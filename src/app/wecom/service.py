from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings
from app.core.logging import get_logger
from app.db.repository import UnitOfWorkFactory
from app.llm.provider import ChatMessage, LLMCallError, LLMProvider, LLMTimeoutError
from app.services.audit import AuditLogStore
from app.services.conversation import ConversationStore
from app.wecom.adapter import NormalizedEvent, WeComCallbackEvent, parse_kf_sync_message

_SYSTEM_PROMPT = (
    "你是企业微信“微信客服”Demo 的 AI 助手。"
    "请直接基于用户当前问题与最近对话上下文，用自然、简洁、专业的中文回复。"
    "不要提及知识库、RAG、内部实现或系统配置。"
)
_MISSING_LLM_REPLY = "当前演示环境尚未配置真实 AI（缺少 LLM_API_KEY），请联系现场工作人员完成配置。"
_LLM_ERROR_REPLY = "抱歉，当前 AI 服务暂时不可用，请稍后再试或联系人工客服。"


class WeComAPIError(RuntimeError):
    """企业微信 API 调用失败。"""


@dataclass(frozen=True)
class WeComSyncBatch:
    messages: list[NormalizedEvent]
    next_cursor: str | None


class WeComKfClient:
    def __init__(
        self,
        *,
        corp_id: str,
        secret: str,
        base_url: str,
        timeout: float,
    ) -> None:
        self._corp_id = corp_id
        self._secret = secret
        self._base_url = base_url.rstrip('/')
        self._timeout = timeout
        self._access_token = ''
        self._access_token_expires_at = 0.0
        self._token_lock = asyncio.Lock()

    async def get_access_token(self) -> str:
        if self._access_token and time.monotonic() < self._access_token_expires_at:
            return self._access_token

        async with self._token_lock:
            if self._access_token and time.monotonic() < self._access_token_expires_at:
                return self._access_token
            if not self._corp_id or not self._secret:
                raise WeComAPIError('wecom corp id or kf secret is not configured')

            data = await self._request_json(
                method='GET',
                path='/cgi-bin/gettoken',
                params={'corpid': self._corp_id, 'corpsecret': self._secret},
            )
            token = str(data.get('access_token') or '')
            expires_in = int(data.get('expires_in') or 0)
            if not token or expires_in <= 0:
                raise WeComAPIError('wecom access token response is invalid')
            self._access_token = token
            self._access_token_expires_at = time.monotonic() + max(0, expires_in - 300)
            return token

    async def sync_messages(
        self,
        *,
        token: str,
        cursor: str | None = None,
        limit: int = 100,
    ) -> WeComSyncBatch:
        payload: dict[str, Any] = {'token': token, 'limit': limit}
        if cursor:
            payload['cursor'] = cursor
        data = await self._request_with_token(
            method='POST',
            path='/cgi-bin/kf/sync_msg',
            json_body=payload,
        )
        raw_messages = data.get('msg_list') or []
        if not isinstance(raw_messages, list):
            raise WeComAPIError('wecom sync_msg response has invalid msg_list')
        messages = [message for item in raw_messages if (message := parse_kf_sync_message(item)) is not None]
        next_cursor = str(data.get('next_cursor') or '') or None
        return WeComSyncBatch(messages=messages, next_cursor=next_cursor)

    async def send_text_message(
        self,
        *,
        external_userid: str,
        open_kfid: str,
        content: str,
    ) -> None:
        await self._request_with_token(
            method='POST',
            path='/cgi-bin/kf/send_msg',
            json_body={
                'touser': external_userid,
                'open_kfid': open_kfid,
                'msgtype': 'text',
                'text': {'content': content},
            },
        )

    async def _request_with_token(
        self,
        *,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        access_token = await self.get_access_token()
        request_params = dict(params or {})
        request_params['access_token'] = access_token
        return await self._request_json(
            method=method,
            path=path,
            params=request_params,
            json_body=json_body,
        )

    async def _request_json(
        self,
        *,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout) as client:
                response = await client.request(method, path, params=params, json=json_body)
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise WeComAPIError('wecom api request timed out') from exc
        except httpx.HTTPStatusError as exc:
            raise WeComAPIError(
                f'wecom api request failed with status {exc.response.status_code}'
            ) from exc
        except httpx.HTTPError as exc:
            raise WeComAPIError('wecom api request failed') from exc

        try:
            data = response.json()
        except ValueError as exc:
            raise WeComAPIError('wecom api returned invalid json') from exc
        if not isinstance(data, dict):
            raise WeComAPIError('wecom api returned invalid payload type')
        errcode = int(data.get('errcode') or 0)
        if errcode != 0:
            raise WeComAPIError(f'wecom api {path} failed with errcode {errcode}')
        return data


class WeComKFDemoService:
    def __init__(
        self,
        *,
        settings: Settings,
        llm_provider: LLMProvider,
        uow_factory: UnitOfWorkFactory,
        conversation_store: ConversationStore,
        audit_log: AuditLogStore,
    ) -> None:
        self._settings = settings
        self._llm_provider = llm_provider
        self._uow_factory = uow_factory
        self._conversation_store = conversation_store
        self._audit_log = audit_log
        self._logger = get_logger(component='wecom_kf')
        self._client = WeComKfClient(
            corp_id=settings.wecom_corp_id,
            secret=settings.wecom_kf_secret,
            base_url=settings.wecom_api_base_url,
            timeout=settings.wecom_http_timeout_seconds,
        )

    async def handle_callback_event(self, event: WeComCallbackEvent, correlation_id: str) -> None:
        if event.event != 'kf_msg_or_event':
            self._logger.info(
                'ignored wecom callback event',
                correlation_id=correlation_id,
                callback_event=event.event,
            )
            return

        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            try:
                batch = await self._client.sync_messages(token=event.token, cursor=cursor)
            except Exception:
                self._logger.exception(
                    'failed to sync wecom messages',
                    correlation_id=correlation_id,
                    callback_event=event.event,
                )
                return
            self._logger.info(
                'synced wecom messages',
                correlation_id=correlation_id,
                callback_event=event.event,
                message_count=len(batch.messages),
                has_next_cursor=batch.next_cursor is not None,
            )
            for message in batch.messages:
                try:
                    await self._process_message(message, correlation_id)
                except Exception:
                    self._logger.exception(
                        'failed to process wecom message',
                        correlation_id=correlation_id,
                        msgid=message.msg_id,
                        open_kfid=message.to_staff_userid,
                    )
            if not batch.next_cursor or batch.next_cursor in seen_cursors:
                return
            seen_cursors.add(batch.next_cursor)
            cursor = batch.next_cursor

    async def _process_message(self, message: NormalizedEvent, correlation_id: str) -> None:
        async with self._uow_factory() as uow:
            tenant = await uow.tenants.get_or_create(
                self._settings.default_tenant_slug, self._settings.default_tenant_name
            )
            idempotency_key = f'wecom:kf:msg:{message.msg_id}'
            if not await uow.idempotency.reserve(tenant_id=tenant.id, key=idempotency_key):
                self._logger.info(
                    'skipped duplicate wecom message',
                    correlation_id=correlation_id,
                    msgid=message.msg_id,
                )
                return

            conversation = await self._conversation_store.get_or_create(
                uow,
                message.from_external_userid,
                message.to_staff_userid,
            )
            await self._conversation_store.append_message(
                uow,
                conversation_id=conversation.conversation_id,
                role='customer',
                content=message.content,
                message_type=message.msg_type,
                external_message_id=message.msg_id,
            )
            history = await self._conversation_store.list_recent_messages(
                uow, conversation.conversation_id, limit=10
            )
            reply, reply_mode = await self._generate_reply(history)
            await self._client.send_text_message(
                external_userid=message.from_external_userid,
                open_kfid=message.to_staff_userid,
                content=reply,
            )
            await self._conversation_store.append_message(
                uow,
                conversation_id=conversation.conversation_id,
                role='assistant',
                content=reply,
                is_ai_generated=reply_mode == 'llm',
            )
            await self._audit_log.record(
                uow,
                conversation_id=conversation.conversation_id,
                handoff_required=False,
                confidence=1.0 if reply_mode == 'llm' else 0.0,
                citations=[],
                raw_input=message.content,
                correlation_id=correlation_id,
                payload={
                    'channel': 'wecom_kf',
                    'msgid': message.msg_id,
                    'reply_mode': reply_mode,
                },
                event_type='wecom_kf_message',
            )
            await uow.idempotency.set(
                tenant_id=tenant.id,
                key=idempotency_key,
                response_payload={
                    'conversation_id': conversation.conversation_id,
                    'reply_mode': reply_mode,
                },
            )
            await uow.commit()

    async def _generate_reply(self, history: list[Any]) -> tuple[str, str]:
        if not self._settings.llm_api_key:
            return _MISSING_LLM_REPLY, 'missing_llm_api_key'

        messages = [ChatMessage(role='system', content=_SYSTEM_PROMPT)]
        for item in history[-10:]:
            messages.append(
                ChatMessage(
                    role='assistant' if item.role == 'assistant' else 'user',
                    content=item.content,
                )
            )
        try:
            response = await self._llm_provider.generate(
                messages,
                timeout=self._settings.llm_timeout_seconds,
            )
        except (LLMTimeoutError, LLMCallError):
            return _LLM_ERROR_REPLY, 'llm_error'
        reply = response.content.strip()
        if not reply:
            return _LLM_ERROR_REPLY, 'llm_error'
        return reply, 'llm'
