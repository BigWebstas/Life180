"""Tests for `custom_components/life180/api/devices.py`.

Focus is the battery-resolution chain, because that is where the recent
per-request battery-sensor lookup was introduced and shipped without any
test coverage. `_battery_from_device_sensors` is exercised through both of
its call shapes (prebuilt index and per-device registry walk) and the two are
asserted to agree, since that equivalence is the whole correctness argument
for the optimisation.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import (
    USING_STUBS,
    FakeConfigEntry,
    FakeEntityRegistry,
    FakeHass,
    FakeRegistryEntry,
    FakeRequest,
    FakeState,
    FakeUser,
    devices,
)


def test_module_under_test_loaded_with_correct_domain():
    """Sanity check that the path-based loader produced a usable module.

    `DOMAIN` is derived from `__package__` at import time, so a wrong module
    name would silently produce the wrong domain rather than failing loudly.
    """
    assert devices.DOMAIN == "life180"
    assert callable(devices._normalize_battery)
    assert callable(devices._build_battery_sensor_index)


def test_homeassistant_import_resolved():
    """Either the real package or the stubs must be importable, never neither."""
    import homeassistant.components.http as http
    import homeassistant.helpers.entity_registry as er

    assert hasattr(http, "HomeAssistantView")
    assert hasattr(er, "async_entries_for_device")
    assert hasattr(er, "async_get")
    # Recorded so a failure here is explainable: True means the stubs are in use.
    assert isinstance(USING_STUBS, bool)


# --------------------------------------------------------------------------
# _normalize_battery
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Plain numbers pass through, rounded.
        (55, 55),
        (55.4, 55),
        (55.5, 56),
        (100, 100),
        # Strings, with and without decoration.
        ("42", 42),
        ("42%", 42),
        ("  42 %  ", 42),
        ("42 percent", 42),
        # A 0-1 fraction is scaled up to a percentage.
        (0.85, 85),
        ("0.5", 50),
        (1, 100),
        (1.0, 100),
        # 0 is a real reading and must not be treated as "missing".
        (0, 0),
        ("0%", 0),
        # Out of range is clamped rather than rejected.
        (140, 100),
        (-5, 0),
        # Sentinel / unusable values collapse to "".
        (None, ""),
        ("", ""),
        ("   ", ""),
        ("unknown", ""),
        ("None", ""),
        ("unavailable", ""),
        ("n/a", ""),
    ],
)
def test_normalize_battery(raw, expected):
    assert devices._normalize_battery(raw) == expected


def test_normalize_battery_returns_int_not_float():
    """The value is written into the API payload, so keep it an int."""
    assert isinstance(devices._normalize_battery("77.7"), int)


# --------------------------------------------------------------------------
# _battery_from_attrs
# --------------------------------------------------------------------------


def test_battery_from_attrs_picks_most_specific_key_first():
    attrs = {"battery_level": 90, "battery_percentage": 10}
    assert devices._battery_from_attrs(attrs) == 90


def test_battery_from_attrs_falls_through_unusable_value():
    """A present-but-unusable key must not shadow a usable lower-priority one."""
    attrs = {"battery_level": "unknown", "battery_percentage": 64}
    assert devices._battery_from_attrs(attrs) == 64


def test_battery_from_attrs_returns_empty_when_nothing_usable():
    assert devices._battery_from_attrs({"latitude": 1.0}) == ""
    assert devices._battery_from_attrs({"battery_level": "unknown"}) == ""


@pytest.mark.parametrize("key", devices._BATTERY_ATTR_KEYS)
def test_battery_from_attrs_recognises_every_known_key(key):
    """Every key in the tuple must actually be consulted.

    Guards against a key being added to `_BATTERY_ATTR_KEYS` without a test
    noticing, or removed from it silently.
    """
    assert devices._battery_from_attrs({key: 42}) == 42


def test_battery_attr_keys_precedence_is_documented_order():
    """The tuple is ordered most-specific-first, and the order is load-bearing."""
    assert devices._BATTERY_ATTR_KEYS == (
        "battery_level",
        "battery_percentage",
        "battery_percent",
        "batteryLevel",
        "battery",
        "bat",
    )
    # battery_level must win over the vaguer battery.
    assert devices._battery_from_attrs({"battery": 10, "battery_level": 90}) == 90
    # battery must win over the even vaguer bat.
    assert devices._battery_from_attrs({"bat": 10, "battery": 90}) == 90


# --------------------------------------------------------------------------
# _slugify_name
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Alice Phone", "alice_phone"),
        ("José Álvarez", "jose_alvarez"),  # accents are folded to ASCII
        ("dev/ice#1", "device1"),
        ("Bob's Car", "bobs_car"),  # apostrophe dropped, not replaced
        ("", ""),
    ],
)
def test_slugify_name(raw, expected):
    assert devices._slugify_name(raw) == expected


def test_slugify_name_does_not_strip_surrounding_whitespace():
    """Pinned current behaviour: runs of whitespace become underscores.

    The result is used to build `sensor.<slug>_battery_level` for the legacy
    battery guess, so a friendly name with a leading or trailing space yields a
    leading/trailing underscore and the guessed entity_id will not match.
    Not a regression -- this has always behaved this way -- but it is easy to
    "fix" without noticing the entity_id contract, so it is asserted here.
    """
    assert devices._slugify_name("  Bob's  Car ") == "_bobs_car_"


# --------------------------------------------------------------------------
# _battery_from_device_sensors -- the per-device registry walk
# --------------------------------------------------------------------------


def test_battery_from_device_sensors_reads_sensor_state():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.phone_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"sensor.phone_battery": "80"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone") == 80


def test_battery_from_device_sensors_ignores_other_devices():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.other_battery", device_id="dev2"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"sensor.other_battery": "80"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone") == ""


def test_battery_from_device_sensors_requires_sensor_prefix():
    """A battery-*looking* binary_sensor is not a sensor. and must be skipped."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("binary_sensor.phone_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"binary_sensor.phone_battery": "80"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone") == ""


