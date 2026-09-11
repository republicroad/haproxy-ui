# WAF 日志存储最佳实践：业界数据管道与存储方案

> 核心结论：**WAF 日志存储不是单一产品选型问题，而是一条分层管道（采集 → 缓冲 → 入库 → 查询 → 归档）**。业界共识是：采集端用轻量 Daemon（Fluent Bit / Vector），缓冲层用 Kafka 解耦，存储层按查询需求选 Elasticsearch / ClickHouse / Loki，冷数据归档到 S3 / 对象存储。

---

## 一、WAF 日志长什么样

HAProxy / Cloudflare / AWS WAF 等产出的 WAF 日志典型字段：

```json
{
  "timestamp": "2026-09-10T12:34:56.789Z",
  "client_ip": "203.0.113.42",
  "client_port": 54321,
  "frontend": "web-frontend",
  "backend": "app-backend",
  "http_method": "POST",
  "http_path": "/api/login",
  "http_status": 403,
  "bytes_in": 512,
  "bytes_out": 0,
  "request_time_ms": 12,
  "waf_action": "BLOCK",
  "waf_rule_id": "SQLi-001",
  "waf_rule_group": "owasp-crs",
  "user_agent": "curl/7.68",
  "host": "example.com",
  "x_forwarded_for": "10.0.0.1",
  "termination_state": "SF",
  "server_id": 3
}
```

**数据特征**：
- **高写入吞吐**：中型站点 10 万+ req/s = 每天数十亿行
- **结构化 JSON**：字段固定，时间戳必有
- **写多读少**：实时查询占比低（调试/告警），合规归档占比高（30–365 天）
- **查询模式**：按时间范围 + IP/路径/status 筛选，聚合统计（QPS、状态码分布、top IP）

---

## 二、管道架构全景

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  HAProxy /   │     │  Fluent Bit  │     │   Kafka          │
│  WAF 网关    │────▶│  / Vector    │────▶│  (缓冲/解耦)      │
│  (stdout/    │     │  Daemon      │     │                  │
│   syslog)    │     │  (每节点)    │     │                  │
└──────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────────────┐
                    ▼                              ▼                          ▼
            ┌──────────────┐             ┌──────────────┐           ┌──────────────┐
            │ Elasticsearch│             │ ClickHouse   │           │ Loki + S3    │
            │ (全文检索)    │             │ (列式压缩)    │           │ (标签索引)    │
            └──────┬───────┘             └──────┬───────┘           └──────┬───────┘
                   ▼                            ▼                          ▼
            ┌──────────────┐             ┌──────────────┐           ┌──────────────┐
            │ Kibana       │             │ Grafana SQL  │           │ Grafana      │
            │ Dashboards   │             │ / ClickHouse │           │ Explore      │
            └──────────────┘             │ Console      │           └──────────────┘
                                         └──────────────┘
```

### 按场景选存储

| 场景              | 首选存储                     | 原因            |
| --------------- | ------------------------ | ------------- |
| 实时调试/告警（7 天热数据） | Elasticsearch            | 全文检索、聚合、告警最成熟 |
| 合规归档（30–365 天）  | S3 + Athena / ClickHouse | 成本最低          |
| 高吞吐写入（>10 亿行/天） | ClickHouse               | 列式压缩，单机吞吐极高   |
| 低运维/轻量级         | Loki                     | 仅索引标签，S3 存原文  |
| 需要全文检索 + 长期归档   | ES 热 + S3 冷              | ILM 自动分层      |

---

## 三、采集层：Fluent Bit / Vector / Fluentd

### 3.1 Fluent Bit（最轻量，K8s DaemonSet 首选）

```yaml
# Fluent Bit 配置：HAProxy syslog → Kafka
[INPUT]
    Name          tail
    Path          /var/log/haproxy/access.log
    Parser        haproxy
    Tag           haproxy.access
    Mem_Buf_Limit 50MB

