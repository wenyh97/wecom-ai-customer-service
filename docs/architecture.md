# 架构文档（Architecture）

关联：[specs/plan.md](../specs/plan.md)（选型对比的权威来源，本文档补充细节）

## 1. 总体架构

```text
                        企业微信官方平台
                               │  回调事件 / 消息发送 API（占位，待官方联调）
                               ▼
                    ┌─────────────────────┐
                    │  wecom 适配器层       │  验签 / 解密 / 消息规范化
                    └─────────┬───────────┘
                              ▼
                    ┌─────────────────────┐
                    │  API 路由层 (FastAPI) │  health / wecom / chat / kb / revisit / handoff / eval
                    └─────────┬───────────┘
                              ▼
                    ┌─────────────────────┐
                    │  应用服务层 (services)│  会话编排 / AI 编排 / 回访任务 / 人工接管 / 审计
                    └───┬─────────────┬───┘
                        ▼             ▼
                ┌───────────┐   ┌───────────┐
                │  llm/     │   │  rag/     │   LLM Provider / Embedding / Retriever 抽象
                └───────────┘   └───────────┘
                        │             │
                        ▼             ▼
                ┌─────────────────────────┐
                │ 基础设施：PostgreSQL+pgvector │
                │ Redis / (未来) Celery/Arq     │
                └─────────────────────────┘
```

## 2. 模块划分与职责

| 模块 | 路径 | 职责 | 未来拆分边界 |
|---|---|---|---|
| WeCom 适配器 | `src/app/wecom/` | 验签、AES 解密（占位）、事件/消息标准化为内部 `NormalizedEvent` | 可拆分为独立“渠道网关”服务，对外只暴露标准化事件 |
| 核心基础设施 | `src/app/core/` | 配置、日志、统一错误处理、安全工具（签名、限流占位） | 保持库化，不单独拆分 |
| LLM | `src/app/llm/` | `LLMProvider` 协议、OpenAI-compatible 实现、Fake 实现（测试用） | 可下沉为独立“模型网关”服务以做多租户限流/计费 |
| RAG | `src/app/rag/` | `EmbeddingProvider`/`Retriever` 协议、内存实现、（未来）pgvector 实现、摄取流程 | 摄取部分可拆分为独立 worker（异步任务） |
| 应用服务 | `src/app/services/` | 会话管理、AI 编排（意图判断→检索→生成→置信度→转人工）、回访任务状态机、人工接管状态机、审计记录 | 回访调度可拆分为独立 worker 服务 |
| API 路由 | `src/app/api/routes/` | 对外 HTTP 接口，薄层，只做校验/编排调用/响应封装 | - |
| Schemas | `src/app/schemas/` | Pydantic 请求/响应模型 | - |

模块化单体的原则：**同一个部署单元（一个容器）内，通过 Python 包边界和协议接口强制解耦**，任何模块之间不允许绕过公开接口直接访问内部实现细节，这样未来按边界拆分为独立服务时改动成本可控。

## 3. 数据模型（第一阶段，内存/占位，后续用 SQLAlchemy + Alembic 落库）

- `Customer`：`external_userid`、显示名（占位，可能脱敏）、创建时间
- `StaffAccount`：企业微信员工 `userid`、姓名
- `Conversation`：`customer_id` + `staff_id` 维度，状态（`ai_active` / `handoff`）、最近消息时间
- `Message`：会话内消息（方向、类型、原始摘要脱敏、msg_id 幂等键）
- `KnowledgeDocument` / `KnowledgeChunk`：文档元数据、切片文本、embedding 向量（占位存内存，未来 pgvector 列）
- `RevisitTask`：回访任务（客户、原因、状态机：`draft -> pending_review -> approved/rejected -> sent/failed`）
- `HandoffRecord`：人工接管起止时间、触发原因
- `AuditLog`：AI 交互审计（correlation_id、检索引用、置信度、是否转人工，脱敏摘要）

## 4. 关键设计决策

### 4.1 为什么模块化单体而非微服务
- 团队规模和流量都不需要微服务的独立扩展/独立发布收益；
- 单体内的强类型协议接口已经能提供后续拆分所需的边界清晰度；
- 减少运维复杂度（服务发现、跨服务事务、分布式追踪）在第一阶段的成本收益比不划算。

### 4.2 为什么 PostgreSQL + pgvector 而不是专用向量库
- 业务数据（客户、会话、任务、审计）本来就需要关系型数据库；
- pgvector 让业务数据和向量数据在同一个事务/备份体系内，简化一致性和运维；
- 数据规模增长后，可将 `KnowledgeChunk` 的向量检索迁移到 Milvus/Elasticsearch，接口层已通过 `Retriever` 协议隔离，迁移成本可控。

### 4.3 为什么不用 LangChain/LlamaIndex 全家桶
- 第一阶段 RAG 流程是标准的“检索 + 拼 prompt + 调用模型”，自研代码量很小且更可控、更易测试；
- 引入重框架会增加版本升级、依赖冲突和调试成本；
- 保留协议接口，未来如需更复杂的 Agent/工具编排，可以局部引入而不必迁移全部代码。

### 4.4 幂等与超时设计
- 所有可能重复投递的入口（企业微信回调）以 `msg_id`（或等价字段）作为幂等键，写入前先检查是否已处理（占位使用内存 set，未来用 Redis `SETNX` + TTL）；
- LLM/检索调用统一设置超时（可配置），超时按“转人工”处理而非无限重试；
- 发送类操作（回访、回复）记录发送结果和幂等键，避免重复发送。

## 5. 未来演进

1. **数据库落地**：SQLAlchemy 模型 + Alembic 迁移，替换内存实现。
2. **任务队列**：引入 Celery（或 Arq）处理知识库摄取、回访任务调度、异步发送重试。
3. **企业微信真实对接**：按官方文档实现验签/解密、access_token 管理、消息发送重试与限流。
4. **向量检索优化**：pgvector 索引调优、批量摄取、增量更新、可选 rerank。
5. **可观测性**：接入集中式日志/tracing（如 OpenTelemetry），详见 [docs/observability-evaluation.md](./observability-evaluation.md)。
6. **拆分评估**：当摄取/回访调度的负载显著增长，或需要独立扩展渠道网关时，按模块边界拆分为独立服务。
