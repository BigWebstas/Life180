"""Local map-asset cache proxy for the OpenFreeMap base map.

Fetches vector tiles, glyphs, sprites and the low-zoom raster backdrop on
demand, stores them on disk under ``<config>/life180_tiles/`` and serves them
from there afterwards. The style JSON and TileJSON are not proxied: the
browser fetches them directly, so a new planet build is picked up on its own.

Goals: fewer requests to the tile server and faster reloads. This is not an
offline or bulk cache: it only fetches assets someone is actively viewing.
When a fetch fails and an older copy is on disk, that copy is served instead
of an error.

Being a polite client of the tile servers:
- each install sends its own identifiable User-Agent (see ``_user_agent``);
- at most ``MAX_CONCURRENT_FETCHES`` upstream requests run at once;
- a 403/429 from upstream pauses all fetching (honouring
  ``Retry-After``), so a block is not prolonged by retries.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time

from datetime import timedelta
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import CoreState
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)

UPSTREAM = "https://tiles.openfreemap.org/"

# Paths under UPSTREAM that may be proxied. Each path segment starts with a
# word character, so ".." and hidden names can never reach the filesystem.
_SEG = r"[\w@-][\w .@-]*"
_ALLOWED = re.compile(
    rf"(?:planet/{_SEG}/\d+/\d+/\d+\.pbf"  # vector tiles (planet/<build>/z/x/y)
    rf"|natural_earth/{_SEG}/\d+/\d+/\d+\.png"  # low-zoom raster backdrop
    rf"|fonts/{_SEG}/{_SEG}\.pbf"  # glyphs
    rf"|sprites/{_SEG}/{_SEG}\.(?:png|json))"  # sprite sheet + index
)
_CONTENT_TYPES = {
    ".pbf": "application/x-protobuf",
    ".png": "image/png",
    ".json": "application/json",
}

TILE_DIR = "life180_tiles"
FETCH_TIMEOUT = 20  # seconds
DISK_TTL = timedelta(days=90)  # re-fetch a cached tile older than this on access
BROWSER_MAX_AGE = 7 * 24 * 3600  # Cache-Control max-age sent to the browser

DEFAULT_MAX_MB = 500
LOW_WATER_FRACTION = 0.85  # evict down to this fraction of the cap
EVICT_INTERVAL = 600.0  # seconds between eviction sweeps
EVICT_MIN_GAP = 120.0  # do not sweep more often than this on write pressure

_MAINT_TASK_KEY = "tile_cache_maint_task"
_STARTED_LISTENER_KEY = "tile_cache_started_listener"
_LAST_EVICT_KEY = "tile_cache_last_evict"
_FETCH_SEM_KEY = "tile_cache_fetch_sem"
_BLOCKED_UNTIL_KEY = "tile_cache_blocked_until"

MAX_CONCURRENT_FETCHES = 2
# Pause after upstream refuses us. 429 = slow down; 403 = blocked (see
# a block, which needs a human to fix the cause, so wait longer.
BACKOFF_429 = 5 * 60  # seconds, unless Retry-After says otherwise
BACKOFF_403 = 60 * 60
MAX_BACKOFF = 24 * 60 * 60

PROJECT_URL = "https://github.com/BigWebstas/Life180"


def _user_agent(hass) -> str:
    """App name + version + contact URL, plus a per-install tag.

    The tag (a short hash of the config entry id, so nothing identifying is
    sent) lets a tile server block one misbehaving install instead of every
    Life180 user.
    """
    version = (hass.data.get(DOMAIN) or {}).get("version", "0")
    install = "unknown"
    try:
        entries = hass.config_entries.async_entries(DOMAIN)
        if entries:
            install = hashlib.sha256(entries[0].entry_id.encode()).hexdigest()[:10]
    except Exception:  # noqa: BLE001
        pass
    return f"Life180/{version} (+{PROJECT_URL}; install {install})"


def _backoff_seconds(status: int, retry_after: str | None) -> float:
    """How long to stop fetching after upstream answered ``status``."""
    default = BACKOFF_429 if status == 429 else BACKOFF_403
    try:
        wait = float(retry_after) if retry_after else default
    except ValueError:  # Retry-After may be an HTTP date; use the default
        wait = default
    return min(max(wait, 1.0), MAX_BACKOFF)


def _tile_root(hass) -> Path:
    return Path(hass.config.path(TILE_DIR))


def _entry_opt(hass, key, default):
    try:
        entries = hass.config_entries.async_entries(DOMAIN)
        if entries:
            entry = entries[0]
            return entry.options.get(key, entry.data.get(key, default))
    except Exception:  # noqa: BLE001
        pass
    return default


def _cache_enabled(hass) -> bool:
    return bool(_entry_opt(hass, "map_cache_enabled", False))


def _cap_bytes(hass) -> int:
    """Read the configured cap (MB) from the config entry; 0 disables eviction."""
    try:
        mb = _entry_opt(hass, "map_cache_max_mb", DEFAULT_MAX_MB)
        return max(0, int(float(mb))) * 1024 * 1024
    except (TypeError, ValueError):
        return DEFAULT_MAX_MB * 1024 * 1024


def _dir_size_and_files(root: Path):
    """Return (total_bytes, [(mtime, size, path), ...]) for every cached file under root."""
    total = 0
    files = []
    if not root.is_dir():
        return 0, files
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            if name.endswith(".tmp"):
                continue
            fp = os.path.join(dirpath, name)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            total += st.st_size
            files.append((st.st_mtime, st.st_size, fp))
    return total, files


def _evict_lru(root: Path, cap: int) -> int:
    """Delete the oldest tiles until the cache is under LOW_WATER_FRACTION * cap."""
    if cap <= 0:
        return 0
    total, files = _dir_size_and_files(root)
    if total <= cap:
        return 0
    target = int(cap * LOW_WATER_FRACTION)
    files.sort(key=lambda t: t[0])  # oldest first
    freed = 0
    for _mtime, size, fp in files:
        if total - freed <= target:
            break
        try:
            os.remove(fp)
            freed += size
        except OSError:
            continue
    return freed


class TileEndpoint(HomeAssistantView):
    """Serve a cached map asset, fetching and storing it on a miss."""

    url = "/api/life180/tile/{path:.+}"
    name = "api:life180/tile"
    # Not requires_auth: with the cache off this only redirects to public map
    # data, which needs no login. With the cache on, only logged-in requests
    # (the app sends its bearer token) are served from / fetched into the
    # cache; anonymous ones get the same redirect. That stops anyone who can
    # reach HA from pulling tiles through this IP or reading which areas are
    # cached (which reveals where the household's people go).
    requires_auth = False

    async def get(self, request, path):
        hass = request.app["hass"]

        if not _ALLOWED.fullmatch(path):
            return web.Response(status=404, text="unknown map asset")

        # Caching off, or an anonymous caller -> redirect straight to upstream.
        # The app itself never relies on this: transformRequest in map3D.js
        # only rewrites to this endpoint when the cache is on and it has a
        # token. Never stored, so a redirect cached while the cache was off
        # can't shadow a logged-in request after it is turned on.
        if not _cache_enabled(hass) or request.get("hass_user") is None:
            return web.HTTPFound(
                UPSTREAM + quote(path),
                headers={
                    "Cache-Control": "no-store",
                    "Access-Control-Allow-Origin": "*",
                },
            )

        file = _tile_root(hass) / path
        ctype = _CONTENT_TYPES[file.suffix]

        fresh = False
        try:
            st = file.stat()
            fresh = (time.time() - st.st_mtime) < DISK_TTL.total_seconds()
        except OSError:
            st = None

        if fresh:
            data = await hass.async_add_executor_job(file.read_bytes)
            return self._tile_response(data, ctype)

        data = await self._fetch(hass, path)
        if data is not None:
            await hass.async_add_executor_job(_write_tile, file, data)
            self._maybe_evict(hass, _tile_root(hass))
            return self._tile_response(data, ctype)

        # Upstream failed - fall back to a stale copy if we have one.
        if st is not None:
            try:
                data = await hass.async_add_executor_job(file.read_bytes)
                return self._tile_response(data, ctype, stale=True)
            except OSError:
                pass

        return web.Response(status=502, text="tile unavailable")

    async def _fetch(self, hass, path):
        dd = hass.data.setdefault(DOMAIN, {})
        sem = dd.get(_FETCH_SEM_KEY)
        if sem is None:
            sem = dd[_FETCH_SEM_KEY] = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
        if time.monotonic() < dd.get(_BLOCKED_UNTIL_KEY, 0.0):
            return None
        async with sem:
            # Re-check: a fetch that finished while this one queued may have
            # just been refused.
            if time.monotonic() < dd.get(_BLOCKED_UNTIL_KEY, 0.0):
                return None
            return await self._fetch_upstream(hass, path, dd)

    async def _fetch_upstream(self, hass, path, dd):
        url = UPSTREAM + quote(path)
        session = async_get_clientsession(hass)
        try:
            async with session.get(
                url,
                headers={"User-Agent": _user_agent(hass)},
                timeout=FETCH_TIMEOUT,
            ) as resp:
                if resp.status in (403, 429):
                    wait = _backoff_seconds(resp.status, resp.headers.get("Retry-After"))
                    dd[_BLOCKED_UNTIL_KEY] = time.monotonic() + wait
                    _LOGGER.warning(
                        "Map server answered %s; pausing map fetches for %d min. "
                        "Cached tiles are still served.",
                        resp.status, wait // 60,
                    )
                    return None
                if resp.status != 200:
                    return None
                return await resp.read()
        except (asyncio.TimeoutError, OSError):
            return None
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("tile fetch error %s: %s", url, err)
            return None

    @staticmethod
    def _tile_response(data: bytes, content_type: str, stale: bool = False) -> web.Response:
        headers = {
            # private: served only to logged-in callers, so no shared cache.
            "Cache-Control": f"private, max-age={BROWSER_MAX_AGE}",
            "Access-Control-Allow-Origin": "*",
        }
        if stale:
            headers["X-Life180-Tile"] = "stale"
        return web.Response(body=data, content_type=content_type, headers=headers)

    @staticmethod
    def _maybe_evict(hass, root: Path) -> None:
        dd = hass.data.setdefault(DOMAIN, {})
        now = time.monotonic()
        if now - dd.get(_LAST_EVICT_KEY, 0.0) < EVICT_MIN_GAP:
            return
        dd[_LAST_EVICT_KEY] = now
        cap = _cap_bytes(hass)
        hass.async_add_executor_job(_evict_lru, root, cap)


def _clear_tile_dir(root: Path) -> int:
    """Delete every cached tile under root and prune empty subdirs.

    Returns the number of bytes freed. The root directory itself is kept.
    """
    freed = 0
    if not root.is_dir():
        return 0
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            fp = os.path.join(dirpath, name)
            try:
                freed += os.stat(fp).st_size
                os.remove(fp)
            except OSError:
                continue
    for dirpath, _dirs, _files in os.walk(root, topdown=False):
        if Path(dirpath) == root:
            continue
        try:
            os.rmdir(dirpath)
        except OSError:
            pass
    return freed


async def async_clear_tile_cache(hass) -> int:
    """Wipe the on-disk tile cache. Returns the number of bytes freed."""
    root = _tile_root(hass)
    freed = await hass.async_add_executor_job(_clear_tile_dir, root)
    hass.data.setdefault(DOMAIN, {})[_LAST_EVICT_KEY] = 0.0
    _LOGGER.info("Life180 tile cache cleared (%d bytes freed)", freed)
    return freed


def _write_tile(path: Path, data: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError as err:
        _LOGGER.debug("could not write tile %s: %s", path, err)


async def async_init_tile_cache(hass) -> None:
    """Start the periodic tile-cache eviction task."""
    dd = hass.data.setdefault(DOMAIN, {})
    dd.setdefault(_LAST_EVICT_KEY, 0.0)

    async def _start(_event=None):
        if _MAINT_TASK_KEY in dd:
            return

        async def _periodic():
            try:
                while True:
                    await asyncio.sleep(EVICT_INTERVAL)
                    try:
                        cap = _cap_bytes(hass)
                        await hass.async_add_executor_job(
                            _evict_lru, _tile_root(hass), cap
                        )
                    except Exception as err:  # noqa: BLE001
                        _LOGGER.debug("tile eviction error: %s", err)
            except asyncio.CancelledError:
                return

        dd[_MAINT_TASK_KEY] = hass.async_create_task(_periodic(), "life180_tile_evict")

    if hass.state == CoreState.running:
        await _start()
    elif not dd.get(_STARTED_LISTENER_KEY):
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start)
        dd[_STARTED_LISTENER_KEY] = True


def async_stop_tile_cache(hass) -> None:
    """Cancel the eviction task (called on unload)."""
    dd = hass.data.get(DOMAIN) or {}
    task = dd.pop(_MAINT_TASK_KEY, None)
    if task:
        task.cancel()
