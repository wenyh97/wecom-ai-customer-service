"""结构化日志配置。

使用 `structlog` 输出 JSON 格式日志，字段约定见 docs/observability-evaluation.md。
默认对已知的隐私字段做脱敏处理，调用方应尽量传入已脱敏的摘要而非原文。
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

import structlog

_PHONE_RE = re.compile(r"1[3-9]\d{9}")
_ID_CARD_RE = re.compile(r"\d{17}[\dXx]")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def redact_sensitive(text: str) -> str:
    """对常见隐私模式（手机号/身份证号/邮箱）做占位替换。

    这是一个尽力而为的脱敏工具，不能替代真正的数据分类与授权控制，
    仅用于降低日志中意外泄露客户隐私的风险。
    """

    text = _ID_CARD_RE.sub("[REDACTED_ID]", text)
    text = _PHONE_RE.sub("[REDACTED_PHONE]", text)
    text = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    return text


def _redact_processor(
    _logger: Any, _method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    for key in ("content", "message", "input_summary", "query"):
        value = event_dict.get(key)
        if isinstance(value, str):
            event_dict[key] = redact_sensitive(value)
    return event_dict


def configure_logging(log_level: str = "INFO") -> None:
    """初始化标准库 logging 与 structlog，供应用启动时调用一次。"""

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level.upper(), logging.INFO),
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redact_processor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level.upper(), logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(**initial_values: Any) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(**initial_values)
