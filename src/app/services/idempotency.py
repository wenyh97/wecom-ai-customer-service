"""幂等键存储抽象与内存实现。

生产环境应替换为 Redis（`SETNX` + TTL），第一阶段使用内存字典，
接口保持一致以便替换。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class IdempotencyStore(Protocol):
    async def get(self, key: str) -> dict | None: ...

    async def set(self, key: str, value: dict) -> None: ...


class InMemoryIdempotencyStore:
    def __init__(self) -> None:
        self._store: dict[str, dict] = {}

    async def get(self, key: str) -> dict | None:
        return self._store.get(key)

    async def set(self, key: str, value: dict) -> None:
        self._store[key] = value
