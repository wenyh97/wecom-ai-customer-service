from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_phase1_smoke_chain(client, container) -> None:
    health = client.get('/health')
    assert health.status_code == 200
    assert health.json()['dependencies']['database'] == 'ok'

    upload = client.post(
        '/kb/documents',
        json={'title': '回款政策', 'content': '回款将在7个工作日内到账。'},
    )
    assert upload.status_code == 200

    payload = {
        'customer_external_userid': 'cust-smoke',
        'staff_userid': 'staff-smoke',
        'content': '回款将在7个工作日内到账。',
        'idempotency_key': 'smoke-idem-1',
    }
    first = client.post('/chat/messages', json=payload)
    second = client.post('/chat/messages', json=payload)
    assert first.status_code == 200
    assert second.json() == first.json()
    conversation_id = first.json()['conversation_id']

    takeover = client.post(
        f'/handoff/{conversation_id}/takeover',
        json={'operator': 'manager-smoke', 'reason': 'manual review'},
    )
    assert takeover.status_code == 200
    assert takeover.json()['active'] is True

    plan = client.post(
        '/revisit/plans',
        json={
            'customer_external_userid': 'cust-smoke',
            'name': '到期回访',
            'reason': '服务即将到期',
            'schedule_rule': 'manual',
        },
    )
    assert plan.status_code == 200

    task = client.post(
        '/revisit/tasks',
        json={
            'customer_external_userid': 'cust-smoke',
            'reason': '服务即将到期',
            'planned_content': '您好，服务即将到期，是否需要续费？',
        },
    )
    assert task.status_code == 200
    task_id = task.json()['task_id']
    review = client.post(
        f'/revisit/tasks/{task_id}/review',
        json={'decision': 'approve', 'reviewer': 'manager-smoke'},
    )
    assert review.status_code == 200
    sent = client.post(f'/revisit/tasks/{task_id}/send')
    assert sent.status_code == 200
    assert sent.json()['status'] == 'sent'

    async with container.uow_factory() as uow:
        messages = await uow.messages.list_recent(conversation_id)
        assert len(messages) == 2
        handoff = await container.handoffs.get(uow, conversation_id)
        assert handoff.active is True
        audit_items = await container.audit_log.query(uow, conversation_id=conversation_id)
        assert len(audit_items) == 2