def test_battery_from_device_sensors_skips_unavailable_state():
    ent_reg = FakeEntityRegistry(
        entries=[FakeRegistryEntry("sensor.phone_battery", device_id="dev1")],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"sensor.phone_battery": "unavailable"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone") == ""


def test_battery_from_device_sensors_returns_empty_without_device_id():
    """A tracker not tied to a device has no sibling sensors to look at."""
    ent_reg = FakeEntityRegistry(entries=[], tracker_devices={})
    assert devices._battery_from_device_sensors(FakeHass(), ent_reg, "device_tracker.orphan") == ""


# --------------------------------------------------------------------------
# Battery matching rules
# --------------------------------------------------------------------------


def _matches_battery_rule(entry) -> bool:
    """True when `_build_battery_sensor_index` would index this entry.

    Derived by observing the real function rather than restating its logic,
    so that the rule under test is the shipped one.
    """
    return bool(devices._build_battery_sensor_index(
        FakeEntityRegistry(entries=[entry], tracker_devices={})
    ).get("dev", []))


@pytest.mark.parametrize(
    ("entry", "expected"),
    [
        # Matched by original_device_class.
        (FakeRegistryEntry("sensor.cell_1", device_id="dev", original_device_class="battery"), True),
        # Matched by a device_class attribute.
        (FakeRegistryEntry("sensor.cell_2", device_id="dev", device_class="battery"), True),
        # Matched by the entity_id suffix conventions.
        (FakeRegistryEntry("sensor.phone_battery", device_id="dev"), True),
        (FakeRegistryEntry("sensor.phone_battery_level", device_id="dev"), True),
        # Not battery sensors.
        (FakeRegistryEntry("sensor.phone_signal", device_id="dev", original_device_class="signal_strength"), False),
        (FakeRegistryEntry("sensor.temp", device_id="dev"), False),
        # Wrong domain even if named like a battery.
        (FakeRegistryEntry("binary_sensor.phone_battery", device_id="dev"), False),
    ],
)
def test_battery_matching_rule(entry, expected):
    assert _matches_battery_rule(entry) is expected


# --------------------------------------------------------------------------
# _build_battery_sensor_index
# --------------------------------------------------------------------------


def test_index_groups_by_device_id():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.a_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.b_battery_level", device_id="dev1"),
            FakeRegistryEntry("sensor.c_battery", device_id="dev2"),
        ],
        tracker_devices={},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    assert sorted(index) == ["dev1", "dev2"]
    assert [e.entity_id for e in index["dev1"]] == ["sensor.a_battery", "sensor.b_battery_level"]
    assert [e.entity_id for e in index["dev2"]] == ["sensor.c_battery"]


