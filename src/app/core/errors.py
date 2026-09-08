"""统一错误响应模型与异常处理器。"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorDetail(BaseModel):
    code: str
    message: str
    correlation_id: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


class AppError(Exception):
    """应用内业务异常的基类，携带错误码和 HTTP 状态码。"""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = status.HTTP_400_BAD_REQUEST,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class NotFoundError(AppError):
    def __init__(self, message: str = "resource not found") -> None:
        super().__init__("not_found", message, status.HTTP_404_NOT_FOUND)


class ConflictError(AppError):
    def __init__(self, message: str = "conflict") -> None:
        super().__init__("conflict", message, status.HTTP_409_CONFLICT)


class UpstreamTimeoutError(AppError):
    def __init__(self, message: str = "upstream call timed out") -> None:
        super().__init__("upstream_timeout", message, status.HTTP_504_GATEWAY_TIMEOUT)


def _correlation_id(request: Request) -> str:
    header_value = request.headers.get("X-Correlation-Id")
    return header_value or str(uuid.uuid4())


def _error_body(code: str, message: str, correlation_id: str) -> dict[str, Any]:
    return ErrorResponse(
        error=ErrorDetail(code=code, message=message, correlation_id=correlation_id)
    ).model_dump()


def register_exception_handlers(app: FastAPI) -> None:
    """注册统一的异常处理器，确保所有错误响应遵循同一 JSON 结构。"""

    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        correlation_id = _correlation_id(request)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.code, exc.message, correlation_id),
            headers={"X-Correlation-Id": correlation_id},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        correlation_id = _correlation_id(request)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_error_body("validation_error", str(exc.errors()), correlation_id),
            headers={"X-Correlation-Id": correlation_id},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        correlation_id = _correlation_id(request)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_body("internal_error", "internal server error", correlation_id),
            headers={"X-Correlation-Id": correlation_id},
        )
