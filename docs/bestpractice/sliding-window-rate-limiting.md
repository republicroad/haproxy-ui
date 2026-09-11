# 滑动窗口速率计数最佳实践：HAProxy freq_ctr 源码解析

> 核心结论：**精确滑动窗口（逐请求时间戳）是 O(N) 内存；HAProxy 用「2 个计数分块 + 线性比例插值」把滑动窗口摊到 O(1) 内存 / O(1) 时间**，每个速率计数器只需 12 字节。
> 本文基于 HAProxy 官方 master 分支源码（`include/haproxy/freq_ctr*.h`、`src/freq_ctr.c`、`src/stick_table.c`）逐行说明计算过程,并给出工程实践建议。

---

## 一、为什么滑动窗口计数需要「分块预计算」

### 1.1 精确滑动窗口的成本

滑动窗口（sliding window）按**请求到达时间戳**计数。最精确的实现是"滑动窗口日志"：

- 维护每个 key 的**全部请求时间戳**（如 Redis `ZADD` sorted set）；
- 每次查询清掉窗口外的旧时间戳，再数剩余个数。

代价：

| 项 | 精确实现（时间戳日志） | 分块+插值（HAProxy） |
|----|----------------------|---------------------|
| 内存 | **O(窗口内请求数)**（1 万 req/s 存 1 万个时间戳） | **O(keys)×12B**，与请求数无关 |
| 写入 | 每次一条指令 + 偶发清理 | 每次 1 次原子自增 |
| 读取 | O(log n) + 范围删除 | O(1)，一次乘除 |

所以业界（HAProxy、Cloudflare、Kong 等）**都不存精确时间戳**，而是**把时间切成固定粒度的小块，每块累计计数，读取时用比例插值补平滑**——这就是"短时间分块预计算"。

### 1.2 HAProxy 的选择：仅 2 块（current + previous）

HAProxy 的 `http_req_rate(10s)` 不记录任何具体到达时刻，而是：

```
┌───────────────┬───────────────┐
│  prev_ctr     │  curr_ctr      │
│ 上一完整周期   │ 本周期已累计    │
│ (已翻转锁定)   │ (原子自增中)    │
└───────────────┴───────────────┘
        ▲ tick起点        ▲ 现在(now_ms)
        ├────────period────────┤
```

- 每周期只有一个整数计数；
- 查询时按"当前周期还剩余多少毫秒"对 `prev_ctr` 打折，叠加到 `curr_ctr` 上。

---

## 二、数据结构：12 字节 / 计数器

源码 `include/haproxy/freq_ctr-t.h:32-36`：

```c
struct freq_ctr {
    unsigned int curr_tick; /* start date of current period (wrapping ticks) */
    unsigned int curr_ctr;  /* cumulated value for current period */
    unsigned int prev_ctr;  /* value for last period */
};
```

- 3×4B = **12 字节**；
- 内嵌在 stick table 会话记录里（`include/haproxy/stick_table-t.h:116-123` 的 `union stktable_data.std_t_frqp`）；
- 每个被跟踪的 key（IP / 路径 / API key）身上带一份，`size` 声明决定总内存上界。

类型注册（`src/stick_table.c:1875`）：`http_req_rate` 的标准类型是 `STD_T_FRQP`（即 `freq_ctr`），参数是 `ARG_T_DELAY`（毫秒时长）。

**period 从哪来**：配置 `stick-table ... store http_req_rate(10s)` 的 `10s` 经 `parse_time_err(..., TIME_UNIT_MS)` 解析成 **10000（毫秒）** 存入 `table->data_arg[STKTABLE_DT_HTTP_REQ_RATE].u`（`src/stick_table.c:1379-1384`）。

---

## 三、写入路径：每请求 O(1) 原子自增

### 3.1 快路径（绝大多数请求）

`include/haproxy/freq_ctr.h:49-66`：

```c
static inline uint update_freq_ctr_period(struct freq_ctr *ctr, uint period, uint inc)
{
    curr_tick = HA_ATOMIC_LOAD(&ctr->curr_tick);
    if (likely(now_ms - curr_tick < period))             /* 仍在本周期内 */
        return HA_ATOMIC_ADD_FETCH(&ctr->curr_ctr, inc); /* 直接原子自增 */

    return update_freq_ctr_period_slow(ctr, period, inc); /* 边界才走慢路径 */
}
```

