"""/kb/* 路由：知识库文档上传/摄取/检索。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_container
from app.core.container import Container
from app.schemas.kb import (
    DocumentResponse,
    DocumentUploadRequest,
    DocumentUploadResponse,
    SearchRequest,
    SearchResponse,
    SearchResultItem,
)

router = APIRouter(prefix="/kb", tags=["knowledge-base"])


@router.post("/documents", response_model=DocumentUploadResponse)
async def upload_document(
    payload: DocumentUploadRequest,
    container: Container = Depends(get_container),
) -> DocumentUploadResponse:
    document = await container.knowledge_base.upload_document(
        title=payload.title, content=payload.content, metadata=payload.metadata
    )
    return DocumentUploadResponse(
        document_id=document.document_id, chunk_count=document.chunk_count
    )


@router.get("/documents/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str, container: Container = Depends(get_container)
) -> DocumentResponse:
    document = container.knowledge_base.get_document(document_id)
    return DocumentResponse(
        document_id=document.document_id,
        title=document.title,
        chunk_count=document.chunk_count,
        metadata=document.metadata,
    )


@router.post("/search", response_model=SearchResponse)
async def search(
    payload: SearchRequest, container: Container = Depends(get_container)
) -> SearchResponse:
    results = await container.knowledge_base.search(payload.query, top_k=payload.top_k)
    return SearchResponse(
        results=[
            SearchResultItem(
                source_id=r.source_id,
                document_id=r.document_id,
                title=r.title,
                text=r.text,
                score=r.score,
            )
            for r in results
        ]
    )
