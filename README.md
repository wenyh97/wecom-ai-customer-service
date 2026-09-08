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
| `SERVER_HOST` / `SERVER_USER` / `SERVER_SSH_KEY` / `SERVER_KNOWN_HOSTS` | SSH 部署 |
| `DEPLOY_PATH` | 服务器部署目录 |
| `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | MySQL 密码 |
| `LLM_API_KEY` / `EMBEDDING_API_KEY` | 模型密钥 |
| `WECOM_CORP_ID` / `WECOM_SECRET` / `WECOM_TOKEN` / `WECOM_AES_KEY` | 企业微信占位凭证 |

### Variables

`APP_PORT`、`LOG_LEVEL`、`TZ`、`MYSQL_DATABASE`、`MYSQL_USER`、`LLM_BASE_URL`、`LLM_MODEL`、`DEFAULT_TENANT_SLUG`、`DEFAULT_TENANT_NAME` 等。

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
