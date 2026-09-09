# 企业微信客户 AI 客服与回访助手

企业微信员工添加客户后，为客户咨询提供 AI 自动回复，并支持人工接管、受控回访、审计与部署自动化。

> 历史 Hermes 内容已保留在 [`docs/legacy/`](docs/legacy/)；当前项目以本 README 和 `specs/` 为准。

## 当前阶段重点

- **Phase 1 优先**：MySQL 持久化 + 非 RAG 核心流程 + GitHub Actions CI/CD + 单机服务器部署。
- **明确延后**：真实 RAG / 向量检索 / Dify / 个人微信协议机器人 / 企业微信真实发送联调。

## 核心能力（当前已实现）

- FastAPI 模块化单体
- SQLAlchemy 2.x async + Alembic + MySQL/SQLite
- 会话、消息、幂等、人工接管、回访计划/任务、审计日志持久化
- Fake LLM / OpenAI-compatible LLM
- Docker Compose（app + mysql + redis + migrate）
- GitHub Actions CI / CD 工作流

## 快速开始（本地 SQLite）

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --reload --app-dir src
```

如需无外部依赖测试，可将 `DATABASE_URL` 设为 `sqlite+aiosqlite:///:memory:`。

## 数据库迁移

```bash
alembic upgrade head
```

> 应用启动不会自动建表；部署时必须先执行迁移。

## 运行测试

```bash
pip install -e ".[dev]"
ruff check .
pytest -q
python scripts/smoke_test.py
```

## 生产部署（Docker Compose + MySQL）

```bash
cp .env.example .env
# 填写真实密码/密钥
docker compose pull app migrate
docker compose --profile ops run --rm migrate
docker compose up -d app mysql redis
curl -f http://127.0.0.1:8000/health
```

## GitHub Actions 配置

### Secrets

| 名称 | 说明 |
|---|---|
| `SERVER_HOST` / `SERVER_USER` | 部署服务器地址与 SSH 用户（如 `TonyAdmin`） |
| `SERVER_PASSWORD` | SSH 登录密码（配合 `sshpass` 使用） |
| `DEPLOY_PATH` | 服务器部署目录（统一为 `/opt/wecom-ai-customer-service`） |
| `LLM_API_KEY` / `EMBEDDING_API_KEY` | 模型密钥 |
| `WECOM_CORP_ID` / `WECOM_SECRET` / `WECOM_TOKEN` / `WECOM_AES_KEY` | 企业微信占位凭证 |

> 生产环境的 `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`MYSQL_DATABASE`、`DATABASE_URL` 统一由服务器 `/opt/wecom-ai-customer-service/.env` 管理；GitHub Actions CD 只会校验这些条目存在，并把 `APP_IMAGE` 更新为本次构建镜像，不会再覆盖整份 `.env`。
>
> CD 使用 SSH 密码登录（`sshpass -e`，密码仅通过 `SSHPASS` 环境变量传递）。**当前阶段临时关闭了 host key 校验**（`StrictHostKeyChecking=no` + `UserKnownHostsFile=/dev/null`），不再需要配置 `SERVER_KNOWN_HOSTS` 或 `SERVER_SSH_KEY`，因此存在中间人攻击风险。这是首次部署的临时降级方案；部署稳定后应恢复 `StrictHostKeyChecking=yes`，并迁移到 SSH key + `known_hosts` 校验。

### Variables

`SERVER_SSH_PORT`（默认 `22`）。

应用配置（如 `APP_PORT`、`LOG_LEVEL`、`TZ`、`MYSQL_DATABASE`、`MYSQL_USER`、`DATABASE_URL`、`LLM_*`、`EMBEDDING_*`、`DEFAULT_TENANT_*`）请直接维护在服务器 `/opt/wecom-ai-customer-service/.env`。

## 观察运行状态

```bash
curl http://127.0.0.1:8000/health
docker compose logs -f app
docker compose logs -f mysql
```

## 手动回滚与备份

详见 [`docs/deployment.md`](docs/deployment.md)：包含 `.previous_app_image` 回滚方法、`mysqldump` 备份/恢复命令。

## TODO(confirm-with-wecom-docs)

- 企业微信真实 AES 解密与签名细节
- 真实消息发送 API / access_token
- 主动回访触达权限与频率限制
