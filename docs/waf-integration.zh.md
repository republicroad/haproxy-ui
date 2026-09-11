# Coraza WAF 与 HAProxy 集成

## 概述

本文档描述了在**开源 HAProxy** 上通过 **SPOE（Stream Processing Offload Engine，流式处理卸载引擎）** 协议，使用 **Coraza WAF** 实现 Web 应用防火墙（WAF）的行业最佳实践。

**状态**：面向未来实现的设计文档。尚未在 haproxy-ui 中实现。

**参考实现**：`github.com/corazawaf/coraza-spoa`（持续维护中，v0.7.3 于 2026 年 9 月发布）

---

## 架构

```
┌─────────────┐     HTTP 请求      ┌─────────────┐     SPOP 协议      ┌──────────────────┐
│   客户端     │ ─────────────────────▶ │   HAProxy   │ ─────────────────────▶ │   coraza-spoa    │
└─────────────┘                         │ (filter spoe)│                      │  (Coraza 引擎   │
                                        │              │  ◀──────────────────  │  + OWASP CRS v4)│
         ▲                              └──────┬───────┘     WAF 决策      └──────────────────┘
         │                                     │
         │                    阻断 / 放行 / 丢弃（通过 txn.coraza.action）
         │                                     │
         ▼                              ┌──────┴───────┐
┌─────────────┐                         │    后端       │
│   响应       │ ◀────────────────────── │  (上游服务器) │
└─────────────┘                         └──────────────┘
```

**关键原则**：HAProxy 负责任何阻断执行；Coraza 只做决策。决策结果通过 HAProxy 事务变量（`txn.coraza.*`）流转。

---

## 配置

### 1. HAProxy 前端配置（`haproxy.cfg`）

```haproxy
frontend web
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/

    # 应用标识符（必须与 coraza-spoa.yaml 中的应用名称匹配）
    http-request set-var(txn.coraza.app) str(my_web_app)

    # 重要：必须在 WAF 检查之前运行的规则放在这里（HERE）
    # （例如：健康检查放行、静态资源绕过）

    # 为 Coraza 启用 SPOE 过滤器
    filter spoe engine coraza config /etc/haproxy/coraza.cfg

    # 触发请求检查
    http-request send-spoe-group coraza coraza-req

    # 基于 Coraza 决策的执行动作
    http-request deny deny_status 403 \
        hdr waf-block "request" \
        if { var(txn.coraza.action) -m str deny }

    http-request silent-drop \
        if { var(txn.coraza.action) -m str drop }

    # 可选：SPOE 出错时 fail-closed（默认是 fail-open）
    http-request deny deny_status 500 \
        if { var(txn.coraza.error) -m int gt 0 }

    # 可选：响应检查（需要 SPOE 配置中有 coraza-res 消息）
    # http-response deny deny_status 403 \
    #     hdr waf-block "response" \
    #     if { var(txn.coraza.action) -m str deny }

    default_backend my_app

backend my_app
    server app1 10.0.0.10:80 check
```

### 2. SPOE 配置（`/etc/haproxy/coraza.cfg`）

```haproxy
# coraza.cfg - coraza-spoa 的 SPOE 过滤器配置
# 来源：coraza-spoa example/haproxy/coraza.cfg

[coraza]
spoe-agent coraza-agent
    messages   coraza-res        # 响应检查（可选）
    groups     coraza-req
    option     var-prefix   coraza
    option     set-on-error error
    # 注意：timeout hello/idle 在 HAProxy SPOE v1.2（2024-07-12）中已废弃
    timeout    processing   500ms   # 关键：限制增加的延迟上限
    use-backend coraza-spoa
    log        global

spoe-message coraza-req
    args app=var(txn.coraza.app) src-ip=src src-port=src_port \
         dst-ip=dst dst-port=dst_port method=method path=path \
         query=query version=req.ver headers=req.hdrs body=req.body \
         exportRuleIDs=bool(false)

spoe-message coraza-res
    args app=var(txn.coraza.app) id=var(txn.coraza.id) \
         version=res.ver status=status headers=res.hdrs body=res.body \
         exportRuleIDs=bool(false) detect-only=bool(false)
    event on-http-response

spoe-group coraza-req
    messages coraza-req

# 指向 coraza-spoa 代理的后端
backend coraza-spoa
    mode tcp
    option spop-check
    server coraza_spoa 127.0.0.1:9000 check
```

### 3. Coraza-SPOA 代理配置（`/etc/coraza-spoa/coraza-spoa.yaml`）

