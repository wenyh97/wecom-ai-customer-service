"""最小 RAG 离线评测脚本接口。"""

from __future__ import annotations

from dataclasses import dataclass

from app.rag.retriever import Retriever


@dataclass(frozen=True)
class EvalCase:
    id: str
    query: str
    expected_doc_ids: list[str]
    expected_handoff: bool = False


@dataclass(frozen=True)
class EvalReport:
    total: int
    hit_at_k: float
    details: list[dict]


async def evaluate_retrieval(
    dataset: list[EvalCase], retriever: Retriever, top_k: int = 5
) -> EvalReport:
    """计算检索命中率（hit@k）：命中集合中是否包含任一期望文档 ID。"""

    details: list[dict] = []
    hits = 0
    for case in dataset:
        results = await retriever.search(case.query, top_k=top_k)
        retrieved_doc_ids = {chunk.document_id for chunk in results}
        hit = bool(retrieved_doc_ids & set(case.expected_doc_ids))
        hits += int(hit)
        details.append({"id": case.id, "hit": hit, "retrieved": list(retrieved_doc_ids)})

    total = len(dataset)
    hit_at_k = hits / total if total else 0.0
    return EvalReport(total=total, hit_at_k=hit_at_k, details=details)
