"""Embedding Provider 抽象。"""

from __future__ import annotations

import hashlib
from typing import Protocol, runtime_checkable

import httpx


@runtime_checkable
class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """返回每个文本对应的向量表示。"""
        ...


class EmbeddingTimeoutError(RuntimeError):
    pass


class EmbeddingCallError(RuntimeError):
    pass


class HashEmbeddingProvider:
    """确定性的假 embedding 实现，用于测试/开发环境，无需网络调用。

    使用简单的字符哈希投影到固定维度向量，不具备语义质量，仅保证：
    - 相同文本产生相同向量（可测试性）；
    - 不同文本大概率产生不同向量（便于基础检索测试）。
    """

    def __init__(self, dimensions: int = 32) -> None:
        self.dimensions = dimensions

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        # 将哈希字节循环填充到目标维度，归一化到 [-1, 1]
        values = [digest[i % len(digest)] for i in range(self.dimensions)]
        return [(v / 127.5) - 1.0 for v in values]


class OpenAICompatibleEmbeddingProvider:
    """指向 OpenAI-compatible `/embeddings` 服务的实现。"""

    def __init__(self, base_url: str, api_key: str, model: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        headers = {"Authorization": "Bearer " + self._api_key}
        payload = {"model": self._model, "input": texts}
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    f"{self._base_url}/embeddings", json=payload, headers=headers
                )
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise EmbeddingTimeoutError("embedding call timed out") from exc
        except httpx.HTTPError as exc:
            raise EmbeddingCallError(f"embedding call failed: {exc}") from exc

        data = response.json()
        return [item["embedding"] for item in data["data"]]
