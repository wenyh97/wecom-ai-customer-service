# Plan：技术方案与选型

状态：`Draft`
关联：[constitution.md](./constitution.md) · [spec.md](./spec.md) · [tasks.md](./tasks.md) · 详细架构见 [docs/architecture.md](../docs/architecture.md)

## 1. 技术栈选型对比

| 领域 | 选型 | 备选方案 | 选择理由 |
|---|---|---|---|
| Web 框架 | **FastAPI** | Flask, Django, NestJS, Spring Boot | 原生异步、Pydantic 集成、自动 OpenAPI 文档、类型友好、轻量 |
| 数据校验/配置 | **Pydantic v2 + pydantic-settings** | attrs, marshmallow | 与 FastAPI 深度集成，配置模型天然可校验 |
| ORM | **SQLAlchemy 2.0（异步）** | Tortoise ORM, Django ORM | 生态成熟、异步支持、与 Alembic 迁移工具链完善 |
| 数据库 | **PostgreSQL + pgvector** | MySQL、Milvus、Elasticsearch 单独部署 | 单一数据库同时承载业务数据和向量检索，降低运维复杂度；pgvector 满足中小规模检索需求，未来可平滑迁移到专用向量库 |
| 缓存/会话 | **Redis** | Memcached | 会话上下文、限流、幂等键、任务队列 broker，社区成熟 |
| 异步任务队列 | **Celery**（首选）/ 可替换为 Arq | RQ, Arq, Dramatiq | Celery 生态最成熟、可靠性高；本项目任务量不大，也在架构文档中说明 Arq（原生 asyncio、更轻）作为未来可替换选项 |
| LLM 接入 | **OpenAI-compatible SDK（`openai` 官方 SDK 指向自定义 base_url）** | LiteLLM, LangChain LLM wrapper | 直接使用官方 SDK 加自定义 `base_url`/`api_key` 即可对接绝大多数国内外 OpenAI 兼容服务（如 DeepSeek、通义千问兼容模式、vLLM/Ollama 网关），无需额外抽象层；仅在需要多供应商路由/成本控制时再引入 LiteLLM |
| RAG 编排 | **自研轻量 RAG 流程（不引入 LangChain/LlamaIndex 全家桶）** | LangChain, LlamaIndex | 项目流程简单（检索+拼接 prompt+调用模型），引入重框架收益有限且增加维护成本；预留 `Retriever`/`LLMProvider` 协议接口，未来若需要更复杂的 Agent/工具编排，可局部引入 LlamaIndex 的检索组件而不必迁移全部流程 |
| Embedding | **OpenAI-compatible embedding 接口**（可选本地 `sentence-transformers` 作为可替换实现） | 本地部署 BGE/GTE 系列 | 优先使用 OpenAI-compatible embedding API 降低运维成本；接口层抽象，未来可切换本地模型以降低成本/满足数据不出境要求 |
| Rerank | 可选，占位接口（未在第一阶段实现） | Cohere rerank, bge-reranker | 第一阶段数据量小，先不引入，接口预留 `Reranker` 协议 |
| 部署 | **Docker Compose**（app + postgres/pgvector + redis） | Kubernetes | 第一阶段规模小，Compose 足够；架构文档说明未来 K8s 演进路径 |
| 日志 | **structlog + 标准 logging** | loguru | structlog 输出结构化 JSON，便于对接日志平台；标准库兼容性好 |

## 2. 不采用的方案及原因

- **Dify / RAGFlow / Flowise**：一体化平台过重，不利于与企业微信适配层深度定制、不便于按 Spec Kit 精细拆解任务，且引入额外运维面。
- **微信个人号协议机器人（Wechaty 等）**：合规风险高，不满足企业客服场景稳定性要求。
- **Milvus/Elasticsearch 专用向量库**：第一阶段数据规模小，pgvector 足够且减少组件数量；架构文档记录未来迁移路径。
- **Kubernetes**：第一阶段团队规模和流量不需要，Compose 优先，未来可迁移。

## 3. 模块化单体（Modular Monolith）分层

```text
src/app/
├── main.py                # FastAPI 入口、路由挂载、异常处理器注册
├── core/                  # 配置、日志、错误、安全（签名/限流）基础设施
├── wecom/                 # 企业微信适配器：验签/解密/消息规范化（占位）
├── llm/                   # LLM Provider 抽象与实现（OpenAI-compatible / Fake）
├── rag/                   # Embedding/Retriever 抽象、检索与摄取流程
├── services/              # 应用服务：会话、AI 编排、回访任务、人工接管、审计
├── schemas/                # Pydantic 请求/响应模型
└── api/routes/            # 按用例划分的路由：health, wecom, chat, kb, revisit, handoff, eval
```

未来拆分边界（详见架构文档）：知识库摄取、回访任务调度、企业微信适配层可在流量/团队规模增长后拆分为独立服务，当前通过清晰的模块边界和接口协议保留拆分能力。

## 4. 关键接口协议（供未来替换实现）

- `LLMProvider`：`generate(messages, **kwargs) -> LLMResponse`
- `EmbeddingProvider`：`embed(texts: list[str]) -> list[list[float]]`
- `Retriever`：`search(query: str, top_k: int) -> list[RetrievedChunk]`
- `MessageChannel`（企业微信占位）：`verify_and_decrypt(raw) -> NormalizedEvent`，`send(message) -> SendResult`

## 5. 演进路线（后续阶段，非本次实现）

1. 真实对接企业微信客户联系 API（签名、access_token 管理、消息发送）。
2. pgvector 生产化调优（索引类型、分批摄取、增量更新）。
3. 引入 Reranker 提升检索精度。
4. 视流量拆分知识库摄取和回访调度为独立 worker 服务（保留 Celery/Arq 任务边界）。
5. 视需要引入 LiteLLM 做多模型路由与成本统计。
