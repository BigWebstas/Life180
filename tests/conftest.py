"""Test fixtures and Home Assistant stubs.

`custom_components/life180/api/devices.py` imports two things from Home
Assistant (`HomeAssistantView` and the entity registry helper) and nothing
else. Installing Home Assistant just to unit-test pure helpers like
`_normalize_battery` is not worth it, and `homeassistant` is not installable
on every Python version this project supports, so the two imports are stubbed
into `sys.modules` before the module under test is imported.

Anything that needs real entity-registry semantics is faked explicitly per
test with the small `FakeEntityRegistry` / `FakeState` helpers below rather
than being asserted against a stub.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

# Make the custom component importable as `custom_components.life180.*`,
# the same path HA itself uses when it loads the integration.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _install_homeassistant_stubs() -> bool:
    """Register minimal `homeassistant.*` modules in sys.modules.

    Returns False without touching anything if a real Home Assistant is
    installed, so the suite never silently shadows the genuine package on a
    developer machine that has it. `homeassistant` is not installable on every
    Python version, so the stubs are the normal path.

    Only the two names `devices.py` imports are provided.
    """
    import importlib.util

    if importlib.util.find_spec("homeassistant") is not None:
        return False

    ha = types.ModuleType("homeassistant")
    ha.__path__ = []  # mark as a package so submodule imports work
    components = types.ModuleType("homeassistant.components")
    components.__path__ = []
    http = types.ModuleType("homeassistant.components.http")
    helpers = types.ModuleType("homeassistant.helpers")
    helpers.__path__ = []
    entity_registry = types.ModuleType("homeassistant.helpers.entity_registry")

    class HomeAssistantView:  # noqa: D401 - mirrors the real base class
        """Stub for `homeassistant.components.http.HomeAssistantView`."""

        requires_auth = False
        url = None
        name = None

        def json(self, data, status_code=200, headers=None):
            """Stand-in for the real response builder."""
            return ("json", data, status_code)

    http.HomeAssistantView = HomeAssistantView

    def async_entries_for_device(registry, device_id, include_disabled_entities=True):
        """Stub: delegate to the registry object under test."""
        return registry.async_entries_for_device(
            device_id, include_disabled_entities=include_disabled_entities
        )

    entity_registry.async_entries_for_device = async_entries_for_device

    def async_get(hass):
        """Stub: return the entity registry carried by the fake `hass`."""
        return hass.entity_registry

    entity_registry.async_get = async_get

    for name, module in (
        ("homeassistant", ha),
        ("homeassistant.components", components),
        ("homeassistant.components.http", http),
        ("homeassistant.helpers", helpers),
        ("homeassistant.helpers.entity_registry", entity_registry),
    ):
        sys.modules.setdefault(name, module)

    return True


USING_STUBS = _install_homeassistant_stubs()


def _load_module_by_path(module_name: str, relative_path: str):
    """Import a single file as `module_name` without importing its parent packages.

    `custom_components/life180/__init__.py` pulls in `aiofiles` and the rest of
    the integration's runtime dependencies. The unit under test has no relative
    imports of its own, so it is loaded straight from its file to keep the
    suite free of the integration's install-time requirements. The name still
    has to look like `custom_components.life180.api.devices` because
    `DOMAIN = __package__.split(".")[-2]` is evaluated at import time.
    """
    import importlib.util

    path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


#: The `devices` module under test.
devices = _load_module_by_path(
    "custom_components.life180.api.devices",
    "custom_components/life180/api/devices.py",
)

#: The `units` module. Loaded by path too, since importing the package would
#: pull in the integration's runtime dependencies for a dependency-free module.
units = _load_module_by_path(
    "custom_components.life180.units",
    "custom_components/life180/units.py",
)


class FakeRegistryEntry:
    """Stand-in for `homeassistant.helpers.entity_registry.RegistryEntry`."""

    def __init__(
        self,
        entity_id,
        device_id=None,
        original_device_class=None,
        device_class=None,
        disabled=False,
    ):
        self.entity_id = entity_id
        self.device_id = device_id
        self.original_device_class = original_device_class
        # Real registry entries do not always expose `device_class`, so this
        # stays absent-able to exercise the getattr() fallback.
        if device_class is not None:
            self.device_class = device_class
        # Lets the `include_disabled_entities` flag actually mean something.
        self.disabled = disabled


class FakeEntityRegistry:
    """Stand-in for the entity registry, supporting the two calls devices.py makes."""

    def __init__(self, entries, tracker_devices=None):
        # entries: list[FakeRegistryEntry]
        self._entries = entries
        # tracker_devices: {tracker_entity_id: device_id}
        self._tracker_devices = tracker_devices or {}

    def async_get(self, entity_id):
        device_id = self._tracker_devices.get(entity_id)
        if device_id is None:
            return None
        return FakeRegistryEntry(entity_id=entity_id, device_id=device_id)

    def async_entries_for_device(self, device_id, include_disabled_entities=True):
        pool = self._entries
        if not include_disabled_entities:
            pool = [e for e in pool if not getattr(e, "disabled", False)]
        if device_id is None:
            return list(pool)
        return [e for e in pool if e.device_id == device_id]


class FakeState:
    """Stand-in for a `hass.states` state object.

    Real HA states carry `entity_id` alongside `state`/`attributes`; it is
    stamped in by `_FakeStates` from the key the state was stored under.
    """

    def __init__(self, state, attributes=None, last_updated=None, last_changed=None, entity_id=None):
        self.state = state
        self.attributes = attributes or {}
        self.last_updated = last_updated
        self.last_changed = last_changed
        self.entity_id = entity_id


class _FakeStates:
    """Stand-in for `hass.states`."""

    def __init__(self, states):
        self._states = {}
        for entity_id, value in (states or {}).items():
            if isinstance(value, FakeState):
                value.entity_id = value.entity_id or entity_id
                self._states[entity_id] = value
            else:
                # Accept a bare value for convenience: it becomes a state string
                # with no attributes.
                self._states[entity_id] = FakeState(value, entity_id=entity_id)

    def get(self, entity_id):
        return self._states.get(entity_id)

    def async_all(self, domain):
        return [s for eid, s in self._states.items() if eid.startswith(f"{domain}.")]


class FakeConfigEntry:
    """Stand-in for a config entry, split into `.data` and `.options` like HA's."""

    def __init__(self, data=None, options=None):
        self.data = data or {}
        self.options = options or {}


class _FakeConfigEntries:
    def __init__(self, entries):
        self._entries = entries

    def async_entries(self, domain):
        return self._entries


class FakeHass:
    """Minimal `hass` stand-in exposing `.states`, `.config_entries`, and the registry."""

    def __init__(self, states=None, config_entries=None, entity_registry=None):
        self.states = _FakeStates(states or {})
        self.config_entries = _FakeConfigEntries(config_entries or [])
        self.entity_registry = entity_registry


class FakeRequest:
    """Stand-in for an aiohttp request as handed to a `HomeAssistantView`."""

    def __init__(self, hass, hass_user=None, query=None):
        self.app = {"hass": hass}
        self._hass_user = hass_user if hass_user is not None else FakeUser(is_admin=True)
        self.query = query or {}

    def __getitem__(self, key):
        # The endpoint reads request["hass_user"].
        if key == "hass_user":
            return self._hass_user
        raise KeyError(key)


class FakeUser:
    def __init__(self, is_admin=True):
        self.is_admin = is_admin
