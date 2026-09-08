# 项目宪法（Constitution）

> Spec Kit 文档层级：`constitution.md` → `spec.md` → `plan.md` → `tasks.md`。

## 1. 项目使命

为企业微信客户联系场景提供：

1. **Phase 1 优先**：可部署、可迁移、可审计的**非 RAG 核心流程**（消息接入、AI 回复、转人工、回访、幂等、审计、CI/CD）。
2. **Phase 2 再做**：真实 RAG / 向量检索 / rerank / 知识库语义增强。

## 2. 硬性原则（Non-negotiable）

1. **不接入微信个人号协议机器人**；所有微信侧能力均以企业微信官方能力抽象为准；未验证能力必须标注 `TODO(confirm-with-wecom-docs)`。
2. **不使用 Dify** 或其他重量级一体化平台；当前阶段坚持**模块化单体**。
3. **Phase 1 不实现真实 RAG**：`HashEmbeddingProvider` / 内存检索仅用于测试与占位，不视为生产 RAG 能力。
4. **低置信度/敏感问题必须转人工**，禁止无依据编造回答。
5. **主动回访默认受控**：需审核、可追踪、可关闭；未确认的企业微信主动触达限制不得臆造。
6. **隐私与数据最小化**：持久化只保留必要业务字段，日志默认脱敏，健康检查/错误响应不得泄露凭证。
7. **可私有化部署**：应用必须可通过 Docker Compose + MySQL 在单台服务器部署，并由 GitHub Actions CI/CD 驱动更新。
8. **迁移优先于启动**：应用启动不应无条件建表或破坏性变更；数据库迁移必须显式执行并可重复运行。

## 3. 架构原则

- 分层清晰：适配器层（企业微信）→ API → 应用服务 → Repository / Unit of Work → MySQL / Redis / LLM。
- SQLAlchemy 2.x async + Alembic 为当前业务数据权威实现；SQLite 仅用于测试。
- 幂等优先：重复回调/重复请求不得重复回复或重复写审计。
- 所有网络调用必须有超时；失败优先降级到转人工而非无限重试。

## 4. 完成定义（Definition of Done）

- `pytest` 在无外部服务下可通过（SQLite）；
- CI 额外验证 `alembic upgrade head` + MySQL service container；
- 文档、Compose、GitHub Actions、README 同步更新；
- 所有企业微信真实能力不确定点均保留 `TODO(confirm-with-wecom-docs)`；
- 无真实密钥、密码、主机名提交到仓库。
