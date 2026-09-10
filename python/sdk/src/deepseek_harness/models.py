from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from pydantic import BaseModel, Field, StrictBool

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class RuntimeCapabilities(BaseModel):
    sessionTreeSettled: StrictBool = False
    approvalResponses: StrictBool = False
    subagentControl: StrictBool = False


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None
    capabilities: RuntimeCapabilities = Field(default_factory=RuntimeCapabilities)