[FILTER]
    Name          parser
    Match         haproxy.access
    Parser        haproxy
    Key_Name      log

[OUTPUT]
    Name          kafka
    Match         haproxy.access
    Brokers       kafka-0:9092,kafka-1:9092,kafka-2:9092
    Topics        waf-logs
    Message_Key   client_ip
    Format        JSON
    Request_Timeout 10
```

- 内存占用 ~650KB（C 实现）
- K8s DaemonSet 每节点一个实例
- 关键参数：`Mem_Buf_Limit` 防止 OOM

### 3.2 Vector（功能最丰富，Rust 实现）

```toml
# Vector：HAProxy → Kafka（agent 角色）
[sources.haproxy_logs]
  type = "file"
  include = ["/var/log/haproxy/access.log"]

[transforms.parse]
  type = "remap"
  inputs = ["haproxy_logs"]
  source = '''
    . = parse_json!(.message)
    .@timestamp = now()
  '''

[sinks.kafka]
  type = "kafka"
  inputs = ["parse"]
  bootstrap_servers = "kafka-0:9092,kafka-1:9092,kafka-2:9092"
  topic = "waf-logs"
  encoding.codec = "json"
```

- VRL（Vector Remap Language）做转换/脱敏
- 内置 disk buffer（`when_full: block`）防止数据丢失
- 比 Fluent Bit 更强的转换能力，但运维经验积累略少

### 3.3 Fluentd（Ruby 生态，插件最多）

- 介于 Fluent Bit 和 Vector 之间
- 适合作为中间聚合层（Fluent Bit → Fluentd → Kafka）
- 内存 ~40-60MB，比 Fluent Bit 重

**选型建议**：
- K8s 环境首选 Fluent Bit（轻、稳定、生态成熟）
- 需要复杂转换/路由时选 Vector
- 已有 Ruby/Fluentd 生态时继续用 Fluentd

---

## 四、缓冲层：Kafka

### 为什么需要 Kafka

| 直连（无 Kafka） | 有 Kafka |
|-----------------|---------|
| 采集与存储紧耦合 | 采集与存储解耦 |
| 存储升级时丢日志 | Kafka 保留 24h+，可回放 |
| 只有一个消费者 | 多消费者（ES + S3 + 告警） |

### Topic 设计

```
waf-logs           # HAProxy WAF 日志
waf-logs-blocked   # 仅被拦截的请求（过滤后，体积小 80-90%）
```

- 分区数 = 消费者并行度（通常 3-8 个分区够用）
- 保留时间 ≥24h（给消费者故障留回放窗口）
- 按 `client_ip` 哈希分区可保序（但大多数场景 round-robin 更优）

---

## 五、存储层

### 5.1 Elasticsearch / OpenSearch（全文检索之王）

**优势**：全文搜索、Kibana 可视化、告警、ILM 自动分层
**劣势**：存储昂贵（每字段都索引）、写入放大

**生产配置**：
```json
PUT _template/waf-logs
{
  "index_patterns": ["waf-logs-*"],
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "refresh_interval": "30s"
  },
  "mappings": {
    "properties": {
      "timestamp":   { "type": "date" },
      "client_ip":   { "type": "ip" },
      "http_status": { "type": "short" },
      "waf_action":  { "type": "keyword" },
      "waf_rule_id": { "type": "keyword" },
      "http_path":   { "type": "keyword", "index": false },
      "user_agent":  { "type": "text", "index": false }
    }
  }
}
```

**ILM 分层策略**：
```
热（7天）: SSD, 1 副本 → warm（30天）: HDD, 0 副本 → 冷（90天）: S3 snapshot → 删除（91天）
```

**查询示例**：
```sql
-- Kibana SQL / OpenSearch SQL
SELECT client_ip, COUNT(*) as hits
FROM waf-logs-*
WHERE timestamp > NOW() - INTERVAL 1 HOUR
  AND waf_action = 'BLOCK'
