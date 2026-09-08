# 验收文档与测试策略

## 1. 测试分层

| 层级 | 工具 | 范围 |
|---|---|---|
| 单元/集成 | `pytest` + FastAPI `TestClient` | SQLite 下无外部依赖验证主要流程 |
| 迁移测试 | Alembic + SQLite 文件 | 校验迁移脚本可加载并升级到 head |
| MySQL 集成 | `pytest` + GitHub Actions MySQL service | 验证 MySQL 连接与迁移环境 |
| Lint | `ruff check .` | 基础静态校验 |
| Compose 校验 | `docker compose config` | 验证生产/CI compose 配置 |
| Smoke | `tests/test_smoke.py` + `scripts/smoke_test.py` | `migrate -> health -> message -> idempotency -> handoff -> revisit` |

## 2. 完成标准

- [ ] `GET /health` 返回应用与数据库状态
- [ ] Alembic `upgrade head` 可重复执行
- [ ] 知识库文档可入库并重新 warmup
- [ ] `/chat/messages` 将客户消息、AI 回复、审计记录落库
- [ ] 重复 `idempotency_key` 不重复处理
- [ ] 人工接管状态可持久化并影响后续消息行为
- [ ] 回访计划/任务状态可持久化并恢复
- [ ] MySQL 数据在容器重启后仍存在
- [ ] `docker compose -f docker-compose.yml config` 通过
- [ ] CI / CD 文档足以完成首次部署与手动回滚
- [ ] 所有真实企业微信能力不确定点保留 `TODO(confirm-with-wecom-docs)`

## 3. 已知限制（当前阶段非缺陷）

- `HashEmbeddingProvider` + 内存 retriever 仅为占位；不是生产 RAG；
- Redis 在 compose 中预留，但业务代码暂未使用；
- 企业微信回调 AES 解密、access_token、主动发送仍未真实联调；
- 回滚仅覆盖镜像级别，复杂 schema downgrade 需单独设计。
