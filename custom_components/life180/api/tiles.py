"""Local raster map-tile cache proxy.

Fetches OSM / Esri raster tiles on demand, stores them on disk under
``<config>/life180_tiles/`` and serves them from there afterwards.

Goals: offline map support, fewer external requests, faster reloads. When a
tile fetch fails and a stale copy is on disk, the stale copy is served so the
map keeps working without a connection.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

from datetime import timedelta
from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import CoreState
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)

# {source: upstream URL template}. {z}/{x}/{y} are substituted per request.
TILE_SOURCES = {
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "esri": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/"
        "World_Imagery/MapServer/tile/{z}/{y}/{x}"
    ),
}

TILE_DIR = "life180_tiles"
MAX_Z = 22
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

USER_AGENT = "Life180/1.0 (+https://github.com/BigWebstas/Life180)"


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
    """Return (total_bytes, [(mtime, size, path), ...]) for every .png under root."""
    total = 0
    files = []
    if not root.is_dir():
        return 0, files
    for dirpath, _dirs, names in os.walk(root):
        for name in names:
            if not name.endswith(".png"):
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
    """Serve a cached raster tile, fetching and storing it on a miss."""

    url = "/api/life180/tile/{source}/{z}/{x}/{y}"
    name = "api:life180/tile"
    # Map libraries request tiles as plain <img>/fetch with no bearer token, and
    # the data is public map imagery, so this endpoint is unauthenticated - the
    # same trust level as the /life180 static path.
    requires_auth = False

    async def get(self, request, source, z, x, y):
        hass = request.app["hass"]

        if source not in TILE_SOURCES:
            return web.Response(status=404, text="unknown tile source")

        # y may arrive as "12345.png"
        y = str(y).split(".", 1)[0]
        try:
            zi, xi, yi = int(z), int(x), int(y)
        except (TypeError, ValueError):
            return web.Response(status=400, text="z/x/y must be integers")
        if not (0 <= zi <= MAX_Z):
            return web.Response(status=400, text="z out of range")
        span = 1 << zi
        if not (0 <= xi < span and 0 <= yi < span):
            return web.Response(status=400, text="x/y out of range")

        # Caching off -> redirect the client straight to upstream. The redirect
        # is cacheable, so after the first hit the browser goes direct and HA is
        # out of the loop.
        if not _cache_enabled(hass):
            return web.HTTPFound(
                TILE_SOURCES[source].format(z=zi, x=xi, y=yi),
                headers={
                    "Cache-Control": f"public, max-age={BROWSER_MAX_AGE}",
                    "Access-Control-Allow-Origin": "*",
                },
            )

        root = _tile_root(hass)
        path = root / source / str(zi) / str(xi) / f"{yi}.png"

        fresh = False
        try:
            st = path.stat()
            fresh = (time.time() - st.st_mtime) < DISK_TTL.total_seconds()
        except OSError:
            st = None

        if fresh:
            data = await hass.async_add_executor_job(path.read_bytes)
            return self._tile_response(data)

        data = await self._fetch(hass, source, zi, xi, yi)
        if data is not None:
            await hass.async_add_executor_job(_write_tile, path, data)
            self._maybe_evict(hass, root)
            return self._tile_response(data)

        # Upstream failed - fall back to a stale copy if we have one.
        if st is not None:
            try:
                data = await hass.async_add_executor_job(path.read_bytes)
                return self._tile_response(data, stale=True)
            except OSError:
                pass

        return web.Response(status=502, text="tile unavailable")

    async def _fetch(self, hass, source, z, x, y):
        url = TILE_SOURCES[source].format(z=z, x=x, y=y)
        session = async_get_clientsession(hass)
        try:
            async with session.get(
                url,
                headers={"User-Agent": USER_AGENT},
                timeout=FETCH_TIMEOUT,
            ) as resp:
                if resp.status != 200:
                    return None
                ctype = resp.headers.get("Content-Type", "")
                if "image" not in ctype:
                    return None
                return await resp.read()
        except (asyncio.TimeoutError, OSError):
            return None
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("tile fetch error %s: %s", url, err)
            return None

    @staticmethod
    def _tile_response(data: bytes, stale: bool = False) -> web.Response:
        headers = {
            "Cache-Control": f"public, max-age={BROWSER_MAX_AGE}",
            "Access-Control-Allow-Origin": "*",
        }
        if stale:
            headers["X-Life180-Tile"] = "stale"
        return web.Response(body=data, content_type="image/png", headers=headers)

    @staticmethod
    def _maybe_evict(hass, root: Path) -> None:
        dd = hass.data.setdefault(DOMAIN, {})
        now = time.monotonic()
        if now - dd.get(_LAST_EVICT_KEY, 0.0) < EVICT_MIN_GAP:
            return
        dd[_LAST_EVICT_KEY] = now
        cap = _cap_bytes(hass)
        hass.async_add_executor_job(_evict_lru, root, cap)


def _write_tile(path: Path, data: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".png.tmp")
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
