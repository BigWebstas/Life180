"""Used to tell whether a user is an administrator."""

import logging

from homeassistant.components.http import HomeAssistantView

DOMAIN = __package__.split(".")[-2]

_LOGGER = logging.getLogger(__name__)


class IsAdminEndpoint(HomeAssistantView):
    """API endpoint that reports whether a user is an admin."""

    url = "/api/life180/is_admin"
    name = "api:life180/is_admin"
    requires_auth = True

    async def get(self, request):
        """Return whether the requesting user is an administrator."""
        hass_user = request["hass_user"]
        if hass_user is None:
            error_msg = {"error": "User not authenticated"}
            return self.json(error_msg, status_code=401)

        return self.json({"is_admin": hass_user.is_admin})
