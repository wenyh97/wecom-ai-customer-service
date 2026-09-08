"""知识库文档存储（内存实现）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from app.core.errors import NotFoundError
from app.rag.chunking import split_into_chunks
from app.rag.retriever import Retriever


@dataclass
class KnowledgeDocument:
    document_id: str
    title: str
    chunk_count: int
    metadata: dict = field(default_factory=dict)


class KnowledgeBaseService:
    def __init__(self, retriever: Retriever) -> None:
        self._retriever = retriever
        self._documents: dict[str, KnowledgeDocument] = {}

    async def upload_document(
        self, title: str, content: str, metadata: dict | None = None
    ) -> KnowledgeDocument:
        document_id = str(uuid.uuid4())
        chunks = split_into_chunks(content)
        chunk_count = await self._retriever.index_document(document_id, title, chunks)
        document = KnowledgeDocument(
            document_id=document_id,
            title=title,
            chunk_count=chunk_count,
            metadata=metadata or {},
        )
        self._documents[document_id] = document
        return document

    def get_document(self, document_id: str) -> KnowledgeDocument:
        document = self._documents.get(document_id)
        if document is None:
            raise NotFoundError(f"document {document_id} not found")
        return document

    async def search(self, query: str, top_k: int = 5):
        return await self._retriever.search(query, top_k=top_k)
