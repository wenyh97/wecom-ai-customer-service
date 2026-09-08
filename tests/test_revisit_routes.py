from __future__ import annotations

from fastapi.testclient import TestClient


def test_revisit_task_full_lifecycle(client: TestClient) -> None:
    create_resp = client.post(
        "/revisit/tasks",
        json={
            "customer_external_userid": "cust-1",
            "reason": "服务到期提醒",
            "planned_content": "您好，您的服务即将到期，是否需要续费？",
        },
    )
    assert create_resp.status_code == 200
    task = create_resp.json()
    assert task["status"] == "pending_review"
    task_id = task["task_id"]

    # 未审核时不能发送
    send_resp = client.post(f"/revisit/tasks/{task_id}/send")
    assert send_resp.status_code == 409

    review_resp = client.post(
        f"/revisit/tasks/{task_id}/review",
        json={"decision": "approve", "reviewer": "manager-1"},
    )
    assert review_resp.status_code == 200
    assert review_resp.json()["status"] == "approved"

    send_resp = client.post(f"/revisit/tasks/{task_id}/send")
    assert send_resp.status_code == 200
    assert send_resp.json()["status"] == "sent"


def test_revisit_task_list_filters_by_status(client: TestClient) -> None:
    client.post(
        "/revisit/tasks",
        json={
            "customer_external_userid": "cust-2",
            "reason": "节日祝福",
            "planned_content": "新年快乐！",
        },
    )
    resp = client.get("/revisit/tasks", params={"status": "pending_review"})
    assert resp.status_code == 200
    assert len(resp.json()) >= 1
    assert all(t["status"] == "pending_review" for t in resp.json())


def test_revisit_task_reject_then_cannot_send(client: TestClient) -> None:
    create_resp = client.post(
        "/revisit/tasks",
        json={
            "customer_external_userid": "cust-3",
            "reason": "测试",
            "planned_content": "测试内容",
        },
    )
    task_id = create_resp.json()["task_id"]
    client.post(
        f"/revisit/tasks/{task_id}/review",
        json={"decision": "reject", "reviewer": "manager-1"},
    )
    send_resp = client.post(f"/revisit/tasks/{task_id}/send")
    assert send_resp.status_code == 409
