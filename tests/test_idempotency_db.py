from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_database_idempotency_store_round_trip(container) -> None:
    async with container.uow_factory() as uow:
        payload = {'conversation_id': 'conv-1', 'reply': 'ok'}
        assert await container.idempotency_store.get(uow, 'idem-1') is None
        await container.idempotency_store.set(uow, 'idem-1', payload)
        await uow.commit()

    async with container.uow_factory() as uow:
        loaded = await container.idempotency_store.get(uow, 'idem-1')
        assert loaded == payload
