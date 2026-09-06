"""Returns the configuration stored in config_entries."""

import logging

from homeassistant.components.http import HomeAssistantView

from ..units import imperial_to_metric

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)


class ConfigEndpoint(HomeAssistantView):
    """Get the configuration stored in config_entries."""

    url = "/api/life180/config"
    name = "api:life180/config"
    requires_auth = True

    async def get(self, request):
        """Return the configuration stored in config_entries."""

        hass = request.app["hass"]

        config_entries = hass.config_entries.async_entries(DOMAIN)
        config_entry = next((entry for entry in config_entries), None)

        if not config_entry:
            error_response = {"error": "Configuration not found"}
            return self.json(error_response, status_code=404)

        # Values are stored in imperial; the frontend consumes them in metric.
        config = imperial_to_metric(
            {**config_entry.data, **config_entry.options}
            if config_entry.options
            else dict(config_entry.data)
        )

        version = (hass.data.get(DOMAIN) or {}).get("version", "0")

        return self.json(
            {
                "version": version,
                "update_interval": config.get("update_interval", 10),
                "geocode_time": config.get("geocode_time", 30),
                "geocode_distance": config.get("geocode_distance", 20),
                "enable_debug": config.get("enable_debug", False),
                # The UI is imperial. The frontend branching is removed separately.
                "use_imperial": True,
            }
        )
