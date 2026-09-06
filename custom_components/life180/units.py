"""Unit conversion helpers.

The Life180 UI works entirely in imperial units (feet and mph), and the
config entry stores the values exactly as the user typed them. The position
pipeline, the geo maths and Home Assistant's zones all work in metric, so the
five distance/speed options are converted on the way in.
"""
from __future__ import annotations

M_PER_FOOT = 0.3048
KMH_PER_MPH = 1.609344

# Config keys held in imperial units -> factor that takes them to metric.
_TO_METRIC = {
    "geocode_distance": M_PER_FOOT,
    "stop_radius": M_PER_FOOT,
    "gps_accuracy": M_PER_FOOT,
    "anti_spike_radius": M_PER_FOOT,
    "max_speed": KMH_PER_MPH,
}


def imperial_to_metric(config: dict) -> dict:
    """Return a copy of *config* with the imperial keys converted to metric."""
    out = dict(config)
    for key, factor in _TO_METRIC.items():
        if out.get(key) is not None:
            try:
                out[key] = float(out[key]) * factor
            except (TypeError, ValueError):
                pass
    return out


def metric_to_imperial(config: dict) -> dict:
    """Inverse of :func:`imperial_to_metric`, used by the v1 -> v2 migration."""
    out = dict(config)
    for key, factor in _TO_METRIC.items():
        if out.get(key) is not None:
            try:
                out[key] = round(float(out[key]) / factor, 1)
            except (TypeError, ValueError):
                pass
    return out