```yaml
# coraza-spoa.yaml
# 来源：coraza-spoa example/coraza-spoa.yaml

bind: "0.0.0.0:9000"              # 默认端口 9000（不是 9002）
# unix: "/run/coraza-spoa/coraza-spoa.sock"  # 备选：Unix 套接字

# 事务 TTL（毫秒）- 跨请求/响应缓存 WAF 事务
transaction_ttl_ms: 60000

# 当 txn.coraza.app 不匹配时的默认应用
default_application: "default"

applications:
  - name: "my_web_app"
    # 内嵌 CRS v4 的 Coraza 指令
    directives: |
      # 推荐的 Coraza 基础配置
      Include @coraza.conf-recommended

      # CRS 配置 - 在此调整怀疑度等级（1-4）
      Include @crs-setup.conf.example
      SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=2"

      # 加载所有 OWASP CRS v4 规则
      Include @owasp_crs/*.conf

      # 引擎模式：On | DetectionOnly
      SecRuleEngine On

      # 自定义排除项放在 CRS 引入之后（配置期）
      # SecRuleRemoveById 942100  # 示例：为特定应用排除 SQLi 规则

    # 为此应用禁用响应检查（更快）
    # response_check: false

  - name: "api_service"
    directives: |
      Include @coraza.conf-recommended
      Include @crs-setup.conf.example
      SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=1"
      Include @owasp_crs/*.conf
      SecRuleEngine On
    # response_check: true

# 日志
log_level: "info"
```

---

## 部署选项

### 方案 A：二进制（与 HAProxy 同机）

```bash
# 从源码构建
git clone https://github.com/corazawaf/coraza-spoa
cd coraza-spoa
go run mage.go build
# 二进制位于 ./build/coraza-spoa

# 带配置运行
./build/coraza-spoa -config /etc/coraza-spoa/coraza-spoa.yaml

# 仅校验配置
./build/coraza-spoa -validate -config /etc/coraza-spoa/coraza-spoa.yaml
```

**Systemd 单元**（加固版，来自 `contrib/`）：
```ini
[Unit]
Description=Coraza SPOA WAF 代理
After=network.target

[Service]
Type=simple
User=haproxy
Group=haproxy
ExecStart=/usr/local/bin/coraza-spoa -config /etc/coraza-spoa/coraza-spoa.yaml
Restart=on-failure
RestartSec=5
# 加固
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/run/coraza-spoa
NoNewPrivileges=true
PrivateNetwork=false  # 需要接受 HAProxy 连接

[Install]
WantedBy=multi-user.target
```

### 方案 B：Docker / Docker Compose

```yaml
# docker-compose.yml
services:
  haproxy:
    image: haproxy:3.1
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - ./coraza.cfg:/usr/local/etc/haproxy/coraza.cfg:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - coraza-spoa

  coraza-spoa:
    image: ghcr.io/corazawaf/coraza-spoa:latest  # distroless，Renovate 维护
    volumes:
      - ./coraza-spoa.yaml:/etc/coraza-spoa/coraza-spoa.yaml:ro
    # ports: ["9000:9000"]  # 同一 Docker 网络内无需暴露
```

### 方案 C：Kubernetes（Helm）

```bash
helm repo add coraza https://corazawaf.github.io/charts
helm install coraza-spoa coraza/coraza-spoa \
  --set config.applications[0].name=my_web_app \
  --set config.applications[0].directives="Include @coraza.conf-recommended\nInclude @crs-setup.conf.example\nInclude @owasp_crs/*.conf\nSecRuleEngine On"
```

---

## CRS 集成细节

### CRS 版本兼容性

| Coraza-SPOA 版本 | 内嵌 CRS（通过 coraza-coreruleset） | 上游 CRS |
|---------------------|----------------------------------------|--------------|
| v0.7.x（2026）       | v4.22 → v4.25                          | v4.29（2026 年 8 月） |

- Coraza 声称 **100% CRS v4 兼容**
- CRS 通过 Go embed（`@owasp_crs/*.conf`）加载——无需文件系统
- Renovate 机器人持续更新 `coraza-coreruleset` 依赖

### 怀疑度等级（Paranoia Levels，PL）

| 等级 | 适用场景 | 误报风险 |
|-------|----------|---------------------|
| PL1   | 基线、公开站点 | 接近零 |
| PL2   | 电子商务、SaaS | 预期会有——需要调优 |
| PL3   | 银行、医疗 | 高——需数周调优 |
| PL4   | 核心资产（Crown jewels） | 极高 |

**最佳实践**：在 CRS 配置中使用 `tx.paranoia_level` 变量。运行 **执行 PL > 阻断 PL**，这样在观测期内新规则只记录而不计入异常分数。

