# ./custom_components/life180/config_flow.py

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.config_entries import ConfigEntry
from homeassistant.data_entry_flow import section

DOMAIN = __package__.split(".")[-1]

# ---------------------------------------------------------------------------
#  Centralized defaults and minimums
# ---------------------------------------------------------------------------
# Distances are in feet and speeds in mph. The pipeline converts them to
# metric (see units.py).
DEFAULTS = {
    "update_interval": 10,
    "geocode_time": 30,
    "geocode_distance": 66,
    "stop_radius": 100,
    "stop_time": 300,
    "reentry_gap": 60,
    "outside_gap": 300,
    "gps_accuracy": 50,
    "max_speed": 95,
    "anti_spike_factor_k": 3.0,
    "anti_spike_detour_ratio": 1.7,
    "anti_spike_radius": 100,
    "anti_spike_time": 600,
    "only_admin": False,
    "enable_debug": False,
    "map_cache_enabled": False,
    "map_cache_max_mb": 500,
    "map_cache_clear": False,
}

MINIMUMS = {
    "update_interval": 10,
    "geocode_time": 10,
    "geocode_distance": 66,
    "stop_radius": 0.0,
    "stop_time": 0,
    "reentry_gap": 0,
    "outside_gap": 0,
    "gps_accuracy": 33.0,
    "max_speed": 63.0,
    "anti_spike_factor_k": 1.5,
    "anti_spike_detour_ratio": 1.1,
    "anti_spike_radius": 0,
    "anti_spike_time": 0,
    "map_cache_max_mb": 50,
}


def _validate_minimums(flat: dict) -> dict[str, str]:
    """Return a per-field error dict for values below their numeric minimum."""
    errors: dict[str, str] = {}
    for key, minv in MINIMUMS.items():
        if key in flat:
            try:
                value = float(flat[key])
            except (TypeError, ValueError):
                # Let voluptuous flag the type error; we do not add one here.
                continue
            if value < float(minv):
                errors[key] = f"min_{key}"
    return errors