def test_index_drops_entries_without_device_id():
    """No device_id means the entry cannot be attributed to any tracker."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.orphan_battery", device_id=None),
            FakeRegistryEntry("sensor.no_device_cell", device_id=None, original_device_class="battery"),
            FakeRegistryEntry("sensor.real_battery", device_id="dev1"),
        ],
        tracker_devices={},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    assert None not in index
    assert all(e.device_id for entries in index.values() for e in entries)


def test_index_omits_non_battery_entities():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.phone_signal", device_id="dev1", original_device_class="signal_strength"),
            FakeRegistryEntry("binary_sensor.phone_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.phone_battery", device_id="dev1"),
        ],
        tracker_devices={},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    indexed = {e.entity_id for entries in index.values() for e in entries}
    assert indexed == {"sensor.phone_battery"}


def test_index_preserves_registry_order():
    """Order matters: the first usable sensor in the list wins the value."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.a_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.b_battery", device_id="dev1"),
        ],
        tracker_devices={},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    assert [e.entity_id for e in index["dev1"]] == ["sensor.a_battery", "sensor.b_battery"]


def test_index_of_empty_registry_is_empty():
    assert devices._build_battery_sensor_index(FakeEntityRegistry(entries=[], tracker_devices={})) == {}


def test_none_device_id_lookup_returns_nothing():
    """Regression guard for the 0.5.0 battery regression.

    `_build_battery_sensor_index` originally iterated with
    `er.async_entries_for_device(ent_reg, None)` on the assumption that a None
    device_id meant "every entry". It does not: real HA looks entries up in its
    device_id index, so None matches nothing and the index came out empty,
    blanking the battery of every tracker whose battery lives on a sibling
    sensor -- notably the HA Companion app.

    This asserts the assumption itself is false, so no test double can quietly
    reintroduce it.
    """
    ent_reg = FakeEntityRegistry(
        entries=[FakeRegistryEntry("sensor.phone_battery", device_id="dev1")],
        tracker_devices={},
    )
    assert ent_reg.async_entries_for_device(None) == []
    assert ent_reg.async_entries_for_device(None, include_disabled_entities=False) == []


def test_index_is_populated_for_a_real_registry():
    """The index must actually contain entries, not be silently empty.

    This is the check whose absence let 0.5.0 ship: every battery lookup
    returned nothing and no test noticed, because the doubles agreed with the
    broken implementation.
    """
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.phone_battery", device_id="dev1"),
            FakeRegistryEntry(
                "sensor.watch_cell", device_id="dev2", original_device_class="battery"
            ),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    assert sorted(index) == ["dev1", "dev2"]


