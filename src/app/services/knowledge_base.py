"""知识库文档存储（数据库 + 内存检索占位实现）。"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.db.repository import UnitOfWork
from app.rag.chunking import split_into_chunks
from app.rag.retriever import Retriever


@dataclass
class KnowledgeDocument:
    document_id: str
    title: str
    chunk_count: int
    metadata: dict = field(default_factory=dict)


class KnowledgeBaseService:
    def __init__(
        self,
        *,
        retriever: Retriever,
        default_tenant_slug: str,
        default_tenant_name: str,
    ) -> None:
        self._retriever = retriever
        self._default_tenant_slug = default_tenant_slug
        self._default_tenant_name = default_tenant_name

    async def upload_document(
        self,
        uow: UnitOfWork,
        title: str,
        content: str,
        metadata: dict | None = None,
    ) -> KnowledgeDocument:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        document = await uow.knowledge_documents.create(
            tenant_id=tenant.id,
            title=title,
            content=content,
            metadata=metadata,
            chunk_count=0,
        )
        chunks = split_into_chunks(content)
        chunk_count = await self._retriever.index_document(document.id, title, chunks)
        document.chunk_count = chunk_count
        await uow.session.flush()
        return KnowledgeDocument(
            document_id=document.id,
            title=document.title,
            chunk_count=document.chunk_count,
            metadata=document.metadata_json,
        )

    async def get_document(self, uow: UnitOfWork, document_id: str) -> KnowledgeDocument:
        document = await uow.knowledge_documents.get(document_id)
        return KnowledgeDocument(
            document_id=document.id,
            title=document.title,
            chunk_count=document.chunk_count,
            metadata=document.metadata_json,
        )

    async def search(self, query: str, top_k: int = 5):
        return await self._retriever.search(query, top_k=top_k)

    async def sync_active_documents(self, uow: UnitOfWork) -> None:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        if hasattr(self._retriever, 'clear'):
            self._retriever.clear()
        documents = await uow.knowledge_documents.list_active(tenant.id)
        for document in documents:
            chunks = split_into_chunks(document.content)
            await self._retriever.index_document(document.id, document.title, chunks)
