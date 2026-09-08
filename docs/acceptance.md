# 验收文档与测试策略

## 1. 测试分层

| 层级 | 工具 | 范围 |
|---|---|---|
| 单元测试 | `pytest` | 各模块内部逻辑（LLM provider、retriever、幂等、错误处理、wecom 签名/加解密占位） |
| 集成测试 | `pytest` + FastAPI `TestClient` | API 路由端到端（进程内，不依赖真实外部服务） |
| 契约测试 | `pytest` 对照 `docs/api-contract.md` 的请求/响应结构 | 保证实现与文档一致；后续可用 schemathesis 等工具加强 |
| RAG 离线评测 | `evaluate_retrieval`（见 observability 文档） + `tests/fixtures/eval_dataset.jsonl` | 检索命中率等指标 |
| 端到端 smoke test | `TestClient` 串联：上传知识库 → 提问 → 校验引用与回答 | 验证骨架完整链路可运行 |

## 2. 本地运行

```bash
pip install -e ".[dev]"
pytest
```

## 3. MVP 验收清单（第一阶段骨架）

- [ ] `GET /health` 返回 200 且包含版本号
- [ ] 上传知识库文档后可通过 `/kb/search` 检索到相关片段
- [ ] `/chat/messages` 对命中知识库的问题返回带引用的回答
- [ ] `/chat/messages` 对命中黑名单关键词的问题标记 `handoff_required=true`
- [ ] 相同 `idempotency_key` 的重复请求不会重复调用 LLM（幂等）
- [ ] `/revisit/tasks` 完整状态机（创建→审核→发送）可通过 API 驱动，未审核任务不会被发送
- [ ] `/handoff/*` 接管/交还状态可查询且影响 `/chat/messages` 行为
- [ ] `/eval/audit-logs` 返回的记录不包含客户隐私原文
- [ ] `docker-compose.yml` 可以启动 app/postgres/redis 三个服务（`docker compose config` 校验通过）
- [ ] `pytest` 全部通过
- [ ] 所有企业微信官方能力相关内容均标注 `TODO(confirm-with-wecom-docs)` 或引用官方文档，未臆造已确认能力

## 4. 完成定义（Definition of Done）

一个任务/PR 被视为完成，当且仅当：

1. 相关 `specs/tasks.md` 条目状态更新；
2. 新增/修改代码有对应单元测试且本地 `pytest` 通过；
3. 涉及外部官方能力的假设有明确标注；
4. 无敏感配置写入仓库（`.env` 等被 `.gitignore` 排除）；
5. 相关文档（`docs/*.md`、`README.md`）同步更新。

## 5. 已知限制（第一阶段骨架，非缺陷）

- 数据均为内存实现，重启进程后不持久化（DB 落地留待下阶段）；
- 企业微信验签/解密为可测试的占位实现，非官方联调验证版本；
- 回访任务的“自动发送”为占位函数，不会真实调用企业微信 API；
- 检索为内存暴力相似度计算，未使用 pgvector；
- 评测脚本仅覆盖检索命中率，回答正确性等指标需要人工标注数据集后续完善。
