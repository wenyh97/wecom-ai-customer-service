from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding='utf-8')


def test_cd_builds_and_deploys_bridge_image() -> None:
    workflow = read_text('.github/workflows/cd.yml')

    assert 'BRIDGE_IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/wecom-ai-customer-service-bridge' in workflow
    assert 'context: ./bridge' in workflow
    assert 'file: ./bridge/Dockerfile' in workflow
    assert 'BRIDGE_IMAGE_REF: ${{ env.BRIDGE_IMAGE_NAME }}:sha-${{ github.sha }}' in workflow
    assert 'docker compose --profile workpro pull app migrate wechaty-bridge' in workflow
    assert 'docker compose pull mysql redis' in workflow
    assert 'docker compose --profile workpro up -d --no-build --force-recreate --no-deps wechaty-bridge' in workflow


def test_cd_gates_workpro_deploy_and_updates_server_env() -> None:
    workflow = read_text('.github/workflows/cd.yml')

    assert 'DEPLOY_WORKPRO_VALUE=$(env_value DEPLOY_WORKPRO)' in workflow
    assert 'WorkPro disabled' in workflow
    assert 'require_env_key WECHATY_PUPPET_SERVICE_TOKEN' in workflow
    assert 'require_env_key AI_BRIDGE_TOKEN' in workflow
    assert 'require_env_key BRIDGE_WEB_TOKEN' in workflow
    assert '/^BRIDGE_IMAGE=/ { print "BRIDGE_IMAGE=" bridge_image; bridge_updated = 1; next }' in workflow


def test_compose_uses_bridge_image_and_healthcheck() -> None:
    compose = read_text('docker-compose.yml')

    assert 'image: ${BRIDGE_IMAGE:-ghcr.io/wenyh97/wecom-ai-customer-service-bridge:latest}' in compose
    assert 'context: ./bridge' in compose
    assert '"${BRIDGE_WEB_BIND_HOST:-127.0.0.1}:${BRIDGE_WEB_PORT:-18080}:${BRIDGE_WEB_PORT:-18080}"' in compose
    assert "const http = require('node:http');" in compose
    assert "path: '/health'," in compose


def test_env_example_documents_cd_managed_bridge_settings() -> None:
    env_example = read_text('.env.example')

    assert 'APP_IMAGE=' in env_example
    assert 'BRIDGE_IMAGE=' in env_example
    assert 'DEPLOY_WORKPRO=false' in env_example
