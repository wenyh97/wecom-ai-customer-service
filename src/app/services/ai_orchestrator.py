"""AI 编排服务：实现 docs/rag-agent.md 描述的核心链路。

第一阶段仅实现 RAG 问答；Agent/工具调用能力仅保留受控扩展点
（`allowed_tools`），不实现任何真实工具调用。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.llm.provider import ChatMessage, LLMCallError, LLMProvider, LLMTimeoutError
from app.rag.retriever import RetrievedChunk, Retriever

SYSTEM_PROMPT = (
    "你是企业客服 AI 助手，只能依据提供的知识库片段回答问题。"
    "如果片段中没有足够信息，必须明确说明并建议转人工，禁止编造答案。"
)


@dataclass(frozen=True)
class AIReplyResult:
    reply: str | None
    handoff_required: bool
    confidence: float
    citations: list[RetrievedChunk]


@dataclass
class AIOrchestrator:
    llm_provider: LLMProvider
    retriever: Retriever
    sensitive_keywords: list[str] = field(default_factory=list)
    confidence_threshold: float = 0.35
    top_k: int = 5
    # 受控扩展点：第一阶段禁止任何工具调用，未来扩展需显式加入白名单并
    # 配合审计与人工审核流程，见 docs/rag-agent.md §2.9。
    allowed_tools: list[str] = field(default_factory=list)

    def _hits_sensitive_keyword(self, text: str) -> bool:
        return any(keyword in text for keyword in self.sensitive_keywords)

    async def handle_message(
        self, query: str, history: list[str] | None = None
    ) -> AIReplyResult:
        if self._hits_sensitive_keyword(query):
            return AIReplyResult(
                reply=None, handoff_required=True, confidence=0.0, citations=[]
            )

        try:
            chunks = await self.retriever.search(query, top_k=self.top_k)
        except Exception:
            # 检索失败：不允许模型无依据回答，直接转人工
            return AIReplyResult(
                reply=None, handoff_required=True, confidence=0.0, citations=[]
            )

        confidence = chunks[0].score if chunks else 0.0
        if confidence < self.confidence_threshold:
            return AIReplyResult(
                reply=None,
                handoff_required=True,
                confidence=confidence,
                citations=chunks,
            )

        context_text = "\n\n".join(
            f"[{chunk.source_id}] {chunk.title}: {chunk.text}" for chunk in chunks
        )
        messages = [
            ChatMessage(role="system", content=SYSTEM_PROMPT),
            ChatMessage(
                role="user",
                content=f"知识库片段：\n{context_text}\n\n客户问题：{query}",
            ),
        ]
        try:
            response = await self.llm_provider.generate(messages)
        except (LLMTimeoutError, LLMCallError):
            return AIReplyResult(
                reply=None,
                handoff_required=True,
                confidence=confidence,
                citations=chunks,
            )

        return AIReplyResult(
            reply=response.content,
            handoff_required=False,
            confidence=confidence,
            citations=chunks,
        )
