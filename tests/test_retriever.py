from __future__ import annotations

import pytest

from app.rag.embedding import HashEmbeddingProvider
from app.rag.retriever import InMemoryRetriever


@pytest.mark.asyncio
async def test_index_and_search_returns_relevant_chunk() -> None:
    provider = HashEmbeddingProvider()
    retriever = InMemoryRetriever(embedding_provider=provider)

    refund_text = "退款将在7个工作日内到账。"
    shipping_text = "订单将在24小时内发货。"
    await retriever.index_document("doc-1", "退款政策", [refund_text])
    await retriever.index_document("doc-2", "发货政策", [shipping_text])

    # 查询文本与已索引片段完全一致时，哈希向量的余弦相似度应为 1（自我匹配），
    # 用于验证检索排序逻辑正确，而非验证语义相似度（假 embedding 不具备语义）。
    results = await retriever.search(refund_text, top_k=1)
    assert len(results) == 1
    assert results[0].document_id == "doc-1"
    assert results[0].score == pytest.approx(1.0, abs=1e-6)


@pytest.mark.asyncio
async def test_search_empty_index_returns_no_results() -> None:
    provider = HashEmbeddingProvider()
    retriever = InMemoryRetriever(embedding_provider=provider)
    results = await retriever.search("任意查询")
    assert results == []


@pytest.mark.asyncio
async def test_hash_embedding_is_deterministic() -> None:
    provider = HashEmbeddingProvider()
    [a] = await provider.embed(["hello"])
    [b] = await provider.embed(["hello"])
    assert a == b
