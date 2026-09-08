# Tasks：任务拆解（第一阶段骨架）

状态：`In Progress`
关联：[constitution.md](./constitution.md) · [spec.md](./spec.md) · [plan.md](./plan.md)

> 状态取值：`todo` / `doing` / `done` / `blocked`。本文件在每个 PR 中同步更新。

## Epic 1：Spec Kit 与文档

- [x] T1.1 建立 `specs/constitution.md`、`spec.md`、`plan.md`、`tasks.md`
- [x] T1.2 建立 `docs/requirements.md`（需求拆解、角色、用例、验收标准）
- [x] T1.3 建立 `docs/architecture.md`（架构与选型说明）
- [x] T1.4 建立 `docs/api-contract.md`（接口草案）
- [x] T1.5 建立 `docs/rag-agent.md`（RAG/Agent 链路说明）
- [x] T1.6 建立 `docs/observability-evaluation.md`（日志/评测方案）
- [x] T1.7 建立 `docs/deployment.md`（部署说明）
- [x] T1.8 建立 `docs/acceptance.md`（验收清单/测试策略）
- [x] T1.9 建立 `docs/brainstorming.md`（待决策清单）
- [x] T1.10 更新根 `README.md` 说明 Spec Kit 使用方式，并保留历史内容

## Epic 2：应用骨架

- [x] T2.1 `pyproject.toml` 项目与依赖定义
- [x] T2.2 配置模型 `core/config.py`（Pydantic Settings，读取 `.env`）
- [x] T2.3 结构化日志 `core/logging.py`
- [x] T2.4 统一错误响应与异常处理器 `core/errors.py`
- [x] T2.5 FastAPI 入口 `main.py` + `/health`
- [x] T2.6 LLM Provider 抽象 + Fake/OpenAI-compatible 实现 `llm/`
- [x] T2.7 Embedding/Retriever 抽象 + 内存实现 `rag/`
- [x] T2.8 企业微信适配器占位：签名校验、消息规范化 `wecom/`
- [x] T2.9 会话/客户映射、回访任务、人工接管的数据模型（内存态，DB 化留待下阶段）`services/`
- [x] T2.10 API 路由：health / wecom callback / chat / kb / revisit / handoff / eval
- [x] T2.11 单元测试覆盖以上模块
- [x] T2.12 `Dockerfile`、`docker-compose.yml`、`.env.example`
- [x] T2.13 `.gitignore` 补充 Python/Docker 相关忽略项

## Epic 3：验证

- [x] T3.1 `pytest` 全部通过
- [x] T3.2 手动验证 `/health` 与关键路由可运行（本地 TestClient）
- [ ] T3.3 （下阶段）接入真实 PostgreSQL/pgvector 与 Redis 的集成测试
- [ ] T3.4 （下阶段）企业微信官方回调联调（需测试企业资质）

## 下阶段任务预告（不在本次 PR 范围）

- 真实数据库迁移（Alembic）与 SQLAlchemy 模型落地
- Celery/Arq 任务队列真实接入
- 企业微信官方 API 真实联调（access_token、签名、发送）
- pgvector 真实向量检索与 rerank
- 评测脚本与离线数据集样例
