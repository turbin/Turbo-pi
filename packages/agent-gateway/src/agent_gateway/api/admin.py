"""Admin and discovery endpoints: /healthz, /v1/models."""

from fastapi import APIRouter, Depends

from agent_gateway.api.deps import get_channel_context
from agent_gateway.channel import ChannelContext

router = APIRouter()


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/v1/models")
async def list_models(context: ChannelContext = Depends(get_channel_context)) -> dict:
    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "created": 0, "owned_by": "agent-gateway"}
            for model in context.allowed_models
        ],
    }
