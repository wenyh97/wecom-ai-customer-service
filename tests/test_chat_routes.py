from __future__ import annotations

from fastapi.testclient import TestClient


def test_chat_sensitive_keyword_triggers_handoff(client: TestClient) -> None:
    resp = client.post(
        "/chat/messages",
        json={
            "customer_external_userid": "cust-1",
            "staff_userid": "staff-1",
            "content": "我要投诉，这个太差了",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handoff_required"] is True
    assert body["reply"] is None


def test_chat_no_knowledge_returns_handoff(client: TestClient) -> None:
    resp = client.post(
        "/chat/messages",
        json={
            "customer_external_userid": "cust-2",
            "staff_userid": "staff-1",
            "content": "你好",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handoff_required"] is True
    assert body["confidence"] == 0.0


def test_chat_answers_with_citation_when_kb_matches(client: TestClient) -> None:
    content = "退款将在7个工作日内到账。"
    client.post("/kb/documents", json={"title": "退款政策", "content": content})

    resp = client.post(
        "/chat/messages",
        json={
            "customer_external_userid": "cust-3",
            "staff_userid": "staff-1",
            "content": content,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["handoff_required"] is False
    assert body["reply"] is not None
    assert len(body["citations"]) >= 1


def test_chat_idempotency_key_prevents_duplicate_processing(client: TestClient) -> None:
    payload = {
        "customer_external_userid": "cust-4",
        "staff_userid": "staff-1",
        "content": "你好",
        "idempotency_key": "msg-idempotent-1",
    }
    first = client.post("/chat/messages", json=payload)
    second = client.post("/chat/messages", json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()

    audit_resp = client.get(
        "/eval/audit-logs",
        params={"conversation_id": first.json()["conversation_id"]},
    )
    assert audit_resp.status_code == 200
    # 幂等命中应只产生一条审计记录，而不是两条
    assert len(audit_resp.json()["items"]) == 1


def test_handoff_takeover_blocks_ai_auto_reply(client: TestClient) -> None:
    content = "退款流程是什么？"
    client.post("/kb/documents", json={"title": "退款流程", "content": content})

    first = client.post(
        "/chat/messages",
        json={
            "customer_external_userid": "cust-5",
            "staff_userid": "staff-1",
            "content": content,
        },
    )
    conversation_id = first.json()["conversation_id"]
    assert first.json()["handoff_required"] is False

    takeover_resp = client.post(
        f"/handoff/{conversation_id}/takeover",
        json={"operator": "human-1", "reason": "customer requested"},
    )
    assert takeover_resp.status_code == 200
    assert takeover_resp.json()["active"] is True

    second = client.post(
        "/chat/messages",
        json={
            "customer_external_userid": "cust-5",
            "staff_userid": "staff-1",
            "content": content,
        },
    )
    assert second.json()["handoff_required"] is True
    assert second.json()["reply"] is None

    release_resp = client.post(f"/handoff/{conversation_id}/release")
    assert release_resp.status_code == 200
    assert release_resp.json()["active"] is False
