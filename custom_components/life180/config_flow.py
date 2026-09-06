# ./custom_components/life180/config_flow.py

from __future__ import annotations

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.config_entries import ConfigEntry
from homeassistant.data_entry_flow import section

DOMAIN = __package__.split(".")[-1]

# ---------------------------------------------------------------------------
#  Defaults y mínimos centralizados
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
}


def _validate_minimums(flat: dict) -> dict[str, str]:
    """Devuelve un dict de errores con claves por campo si no cumple el mínimo numérico."""
    errors: dict[str, str] = {}
    for key, minv in MINIMUMS.items():
        if key in flat:
            try:
                value = float(flat[key])
            except (TypeError, ValueError):
                # Deja que voluptuous marque error de tipo; aquí no añadimos error.
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

        # ---- Construcción de secciones (instalación con grupos) ----
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

        data_schema = vol.Schema({
            vol.Required("general"): section(general, {"collapsed": True}),
            vol.Required("geocoding"): section(geocoding, {"collapsed": True}),
            vol.Required("stops"): section(stops, {"collapsed": True}),
            vol.Required("accuracy"): section(accuracy, {"collapsed": True}),
            vol.Required("anti_spike"): section(anti_spike, {"collapsed": True}),
        })

        errors: dict[str, str] = {}

        if user_input is not None:
            # Aplana las secciones antes de validar/guardar
            flat: dict = {}
            for sec in ("general", "geocoding", "stops", "accuracy", "anti_spike"):
                flat.update(user_input.get(sec, {}))

            # Unique ID global (instancia única)
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured()

            # Validaciones personalizadas (solo mínimos numéricos)
            errors.update(_validate_minimums(flat))

            if not errors:
                return self.async_create_entry(title="Life180", data=flat)

            # Si hay errores, volver a mostrar formulario
            return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

        # Primer render del formulario
        return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

    async def async_step_import(self, user_input):
        """Soporta importaciones (p.ej. YAML) evitando duplicados."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        # Reutiliza la lógica de user (incluye validaciones y aplanado)
        return await self.async_step_user(user_input)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry):
        return Life180OptionsFlowHandler(config_entry)


# ---------------------------------------------------------------------------
#  Options Flow (un único formulario seccionado)
# ---------------------------------------------------------------------------
class Life180OptionsFlowHandler(config_entries.OptionsFlow):
    """Opciones agrupadas en secciones."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry
        self._opts = {
            **DEFAULTS,
            **(self._entry.data or {}),
            **(self._entry.options or {}),
        }

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            # Aplana secciones
            flat: dict = {}
            for sec in ("general", "geocoding", "stops", "accuracy", "anti_spike"):
                flat.update(user_input.get(sec, {}))

            errors: dict[str, str] = {}
            errors.update(_validate_minimums(flat))

            if errors:
                return self.async_show_form(
                    step_id="init",
                    data_schema=self._build_schema(),
                    errors=errors,
                )

            return self.async_create_entry(title="", data=flat)

        return self.async_show_form(
            step_id="init",
            data_schema=self._build_schema(),
            errors={},
        )

    def _build_schema(self) -> vol.Schema:
        """Construye el esquema con secciones y defaults actuales (sin Range para permitir errores personalizados)."""
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

        data_schema = {
            vol.Required("general"): section(general, {"collapsed": True}),
            vol.Required("geocoding"): section(geocoding, {"collapsed": True}),
            vol.Required("stops"): section(stops, {"collapsed": True}),
            vol.Required("accuracy"): section(accuracy, {"collapsed": True}),
            vol.Required("anti_spike"): section(anti_spike, {"collapsed": True}),
        }
        return vol.Schema(data_schema)
