"""回访任务状态机（数据库实现）。"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select

from app.core.errors import ConflictError
from app.db.base import utcnow
from app.db.models import Customer
from app.db.repository import UnitOfWork

_VALID_TRANSITIONS: dict[str, set[str]] = {
    'draft': {'pending_review'},
    'pending_review': {'approved', 'rejected'},
    'approved': {'sent', 'failed'},
    'rejected': set(),
    'sent': set(),
    'failed': set(),
}


@dataclass
class RevisitPlan:
    plan_id: str
    customer_external_userid: str
    reason: str
    name: str
    schedule_rule: str | None = None
    status: str = 'active'
    metadata: dict = field(default_factory=dict)


@dataclass
class RevisitTask:
    task_id: str
    customer_external_userid: str
    reason: str
    planned_content: str
    status: str = 'draft'
    reviewer: str | None = None
    review_comment: str | None = None
    created_at: float | None = None
    updated_at: float | None = None


class RevisitTaskStore:
    def __init__(self, *, default_tenant_slug: str, default_tenant_name: str) -> None:
        self._default_tenant_slug = default_tenant_slug
        self._default_tenant_name = default_tenant_name

    async def _resolve_customer(
        self, uow: UnitOfWork, customer_external_userid: str
    ) -> tuple[str, str]:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        customer = await uow.customers.get_or_create(tenant.id, customer_external_userid)
        return tenant.id, customer.id

    async def _external_userids(
        self, uow: UnitOfWork, customer_ids: set[str]
    ) -> dict[str, str]:
        if not customer_ids:
            return {}
        rows = await uow.session.execute(select(Customer).where(Customer.id.in_(customer_ids)))
        return {customer.id: customer.external_userid for customer in rows.scalars().all()}

    async def create(
        self, uow: UnitOfWork, customer_external_userid: str, reason: str, planned_content: str
    ) -> RevisitTask:
        tenant_id, customer_id = await self._resolve_customer(uow, customer_external_userid)
        task = await uow.revisit_tasks.create(
            tenant_id=tenant_id,
            customer_id=customer_id,
            reason=reason,
            planned_content=planned_content,
        )
        await self._apply_transition(uow, task, 'pending_review')
        return self._to_task(customer_external_userid, task)

    async def create_plan(
        self,
        uow: UnitOfWork,
        *,
        customer_external_userid: str,
        name: str,
        reason: str,
        schedule_rule: str | None = None,
        metadata: dict | None = None,
    ) -> RevisitPlan:
        tenant_id, customer_id = await self._resolve_customer(uow, customer_external_userid)
        plan = await uow.revisit_plans.create(
            tenant_id=tenant_id,
            customer_id=customer_id,
            staff_user_id=None,
            name=name,
            reason=reason,
            schedule_rule=schedule_rule,
            metadata=metadata,
        )
        return RevisitPlan(
            plan_id=plan.id,
            customer_external_userid=customer_external_userid,
            name=plan.name,
            reason=plan.reason,
            schedule_rule=plan.schedule_rule,
            status=plan.status,
            metadata=plan.metadata_json,
        )

    async def list_plans(self, uow: UnitOfWork) -> list[RevisitPlan]:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        plans = await uow.revisit_plans.list_active(tenant.id)
        customers = await self._external_userids(uow, {plan.customer_id for plan in plans})
        return [
            RevisitPlan(
                plan_id=plan.id,
                customer_external_userid=customers.get(plan.customer_id, ''),
                name=plan.name,
                reason=plan.reason,
                schedule_rule=plan.schedule_rule,
                status=plan.status,
                metadata=plan.metadata_json,
            )
            for plan in plans
        ]

    async def get(self, uow: UnitOfWork, task_id: str) -> RevisitTask:
        task = await uow.revisit_tasks.get(task_id)
        customer = await uow.session.get(Customer, task.customer_id)
        return self._to_task(customer.external_userid if customer else '', task)

    async def list_by_status(self, uow: UnitOfWork, status: str | None = None) -> list[RevisitTask]:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        tasks = await uow.revisit_tasks.list_by_status(tenant.id, status)
        customers = await self._external_userids(uow, {task.customer_id for task in tasks})
        return [self._to_task(customers.get(task.customer_id, ''), task) for task in tasks]

    async def review(
        self, uow: UnitOfWork, task_id: str, decision: str, reviewer: str, comment: str = ''
    ) -> RevisitTask:
        task = await uow.revisit_tasks.get(task_id)
        new_status = 'approved' if decision == 'approve' else 'rejected'
        await self._apply_transition(uow, task, new_status)
        task.reviewer = reviewer
        task.review_comment = comment
        await uow.session.flush()
        customer = await uow.session.get(Customer, task.customer_id)
        return self._to_task(customer.external_userid if customer else '', task)

    async def mark_sent(self, uow: UnitOfWork, task_id: str, success: bool) -> RevisitTask:
        task = await uow.revisit_tasks.get(task_id)
        await self._apply_transition(uow, task, 'sent' if success else 'failed')
        task.sent_at = utcnow()
        await uow.session.flush()
        customer = await uow.session.get(Customer, task.customer_id)
        return self._to_task(customer.external_userid if customer else '', task)

    async def _apply_transition(self, uow: UnitOfWork, task, new_status: str) -> None:
        allowed = _VALID_TRANSITIONS.get(task.status, set())
        if new_status not in allowed:
            raise ConflictError(f'cannot transition revisit task from {task.status} to {new_status}')
        task.status = new_status
        task.updated_at = utcnow()
        await uow.session.flush()

    def _to_task(self, customer_external_userid: str, task) -> RevisitTask:
        return RevisitTask(
            task_id=task.id,
            customer_external_userid=customer_external_userid,
            reason=task.reason,
            planned_content=task.planned_content,
            status=task.status,
            reviewer=task.reviewer,
            review_comment=task.review_comment,
            created_at=task.created_at.timestamp(),
            updated_at=task.updated_at.timestamp(),
        )
