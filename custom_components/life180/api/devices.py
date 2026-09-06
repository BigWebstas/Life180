"""Returns the Home Assistant device_tracker entities."""

import logging
import re
import unicodedata

from homeassistant.components.http import HomeAssistantView
from homeassistant.helpers import entity_registry as er

# Attribute keys that may carry a battery level, most specific first.
_BATTERY_ATTR_KEYS = (
    "battery_level",
    "battery_percentage",
    "battery_percent",
    "batteryLevel",
    "battery",
    "bat",
)

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)


def _slugify_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^a-z0-9_]+", "", s)
    return s
    
    
def _normalize_battery(raw):
    """Return a rounded battery value 0-100 (int) or '' when there is no valid data."""
    if raw is None:
        return ""
    s = str(raw).strip().lower()
    if s in ("unknown", "none", "unavailable", ""):
        return ""

    # Strip the % sign and extract the first valid number
    s = s.replace("%", "")
    m = re.search(r'[-+]?\d*\.?\d+', s)
    if not m:
        return ""
    try:
        val = float(m.group())
    except (TypeError, ValueError):
        return ""

    # If it looks like a fraction (0-1), scale it to a percentage
    if 0 < val <= 1:
        val *= 100.0

    # Clamp and round
    val = max(0.0, min(100.0, val))
    return int(round(val))


def _battery_from_attrs(attributes):
    """First numeric battery value found among the known attribute keys, or ''."""
    for key in _BATTERY_ATTR_KEYS:
        if key in attributes:
            level = _normalize_battery(attributes.get(key))
            if level != "":
                return level
    return ""


def _battery_from_device_sensors(hass, ent_reg, tracker_entity_id):
    """Look for a battery sensor on the same registry device as the tracker."""
    try:
        reg_entry = ent_reg.async_get(tracker_entity_id)
        if not reg_entry or not reg_entry.device_id:
            return ""
        for entry in er.async_entries_for_device(
            ent_reg, reg_entry.device_id, include_disabled_entities=False
        ):
            if not entry.entity_id.startswith("sensor."):
                continue
            is_battery = (
                entry.original_device_class == "battery"
                or getattr(entry, "device_class", None) == "battery"
                or entry.entity_id.endswith(("_battery_level", "_battery"))
            )
            if not is_battery:
                continue
            state = hass.states.get(entry.entity_id)
            if state:
                level = _normalize_battery(state.state)
                if level != "":
                    return level
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("battery sensor lookup failed for %s: %s", tracker_entity_id, err)
    return ""
    

class DevicesEndpoint(HomeAssistantView):
    """API endpoint that returns the filtered device_tracker entities."""

    url = "/api/life180/devices"
    name = "api:life180/devices"
    requires_auth = True

    async def get(self, request):
        """Return device_tracker entities with valid, in-range lat/lon, excluding (0,0)."""

        hass = request.app["hass"]

        # Only return data if the user is an admin or only_admin is false
        only_admin = False
        entries = hass.config_entries.async_entries(DOMAIN)
        if entries:                             # There is normally only one entry
            entry = entries[0]
            only_admin = entry.options.get(
                "only_admin",
                entry.data.get("only_admin", False),
            )
        user = request["hass_user"]             
        if only_admin and (user is None or not user.is_admin):
            return self.json([])        
        
        
        devices = hass.states.async_all("device_tracker")
        ent_reg = er.async_get(hass)
        device_data = []

        for device in devices:
            lat = device.attributes.get("latitude")
            lon = device.attributes.get("longitude")

            # Validate the range and discard only (0,0)
            try:
                lat_val = float(lat)
                lon_val = float(lon)
            except (TypeError, ValueError):
                # Discard entries that cannot be converted to a number
                continue

            if not (-90.0 <= lat_val <= 90.0 and -180.0 <= lon_val <= 180.0):
                continue
            if lat_val == 0.0 and lon_val == 0.0:
                continue

            # ---- Optional extra data ----
            name = device.attributes.get("friendly_name", "")
            friendly_name = _slugify_name(name)
            
            attrs = dict(device.attributes)
            
            # velocity / speedMps -> speed (m/s)
            if "speed" not in attrs:
                # Preferred: speedMps (already in m/s)
                if "speedMps" in attrs:
                    try:
                        attrs["speed"] = round(float(attrs["speedMps"]), 2)
                    except (TypeError, ValueError):
                        pass
                # Fallback: OwnTracks "velocity" (km/h -> m/s)
                elif "velocity" in attrs:
                    try:
                        attrs["speed"] = round(float(attrs.pop("velocity")) / 3.6, 2)
                    except (TypeError, ValueError):
                        pass

            # Normalize "speed": clamp negatives to 0.0
            try:
                spd_val = float(attrs.get("speed"))
                if spd_val < 0:
                    attrs["speed"] = 0.0
            except (TypeError, ValueError):
                # No "speed" or not numeric -> leave it as is
                pass


            # --- Battery: rounding and normalization ---
            # 1) A numeric battery attribute on the tracker itself.
            battery_level = _battery_from_attrs(device.attributes)

            # 2) A battery sensor on the same registry device (covers the HA
            #    Companion app, whose tracker has no battery attribute).
            if battery_level == "":
                battery_level = _battery_from_device_sensors(
                    hass, ent_reg, device.entity_id
                )

            # 3) Legacy guess: sensor.<slugified friendly name>_battery_level.
            if battery_level == "" and friendly_name:
                batt_state = hass.states.get(
                    f"sensor.{friendly_name}_battery_level"
                )
                if batt_state:
                    battery_level = _normalize_battery(batt_state.state)

            # (Optional) Also update the attribute so it appears rounded in "attributes"
            if battery_level != "":
                attrs["battery_level"] = battery_level
                attrs["battery_unit"] = "%"
                    

            device_data.append(
                {
                    "entity_id": device.entity_id,
                    "state": device.state,
                    "attributes": attrs,
                    "last_updated": device.last_updated.isoformat() if hasattr(device.last_updated, "isoformat") else device.last_updated,
                    "last_changed": device.last_changed.isoformat() if hasattr(device.last_changed, "isoformat") else device.last_changed,
                    "battery_level": battery_level,
                }
            )

        return self.json(device_data)

