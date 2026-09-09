"""LLM Provider 抽象与实现。

`LLMProvider` 是一个 `Protocol`，任何满足接口的实现都可以被应用服务层使用，
便于在测试环境使用 `FakeLLMProvider`，在生产环境使用指向 OpenAI-compatible
服务的实现，而不需要修改上层业务代码。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

import httpx

LLMAuthMode = Literal['bearer', 'api-key']


@dataclass(frozen=True)
class ChatMessage:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass(frozen=True)
class LLMResponse:
    content: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)


@runtime_checkable
class LLMProvider(Protocol):
    """LLM 供应商抽象接口。"""

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        timeout: float = 15.0,
    ) -> LLMResponse:
        """生成一次对话回复，实现需自行处理超时和错误转换。"""
        ...


class LLMTimeoutError(RuntimeError):
    """LLM 调用超时。"""


class LLMCallError(RuntimeError):
    """LLM 调用发生非超时错误。"""


class FakeLLMProvider:
    """用于测试/离线开发的假实现：基于简单规则拼接检索片段生成回答。

    不依赖任何网络调用，保证单元测试可在无外网环境运行。
    """

    def __init__(self, model: str = "fake-model") -> None:
        self.model = model

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        timeout: float = 15.0,
    ) -> LLMResponse:
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"), ""
        )
        reply = f"[fake-llm] 已收到问题：{last_user[:50]}"
        return LLMResponse(content=reply, model=self.model, usage={"total_tokens": len(reply)})


class OpenAICompatibleLLMProvider:
    """指向任意 OpenAI-compatible `/chat/completions` 服务的实现。

    可用于 OpenAI 官方、DeepSeek、通义千问兼容模式、自托管 vLLM/Ollama 网关等。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        auth_mode: LLMAuthMode = 'bearer',
        send_temperature: bool = True,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._auth_mode = auth_mode
        self._send_temperature = send_temperature

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        timeout: float = 15.0,
    ) -> LLMResponse:
        payload = {
            "model": self._model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if self._send_temperature:
            payload["temperature"] = temperature
        headers = (
            {'api-key': self._api_key}
            if self._auth_mode == 'api-key'
            else {'Authorization': 'Bearer ' + self._api_key}
        )
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{self._base_url}/chat/completions",
                    json=payload,
                    headers=headers,
                )
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise LLMTimeoutError("llm call timed out") from exc
        except httpx.HTTPError as exc:
            raise LLMCallError('llm call failed') from exc

        data = response.json()
        choice = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        return LLMResponse(content=choice, model=self._model, usage=usage)
