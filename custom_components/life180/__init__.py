"""Initialization module for Life180."""
from __future__ import annotations 

import json
import logging
import asyncio
import aiofiles
import re

from datetime import timedelta
from functools import partial
from typing import Any, Dict
from urllib.parse import urlsplit, urlunsplit
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.lovelace.resources import (
    ResourceStorageCollection,  # type: ignore
)
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, CoreState
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.network import get_url
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED

from .api import register_api_views
from .api.zones import register_zones, unregister_zones
from .api.reverse_geocode import async_init_reverse_cache
from .api.tiles import async_init_tile_cache, async_stop_tile_cache
from .units import imperial_to_metric, metric_to_imperial


# --------------------------------------------------------------------------- #
#  BASIC CONFIGURATION                                                        #
# --------------------------------------------------------------------------- #

DOMAIN = __package__.split(".")[-1]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_LOGGER = logging.getLogger(__name__)

STATIC_DIR = (Path(__file__).parent / "www").resolve()

PANEL_URL = "/life180_static/assets/life180-panel.js"
CARD_URL  = "/life180_static/assets/life180-card.js"


# --------------------------------------------------------------------------- #
#  SETUP                                                                      #
# --------------------------------------------------------------------------- #
async def async_setup(_hass: HomeAssistant, _config) -> bool:
    """Initial integration setup (empty)."""
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Migrate old config entries.

    v1 stored distances/speeds in metric with a `use_imperial` flag.
    v2 stores them in feet / mph and has no flag.
    """
    if entry.version > 2:
        return False

    if entry.version == 1:
        data = metric_to_imperial(dict(entry.data))
        data.pop("use_imperial", None)
        options = metric_to_imperial(dict(entry.options or {}))
        options.pop("use_imperial", None)
        hass.config_entries.async_update_entry(
            entry, data=data, options=options, version=2
        )
        _LOGGER.info("Life180 config entry migrated to version 2 (imperial units)")

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Life180 from a config entry."""

    # Merge data and options. Values are stored in imperial (feet / mph);
    # the pipeline works in metric.
    raw_config: Dict[str, Any] = {**entry.data, **entry.options} if entry.options else dict(entry.data)
    config: Dict[str, Any] = imperial_to_metric(raw_config)

    domain_data: Dict[str, Any] = hass.data.setdefault(DOMAIN, {})
    domain_data["config"] = config

    # ------------------------------------------------------------------ #
    #  1. Get the current version from manifest.json                     #
    # ------------------------------------------------------------------ #
    current_version: str | None = await get_version_from_manifest()
    if current_version is None:
        _LOGGER.error("Could not get version from manifest.json.")
        return False

    domain_data["version"] = current_version

    # ------------------------------------------------------------------ #
    #  2. Register static paths                                          #
    # ------------------------------------------------------------------ #
    await hass.http.async_register_static_paths([
        StaticPathConfig(url_path="/life180_static", path=str(STATIC_DIR), cache_headers=True),
    ])

    # ------------------------------------------------------------------ #
    #  3. Register REST views (once only)                                #
    # ------------------------------------------------------------------ #
    register_api_views(hass)

    # ------------------------------------------------------------------ #
    #  4. Register zones                                                 #
    # ------------------------------------------------------------------ #
    try:
        await register_zones(hass)
    except Exception as err:  # noqa: BLE001
        _LOGGER.error("Error while registering zones: %s", err)

    # ------------------------------------------------------------------ #
    #  5. Register the sidebar panel                                     #
    # ------------------------------------------------------------------ #
    await async_register_panel(
        hass=hass,
        frontend_url_path="life180",      # /life180
        webcomponent_name="life180-panel",      # <life180> (your custom element)
        module_url = f"{PANEL_URL}?v={hass.data[DOMAIN]['version']}",                                   # better with ?v= for cache-busting
        sidebar_title="Life180",
        sidebar_icon="mdi:at",
        require_admin=config.get("only_admin", False),
        # embed_iframe=False: the panel web component runs directly in the HA
        # frontend, so it (and the app iframe it creates) can read the live HA
        # theme. embed_iframe=True double-wraps in an empty iframe that has no
        # theme, which left the app stuck in light mode.
        embed_iframe=False,
    )

    # ------------------------------------------------------------------ #
    #  6. BLUEPRINTS                                                     #
    # ------------------------------------------------------------------ #
    async def _install_blueprint(_event=None):
        try:
            await _ensure_blueprint(hass)
        except Exception as err:
            _LOGGER.error("Failed to install blueprint: %s", err)

    if hass.state == CoreState.running:
        await _install_blueprint()
    else:
        # IMPORTANT: use async_listen_once (async callback) - no create_task from threads
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _install_blueprint)

    # ------------------------------------------------------------------ #
    #  7. Add the Lovelace resource (version + cache)                    #
    # ------------------------------------------------------------------ #
    async def _register_resources(_event=None):
        await _ensure_lovelace_resource(hass, CARD_URL)

    if hass.state == CoreState.running:
        await _ensure_lovelace_resource(hass, CARD_URL)
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _register_resources)

    # Listen for options changes
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))

    # ------------------------------------------------------------------ #
    #  8. Warm up the reverse-geocode cache                              #
    # ------------------------------------------------------------------ #
    await async_init_reverse_cache(hass)

    # ------------------------------------------------------------------ #
    #  9. Start the map-tile cache eviction task                         #
    # ------------------------------------------------------------------ #
    await async_init_tile_cache(hass)

    return True


