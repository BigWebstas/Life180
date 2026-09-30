"""Tests for `custom_components/life180/units.py`.

The UI is imperial but everything downstream is metric, so these conversions
sit on the path of every filter option. A silent error here would show up as
filters that "don't work" rather than as an exception, which is why the
round-trip is worth pinning down.
"""

from __future__ import annotations

import pytest

from conftest import units


def test_feet_to_meters_conversion():
    assert units.M_PER_FOOT == pytest.approx(0.3048)


def test_mph_to_kmh_conversion():
    assert units.KMH_PER_MPH == pytest.approx(1.609344)


@pytest.mark.parametrize(
    ("key", "imperial", "metric"),
    [
        ("geocode_distance", 100, 30.48),
        ("stop_radius", 50, 15.24),
        ("gps_accuracy", 200, 60.96),
        ("anti_spike_radius", 328, 99.9744),
        ("max_speed", 10, 16.09344),
    ],
)
def test_imperial_to_metric_known_values(key, imperial, metric):
    out = units.imperial_to_metric({key: imperial})
    assert out[key] == pytest.approx(metric)


def test_imperial_to_metric_leaves_other_keys_alone():
    config = {
        "update_interval": 10,
        "geocode_time": 30,
        "enable_debug": True,
        "only_admin": False,
    }
    assert units.imperial_to_metric(config) == config


def test_imperial_to_metric_does_not_mutate_input():
    config = {"stop_radius": 100}
    units.imperial_to_metric(config)
    assert config == {"stop_radius": 100}


def test_imperial_to_metric_accepts_numeric_strings():
    """Options flow stores values coerced to numbers, but be forgiving."""
    out = units.imperial_to_metric({"stop_radius": "100"})
    assert out["stop_radius"] == pytest.approx(30.48)


def test_imperial_to_metric_preserves_zero():
    """0 means "disabled" for several options and must survive, not be dropped."""
    out = units.imperial_to_metric({"anti_spike_radius": 0, "max_speed": 0})
    assert out["anti_spike_radius"] == 0
    assert out["max_speed"] == 0


def test_imperial_to_metric_passes_through_non_numeric():
    """Garbage in the entry should not raise; the caller falls back to a default."""
    out = units.imperial_to_metric({"stop_radius": "not-a-number"})
    assert out["stop_radius"] == "not-a-number"


def test_imperial_to_metric_skips_none():
    out = units.imperial_to_metric({"stop_radius": None})
    assert out["stop_radius"] is None


def test_metric_to_imperial_is_the_inverse():
    for key in units._TO_METRIC:
        original = 123
        metric = units.imperial_to_metric({key: original})
        # metric_to_imperial rounds to 1 decimal, so compare with tolerance.
        assert units.metric_to_imperial(metric)[key] == pytest.approx(original, abs=0.1)


def test_round_trip_preserves_typical_values():
    config = {
        "geocode_distance": 20,
        "stop_radius": 150,
        "gps_accuracy": 100,
        "anti_spike_radius": 328,
        "max_speed": 25,
    }
    assert units.metric_to_imperial(units.imperial_to_metric(config)) == config
