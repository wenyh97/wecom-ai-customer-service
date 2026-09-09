from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import NotFoundError
from app.db.base import utcnow
from app.db.models import (
    AuditLog,
    Conversation,
    Customer,
    CustomerStaffBinding,
    HandoffCase,
    IdempotencyRecord,
    KnowledgeDocument,
    Message,
    RevisitPlan,
    RevisitTask,
    StaffUser,
    Tenant,
    content_sha256,
)


class TenantRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, slug: str, name: str) -> Tenant:
        tenant = await self.session.scalar(select(Tenant).where(Tenant.slug == slug))
        if tenant is not None:
            return tenant
        tenant = Tenant(slug=slug, name=name)
        self.session.add(tenant)
        await self.session.flush()
        return tenant


class StaffUserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, tenant_id: str, wecom_userid: str) -> StaffUser:
        staff = await self.session.scalar(
            select(StaffUser).where(
                StaffUser.tenant_id == tenant_id,
                StaffUser.wecom_userid == wecom_userid,
            )
        )
        if staff is not None:
            return staff
        staff = StaffUser(tenant_id=tenant_id, wecom_userid=wecom_userid)
        self.session.add(staff)
        await self.session.flush()
        return staff


class CustomerRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, tenant_id: str, external_userid: str) -> Customer:
        customer = await self.session.scalar(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.external_userid == external_userid,
            )
        )
        if customer is not None:
            return customer
        customer = Customer(tenant_id=tenant_id, external_userid=external_userid)
        self.session.add(customer)
        await self.session.flush()
        return customer


class CustomerStaffBindingRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, tenant_id: str, customer_id: str, staff_user_id: str) -> CustomerStaffBinding:
        binding = await self.session.scalar(
            select(CustomerStaffBinding).where(
                CustomerStaffBinding.customer_id == customer_id,
                CustomerStaffBinding.staff_user_id == staff_user_id,
            )
        )
        if binding is not None:
            return binding
        binding = CustomerStaffBinding(
            tenant_id=tenant_id,
            customer_id=customer_id,
            staff_user_id=staff_user_id,
        )
        self.session.add(binding)
        await self.session.flush()
        return binding


class ConversationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(
        self,
        tenant_id: str,
        customer_id: str,
        staff_user_id: str,
        channel: str = 'wecom',
    ) -> Conversation:
        conversation = await self.session.scalar(
            select(Conversation).where(
                Conversation.customer_id == customer_id,
                Conversation.staff_user_id == staff_user_id,
            )
        )
        if conversation is not None:
            return conversation
        conversation = Conversation(
            tenant_id=tenant_id,
            customer_id=customer_id,
            staff_user_id=staff_user_id,
            channel=channel,
            last_message_at=utcnow(),
        )
        self.session.add(conversation)
        await self.session.flush()
        return conversation

    async def get_by_id(self, conversation_id: str) -> Conversation | None:
        return await self.session.get(Conversation, conversation_id)

    async def touch(self, conversation: Conversation) -> None:
        conversation.last_message_at = utcnow()
        conversation.updated_at = utcnow()
        await self.session.flush()

    async def set_status(self, conversation: Conversation, status: str) -> None:
        conversation.status = status
        await self.touch(conversation)


class MessageRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def append(
        self,
        *,
        tenant_id: str,
        conversation_id: str,
        role: str,
        content: str,
        message_type: str = 'text',
        external_message_id: str | None = None,
        is_ai_generated: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> Message:
        message = Message(
            tenant_id=tenant_id,
            conversation_id=conversation_id,
            role=role,
            content=content,
            message_type=message_type,
            external_message_id=external_message_id,
            is_ai_generated=is_ai_generated,
            metadata_json=metadata or {},
        )
        self.session.add(message)
        conversation = await self.session.get(Conversation, conversation_id)
        if conversation is not None:
            conversation.last_message_at = message.created_at or utcnow()
            conversation.updated_at = utcnow()
        await self.session.flush()
        return message

    async def list_recent(self, conversation_id: str, limit: int = 10) -> list[Message]:
        result = await self.session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
        return list(reversed(result.all()))


class KnowledgeDocumentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        tenant_id: str,
        title: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        chunk_count: int = 0,
        status: str = 'active',
    ) -> KnowledgeDocument:
        document = KnowledgeDocument(
            tenant_id=tenant_id,
            title=title,
            content=content,
            content_sha256=content_sha256(content),
            metadata_json=metadata or {},
            chunk_count=chunk_count,
            status=status,
        )
        self.session.add(document)
        await self.session.flush()
        return document

    async def get(self, document_id: str) -> KnowledgeDocument:
        document = await self.session.get(KnowledgeDocument, document_id)
        if document is None:
            raise NotFoundError(f'document {document_id} not found')
        return document

    async def list_active(self, tenant_id: str) -> list[KnowledgeDocument]:
        result = await self.session.scalars(
            select(KnowledgeDocument)
            .where(KnowledgeDocument.tenant_id == tenant_id, KnowledgeDocument.status == 'active')
            .order_by(KnowledgeDocument.created_at.asc())
        )
        return list(result.all())


class HandoffRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_or_create(self, conversation_id: str) -> HandoffCase:
        record = await self.session.scalar(
            select(HandoffCase).where(HandoffCase.conversation_id == conversation_id)
        )
        if record is not None:
            return record
        record = HandoffCase(conversation_id=conversation_id)
        self.session.add(record)
        await self.session.flush()
        return record

    async def takeover(self, conversation_id: str, operator: str, reason: str) -> HandoffCase:
        record = await self.get_or_create(conversation_id)
        record.active = True
        record.operator = operator
        record.reason = reason
        record.started_at = utcnow()
        history = list(record.history_json)
        history.append({'action': 'takeover', 'operator': operator, 'reason': reason})
        record.history_json = history
        await self.session.flush()
        return record

    async def release(self, conversation_id: str) -> HandoffCase:
        record = await self.get_or_create(conversation_id)
        record.active = False
        record.ended_at = utcnow()
        history = list(record.history_json)
        history.append({'action': 'release', 'operator': record.operator})
        record.history_json = history
        await self.session.flush()
        return record


class RevisitPlanRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        tenant_id: str,
        customer_id: str,
        staff_user_id: str | None,
        name: str,
        reason: str,
        schedule_rule: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RevisitPlan:
        plan = RevisitPlan(
            tenant_id=tenant_id,
            customer_id=customer_id,
            staff_user_id=staff_user_id,
            name=name,
            reason=reason,
            schedule_rule=schedule_rule,
            metadata_json=metadata or {},
        )
        self.session.add(plan)
        await self.session.flush()
        return plan

    async def list_active(self, tenant_id: str) -> list[RevisitPlan]:
        result = await self.session.scalars(
            select(RevisitPlan)
            .where(RevisitPlan.tenant_id == tenant_id, RevisitPlan.status == 'active')
            .order_by(RevisitPlan.created_at.desc())
        )
        return list(result.all())


class RevisitTaskRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        tenant_id: str,
        customer_id: str,
        reason: str,
        planned_content: str,
        staff_user_id: str | None = None,
        plan_id: str | None = None,
    ) -> RevisitTask:
        task = RevisitTask(
            tenant_id=tenant_id,
            customer_id=customer_id,
            staff_user_id=staff_user_id,
            plan_id=plan_id,
            reason=reason,
            planned_content=planned_content,
        )
        self.session.add(task)
        await self.session.flush()
        return task

    async def get(self, task_id: str) -> RevisitTask:
        task = await self.session.get(RevisitTask, task_id)
        if task is None:
            raise NotFoundError(f'revisit task {task_id} not found')
        return task

    async def list_by_status(self, tenant_id: str, status: str | None = None) -> list[RevisitTask]:
        stmt = select(RevisitTask).where(RevisitTask.tenant_id == tenant_id)
        if status is not None:
            stmt = stmt.where(RevisitTask.status == status)
        result = await self.session.scalars(stmt.order_by(RevisitTask.created_at.desc()))
        return list(result.all())


class AuditLogRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        *,
        tenant_id: str,
        conversation_id: str | None,
        correlation_id: str,
        handoff_required: bool,
        confidence: float,
        citations: list[str],
        input_summary: str,
        payload: dict[str, Any] | None = None,
        event_type: str = 'chat_message',
    ) -> AuditLog:
        entry = AuditLog(
            tenant_id=tenant_id,
            conversation_id=conversation_id,
            correlation_id=correlation_id,
            handoff_required=handoff_required,
            confidence=confidence,
            citations_json=citations,
            input_summary=input_summary,
            payload_json=payload or {},
            event_type=event_type,
        )
        self.session.add(entry)
        await self.session.flush()
        return entry

    async def query(self, conversation_id: str | None = None, limit: int = 50) -> list[AuditLog]:
        stmt = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
        if conversation_id is not None:
            stmt = stmt.where(AuditLog.conversation_id == conversation_id)
        result = await self.session.scalars(stmt)
        return list(result.all())


class IdempotencyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, key: str) -> IdempotencyRecord | None:
        return await self.session.scalar(
            select(IdempotencyRecord).where(IdempotencyRecord.idempotency_key == key)
        )

    async def set(
        self,
        *,
        tenant_id: str,
        key: str,
        response_payload: dict[str, Any],
    ) -> IdempotencyRecord:
        record = await self.get(key)
        if record is not None:
            record.response_payload = response_payload
            record.status = 'completed'
            await self.session.flush()
            return record
        fingerprint = hashlib.sha256(repr(sorted(response_payload.items())).encode('utf-8')).hexdigest()
        record = IdempotencyRecord(
            tenant_id=tenant_id,
            idempotency_key=key,
            response_payload=response_payload,
            request_fingerprint=fingerprint,
        )
        self.session.add(record)
        await self.session.flush()
        return record

    async def reserve(self, *, tenant_id: str, key: str) -> bool:
        existing = await self.get(key)
        if existing is not None:
            return False
        record = IdempotencyRecord(
            tenant_id=tenant_id,
            idempotency_key=key,
            status='processing',
            response_payload={},
        )
        self.session.add(record)
        try:
            await self.session.flush()
        except IntegrityError:
            await self.session.rollback()
            return False
        return True


class UnitOfWork:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.session: AsyncSession | None = None

    async def __aenter__(self) -> UnitOfWork:
        self.session = self._session_factory()
        self.tenants = TenantRepository(self.session)
        self.staff_users = StaffUserRepository(self.session)
        self.customers = CustomerRepository(self.session)
        self.bindings = CustomerStaffBindingRepository(self.session)
        self.conversations = ConversationRepository(self.session)
        self.messages = MessageRepository(self.session)
        self.knowledge_documents = KnowledgeDocumentRepository(self.session)
        self.handoffs = HandoffRepository(self.session)
        self.revisit_plans = RevisitPlanRepository(self.session)
        self.revisit_tasks = RevisitTaskRepository(self.session)
        self.audit_logs = AuditLogRepository(self.session)
        self.idempotency = IdempotencyRepository(self.session)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.session is None:
            return
        try:
            if exc is not None:
                await self.session.rollback()
        finally:
            await self.session.close()

    async def commit(self) -> None:
        if self.session is None:
            return
        await self.session.commit()

    async def rollback(self) -> None:
        if self.session is None:
            return
        await self.session.rollback()


UnitOfWorkFactory = Callable[[], UnitOfWork]