# ---------------------------------------------------------------------------
#  Config Flow
# ---------------------------------------------------------------------------
class Life180ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 2

    async def async_step_user(self, user_input=None):
        # --- Single instance guard ---
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        # ---- Build the sections (grouped install form) ----
        general = vol.Schema({
            vol.Required("update_interval", default=DEFAULTS["update_interval"]): vol.All(vol.Coerce(int)),
            vol.Required("only_admin", default=DEFAULTS["only_admin"]): bool,
            vol.Required("enable_debug", default=DEFAULTS["enable_debug"]): bool,
        })

        geocoding = vol.Schema({
            vol.Required("geocode_time", default=DEFAULTS["geocode_time"]): vol.All(vol.Coerce(int)),
            vol.Required("geocode_distance", default=DEFAULTS["geocode_distance"]): vol.All(vol.Coerce(int)),
        })

        stops = vol.Schema({
            vol.Required("stop_radius", default=DEFAULTS["stop_radius"]): vol.All(vol.Coerce(float)),
            vol.Required("stop_time", default=DEFAULTS["stop_time"]): vol.All(vol.Coerce(int)),
            vol.Required("reentry_gap", default=DEFAULTS["reentry_gap"]): vol.All(vol.Coerce(int)),
            vol.Required("outside_gap", default=DEFAULTS["outside_gap"]): vol.All(vol.Coerce(int)),
        })

        accuracy = vol.Schema({
            vol.Required("gps_accuracy", default=DEFAULTS["gps_accuracy"]): vol.All(vol.Coerce(float)),
            vol.Required("max_speed", default=DEFAULTS["max_speed"]): vol.All(vol.Coerce(float)),
        })

        anti_spike = vol.Schema({
            vol.Required("anti_spike_factor_k", default=DEFAULTS["anti_spike_factor_k"]): vol.All(vol.Coerce(float)),
            vol.Required("anti_spike_detour_ratio", default=DEFAULTS["anti_spike_detour_ratio"]): vol.All(vol.Coerce(float)),
            vol.Required("anti_spike_radius", default=DEFAULTS["anti_spike_radius"]): vol.All(vol.Coerce(int)),
            vol.Required("anti_spike_time", default=DEFAULTS["anti_spike_time"]): vol.All(vol.Coerce(int)),
        })

        map_cache = vol.Schema({
            vol.Required("map_cache_enabled", default=DEFAULTS["map_cache_enabled"]): bool,
            vol.Required("map_cache_max_mb", default=DEFAULTS["map_cache_max_mb"]): vol.All(vol.Coerce(int)),
            vol.Required("map_cache_clear", default=False): bool,
        })

        data_schema = vol.Schema({
            vol.Required("general"): section(general, {"collapsed": True}),
            vol.Required("geocoding"): section(geocoding, {"collapsed": True}),
            vol.Required("stops"): section(stops, {"collapsed": True}),
            vol.Required("accuracy"): section(accuracy, {"collapsed": True}),
            vol.Required("anti_spike"): section(anti_spike, {"collapsed": True}),
            vol.Required("map_cache"): section(map_cache, {"collapsed": True}),
        })

        errors: dict[str, str] = {}

        if user_input is not None:
            # Flatten the sections before validating/saving
            flat: dict = {}
            for sec in ("general", "geocoding", "stops", "accuracy", "anti_spike", "map_cache"):
                flat.update(user_input.get(sec, {}))

            # Global unique ID (single instance)
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured()

            # Custom validation (numeric minimums only)
            errors.update(_validate_minimums(flat))

            # "Clear cached tiles now" is a one-shot action, never persisted.
            flat["map_cache_clear"] = False

            if not errors:
                return self.async_create_entry(title="Life180", data=flat)

            # On errors, show the form again
            return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

        # First render of the form
        return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

    async def async_step_import(self, user_input):
        """Support imports (e.g. YAML) while avoiding duplicates."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        # Reuse the user step logic (includes validation and flattening)
        return await self.async_step_user(user_input)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry):
        return Life180OptionsFlowHandler(config_entry)


# ---------------------------------------------------------------------------
#  Options Flow (single sectioned form)
# ---------------------------------------------------------------------------
class Life180OptionsFlowHandler(config_entries.OptionsFlow):
    """Options grouped into sections."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry
        self._opts = {
            **DEFAULTS,
            **(self._entry.data or {}),
            **(self._entry.options or {}),
        }

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            # Flatten the sections
            flat: dict = {}
            for sec in ("general", "geocoding", "stops", "accuracy", "anti_spike", "map_cache"):
                flat.update(user_input.get(sec, {}))

            errors: dict[str, str] = {}
            errors.update(_validate_minimums(flat))

            if errors:
                return self.async_show_form(
                    step_id="init",
                    data_schema=self._build_schema(),
                    errors=errors,
                )

            # "Clear cached tiles now" is a one-shot action: run it here and
            # never persist the flag as True.
            if flat.get("map_cache_clear"):
                from .api.tiles import async_clear_tile_cache

                await async_clear_tile_cache(self.hass)
            flat["map_cache_clear"] = False

            return self.async_create_entry(title="", data=flat)

        return self.async_show_form(
            step_id="init",
            data_schema=self._build_schema(),
            errors={},
        )

    def _build_schema(self) -> vol.Schema:
        """Build the schema with sections and current defaults (no Range, so custom errors can be raised)."""
        general = vol.Schema({
            vol.Required("update_interval", default=self._opts["update_interval"]): vol.All(vol.Coerce(int)),
            vol.Required("only_admin", default=self._opts["only_admin"]): bool,
            vol.Required("enable_debug", default=self._opts["enable_debug"]): bool,
        })

        geocoding = vol.Schema({
            vol.Required("geocode_time", default=self._opts["geocode_time"]): vol.All(vol.Coerce(int)),
            vol.Required("geocode_distance", default=self._opts["geocode_distance"]): vol.All(vol.Coerce(int)),
        })

        stops = vol.Schema({
            vol.Required("stop_radius", default=self._opts["stop_radius"]): vol.All(vol.Coerce(float)),
            vol.Required("stop_time", default=self._opts["stop_time"]): vol.All(vol.Coerce(int)),
            vol.Required("reentry_gap", default=self._opts["reentry_gap"]): vol.All(vol.Coerce(int)),
            vol.Required("outside_gap", default=self._opts["outside_gap"]): vol.All(vol.Coerce(int)),
        })

        accuracy = vol.Schema({
            vol.Required("gps_accuracy", default=self._opts["gps_accuracy"]): vol.All(vol.Coerce(float)),
            vol.Required("max_speed", default=self._opts["max_speed"]): vol.All(vol.Coerce(float)),
        })

        anti_spike = vol.Schema({
            vol.Required("anti_spike_factor_k", default=self._opts["anti_spike_factor_k"]): vol.All(vol.Coerce(float)),
            vol.Required("anti_spike_detour_ratio", default=self._opts["anti_spike_detour_ratio"]): vol.All(vol.Coerce(float)),
            vol.Required("anti_spike_radius", default=self._opts["anti_spike_radius"]): vol.All(vol.Coerce(int)),
            vol.Required("anti_spike_time", default=self._opts["anti_spike_time"]): vol.All(vol.Coerce(int)),
        })

        map_cache = vol.Schema({
            vol.Required("map_cache_enabled", default=self._opts["map_cache_enabled"]): bool,
            vol.Required("map_cache_max_mb", default=self._opts["map_cache_max_mb"]): vol.All(vol.Coerce(int)),
            vol.Required("map_cache_clear", default=False): bool,
        })

        data_schema = {
            vol.Required("general"): section(general, {"collapsed": True}),
            vol.Required("geocoding"): section(geocoding, {"collapsed": True}),
            vol.Required("stops"): section(stops, {"collapsed": True}),
            vol.Required("accuracy"): section(accuracy, {"collapsed": True}),
            vol.Required("anti_spike"): section(anti_spike, {"collapsed": True}),
            vol.Required("map_cache"): section(map_cache, {"collapsed": True}),
        }
        return vol.Schema(data_schema)
