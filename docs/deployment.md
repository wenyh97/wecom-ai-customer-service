# 部署文档

## 1. 组件

Docker Compose（`docker-compose.yml`）定义以下服务：

| 服务 | 说明 |
|---|---|
| `app` | FastAPI 应用（本仓库代码） |
| `postgres` | PostgreSQL + pgvector 扩展（使用 `pgvector/pgvector` 镜像） |
| `redis` | 会话上下文/幂等键/限流缓存 |

模型与 embedding 均通过 OpenAI-compatible 环境变量配置（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`），不在 Compose 中内置模型服务，方便替换为任意 OpenAI 兼容供应商（含自托管 vLLM/Ollama 网关）。

## 2. 快速开始（本地开发）

```bash
cp .env.example .env
# 按需修改 .env

docker compose up -d postgres redis
pip install -e ".[dev]"
uvicorn app.main:app --reload --app-dir src
```

或完整用 Compose 启动全部服务：

```bash
docker compose up --build
```

## 3. 环境变量

见 `.env.example`。关键分组：

- `APP_*`：应用基础配置（环境、日志级别）
- `DATABASE_URL`：PostgreSQL 连接串
- `REDIS_URL`：Redis 连接串
- `LLM_*`：OpenAI-compatible 模型配置
- `EMBEDDING_*`：OpenAI-compatible embedding 配置
- `WECOM_*`：企业微信凭证占位（`CORP_ID`、`SECRET`、`TOKEN`、`AES_KEY`），**真实生产凭证不得提交到仓库**

## 4. 数据库迁移/初始化说明

第一阶段骨架未接入真实 ORM 落库（内存实现为主），因此暂无 Alembic 迁移脚本。下阶段计划：

1. 引入 SQLAlchemy 模型 + Alembic；
2. `alembic upgrade head` 作为启动前置步骤；
3. Postgres 容器需预先执行 `CREATE EXTENSION IF NOT EXISTS vector;`（可在初始化 SQL 或迁移脚本中完成）。

## 5. 开发 / 测试 / 生产差异

| 环境 | 说明 |
|---|---|
| 开发 (`development`) | 可使用 Fake LLM/内存检索，`.env` 允许更详细日志（不含隐私原文） |
| 测试 (`test`) | pytest 默认使用 Fake 实现，不依赖外部网络/数据库 |
| 生产 (`production`) | 必须配置真实 `LLM_*`/`EMBEDDING_*`/`DATABASE_URL`/`REDIS_URL`；日志脱敏强制开启；企业微信凭证通过安全的 secret 管理注入（不写入镜像） |

## 6. 安全建议

- `.env` 不得提交仓库，仓库中只保留 `.env.example`；
- 生产环境使用 secret manager（如云厂商 KMS/Secrets Manager）或部署平台的 secret 注入机制，而非明文环境变量文件；
- 企业微信回调地址仅接受 HTTPS；
- 数据库、Redis 不对公网开放端口，仅供 `app` 容器内网访问；
- 定期轮换 `WECOM_SECRET`/`LLM_API_KEY` 等凭证；
- 结构化日志默认脱敏，见 [docs/observability-evaluation.md](./observability-evaluation.md)。

## 7. 未来演进

- 生产环境引入反向代理（Caddy/Nginx）终止 TLS；
- 引入 CI 自动构建镜像、运行 `pytest`；
- 数据库高可用与备份策略；
- 视流量拆分独立 worker 容器（摄取、回访调度）。