```haproxy
# coraza-spoa.yaml directives 中：
SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=2"
SecAction "id:900131,phase:1,nolog,pass,t:none,setvar:tx.blocking_paranoia_level=1"
```

---

## 运维最佳实践

### 1. 强制模式之前的观测模式

**阶段 1：仅检测**
```yaml
# coraza-spoa.yaml
directives: |
  Include @coraza.conf-recommended
  Include @crs-setup.conf.example
  Include @owasp_crs/*.conf
  SecRuleEngine DetectionOnly   # 仅记录，绝不阻断
```

**阶段 2：响应仅检测（coraza-spoa v0.7.0+）**
```yaml
# SPOE 配置中，响应消息：
detect-only=bool(true)
```
立即返回 HAProxy；后台评估响应规则，仅用于记录。

**阶段 3：渐进式生效**
- 监控日志中的 `txn.coraza.anomaly_score`、`txn.coraza.rules_hit`、`txn.coraza.rule_ids`
- 调优误报（见下文）
- 按应用逐个把 `SecRuleEngine` 切换为 `On`

### 2. 误报处理

**绝不分叉（fork）CRS 规则文件。** 使用排除项：

**配置期（在 CRS 引入之后）：**
```apache
# 完全移除指定规则
SecRuleRemoveById 942100

# 从指定变量中移除规则
SecRuleUpdateTargetById 942100 !ARGS:user_input
```

**运行时（在 CRS 引入之前——更灵活）：**
```apache
# 为指定路径移除目标
SecRule REQUEST_URI "@beginsWith /api/webhook" \
  "id:100001,phase:1,pass,nolog,ctl:ruleRemoveTargetById=942100;ARGS:payload"

# WordPress/Nextcloud/Drupal 排除包（官方 CRS）
SecAction "id:100010,phase:1,nolog,pass,t:none,setvar:tx.crs_exclusions_wordpress=1"
```

**规则 ID 约定**（针对自定义规则）：
- `100000–189999` — 基础设施/白名单（不计入异常计数器）
- `190000–199999` — 自定义阻断规则（计入，在 `rule_ids` 中导出）

### 3. 延迟管理

| 技术 | 描述 |
|-----------|-------------|
| 同机部署代理 | 让 coraza-spoa 与 HAProxy 运行在同一主机（亚毫秒延迟） |
| `timeout processing` | 限制最坏情况：SPOE 配置中 `500ms` |
| `option set-process-time` | 将 SPOE 延迟导出到变量中以供监控 |
| `option set-total-time` | 导出 SPOE 总耗时 |
| Pipelining | SPOE v1.2+ 始终启用 |

```haproxy
# coraza.cfg spoe-agent 段中：
option set-process-time waf_spoe_processing
option set-total-time waf_spoe_total
```

### 4. 日志

**WAF 事件变量**（可在 `log-format` 中使用）：
```haproxy
# 标准跟踪
log-format "%ci:%cp [%tr] %ft %b/%s %TR/%Tw/%Tc/%Tr/%Ta %ST %B %CC %CS %tsc %ac/%fc/%bc/%sc/%rc %sq/%bq %{+Q}r waf_action=%[var(txn.coraza.action)] waf_score=%[var(txn.coraza.anomaly_score)] waf_rules=%[var(txn.coraza.rules_hit)]"

# 调试模式（逐规则 ID）——在 SPOE 消息中添加 exportRuleIDs=bool(true)
# waf_rule_ids=%[var(txn.coraza.rule_ids)]
```

**SPOE 内部日志**（通过 spoe-agent 中的 `log global`）：
```
SPOE: [AGENT] coraza-req SENT    pT 1.2ms  # 处理时间
SPOE: [AGENT] coraza-req RECV    pT 0.8ms
```

静默成功事件：
```haproxy
spoe-agent coraza-agent
    option dontlog-normal
```

### 5. Fail-Open vs Fail-Closed

| 策略 | 配置 | 适用时机 |
|----------|---------------|-------------|
| **Fail-Open**（默认） | 无 `txn.coraza.error` 规则；超时/出错时请求放行 | 高可用优先；非关键路径 |
| **Fail-Closed** | `http-request deny deny_status 500 if { var(txn.coraza.error) -m int gt 0 }` | 受监管环境；关键 API |

**混合方案**：大部分流量 fail-open，敏感端点 fail-closed：
```haproxy
acl sensitive path_beg /api/admin /api/payment
http-request deny deny_status 500 if sensitive { var(txn.coraza.error) -m int gt 0 }
```

### 6. CRS 升级流程

