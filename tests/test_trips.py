"""Trip detection and driving-event counting in `filtered_positions`.

The module imports Home Assistant, aiohttp and dateutil at the top, none of
which the suite installs. They are replaced with mocks only for the duration of
the import; `_calc_trips` / `_trip_totals` themselves are pure.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from conftest import REPO_ROOT, units

T0 = datetime(2026, 10, 1, 8, 0, 0, tzinfo=timezone.utc)


def _load():
    dateutil = types.ModuleType("dateutil")
    dateutil.parser = types.SimpleNamespace(isoparse=datetime.fromisoformat)
    mocks = {name: MagicMock() for name in (
        "aiohttp", "homeassistant", "homeassistant.components",
        "homeassistant.components.http", "homeassistant.components.recorder",
        "homeassistant.components.recorder.history", "homeassistant.util",
    )}
    mocks["homeassistant.util"].dt = types.SimpleNamespace(
        as_utc=lambda d: d.astimezone(timezone.utc), DEFAULT_TIME_ZONE=timezone.utc)
    mocks["homeassistant.util.dt"] = mocks["homeassistant.util"].dt
    mocks["dateutil"] = dateutil
    mocks["dateutil.parser"] = dateutil.parser
    pkg = types.ModuleType("custom_components.life180")
    pkg.__path__ = []
    api = types.ModuleType("custom_components.life180.api")
    api.__path__ = []
    mocks["custom_components.life180"] = pkg
    mocks["custom_components.life180.api"] = api
    mocks["custom_components.life180.units"] = units
    name = "custom_components.life180.api.filtered_positions"
    with patch.dict(sys.modules, mocks):
        spec = importlib.util.spec_from_file_location(
            name, REPO_ROOT / "custom_components/life180/api/filtered_positions.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


fp = _load()

# ~111 m per 0.001 degree of latitude
LAT = 40.0


def _pt(sec, lat_m, speed):
    return {
        "last_updated": (T0 + timedelta(seconds=sec)).isoformat(),
        "attributes": {"latitude": LAT + lat_m / 111_000, "longitude": -75.0, "speed": speed},
    }


def _stop(start, leave, lat_m=0):
    return {
        "stop": True,
        "stop_duration_s": leave - start,
        "last_updated": (T0 + timedelta(seconds=start)).isoformat(),
        "stop_start": (T0 + timedelta(seconds=start)).isoformat(),
        "stop_end": (T0 + timedelta(seconds=leave)).isoformat(),
        "stop_leave": (T0 + timedelta(seconds=leave)).isoformat(),
        "stop_center_lat": LAT + lat_m / 111_000,
        "stop_center_lon": -75.0,
        "attributes": {"latitude": LAT + lat_m / 111_000, "longitude": -75.0},
    }


def test_trip_between_two_stops():
    positions = [
        _stop(0, 600),
        _pt(660, 500, 10.0),
        _pt(720, 1000, 12.0),
        _stop(900, 1800, lat_m=2000),
    ]
    (trip,) = fp._calc_trips(positions, [])
    assert trip["mode"] == "drive"
    assert trip["start_utc"] == (T0 + timedelta(seconds=600)).isoformat()
    assert trip["end_utc"] == (T0 + timedelta(seconds=900)).isoformat()
    assert trip["duration_s"] == 300
    assert trip["distance_m"] == pytest.approx(2000, rel=0.02)
    assert trip["max_speed_mps"] == 12.0


def test_walk_is_not_a_drive_and_counts_no_events():
    positions = [_pt(0, 0, 1.4), _pt(60, 100, 0.0), _pt(120, 200, 1.5)]
    (trip,) = fp._calc_trips(positions, [])
    assert trip["mode"] == "walk"
    assert trip["hard_braking"] == trip["hard_accel"] == 0


def _cruise_brake_accel():
    """70 s at 20 m/s, hard stop to 2 m/s, then hard pull-away back to 20 m/s."""
    speeds = [20.0] * 14 + [2.0, 20.0]
    return [_pt(5 * i, 100 * i, v) for i, v in enumerate(speeds)]


def test_hard_braking_and_acceleration():
    (trip,) = fp._calc_trips(_cruise_brake_accel(), [])
    assert trip["hard_braking"] == 1   # 20 -> 2 m/s in 5 s = 3.6 m/s^2
    assert trip["hard_accel"] == 1     # 2 -> 20 m/s in 5 s = 3.6 m/s^2


def test_sparse_samples_do_not_count_as_events():
    positions = [_pt(0, 0, 20.0), _pt(60, 800, 0.0), _pt(120, 1600, 20.0)]
    (trip,) = fp._calc_trips(positions, [])
    assert trip["hard_braking"] == trip["hard_accel"] == 0


def test_tiny_or_brief_movement_is_not_a_trip():
    assert fp._calc_trips([_pt(0, 0, 1.0), _pt(30, 50, 1.0)], []) == []


def test_totals():
    trips = fp._calc_trips(_cruise_brake_accel(), [])
    assert fp._trip_totals(trips) == {
        "trips_count": 1, "driving_trips_count": 1,
        "hard_braking_count": 1, "hard_accel_count": 1,
    }


def test_repeat_stops_outside_zones_become_a_place():
    positions = [
        _stop(0, 1800),
        _stop(5000, 8000, lat_m=30),       # same place, within 75 m
        _stop(10000, 10600, lat_m=5000),   # one-off elsewhere
    ]
    (place,) = fp._calc_places(positions, [])
    assert place["visits"] == 2
    assert place["total_s"] == 1800 + 3000


def test_stops_inside_a_zone_are_not_places():
    zone = {"name": "Home", "latitude": LAT, "longitude": -75.0, "radius_m": 100.0,
            "lat_min": LAT - 0.01, "lat_max": LAT + 0.01, "lon_min": -75.01, "lon_max": -74.99}
    positions = [_stop(0, 1800), _stop(5000, 8000)]
    assert fp._calc_places(positions, [zone]) == []


def _with_battery(sec, value):
    pt = _pt(sec, 0, 0.0)
    pt["attributes"]["battery_level"] = value
    return pt


def test_battery_series_keeps_changes_and_the_last_point():
    positions = [_with_battery(0, 80), _with_battery(60, 80), _with_battery(120, 79),
                 _with_battery(180, 79), _pt(240, 0, 0.0)]
    assert fp._calc_battery(positions) == [
        [T0.isoformat(), 80],
        [(T0 + timedelta(seconds=120)).isoformat(), 79],
        [(T0 + timedelta(seconds=180)).isoformat(), 79],
    ]


@pytest.mark.parametrize("raw, expected", [(85, 85), ("85%", 85), (0.85, 85), ("0.5", 50),
                                           (150, 100), ("n/a", None), (None, None)])
def test_battery_pct_normalisation(raw, expected):
    assert fp._battery_pct({"battery_level": raw}) == expected
