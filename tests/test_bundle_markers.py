"""Guard the hand-patched production bundle against lost edits.

`www/dist/life180.js` has no build step: source changes are string-patched
into it, and it is a few very long lines, so a merge-conflict resolution can
silently drop one side's patch (0.6.0 → #69 lost the tile-token
transformRequest this way). Each marker below is a patch that must survive.
"""

from __future__ import annotations

import pytest

from conftest import REPO_ROOT

BUNDLE = (REPO_ROOT / "custom_components/life180/www/dist/life180.js").read_text(encoding="utf-8")

MARKERS = {
    "tile requests carry the HA token while the cache is on (#69)":
        'if(l180TileCache&&l180LastToken)return{url:f,headers:{Authorization:`Bearer ${l180LastToken}`}}',
    "other tile requests go straight to OSM, not via HA's no-referrer redirect":
        '{osm:"https://tile.openstreetmap.org/{z}/{x}/{y}.png"}[m[1]]',
    "the token is remembered from API calls (#69)": "l180LastToken=c,",
    "config reports the tile cache flag (#69)": "l180TileCache=e.map_cache_enabled===!0",
    "map search result shown as text, not HTML (#68)": ".setText(d.place_name",
    "slow config/admin refresh (#66)": "performance.now()-l180SlowAt>=3e5",
    "people table refreshes on tab switch (#66)":
        'tr.selected").forEach(a=>a.classList.remove("selected")),en()',
    "speed chart reads theme colours (#67)": "function l180ChartColors()",
}


@pytest.mark.parametrize("marker", MARKERS.values(), ids=list(MARKERS))
def test_bundle_keeps_patch(marker):
    assert marker in BUNDLE


def test_bundle_has_no_removed_code():
    for gone in ("vendor/leaflet", "select_color", 'h("layers")', ".setHTML(d.place_name"):
        assert gone not in BUNDLE, gone