# --------------------------------------------------------------------------- #
#  RELOAD / UNLOAD                                                            #
# --------------------------------------------------------------------------- #
async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the integration when options change from the UI."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, _entry: ConfigEntry) -> bool:
    """Fully uninstall the integration."""

    # Stop the map-tile cache eviction task
    async_stop_tile_cache(hass)

    # Remove zones
    await unregister_zones(hass)

    # Remove the custom panel
    try:
        await async_remove_panel(hass, "life180")
    except Exception as err:
        _LOGGER.error("Error removing Life180 panel: %s", err)

    # Remove the Lovelace resource
    await _remove_lovelace_resource(hass, CARD_URL)

    # Clear data
    hass.data.pop(DOMAIN, None)

    return True

# --------------------------------------------------------------------------- #
#  LOVELACE RESOURCE HANDLING                                                 #
# --------------------------------------------------------------------------- #
async def _ensure_lovelace_resource(
    hass: HomeAssistant,
    path: str,  # "/life180/life180-card.js"
) -> None:
    """Add or update a Lovelace resource without touching the others."""
    ll = hass.data.get("lovelace")
    resources: ResourceStorageCollection | None = getattr(ll, "resources", None)  # type: ignore[attr-defined]

    if resources is None:
        _LOGGER.warning("Lovelace resources not ready yet")
        return

    version = hass.data[DOMAIN].get("version", "0")
    expected_url = f"{path}?v={version}"

    # Every resource that is *exactly* that file
    matches = [it for it in resources.async_items() if _base(it["url"]) == path]

    if matches:
        # Keep the first one -> update it if needed
        main = matches[0]
        if main["url"] != expected_url:
            await resources.async_update_item(main["id"], {"url": expected_url})
        # Remove duplicates, if any
        for dup in matches[1:]:
            await resources.async_delete_item(dup["id"])
    else:
        # Does not exist yet -> create it
        await resources.async_create_item({"res_type": "module", "url": expected_url})

async def _remove_lovelace_resource(hass: HomeAssistant, path: str) -> None:
    resources = getattr(hass.data.get("lovelace"), "resources", None)
    if not resources:
        return

    ids_to_delete = [item["id"] for item in resources.async_items() if _base(item["url"]) == path]

    for res_id in ids_to_delete:
        await resources.async_delete_item(res_id)


# --------------------------------------------------------------------------- #
#  BLUEPRINTS                                                                 #
# --------------------------------------------------------------------------- #
async def _ensure_blueprint(hass: HomeAssistant) -> None:
    """Copy the bundled blueprint into the HA folder if missing or changed,
    without blocking the event loop."""
    # Path to the blueprint inside the integration package
    src_path = Path(__file__).parent / "blueprints" / "persons_in_zones_alert.yaml"

    # Destination folder (inside /config)
    bp_dir = Path(hass.config.path("blueprints/automation/life180"))
    # mkdir is I/O -> executor
    await hass.async_add_executor_job(partial(bp_dir.mkdir, parents=True, exist_ok=True))
    dest = bp_dir / src_path.name

    # Read the source (async)
    async with aiofiles.open(src_path, "r", encoding="utf-8") as f:
        yaml_text = await f.read()

    # Read the destination (async) if it exists; avoid the sync Path.exists()
    current: str | None = None
    try:
        async with aiofiles.open(dest, "r", encoding="utf-8") as f:
            current = await f.read()
    except FileNotFoundError:
        current = None

    if current != yaml_text:
        async with aiofiles.open(dest, "w", encoding="utf-8") as f:
            await f.write(yaml_text)

# --------------------------------------------------------------------------- #
#  UTILITIES                                                                  #
# --------------------------------------------------------------------------- #
async def get_version_from_manifest() -> str | None:
    """Read the version from manifest.json (async)."""
    manifest_path = Path(__file__).parent / "manifest.json"

    try:
        async with aiofiles.open(manifest_path, "r", encoding="utf-8") as file:
            manifest_data = await file.read()
        manifest_json = json.loads(manifest_data)
        return manifest_json.get("version")
    except (OSError, json.JSONDecodeError) as err:
        _LOGGER.error("Error reading manifest.json: %s", err)
        return None


def _base(u: str) -> str:
    """Return the URL without query or fragment."""
    parts = list(urlsplit(u))
    parts[3] = parts[4] = ""  # query, fragment
    return urlunsplit(parts)