def test_index_is_empty_when_registry_has_no_battery_sensors():
    """A genuinely empty result is fine, and distinct from the broken lookup."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry(
                "sensor.phone_signal",
                device_id="dev1",
                original_device_class="signal_strength",
            ),
        ],
        tracker_devices={},
    )
    assert devices._build_battery_sensor_index(ent_reg) == {}


def test_index_excludes_disabled_entities():
    """Disabled battery sensors must not be offered as a battery source."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.enabled_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.disabled_battery", device_id="dev1", disabled_by="user"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    assert [e.entity_id for e in index["dev1"]] == ["sensor.enabled_battery"]
    hass = FakeHass({"sensor.enabled_battery": "10", "sensor.disabled_battery": "99"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", index) == 10


def test_index_prefers_enabled_sensor_over_disabled_one():
    """A disabled sensor earlier in the list must not shadow an enabled one."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.a_battery", device_id="dev1", disabled_by="integration"),
            FakeRegistryEntry("sensor.b_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    index = devices._build_battery_sensor_index(ent_reg)
    hass = FakeHass({"sensor.a_battery": "99", "sensor.b_battery": "10"})
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", index) == 10


# --------------------------------------------------------------------------
# The optimisation's invariant: prebuilt index == per-device registry walk
# --------------------------------------------------------------------------


# A registry mixing every matching rule, several devices, and decoys.
_MIXED_ENTRIES = [
    FakeRegistryEntry("sensor.phone_battery", device_id="dev1"),
    FakeRegistryEntry("sensor.tablet_battery_level", device_id="dev1"),
    FakeRegistryEntry("sensor.laptop_signal", original_device_class="signal_strength", device_id="dev1"),
    FakeRegistryEntry("binary_sensor.watch_battery", device_id="dev1"),
    FakeRegistryEntry("sensor.watch_cell", original_device_class="battery", device_id="dev2"),
    FakeRegistryEntry("sensor.car_battery", device_id="dev3"),
    FakeRegistryEntry("sensor.orphan_battery", device_id=None),
    FakeRegistryEntry("sensor.no_device_cell", original_device_class="battery", device_id=None),
]


_TRACKERS = {
    "device_tracker.phone": "dev1",
    "device_tracker.watch": "dev2",
    "device_tracker.car": "dev3",
    "device_tracker.orphan": None,
}


def test_prebuilt_index_matches_per_device_walk():
    """The two call shapes must agree for every tracker.

    This is the invariant the per-request index relies on. If it ever breaks,
    batteries silently disappear from the devices payload for exactly the users
    who have many devices -- which is who the optimisation targets.
    """
    ent_reg = FakeEntityRegistry(entries=_MIXED_ENTRIES, tracker_devices=_TRACKERS)
    hass = FakeHass(
        {
            "sensor.phone_battery": "80",
            "sensor.tablet_battery_level": "45",
            "sensor.watch_cell": "60",
            "sensor.car_battery": "unavailable",
        }
    )
    index = devices._build_battery_sensor_index(ent_reg)

    for tracker in _TRACKERS:
        via_walk = devices._battery_from_device_sensors(hass, ent_reg, tracker, None)
        via_index = devices._battery_from_device_sensors(hass, ent_reg, tracker, index)
        assert via_index == via_walk, f"mismatch for {tracker}"


def test_battery_lookup_prefers_first_sensor_in_registry_order():
    """Both shapes take the first matching sensor with a usable state."""
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.a_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.b_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"sensor.a_battery": "10", "sensor.b_battery": "90"})
    index = devices._build_battery_sensor_index(ent_reg)
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", index) == 10
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", None) == 10


def test_battery_lookup_skips_unusable_state_to_reach_next_sensor():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.a_battery", device_id="dev1"),
            FakeRegistryEntry("sensor.b_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass({"sensor.a_battery": "unavailable", "sensor.b_battery": "90"})
    index = devices._build_battery_sensor_index(ent_reg)
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", index) == 90
    assert devices._battery_from_device_sensors(hass, ent_reg, "device_tracker.phone", None) == 90


# --------------------------------------------------------------------------
# End-to-end through DevicesEndpoint.get()
# --------------------------------------------------------------------------
#
# The unit tests above pass the index in by hand. These drive the real endpoint
# so that the index it builds internally is covered too -- otherwise a change
# to the predicate or the prebuild inside `get()` would not fail anything,
# since the tests above would keep passing their own copy.


def _tracker(entity_id, friendly_name, **attrs):
    """Build a device_tracker state object shaped like `hass.states` returns.

    Defaults to valid coordinates so battery tests are not silently dropped by
    the endpoint's coordinate filter; the coordinate tests override them.
    """
    attributes = {"friendly_name": friendly_name, "latitude": 40.0, "longitude": -3.0}
    attributes.update(attrs)
    return FakeState("not_home", attributes=attributes)


def _call_endpoint(hass, ent_reg):
    """Run DevicesEndpoint.get() and return the decoded JSON payload."""
    request = FakeRequest(hass)
    # `er.async_get` is stubbed in conftest to return `hass.entity_registry`.
    hass.entity_registry = ent_reg
    endpoint = devices.DevicesEndpoint()
    result = asyncio.run(endpoint.get(request))
    # The stub HomeAssistantView.json returns ("json", data, status).
    kind, payload, status = result
    assert kind == "json"
    assert status == 200
    return payload


def test_endpoint_resolves_battery_from_same_device_sensor():
    """The shipped code path: battery found via the prebuilt per-request dict."""
    ent_reg = FakeEntityRegistry(
        entries=[FakeRegistryEntry("sensor.phone_battery", device_id="dev1")],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass(
        states={
            "device_tracker.phone": _tracker("device_tracker.phone", "Phone"),
            "sensor.phone_battery": "80",
        }
    )
    payload = _call_endpoint(hass, ent_reg)
    assert len(payload) == 1
    assert payload[0]["battery_level"] == 80
    # The attribute is backfilled so the frontend gets a rounded value.
    assert payload[0]["attributes"]["battery_level"] == 80
    assert payload[0]["attributes"]["battery_unit"] == "%"


def test_endpoint_battery_from_tracker_attribute_wins():
    """A battery on the tracker itself short-circuits the registry lookup."""
    ent_reg = FakeEntityRegistry(
        entries=[FakeRegistryEntry("sensor.phone_battery", device_id="dev1")],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass(
        states={
            "device_tracker.phone": _tracker("device_tracker.phone", "Phone", battery_level=55),
            "sensor.phone_battery": "80",
        }
    )
    payload = _call_endpoint(hass, ent_reg)
    assert payload[0]["battery_level"] == 55


def test_endpoint_does_not_borrow_battery_from_another_device():
    ent_reg = FakeEntityRegistry(
        entries=[FakeRegistryEntry("sensor.car_battery", device_id="dev2")],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass(
        states={
            "device_tracker.phone": _tracker("device_tracker.phone", "Phone"),
            "sensor.car_battery": "80",
        }
    )
    payload = _call_endpoint(hass, ent_reg)
    assert payload[0]["battery_level"] == ""


def test_endpoint_ignores_non_battery_sensors_on_same_device():
    ent_reg = FakeEntityRegistry(
        entries=[
            FakeRegistryEntry("sensor.phone_signal", original_device_class="signal_strength", device_id="dev1"),
            FakeRegistryEntry("binary_sensor.phone_battery", device_id="dev1"),
        ],
        tracker_devices={"device_tracker.phone": "dev1"},
    )
    hass = FakeHass(
        states={
            "device_tracker.phone": _tracker("device_tracker.phone", "Phone"),
            "sensor.phone_signal": "80",
            "binary_sensor.phone_battery": "80",
        }
    )
    payload = _call_endpoint(hass, ent_reg)
    assert payload[0]["battery_level"] == ""


def test_endpoint_battery_works_across_many_devices():
    """The N+1 case the optimisation targets: several trackers, one prebuild."""
    entries = [
        FakeRegistryEntry(f"sensor.d{i}_battery", device_id=f"dev{i}") for i in range(1, 6)
    ]
    trackers = {f"device_tracker.d{i}": f"dev{i}" for i in range(1, 6)}
    ent_reg = FakeEntityRegistry(entries=entries, tracker_devices=trackers)
    states = {f"device_tracker.d{i}": _tracker(f"device_tracker.d{i}", f"Dev {i}") for i in range(1, 6)}
    states.update({f"sensor.d{i}_battery": str(i * 20) for i in range(1, 6)})
    payload = _call_endpoint(FakeHass(states=states), ent_reg)
    assert [d["battery_level"] for d in payload] == [20, 40, 60, 80, 100]


def test_endpoint_filters_out_trackers_without_valid_coordinates():
    ent_reg = FakeEntityRegistry(entries=[], tracker_devices={})
    states = {
        "device_tracker.ok": _tracker("device_tracker.ok", "Ok", latitude=40.0, longitude=-3.0),
        "device_tracker.zero": _tracker("device_tracker.zero", "Zero", latitude=0.0, longitude=0.0),
        "device_tracker.bad": _tracker("device_tracker.bad", "Bad", latitude="x", longitude="y"),
        "device_tracker.oob": _tracker("device_tracker.oob", "Oob", latitude=999.0, longitude=0.0),
    }
    payload = _call_endpoint(FakeHass(states=states), ent_reg)
    assert [d["entity_id"] for d in payload] == ["device_tracker.ok"]


def _run_endpoint(hass, ent_reg, hass_user=None):
    """Call DevicesEndpoint.get() directly and return the raw json() tuple."""
    hass.entity_registry = ent_reg
    request = FakeRequest(hass, hass_user=hass_user)
    endpoint = devices.DevicesEndpoint()
    return asyncio.run(endpoint.get(request))


def test_endpoint_non_admin_gets_empty_list_when_only_admin():
    """Note: this endpoint returns 200 with an empty list, not 403.

    `filtered_positions` answers `self.json({"error": ...}, status_code=403)`
    for a non-admin, but `devices` answers a bare `self.json([])`. Both are
    legitimate; the point is that they differ, so it is pinned here.
    """
    ent_reg = FakeEntityRegistry(entries=[], tracker_devices={})
    entry = FakeConfigEntry(data={"only_admin": True})
    hass = FakeHass(
        states={"device_tracker.ok": _tracker("device_tracker.ok", "Ok", latitude=1.0, longitude=2.0)},
        config_entries=[entry],
    )
    kind, payload, status = _run_endpoint(hass, ent_reg, FakeUser(is_admin=False))
    assert status == 200
    assert payload == []


def test_endpoint_options_override_data_for_only_admin():
    """options wins over data, which is how the options flow persists changes."""
    ent_reg = FakeEntityRegistry(entries=[], tracker_devices={})
    entry = FakeConfigEntry(data={"only_admin": True}, options={"only_admin": False})
    hass = FakeHass(
        states={"device_tracker.ok": _tracker("device_tracker.ok", "Ok", latitude=1.0, longitude=2.0)},
        config_entries=[entry],
    )
    kind, payload, status = _run_endpoint(hass, ent_reg, FakeUser(is_admin=False))
    assert status == 200
    assert len(payload) == 1
