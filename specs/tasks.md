# Tasks：任务拆解（Phase 1 MySQL / CI-CD）

状态：`In Progress`

## Epic 1：持久化改造

- [x] T1.1 新增 `src/app/db/`：Base / models / session / repository(UoW)
- [x] T1.2 引入 SQLAlchemy 2.x async、asyncmy、Alembic、PyMySQL、aiosqlite
- [x] T1.3 编写初始迁移，覆盖 12 张核心表
- [x] T1.4 应用启动改为“迁移先行、启动后 warmup”，不自动建表

## Epic 2：业务流程落库

- [x] T2.1 会话、消息、幂等改为数据库实现
- [x] T2.2 人工接管改为数据库实现
- [x] T2.3 回访计划/任务与状态机改为数据库实现
- [x] T2.4 审计日志改为数据库实现
- [x] T2.5 健康检查增加数据库依赖状态
- [x] T2.6 保留 Fake LLM / HashEmbeddingProvider 作为占位能力

## Epic 3：测试与验证

- [x] T3.1 更新 `tests/conftest.py`，使用 SQLite async 测试库
- [x] T3.2 新增模型/仓储/幂等/迁移/MySQL 集成/smoke 测试
- [ ] T3.3 在 CI 上持续验证 MySQL service container、Alembic 和 compose config

## Epic 4：部署与交付

- [x] T4.1 更新 `Dockerfile`、`docker-compose.yml`、`.env.example`
- [x] T4.2 新增 `.github/workflows/ci.yml`
- [x] T4.3 新增 `.github/workflows/cd.yml`
- [x] T4.4 更新 README 与 `docs/architecture.md`、`deployment.md`、`acceptance.md`、`brainstorming.md`

## 仍然延后（非本次实现）

- [ ] P2.1 真实 RAG / 向量检索 / rerank
- [ ] P2.2 企业微信真实 AES 解密、access_token、发送 API
- [ ] P2.3 Redis 在幂等/限流/队列中的真实使用
- [ ] P2.4 Dify / 个人微信协议机器人（明确不做）
