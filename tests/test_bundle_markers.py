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
    "map assets carry the HA token and go via the cache while it is on (#69)":
        'f.startsWith("https://tiles.openfreemap.org/"))return;return{url:`${te}/api/life180/tile/${f.slice(30)}`,headers:{Authorization:`Bearer ${l180LastToken}`}}',
    "the cache is skipped, not redirected, when off (no-referrer redirect)":
        '!(l180TileCache&&l180LastToken)||',
    "the token is remembered from API calls (#69)": "l180LastToken=c,",
    "config reports the tile cache flag (#69)": "l180TileCache=e.map_cache_enabled===!0",
    "map search result shown as text, not HTML (#68)": ".setText(d.place_name",
    "slow config/admin refresh (#66)": "performance.now()-l180SlowAt>=3e5",
    "people table refreshes on tab switch (#66)":
        'tr.selected").forEach(a=>a.classList.remove("selected")),en()',
    "speed chart reads theme colours (#67)": "function l180ChartColors()",
    "battery pill always shown over the avatar": '_mb=(_mv||i!=null)?',
    "low-battery people rows pulse red": 'f.classList.toggle("l180-row-low-battery"',
    "trips tab is rendered on filter (0.8.0)": 'l180Trips(Array.isArray(e)?[]:e?.trips||[])',
    "live ETA is estimated per person on the map (0.11.0)": 'l180Eta[t]=Ye(o,r)?null:l180Estimate(t,o,r,s)',
    "live ETA shows in the people table zone cell (0.11.0)": 'esc(v||l180EtaText(l))',
    "snapshot button is wired at startup (0.13.0)": 'await us(),l180SnapInit(),Xl()',
    "snapshot renders the map canvas plus people pins (0.13.0)": 'function l180SnapRender(){let m=A._ml',
    "snapshot download fallback shows a toast (0.13.1)": 'l180SnapToast(h("snapshot_saved"))',
    "battery chart is rendered on filter (0.10.0)": 'l180Battery(Array.isArray(e)?[]:e?.battery||[])',
    "frequent places are rendered on filter (0.9.0)": 'l180Places(Array.isArray(e)?[]:e?.places||[])',
    "add-zone can target a given point (0.9.0)": 'let n=l180At||A.getCenter()',
    "map has the auto-fit checkbox under search (0.15.0)": 'addControl(wn,"top-left"),b.addControl(new l180AutoFitCtl,"top-left")',
    "live refresh refits to everyone when auto-fit is on (0.15.0)": 'await l180AutoFitIfEnabled()}catch(e){throw console.error("Error updating devices:",e),e}}',
    "trips tab is cleared on filter reset (0.8.0)": 'l180ClearTrips(),l180ClearPlaces(),l180Battery([]);let n=',
}


@pytest.mark.parametrize("marker", MARKERS.values(), ids=list(MARKERS))
def test_bundle_keeps_patch(marker):
    assert marker in BUNDLE


def test_bundle_has_no_removed_code():
    for gone in ("vendor/leaflet", "select_color", 'h("layers")', ".setHTML(d.place_name"):
        assert gone not in BUNDLE, gone
