# Spec：企业微信客户 AI 客服与回访助手（Phase 1 MySQL/CI-CD）

状态：`In Progress`
关联：[constitution.md](./constitution.md) · [plan.md](./plan.md) · [tasks.md](./tasks.md)

## 1. 背景

当前仓库已有 FastAPI 骨架与内存实现。下一阶段目标不是完善 RAG，而是先把**非 RAG 核心流程**落到 MySQL，并通过 GitHub Actions 持续部署到服务器。

## 2. 目标用户与角色

| 角色 | 说明 |
|---|---|
| 客户 | 企业微信员工的外部联系人 |
| 企业微信员工 | 与客户沟通的企业成员 |
| 人工客服/主管 | 接管会话、审核回访 |
| 知识库管理员 | 上传知识库文档原文/元数据 |
| 系统管理员 | 管理 MySQL、Secrets、部署 |

## 3. Phase 1 范围

### 3.1 必须完成

- MySQL 持久化：`tenants`、`staff_users`、`customers`、`customer_staff_bindings`、`conversations`、`messages`、`knowledge_documents`、`handoff_cases`、`revisit_plans`、`revisit_tasks`、`audit_logs`、`evaluation_runs`、`idempotency_records`。
- SQLAlchemy 2.x async + `asyncmy` 运行时访问；Alembic 迁移；SQLite 测试兼容。
- Repository / Unit of Work 替换内存存储。
- 非 RAG 流程：消息入站 → 会话/消息落库 → Fake/OpenAI-compatible LLM → AI 回复记录 → 幂等 → 人工接管 → 审计。
- 回访计划/任务持久化、审核、发送占位与审计。
- `/health` 检查应用与数据库依赖状态，不泄露连接串。
- Docker Compose 生产部署：`app + mysql + redis`。
- GitHub Actions：CI（ruff/pytest/alembic/compose config），CD（GHCR + SSH deploy + migrate + health check）。
- README / `docs/*.md` / `specs/*.md` 同步更新。

### 3.2 明确保留但不实现

- 真实 RAG / 向量库 / reranker / embedding 生产化；
- Dify；
- 微信个人号协议机器人；
- 企业微信真实 AES 解密、`access_token`、正式消息发送；相关位置继续保留 `TODO(confirm-with-wecom-docs)`。

## 4. 核心用例

### UC-1 客户消息自动处理（非 RAG 版优先）
1. 接收客户消息。
2. 以 `customer_external_userid + staff_userid` 建立/复用会话。
3. 先检查幂等键；重复消息直接返回已处理结果。
4. 记录客户消息；若命中敏感词或低置信度，创建/更新人工接管。
5. 否则调用 Fake 或 OpenAI-compatible LLM 生成回复，记录 AI 消息。
6. 记录审计日志。

### UC-2 知识库文档元数据入库
- 上传文档原文与元数据到 `knowledge_documents`；
- 当前仅供基础检索占位与未来 RAG 扩展，不承诺生产语义检索质量。

### UC-3 回访计划/任务
- 创建计划；
- 创建任务默认进入 `pending_review`；
- 审核通过后才允许发送占位；
- 所有动作写审计日志。

### UC-4 部署与回滚
- 通过 GitHub Actions 构建 GHCR 镜像；
- 通过 SSH 在服务器上执行 `docker compose pull`、`alembic upgrade head`、`docker compose up -d`；
- 失败时停止发布，并保留前一镜像标识供手动回滚。

## 5. 验收标准

- SQLite 测试环境 `pytest -q` 全部通过；
- MySQL service container 上可执行 `alembic upgrade head`；
- 数据在容器重启后可保留（MySQL volume）；
- 相同 `idempotency_key` 不会重复回复或重复写会话审计；
- 人工接管状态、回访任务状态可从数据库恢复；
- `docs/deployment.md` 与 README 足以指导首次部署、更新、查看日志、回滚和备份。

## 6. Open Questions / TODO(confirm-with-wecom-docs)

1. 企业微信消息回调加解密与验签的生产实现细节。
2. 自动回复窗口、主动回访权限与频率限制。
3. 真实消息发送 API、回访权限、审核合规要求。
4. 若后续引入真实 RAG，知识库向量索引与更新策略。
