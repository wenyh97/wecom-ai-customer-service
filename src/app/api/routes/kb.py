"""/kb/* 路由：知识库文档上传/摄取/检索。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.db.repository import UnitOfWork
from app.schemas.kb import (
    DocumentResponse,
    DocumentUploadRequest,
    DocumentUploadResponse,
    SearchRequest,
    SearchResponse,
    SearchResultItem,
)

router = APIRouter(prefix='/kb', tags=['knowledge-base'])


@router.post('/documents', response_model=DocumentUploadResponse)
async def upload_document(
    payload: DocumentUploadRequest,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> DocumentUploadResponse:
    document = await container.knowledge_base.upload_document(
        uow, title=payload.title, content=payload.content, metadata=payload.metadata
    )
    await container.audit_log.record(
        uow,
        raw_input=payload.title,
        event_type='knowledge_document_upload',
        payload={'document_id': document.document_id, 'chunk_count': document.chunk_count},
    )
    await uow.commit()
    return DocumentUploadResponse(
        document_id=document.document_id, chunk_count=document.chunk_count
    )


@router.get('/documents/{document_id}', response_model=DocumentResponse)
async def get_document(
    document_id: str,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> DocumentResponse:
    document = await container.knowledge_base.get_document(uow, document_id)
    return DocumentResponse(
        document_id=document.document_id,
        title=document.title,
        chunk_count=document.chunk_count,
        metadata=document.metadata,
    )


@router.post('/search', response_model=SearchResponse)
async def search(
    payload: SearchRequest, container: Container = Depends(get_container)
) -> SearchResponse:
    results = await container.knowledge_base.search(payload.query, top_k=payload.top_k)
    return SearchResponse(
        results=[
            SearchResultItem(
                source_id=result.source_id,
                document_id=result.document_id,
                title=result.title,
                text=result.text,
                score=result.score,
            )
            for result in results
        ]
    )
