"""依赖容器：根据配置装配各模块实现，供 FastAPI 依赖注入使用。

第一阶段所有存储为内存实现；当配置了真实 LLM/Embedding 凭证时使用
OpenAI-compatible 实现，否则回退到 Fake 实现，便于本地开发和测试。
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings
from app.llm.provider import FakeLLMProvider, LLMProvider, OpenAICompatibleLLMProvider
from app.rag.embedding import (
    EmbeddingProvider,
    HashEmbeddingProvider,
    OpenAICompatibleEmbeddingProvider,
)
from app.rag.retriever import InMemoryRetriever, Retriever
from app.services.ai_orchestrator import AIOrchestrator
from app.services.audit import AuditLogStore
from app.services.conversation import ConversationStore
from app.services.handoff import HandoffStore
from app.services.idempotency import IdempotencyStore, InMemoryIdempotencyStore
from app.services.knowledge_base import KnowledgeBaseService
from app.services.revisit import RevisitTaskStore


def build_llm_provider(settings: Settings) -> LLMProvider:
    if not settings.llm_api_key:
        return FakeLLMProvider(model=settings.llm_model)
    return OpenAICompatibleLLMProvider(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
    )


def build_embedding_provider(settings: Settings) -> EmbeddingProvider:
    if not settings.embedding_api_key:
        return HashEmbeddingProvider()
    return OpenAICompatibleEmbeddingProvider(
        base_url=settings.embedding_base_url,
        api_key=settings.embedding_api_key,
        model=settings.embedding_model,
    )


@dataclass
class Container:
    settings: Settings
    llm_provider: LLMProvider
    embedding_provider: EmbeddingProvider
    retriever: Retriever
    conversation_store: ConversationStore
    knowledge_base: KnowledgeBaseService
    revisit_tasks: RevisitTaskStore
    handoffs: HandoffStore
    audit_log: AuditLogStore
    idempotency_store: IdempotencyStore
    ai_orchestrator: AIOrchestrator


def build_container(settings: Settings) -> Container:
    llm_provider = build_llm_provider(settings)
    embedding_provider = build_embedding_provider(settings)
    retriever = InMemoryRetriever(embedding_provider=embedding_provider)

    ai_orchestrator = AIOrchestrator(
        llm_provider=llm_provider,
        retriever=retriever,
        sensitive_keywords=settings.sensitive_keyword_list,
        confidence_threshold=settings.handoff_confidence_threshold,
        top_k=settings.retrieval_top_k,
    )

    return Container(
        settings=settings,
        llm_provider=llm_provider,
        embedding_provider=embedding_provider,
        retriever=retriever,
        conversation_store=ConversationStore(),
        knowledge_base=KnowledgeBaseService(retriever=retriever),
        revisit_tasks=RevisitTaskStore(),
        handoffs=HandoffStore(),
        audit_log=AuditLogStore(),
        idempotency_store=InMemoryIdempotencyStore(),
        ai_orchestrator=ai_orchestrator,
    )
