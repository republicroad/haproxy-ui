# WAF 日志存储：业界厂商实际技术栈

> 本文整理 Cloudflare、HAProxy Enterprise、Akamai、AWS、Azure、GCP、Imperva、Fortinet、Palo Alto、Barracuda、F5、NGINX、Check Point、Wallarm、Sucuri、ModSecurity、Sophos、Radware、Fastly、HUMAN/PerimeterX、Vercel 等厂商在 WAF/安全日志存储上的**真实生产架构**（来自官方博客、文档、技术分享），而非通用推荐方案。

---

## 一、总览对比

| 厂商                       | 主存储                                   | 缓冲         | 导出方式                               | 默认保留                       | 查询工具                     |
| ------------------------ | ------------------------------------- | ---------- | ---------------------------------- | -------------------------- | ------------------------ |
| **Cloudflare**           | **ClickHouse**（36 节点，主力） + ELK（90 节点） | Kafka      | Logpush（S3/HTTP） + R2 Log Explorer | 24 小时-180 天（计划相关）          | GraphQL API + Grafana    |
| **HAProxy Enterprise**   | **ELK**（Elasticsearch + Kibana）       | —          | Rsyslog                            | 30 天                       | Kibana + Metricbeat      |
| **Akamai**               | **S3 + SIEM**（Splunk/Sentinel）        | Lambda 过滤  | SIEM API / DataStream2             | 热 30-90 天 / 冷 1-7 年        | SIEM 原生仪表板               |
| **AWS WAF**              | **S3 + Athena**（推荐）                   | Firehose   | CloudWatch / Firehose / S3         | 30 天（可配至 2 年）              | Athena + QuickSight      |
| **Azure WAF**            | **Log Analytics** + Storage Account   | —          | Azure Monitor 诊断设置                 | 30 天（LA）/ 永久（Storage）      | KQL（Log Analytics）       |
| **GCP Cloud Armor**      | **BigQuery**（推荐）                      | Log Router | Cloud Logging → Sink               | 30 天（默认）/ 400 天（_Required） | BigQuery SQL             |
| **Imperva**              | 云仓库（按客户隔离）                            | —          | API Pull / S3 Push / Syslog        | 未公开                        | SIEM 原生仪表板               |
| **Fortinet FortiWeb**    | **FortiAnalyzer**（本地）                 | —          | OFTP / Syslog / ArcSight           | 设备本地：100K-2M 条/类型          | FortiAnalyzer            |
| **Palo Alto**            | **Strata Logging Service**（云）         | —          | Syslog / API / Panorama            | 1 年（新授权）                   | Strata Cloud Manager     |
| **Barracuda**            | 设备本地 + 外发 Syslog                      | —          | Syslog / Azure Event Hub           | SaaS：30-60 天               | Barracuda XDR            |
| **F5 BIG-IP**            | 本地 MySQL/SyslogDB（有限）                 | —          | HSL / Syslog / Splunk / ArcSight   | 未公开                        | BIG-IQ Logging Node      |
| **F5 Distributed Cloud** | 云存储（FR 30 天 + DE 1 年备份）               | —          | S3/Kafka/Splunk/Datadog 等          | 30 天 + 1 年备份               | Global Log Receiver      |
| **NGINX App Protect**    | 本地文件                                  | —          | Syslog / 本地文件                      | 手动轮转                       | ELK / Splunk             |
| **Check Point**          | Log Server / SmartEvent               | —          | Log Exporter（syslog）               | CloudGuard：3 年             | SmartEvent               |
| **Wallarm**              | SaaS 云存储（默认 3 个月）                     | —          | S3/MinIO/Fluentd/Splunk            | 3 个月                       | 原生 UI                    |
| **Sucuri**               | 内存（不存请求包）                             | —          | Syslog / API                       | 长期（未公开）                    | SOC + Dashboard          |
| **ModSecurity**          | 本地文件（Serial/Concurrent）               | —          | mlogc → HTTP 端点                    | 手动（logrotate）              | ELK / Splunk             |
| **Sophos**               | 设备本地（/var 分区，15% 配额）                  | —          | Syslog（最多 5 台）/ Sophos Central     | Central：90 天               | Sophos Central Dashboard |
| **Radware**              | 云 WAF：AWS；DefensePro：本地               | —          | S3/Azure/SQS/Syslog                | 未公开                        | SIEM 原生仪表板               |
| **Fastly NGWAF**         | 云引擎（≤30 天）                            | —          | Real-Time Log Streaming            | ≤30 天                      | 自托管仪表板                   |
| **HUMAN/PerimeterX**     | AWS/GCP/Equinix                       | —          | S3/Splunk/Datadog/Webhook          | 按策略（未公开）                   | HUMAN Portal             |
| **Vercel**               | Vercel 基础设施                           | —          | Log Drains（HTTPS）                  | 1 小时-30 天（计划相关）            | Datadog / Dash0          |
| **MalCare**              | **ClickHouse**（单机）                    | —          | 自研 UI                              | 按需                         | 自研 Rails + SQL           |

