// utils/map.js
import { USE_MAP } from '../globals.js';

let _implPromise;
function _getImpl() {
    if (!_implPromise) {
        _implPromise = USE_MAP === '2D'
             ? import('./map2d.js')
             : import('./map3d.js');
    }
    return _implPromise;
}

export let map; // <- assigned after initMap()

export async function initMap(...args) {
    const m = await _getImpl();
    const result = await m.initMap?.(...args);
    // NOTE: update the export here so it stops being undefined
    map = m.map;
    return result ?? map;
}

// A helper to get the map guaranteed to be ready:
export async function getMap() {
    const m = await _getImpl();
    if (!m.map) {
        // if initMap has not been called yet, call it with no args
        await m.initMap?.();
    }
    map = m.map;
    return map;
}

// =====================
// Synchronous utilities
// =====================
export function isValidCoordinates(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng);
}
export function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000,
    toR = d => d * Math.PI / 180;
    const dLat = toR(lat2 - lat1),
    dLon = toR(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =====================
// Right-side gap (desktop only)
// =====================

// Breakpoint consistent with the CSS (<=600px is "mobile")
export function isSmallScreen() {
    return window.matchMedia?.('(max-width: 600px)').matches ?? false;
}

/**
 * Reads the panel width (when visible) and returns the "safe" right-side padding.
 * By default, on mobile it adds no margin (desktopOnly: true).
 */
export function getRightSafePadding(extra = 16, {
    desktopOnly = true
} = {}) {
    const small = isSmallScreen();
    if (desktopOnly && small) {
        return {
            panel: 0,
            right: 0,
            isMobile: true
        };
    }

    const panelEl = document.getElementById('forms-container');
    if (!panelEl)
        return {
            panel: 0,
            right: extra,
            isMobile: small
        };

    // On desktop: visible if it does NOT have .hidden
    // On mobile: visible only if it HAS .visible (per the CSS)
    const hiddenDesktop = panelEl.classList?.contains('hidden');
    const hiddenMobile = small && !panelEl.classList?.contains('visible');
    const isHidden = hiddenDesktop || hiddenMobile;

    const w = isHidden ? 0 : Math.round(panelEl.getBoundingClientRect().width || 0);
    return {
        panel: w,
        right: w + extra,
        isMobile: small
    };
}

// =====================
// Bounds and viewport helpers
// =====================

// Leaflet LatLngBounds / MapLibre LngLatBounds -> edges
function _getBoundsEdges(b) {
    const get = (fn, fallback) => (typeof b?.[fn] === 'function' ? b[fn]() : fallback);
    let west = get('getWest', b?._sw?.lng ?? b?._southWest?.lng ?? -180);
    let east = get('getEast', b?._ne?.lng ?? b?._northEast?.lng ?? 180);
    let south = get('getSouth', b?._sw?.lat ?? b?._southWest?.lat ?? -85);
    let north = get('getNorth', b?._ne?.lat ?? b?._northEast?.lat ?? 85);
    return {
        west,
        east,
        south,
        north
    };
}
function _lngSpan(west, east) {
    let span = east - west;
    if (span < 0)
        span += 360; // crossing the antimeridian
    return span;
}
function _mapSizePx() {
    const mapEl = document.getElementById('map');
    if (!mapEl)
        return {
            w: 1,
            h: 1
        };
    const r = mapEl.getBoundingClientRect();
    return {
        w: Math.max(1, Math.round(r.width)),
        h: Math.max(1, Math.round(r.height))
    };
}

// Viewport width/height (MapLibre or Leaflet)
function _getViewportWH() {
    if (map?._ml?.getContainer) {
        const c = map._ml.getContainer();
        return {
            w: c?.clientWidth || 0,
            h: c?.clientHeight || 0
        };
    }
    const s = map.getSize?.();
    return {
        w: s?.x || 0,
        h: s?.y || 0
    };
}

// Clamp the right padding (so it never "eats" the whole map)
function _safeRight(extraRight, {
    desktopOnly = true
} = {}) {
    const { w } = _getViewportWH();
    const { right, isMobile } = getRightSafePadding(extraRight, {
        desktopOnly
    });
    if (desktopOnly && isMobile)
        return 0;
    // always leave at least 48px of visible area
    return Math.max(0, Math.min(right, Math.max(0, w - 48)));
}

// Target (x,y) of the "visible center", accounting for the panel and fixed top/bottom
function _visibleTargetXY({
    extraRight = 16,
    desktopOnly = true,
    baseTop = 0,
    baseBottom = 0
}) {
    const { w, h } = _getViewportWH();
    const right = _safeRight(extraRight, {
        desktopOnly
    });
    const targetX = (w - right) / 2;
    const targetY = (baseTop || baseBottom)
     ? (baseTop + (h - baseTop - baseBottom) / 2)
     : (h / 2);
    return {
        targetX,
        targetY,
        right
    };
}

/**
 * Shifts the center "pxRight" pixels to the RIGHT (equivalent to panBy([pxRight,0])).
 * Uses Leaflet panBy if available. Otherwise approximates with a longitude change based on bounds and width.
 * (Kept as a fallback/utility in case it is needed elsewhere.)
 */
function _shiftCenterByPixels(pxRight, {
    animate = false
} = {}) {
    if (!map || !pxRight)
        return;

    // Leaflet: use panBy if available
    if (typeof map.panBy === 'function') {
        try {
            map.panBy([pxRight, 0], {
                animate
            });
        } catch {}
        return;
    }

    // Fallback (e.g. 3D shim): shift the center in longitude equivalent to those pixels
    try {
        const bounds = map.getBounds?.();
        const center = map.getCenter?.();
        const zoom = map.getZoom?.();
        if (!bounds || !center || zoom == null)
            return;

        const { west, east } = _getBoundsEdges(bounds);
        const { w } = _mapSizePx();
        const spanLng = _lngSpan(west, east);
        const dLngPerPx = spanLng / Math.max(1, w);
        const deltaLng = pxRight * dLngPerPx;

        const newCenter = {
            lat: center.lat,
            lng: center.lng + deltaLng
        };
        map.setView?.(newCenter, zoom, {
            animate
        });
    } catch { /* noop */
    }
}

// =====================
// Point focus with a right-side gap (desktop)
// =====================

/**
 * Centers a point, leaving a right-side gap on desktop ONLY.
 * On mobile it behaves as "always": no extra margin.
 */
export function focusPoint(point, {
    zoom = null,
    animate = false,
    extraRight = 16,
    desktopOnly = true,
    baseTop = 0, // if you have a fixed top bar, put its height here
    baseBottom = 0 // same for a fixed footer
} = {}) {
    if (!map)
        return;

    const latlng = Array.isArray(point) ? {
        lat: point[0],
        lng: point[1]
    }
     : point;

    // Compute the exact new center for both engines
    function computeNewCenter() {
        const { targetX, targetY } = _visibleTargetXY({
            extraRight,
            desktopOnly,
            baseTop,
            baseBottom
        });
        const { w, h } = _getViewportWH();
        if (!w || !h) {
            const z = map._ml ? (zoom ?? map._ml.getZoom()) : (zoom ?? map.getZoom?.());
            return {
                center: [latlng.lng, latlng.lat],
                zoom: z,
                dx: 0,
                dy: 0
            };
        }

        if (map._ml) {
            const ml = map._ml;
            const p = ml.project([latlng.lng, latlng.lat]);
            const c = {
                x: w / 2,
                y: h / 2
            };
            const dx = p.x - targetX,
            dy = p.y - targetY;
            const newCenterScreen = [c.x + dx, c.y + dy];
            const newC = ml.unproject(newCenterScreen);
            return {
                center: [newC.lng, newC.lat],
                zoom: (zoom ?? ml.getZoom()),
                dx,
                dy
            };
        }

        const p = map.latLngToContainerPoint(latlng);
        const c = map.latLngToContainerPoint(map.getCenter());
        const dx = p.x - targetX,
        dy = p.y - targetY;
        const newCenterPx = L.point(c.x + dx, c.y + dy);
        const newCenterLatLng = map.containerPointToLatLng(newCenterPx);
        return {
            center: [newCenterLatLng.lng, newCenterLatLng.lat],
            zoom: (zoom ?? map.getZoom?.()),
            dx,
            dy
        };
    }

    // Apply the center (per platform)
    function applyCenter(center, z, anim) {
        if (map._ml) {
            map._ml.easeTo({
                center,
                zoom: z,
                duration: anim ? 300 : 0
            });
        } else {
            // Leaflet expects [lat, lng]
            map.setView?.({
                lat: center[1],
                lng: center[0]
            }, z, {
                animate: anim
            });
        }
    }

    // 1) first pass
    const pass1 = computeNewCenter();
    applyCenter(pass1.center, pass1.zoom, animate);

    // 2) post-layout re-adjustments (in case the panel width changes)
    let attempts = 2;
    const EPS = 1; // pixels
    const reAdjust = () => {
        if (attempts-- <= 0)
            return;
        try {
            map.invalidateSize?.();
        } catch {}
        const pass = computeNewCenter();
        if (Math.abs(pass.dx) > EPS || Math.abs(pass.dy) > EPS) {
            applyCenter(pass.center, pass.zoom, animate);
            requestAnimationFrame(reAdjust);
        }
    };
    requestAnimationFrame(reAdjust);
}

// =====================
// fitBounds with safe asymmetric padding
// =====================

// Robust SW/NE extractor (does not fall back to world defaults)
function _extractSWNE(b) {
    if (!b)
        return null;

    // 1) typical APIs
    if (typeof b.getSouthWest === 'function' && typeof b.getNorthEast === 'function') {
        const sw = b.getSouthWest(),
        ne = b.getNorthEast();
        if (sw && ne && Number.isFinite(sw.lat) && Number.isFinite(sw.lng) && Number.isFinite(ne.lat) && Number.isFinite(ne.lng)) {
            return {
                sw: {
                    lat: sw.lat,
                    lng: sw.lng
                },
                ne: {
                    lat: ne.lat,
                    lng: ne.lng
                }
            };
        }
    }

    // 2) Props internas frecuentes (Leaflet/shims)
    const sw2 = b._southWest || b._sw;
    const ne2 = b._northEast || b._ne;
    if (sw2 && ne2 && Number.isFinite(sw2.lat) && Number.isFinite(sw2.lng) && Number.isFinite(ne2.lat) && Number.isFinite(ne2.lng)) {
        return {
            sw: {
                lat: sw2.lat,
                lng: sw2.lng
            },
            ne: {
                lat: ne2.lat,
                lng: ne2.lng
            }
        };
    }

    // 3) Formato plano { south, west, north, east }
    if (Number.isFinite(b.south) && Number.isFinite(b.west) && Number.isFinite(b.north) && Number.isFinite(b.east)) {
        return {
            sw: {
                lat: b.south,
                lng: b.west
            },
            ne: {
                lat: b.north,
                lng: b.east
            }
        };
    }

    // 4) Array de puntos [[lat,lng], ...] -> calculamos envolvente
    if (Array.isArray(b) && b.length) {
        let minLat = +Infinity,
        minLng = +Infinity,
        maxLat = -Infinity,
        maxLng = -Infinity;
        for (const p of b) {
            if (!Array.isArray(p) || p.length < 2)
                continue;
            let lat = Number(p[0]),
            lng = Number(p[1]);
            // Si parece [lng,lat], lo invertimos
            if (Math.abs(lat) > 90 && Math.abs(lng) <= 90)
                [lng, lat] = [lat, lng];
            if (!Number.isFinite(lat) || !Number.isFinite(lng))
                continue;
            if (lat < minLat)
                minLat = lat;
            if (lat > maxLat)
                maxLat = lat;
            if (lng < minLng)
                minLng = lng;
            if (lng > maxLng)
                maxLng = lng;
        }
        if (isFinite(minLat) && isFinite(minLng) && isFinite(maxLat) && isFinite(maxLng)) {
            return {
                sw: {
                    lat: minLat,
                    lng: minLng
                },
                ne: {
                    lat: maxLat,
                    lng: maxLng
                }
            };
        }
    }

    return null; // <- better to do nothing than to "jump" to the whole world
}

/**
 * Fits bounds, leaving a right-side margin on desktop ONLY.
 * On mobile it uses normal symmetric padding (right is clamped automatically).
 */
export function fitBoundsSafe(
    bounds, {
    animate = false,
    base = 24, // standard margin (px) where there is no panel
    extraRight = 16, // extra room to add to the panel width
    desktopOnly = true,
    baseTop = 0, // if you have a fixed header
    baseBottom = 0, // if you have a fixed footer
    refitAttempts = 2, // post-layout retries
} = {}) {
    if (!map)
        return;

    const doApply = () => {
        const { targetX, targetY, right } = _visibleTargetXY({
            extraRight,
            desktopOnly,
            baseTop,
            baseBottom
        });
        void targetX;
        void targetY; // (informational only; pads use right/top/bottom)

        const leftPad = base;
        const rightPad = base + right;
        const topPad = baseTop || base;
        const bottomPad = baseBottom || base;

        const swne = _extractSWNE(bounds);
        if (!swne)
            return false;

        // --- MAPLIBRE (3D) ---
        if (map._ml && (typeof map._ml.fitBounds === 'function' || typeof map._ml.cameraForBounds === 'function')) {
            const ml = map._ml;
            const bb = [[swne.sw.lng, swne.sw.lat], [swne.ne.lng, swne.ne.lat]];
            const padding = {
                left: leftPad,
                right: rightPad,
                top: topPad,
                bottom: bottomPad
            };

            try {
                const bearing = ml.getBearing?.() ?? 0;
                const pitch = ml.getPitch?.() ?? 0;

                // 1) Compute framing without perspective (pitch 0) for a "conservative" zoom/center
                if (typeof ml.cameraForBounds === 'function') {
                    const cam = ml.cameraForBounds(bb, {
                        padding,
                        bearing,
                        pitch: 0
                    });
                    (animate ? ml.easeTo : ml.jumpTo).call(ml, {
                        center: cam.center,
                        zoom: cam.zoom,
                        bearing,
                        pitch, // restore the real pitch
                        duration: animate ? 300 : 0
                    });
                } else {
                    ml.fitBounds(bb, {
                        padding,
                        duration: animate ? 300 : 0
                    });
                }

                // 2) Pixel post-adjustment: ensure the edges fit with the real paddings
                const fixEdges = (tries = 3) => {
                    const c = ml.getContainer?.();
                    const w = c?.clientWidth || 0;
                    if (!w)
                        return true;

                    const guard = 12; // small extra margin for the icon (~48px)
                    const leftLimit = leftPad + guard;
                    const rightLimit = w - (rightPad + guard);

                    // use the 4 corners of the bounds (covers 2 points left/right)
                    const pts = [
                        [swne.sw.lng, swne.sw.lat],
                        [swne.ne.lng, swne.ne.lat],
                        [swne.sw.lng, swne.ne.lat],
                        [swne.ne.lng, swne.sw.lat],
                    ];
                    let minX = Infinity,
                    maxX = -Infinity;
                    for (const [lng, lat] of pts) {
                        const p = ml.project([lng, lat]);
                        if (!p)
                            continue;
                        if (p.x < minX)
                            minX = p.x;
                        if (p.x > maxX)
                            maxX = p.x;
                    }
                    if (!isFinite(minX) || !isFinite(maxX))
                        return true;

                    // Errors (positive = outside)
                    const leftErr = Math.max(0, leftLimit - minX); // too far LEFT
                    const rightErr = Math.max(0, maxX - rightLimit); // too far RIGHT

                    if (leftErr === 0 && rightErr === 0)
                        return true;

                    if (leftErr > 0 && rightErr > 0) {
                        // both outside -> a touch of zoom-out and retry
                        ml.easeTo({
                            zoom: ml.getZoom() - 0.22,
                            duration: animate ? 180 : 0
                        });
                    } else if (leftErr > 0) {
                        // move content RIGHT on screen => pan LEFT (negative dx)
                        ml.panBy([-leftErr, 0], {
                            duration: animate ? 160 : 0
                        });
                    } else if (rightErr > 0) {
                        // move content LEFT on screen => pan RIGHT (positive dx)
                        ml.panBy([rightErr, 0], {
                            duration: animate ? 160 : 0
                        });
                    }

                    if (tries - 1 <= 0)
                        return true;
                    requestAnimationFrame(() => fixEdges(tries - 1));
                    return false;
                };

                if (animate)
                    setTimeout(() => requestAnimationFrame(() => fixEdges(3)), 320);
                else
                    requestAnimationFrame(() => fixEdges(3));

                return true;
            } catch {
                return false;
            }
        }

        // --- LEAFLET (2D) ---
        try {
            map.fitBounds(bounds, {
                paddingTopLeft: [leftPad, topPad],
                paddingBottomRight: [rightPad, bottomPad],
                animate
            });
            return true;
        } catch {
            return false;
        }
    };

    try {
        map.invalidateSize?.();
    } catch {}
    const ok = doApply();
    if (!ok)
        return;

    // Refit in 1-2 frames in case the panel width changes after opening
    let attempts = refitAttempts;
    const raf = () => {
        if (attempts-- <= 0)
            return;
        try {
            map.invalidateSize?.();
        } catch {}
        doApply();
        if (attempts > 0)
            requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
}
