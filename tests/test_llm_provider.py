from __future__ import annotations

import pytest

from app.llm.provider import ChatMessage, FakeLLMProvider


@pytest.mark.asyncio
async def test_fake_llm_provider_generates_reply() -> None:
    provider = FakeLLMProvider()
    messages = [
        ChatMessage(role="system", content="system prompt"),
        ChatMessage(role="user", content="退款政策是什么？"),
    ]
    response = await provider.generate(messages)
    assert "退款政策" in response.content
    assert response.model == "fake-model"