GROUP BY client_ip
ORDER BY hits DESC
LIMIT 20
```

**成本参考**：~$0.10/GB/月（热存储）

### 5.2 ClickHouse（列式压缩，吞吐之王）

**优势**：压缩比 5-10x、单机日写入 10 亿+行、SQL 查询
**劣势**：全文检索不如 ES、生态工具不如 ES 成熟

**生产案例**：
- MalCare：50 万网站 WAF 日志，每天 10 亿+ 行，单机即可承载
- Cloudflare：用 ClickHouse 处理海量 HTTP 分析数据

**表结构**：
```sql
CREATE TABLE waf_logs ON CLUSTER '{cluster}'
(
    timestamp        DateTime64(3),
    client_ip        IPv4,
    http_method      LowCardinality(String),
    http_path        String,
    http_status      UInt16,
    waf_action       LowCardinality(String),
    waf_rule_id      LowCardinality(String),
    bytes_in         UInt32,
    request_time_ms  UInt16
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/waf_logs', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (client_ip, timestamp)
TTL timestamp + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;
```

**查询示例**：
```sql
SELECT
    client_ip,
    count() AS hits,
    avg(request_time_ms) AS avg_latency
FROM waf_logs
WHERE timestamp > now() - INTERVAL 1 HOUR
  AND waf_action = 'BLOCK'
GROUP BY client_ip
ORDER BY hits DESC
LIMIT 20
```

**存储成本**：~$0.01-0.02/GB/月（列式压缩后），比 ES 低 5-10x

### 5.3 Grafana Loki（标签索引，最便宜）

**优势**：仅索引标签（不索引日志内容）、S3 存原价、Grafana 集成好
**劣势**：全文检索需扫描压缩块（慢）

**架构**：标签索引（BoltDB/TSDB）+ 压缩块（S3/GCS）
```yaml
# Loki + S3 配置
auth_enabled: false
server:
  http_listen_port: 3100
storage:
  boltdb:
    directory: /loki/index
  filesystem:
    directory: /loki/chunks
  bucket_store:
    bucket_name: my-loki-bucket
    s3:
      endpoint: s3.us-east-1.amazonaws.com
```

**查询示例**（LogQL）：
```logql
{job="haproxy"} |= "BLOCK" | json | client_ip="203.0.113.42"
```

**存储成本**：~$0.004-0.01/GB/月（S3 存储）

### 5.4 S3 + Iceberg（数据湖归档）

**优势**：SQL 查询（Athena）、schema evolution、time travel、成本最低
**劣势**：查询延迟高（秒级起）

**架构**：Firehose → Iceberg Table on S3 → Athena 查询
```sql
-- Athena 查询
SELECT client_ip, COUNT(*) as blocked_count
FROM waf_logs_iceberg
WHERE dt = '2026/09/10'
  AND waf_action = 'BLOCK'
GROUP BY client_ip
ORDER BY blocked_count DESC
LIMIT 20
```

**存储成本**：~$0.023/GB/月（S3 标准），$0.004/GB/月（Glacier）

---

## 六、查询层

| 工具 | 对接存储 | 查询语言 | 适用场景 |
|------|---------|---------|---------|
| Kibana | Elasticsearch | KQL / SQL | 实时仪表板、告警 |
| Grafana | Loki / ClickHouse / ES | LogQL / SQL | 统一可视化 |
| Athena | S3 (Iceberg) | SQL | 偶尔查询、合规审计 |
| ClickHouse Console | ClickHouse | SQL | 深度分析 |
| Superset | ClickHouse / ES | SQL | BI 报表 |

---

## 七、日志过滤策略（降本关键）

**全量日志 → 过滤后日志，体积减少 80-90%**：

```haproxy
# HAProxy：只记录非 200 响应和特定动作
http-request set-log-level silent if { status 200 } !{ path_beg /api/ }
```

```yaml
# Fluent Bit：只转发 BLOCK/COUNT 动作
[FILTER]
    Name    grep
    Match   haproxy.access
    Regex   waf_action (BLOCK|COUNT|CHALLENGE)
```

| 过滤策略 | 日志量减少 | 风险 |
|---------|-----------|------|
| 仅记录 BLOCK/COUNT | 80-90% | 丢失正常请求审计 |
| 采样 1/10 正常请求 | 70% | 聚合统计仍有代表性 |
| 按路径过滤（仅 /api） | 视业务 | 丢失静态资源日志 |

---

## 八、生产部署模式

### 模式 A：ES 热 + S3 冷（最常见）

```
HAProxy → Fluent Bit → Kafka → ES (7天) → S3 (365天) → Athena 查询
```

- 实时告警/Kibana 仪表板 → ES
- 合规审计/历史查询 → Athena
- 成本：ES 热 + S3 冷 = 最佳平衡

### 模式 B：ClickHouse 主存储（高吞吐首选）

```
HAProxy → Vector → Kafka → ClickHouse (90天) → S3 冷 (7年)
```

- 所有查询走 ClickHouse SQL
- 成本比 ES 低 5-10x
- 适合日写入 >10 亿行的场景

### 模式 C：Loki 轻量级（小团队首选）

```
HAProxy → Fluent Bit → Loki → S3
```

- 运维最简单
- 适合日志量 <10GB/天
- Grafana 原生支持

---

## 九、成本对比（100GB/天日志量，30 天保留）

| 方案 | 月存储成本 | 月查询成本 | 月基础设施成本 | 总计 |
|------|-----------|-----------|---------------|------|
| ES 全托管（AWS） | ~$900 | 含在存储 | 含在存储 | ~$900 |
| ES 自建（3 节点） | ~$300 | $0 | ~$600 (EC2) | ~$900 |
| ClickHouse Cloud | ~$150 | $0 | ~$400 | ~$550 |
| ClickHouse 自建 | ~$80 | $0 | ~$300 | ~$380 |
| Loki + S3 | ~$70 | $0 | ~$200 | ~$270 |

---

## 十、最佳实践清单

**采集**
- [ ] 每节点部署 Fluent Bit DaemonSet，设置 `Mem_Buf_Limit`
- [ ] 日志格式统一为结构化 JSON（ECS 或 OTel 兼容）
- [ ] 启用日志过滤：只转发 BLOCK/COUNT/异常，丢弃 200 OK

**传输**
- [ ] Kafka 保留 ≥24h，分区数 = 消费者并行度
- [ ] 消费者启用批量写入（ES bulk / ClickHouse batch）

**存储**
- [ ] ES：显式 mapping，高基数字段（userId）设 `"index": false`
- [ ] ClickHouse：`ORDER BY` 对齐查询模式，`TTL` 自动过期
- [ ] 所有方案：冷热分层，S3 归档

**查询**
- [ ] 告警规则走 ES/ClickHouse，不走 S3
- [ ] 查询必须带时间范围（避免全表扫描）
- [ ] Grafana 仪表板：top blocked IPs、状态码分布、WAF 规则命中率

**运维**
- [ ] 监控 Kafka consumer lag（增长 = 下游写入瓶颈）
- [ ] 监控 Fluent Bit `mem_buf_overflow`（丢数据预警）
- [ ] 定期验证备份可恢复

---

## 十一、参考

- AWS WAF Logging Best Practices (aws.github.io, 2026)
- Let's Build Solutions: Designing a Logging Pipeline (2026-04)
- MalCare: Scaling Firewall Logs with ClickHouse (2026-08)
- KloudVin: Deploy Vector for Log Routing (2026-06)
- Alek's Blog: ES vs Loki vs ClickHouse Complete Guide (2026-05)
- Cloudflare: TimescaleDB for Analytics (2025-07)
- AWS: WAF Logs to Apache Iceberg via Firehose (2025-02)

---

**文档版本**：v1.0
**更新日期**：2026-09-10
**位置**：`docs/bestpractice/waf-log-storage-practices.md`
