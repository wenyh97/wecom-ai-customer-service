# 企业微信客户 AI 客服与回访助手

企业微信员工已添加客户个人微信后，为客户咨询提供 AI 自动回复（RAG 知识库问答），
并支持受控的人工/自动回访。本仓库当前处于 **第一阶段：需求、架构与可运行骨架**，
严格按 [Spec Kit](https://github.com/github/spec-kit) 的规格驱动方式推进。

> 历史内容：本仓库此前包含一份 Hermes Agent 远程部署指南，与当前项目无关，
> 已保留在 [`docs/legacy/hermes-remote-deployment.md`](docs/legacy/hermes-remote-deployment.md)，不再维护。

## 明确不做（Non-goals）

- **不接入微信个人号协议机器人**（不使用 Wechaty/Hook/协议号等灰色方案）。
- **不使用 Dify** 或其他一体化 AI 平台。
- 不做加好友、拉群等主动扩列（由人工完成）。
- 第一阶段不做企业微信官方生产级联调，仅提供验签/解密/消息规范化的**接口与占位实现**。

详见 [specs/spec.md](specs/spec.md) 的范围/非范围说明。

## Spec Kit 工作方式

本项目按照 Spec Kit 的文档层级推进，四个核心文档位于 `specs/` 目录：

| 文档 | 作用 |
|---|---|
| [`specs/constitution.md`](specs/constitution.md) | 项目不可轻易违反的基本原则（做什么/不做什么的红线） |
| [`specs/spec.md`](specs/spec.md) | 需求规格：角色、用例、范围/非范围、验收标准、风险与待确认项 |
| [`specs/plan.md`](specs/plan.md) | 技术方案：选型对比、模块划分、演进路线 |
| [`specs/tasks.md`](specs/tasks.md) | 可执行任务拆解与状态追踪 |

**继续推进的建议流程**：

1. 先修改/评审 `specs/constitution.md`（原则是否需要调整）；
2. 再修改 `specs/spec.md`（需求/范围变化）；
3. 再修改 `specs/plan.md`（技术方案变化，需说明选型对比与理由）；
4. 最后拆解/更新 `specs/tasks.md`，逐项实现并勾选完成；
5. 每次实现需同步更新 `docs/` 下的相关设计文档。

补充设计文档（`docs/` 目录）：

- [`docs/requirements.md`](docs/requirements.md) — 需求详情与可测试化验收标准
- [`docs/architecture.md`](docs/architecture.md) — 架构、模块划分、关键设计决策
- [`docs/api-contract.md`](docs/api-contract.md) — 接口草案（含待确认的企业微信官方限制标注）
- [`docs/rag-agent.md`](docs/rag-agent.md) — RAG/Agent 核心链路
- [`docs/observability-evaluation.md`](docs/observability-evaluation.md) — 日志/可观测性/评测方案
- [`docs/deployment.md`](docs/deployment.md) — 部署说明
- [`docs/acceptance.md`](docs/acceptance.md) — 验收清单与测试策略
- [`docs/brainstorming.md`](docs/brainstorming.md) — 待决策清单

## 技术栈（第一阶段）

FastAPI + Pydantic + structlog；LLM/Embedding 通过 OpenAI-compatible 接口配置，
默认使用内置的确定性假实现（`FakeLLMProvider` / `HashEmbeddingProvider`）以便
无网络环境下开发测试。检索使用内存实现，PostgreSQL + pgvector / Redis 已在
`docker-compose.yml` 中规划，真实落库留待下一阶段。完整选型对比见
[specs/plan.md](specs/plan.md)。

## 快速开始

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env

uvicorn app.main:app --reload --app-dir src
```

验证：

```bash
curl http://127.0.0.1:8000/health
```

打开 `http://127.0.0.1:8000/docs` 查看自动生成的 OpenAPI 文档。

## 运行测试

```bash
pip install -e ".[dev]"
pytest
ruff check src tests
```

## Docker Compose

```bash
docker compose up --build
```

详见 [docs/deployment.md](docs/deployment.md)。

## 项目结构

```text
specs/                  # Spec Kit：constitution / spec / plan / tasks
docs/                   # 详细设计文档
docs/legacy/            # 历史遗留内容（与当前项目无关）
src/app/
├── main.py             # FastAPI 入口
├── core/               # 配置、日志、错误处理、依赖容器
├── wecom/              # 企业微信适配器（验签/解密/消息规范化占位）
├── llm/                # LLM Provider 抽象
├── rag/                # Embedding/Retriever 抽象与切分工具
├── services/           # 会话、AI 编排、知识库、回访、人工接管、审计、评测
├── schemas/            # Pydantic 请求/响应模型
└── api/routes/         # health / wecom / chat / kb / revisit / handoff / eval
tests/                  # pytest 单元与集成测试
Dockerfile / docker-compose.yml / .env.example
```

## 已知限制

见 [docs/acceptance.md](docs/acceptance.md) “已知限制”一节：当前所有数据存储为
内存实现，企业微信验签/解密为占位实现，尚未接入真实 PostgreSQL/pgvector 和
Celery/Arq 任务队列。这些均计划在后续按 `specs/tasks.md` 的“下阶段任务预告”推进。