1. 在部署中**固定版本**（Docker 标签、Helm chart 版本、二进制发布）
2. 阅读 coraza-spoa CHANGELOG 了解内嵌 CRS 版本升级
3. 以 `SecRuleEngine DetectionOnly` 部署到预发环境
4. 运行 **go-ftw** 回归测试（coraza-spoa CI 使用这些测试）
5. 运行你自己的误报回归套件
6. 验证通过后切换为 `SecRuleEngine On`

---

## 方案对比

| 方案                           | 成熟度    | 维护              | 覆盖范围          | 最适用于                  |
| ---------------------------- | ------ | --------------- | ------------- | --------------------- |
| **Coraza SPOA + CRS**        | 生产可用 ✅ | 活跃（Coraza 核心团队） | 完整 CRS v4     | 开源 HAProxy WAF 标准     |
| HAProxy 中的 ModSecurity v3    | 不支持 ❌  | N/A             | N/A           | N/A——无开源集成            |
| HAProxy Enterprise WAF       | 企业版 ✅  | 厂商支持            | 专有 + CRS      | 预算允许、需要 SLA           |
| 外部 WAF（Cloudflare、AWS WAF 等） | 托管 ✅   | 厂商              | 视产品而定         | 卸载运维、Bot 管理、上游 TLS 终止 |
| 原生 ACL“穷人版 WAF”              | 原生 ✅   | 自行              | 部分（无法检查 body） | 仅作补充；扫描器噪声抑制          |
| stick-table 限速               | 原生 ✅   | 自行              | L7 DDoS、暴力破解  | **任何 WAF 的必要补充**      |
| fail2ban / CrowdSec          | 社区     | 不定              | 基于日志的响应式      | 旧系统；优先选 CrowdSec      |

**原生 ACL 模式**（来自 HAProxy 博客）：
```haproxy
# 阻断已知恶意 User-Agent
acl bad_ua hdr(user-agent) -m sub -i sqlmap nikto nessus
http-request deny deny_status 403 if bad_ua

# 加固敏感路径
acl admin_path path_beg /admin /wp-admin /phpmyadmin
http-request deny deny_status 403 if admin_path !{ src -f /etc/haproxy/allowlist.lst }

# 方法白名单
http-request deny deny_status 405 unless { method GET HEAD POST OPTIONS }

# 畸形 HTTP（与 Coraza 示例一致）
http-request deny deny_status 400 if !HTTP_1.0 !HTTP_1.1 !HTTP_2.0

# 限速（stick-table）
stick-table type ip size 100k expire 2m store http_req_rate(1m)
http-request track-sc0 src
http-request deny deny_status 429 if { sc_http_req_rate(0) gt 100 }
```

---

## 与 haproxy-ui 的集成（未来实现）

实现时，haproxy-ui 可以管理**配置编排**层：

### 计划能力

| 功能 | 描述 |
|---------|-------------|
| **SPOE 配置生成** | 从 UI 生成 `coraza.cfg`（应用、超时、后端引用） |
| **按应用 CRS 调优** | PL 选择器、`SecRuleEngine` 模式（DetectionOnly/On）、按应用的排除项 UI |
| **排除规则管理** | `SecRuleRemoveById`、`ctl:ruleRemoveTargetById` 的可视化编辑器，支持路径作用域；存储在 SQLite，历史版本化 |
| **模式切换** | 一键在 DetectionOnly ⇄ On 之间切换（按应用，带确认） |
| **事件关联** | 从日志解析 `txn.coraza.*` → 仪表板（异常分数趋势、命中最多的规则、被阻断的 IP） |
| **告警集成** | WAF 阻断 → 现有的 webhook/SSE 告警管道 |
| **CRS 版本跟踪** | 显示内嵌 CRS 版本；带仅检测验证门槛的升级流程 |

### 非目标（超出范围）

- **coraza-spoa 进程生命周期**（通过 Docker/systemd/Helm 部署是基础设施问题）
- **WAF 配置变更时 HAProxy reload**（已由现有的事务性配置管道处理）
- **规则编写**（使用 CRS；仅通过排除项 UI 做自定义规则）

### 数据模型补充（未来）

