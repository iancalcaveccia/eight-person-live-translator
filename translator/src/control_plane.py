"""HMAC-signed client for the control plane's internal API (CONTRACT.md §6)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import aiohttp

logger = logging.getLogger("translator.control_plane")


def sign(secret: str, timestamp: str, body: str) -> str:
    """Return the `X-Interp-Signature` header value."""
    digest = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.{body}".encode(), hashlib.sha256
    ).hexdigest()
    return f"v1={digest}"


def canonical_json(payload: Any) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class ControlPlaneError(Exception):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class AdmissionDecision:
    allowed: bool
    epoch: int | None = None
    reason: str | None = None


@dataclass
class TranslationPolicy:
    allowed: bool = True
    reason: str | None = None
    default_provider: str | None = None


@dataclass
class AdmissionResult:
    participants: dict[str, AdmissionDecision] = field(default_factory=dict)
    translation: TranslationPolicy = field(default_factory=TranslationPolicy)
    gathering_id: str | None = None
    group_id: str | None = None
    room_unknown: bool = False


@dataclass
class UsageResult:
    translation: TranslationPolicy = field(default_factory=TranslationPolicy)
    spend: dict[str, Any] = field(default_factory=dict)


def parse_admission(data: dict[str, Any]) -> AdmissionResult:
    result = AdmissionResult(
        gathering_id=data.get("gatheringId"), group_id=data.get("groupId")
    )
    for identity, d in (data.get("participants") or {}).items():
        d = d or {}
        epoch = d.get("epoch")
        result.participants[identity] = AdmissionDecision(
            allowed=bool(d.get("allowed")),
            epoch=int(epoch) if isinstance(epoch, (int, float)) else None,
            reason=d.get("reason"),
        )
    tr = data.get("translation") or {}
    result.translation = TranslationPolicy(
        allowed=bool(tr.get("allowed", True)),
        reason=tr.get("reason"),
        default_provider=tr.get("defaultProvider"),
    )
    return result


def parse_usage(data: dict[str, Any]) -> UsageResult:
    tr = data.get("translation") or {}
    return UsageResult(
        translation=TranslationPolicy(
            allowed=bool(tr.get("allowed", True)), reason=tr.get("reason")
        ),
        spend=data.get("spend") or {},
    )


class ControlPlaneClient:
    """Thin async client. When `base_url` is empty the client is in standalone
    dev mode (`standalone == True`) and callers must not use it."""

    def __init__(
        self,
        *,
        base_url: str,
        secret: str,
        timeout_sec: float = 5.0,
        retries: int = 2,
        session: aiohttp.ClientSession | None = None,
        clock: Any = time.time,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._timeout = aiohttp.ClientTimeout(total=timeout_sec)
        self._retries = retries
        self._session = session
        self._owns_session = session is None
        self._clock = clock
        if self._base and not self._secret:
            raise ValueError(
                "INTERNAL_API_SECRET is required when CONTROL_PLANE_URL is set"
            )

    @property
    def standalone(self) -> bool:
        return not self._base

    async def aclose(self) -> None:
        if self._session is not None and self._owns_session:
            await self._session.close()
            self._session = None

    def _headers(self, body: str) -> dict[str, str]:
        ts = str(int(self._clock()))
        return {
            "Content-Type": "application/json",
            "X-Interp-Timestamp": ts,
            "X-Interp-Signature": sign(self._secret, ts, body),
        }

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self.standalone:
            raise ControlPlaneError("standalone mode: no control plane configured")
        if self._session is None:
            self._session = aiohttp.ClientSession()
        body = canonical_json(payload)
        last_exc: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                async with self._session.post(
                    f"{self._base}{path}",
                    data=body.encode("utf-8"),
                    headers=self._headers(body),
                    timeout=self._timeout,
                ) as resp:
                    if resp.status == 404:
                        raise ControlPlaneError("not found", status=404)
                    if resp.status in (401, 403):
                        raise ControlPlaneError(
                            "unauthorized (check INTERNAL_API_SECRET)",
                            status=resp.status,
                        )
                    if resp.status >= 500:
                        raise ControlPlaneError(
                            f"server error {resp.status}", status=resp.status
                        )
                    if resp.status >= 400:
                        raise ControlPlaneError(
                            f"bad request {resp.status}", status=resp.status
                        )
                    return await resp.json()
            except ControlPlaneError as exc:
                last_exc = exc
                if exc.status is not None and exc.status < 500:
                    raise
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                last_exc = exc
            if attempt < self._retries:
                await asyncio.sleep(0.5 * (2**attempt))
        raise ControlPlaneError(f"control plane unreachable: {type(last_exc).__name__}")

    async def admission(self, *, room: str, identities: list[str]) -> AdmissionResult:
        try:
            data = await self._post(
                "/api/internal/admission", {"room": room, "identities": identities}
            )
        except ControlPlaneError as exc:
            if exc.status == 404:
                return AdmissionResult(
                    participants={
                        i: AdmissionDecision(False, None, "unknown_room")
                        for i in identities
                    },
                    translation=TranslationPolicy(False, "unknown_room"),
                    room_unknown=True,
                )
            raise
        return parse_admission(data)

    async def usage(
        self,
        *,
        room: str,
        gathering_id: str,
        group_id: str,
        records: list[dict[str, Any]],
    ) -> UsageResult:
        data = await self._post(
            "/api/internal/usage",
            {
                "room": room,
                "gatheringId": gathering_id,
                "groupId": group_id,
                "records": records,
            },
        )
        return parse_usage(data)
