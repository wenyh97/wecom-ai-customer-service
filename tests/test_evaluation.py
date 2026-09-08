from __future__ import annotations

import pytest

from app.rag.embedding import HashEmbeddingProvider
from app.rag.retriever import InMemoryRetriever
from app.services.evaluation import EvalCase, evaluate_retrieval


@pytest.mark.asyncio
async def test_evaluate_retrieval_computes_hit_rate() -> None:
    retriever = InMemoryRetriever(embedding_provider=HashEmbeddingProvider())
    await retriever.index_document("doc-1", "退款政策", ["退款7天到账"])

    dataset = [
        EvalCase(id="case-1", query="退款7天到账", expected_doc_ids=["doc-1"]),
        EvalCase(id="case-2", query="不存在的问题", expected_doc_ids=["doc-999"]),
    ]
    report = await evaluate_retrieval(dataset, retriever, top_k=1)
    assert report.total == 2
    assert report.hit_at_k == pytest.approx(0.5)
    assert report.details[0]["hit"] is True
    assert report.details[1]["hit"] is False
