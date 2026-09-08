from __future__ import annotations

import asyncio
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.container import build_container
from app.main import create_app


async def main() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime_dir = root / '.test-artifacts'
    runtime_dir.mkdir(exist_ok=True)
    db_path = runtime_dir / 'smoke.sqlite'
    if db_path.exists():
        db_path.unlink()

    database_url = f'sqlite+aiosqlite:///{db_path}'
    settings = Settings(
        _env_file=None,
        app_env='test',
        database_url=database_url,
        wecom_token='test-token',
        llm_api_key='',
        embedding_api_key='',
        handoff_confidence_threshold=0.1,
    )

    import os

    os.environ['DATABASE_URL'] = database_url
    cfg = Config(str(root / 'alembic.ini'))
    command.upgrade(cfg, 'head')

    container = build_container(settings)
    app = create_app(container=container)
    with TestClient(app) as client:
        assert client.get('/health').status_code == 200
        client.post('/kb/documents', json={'title': '退款政策', 'content': '退款将在7个工作日内到账。'})
        payload = {
            'customer_external_userid': 'cust-smoke',
            'staff_userid': 'staff-smoke',
            'content': '退款将在7个工作日内到账。',
            'idempotency_key': 'smoke-script-1',
        }
        first = client.post('/chat/messages', json=payload)
        second = client.post('/chat/messages', json=payload)
        assert first.status_code == 200
        assert first.json() == second.json()
        conversation_id = first.json()['conversation_id']
        assert client.post(
            f'/handoff/{conversation_id}/takeover',
            json={'operator': 'manager-1', 'reason': 'manual review'},
        ).status_code == 200
        task = client.post(
            '/revisit/tasks',
            json={
                'customer_external_userid': 'cust-smoke',
                'reason': '服务到期提醒',
                'planned_content': '您好，您的服务即将到期，是否需要续费？',
            },
        )
        task_id = task.json()['task_id']
        assert client.post(
            f'/revisit/tasks/{task_id}/review',
            json={'decision': 'approve', 'reviewer': 'manager-1'},
        ).status_code == 200
        assert client.post(f'/revisit/tasks/{task_id}/send').status_code == 200

    await container.close()
    print('smoke test ok')


if __name__ == '__main__':
    asyncio.run(main())
