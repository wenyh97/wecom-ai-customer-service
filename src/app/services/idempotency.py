"""幂等键存储（数据库实现）。"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from app.db.repository import UnitOfWork


@runtime_checkable
class IdempotencyStore(Protocol):
    async def get(self, uow: UnitOfWork, key: str) -> dict | None: ...

    async def set(self, uow: UnitOfWork, key: str, value: dict) -> None: ...


class DatabaseIdempotencyStore:
    def __init__(self, *, default_tenant_slug: str, default_tenant_name: str) -> None:
        self._default_tenant_slug = default_tenant_slug
        self._default_tenant_name = default_tenant_name

    async def get(self, uow: UnitOfWork, key: str) -> dict | None:
        record = await uow.idempotency.get(key)
        return None if record is None else record.response_payload

    async def set(self, uow: UnitOfWork, key: str, value: dict) -> None:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        await uow.idempotency.set(tenant_id=tenant.id, key=key, response_payload=value)
