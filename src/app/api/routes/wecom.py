"""/wecom/callback 路由：企业微信回调验签/解密/事件入口（占位实现）。

见 docs/api-contract.md §2 与 src/app/wecom/adapter.py 顶部声明：
本模块提供可测试的占位实现，真实生产对接前需要对照企业微信官方文档确认细节
（TODO(confirm-with-wecom-docs)）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import get_container
from app.core.container import Container
from app.core.errors import AppError
from app.wecom.adapter import WeComCrypto, WeComSignatureVerifier

router = APIRouter(prefix="/wecom", tags=["wecom"])


@router.get("/callback")
async def verify_callback(
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    echostr: str = Query(...),
    container: Container = Depends(get_container),
) -> Response:
    verifier = WeComSignatureVerifier(token=container.settings.wecom_token)
    if not verifier.verify(msg_signature, timestamp, nonce, echostr):
        raise AppError("invalid_signature", "signature verification failed", 403)

    crypto = WeComCrypto(aes_key=container.settings.wecom_aes_key)
    decrypted = crypto.decrypt(echostr)
    return Response(content=decrypted, media_type="text/plain")


@router.post("/callback")
async def receive_callback(
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    container: Container = Depends(get_container),
) -> dict:
    # 真实事件体的验签/解密/规范化流程占位：具体请求体格式与解密算法需要在真实
    # 联调时对照企业微信官方文档确认（TODO(confirm-with-wecom-docs)）。
    # 当前仅返回确认响应，供本地开发验证路由可达性。
    return {"status": "accepted"}
