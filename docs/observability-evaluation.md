# 可观测性与评测方案

## 1. 结构化日志字段

所有请求级日志（通过 `structlog`）至少包含：

| 字段 | 说明 |
|---|---|
| `timestamp` | ISO8601 时间戳 |
| `level` | 日志级别 |
| `correlation_id` | 跨请求/跨服务关联 ID（来自请求头或自动生成） |
| `conversation_id` | 会话 ID（如适用） |
| `event` | 事件名（如 `wecom.callback.received`、`ai.reply.generated`、`kb.search`） |
| `duration_ms` | 关键操作耗时 |
| `outcome` | `success` / `error` / `timeout` / `handoff` |

**隐私原则**：日志中不记录客户消息原文全文，默认只记录长度、hash 或脱敏摘要（如替换手机号/身份证号/邮箱为占位符）；如需记录原文用于人工排查，需要显式配置开关并有独立的访问审计（本阶段不实现该开关，默认最保守）。

## 2. 模型调用记录

- 记录：模型名称、耗时、输入/输出 token 数（若供应商返回）、是否超时、是否重试。
- **不记录**：完整 prompt 原文默认不落盘到常规日志（可能包含客户隐私）；如需调试，仅在开发环境（`ENV=development`）下可选启用完整记录，生产环境默认关闭。

## 3. RAG 召回指标

- `retrieval_hit@k`：Top-K 检索结果中是否包含标注的正确文档（离线评测数据集使用）。
- `retrieval_score_distribution`：检索分数分布，用于校准置信度阈值。

## 4. 业务指标

| 指标 | 定义 |
|---|---|
| 回答正确率 | 离线评测集中人工标注“正确”的回答占比 |
| 引用率 | 生成回答中包含有效 `source_id` 引用的比例 |
| 拒答率 | 系统明确表示“无法回答”的比例（不同于转人工） |
| 转人工率 | `handoff_required=true` 的会话占比 |

## 5. 离线评测数据集格式

`tests/fixtures/eval_dataset.jsonl`，每行一个样本：

```json
{"id": "case-001", "query": "退款多久到账？", "expected_doc_ids": ["doc-refund-policy"], "expected_handoff": false}
```

字段说明：
- `id`：样本唯一标识；
- `query`：客户问题；
- `expected_doc_ids`：期望命中的知识库文档 ID 列表（用于计算 `retrieval_hit@k`）；
- `expected_handoff`：期望是否应转人工（用于校验安全判断规则）。

## 6. 最小评测脚本接口

`src/app/services/evaluation.py` 提供：

```python
def evaluate_retrieval(dataset: list[EvalCase], retriever: Retriever, top_k: int = 5) -> EvalReport:
    """对给定数据集运行检索并计算 hit@k 等指标，返回 EvalReport。"""
```

第一阶段仅实现检索命中率的最小评测，回答正确性等需要人工标注或模型评审的指标留待下阶段接入真实数据集后完善（见 `docs/brainstorming.md`）。

## 7. Trace / Correlation

- 每个外部请求（企业微信回调、API 调用）分配/透传 `correlation_id`；
- 所有下游调用（检索、LLM、发送）日志携带同一 `correlation_id`，便于排查一次交互的完整链路；
- 第一阶段不引入完整的 OpenTelemetry tracing，作为未来演进项。

## 8. 隐私与合规提醒

- 默认不记录未获授权的客户隐私字段（身份证号、银行卡号、住址等）；
- 若业务需要留存会话内容用于合规存档，需要在企业微信侧确认已开通“会话内容存档”能力并获得必要授权后，再显式开启相关存储和访问审计，本阶段不默认开启。