```sql
-- WAF 应用配置
CREATE TABLE waf_applications (
    id TEXT PRIMARY KEY,
    node_group_id TEXT REFERENCES node_groups(id),
    name TEXT NOT NULL,                    -- 与 txn.coraza.app 匹配
    paranoia_level INTEGER DEFAULT 2,      -- 1-4
    blocking_paranoia_level INTEGER DEFAULT 1,
    engine_mode TEXT DEFAULT 'DetectionOnly', -- 'DetectionOnly' | 'On'
    response_inspection BOOLEAN DEFAULT false,
    directives_override TEXT,              -- 自定义 SecRule* 行（追加）
    created_at INTEGER, updated_at INTEGER
);

-- 排除规则（按应用）
CREATE TABLE waf_exclusions (
    id TEXT PRIMARY KEY,
    waf_application_id TEXT REFERENCES waf_applications(id) ON DELETE CASCADE,
    rule_id INTEGER NOT NULL,              -- 要排除的 CRS 规则 ID
    type TEXT NOT NULL,                    -- 'remove' | 'remove_target' | 'update_target'
    target TEXT,                           -- 例如 'ARGS:payload'（用于 remove_target）
    condition TEXT,                        -- 可选的 SecRule 条件（例如 REQUEST_URI @beginsWith /api/webhook）
    created_at INTEGER
);

-- WAF 审计事件（为仪表板反规范化）
CREATE TABLE waf_events (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    application TEXT NOT NULL,
    client_ip TEXT,
    method TEXT, path TEXT,
    action TEXT,                           -- 'deny' | 'drop' | 'pass' | 'error'
    anomaly_score INTEGER,
    rule_ids TEXT,                         -- JSON 数组
    error_code INTEGER
);
```

---

## 快速参考：常见任务

### 新增应用 WAF 配置

1. 在 `coraza-spoa.yaml` 中新增 application 块
2. 在目标前端设置 `http-request set-var(txn.coraza.app) str(<name>)`
3. 重载 HAProxy（事务性配置）
4. 重载 coraza-spoa（`systemctl reload coraza-spoa` 或 SIGHUP）

### 为 `/api/webhook` 载荷调优误报

```yaml
# coraza-spoa.yaml 的 application.directives 中：
SecRule REQUEST_URI "@beginsWith /api/webhook" \
  "id:100001,phase:1,pass,nolog,ctl:ruleRemoveTargetById=942100;ARGS:payload"
```

仅重载 coraza-spoa（无需重载 HAProxy）。

### 启用响应检查以防范数据泄露

```haproxy
# coraza.cfg 中：
spoe-agent coraza-agent
    messages coraza-req coraza-res   # 添加 coraza-res

# haproxy.cfg 前端中：
http-response deny deny_status 403 \
    hdr waf-block "response" \
    if { var(txn.coraza.action) -m str deny }
```

### 监控 WAF 延迟

```haproxy
# coraza.cfg spoe-agent 中：
option set-process-time waf_proc
option set-total-time waf_total

# log-format 中：
%[var(txn.waf_proc)] %[var(txn.waf_total)]
```

---

## 故障排查

| 症状 | 可能原因 | 修复 |
|---------|--------------|-----|
| 所有请求返回 500 | coraza-spoa 宕机/不可达 | 检查后端健康（`spop-check`）、防火墙、进程状态 |
| 延迟尖峰高 | `timeout processing` 过高或代理过载 | 降低超时；扩展代理；检查 `waf_proc` 指标 |
| 合法流量被阻断 | CRS 误报 | 检查 `waf_rule_ids`，添加排除项；考虑降低 PL |
| WAF 未触发 | `send-spoe-group` 缺失或位于 `filter spoe` 之前 | 将 `filter spoe` 移到 `send-spoe-group` 之前；核对变量名 |
| 响应检查不生效 | SPOE 配置中没有 `coraza-res` 消息 | 在 spoe-agent 中加 `messages coraza-res`；定义 `spoe-message coraza-res` |

---

## 参考资料

- **coraza-spoa 仓库**：https://github.com/corazawaf/coraza-spoa
- **Coraza WAF 引擎**：https://github.com/corazawaf/coraza
- **OWASP CoreRuleSet**：https://coreruleset.org/
- **HAProxy SPOE 文档**：https://github.com/haproxy/haproxy/blob/master/doc/SPOE.txt
- **HAProxy 博客 - Coraza WAF**：（原文已废弃；以 coraza-spoa README 为准）
- **HAProxy 博客 - 响应策略**：https://www.haproxy.com/blog/use-haproxy-response-policies-to-stop-threats
- **HAProxy 博客 - 速率限制**：https://www.haproxy.com/blog/four-examples-of-haproxy-rate-limiting
- **CRS 怀疑度等级**：https://coreruleset.org/docs/concepts/paranoia_levels/
- **CRS 误报处理**：https://coreruleset.org/docs/concepts/false_positives_and_tuning/

---

## 变更日志

| 日期 | 版本 | 描述 |
|------|---------|-------------|
| 2026-09-07 | 1.0 | 基于 Coraza SPOA v0.7.3 调研的初始设计文档 |

---

*本文档将在实现开始时更新（计划为 P11+）。*