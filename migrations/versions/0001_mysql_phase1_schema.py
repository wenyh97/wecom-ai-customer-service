"""initial mysql phase1 schema

Revision ID: 0001_mysql_phase1
Revises: None
Create Date: 2026-09-08 00:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0001_mysql_phase1'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'tenants',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('slug', sa.String(length=128), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('timezone', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint('slug', name='uq_tenants_slug'),
    )
    op.create_index('ix_tenants_slug', 'tenants', ['slug'], unique=False)

    op.create_table(
        'staff_users',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('wecom_userid', sa.String(length=128), nullable=False),
        sa.Column('display_name', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.UniqueConstraint('tenant_id', 'wecom_userid', name='uq_staff_users_tenant_id'),
    )
    op.create_index('ix_staff_users_tenant_id', 'staff_users', ['tenant_id'], unique=False)

    op.create_table(
        'customers',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('external_userid', sa.String(length=128), nullable=False),
        sa.Column('display_name', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.UniqueConstraint('tenant_id', 'external_userid', name='uq_customers_tenant_id'),
    )
    op.create_index('ix_customers_tenant_id', 'customers', ['tenant_id'], unique=False)

    op.create_table(
        'customer_staff_bindings',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('customer_id', sa.String(length=36), nullable=False),
        sa.Column('staff_user_id', sa.String(length=36), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['staff_user_id'], ['staff_users.id'], ondelete='RESTRICT'),
        sa.UniqueConstraint('customer_id', 'staff_user_id', name='uq_customer_staff_bindings_customer_id'),
    )
    op.create_index('ix_customer_staff_bindings_tenant_id', 'customer_staff_bindings', ['tenant_id'], unique=False)
    op.create_index('ix_customer_staff_bindings_customer_id', 'customer_staff_bindings', ['customer_id'], unique=False)
    op.create_index('ix_customer_staff_bindings_staff_user_id', 'customer_staff_bindings', ['staff_user_id'], unique=False)

    op.create_table(
        'conversations',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('customer_id', sa.String(length=36), nullable=False),
        sa.Column('staff_user_id', sa.String(length=36), nullable=False),
        sa.Column('channel', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('last_message_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['staff_user_id'], ['staff_users.id'], ondelete='RESTRICT'),
        sa.UniqueConstraint('customer_id', 'staff_user_id', name='uq_conversations_customer_id'),
    )
    op.create_index('ix_conversations_tenant_id', 'conversations', ['tenant_id'], unique=False)
    op.create_index('ix_conversations_customer_id', 'conversations', ['customer_id'], unique=False)
    op.create_index('ix_conversations_staff_user_id', 'conversations', ['staff_user_id'], unique=False)
    op.create_index('ix_conversations_tenant_status', 'conversations', ['tenant_id', 'status'], unique=False)

    op.create_table(
        'knowledge_documents',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('content_sha256', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('source_uri', sa.String(length=512), nullable=True),
        sa.Column('chunk_count', sa.Integer(), nullable=False),
        sa.Column('metadata_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
    )
    op.create_index('ix_knowledge_documents_tenant_id', 'knowledge_documents', ['tenant_id'], unique=False)
    op.create_index('ix_knowledge_documents_tenant_status', 'knowledge_documents', ['tenant_id', 'status'], unique=False)
    op.create_index('ix_knowledge_documents_sha', 'knowledge_documents', ['content_sha256'], unique=False)

    op.create_table(
        'revisit_plans',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('customer_id', sa.String(length=36), nullable=False),
        sa.Column('staff_user_id', sa.String(length=36), nullable=True),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('reason', sa.String(length=255), nullable=False),
        sa.Column('schedule_rule', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('next_run_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['staff_user_id'], ['staff_users.id'], ondelete='RESTRICT'),
    )
    op.create_index('ix_revisit_plans_tenant_id', 'revisit_plans', ['tenant_id'], unique=False)
    op.create_index('ix_revisit_plans_customer_id', 'revisit_plans', ['customer_id'], unique=False)
    op.create_index('ix_revisit_plans_staff_user_id', 'revisit_plans', ['staff_user_id'], unique=False)
    op.create_index('ix_revisit_plans_tenant_status', 'revisit_plans', ['tenant_id', 'status'], unique=False)

    op.create_table(
        'revisit_tasks',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('plan_id', sa.String(length=36), nullable=True),
        sa.Column('customer_id', sa.String(length=36), nullable=False),
        sa.Column('staff_user_id', sa.String(length=36), nullable=True),
        sa.Column('reason', sa.String(length=255), nullable=False),
        sa.Column('planned_content', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('reviewer', sa.String(length=255), nullable=True),
        sa.Column('review_comment', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['plan_id'], ['revisit_plans.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['customer_id'], ['customers.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['staff_user_id'], ['staff_users.id'], ondelete='RESTRICT'),
    )
    op.create_index('ix_revisit_tasks_tenant_id', 'revisit_tasks', ['tenant_id'], unique=False)
    op.create_index('ix_revisit_tasks_plan_id', 'revisit_tasks', ['plan_id'], unique=False)
    op.create_index('ix_revisit_tasks_customer_id', 'revisit_tasks', ['customer_id'], unique=False)
    op.create_index('ix_revisit_tasks_staff_user_id', 'revisit_tasks', ['staff_user_id'], unique=False)
    op.create_index('ix_revisit_tasks_tenant_status', 'revisit_tasks', ['tenant_id', 'status'], unique=False)

    op.create_table(
        'messages',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('conversation_id', sa.String(length=36), nullable=False),
        sa.Column('role', sa.String(length=32), nullable=False),
        sa.Column('message_type', sa.String(length=32), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('external_message_id', sa.String(length=128), nullable=True),
        sa.Column('is_ai_generated', sa.Boolean(), nullable=False),
        sa.Column('metadata_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
    )
    op.create_index('ix_messages_tenant_id', 'messages', ['tenant_id'], unique=False)
    op.create_index('ix_messages_conversation_id', 'messages', ['conversation_id'], unique=False)
    op.create_index('ix_messages_external_message_id', 'messages', ['external_message_id'], unique=False)
    op.create_index('ix_messages_conversation_created_at', 'messages', ['conversation_id', 'created_at'], unique=False)

    op.create_table(
        'handoff_cases',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('conversation_id', sa.String(length=36), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.Column('operator', sa.String(length=255), nullable=True),
        sa.Column('reason', sa.String(length=255), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('history_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('conversation_id', name='uq_handoff_cases_conversation_id'),
    )
    op.create_index('ix_handoff_cases_conversation_id', 'handoff_cases', ['conversation_id'], unique=False)

    op.create_table(
        'audit_logs',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('conversation_id', sa.String(length=36), nullable=True),
        sa.Column('correlation_id', sa.String(length=64), nullable=False),
        sa.Column('event_type', sa.String(length=64), nullable=False),
        sa.Column('handoff_required', sa.Boolean(), nullable=False),
        sa.Column('confidence', sa.Float(), nullable=False),
        sa.Column('citations_json', sa.JSON(), nullable=False),
        sa.Column('input_summary', sa.String(length=200), nullable=False),
        sa.Column('payload_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='SET NULL'),
    )
    op.create_index('ix_audit_logs_tenant_id', 'audit_logs', ['tenant_id'], unique=False)
    op.create_index('ix_audit_logs_conversation_id', 'audit_logs', ['conversation_id'], unique=False)
    op.create_index('ix_audit_logs_correlation_id', 'audit_logs', ['correlation_id'], unique=False)
    op.create_index('ix_audit_logs_conversation_created_at', 'audit_logs', ['conversation_id', 'created_at'], unique=False)

    op.create_table(
        'evaluation_runs',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('run_type', sa.String(length=64), nullable=False),
        sa.Column('dataset_name', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('summary_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
    )
    op.create_index('ix_evaluation_runs_tenant_id', 'evaluation_runs', ['tenant_id'], unique=False)
    op.create_index('ix_evaluation_runs_tenant_status', 'evaluation_runs', ['tenant_id', 'status'], unique=False)

    op.create_table(
        'idempotency_records',
        sa.Column('id', sa.String(length=36), primary_key=True),
        sa.Column('tenant_id', sa.String(length=36), nullable=False),
        sa.Column('idempotency_key', sa.String(length=255), nullable=False),
        sa.Column('request_fingerprint', sa.String(length=64), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('response_payload', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['tenant_id'], ['tenants.id'], ondelete='RESTRICT'),
        sa.UniqueConstraint('idempotency_key', name='uq_idempotency_records_idempotency_key'),
    )
    op.create_index('ix_idempotency_records_tenant_id', 'idempotency_records', ['tenant_id'], unique=False)
    op.create_index('ix_idempotency_records_created_at', 'idempotency_records', ['created_at'], unique=False)


def downgrade() -> None:
    for index_name, table_name in [
        ('ix_idempotency_records_created_at', 'idempotency_records'),
        ('ix_idempotency_records_tenant_id', 'idempotency_records'),
        ('ix_evaluation_runs_tenant_status', 'evaluation_runs'),
        ('ix_evaluation_runs_tenant_id', 'evaluation_runs'),
        ('ix_audit_logs_conversation_created_at', 'audit_logs'),
        ('ix_audit_logs_correlation_id', 'audit_logs'),
        ('ix_audit_logs_conversation_id', 'audit_logs'),
        ('ix_audit_logs_tenant_id', 'audit_logs'),
        ('ix_handoff_cases_conversation_id', 'handoff_cases'),
        ('ix_messages_conversation_created_at', 'messages'),
        ('ix_messages_external_message_id', 'messages'),
        ('ix_messages_conversation_id', 'messages'),
        ('ix_messages_tenant_id', 'messages'),
        ('ix_revisit_tasks_tenant_status', 'revisit_tasks'),
        ('ix_revisit_tasks_staff_user_id', 'revisit_tasks'),
        ('ix_revisit_tasks_customer_id', 'revisit_tasks'),
        ('ix_revisit_tasks_plan_id', 'revisit_tasks'),
        ('ix_revisit_tasks_tenant_id', 'revisit_tasks'),
        ('ix_revisit_plans_tenant_status', 'revisit_plans'),
        ('ix_revisit_plans_staff_user_id', 'revisit_plans'),
        ('ix_revisit_plans_customer_id', 'revisit_plans'),
        ('ix_revisit_plans_tenant_id', 'revisit_plans'),
        ('ix_knowledge_documents_sha', 'knowledge_documents'),
        ('ix_knowledge_documents_tenant_status', 'knowledge_documents'),
        ('ix_knowledge_documents_tenant_id', 'knowledge_documents'),
        ('ix_conversations_tenant_status', 'conversations'),
        ('ix_conversations_staff_user_id', 'conversations'),
        ('ix_conversations_customer_id', 'conversations'),
        ('ix_conversations_tenant_id', 'conversations'),
        ('ix_customer_staff_bindings_staff_user_id', 'customer_staff_bindings'),
        ('ix_customer_staff_bindings_customer_id', 'customer_staff_bindings'),
        ('ix_customer_staff_bindings_tenant_id', 'customer_staff_bindings'),
        ('ix_customers_tenant_id', 'customers'),
        ('ix_staff_users_tenant_id', 'staff_users'),
        ('ix_tenants_slug', 'tenants'),
    ]:
        op.drop_index(index_name, table_name=table_name)

    for table_name in [
        'idempotency_records',
        'evaluation_runs',
        'audit_logs',
        'handoff_cases',
        'messages',
        'revisit_tasks',
        'revisit_plans',
        'knowledge_documents',
        'conversations',
        'customer_staff_bindings',
        'customers',
        'staff_users',
        'tenants',
    ]:
        op.drop_table(table_name)
