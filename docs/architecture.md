# 架构文档（Architecture）

## 1. 当前阶段目标

当前阶段优先验证**可部署的非 RAG 主流程**：消息入站、会话持久化、AI 回复、低置信度转人工、回访任务、审计、CI/CD。RAG 真实能力延后到下一阶段。

## 2. 总体架构

```text
企业微信回调/发送占位
        │
        ▼
wecom adapter (TODO(confirm-with-wecom-docs))
        │
        ▼
FastAPI routes
        │
        ▼
services (chat / kb / handoff / revisit / audit)
        │
        ▼
Repository + Unit of Work (AsyncSession per request)
        │
        ├── MySQL 8.0（权威业务数据）
        ├── Redis（Phase 1 仅预留）
        └── Fake / OpenAI-compatible LLM
```

## 3. 数据持久化

### 3.1 ORM 与迁移
- 运行时：SQLAlchemy 2.x async + `asyncmy`
- 迁移：Alembic + `PyMySQL`
- 测试：`sqlite+aiosqlite`

### 3.2 核心表
- `tenants`
- `staff_users`
- `customers`
- `customer_staff_bindings`
- `conversations`
- `messages`
- `knowledge_documents`
- `handoff_cases`
- `revisit_plans`
- `revisit_tasks`
- `audit_logs`
- `evaluation_runs`
- `idempotency_records`

### 3.3 数据最小化
- 客户仅持久化 `external_userid`、必要显示名/状态等最小字段；
- `audit_logs.input_summary` 始终是脱敏摘要；
- `/health` 仅返回依赖状态，不返回连接串。

## 4. 请求生命周期

### 4.1 聊天消息
1. 路由创建请求级 UoW；
2. 查询/写入幂等记录；
3. 创建/复用租户、员工、客户、绑定、会话；
4. 客户消息落库；
5. 若人工接管中，则直接返回 `handoff_required=true`；
6. 否则调用 AI 编排器；
7. AI 回复或转人工结果写入消息/接管/审计；
8. 提交事务。

### 4.2 知识库
- 文档原文与元数据落库到 `knowledge_documents`；
- 仍使用内存 retriever 作为占位；应用启动时从 DB warmup 重建索引；
- `HashEmbeddingProvider` 明确仅用于测试/占位，不代表生产 RAG。

### 4.3 回访
- `revisit_plans` 保存计划模板；
- `revisit_tasks` 保存具体任务实例；
- 状态机：`draft -> pending_review -> approved/rejected -> sent/failed`；
- 所有计划/任务操作写入 `audit_logs`。

## 5. 部署架构

- 单台服务器：Docker Engine + Compose v2；
- `docker-compose.yml` 包含 `app`、`mysql`、`redis`、`migrate`；
- CD 通过 GHCR 拉取镜像并 SSH 到服务器执行迁移和启动。

## 6. 边界与已知限制

- 不实现真实企业微信 AES 解密、消息发送、access_token；
- 不实现真实 RAG / 向量库；
- Redis 当前未被业务代码使用，仅为下一阶段预留。
