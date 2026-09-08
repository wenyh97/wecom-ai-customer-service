# 部署文档

## 1. 前提

服务器需具备：

- Docker Engine
- Docker Compose v2（`docker compose`）
- 可执行 `docker compose`、`curl` 的 SSH 用户
- 已配置 `ghcr.io` 拉取权限（如私有镜像则需 `docker login ghcr.io`）

## 2. 生产 Compose 组件

| 服务 | 说明 |
|---|---|
| `app` | FastAPI 应用 |
| `migrate` | 一次性 Alembic 迁移任务 |
| `mysql` | MySQL 8.0，持久化 volume、utf8mb4、健康检查 |
| `redis` | Phase 1 预留，当前应用未消费 |

## 3. 首次部署

1. 复制 `.env.example` 为服务器上的 `.env`，填入真实值；
2. 至少配置：`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`LLM_API_KEY`（如需要真实模型）、`WECOM_*`；
3. 执行：

```bash
docker compose pull app migrate
docker compose --profile ops run --rm migrate
docker compose up -d app mysql redis
curl -f http://127.0.0.1:8000/health
```

> 应用不会在启动时自动建表；必须先执行 `alembic upgrade head`（通过 `migrate` 服务完成）。

## 4. GitHub Actions 配置

### 4.1 必要 Secrets

| 名称 | 用途 |
|---|---|
| `SERVER_HOST` | 部署服务器地址 |
| `SERVER_USER` | SSH 用户 |
| `SERVER_SSH_KEY` | SSH 私钥 |
| `SERVER_KNOWN_HOSTS` | 服务器 host key，启用严格校验 |
| `DEPLOY_PATH` | 服务器部署目录 |
| `MYSQL_PASSWORD` | MySQL 应用账号密码 |
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 |
| `LLM_API_KEY` | 真实模型密钥（可留空则使用 Fake） |
| `EMBEDDING_API_KEY` | 真实 embedding 密钥（可留空） |
| `WECOM_CORP_ID` / `WECOM_SECRET` / `WECOM_TOKEN` / `WECOM_AES_KEY` | 企业微信占位凭证 |

### 4.2 推荐 Variables

`APP_PORT`、`LOG_LEVEL`、`TZ`、`MYSQL_DATABASE`、`MYSQL_USER`、`LLM_BASE_URL`、`LLM_MODEL`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL`、`DEFAULT_TENANT_*`。

## 5. 更新发布

CD 工作流执行顺序：

1. 构建镜像并推送 GHCR；
2. 通过 SSH 严格 host key 校验连到服务器；
3. 上传最新 `docker-compose.yml`；
4. 生成/更新服务器 `.env`；
5. `docker compose pull app migrate`；
6. `docker compose --profile ops run --rm migrate`；
7. `docker compose up -d app mysql redis`；
8. `curl /health` 校验。

若迁移失败，发布应停止，不应继续重启应用容器。

## 6. 日志与健康检查

```bash
docker compose logs -f app
docker compose logs -f mysql
curl -f http://127.0.0.1:8000/health
```

## 7. 备份与恢复

### 7.1 备份
```bash
docker compose exec mysql sh -c 'mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' > backup.sql
```

### 7.2 恢复
```bash
cat backup.sql | docker compose exec -T mysql sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

## 8. 手动回滚

CD 会在部署目录保存上一镜像标识（如 `.previous_app_image`）。手动回滚步骤：

```bash
export APP_IMAGE=$(cat .previous_app_image)
docker compose pull app
docker compose up -d app
curl -f http://127.0.0.1:8000/health
```

> 若迁移已前滚且不可逆，需先评估数据兼容性；本阶段仅提供回滚说明，不自动执行 schema downgrade。

## 9. TODO(confirm-with-wecom-docs)

- 企业微信真实消息发送、AES 解密、会话窗口与主动回访限制仍需官方文档/测试企业确认。
