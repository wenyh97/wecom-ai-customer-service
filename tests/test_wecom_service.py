from __future__ import annotations

import httpx
import pytest

from app.core.config import Settings
from app.core.container import Container, build_container
from app.db.base import Base
from app.wecom.adapter import NormalizedEvent, WeComCallbackEvent
from app.wecom.service import WeComAPIError, WeComKfClient, WeComSyncBatch


async def _create_schema(container: Container) -> None:
    async with container.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


def _build_settings(**overrides) -> Settings:
    defaults = dict(
        _env_file=None,
        app_env="test",
        database_url="sqlite+aiosqlite:///:memory:",
        llm_base_url="https://llm.example/v1",
        llm_api_key="",
        embedding_api_key="",
        wecom_token="test-token",
        wecom_kf_secret="test-kf-secret",
        wecom_encoding_aes_key="abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        wecom_receive_id="ww-test-corp",
        wecom_corp_id="ww-test-corp",
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.mark.asyncio
async def test_wecom_service_deduplicates_messages(container: Container, monkeypatch) -> None:
    message = NormalizedEvent(
        msg_id="msg-1",
        from_external_userid="external-1",
        to_staff_userid="kf-1",
        msg_type="text",
        content="你好",
        timestamp=1700000001,
    )
    batches = [
        WeComSyncBatch(messages=[message], next_cursor=None),
        WeComSyncBatch(messages=[message], next_cursor=None),
    ]
    sent_payloads: list[dict[str, str]] = []

    async def fake_sync_messages(*, token: str, cursor: str | None = None, limit: int = 100):
        return batches.pop(0)

    async def fake_send_text_message(*, external_userid: str, open_kfid: str, content: str) -> None:
        sent_payloads.append(
            {
                "external_userid": external_userid,
                "open_kfid": open_kfid,
                "content": content,
            }
        )

    monkeypatch.setattr(container.wecom_kf_service._client, "sync_messages", fake_sync_messages)
    monkeypatch.setattr(container.wecom_kf_service._client, "send_text_message", fake_send_text_message)

    event = WeComCallbackEvent(event="kf_msg_or_event", token="sync-token-1", raw_payload={})
    await container.wecom_kf_service.handle_callback_event(event, "corr-1")
    await container.wecom_kf_service.handle_callback_event(event, "corr-2")

    assert len(sent_payloads) == 1
    assert "未配置真实 AI" in sent_payloads[0]["content"]

    async with container.uow_factory() as uow:
        conversation = await container.conversation_store.get_or_create(uow, "external-1", "kf-1")
        messages = await container.conversation_store.list_recent_messages(uow, conversation.conversation_id)
        audits = await container.audit_log.query(uow, conversation.conversation_id)
        assert len(messages) == 2
        assert len(audits) == 1


@pytest.mark.asyncio
async def test_wecom_service_uses_llm_and_fallback(monkeypatch) -> None:
    llm_responses = iter(
        [
            {"choices": [{"message": {"content": "您好，这里是 AI 客服。"}}], "usage": {"total_tokens": 10}},
        ]
    )

    class FakeLLMClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def post(self, url: str, json: dict, headers: dict) -> httpx.Response:
            request = httpx.Request("POST", url)
            return httpx.Response(200, json=next(llm_responses), request=request)

    monkeypatch.setattr("app.llm.provider.httpx.AsyncClient", FakeLLMClient)

    settings = _build_settings(llm_api_key="real-key")
    configured = build_container(settings)
    await _create_schema(configured)

    message = NormalizedEvent(
        msg_id="msg-2",
        from_external_userid="external-2",
        to_staff_userid="kf-2",
        msg_type="text",
        content="请介绍一下你们的产品",
        timestamp=1700000002,
    )
    sent_payloads: list[str] = []

    async def fake_sync_messages(*, token: str, cursor: str | None = None, limit: int = 100):
        return WeComSyncBatch(messages=[message], next_cursor=None)

    async def fake_send_text_message(*, external_userid: str, open_kfid: str, content: str) -> None:
        sent_payloads.append(content)

    monkeypatch.setattr(configured.wecom_kf_service._client, "sync_messages", fake_sync_messages)
    monkeypatch.setattr(configured.wecom_kf_service._client, "send_text_message", fake_send_text_message)

    await configured.wecom_kf_service.handle_callback_event(
        WeComCallbackEvent(event="kf_msg_or_event", token="sync-token-2", raw_payload={}),
        "corr-3",
    )
    assert sent_payloads == ["您好，这里是 AI 客服。"]
    await configured.close()

    class TimeoutLLMClient(FakeLLMClient):
        async def post(self, url: str, json: dict, headers: dict) -> httpx.Response:
            raise httpx.TimeoutException("boom")

    monkeypatch.setattr("app.llm.provider.httpx.AsyncClient", TimeoutLLMClient)

    failing = build_container(_build_settings(llm_api_key="real-key"))
    await _create_schema(failing)
    fallback_payloads: list[str] = []

    monkeypatch.setattr(failing.wecom_kf_service._client, "sync_messages", fake_sync_messages)

    async def fake_fallback_send(*, external_userid: str, open_kfid: str, content: str) -> None:
        fallback_payloads.append(content)

    monkeypatch.setattr(failing.wecom_kf_service._client, "send_text_message", fake_fallback_send)
    await failing.wecom_kf_service.handle_callback_event(
        WeComCallbackEvent(event="kf_msg_or_event", token="sync-token-3", raw_payload={}),
        "corr-4",
    )
    assert fallback_payloads == ["抱歉，当前 AI 服务暂时不可用，请稍后再试或联系人工客服。"]
    await failing.close()


@pytest.mark.asyncio
async def test_wecom_service_swallows_sync_errors(container: Container, monkeypatch) -> None:
    async def fake_sync_messages(*, token: str, cursor: str | None = None, limit: int = 100):
        raise WeComAPIError("boom")

    monkeypatch.setattr(container.wecom_kf_service._client, "sync_messages", fake_sync_messages)
    await container.wecom_kf_service.handle_callback_event(
        WeComCallbackEvent(event="kf_msg_or_event", token="sync-token-4", raw_payload={}),
        "corr-5",
    )


@pytest.mark.asyncio
async def test_wecom_client_caches_access_token_and_sends_expected_payload(monkeypatch) -> None:
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def request(self, method: str, path: str, params=None, json=None) -> httpx.Response:
            calls.append({"method": method, "path": path, "params": params, "json": json})
            request = httpx.Request(method, f"https://qyapi.weixin.qq.com{path}")
            if path == "/cgi-bin/gettoken":
                return httpx.Response(
                    200,
                    json={"errcode": 0, "access_token": "token-1", "expires_in": 7200},
                    request=request,
                )
            return httpx.Response(200, json={"errcode": 0, "errmsg": "ok"}, request=request)

    monkeypatch.setattr("app.wecom.service.httpx.AsyncClient", FakeClient)

    client = WeComKfClient(
        corp_id="ww-test-corp",
        secret="test-kf-secret",
        base_url="https://qyapi.weixin.qq.com",
        timeout=10,
    )
    await client.send_text_message(
        external_userid="external-1",
        open_kfid="kf-1",
        content="hello",
    )
    await client.send_text_message(
        external_userid="external-1",
        open_kfid="kf-1",
        content="hello again",
    )

    assert [call["path"] for call in calls] == [
        "/cgi-bin/gettoken",
        "/cgi-bin/kf/send_msg",
        "/cgi-bin/kf/send_msg",
    ]
    assert calls[1]["params"]["access_token"] == "token-1"
    assert calls[1]["json"] == {
        "touser": "external-1",
        "open_kfid": "kf-1",
        "msgtype": "text",
        "text": {"content": "hello"},
    }


@pytest.mark.asyncio
async def test_wecom_client_sync_messages_filters_non_text(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb) -> None:
            return None

        async def request(self, method: str, path: str, params=None, json=None) -> httpx.Response:
            request = httpx.Request(method, f"https://qyapi.weixin.qq.com{path}")
            if path == "/cgi-bin/gettoken":
                return httpx.Response(
                    200,
                    json={"errcode": 0, "access_token": "token-1", "expires_in": 7200},
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "errcode": 0,
                    "next_cursor": "cursor-2",
                    "msg_list": [
                        {
                            "msgid": "msg-1",
                            "open_kfid": "kf-1",
                            "external_userid": "external-1",
                            "send_time": 1700000001,
                            "origin": 3,
                            "msgtype": "text",
                            "text": {"content": "hello"},
                        },
                        {"msgtype": "image", "origin": 3},
                        {"msgtype": "text", "origin": 4},
                    ],
                },
                request=request,
            )

    monkeypatch.setattr("app.wecom.service.httpx.AsyncClient", FakeClient)

    client = WeComKfClient(
        corp_id="ww-test-corp",
        secret="test-kf-secret",
        base_url="https://qyapi.weixin.qq.com",
        timeout=10,
    )
    batch = await client.sync_messages(token="sync-token-1")
    assert batch.next_cursor == "cursor-2"
    assert [item.msg_id for item in batch.messages] == ["msg-1"]
