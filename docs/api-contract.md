# API Contract（接口草案）

> 本文档描述第一阶段的接口草案。涉及企业微信官方能力的部分均标注 `TODO(confirm-with-wecom-docs)`，表示尚未经真实官方联调确认，不代表已验证的生产行为。第一阶段实现以此文档为准，FastAPI 自动生成的 OpenAPI（`/docs`、`/openapi.json`）作为可执行的接口文档来源。

## 通用约定

- 统一错误响应格式：

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "correlation_id": "string"
  }
}
```

- 所有请求/响应携带或生成 `correlation_id`（若请求头 `X-Correlation-Id` 存在则透传，否则服务端生成），用于跨日志关联。
- 涉及外部副作用的接口（发送消息类）需要幂等键，通过 `Idempotency-Key` 请求头或 body 内字段传递。
- 超时：外部调用（LLM/检索）默认超时 15s（可配置），超时返回 `504`（本地封装为统一错误结构）并触发转人工流程（若适用）。

## 1. 健康检查

`GET /health`

```json
{ "status": "ok", "version": "0.1.0" }
```

## 2. 企业微信回调（占位，验签/解密/事件入口的抽象）

`GET /wecom/callback`（URL 验证，企业微信配置回调地址时的握手请求）

- Query：`msg_signature`, `timestamp`, `nonce`, `echostr`
- 行为：校验签名后原样返回解密后的 `echostr`（**加解密算法细节 `TODO(confirm-with-wecom-docs)`**）

`POST /wecom/callback`（真实事件回调）

- Query：`msg_signature`, `timestamp`, `nonce`
- Body：企业微信加密 XML/JSON（占位，格式 `TODO(confirm-with-wecom-docs)`）
- 行为：
  1. 验签（`WeComSignatureVerifier`，本阶段实现签名算法本身的可测试版本，密钥来自配置）；
  2. 解密（占位接口 `WeComCrypto.decrypt`，第一阶段可返回未加密的透传实现，供本地测试）；
  3. 规范化为内部 `NormalizedEvent`（发送者、消息类型、内容、`msg_id`、时间戳）；
  4. 按 `msg_id` 幂等去重后转发给会话服务。
- 响应：企业微信要求快速响应（占位返回 `success` 文本或空 200，**具体格式 `TODO(confirm-with-wecom-docs)`**）。

## 3. 客户会话消息入口 / AI 回复

`POST /chat/messages`

请求体：

```json
{
  "conversation_id": "string (可选，若为空则按 customer_id+staff_id 查找或创建)",
  "customer_external_userid": "string",
  "staff_userid": "string",
  "content": "string",
  "message_type": "text",
  "idempotency_key": "string (通常为企业微信 msg_id)"
}
```

响应体：

```json
{
  "conversation_id": "string",
  "reply": "string | null",
  "handoff_required": true,
  "confidence": 0.0,
  "citations": [
    { "source_id": "string", "title": "string", "score": 0.0 }
  ],
  "correlation_id": "string"
}
```

- `handoff_required=true` 时 `reply` 可能为 `null` 或为固定的“转人工”提示语（由配置决定）。
- 重复 `idempotency_key` 的请求返回此前已生成的结果，不重复调用 LLM。

## 4. 知识库文档上传 / 摄取 / 检索

`POST /kb/documents`（上传，第一阶段仅支持纯文本/Markdown 内容体，不做文件二进制解析）

```json
{ "title": "string", "content": "string", "metadata": {"tag": "string"} }
```

响应：`{ "document_id": "string", "chunk_count": 3 }`

`GET /kb/documents/{document_id}` — 查询文档元数据与切片数量

`POST /kb/search`

```json
{ "query": "string", "top_k": 5 }
```

响应：

```json
{
  "results": [
    { "source_id": "string", "document_id": "string", "title": "string", "text": "string", "score": 0.0 }
  ]
}
```

## 5. 回访计划与任务

`POST /revisit/tasks` — 创建回访任务（草稿）

```json
{ "customer_external_userid": "string", "reason": "string", "planned_content": "string" }
```

`GET /revisit/tasks?status=pending_review` — 按状态查询

`POST /revisit/tasks/{task_id}/review`

```json
{ "decision": "approve", "reviewer": "string", "comment": "string" }
```

- `decision` ∈ `approve | reject`

`POST /revisit/tasks/{task_id}/send`（仅 `approved` 状态可调用，占位实现，真实发送 `TODO(confirm-with-wecom-docs)`）

状态机：`draft -> pending_review -> approved|rejected -> sent|failed`

## 6. 人工接管

`POST /handoff/{conversation_id}/takeover` — 人工接管会话（AI 停止自动回复）

```json
{ "operator": "string", "reason": "string" }
```

`POST /handoff/{conversation_id}/release` — 交还给 AI

`GET /handoff/{conversation_id}` — 查询当前接管状态

## 7. 评测/日志查询

`GET /eval/audit-logs?conversation_id=&since=&until=&limit=`

响应（示例，字段均为脱敏后的摘要，不返回客户隐私原文）：

```json
{
  "items": [
    {
      "correlation_id": "string",
      "conversation_id": "string",
      "timestamp": "2026-01-01T00:00:00Z",
      "handoff_required": false,
      "confidence": 0.82,
      "citations": ["doc-1#chunk-0"],
      "input_summary": "string (已脱敏)"
    }
  ]
}
```

`GET /eval/metrics?since=&until=` — 返回聚合指标（召回命中率占位、转人工率、拒答率等），字段定义见 [docs/observability-evaluation.md](./observability-evaluation.md)。

## 8. 尚未确认的官方权限/限制汇总

见 [specs/spec.md](../specs/spec.md) §6，所有接口涉及企业微信官方能力处均已在上文标注 `TODO(confirm-with-wecom-docs)`。
