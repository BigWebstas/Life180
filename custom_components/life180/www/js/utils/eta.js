// ./utils/eta.js
// Straight-line ETA for a moving person: which saved zone they are heading
// towards, and roughly how long until they reach its edge. There is no routing
// data, so distance is inflated by a fixed road factor.

import { getDistanceFromLatLonInMeters } from './map.js';

const MIN_MOVE_M = 25;           // heading is re-measured after moving this far
const MIN_SPEED_MPS = 1.34;      // ~3 mph: slower than this is not "on the way"
const MAX_HEADING_DIFF_DEG = 40; // a zone must be this close to straight ahead
const ROAD_FACTOR = 1.3;         // roads are longer than the crow flies
const MAX_RANGE_M = 160000;
const SPEED_SMOOTHING = 0.3;     // weight of the newest speed sample

function bearing(lat1, lon1, lat2, lon2) {
    const r = d => d * Math.PI / 180;
    const y = Math.sin(r(lon2 - lon1)) * Math.cos(r(lat2));
    const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(r(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * `track` is the person's own state object (mutated across calls).
 * Returns { name, seconds, meters } for the nearest zone dead ahead, else null.
 */
export function estimateEta(track, lat, lon, speedMps, zones) {
    const speed = Number(speedMps) || 0;
    track.speed = track.speed == null ? speed : track.speed + (speed - track.speed) * SPEED_SMOOTHING;

    if (!track.anchor) {
        track.anchor = { lat, lon };
    } else if (getDistanceFromLatLonInMeters(track.anchor.lat, track.anchor.lon, lat, lon) >= MIN_MOVE_M) {
        track.heading = bearing(track.anchor.lat, track.anchor.lon, lat, lon);
        track.anchor = { lat, lon };
    }
    if (track.heading == null || track.speed < MIN_SPEED_MPS) return null;

    let best = null;
    for (const z of zones) {
        if (z.visible === false || z.passive) continue;
        const meters = getDistanceFromLatLonInMeters(lat, lon, z.latitude, z.longitude) - (Number(z.radius) || 0);
        if (meters <= 0 || meters > MAX_RANGE_M || (best && meters >= best.meters)) continue;
        const diff = Math.abs(((bearing(lat, lon, z.latitude, z.longitude) - track.heading + 540) % 360) - 180);
        if (diff <= MAX_HEADING_DIFF_DEG) best = { name: z.name, meters };
    }
    return best && { ...best, seconds: Math.round(best.meters * ROAD_FACTOR / track.speed) };
}
