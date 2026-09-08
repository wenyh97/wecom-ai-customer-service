"""依赖容器：根据配置装配各模块实现，供 FastAPI 依赖注入使用。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from app.core.config import Settings
from app.db.repository import UnitOfWork
from app.db.session import build_async_engine, build_session_factory
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
from app.services.idempotency import DatabaseIdempotencyStore, IdempotencyStore
from app.services.knowledge_base import KnowledgeBaseService
from app.services.revisit import RevisitTaskStore


class OutboundMessageDispatcher:
    async def send_text(self, conversation_id: str, reply: str) -> dict:
        return {
            'conversation_id': conversation_id,
            'status': 'accepted',
            'detail': 'TODO(confirm-with-wecom-docs): real WeCom send API is not implemented in Phase 1.',
            'reply_preview': reply[:80],
        }


@dataclass
class Container:
    settings: Settings
    llm_provider: LLMProvider
    embedding_provider: EmbeddingProvider
    retriever: Retriever
    engine: object
    session_factory: object
    uow_factory: Callable[[], UnitOfWork]
    conversation_store: ConversationStore
    knowledge_base: KnowledgeBaseService
    revisit_tasks: RevisitTaskStore
    handoffs: HandoffStore
    audit_log: AuditLogStore
    idempotency_store: IdempotencyStore
    ai_orchestrator: AIOrchestrator
    outbound_dispatcher: OutboundMessageDispatcher

    async def warmup(self) -> None:
        async with self.uow_factory() as uow:
            await self.knowledge_base.sync_active_documents(uow)

    async def close(self) -> None:
        await self.engine.dispose()


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


def build_container(settings: Settings) -> Container:
    llm_provider = build_llm_provider(settings)
    embedding_provider = build_embedding_provider(settings)
    retriever = InMemoryRetriever(embedding_provider=embedding_provider)
    engine = build_async_engine(settings.database_url, app_env=settings.app_env)
    session_factory = build_session_factory(engine)

    ai_orchestrator = AIOrchestrator(
        llm_provider=llm_provider,
        retriever=retriever,
        sensitive_keywords=settings.sensitive_keyword_list,
        confidence_threshold=settings.handoff_confidence_threshold,
        top_k=settings.retrieval_top_k,
    )

    def uow_factory() -> UnitOfWork:
        return UnitOfWork(session_factory)

    return Container(
        settings=settings,
        llm_provider=llm_provider,
        embedding_provider=embedding_provider,
        retriever=retriever,
        engine=engine,
        session_factory=session_factory,
        uow_factory=uow_factory,
        conversation_store=ConversationStore(
            default_tenant_slug=settings.default_tenant_slug,
            default_tenant_name=settings.default_tenant_name,
        ),
        knowledge_base=KnowledgeBaseService(
            retriever=retriever,
            default_tenant_slug=settings.default_tenant_slug,
            default_tenant_name=settings.default_tenant_name,
        ),
        revisit_tasks=RevisitTaskStore(
            default_tenant_slug=settings.default_tenant_slug,
            default_tenant_name=settings.default_tenant_name,
        ),
        handoffs=HandoffStore(),
        audit_log=AuditLogStore(
            default_tenant_slug=settings.default_tenant_slug,
            default_tenant_name=settings.default_tenant_name,
        ),
        idempotency_store=DatabaseIdempotencyStore(
            default_tenant_slug=settings.default_tenant_slug,
            default_tenant_name=settings.default_tenant_name,
        ),
        ai_orchestrator=ai_orchestrator,
        outbound_dispatcher=OutboundMessageDispatcher(),
    )
