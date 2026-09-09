from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.container import Container, build_container
from app.db.base import Base
from app.llm.provider import LLMCallError, LLMResponse, LLMTimeoutError
from app.main import create_app


async def _create_schema(container: Container) -> None:
    async with container.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


def _build_settings(**overrides) -> Settings:
    defaults = dict(
        _env_file=None,
        app_env='test',
        database_url='sqlite+aiosqlite:///:memory:',
        llm_base_url='https://llm.example/v1',
        llm_api_key='real-key',
        llm_model='demo-model',
        ai_bridge_token='bridge-test-token',
        embedding_api_key='',
        handoff_confidence_threshold=0.1,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
def bridge_client() -> TestClient:
    container = build_container(_build_settings())
    asyncio.run(_create_schema(container))
    app = create_app(container=container)
    with TestClient(app) as client:
        yield client
    asyncio.run(container.close())


def _auth_headers(token: str = 'bridge-test-token') -> dict[str, str]:
    return {'Authorization': 'Bearer ' + token}


def _payload(
    *,
    contact_id: str = 'contact-1',
    staff_userid: str = 'staff-1',
    message_id: str = 'msg-1',
    text: str = '你好',
) -> dict[str, str]:
    return {
        'conversation_key': f'wechaty-workpro:{staff_userid}:{contact_id}',
        'contact_id': contact_id,
        'staff_userid': staff_userid,
        'message_id': message_id,
        'text': text,
    }


def test_internal_chat_requires_bearer_token(client: TestClient) -> None:
    response = client.post('/internal/chat', json=_payload())
    assert response.status_code == 401
    assert response.json()['error']['code'] == 'unauthorized'


def test_internal_chat_rejects_invalid_bearer_token(client: TestClient) -> None:
    response = client.post(
        '/internal/chat',
        json=_payload(),
        headers=_auth_headers('wrong-token'),
    )
    assert response.status_code == 403
    assert response.json()['error']['code'] == 'forbidden'


def test_internal_chat_requires_real_llm_key(client: TestClient) -> None:
    response = client.post(
        '/internal/chat',
        json=_payload(),
        headers=_auth_headers(),
    )
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'llm_not_configured'


def test_internal_chat_handles_llm_without_knowledge_base(bridge_client: TestClient, monkeypatch) -> None:
    captured_messages: list[list[str]] = []

    async def fake_generate(messages, *, temperature=0.2, timeout=15.0):
        captured_messages.append([f'{item.role}:{item.content}' for item in messages])
        return LLMResponse(content='您好，这里是演示客服。', model='demo-model')

    monkeypatch.setattr(bridge_client.app.state.container.llm_provider, 'generate', fake_generate)

    response = bridge_client.post('/internal/chat', json=_payload(), headers=_auth_headers())

    assert response.status_code == 200
    assert response.json()['reply'] == '您好，这里是演示客服。'
    assert any('user:你好' == item for item in captured_messages[0])


def test_internal_chat_is_idempotent_by_message_id(
    bridge_client: TestClient, monkeypatch
) -> None:
    call_count = 0

    async def fake_generate(messages, *, temperature=0.2, timeout=15.0):
        nonlocal call_count
        call_count += 1
        return LLMResponse(content='幂等回复', model='demo-model')

    monkeypatch.setattr(bridge_client.app.state.container.llm_provider, 'generate', fake_generate)

    first = bridge_client.post('/internal/chat', json=_payload(), headers=_auth_headers())
    second = bridge_client.post('/internal/chat', json=_payload(), headers=_auth_headers())

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()
    assert call_count == 1


def test_internal_chat_keeps_multi_turn_context_isolated_per_contact(
    bridge_client: TestClient, monkeypatch
) -> None:
    captured_messages: list[list[str]] = []

    async def fake_generate(messages, *, temperature=0.2, timeout=15.0):
        rendered = [f'{item.role}:{item.content}' for item in messages]
        captured_messages.append(rendered)
        return LLMResponse(content=f'call-{len(captured_messages)}', model='demo-model')

    monkeypatch.setattr(bridge_client.app.state.container.llm_provider, 'generate', fake_generate)

    first = bridge_client.post(
        '/internal/chat',
        json=_payload(message_id='msg-1', text='你好，我叫小王'),
        headers=_auth_headers(),
    )
    second = bridge_client.post(
        '/internal/chat',
        json=_payload(message_id='msg-2', text='我刚才问了什么'),
        headers=_auth_headers(),
    )
    third = bridge_client.post(
        '/internal/chat',
        json=_payload(contact_id='contact-2', message_id='msg-3', text='我刚才问了什么'),
        headers=_auth_headers(),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 200
    assert any('user:你好，我叫小王' == item for item in captured_messages[1])
    assert any('assistant:call-1' == item for item in captured_messages[1])
    assert all('你好，我叫小王' not in item for item in captured_messages[2])


@pytest.mark.parametrize(
    ('side_effect', 'status_code', 'error_code'),
    [
        (LLMTimeoutError('boom'), 504, 'upstream_timeout'),
        (LLMCallError('boom'), 502, 'llm_upstream_error'),
    ],
)
def test_internal_chat_handles_llm_failures(
    bridge_client: TestClient,
    monkeypatch,
    side_effect: Exception,
    status_code: int,
    error_code: str,
) -> None:
    async def fake_generate(messages, *, temperature=0.2, timeout=15.0):
        raise side_effect

    monkeypatch.setattr(bridge_client.app.state.container.llm_provider, 'generate', fake_generate)

    response = bridge_client.post(
        '/internal/chat',
        json=_payload(message_id='msg-failure'),
        headers=_auth_headers(),
    )

    assert response.status_code == status_code
    assert response.json()['error']['code'] == error_code
