"""HMAC signing (shared test vector) and the internal API client."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from aiohttp import web

from control_plane import ControlPlaneClient, ControlPlaneError, canonical_json, sign

SECRET = "test-secret"


def test_contract_hmac_test_vector():
    body = '{"room":"grp_test","identities":["p1"]}'
    assert canonical_json({"room": "grp_test", "identities": ["p1"]}) == body
    assert (
        sign(SECRET, "1700000000", body)
        == "v1=81db07323246d44a782b096c988c871b5c323017ba636958c89b1bd643c5214d"
    )


def test_standalone_requires_no_secret_but_url_requires_secret():
    assert ControlPlaneClient(base_url="", secret="").standalone
    with pytest.raises(ValueError):
        ControlPlaneClient(base_url="https://x", secret="")


@pytest.fixture
async def server():
    seen: list[dict] = []

    def verify(request: web.Request, body: str) -> bool:
        ts = request.headers.get("X-Interp-Timestamp", "")
        sig = request.headers.get("X-Interp-Signature", "")
        expected = (
            "v1="
            + hmac.new(
                SECRET.encode(), f"{ts}.{body}".encode(), hashlib.sha256
            ).hexdigest()
        )
        return hmac.compare_digest(sig, expected)

    async def admission(request: web.Request):
        body = await request.text()
        if not verify(request, body):
            return web.json_response({"error": "bad signature"}, status=401)
        data = json.loads(body)
        seen.append({"path": "admission", **data})
        if data["room"] == "grp_unknown":
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(
            {
                "gatheringId": "g",
                "groupId": "grp",
                "participants": {
                    i: (
                        {"allowed": True, "epoch": 2, "reason": None}
                        if i != "bad"
                        else {"allowed": False, "epoch": None, "reason": "not_in_group"}
                    )
                    for i in data["identities"]
                },
                "translation": {
                    "allowed": True,
                    "reason": None,
                    "defaultProvider": "gemini",
                },
            }
        )

    async def usage(request: web.Request):
        body = await request.text()
        if not verify(request, body):
            return web.json_response({"error": "bad signature"}, status=401)
        seen.append({"path": "usage", **json.loads(body)})
        return web.json_response(
            {
                "translation": {"allowed": False, "reason": "monthly_cap"},
                "spend": {
                    "gatheringUsd": 1.5,
                    "monthUsd": 200,
                    "capGatheringUsd": 50,
                    "capMonthUsd": 200,
                },
            }
        )

    app = web.Application()
    app.router.add_post("/api/internal/admission", admission)
    app.router.add_post("/api/internal/usage", usage)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", seen
    await runner.cleanup()


async def test_admission_round_trip(server):
    url, seen = server
    client = ControlPlaneClient(base_url=url, secret=SECRET)
    res = await client.admission(room="grp_x", identities=["p1", "bad"])
    await client.aclose()
    assert res.participants["p1"].allowed and res.participants["p1"].epoch == 2
    assert (
        not res.participants["bad"].allowed
        and res.participants["bad"].reason == "not_in_group"
    )
    assert res.translation.default_provider == "gemini"
    assert seen[0] == {
        "path": "admission",
        "room": "grp_x",
        "identities": ["p1", "bad"],
    }


async def test_unknown_room_maps_to_denial(server):
    url, _ = server
    client = ControlPlaneClient(base_url=url, secret=SECRET)
    res = await client.admission(room="grp_unknown", identities=["p1"])
    await client.aclose()
    assert res.room_unknown and not res.participants["p1"].allowed


async def test_wrong_secret_is_rejected(server):
    url, _ = server
    client = ControlPlaneClient(base_url=url, secret="wrong")
    with pytest.raises(ControlPlaneError) as info:
        await client.admission(room="grp_x", identities=["p1"])
    await client.aclose()
    assert info.value.status == 401


async def test_usage_round_trip_returns_budget_policy(server):
    url, seen = server
    client = ControlPlaneClient(base_url=url, secret=SECRET)
    res = await client.usage(
        room="grp_x",
        gathering_id="g",
        group_id="grp",
        records=[{"speakerId": "a", "targetLang": "pl"}],
    )
    await client.aclose()
    assert res.translation.allowed is False and res.translation.reason == "monthly_cap"
    assert res.spend["monthUsd"] == 200
    assert seen[-1]["records"] == [{"speakerId": "a", "targetLang": "pl"}]


async def test_unreachable_control_plane_raises_after_retries():
    client = ControlPlaneClient(
        base_url="http://127.0.0.1:9", secret=SECRET, timeout_sec=0.5, retries=1
    )
    with pytest.raises(ControlPlaneError):
        await client.admission(room="grp", identities=["p"])
    await client.aclose()