- 使用**线程本地时钟 `now_ms`**（大多数情况下与全局一致），避免读共享全局时钟；
- 命中率约 99.997%，慢路径只出现在毫秒边界交错的极少量请求；
- 到这里已经可以看到：**每个请求只做一次原子加，没有任何时间戳、排序或队列操作**。

### 3.2 翻转（rotate）：把 current 沉降为 previous

`src/freq_ctr.c:26-65`：

```c
uint update_freq_ctr_period_slow(struct freq_ctr *ctr, uint period, uint inc)
{
    /* 用 curr_tick 最低位作“翻转进行中”锁 */
    if (!(curr_tick & 1) && HA_ATOMIC_CAS(&ctr->curr_tick, &curr_tick, curr_tick | 0x1))
        break;   /* 抢到翻转权 */
    ...
    HA_ATOMIC_STORE(&ctr->prev_ctr, HA_ATOMIC_XCHG(&ctr->curr_ctr, inc)); /* swap */
    curr_tick += period;
    if (now_ms_tmp - curr_tick >= period) {              /* 补了还落后≥1周期 */
        HA_ATOMIC_STORE(&ctr->prev_ctr, 0);             /* 数据太旧直接作废 */
        curr_tick = now_ms_tmp;
    }
    HA_ATOMIC_STORE(&ctr->curr_tick, curr_tick & ~1);
}
```

要点：

- `XCHG` 一步完成「旧 curr → prev，新 curr = inc」，且不丢期间的并发自增；
- 若上次翻转至今**错过多于一个周期**（进程暂停/长等待），`prev_ctr` 直接清零——不拿过期假数据。

计数器在上层调用处（`src/stick_table.h:300-303`）：

```c
update_freq_ctr_period(&stktable_data_cast(ptr2, std_t_frqp),
                       stkctr->table->data_arg[STKTABLE_DT_HTTP_REQ_RATE].u, 1);
```

每个请求命中此路径(`track-sc0` 触发 `stkctr_inc_http_req_ctr`)。

---

## 四、读取路径：尾随窗口线性插值（核心公式）

### 4.1 读取入口

`src/stick_table.c:4782-4783`（`smp_fetch_http_req_rate` → `sc_http_req_rate` → `src_http_req_rate`）：

```c
smp->data.u.sint = read_freq_ctr_period(&stktable_data_cast(ptr, std_t_frqp),
                                         stkctr->table->data_arg[STKTABLE_DT_HTTP_REQ_RATE].u);
```

`read_freq_ctr_period`（`freq_ctr.h:90-95`）＝ `freq_ctr_total(ctr, period, -1) / period`。

### 4.2 插值公式

`src/freq_ctr.c:79-103`（`_freq_ctr_total_from_values`）：

```c
remain = tick + period - global_now_ms;      /* 当前周期还剩多少毫秒 */
if (unlikely(remain < 0)) {                  /* 读到的是过期 tick(竞态) */
    remain += period;
    past = (remain >= 0) ? curr : 0;
    curr = 0;
}
...
/* 核心：总量 */
return past * remain + (curr + pend) * period;
```

平均速率 = **总量 / period**。展开（`pend=0`）：

```
rate(events/period) = ( prev_ctr × remain + curr_ctr × period ) / period
                    = curr_ctr + prev_ctr × (remain / period)
```

**物理含义**：当前周期计数`curr_ctr`全额计入 + 上一完整周期计数`prev_ctr`按「本周期剩余时间占比」线性打折。剩余越多（刚进周期），上一周期权重越大；剩余越少（快到翻转），上一周期权重趋近 0，读数自然滚到本周期——**两个固定块的权重随时间平滑过渡，避免固定窗口的边界尖峰**。

### 4.3 低频防抖动（flapping correction）

`freq_ctr.c:94-99`：

```c
if (pend < 0) {                       /* 纯读取场景 */
    pend = 0;
    if (!curr && past <= 1)
        return past * period;         /* 本期为0且上期≤1:直接沿用上期速率 */
}
```

避免低频用户（如 0 或 1 请求/周期）在 0↔1 之间来回抖动导致限速误判。

---

## 五、数值演算

