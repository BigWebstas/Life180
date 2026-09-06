"""Returns the Home Assistant persons."""

import logging

from homeassistant.components.http import HomeAssistantView

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)


class PersonsEndpoint(HomeAssistantView):
    """API endpoint that returns the persons."""

    url = "/api/life180/persons"
    name = "api:life180/persons"
    requires_auth = True

    async def get(self, request):
        """Return the Home Assistant persons (filtered by the 'person' domain)."""

        hass = request.app["hass"]

        # Only return data if the user is an admin or only_admin is false
        only_admin = False
        entries = hass.config_entries.async_entries(DOMAIN)
        if entries:  # There is normally only one entry
            entry = entries[0]
            only_admin = entry.options.get(
                "only_admin",
                entry.data.get("only_admin", False),
            )
        user = request["hass_user"]
        if only_admin and (user is None or not user.is_admin):
            return self.json([])

        persons = hass.states.async_all()

        person_data = []
        for person in persons:
            if not person.entity_id.startswith("person."):
                continue            
            attrs = dict(person.attributes)

            # Useful derived field (when lat/lon are present)
            lat = attrs.get("latitude")
            lon = attrs.get("longitude")
            has_location = False
            try:
                if lat is not None and lon is not None:
                    _lat = float(lat)
                    _lon = float(lon)
                    # Valid range
                    if -90.0 <= _lat <= 90.0 and -180.0 <= _lon <= 180.0:
                        # Treat only (0,0) as the null case
                        has_location = not (_lat == 0.0 and _lon == 0.0)
            except (TypeError, ValueError):
                has_location = False

            person_data.append(
                {
                    "entity_id": person.entity_id,
                    "state": person.state,
                    "attributes": attrs,
                    "has_location": has_location,
                    "last_updated": person.last_updated.isoformat()
                    if hasattr(person.last_updated, "isoformat")
                    else person.last_updated,
                    "last_changed": person.last_changed.isoformat()
                    if hasattr(person.last_changed, "isoformat")
                    else person.last_changed,
                }
            )

        return self.json(person_data)
