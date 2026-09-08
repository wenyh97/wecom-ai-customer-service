"""回访任务状态机（内存实现）。"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from app.core.errors import ConflictError, NotFoundError

_VALID_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"pending_review"},
    "pending_review": {"approved", "rejected"},
    "approved": {"sent", "failed"},
    "rejected": set(),
    "sent": set(),
    "failed": set(),
}


@dataclass
class RevisitTask:
    task_id: str
    customer_external_userid: str
    reason: str
    planned_content: str
    status: str = "draft"
    reviewer: str | None = None
    review_comment: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class RevisitTaskStore:
    def __init__(self) -> None:
        self._tasks: dict[str, RevisitTask] = {}

    def create(
        self, customer_external_userid: str, reason: str, planned_content: str
    ) -> RevisitTask:
        task = RevisitTask(
            task_id=str(uuid.uuid4()),
            customer_external_userid=customer_external_userid,
            reason=reason,
            planned_content=planned_content,
        )
        self._tasks[task.task_id] = task
        # 新建任务默认直接进入待审核队列，符合“回访默认受控”的原则
        self._transition(task, "pending_review")
        return task

    def get(self, task_id: str) -> RevisitTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise NotFoundError(f"revisit task {task_id} not found")
        return task

    def list_by_status(self, status: str | None = None) -> list[RevisitTask]:
        tasks = list(self._tasks.values())
        if status is not None:
            tasks = [t for t in tasks if t.status == status]
        return tasks

    def _transition(self, task: RevisitTask, new_status: str) -> None:
        allowed = _VALID_TRANSITIONS.get(task.status, set())
        if new_status not in allowed:
            raise ConflictError(
                f"cannot transition revisit task from {task.status} to {new_status}"
            )
        task.status = new_status
        task.updated_at = time.time()

    def review(
        self, task_id: str, decision: str, reviewer: str, comment: str = ""
    ) -> RevisitTask:
        task = self.get(task_id)
        new_status = "approved" if decision == "approve" else "rejected"
        self._transition(task, new_status)
        task.reviewer = reviewer
        task.review_comment = comment
        return task

    def mark_sent(self, task_id: str, success: bool) -> RevisitTask:
        task = self.get(task_id)
        self._transition(task, "sent" if success else "failed")
        return task
