"""会话与客户映射（内存实现，第一阶段骨架）。"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field


@dataclass
class Message:
    role: str  # "customer" | "assistant" | "staff"
    content: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class Conversation:
    conversation_id: str
    customer_external_userid: str
    staff_userid: str
    status: str = "ai_active"  # "ai_active" | "handoff"
    messages: list[Message] = field(default_factory=list)

    def recent_history(self, limit: int = 10) -> list[Message]:
        return self.messages[-limit:]


class ConversationStore:
    """按 (customer_external_userid, staff_userid) 维度管理会话，内存实现。"""

    def __init__(self) -> None:
        self._by_key: dict[tuple[str, str], Conversation] = {}
        self._by_id: dict[str, Conversation] = {}

    def get_or_create(
        self, customer_external_userid: str, staff_userid: str
    ) -> Conversation:
        key = (customer_external_userid, staff_userid)
        if key in self._by_key:
            return self._by_key[key]
        conversation = Conversation(
            conversation_id=str(uuid.uuid4()),
            customer_external_userid=customer_external_userid,
            staff_userid=staff_userid,
        )
        self._by_key[key] = conversation
        self._by_id[conversation.conversation_id] = conversation
        return conversation

    def get_by_id(self, conversation_id: str) -> Conversation | None:
        return self._by_id.get(conversation_id)