设 `stick-table ... store http_req_rate(10s)`，即 `period = 10000ms`。`track-sc0 src` 跟踪某 IP。

### 场景：现在处于某周期起点后 4 秒

- `prev_ctr = 30`（上一完整 10s 内 30 个请求），`curr_ctr = 14`（本期已过 4s 内 14 个）；
- `remain = 10000 - 4000 = 6000` ms；
- 总量 `= 30×6000 + 14×10000 = 320000`；
- 速率 `= 320000 / 10000 = 32`（事件/10s）。

配合 ACL `sc_http_req_rate(0) gt 20` → 超限，返回 429。直观对比：严格滑动窗口下最近 10s 约 30×0.6+14 = 32，两者一致——插值正是对"上一周期尾部 + 本期"的线性近似。

### 边界行为

| 时刻 | remain | 读数 ≈ | 说明 |
|------|--------|--------|------|
| 刚翻转 | ≈10000 | curr + prev | 主要反映上一周期 |
| 期中 | 5000 | curr + prev/2 | 两段各半 |
| 翻转前 | ≈0 | curr | 自然滚到本期 |
| 错过≥2周期 | — | 仅 curr（prev 已清零） | 不保留过期数据 |

---

## 六、对比：2 块方案 vs 业界其他近似

| 实现                            | 分块                 | 插值方式                 | 误差特征                                   |
| ----------------------------- | ------------------ | -------------------- | -------------------------------------- |
| **HAProxy freq_ctr**          | **2 块**（prev+curr） | 按剩余时间比例线性加权          | 内存极省；窗口尾部的尖峰被线性摊平                      |
| Cloudflare 滑动窗口计数             | 2 块（prev+curr 权重）  | 前一窗口按重叠比例加权          | 与 HAProxy 思路同源（weighted approximation） |
| Redis sorted-set 滑动日志         | 逐时间戳               | 精确计数+过期清理            | 精确但 O(N) 内存、每查询需 ZREMRANGEBYSCORE      |
| Kong `rate-limiting-advanced` | 固定/滑动两窗            | sync_rate 批量同步 Redis | 换取准确率/延迟权衡                             |

> 共同点：绝大多数生产实现都在**减小分块粒度**（如按秒分块后再插值），而不是记录逐时间戳。HAProxy 把分块压到**最少 2 块**，代价是窗口内分布假设为线性——对"速率超限"这类粗粒度判断完全够用。

## 七、工程实践建议

1. **周期选型**：短周期（`1s`）够灵敏但易抖；长周期（`60s`/`24h`）平滑。可**多个计数器并存**：同一条记录同时 `store http_req_rate(1s),http_req_rate(60s)`，分别鉴 bot 尖峰与 API 日配额。
2. **`expire` 与 `size`**：`expire` 必须 ≥ 周期×若干倍，否则记录提前死亡导致漏计；`size` 决定上界（如 `1m`=100万 key × 计数器字节数）。
3. **阈值放到插值意义下理解**：`gt 20` 是"约等于最近 10s ≥20 次"，不是精确时间戳窗口；需要严格配额场景可改用 `http_req_cnt` + Runtime API 定时清零（固定窗口）。
4. **多节点**：开源版 stick table 每节点各自计数；集群级一致性用企业版 Global Profiling Engine（peers 协议聚合推送），无需 Redis。
5. **误报治理**：对低频会话依赖 flapping 修正；对合法突发可加短 `expire` 让计分尽快淡出，或用 `sc_*_rate` 多档阈值分层放行而不是一刀切 429。

## 八、参考

- 源码：`include/haproxy/freq_ctr-t.h`、`include/haproxy/freq_ctr.h`、`src/freq_ctr.c`、`src/stick_table.c`、`include/haproxy/stick_table.h`（HAProxy master，2026-09 分析）
- HAProxy 官方博客《What to Look for in a Rate Limiting Solution》(2026-07-02)
- HAProxy 官方博客《HAProxy rate limiting: four examples》(2019)（滑动/固定窗口两种配置对照）
- Cloudflare 滑动窗口计数加权近似（窗口重叠比例插值）
- Kong `rate-limiting` / `rate-limiting-advanced` 插件文档

---

**文档版本**：v1.0
**更新日期**：2026-09-09
**位置**：`docs/bestpractice/sliding-window-rate-limiting.md`