"""Tests for how the tile cache behaves towards upstream tile servers.

Tile servers block clients that hammer them, and a block on a home IP takes
the map down for everyone behind it. These pin the safeguards: a
per-install User-Agent, a cap on parallel upstream requests, and pausing all
fetches after a 403/429 instead of retrying through a block.
"""

from __future__ import annotations

import asyncio
import types

import test_tiles_auth  # noqa: F401  (installs the aiohttp / HA stubs)
from conftest import _load_module_by_path

tiles = _load_module_by_path(
    "custom_components.life180.api.tiles",
    "custom_components/life180/api/tiles.py",
)


class _Resp:
    def __init__(self, status=200, headers=None, body=b"png"):
        self.status = status
        self.headers = {"Content-Type": "image/png", **(headers or {})}
        self._body = body

    async def read(self):
        return self._body


class _Session:
    """Fake aiohttp session: replays `responses`, records calls and concurrency."""

    def __init__(self, responses=None, delay=0.0):
        self.responses = list(responses or [])
        self.delay = delay
        self.calls = []
        self.in_flight = 0
        self.max_in_flight = 0

    def get(self, url, headers=None, timeout=None):
        session = self

        class _Ctx:
            async def __aenter__(self_inner):
                session.calls.append((url, headers))
                session.in_flight += 1
                session.max_in_flight = max(session.max_in_flight, session.in_flight)
                await asyncio.sleep(session.delay)
                return session.responses.pop(0) if session.responses else _Resp()

            async def __aexit__(self_inner, *exc):
                session.in_flight -= 1
                return False

        return _Ctx()


def _hass(entry_id="01J0000000000000000000ABCD", version="0.7.0"):
    entry = types.SimpleNamespace(entry_id=entry_id, data={}, options={})
    return types.SimpleNamespace(
        data={tiles.DOMAIN: {"version": version}},
        config_entries=types.SimpleNamespace(async_entries=lambda domain: [entry]),
    )


def _fetch(hass, session, monkeypatch, n=1):
    monkeypatch.setattr(tiles, "async_get_clientsession", lambda h: session)

    async def run():
        ep = tiles.TileEndpoint()
        return await asyncio.gather(*(ep._fetch(hass, f"planet/b/3/4/{i}.pbf") for i in range(n)))

    return asyncio.run(run())


def test_user_agent_identifies_app_version_and_install():
    ua = tiles._user_agent(_hass())

    assert ua.startswith("Life180/0.7.0 (+https://github.com/BigWebstas/Life180; install ")
    assert "01J0000000000000000000ABCD" not in ua  # raw entry id never sent


def test_user_agent_differs_per_install():
    assert tiles._user_agent(_hass("entry-a")) != tiles._user_agent(_hass("entry-b"))


def test_user_agent_is_sent_upstream(monkeypatch):
    hass = _hass()
    session = _Session()
    _fetch(hass, session, monkeypatch)

    assert session.calls[0][1]["User-Agent"] == tiles._user_agent(hass)


def test_at_most_two_upstream_fetches_at_once(monkeypatch):
    session = _Session(delay=0.01)
    results = _fetch(_hass(), session, monkeypatch, n=8)

    assert all(r == b"png" for r in results)
    assert len(session.calls) == 8
    assert session.max_in_flight == tiles.MAX_CONCURRENT_FETCHES == 2


def test_403_pauses_all_fetches(monkeypatch):
    hass = _hass()
    session = _Session([_Resp(status=403)])

    assert _fetch(hass, session, monkeypatch) == [None]
    assert _fetch(hass, session, monkeypatch, n=3) == [None, None, None]
    assert len(session.calls) == 1  # nothing sent while paused


def test_429_honours_retry_after_then_resumes(monkeypatch):
    hass = _hass()
    now = [1000.0]
    monkeypatch.setattr(tiles.time, "monotonic", lambda: now[0])
    session = _Session([_Resp(status=429, headers={"Retry-After": "120"})])

    assert _fetch(hass, session, monkeypatch) == [None]
    now[0] += 119
    assert _fetch(hass, session, monkeypatch) == [None]
    assert len(session.calls) == 1

    now[0] += 2  # past Retry-After
    assert _fetch(hass, session, monkeypatch) == [b"png"]
    assert len(session.calls) == 2


def test_backoff_defaults_and_bounds():
    assert tiles._backoff_seconds(403, None) == tiles.BACKOFF_403
    assert tiles._backoff_seconds(429, None) == tiles.BACKOFF_429
    assert tiles._backoff_seconds(429, "Wed, 21 Oct 2026 07:28:00 GMT") == tiles.BACKOFF_429
    assert tiles._backoff_seconds(429, "999999") == tiles.MAX_BACKOFF


def test_other_errors_do_not_pause(monkeypatch):
    hass = _hass()
    session = _Session([_Resp(status=404), _Resp()])

    assert _fetch(hass, session, monkeypatch) == [None]
    assert _fetch(hass, session, monkeypatch) == [b"png"]
