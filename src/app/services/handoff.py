"""人工接管状态记录（内存实现）。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class HandoffRecord:
    conversation_id: str
    active: bool = False
    operator: str | None = None
    reason: str | None = None
    started_at: float | None = None
    ended_at: float | None = None
    history: list[dict] = field(default_factory=list)


class HandoffStore:
    def __init__(self) -> None:
        self._records: dict[str, HandoffRecord] = {}

    def get(self, conversation_id: str) -> HandoffRecord:
        return self._records.setdefault(
            conversation_id, HandoffRecord(conversation_id=conversation_id)
        )

    def takeover(self, conversation_id: str, operator: str, reason: str) -> HandoffRecord:
        record = self.get(conversation_id)
        record.active = True
        record.operator = operator
        record.reason = reason
        record.started_at = time.time()
        record.history.append(
            {"action": "takeover", "operator": operator, "reason": reason}
        )
        return record

    def release(self, conversation_id: str) -> HandoffRecord:
        record = self.get(conversation_id)
        record.active = False
        record.ended_at = time.time()
        record.history.append({"action": "release", "operator": record.operator})
        return record
