"""Pydantic 请求/响应模型：/kb/*。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class DocumentUploadRequest(BaseModel):
    title: str
    content: str
    metadata: dict = Field(default_factory=dict)


class DocumentUploadResponse(BaseModel):
    document_id: str
    chunk_count: int


class DocumentResponse(BaseModel):
    document_id: str
    title: str
    chunk_count: int
    metadata: dict


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5


class SearchResultItem(BaseModel):
    source_id: str
    document_id: str
    title: str
    text: str
    score: float


class SearchResponse(BaseModel):
    results: list[SearchResultItem]
