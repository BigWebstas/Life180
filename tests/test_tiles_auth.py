"""Tests for the login gate on the tile cache in `api/tiles.py`.

The tile endpoint is reachable without a token (map libraries load tiles as
plain requests). With the cache on it must only fetch into / serve from the
cache for logged-in callers; anyone else gets a redirect to the public map
server. Otherwise anyone who can reach HA could pull tiles through the
household's IP, or read which areas are cached.
"""

from __future__ import annotations

import asyncio
import sys
import types

from conftest import FakeConfigEntry, FakeUser, _load_module_by_path


def _install_stubs():
    """Stub the aiohttp / HA names tiles.py imports beyond the conftest set."""
    aiohttp = sys.modules.setdefault("aiohttp", types.ModuleType("aiohttp"))
    web = types.ModuleType("aiohttp.web")

    class Response:
        def __init__(self, status=200, text=None, body=None, content_type=None, headers=None):
            self.status = status
            self.text = text
            self.body = body
            self.content_type = content_type
            self.headers = headers or {}

    class HTTPFound(Response):
        def __init__(self, location, headers=None):
            super().__init__(status=302, headers=headers)
            self.location = location

    web.Response = Response
    web.HTTPFound = HTTPFound
    aiohttp.web = web
    sys.modules.setdefault("aiohttp.web", web)

    core = sys.modules.setdefault("homeassistant.core", types.ModuleType("homeassistant.core"))
    core.CoreState = getattr(core, "CoreState", types.SimpleNamespace(running="running"))
    const = sys.modules.setdefault("homeassistant.const", types.ModuleType("homeassistant.const"))
    const.EVENT_HOMEASSISTANT_STARTED = "homeassistant_started"
    client = sys.modules.setdefault(
        "homeassistant.helpers.aiohttp_client",
        types.ModuleType("homeassistant.helpers.aiohttp_client"),
    )
    client.async_get_clientsession = lambda hass: None


_install_stubs()
tiles = _load_module_by_path(
    "custom_components.life180.api.tiles",
    "custom_components/life180/api/tiles.py",
)

TILE_PBF = b"fake vector tile"
TILE_PATH = "planet/20261004_113936_pt/3/4/5.pbf"
UPSTREAM_URL = tiles.UPSTREAM + TILE_PATH


class _Config:
    def __init__(self, root):
        self._root = root

    def path(self, *parts):
        return str(self._root.joinpath(*parts))


class _Hass:
    def __init__(self, root, cache_enabled):
        self.config = _Config(root)
        self.data = {}
        entry = FakeConfigEntry(options={"map_cache_enabled": cache_enabled})
        self.config_entries = types.SimpleNamespace(async_entries=lambda domain: [entry])

    async def async_add_executor_job(self, fn, *args):
        return fn(*args)


class _Request(dict):
    """aiohttp requests are mappings; HA sets "hass_user" only when logged in."""

    def __init__(self, hass, user=None):
        super().__init__()
        self.app = {"hass": hass}
        if user is not None:
            self["hass_user"] = user


def _get(hass, request, monkeypatch, path=TILE_PATH):
    fetches = []

    async def fake_fetch(self, hass_, path):
        fetches.append(path)
        return TILE_PBF

    monkeypatch.setattr(tiles.TileEndpoint, "_fetch", fake_fetch)
    monkeypatch.setattr(tiles.TileEndpoint, "_maybe_evict", staticmethod(lambda h, r: None))
    resp = asyncio.run(tiles.TileEndpoint().get(request, path))
    return resp, fetches


def test_cache_off_redirects_without_storing(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=False)
    resp, fetches = _get(hass, _Request(hass, FakeUser()), monkeypatch)

    assert resp.status == 302
    assert resp.location == UPSTREAM_URL
    # A stored redirect would later shadow logged-in cache requests.
    assert resp.headers["Cache-Control"] == "no-store"
    assert fetches == []


def test_cache_on_anonymous_is_redirected_not_fetched(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=True)
    resp, fetches = _get(hass, _Request(hass), monkeypatch)

    assert resp.status == 302
    assert resp.location == UPSTREAM_URL
    assert resp.headers["Cache-Control"] == "no-store"
    assert fetches == []
    assert not (tmp_path / tiles.TILE_DIR).exists()


def test_cache_on_anonymous_never_sees_cached_tile(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=True)
    cached = tmp_path / tiles.TILE_DIR / TILE_PATH
    cached.parent.mkdir(parents=True)
    cached.write_bytes(TILE_PBF)

    resp, _ = _get(hass, _Request(hass), monkeypatch)

    assert resp.status == 302
    assert resp.body is None


def test_cache_on_logged_in_fetches_and_stores(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=True)
    resp, fetches = _get(hass, _Request(hass, FakeUser(is_admin=False)), monkeypatch)

    assert resp.status == 200
    assert resp.body == TILE_PBF
    assert resp.content_type == "application/x-protobuf"
    assert resp.headers["Cache-Control"].startswith("private")
    assert fetches == [TILE_PATH]
    assert (tmp_path / tiles.TILE_DIR / TILE_PATH).read_bytes() == TILE_PBF


def test_unlisted_paths_are_rejected(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=True)
    for bad in ("styles/liberty", "planet/../../etc/passwd", "planet/b/3/4/5.png", "fonts/x/y.pbf/../z"):
        resp, fetches = _get(hass, _Request(hass, FakeUser()), monkeypatch, path=bad)
        assert resp.status == 404, bad
        assert fetches == []


def test_fonts_and_sprites_are_cached_with_matching_type(tmp_path, monkeypatch):
    hass = _Hass(tmp_path, cache_enabled=True)
    for path, ctype in (
        ("fonts/Noto Sans Regular/0-255.pbf", "application/x-protobuf"),
        ("sprites/ofm_f384/ofm.json", "application/json"),
        ("sprites/ofm_f384/ofm@2x.png", "image/png"),
    ):
        resp, _ = _get(hass, _Request(hass, FakeUser()), monkeypatch, path=path)
        assert resp.status == 200 and resp.content_type == ctype, path
        assert (tmp_path / tiles.TILE_DIR / path).read_bytes() == TILE_PBF

