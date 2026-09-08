from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.models import Customer, IdempotencyRecord, StaffUser


@pytest.mark.asyncio
async def test_schema_supports_core_entities(container) -> None:
    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-a', '企业 A')
        staff = await uow.staff_users.get_or_create(tenant.id, 'staff-1')
        customer = await uow.customers.get_or_create(tenant.id, 'cust-1')
        conversation = await uow.conversations.get_or_create(tenant.id, customer.id, staff.id)
        await uow.messages.append(
            tenant_id=tenant.id,
            conversation_id=conversation.id,
            role='customer',
            content='你好',
        )
        await uow.commit()

    async with container.uow_factory() as uow:
        loaded = await uow.conversations.get_by_id(conversation.id)
        assert loaded is not None
        messages = await uow.messages.list_recent(conversation.id)
        assert len(messages) == 1
        assert messages[0].content == '你好'


@pytest.mark.asyncio
async def test_unique_constraints_enforced(container) -> None:
    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-b', '企业 B')
        uow.session.add(StaffUser(tenant_id=tenant.id, wecom_userid='dup-staff', status='active'))
        await uow.commit()

    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-b', '企业 B')
        uow.session.add(StaffUser(tenant_id=tenant.id, wecom_userid='dup-staff', status='active'))
        with pytest.raises(IntegrityError):
            await uow.commit()
        await uow.rollback()
            
    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-c', '企业 C')
        uow.session.add(Customer(tenant_id=tenant.id, external_userid='dup-customer', status='active'))
        await uow.commit()

    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-c', '企业 C')
        uow.session.add(Customer(tenant_id=tenant.id, external_userid='dup-customer', status='active'))
        with pytest.raises(IntegrityError):
            await uow.commit()
        await uow.rollback()


@pytest.mark.asyncio
async def test_idempotency_key_unique_constraint(container) -> None:
    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-d', '企业 D')
        uow.session.add(
            IdempotencyRecord(
                tenant_id=tenant.id,
                idempotency_key='dup-key',
                status='completed',
                response_payload={'ok': True},
            )
        )
        await uow.commit()

    async with container.uow_factory() as uow:
        tenant = await uow.tenants.get_or_create('tenant-d', '企业 D')
        uow.session.add(
            IdempotencyRecord(
                tenant_id=tenant.id,
                idempotency_key='dup-key',
                status='completed',
                response_payload={'ok': True},
            )
        )
        with pytest.raises(IntegrityError):
            await uow.commit()
        await uow.rollback()
