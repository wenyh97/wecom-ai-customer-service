"""Retriever 抽象与内存实现。"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.rag.embedding import EmbeddingProvider


@dataclass(frozen=True)
class RetrievedChunk:
    source_id: str
    document_id: str
    title: str
    text: str
    score: float


@runtime_checkable
class Retriever(Protocol):
    async def search(self, query: str, top_k: int = 5) -> list[RetrievedChunk]: ...

    async def index_document(
        self, document_id: str, title: str, chunks: list[str]
    ) -> int:
        """摄取文档切片，返回写入的切片数量。"""
        ...


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


@dataclass
class _IndexedChunk:
    source_id: str
    document_id: str
    title: str
    text: str
    embedding: list[float]


@dataclass
class InMemoryRetriever:
    """内存暴力余弦相似度检索，第一阶段骨架使用，生产环境应替换为 pgvector 实现。

    接口与 `Retriever` Protocol 保持一致，替换实现时上层代码无需改动。
    """

    embedding_provider: EmbeddingProvider
    _chunks: list[_IndexedChunk] = field(default_factory=list)

    async def index_document(
        self, document_id: str, title: str, chunks: list[str]
    ) -> int:
        embeddings = await self.embedding_provider.embed(chunks)
        for text, embedding in zip(chunks, embeddings, strict=False):
            self._chunks.append(
                _IndexedChunk(
                    source_id=f"{document_id}#{uuid.uuid4().hex[:8]}",
                    document_id=document_id,
                    title=title,
                    text=text,
                    embedding=embedding,
                )
            )
        return len(chunks)

    async def search(self, query: str, top_k: int = 5) -> list[RetrievedChunk]:
        if not self._chunks:
            return []
        [query_embedding] = await self.embedding_provider.embed([query])
        scored = [
            RetrievedChunk(
                source_id=chunk.source_id,
                document_id=chunk.document_id,
                title=chunk.title,
                text=chunk.text,
                score=_cosine_similarity(query_embedding, chunk.embedding),
            )
            for chunk in self._chunks
        ]
        scored.sort(key=lambda c: c.score, reverse=True)
        return scored[:top_k]
