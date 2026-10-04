"""Tests for the mtime-keyed cache in `api/zones.py`'s `_read_store`.

The frontend GETs /api/life180/zones on every update tick, so the parsed
zones file is reused until its mtime changes. These tests pin the two
properties that make that safe: a changed file is always re-read, and callers
mutating the returned store never corrupt the cached copy.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types

from conftest import _load_module_by_path

# zones.py imports aiofiles at module level; the cache path under test never
# reaches it because `read_zones_file` is replaced below.
sys.modules.setdefault("aiofiles", types.ModuleType("aiofiles"))

zones = _load_module_by_path(
    "custom_components.life180.api.zones",
    "custom_components/life180/api/zones.py",
)


def _install_counting_reader(monkeypatch):
    calls = []

    async def fake_read(path):
        calls.append(path)
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    monkeypatch.setattr(zones, "read_zones_file", fake_read)
    monkeypatch.setattr(zones, "_store_cache", {})
    return calls


def _write(path, data, mtime_ns):
    path.write_text(json.dumps(data), encoding="utf-8")
    os.utime(path, ns=(mtime_ns, mtime_ns))


def test_unchanged_file_is_read_once(tmp_path, monkeypatch):
    calls = _install_counting_reader(monkeypatch)
    path = tmp_path / "life180_zones.json"
    _write(path, {"zones": [{"id": "home"}], "ha_overrides": {}}, 1_000_000_000)

    first = asyncio.run(zones._read_store(str(path)))
    second = asyncio.run(zones._read_store(str(path)))

    assert first == second == {"zones": [{"id": "home"}], "ha_overrides": {}}
    assert len(calls) == 1


def test_changed_mtime_rereads_file(tmp_path, monkeypatch):
    calls = _install_counting_reader(monkeypatch)
    path = tmp_path / "life180_zones.json"
    _write(path, {"zones": [{"id": "home"}]}, 1_000_000_000)
    asyncio.run(zones._read_store(str(path)))

    _write(path, {"zones": [{"id": "work"}]}, 2_000_000_000)
    store = asyncio.run(zones._read_store(str(path)))

    assert store["zones"] == [{"id": "work"}]
    assert len(calls) == 2


def test_mutating_returned_store_does_not_touch_cache(tmp_path, monkeypatch):
    _install_counting_reader(monkeypatch)
    path = tmp_path / "life180_zones.json"
    _write(path, {"zones": [{"id": "home"}], "ha_overrides": {"a": {}}}, 1_000_000_000)

    store = asyncio.run(zones._read_store(str(path)))
    store["zones"].append({"id": "junk"})
    store["ha_overrides"].pop("a")

    again = asyncio.run(zones._read_store(str(path)))
    assert again == {"zones": [{"id": "home"}], "ha_overrides": {"a": {}}}


def test_missing_file_is_not_cached(tmp_path, monkeypatch):
    async def fake_read(path):
        return []

    monkeypatch.setattr(zones, "read_zones_file", fake_read)
    monkeypatch.setattr(zones, "_store_cache", {})

    store = asyncio.run(zones._read_store(str(tmp_path / "missing.json")))

    assert store == {"zones": [], "ha_overrides": {}}
    assert zones._store_cache == {}


def test_write_store_drops_cache_even_with_same_mtime(tmp_path, monkeypatch):
    calls = _install_counting_reader(monkeypatch)
    path = tmp_path / "life180_zones.json"
    _write(path, {"zones": [{"id": "home"}]}, 1_000_000_000)
    asyncio.run(zones._read_store(str(path)))

    async def fake_write(p, data):
        _write(path, data, 1_000_000_000)  # same mtime as before

    monkeypatch.setattr(zones, "write_zones_file", fake_write)
    asyncio.run(zones._write_store(str(path), {"zones": [{"id": "work"}]}))

    store = asyncio.run(zones._read_store(str(path)))
    assert store["zones"] == [{"id": "work"}]
    assert len(calls) == 2