---

## 二、Cloudflare

### 2.1 日志管道全景

来源：[An overview of Cloudflare's logging pipeline](https://blog.cloudflare.com/an-overview-of-cloudflares-logging-pipeline/)、[Log analytics using ClickHouse](https://blog.cloudflare.com/log-analytics-using-clickhouse/)、[Over 700M events/second](https://blog.cloudflare.com/how-we-make-sense-of-too-much-data/)

```
全球边缘节点（35-45M req/s）
  │
  ▼
Logreceiver（自研）── 自适应采样（100%/10%/1%/0.1%）
  │
  ▼
Kafka（分布式队列）
  │
  ├─▶ Logstash → Elasticsearch（90 节点，master/data/HTTP 分离）
  │     └─ Kibana（内部调试）
  │
  ├─▶ ClickHouse Inserter（自研，Cap'n Proto 编码）
  │     └─ ClickHouse（36 节点，x3 副本）
  │
  └─▶ Logpush → 客户端（S3/HTTP 端点）
```

### 2.2 ClickHouse 主存储

| 指标 | 数值 |
|------|------|
| 节点数 | 36 节点，x3 副本 |
| 写入速率 | 11M rows/s（峰值更高） |
| 写入带宽 | 47 Gbps |
| 查询 QPS | ~40（峰值 ~80） |
| 数据格式 | Cap'n Proto（传输）→ ClickHouse 原生格式 |
| 分区策略 | `toStartOfHour(dateTime)`，按小时分区 |
| 表引擎 | `ReplicatedAggregatingMergeTree`（物化视图预聚合） |
| 压缩比 | ES 600 字节/行 → ClickHouse 60 字节/行（**10x**） |

### 2.3 R2 Log Explorer

- 日志直接存储在 **R2**（Cloudflare S3 兼容存储），通过 Dashboard/API 查询
- Zero Trust 日志保留：Free 24 小时 / Standard 30 天 / Enterprise 180 天

---

## 三、HAProxy Enterprise

### 3.1 架构

```
HAProxy Enterprise
  ├─▶ Rsyslog → Elasticsearch → Kibana
  ├─▶ Metricbeat（HAProxy 模块）→ Elasticsearch
  └─▶ stdout（Docker）→ logspout / 外部聚合
```

---

## 四、Akamai

### 4.1 导出机制

| 机制 | 延迟 | 适用场景 |
|------|------|---------|
| **SIEM API**（Pull） | 近实时 | SIEM 集成 |
| **DataStream2**（Push） | 近实时（可配窗口） | 自定义存储 |
| **ULS**（Universal Log Shipper） | 近实时 | 多产品统一采集 |
| **LDS**（Log Delivery Service） | 非实时（批量） | 合规归档 |

**DataStream2 支持目标**：Amazon S3、Azure Storage、GCS、Datadog、Dynatrace、New Relic、Elasticsearch、Splunk、Sumo Logic、Loggly、Oracle Cloud、TrafficPeak

### 4.2 核心模式：外部过滤层

**过滤效果**：47 GB/天 → 890 MB/天（**98% 减少**）

---

## 五、AWS WAF

### 5.1 日志导出

```
AWS WAF（每个请求一条日志，1-5 KB）
  │
  ├─▶ CloudWatch Logs（Vended Logs）
  ├─▶ Amazon Data Firehose（Direct PUT）
  │     └─▶ S3 + Athena + QuickSight
  │     └─▶ OpenSearch Serverless
  │     └─▶ Splunk / Datadog
  └─▶ Amazon Security Lake（Parquet/OLM 格式）
```

### 5.2 成本

| 项目          | 费用                       |
| ----------- | ------------------------ |
| Firehose    | ~$0.029/GB（5 KB 最小记录）    |
| Vended Logs | $0.50/GB（每百万请求免费 500 MB） |
| S3 Standard | $0.023/GB/月              |
| S3 Glacier  | $0.004/GB/月              |
| Athena      | $5/TB 扫描                 |

---

## 六、Azure WAF

### 6.1 特点

- **诊断设置**：需手动启用（默认关闭）
- **Log Analytics**：默认 30 天，可扩展至 2 年
- **Storage Account**：无限期保留

### 6.2 成本

| 项目 | 费用 |
|------|------|
| Log Analytics 摄入 | ~$2.76/GB（前 5 GB/月免费） |
| Storage Account（冷层） | ~$0.018/GB/月 |

---

## 七、GCP Cloud Armor

### 7.1 成本

| 项目 | 费用 |
|------|------|
| Cloud Logging | $0.50/GiB（前 50 GiB/项目/月免费） |
| Cloud Armor Standard | $0.75/百万请求 |
| Cloud Armor Enterprise（按量） | $0.274/小时 + $0.05/GiB |

---

## 八、Imperva / Incapsula

### 8.1 架构

```
Imperva WAF（云端）
  └─▶ 云仓库（按客户隔离）
        ├─▶ API Pull（Imperva Client 解密后推送）
        ├─▶ S3 Push（CEF 格式，压缩）
        ├─▶ Azure Blob Push
        └─▶ Syslog → SIEM
```

支持 11 种 SIEM：Splunk、QRadar、Sentinel、InsightIDR、Chronicle、Sumo Logic、LogScale、Elastic、Datadog、Graylog、Taegis XDR

---

## 九、Fortinet FortiWeb

### 9.1 FortiAnalyzer（集中存储）

| 型号 | 日志速率 | 存储容量 |
|------|---------|---------|
| FAZ-300G | 100 GB/天，2,000 logs/s | 4 TB |
| FAZ-3750G | 8,300 GB/天，100,000 logs/s | 305 TB |

---

## 十、Palo Alto Networks

### 10.1 Strata Logging Service

- **默认 1 年保留**，**无限存储空间**（2024 年 10 月新授权层级）

---

## 十一、Barracuda WAF

### 11.1 保留

- WAF-as-a-Service：Advanced 30 天 / Premium 60 天 / Audit Logs 180 天

---

## 十二、F5（BIG-IP / Distributed Cloud）

### 12.1 BIG-IP ASM

- F5 官方警告："BIG-IP 系统不是日志服务器"
- 本地 MySQL/SyslogDB 容量有限（~100K 条）
- 必须通过 HSL（Remote High-Speed Logging）外发到 Syslog/Splunk/ArcSight

### 12.2 F5 Distributed Cloud

- 压缩 gzip NDJSON 每 5 分钟写入
- 支持 11+ 目标：AWS CloudWatch/S3、Azure Blob/Event Hubs、GCP Bucket、Splunk、Datadog、Kafka、QRadar、Sumo Logic、New Relic、Generic HTTP/HTTPS
- 数据存储在法国（30 天），加密备份在德国（1 年）

---

## 十三、NGINX App Protect WAF

### 13.1 限制

- DoS 模块日志限速：攻击期间 **50 RPS**
- 无原生 SIEM 集成，依赖 syslog 转发
- 无内置压缩/轮转

---

## 十四、Check Point（Quantum AppSec / CloudGuard）

### 14.1 Log Exporter

- Syslog over TCP/UDP + TLS 1.2 双向认证
- 格式：CEF / LEEF / JSON / Splunk / LogRhythm
- CloudGuard 审计日志保留 **3 年**

---

## 十五、Wallarm（云原生 WAF）

### 15.1 特点

- 默认保留 **3 个月**，官方建议"如需更长保留应定期导出"
- S3/MinIO 导出每 10 分钟一次（JSON / NDJSON / OCSF）

---

## 十六、Sucuri（网站安全 WAF）

### 16.1 特点

- **所有分析在内存中完成**，不存储原始请求包
- 仅存储元数据作为 Web 访问日志（OSSEC 格式）
- 企业客户有 SOC 团队辅助日志分析

---

## 十七、ModSecurity（开源 WAF）

### 17.1 两种模式

| 模式 | 特点 | 适用场景 |
|------|------|---------|
| **Serial** | 所有条目写入单文件 | 中低流量 |
| **Concurrent** | 每事务独立文件，主文件作索引 | 高流量 + mlogc |

- **mlogc**：可靠远程日志传输（HTTP 协议，确认后删除，崩溃恢复）
- 典型条目：~1.3-1.5 KB（短 GET 请求）

---

## 十八、Sophos（Sophos XG / Sophos Firewall）

### 18.1 本地存储

- 日志存储在设备 `/var` 分区
- 配额：**15% 的 /var 分区**或 **50% 空闲空间**（取较小值）

### 18.2 导出方式

- **Syslog**：最多 5 台日志服务器（UDP/TCP 514）
- **Sophos Central**：云管理平台，默认保留 **90 天**
- **API**：Sophos Central API 配置转发到 SIEM

### 18.3 特点

- 支持 Google Chronicle（Bindplane agent）、Rapid7、Splunk、Elastic
- Sophos Central 报告保留：最长 **1 年**（可配置）

---

## 十九、Radware（DefensePro / Cloud WAF）

### 19.1 架构

```
Radware WAF
  ├─▶ DefensePro（本地设备）→ Syslog → 外部 SIEM
  └─▶ Cloud WAF（AWS 托管）
        ├─▶ S3 / Azure Blob（访问日志）
        ├─▶ Amazon SQS + Logstash/Syslog（安全事件）
        └─▶ Cloud WAAP Logging Integration Tool（GitHub 免费）
```

### 19.2 特点

- **DefensePro**：经审计测试 **1500 万 PPS** DDoS 防护
- **Cloud WAAP Logging Integration Tool**：开源 Lambda 工具，支持 S3/Azure/SFTP 重格式化
- 无具体日志保留/吞吐量数字公开

---

## 二十、Fastly NGWAF（Signal Sciences）

### 20.1 数据存储策略

来源：[Fastly NGWAF Data Storage](https://www.fastly.com/documentation/guides/next-gen-waf/data-storage-and-privacy/about-data-storage-and-privacy)

| 信号类型 | 存储策略 |
|---------|---------|
| **All**：攻击信号（SQLi/XSS/CVE） | 完整请求数据存储 |
| **Sampled**：异常/Bot/自定义信号 | 随机采样存储 |
| **Time series only**：信息性/API 信号 | 不存储单个请求数据 |

### 20.2 导出方式

- **Real-Time Log Streaming**：S3、GCS、Azure Blob、Datadog、Elasticsearch、Splunk、Sumo Logic、Syslog
- **本地日志**：`waf-data-log` 写入本地文件
- **API**：Signal Sciences REST API 请求数据

### 20.3 限制

- 单个请求数据保留 **≤30 天**
- 数据只能在创建后 **24 小时内**提取
- Agent 延迟 **<3ms**
- **90%+ 客户**运行在完全阻止模式

---

## 二十一、HUMAN Security / PerimeterX

### 21.1 架构

```
HUMAN Bot Defender / Account Defender
  │
  └─▶ HUMAN Portal（AWS/GCP/Equinix）
        │
        ├─▶ Amazon S3（主要导出方式）
        ├─▶ Splunk（原生集成 + 预建仪表板）
        ├─▶ Datadog / Sumo Logic
        ├─▶ HTTP Webhook
        └─▶ Syslog
```

### 21.2 特点

- 验证 **每周 15 万亿+ 交互**（全产品线）
- 日志类型：Legitimate / Block / CAPTCHA / Account Defender
- 数据架构：`client_ip`、`full_url`、`http_method`、`http_status`、`incident_types`、`ivt` 类别

---

## 二十二、Vercel（Edge Firewall）

### 22.1 架构

```
Vercel Firewall（300ms 全球生效）
  │
  └─▶ Log Drains（HTTPS，JSON/NDJSON）
        ├─▶ Datadog / Dash0
        └─▶ 自定义端点
```

### 22.2 保留

| 计划 | 运行时日志保留 |
|------|-------------|
| Hobby | 1 小时 |
| Pro | 1 天 |
| Pro + Observability Plus | 30 天 |
| Enterprise | 3 天 |
| Enterprise + Observability Plus | 30 天 |

### 22.3 限制

- 每条日志最大 **256 KB**，每请求最大 **1 MB**
- WAF 字段：`proxy.wafAction`（log/challenge/deny/bypass/rate_limit）、`proxy.wafRuleId`

---

## 二十三、MalCare（WAF SaaS，10 亿行/天）

- **单台 ClickHouse** 承载 50 万网站，每天 **10 亿+ 行**，CPU 个位数
- 从 MongoDB 迁移（双写 → 切读 → 完全切换）
- **隐藏杀手**：`system.query_log` 默认开启，曾长到比数据表还大

---

## 二十四、共性模式与选型建议

### 24.1 业界共识

| 模式 | 采用者 | 原因 |
|------|--------|------|
| **ClickHouse 作为主力日志存储** | Cloudflare、MalCare、Trip.com、快手 | 列式压缩 10x、单机吞吐极高 |
| **Kafka 作为缓冲层** | Cloudflare、Trip.com、F5 | 解耦采集与存储 |
| **外部过滤层（不直接灌 SIEM）** | Akamai、所有大型部署 | 控制 SIEM 成本（98% 减少） |
| **冷热分层** | 所有厂商 | 热 SSD + 冷 S3/Glacier |
| **自适应采样** | Cloudflare、F5、Fastly | 小客户不丢数据，大客户控成本 |
| **云原生集成** | AWS/Azure/GCP/Vercel | Firehose/Event Hub/Log Drains 一键接入 |
| **本地磁盘 + 外发** | Fortinet/Barracuda/F5 BIG-IP/Sophos | 设备本地快速查询，外发做长期存储 |

### 24.2 按规模选型

| 日志量 | 推荐方案 | 理由 |
|--------|---------|------|
| <10 GB/天 | Loki + Grafana | 最简单、最便宜 |
| 10-100 GB/天 | ES（ILM）或 ClickHouse | ES 生态成熟，ClickHouse 更省 |
| 100 GB-1 TB/天 | ClickHouse + Kafka | 列式压缩优势明显 |
| >1 TB/天 | ClickHouse 集群 + Kafka + 自研 inserter | 需要定制化 |
| 云原生环境 | AWS Firehose + S3 + Athena / Azure Log Analytics / GCP BigQuery | 云厂商原生方案，零运维 |

### 24.3 不要做的事

- ❌ 不要直接把 WAF 全量日志灌入 SIEM（成本爆炸）
- ❌ 不要在 ClickHouse 上做全文检索（用 ES）
- ❌ 不要跳过 Kafka 直连存储（耦合太紧）
- ❌ 不要忽略 `system.query_log`（ClickHouse 磁盘杀手）
- ❌ 不要忘记开启 Azure WAF 诊断设置（默认关闭）
- ❌ 不要忽略 AWS Firehose 5 KB 最小记录（按 5 KB 计费）
- ❌ 不要依赖 BIG-IP 本地存储做长期日志（F5 官方明确警告）
- ❌ 不要依赖 ModSecurity Serial 模式处理高流量
- ❌ 不要依赖 Vercel Hobby 计划做日志保留（仅 1 小时）

---

## 二十五、参考

- Cloudflare: An overview of Cloudflare's logging pipeline (2024-01)
- Cloudflare: Log analytics using ClickHouse (2022-09)
- Cloudflare: Over 700M events/second (2025-01)
- Cloudflare: How TimescaleDB helped us scale analytics (2025-07)
- HAProxy Enterprise: Elastic Stack integration docs
- Akamai: SIEM Integration TechDocs
- Akamai: DataStream 2 destinations
- AWS: WAF Logging Developer Guide
- AWS: Security Services Best Practices - WAF Logging
- Azure: Front Door WAF Logs (Microsoft Learn)
- GCP: Cloud Armor Audit Logging
- Imperva: SIEM Integration Guide
- Fortinet: FortiWeb 8.0.6 Administration Guide
- Fortinet: FortiAnalyzer 7.6 Architecture Guide
- Palo Alto: Strata Logging Service Overview
- Barracuda: WAF-as-a-Service Log Export
- F5: BIG-IP ASM Logging and Reporting
- F5: Distributed Cloud Global Log Streaming
- NGINX: App Protect Security Logs
- Check Point: Log Exporter Administration Guide
- Wallarm: Integrations Overview
- Sucuri: Technical Whitepaper
- ModSecurity: Reference Manual (v3.x)
- Sophos: Sophos Firewall Logs documentation
- Radware: Cloud WAF Access Log Integration Guide
- Radware: Cloud WAAP Logging Integration Tool (GitHub)
- Fastly: NGWAF Data Storage and Privacy
- Fastly: Real-Time Log Streaming
- HUMAN Security: Data Schema and Logs
- HUMAN Security: Splunk Integration
- Vercel: Runtime Logs
- Vercel: Log Drains Reference
- MalCare: How We Scaled Firewall Logs with ClickHouse (2026-08)
- Trip.com: How trip.com migrated from ES to ClickHouse (2024-06)

---

**文档版本**：v1.0
**更新日期**：2026-09-10
**位置**：`docs/bestpractice/waf-log-vendor-stacks.md`
