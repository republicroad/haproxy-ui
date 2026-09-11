# WAF工程最佳实践：轻量级流式异常检测与计算方法

> 核心问题：全量重算（全量计算统计量、全量retrain模型）需要大量CPU和内存。业界WAF工程上如何做到**低成本、低延迟、流式实时**检测。
> 本文聚焦**具体如何计算**，回答上一篇文档中"全量计算太贵"的问题。

---

## 目录

1. [核心思路：为什么不能全量重算](#一核心思路为什么不能全量重算)
2. [关键原则：快路径/慢路径分离](#二关键原则快路径慢路径分离)
3. [流式统计（Streaming Statistics）](#三流式统计streaming-statistics)
4. [近似数据结构（Sketches）](#四近似数据结构sketches)
5. [在线/流式异常检测算法](#五在线流式异常检测算法)
6. [业界WAF架构实例](#六业界waf架构实例)
7. [工程落地架构图](#七工程落地架构图)
8. [性能基准与对比](#八性能基准与对比)
9. [推荐技术选型](#九推荐技术选型)
10. [速查表](#十速查表)

---

## 一、核心思路：为什么不能全量重算

### 1.1 全量计算的代价

假设高流量WAF：

```
QPS = 50,000
一次请求产生的特征 = 30维
学习窗口 = 7天

全量统计的计算量：
  - 7天总请求数 = 50,000 × 86,400 × 7 = 302亿条
  - 全量扫描一遍 = O(N) = 302亿次特征计算
  - 内存：每维度存均值/方差 → 需要全量缓存 → 数百GB

结论：全量重算在毫秒级实时场景下不可行
```

### 1.2 业界共识：在线流式范式

**业界WAF工程的核心范式是"在线流式计算"**：

```
全量重算（不可行）                   在线流式（业界实践）
───────────────                    ──────────────────────
每次都要O(N)重扫数据                每个新点O(1)更新统计量
需缓存全量数据(N个点)                只保存常数规模的汇总状态
周期重训整个模型                     增量更新已有模型
无法实时响应                       立即纳入新点并产生结果
```

### 1.3 三个关键技术基石

| 技术 | 解决的问题 | 复杂度 |
|------|-----------|--------|
| **流式统计** | 均值/方差/分位数不重算 | O(1)更新 |
| **近似数据结构** | 基数/频率统计省内存 | 亚线性内存 |
| **在线异常检测** | 模型增量更新+实时打分 | O(1)/O(log n) |

---

## 二、关键原则：快路径/慢路径分离

### 2.1 分层处理架构（最重要的工程实践）

**不是所有流量都跑完整ML。** 业界普遍采用**两阶段/多阶段**分流：

```
   请求进入
      │
      ▼
┌─────────────────────────────┐
│  L1 快路径（在线/同步）       │   <1ms
│  - 流式统计更新（O(1)）       │   每个请求都跑
│  - 简单阈值/计数（Redis计数） │
│  - 签名规则（编译进二进制）     │
└─────────────────────────────┘
      │ 仅异常/存疑请求
      ▼
┌─────────────────────────────┐
│  L2 慢路径（异步/离线）       │  >1ms 可容忍
│  - ML模型打分（IF/分类器）     │   只对可疑样本
│  - 深度特征分析               │
│  - 语义/序列分析              │
└─────────────────────────────┘
```

**为什么这样设计：**
- 全量流量跑轻量统计（O(1)），不阻塞
- 只有少量可疑流量触发ML慢路径
- ML推理放异步（Kafka解耦），不拖慢请求

### 2.2 LD（Lambda/多层）表现对比（业界数据）

| 层 | 吞吐 | p99延迟 | 用途 |
|----|------|---------|------|
| **eBPF/XDP内核层** | 1.2M req/s | <100μs | IP封禁、DDoS丢弃 |
| **快路径规则层** | 6.2M req/s | <1μs | 签名、计数、简单统计 |
| **ML推理层** | — | 42-210μs | 零日/未知攻击 |
| **流式异常检测** | — | 亚秒 | 长期基线、漂移 |

---

## 三、流式统计（Streaming Statistics）

这是取代"全量重算"的第一根支柱：**只维护常数规模的汇总状态，每个新样本O(1)更新**。

### 3.1 Welford在线均值/方差（核心！）

**不用缓存所有数据**，用三条状态量递推更新：

```python
class OnlineStats:
    """Welford在线算法：流式计算均值、方差、标准差"""
    def __init__(self):
        self.count = 0      # 已处理样本数 n
        self.mean = 0.0     # 均值 μ
        self.M2 = 0.0       # 二阶矩（用于方差）
    
    def update(self, x):
        """每个新样本O(1)更新"""
        self.count += 1
        delta = x - self.mean
        self.mean += delta / self.count          # 更新均值
        delta2 = x - self.mean
        self.M2 += delta * delta2                # 更新二阶矩
    
    @property
    def variance(self):
        return self.M2 / self.count              # 方差 σ²
    
    @property
    def std(self):
        return (self.variance) ** 0.5            # 标准差 σ

# 使用：每个(IP,路径,时段)桶维护一个OnlineStats
# 完全不需要缓存历史数据！
```

**关键优点：**
- 空间`O(1)`（只存count/mean/M2三个数）
- 时间`O(1)`（每次更新3次运算）
- 数值稳定（避免大数相减的浮点误差）

### 3.2 t-digest在线分位数

**问题**：在线计算中位数/p95/p99不能用普通排序（需全量数据）。

**解决方案**：`t-digest`（Dunning算法）——用树状分箱近似分位数，精度高且省内存。

```python
# 概念：t-digest把数据聚成若干"质心"(centroid)
# 每个质心= (均值, 权重)，中心附近的分箱更密集

from tdigest import TDigest

digest = TDigest()

# 在线更新，O(log n)，内存固定
for x in stream:
    digest.update(x)

# 随时查询分位数，无需全量重算
p50 = digest.percentile(50)
p95 = digest.percentile(95)
p99 = digest.percentile(99)

# 内存：固定~1000个质心 → ~几十KB，与数据量无关
```

**适用**：基线中需要分位数(p50/p95/p99)而非仅均值/方差的特征。

### 3.3 指数加权移动平均（EWMA z-score）

**用于实时检测趋势偏离**，比等权均值更敏感新变化：

```python
class EWMA:
    """指数加权移动平均：更重视近期数据"""
    def __init__(self, alpha=0.3):
        self.alpha = alpha   # 平滑因子，大=更重视新数据
        self.mean = None
        self.var = None
    
    def update(self, x):
        if self.mean is None:
            self.mean = x
            self.var = 0
        else:
            # 均值：新值占alpha，历史占(1-alpha)
            self.mean = self.alpha * x + (1 - self.alpha) * self.mean
            # 方差（简化）
            self.var = self.alpha * (x - self.mean)**2 + \
                       (1 - self.alpha) * self.var
```

### 3.4 滑动窗口 vs 指数衰减

| 方法 | 窗口 | 内存 | 反应速度 | 适用 |
|------|------|------|---------|------|
| **固定滑动窗口** | 固定N个样本 | O(N)（需缓存） | 中等 | 精确、周期性 |
| **指数衰减** | 无边界（半衰期） | O(1) | 快 | 高频实时 |
| **Welford+重算** | 定期重置 | O(1) | 慢 | 稳定基线 |

**业界实践**：滑动窗口用**环形缓冲区**（ring buffer）只缓存窗口内数据，超出的丢弃——相比全量，内存从O(N)降到O(W)，W远小于N。

---

## 四、近似数据结构（Sketches）

第二根支柱：**用亚线性内存做精确近似统计**，解决"高基数/高频率"统计的内存爆炸。

### 4.1 Count-Min Sketch（频率计数）

**问题**：统计每个IP的请求数 → 若IP基数百万级，哈希表内存大。

**解决**：Count-Min Sketch用多个哈希函数+计数数组，牺牲微量精度换内存。

```
         ┌───┬───┬───┬───┬───┬───┬───┐
h1(x) ──→│ 5 │ 3 │ 7 │ 2 │ 9 │ 1 │ 4 │  第1行（d=4行）
         ├───┼───┼───┼───┼───┼───┼───┤
h2(x) ──→│ 6 │ 2 │ 4 │ 8 │ 3 │ 5 │ 1 │  第2行
         ├───┼───┼───┼───┼───┼───┼───┤
h3(x) ──→│ 2 │ 9 │ 1 │ 4 │ 7 │ 3 │ 6 │  第3行
         ├───┼───┼───┼───┼───┼───┼───┤
h4(x) ──→│ 3 │ 5 │ 8 │ 1 │ 6 │ 2 │ 7 │  第4行
         └───┴───┴───┴───┴───┴───┴───┘

计数 x：每行加1到 h_i(x) 对应格
查询 x：取 4行中最小值（因为有哈希冲突取保守估计）
```

```python
class CountMinSketch:
    """频率计数草图：估算元素出现次数（只能高估，误差有界）"""
    def __init__(self, width=2**16, depth=4):
        self.width = width    # 每行宽度（越大越准）
        self.depth = depth    # 行数（哈希函数数）
        self.table = [[0] * width for _ in range(depth)]
        import hashlib
        self.hashes = [lambda x, i=i: self._h(x, i) for i in range(depth)]
    
    def _h(self, x, i):
        # 用不同salt做多个哈希
        import hashlib
        return int(hashlib.sha256(f"{i}:{x}".encode()).hexdigest(), 16) % self.width
    
    def add(self, x, delta=1):
        """O(d)更新：每秒每个请求调一次"""
        for i in range(self.depth):
            self.table[i][self.hashes[i](x)] += delta
    
    def estimate(self, x):
        """O(d)查询频率"""
        return min(self.table[i][self.hashes[i](x)] for i in range(self.depth))

# 内存：width×depth = 65536×4 个整数 ≈ 2MB
# 能统计百万级不同IP，误差 < 2% （理论误差1/width = 1/65536）
```

**WAF用途**：按IP/Kafka流式统计请求速率，取代大哈希表，O(1)内存更新。

### 4.2 HyperLogLog（基数估计）

**问题**：统计"有多少个不同路径/不同IP/不同UA"（基数）需要大量内存。

**解决**：HyperLogLog用哈希+概率，固定内存估算基数（准确率~99%）。

```python
class HyperLogLog:
    """基数草图：估算不重复元素个数"""
    def __init__(self, p=14):  # p=14 → 2^14=16384个寄存器
        self.m = 1 << p
        self.registers = [0] * self.m
    
    def add(self, x):
        # 哈希后取前p位定位寄存器，剩余位数前导0的个数存进去
        h = hash(x)
        index = h & (self.m - 1)
        # 统计剩余位前导0个数
        w = h >> (self.p)
        rank = self._leading_zeros(w) + 1
        self.registers[index] = max(self.registers[index], rank)
    
    def estimate(self):
        # harmonic mean
        return self._harmonic_mean() * self.m * 0.79402

# 内存：16384字节 ≈ 16KB
# 可估算数十亿级不同元素，误差 ~1.04/sqrt(16384) ≈ 0.8%
```

**WAF用途**：检测URI熵、路径多样性、会话唯一性——无需缓存全部历史路径。

### 4.3 Space-Saving（Top-K重活元素）

**问题**：找出"请求最多的Top-K个IP/路径"（重活检测）用于热点/异常分析。

**解决**：Space-Saving用`O(K)`内存跟踪Top-K。

```python
class SpaceSaving:
    """Top-K重活元素：确定性的O(K)内存"""
    def __init__(self, k=100):
        self.k = k
        self.counters = {}  # 只存K个
    
    def add(self, x):
        if x in self.counters:
            self.counters[x] += 1
        elif len(self.counters) < self.k:
            self.counters[x] = 1
        else:
            # 替换计数最小的
            min_key = min(self.counters, key=self.counters.get)
            self.counters[x] = self.counters.pop(min_key) + 1
    
    def top(self):
        return sorted(self.counters.items(), key=lambda x: -x[1])[:self.k]

# 内存：固定K个 → O(K)
# 用途：定位暴力破解的高频IP、扫描器的热门路径
```

### 4.4 Bloom Filter（集合成员查询）

**问题**：判断一个IP是否在黑名单/IOC列表，查大集合很慢。

**解决**：Bloom Filter用位数组+多哈希，`O(1)`判断，**零假阴性**、可接受假阳性。

```python
class BloomFilter:
    """集合成员判断：零假阴性，有界假阳性"""
    def __init__(self, n, fp_rate=0.01):
        self.m = int(-n * log(fp_rate) / (log(2)**2))  # 位数组大小
        self.k = int(self.m / n * log(2))              # 哈希函数数
        self.bitarray = [0] * self.m
    
    def add(self, x):
        for i in range(self.k):
            self.bitarray[self._h(x, i)] = 1
    
    def contains(self, x):
        return all(self.bitarray[self._h(x, i)] for i in range(self.k))

# WAF用途：IOC/IP黑名单查询，内存极小，查询O(1)极快
```

---

## 五、在线/流式异常检测算法

### 5.1 在线Isolation Forest（流式孤立森林）

**问题**：传统Isolation Forest需一次性加载全量数据训练。

**解决**：业界采用**在线版本**（oIFOR / SiForest / Random Cut Forest），模型随数据流增量更新：

```
传统IfF：                      在线/流式IfF：
  一次性 O(N) 训练              每个新点 O(1)~O(log n) 更新
  缓存全量数据                  只保留树的切分结构
  分布变了要全量重训             手动替换过期子树
```

**业界代表：**

| 算法 | 特点 | 复杂度 |
|------|------|--------|
| **oIFOR** (Leveni 2024) | 在线Isolation Forest | 更新O(log n) |
| **SiForest** (Liu 2025) | 流式Isolation Forest | 更新O(log n) |
| **Random Cut Forest** (AWS/OpenSearch) | 随机切割森林，增量树 | 更新O(log n) |
| **Streaming IF** | 窗口滑动的IF变体 | — |

**Random Cut Forest（RCF）——AWS WAF实际用的**：

```python
# 概念：RCF增量维护一棵"随机树"
# 每个新点：从根到叶子走一遍(O(log n))，更新路径上节点统计
# 异常分数 = 新点与正常点的分离程度（路径深度特征）

# AWS OpenSearch的RCF：持续适应数据流中的周期性/趋势
# "lightweight, computational load distributed across nodes"
```

### 5.2 在线z-score + EWMA + CUSUM

**最轻量、广泛应用**的流式异常检测组合：

```python
class StreamingZScore:
    """基于Welford在线均值的z-score检测"""
    def __init__(self, threshold=3.0):
        self.stats = OnlineStats()
        self.threshold = threshold
    
    def update_and_check(self, x):
        # 先检测
        if self.stats.count >= 30:  # 有足够样本才检测
            z = abs(x - self.stats.mean) / (self.stats.std + 1e-9)
            if z >= self.threshold:
                return True  # 异常
        # 再更新（也可做"异常点不更新"保护）
        self.stats.update(x)
        return False

# 双向CUSUM：检测均值持续的缓慢漂移
def cusum(x, target, threshold=5.0, k=0.5):
    """累积和：检测微小但持续的偏离"""
    S_hi = max(0, S_hi + (x - target - k))   # 上侧
    S_lo = max(0, S_lo - (x - target + k))   # 下侧
    if S_hi > threshold or S_lo > threshold:
        return True  # 漂移
```

**关键优化**：使用 `OnlineStats` 后z-score检测完全O(1)，无需缓存任何历史。

### 5.3 ADWIN（自适应滑动窗口）

**问题**：何时该重置基线？窗口大小该多大？

**解决**：ADWIN自动检测"分布变化"并调整窗口——变化时自动缩小窗口。

```
ADWIN（Adaptive Windowing）：
  - 维护可变长度滑动窗口
  - 若检测到分布显著变化（前后均值差超阈值）
    自动截断旧数据，缩小窗口
  - 恒定内存、O(1)摊销

AEOF防火墙实践（2026）：
  - 用ADWIN自适应百分比阈值
  - 识别概念漂移，自动调整检测敏感度
```

### 5.4 增量学习的可选方向

| 方法 | 说明 | 复杂度 |
|------|------|--------|
| **在线Random Forest** | 逐棵替换过时树 | O(log n) |
| **增量IDK-S** | 增量分布核，替换过时弱检测器 | O(l·ψ·t) |
| **在线Learn++/ensemble** | 新分类器加入集成 | — |

---

## 六、业界WAF架构实例

### 6.1 Cloudflare WAF（eBPF + ML + CRDT）

```
请求
  │
  ▼
L1: eBPF/XDP 内核层          <100μs
     - 头部检查、IP封禁、DDoS丢弃
     - 无需分配内核数据结构
  │ 剩余请求
  ▼
L2: WAF规则层（用户空间）
     - 签名规则
  │ 剩余请求
  ▼
L3: ML推理层（waf-infer守护进程，ONNX）
     - 142维特征：请求熵、头部异常、载荷偏差
     - INT8量化：42μs推理
     - 实时零日打分
  │
  ▼
决策：放行 / 阻断 / 挑战 / 限速

性能：p99=820μs，1.2M req/s，误报率0.001%
```

**关键工程点：**
- **模型量化**：FP32→INT8，大小减4x，推理快3-5x，精度损失<0.1%
- **ONNX Runtime**：跨x86/ARM，动态shape优化
- **规则CRDT传播**：控制面→300+边缘节点，120ms（而非12s）

### 6.2 AWS WAF（Kinesis + Lambda + OpenSearch RCF）

```
AWS WAF日志
  │ (Kinesis Data Firehose)
  ▼
Lambda(one-hot编码)
  │
  ▼
OpenSearch Service（内置Random Cut Forest）
  - 自动检测时间序列异常
  - 计算anomaly grade + confidence
  │
  ▼
SNS告警

关键：RCF是"在线/自适应"算法，持续适应数据流，
      不是全量重算
```

### 6.3 IntelliWAF（六层分级 + Redis解耦）——第三方项目案例

```
L1: IP黑名单（Bloom/Firewall）
L2: 速率限制（Redis滑动窗口计数器）
L3: 24条正则（编译进二进制）
L4: Random Forest分类（只判可疑样本）
L5: Isolation Forest异常评分
L6: 灰色语义分析
      │
      ▼
Redis事件队列（异步，不阻塞）
      ▼
MySQL + 实时仪表板（sub-50ms）
```

> ⚠️ **注意**：IntelliWAF 是第三方学术/开源项目，其 L2 速率限制用 **Redis TTL 滑动窗口计数**。**这并非 HAProxy Enterprise WAF 的实现方式**——HAProxy（开源+企业版）的滑动窗口速率限制一律用 **进程内 stick tables**（`http_req_rate(10s)` 尾随窗口回看），无外部存储依赖；企业版仅通过 **peers 协议 + Global Profiling Engine** 做跨节点聚合，仍不需要 Redis。来源：HAProxy 官方博客《What to Look for in a Rate Limiting Solution》(2026)。

**关键工程点（IntelliWAF 自身）：**
- **Redis计数器**：滑动窗口速率限制用Redis TTL计数，O(1)
- **事件队列解耦**：检测与日志/存储分离，不拖慢请求
- **只对可疑样本跑ML**：全量流量走L1/L2/L3快路径

### 6.4 Zentinel / Light-WAF（Rust高性能）

```
Zentinel WAF（纯Rust）：
  - 285条规则编译进二进制（~6MB）
  - 统计分类 + n-gram 降低误报
  - 吞吐 1.6M req/s，p99 < 5μs
  - bot检测：行为 + TLS指纹（JA3）

Light-WAF：
  - CRS风格异常评分（cumulative risk score）
  - 内容预过滤快路径（fast-path）
  - p99 < 1ms
```

### 6.5 HAProxy Enterprise WAF（对照：进程内 stick tables，无外部存储）

> 与上一节 IntelliWAF 不同,HAProxy（开源+企业版）**不做 Redis**:
> WAF 引擎（签名+行为检测）与速率限制是**两个独立能力**,速率限制由 **进程内 stick tables** 完成。

**HAProxy 的实现分层：**

```
┌────────────────────────────────────────────────────────────┐
│ HAProxy Enterprise WAF                              在线    │
│  - WAF Engine（签名引擎 / Intelligent WAF Engine）           │
│    · 签名检测：OWASP CRS 兼容规则 / 专有签名                  │
│    · 非签名检测：行为分析 + 机器学习（分层，非全量ML）          │
│  - 速率限制：STICK TABLES（非 Redis）                        │
│    · http_req_rate(10s)：每次请求回看尾随滑动窗口            │
│    · 内存 key-value（弹性二叉查找树），O(log n)               │
│    · 单节点：进程内，零网络跳转，线速                        │
│    · 多节点：peers 协议同步 + Global Profiling Engine         │
│      聚合集群各节点计数（仍无外部数据库/Redis）                │
└────────────────────────────────────────────────────────────┘
```

**关键点（对照 IntelliWAF）：**

| 维度 | IntelliWAF（6.3） | HAProxy Enterprise WAF |
|------|-------------------|------------------------|
| 速率限制存储 | Redis TTL 计数（外部依赖） | **stick tables（进程内内存）** |
| 滑动窗口 | Redis 计数 + 过期窗口 | stick-table 计数，每次请求回看尾随窗口 |
| 外部调用 | 每请求可能打 Redis → 网络跳转 | **零外部调用/零网络跳转** |
| 集群扩展 | 需维护 Redis 集群 | peers 协议 + Global Profiling Engine，无需外部 DB |
| 检测引擎 | 独立第三方项目（论文） | WAF 引擎内建（签名+行为/ML） |

**滑动窗口计数的内部机制（分块+插值，源码级）：**
- `http_req_rate(period)` 不存请求时间戳，而是维护 2 块计数（`curr_ctr` 本周期 + `prev_ctr` 上一周期），共 **12 字节/计数器**（`struct freq_ctr`）。
- **写**：每请求一次原子自增；周期翻转用 `XCHG` 一步把 curr 沉降为 prev，错过≥2周期直接清零 prev。
- **读**：`rate = (prev_ctr×remain + curr_ctr×period) / period`——本周期全额 + 上一周期按"剩余时间占比"线性加权，平滑过渡避免固定窗口边界尖峰；低频有 flapping 修正。
- ✅ 这正是"**短时间分块预计算**"范式：把精确 O(N) 滑动窗口日志压低到 O(1) 内存/时间。

▶️ 详见 `bestpractice/sliding-window-rate-limiting.md`（含源码逐行分析与数值演算）。

**出处：**
- HAProxy 官方博客《What to Look for in a Rate Limiting Solution》(2026-07-02)
- HAProxy 官方博客《Introduction to HAProxy stick tables》(2018)
- HAProxy master 源码：`include/haproxy/freq_ctr-t.h`、`src/freq_ctr.c`、`src/stick_table.c`

---

## 七、工程落地架构图

### 7.1 推荐：异步 + 快慢路径 + 流式统计

```
┌────────────────────────────────────────────────────────────┐
│                     WAF网关（OpenResty/HAProxy/Rust）        │
│                                                            │
│   请求进入                                                  │
│     │                                                      │
│     ▼                                                      │
│  ┌──────────────────────┐  快路径（O(1)，每请求）            │
│  │ L1内联（同步）        │                                  │
│  │  - 流式统计更新       │  OnlineStats / CMS / HLL实时递增  │
│  │  - Redis速率计数      │                                  │
│  │  - 签名规则匹配       │                                  │
│  └──────────────────────┘                                  │
│     │ 剩余请求→放行                 │ (可疑样本入队)          │
│     └─────────────┬───────────────┘                        │
└───────────────────┼────────────────────────────────────────┘
                    ▼
            ┌───────────────┐  异步解耦
            │  Kafka事件总线 │
            └───────┬───────┘
                    ▼
        ┌───────────────────────┐   慢路径（>1ms，只对可疑样本）
        │   检测消费者服务       │
        │  - 在线IF打分         │   增量更新，O(log n)
        │  - 深度特征分析       │
        │  - 语义/序列分析      │
        └───────────┬───────────┘
                    │ 判定
                    ▼
            ┌───────────────┐
            │  决策/封禁     │ ──→ CrowdSec / 防火墙bouncer /
            │  (IP封禁)      │     黑洞路由、限速
            └───────────────┘
```

> ⚠️ 上图"Redis速率计数"是**通用网关（OpenResty/Rust 等）**的通用快路径方案。若网关为 **HAProxy**，则该处应替换为 **stick tables**（`http_req_rate`），不引入 Redis 依赖（详见 6.5）。

### 7.2 基线维护（完全在线，无需全量重算）

```
每个(IP,路径,时段)桶维护：
  ┌─────────────────────────────┐
  │  OnlineStats (count/mean/M2)│  ← O(1)更新
  │  TDigest (分位数)           │  ← O(log n)
  │  EWMA (趋势)                │
  └─────────────────────────────┘

查询z-score：
  z = (x - mean) / std   ← 直接用在线统计量，无需重算

定期（如每天）：
  - 增量更新online统计
  - 用PSI/ADWIN检测漂移
  - 仅当漂移显著时才重置窗口
```

---

## 八、性能基准与对比

### 8.1 各技术成本对比

| 技术                     | 更新时间      | 查询时间     | 内存   | 精度      |
| ---------------------- | --------- | -------- | ---- | ------- |
| **Welford在线均值**        | O(1)      | O(1)     | O(1) | 精确      |
| **t-digest分位**         | O(log n)  | O(log n) | ~KB  | ~0.01误差 |
| **Count-Min Sketch**   | O(d)      | O(d)     | ~MB  | 有界误差    |
| **HyperLogLog**        | O(1)      | O(1)     | ~KB  | ~0.8%   |
| **Space-Saving**       | O(1)~O(K) | O(K)     | O(K) | 近似      |
| **Bloom Filter**       | O(k)      | O(k)     | 位数组  | 假阳性率可调  |
| **在线Isolation Forest** | O(log n)  | O(log n) | 树结构  | 近似      |
| **全量重算（不要用）**          | O(N)      | —        | O(N) | 精确但不可行  |

### 8.2 业界实测吞吐/延迟

| 方案 | 吞吐 | p99延迟 | CPU/100k req |
|------|------|---------|--------------|
| eBPF/XDP层 | 1.2M req/s | <100μs | — |
| ZentinelSec(纯Rust CRS) | 6.2M req/s | <1μs | — |
| Light-WAF(Rust) | — | <1ms | — |
| ONNX INT8 ML推理 | — | 42μs | — |
| Cloudflare WAF整体 | 1.2M req/s | 820μs | 8% |
| 传统集中式WAF | 450k req/s | 2.1ms | 22% |

---

## 九、推荐技术选型

### 9.1 按场景选择

| 场景 | 推荐方案 | 理由 |
|------|---------|------|
| **高吞吐实时WAF** | eBPF/内核层 + Rust快路径 + Redis计数 + 在线IF | 亚毫秒延迟 |
| **流式异常检测** | Welford + EWMA/CUSUM + OnlineStats | 最轻量O(1) |
| **基数/频率统计** | HyperLogLog + Count-Min Sketch | 省内存 |
| **未知攻击检测** | 在线Isolation Forest / Random Cut Forest | 无监督+增量 |
| **分布式边缘** | Kafka异步 + 中心模型 + CRDT规则传播 | 解耦、可扩展 |
| **中小规模** | OpenResty + Kafka + CrowdSec + 流式统计 | 轻量、成熟 |

### 9.2 现成库/组件

```
流式统计：
  - River（Python在线学习）
  - tdigest（分位数）
  - Apache DataSketches（HLL/CMS）

在线异常检测：
  - AWS OpenSearch RCF（内置）
  - anomstream（Rust流式异常检测工具集）
  - River 的 IsolationForest 在线版

内存数据库：
  - Redis（速率计数、TTL滑动窗口）
  - CrowdSec（IP声誉、协同封禁）

Web服务器侧：
  - OpenResty/ngx_lua（Lua快路径 + 异步发布Kafka）
```

---

## 十、速查表

```
✅ 业界WAF工程核心实践：
  □ 快路径/慢路径分离：全量流量跑O(1)轻量统计，只对可疑样本跑ML
  □ 流式统计（Welford/t-digest/EWMA）：不全量重算，O(1)增量更新
  □ 近似数据结构（HLL/CMS/Space-Saving/Bloom）：亚线性内存估算
  □ 在线异常检测（oIFOR/RCF/Online z-score）：模型随流更新
  □ 异步解耦（Kafka/Redis队列）：检测不阻塞请求
  □ 模型量化（INT8/ONNX）：推理快3-5x，精度损失<0.1%
  □ 漂移检测（PSI/ADWIN）：只在显著漂移时重置，不频繁全量重训
  □ 分层防御：签名(快) + 行为(慢) + 威胁情报(上下文)

❌ 应避免：
  □ 每请求全量重算统计量（O(N)）
  □ 全量缓存历史流量用于训练（内存爆炸）
  □ 全量流量都跑深度ML推理
  □ collected全部原始数据存库再批处理（延迟高）
```

---

**文档版本**：v1.3  
**更新日期**：2026-09-09  
**配套**：`机器学习异常检测模型详解.md`、`行为基线构建详细流程.md`、`bestpractice/sliding-window-rate-limiting.md`  
**调研来源**：Cloudflare WAF架构、AWS WAF/OpenSearch RCF、IntelliWAF论文、anomstream、Zentinel、AEOF、流式异常检测学术（oIFOR/SiForest/IDK-S）、HAProxy官方博客（stick tables / rate limiting）
