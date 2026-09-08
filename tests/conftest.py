"""共享测试 fixture。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.container import build_container
from app.main import create_app


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        llm_api_key="",
        embedding_api_key="",
        wecom_token="test-token",
        wecom_aes_key="",
        handoff_confidence_threshold=0.1,
    )


@pytest.fixture
def client(settings: Settings) -> TestClient:
    app = create_app()
    app.state.container = build_container(settings)
    return TestClient(app)
