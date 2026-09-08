# Plan：技术方案与选型

状态：`In Progress`

## 1. 本阶段主方案

| 领域 | 选型 | 说明 |
|---|---|---|
| Web | FastAPI | 保持现有骨架 |
| ORM | SQLAlchemy 2.x async | 统一运行时 DB 访问 |
| 迁移 | Alembic | 显式迁移，先迁移后启动 |
| MySQL 驱动 | asyncmy | 运行时异步驱动 |
| Alembic MySQL 驱动 | PyMySQL | 迁移阶段使用同步驱动更稳定 |
| 测试 DB | SQLite + aiosqlite | 无外部服务即可跑测试 |
| 缓存 | Redis（预留） | Phase 1 compose 中保留，应用暂未使用 |
| 部署 | Docker Compose + GHCR + GitHub Actions | 单机服务器优先 |

## 2. 模块设计

```text
src/app/
├── api/routes/            # HTTP 接口
├── core/                  # settings / container / logging / errors
├── db/                    # SQLAlchemy Base / models / session / repository(UoW)
├── services/              # 会话、知识库、接管、回访、幂等、审计
├── llm/                   # Fake/OpenAI-compatible LLM
├── rag/                   # 占位 embedding/retriever（非生产 RAG）
└── wecom/                 # 官方能力占位适配器
```

## 3. Repository / Unit of Work

- 每个请求通过 `get_uow()` 创建独立 `AsyncSession`；
- `Container` 只保留单例资源（engine、sessionmaker、provider、retriever、services）；
- 聊天、回访、知识库等写操作在同一个 UoW 内显式 `commit()`；
- 应用启动只做 warmup（重建内存检索占位），不做建表。

## 4. 数据库设计摘要

- `tenants.slug` 唯一；
- `staff_users (tenant_id, wecom_userid)` 唯一；
- `customers (tenant_id, external_userid)` 唯一；
- `customer_staff_bindings (customer_id, staff_user_id)` 唯一；
- `conversations (customer_id, staff_user_id)` 唯一；
- `messages` 建 `(conversation_id, created_at)` 索引；
- `idempotency_records.idempotency_key` 唯一；
- `knowledge_documents` 仅保存元数据/原文/状态，不保存向量列。

## 5. 运行与部署流程

1. 构建镜像并推送 GHCR；
2. 服务器更新 `docker-compose.yml` / `.env`；
3. 执行 `docker compose --profile ops run --rm migrate`；
4. 执行 `docker compose up -d app mysql redis`；
5. 调用 `/health` 校验；
6. 若失败，保留旧镜像标识并按文档手动回滚。

## 6. 延后到 Phase 2

- 真实 RAG、向量索引、rerank；
- Redis 幂等/限流/队列真实接入；
- 企业微信真实联调；
- 离线评测扩展为回答质量评测。
