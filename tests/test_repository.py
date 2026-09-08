from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_repository_backed_chat_flow_persists_records(container) -> None:
    async with container.uow_factory() as uow:
        document = await container.knowledge_base.upload_document(
            uow,
            title='退款政策',
            content='退款将在7个工作日内到账。',
            metadata={'channel': 'faq'},
        )
        await uow.commit()

    async with container.uow_factory() as uow:
        conversation = await container.conversation_store.get_or_create(uow, 'cust-r1', 'staff-r1')
        await container.conversation_store.append_message(
            uow,
            conversation_id=conversation.conversation_id,
            role='customer',
            content='退款将在7个工作日内到账。',
        )
        result = await container.ai_orchestrator.handle_message('退款将在7个工作日内到账。')
        await container.conversation_store.append_message(
            uow,
            conversation_id=conversation.conversation_id,
            role='assistant',
            content=result.reply or '',
            is_ai_generated=True,
        )
        await container.audit_log.record(
            uow,
            conversation_id=conversation.conversation_id,
            raw_input='退款将在7个工作日内到账。',
            confidence=result.confidence,
            handoff_required=result.handoff_required,
            citations=[citation.source_id for citation in result.citations],
        )
        await uow.commit()

    async with container.uow_factory() as uow:
        messages = await uow.messages.list_recent(conversation.conversation_id)
        assert document.document_id
        assert len(messages) == 2
        assert messages[-1].is_ai_generated is True
        audit_logs = await container.audit_log.query(uow, conversation_id=conversation.conversation_id)
        assert len(audit_logs) == 1
        assert audit_logs[0].handoff_required is False
