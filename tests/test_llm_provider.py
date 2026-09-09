from __future__ import annotations

import httpx
import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.container import build_llm_provider
from app.llm.provider import (
    ChatMessage,
    FakeLLMProvider,
    LLMCallError,
    LLMTimeoutError,
    OpenAICompatibleLLMProvider,
)


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


@pytest.mark.asyncio
async def test_openai_compatible_provider_uses_bearer_header_by_default(monkeypatch) -> None:
    captured: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {'total_tokens': 1},
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            captured['timeout'] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict[str, str]) -> FakeResponse:
            captured['url'] = url
            captured['headers'] = headers
            captured['payload'] = json
            return FakeResponse()

    monkeypatch.setattr('app.llm.provider.httpx.AsyncClient', FakeClient)
    provider = OpenAICompatibleLLMProvider(
        base_url='https://llm.example/v1/',
        api_key='demo-key',
        model='demo-model',
    )
    response = await provider.generate(
        [ChatMessage(role='user', content='hello')], temperature=0.7, timeout=12.0
    )

    assert response.content == 'ok'
    assert captured['url'] == 'https://llm.example/v1/chat/completions'
    assert 'Authorization' in captured['headers']
    assert captured['headers']['Authorization'].startswith('Bearer ')
    assert 'api-key' not in captured['headers']
    assert captured['payload']['temperature'] == 0.7


@pytest.mark.asyncio
async def test_openai_compatible_provider_uses_api_key_header(monkeypatch) -> None:
    captured: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {'total_tokens': 1},
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            captured['timeout'] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict[str, str]) -> FakeResponse:
            captured['url'] = url
            captured['headers'] = headers
            captured['payload'] = json
            return FakeResponse()

    monkeypatch.setattr('app.llm.provider.httpx.AsyncClient', FakeClient)
    provider = OpenAICompatibleLLMProvider(
        base_url='https://tonyai.openai.azure.com/openai/v1/',
        api_key='azure-key',
        model='gpt-5.6-luna',
        auth_mode='api-key',
    )
    response = await provider.generate([ChatMessage(role='user', content='hello')], timeout=18.0)

    assert response.content == 'ok'
    assert captured['url'] == 'https://tonyai.openai.azure.com/openai/v1/chat/completions'
    assert captured['headers'] == {'api-key': 'azure-key'}
    assert 'Authorization' not in captured['headers']
    assert captured['payload']['temperature'] == 0.2


@pytest.mark.asyncio
async def test_openai_compatible_provider_omits_temperature_when_disabled(monkeypatch) -> None:
    captured: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {'total_tokens': 1},
            }

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            captured['timeout'] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict[str, str]) -> FakeResponse:
            captured['url'] = url
            captured['headers'] = headers
            captured['payload'] = json
            return FakeResponse()

    monkeypatch.setattr('app.llm.provider.httpx.AsyncClient', FakeClient)
    provider = OpenAICompatibleLLMProvider(
        base_url='https://tonyai.openai.azure.com/openai/v1/',
        api_key='azure-key',
        model='gpt-5.6-luna',
        auth_mode='api-key',
        send_temperature=False,
    )
    response = await provider.generate([ChatMessage(role='user', content='hello')], temperature=0.7)

    assert response.content == 'ok'
    assert captured['headers'] == {'api-key': 'azure-key'}
    assert 'temperature' not in captured['payload']


@pytest.mark.asyncio
async def test_openai_compatible_provider_maps_timeout_error(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, timeout: float) -> None:
            del timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict[str, str]):
            del url, json, headers
            raise httpx.TimeoutException('timed out')

    monkeypatch.setattr('app.llm.provider.httpx.AsyncClient', FakeClient)
    provider = OpenAICompatibleLLMProvider(
        base_url='https://llm.example/v1',
        api_key='demo-key',
        model='demo-model',
    )

    with pytest.raises(LLMTimeoutError, match='llm call timed out'):
        await provider.generate([ChatMessage(role='user', content='hello')])


@pytest.mark.asyncio
async def test_openai_compatible_provider_maps_http_error_without_leaking_key(
    monkeypatch,
) -> None:
    secret_key = 'super-secret-key'

    class FakeClient:
        def __init__(self, timeout: float) -> None:
            del timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> bool:
            return False

        async def post(self, url: str, json: dict, headers: dict[str, str]):
            del json, headers
            request = httpx.Request('POST', url)
            response = httpx.Response(status_code=401, request=request)
            raise httpx.HTTPStatusError('upstream unauthorized', request=request, response=response)

    monkeypatch.setattr('app.llm.provider.httpx.AsyncClient', FakeClient)
    provider = OpenAICompatibleLLMProvider(
        base_url='https://llm.example/v1',
        api_key=secret_key,
        model='demo-model',
    )

    with pytest.raises(LLMCallError, match='llm call failed') as exc_info:
        await provider.generate([ChatMessage(role='user', content='hello')])
    assert secret_key not in str(exc_info.value)


def test_invalid_llm_auth_mode_fails_settings_parsing() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, llm_auth_mode='invalid')


def test_llm_send_temperature_defaults_to_true() -> None:
    settings = Settings(_env_file=None)

    assert settings.llm_send_temperature is True


def test_build_llm_provider_passes_send_temperature_setting(monkeypatch) -> None:
    captured: dict = {}

    class FakeProvider:
        def __init__(
            self,
            *,
            base_url: str,
            api_key: str,
            model: str,
            auth_mode: str,
            send_temperature: bool,
        ) -> None:
            captured['base_url'] = base_url
            captured['api_key'] = api_key
            captured['model'] = model
            captured['auth_mode'] = auth_mode
            captured['send_temperature'] = send_temperature

    monkeypatch.setattr('app.core.container.OpenAICompatibleLLMProvider', FakeProvider)

    settings = Settings(
        _env_file=None,
        llm_api_key='demo-key',
        llm_base_url='https://llm.example/v1',
        llm_model='demo-model',
        llm_auth_mode='api-key',
        llm_send_temperature=False,
    )

    provider = build_llm_provider(settings)

    assert isinstance(provider, FakeProvider)
    assert captured == {
        'base_url': 'https://llm.example/v1',
        'api_key': 'demo-key',
        'model': 'demo-model',
        'auth_mode': 'api-key',
        'send_temperature': False,
    }
