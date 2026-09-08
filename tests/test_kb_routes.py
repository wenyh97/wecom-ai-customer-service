from __future__ import annotations

from fastapi.testclient import TestClient


def test_kb_upload_then_search(client: TestClient) -> None:
    upload_resp = client.post(
        "/kb/documents",
        json={"title": "退款政策", "content": "客户申请退款后，7个工作日内到账。"},
    )
    assert upload_resp.status_code == 200
    body = upload_resp.json()
    assert body["chunk_count"] >= 1
    document_id = body["document_id"]

    get_resp = client.get(f"/kb/documents/{document_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["title"] == "退款政策"

    search_resp = client.post(
        "/kb/search", json={"query": "客户申请退款后，7个工作日内到账。", "top_k": 1}
    )
    assert search_resp.status_code == 200
    results = search_resp.json()["results"]
    assert len(results) == 1
    assert results[0]["document_id"] == document_id


def test_kb_get_document_not_found(client: TestClient) -> None:
    resp = client.get("/kb/documents/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    assert body["error"]["code"] == "not_found"
    assert "correlation_id" in body["error"]
