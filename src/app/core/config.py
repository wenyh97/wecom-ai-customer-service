"""应用配置模型（Pydantic Settings）。

所有配置从环境变量 / `.env` 文件读取，敏感值（API Key、企业微信密钥）
不应该有非空默认值以外的硬编码；仅测试/开发默认值允许安全的占位符。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用运行时配置。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    app_env: Literal["development", "test", "production"] = Field(
        default="development", alias="APP_ENV"
    )
    app_name: str = Field(default="wecom-ai-assistant", alias="APP_NAME")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    version: str = Field(default="0.1.0", alias="APP_VERSION")

    database_url: str = Field(
        default="postgresql+psycopg://localhost:5432/wecom_ai",
        alias="DATABASE_URL",
        description="生产环境必须通过环境变量覆盖，包含真实凭证的连接串不得提交仓库",
    )
    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")

    # LLM（OpenAI-compatible）
    llm_base_url: str = Field(default="https://api.openai.com/v1", alias="LLM_BASE_URL")
    llm_api_key: str = Field(default="", alias="LLM_API_KEY")
    llm_model: str = Field(default="gpt-4o-mini", alias="LLM_MODEL")
    llm_timeout_seconds: float = Field(default=15.0, alias="LLM_TIMEOUT_SECONDS")

    # Embedding（OpenAI-compatible）
    embedding_base_url: str = Field(
        default="https://api.openai.com/v1", alias="EMBEDDING_BASE_URL"
    )
    embedding_api_key: str = Field(default="", alias="EMBEDDING_API_KEY")
    embedding_model: str = Field(default="text-embedding-3-small", alias="EMBEDDING_MODEL")

    # 企业微信（占位，真实凭证不得提交仓库）
    wecom_corp_id: str = Field(default="", alias="WECOM_CORP_ID")
    wecom_secret: str = Field(default="", alias="WECOM_SECRET")
    wecom_token: str = Field(default="", alias="WECOM_TOKEN")
    wecom_aes_key: str = Field(default="", alias="WECOM_AES_KEY")

    # RAG / AI 行为
    handoff_confidence_threshold: float = Field(
        default=0.35, alias="HANDOFF_CONFIDENCE_THRESHOLD"
    )
    sensitive_keywords: str = Field(
        default="退款纠纷,投诉,起诉,律师", alias="SENSITIVE_KEYWORDS"
    )
    retrieval_top_k: int = Field(default=5, alias="RETRIEVAL_TOP_K")

    # 回访任务
    revisit_auto_send_enabled: bool = Field(
        default=False, alias="REVISIT_AUTO_SEND_ENABLED"
    )

    @property
    def sensitive_keyword_list(self) -> list[str]:
        return [kw.strip() for kw in self.sensitive_keywords.split(",") if kw.strip()]


@lru_cache
def get_settings() -> Settings:
    """返回缓存的 Settings 单例，便于 FastAPI 依赖注入。"""

    return Settings()
