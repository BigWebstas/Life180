//
// geocode.js
// Reverse-geocoding with an LRU cache, a queue (limited concurrency) and backoff.
// Also retries when a 200 comes back without a usable address.
// Use it to convert (lat,lon,ts) -> address.
//

import { fetchReverseGeocode } from '../ha/fetch.js';

// ---------- Config ----------
let POS_CACHE_MAX = 400; // LRU cache keyed by uniqueId
let RG_MAX = 4; // max concurrency
let MAX_EMPTY_RETRIES = 2; // extra retries when a 200 arrives with no address

export function setGeocodeCacheSize(n) {
    POS_CACHE_MAX = Math.max(50, Number(n) || POS_CACHE_MAX);
}
export function setGeocodeConcurrency(n) {
    RG_MAX = Math.max(1, Number(n) || RG_MAX);
}
export function setGeocodeEmptyRetries(n) {
    MAX_EMPTY_RETRIES = Math.max(0, Number(n) || MAX_EMPTY_RETRIES);
}

// ---------- Key helpers ----------
const DECIMALS = 4; // same as the backend
const posKey = (lat, lon, tsMs) => `${Number(lat).toFixed(DECIMALS)},${Number(lon).toFixed(DECIMALS)},${Number(tsMs)}`;
const coordKey = (lat, lon) => `${Number(lat).toFixed(DECIMALS)},${Number(lon).toFixed(DECIMALS)}`;

// ---------- Caches ----------
const posCache = new Map(); // uniqueId -> { key, address }
const coordAddrCache = new Map(); // "lat,lon" -> address (non-empty only)
const coordInFlight = new Map(); // "lat,lon" -> Promise<any>

// ---------- State per uniqueId ----------
const wanted = new Map(); // uniqueId -> key
const inFlight = new Map(); // uniqueId -> key
const retryCount = new Map(); // uniqueId -> n

function lruPut(id, val) {
    if (posCache.has(id))
        posCache.delete(id);
    posCache.set(id, val);
    if (posCache.size > POS_CACHE_MAX) {
        const first = posCache.keys().next().value;
        posCache.delete(first);
    }
}
function resetRetry(id) {
    retryCount.delete(id);
}
function scheduleRetry(id, baseMs, cb) {
    const n = (retryCount.get(id) || 0) + 1;
    retryCount.set(id, n);
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(8000, Math.max(300, baseMs) * Math.pow(1.6, n)) + jitter;
    setTimeout(cb, delay);
}

// ---------- Mini concurrency pool ----------
let active = 0, q = [];
function run(task) {
    return new Promise((res, rej) => {
        q.push({
            task,
            res,
            rej
        });
        pump();
    });
}
function pump() {
    while (active < RG_MAX && q.length) {
        const { task, res, rej } = q.shift();
        active++;
        task().then(res, rej).finally(() => {
            active--;
            pump();
        });
    }
}

// ---------- API ----------
/**
 * Resolves the address for (lat,lon,tsMs) and delivers it to onAddress(address:string).
 * uniqueId: unique per "logical row"; includes the timestamp (e.g. `${rowId}_${tsMs}`).
 */
// Helper: store the address in the DOM data- attributes (when those rows exist)
function persistAddressToDom(uniqueId, addr) {
    try {
        const main = document.querySelector(`tr.pos-main-row[data-entity-id="${uniqueId}"]`);
        if (main)
            main.dataset.address = addr || '';

        const addrRow = document.querySelector(`tr.position-address-row[data-entity-id="${uniqueId}"]`);
        if (addrRow)
            addrRow.dataset.address = addr || '';
    } catch (e) {
        // ignore DOM errors
    }
}

export async function requestAddress(uniqueId, lat, lon, tsMs, onAddress) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(tsMs))
        return;

    const key = posKey(lat, lon, tsMs);
    wanted.set(uniqueId, key);

    // cache keyed by uniqueId (valid only when the key matches)
    const hit = posCache.get(uniqueId);
    if (hit?.key === key) {
        const addr = hit.address || '';
        onAddress?.(addr);
        persistAddressToDom(uniqueId, addr);
        wanted.delete(uniqueId);
        resetRetry(uniqueId);
        return;
    }

    // avoid exact duplicates per uniqueId
    if (inFlight.get(uniqueId) === key)
        return;
    inFlight.set(uniqueId, key);

    const scheduleRetryIfWanted = (ms) => {
        if (inFlight.get(uniqueId) === key)
            inFlight.delete(uniqueId);
        scheduleRetry(uniqueId, ms, () => {
            if (wanted.get(uniqueId) === key)
                requestAddress(uniqueId, lat, lon, tsMs, onAddress);
        });
    };

    const cKey = coordKey(lat, lon);

    try {
        // Reuse the per-coordinate address if it already exists (we only store non-empty ones)
        if (coordAddrCache.has(cKey)) {
            const addr = coordAddrCache.get(cKey) || '';
            lruPut(uniqueId, {
                key,
                address: addr
            });
            if (wanted.get(uniqueId) === key) {
                onAddress?.(addr);
                persistAddressToDom(uniqueId, addr);
                wanted.delete(uniqueId);
                resetRetry(uniqueId);
            }
            return;
        }

        // If there is a request in flight for that coordinate, join it
        if (coordInFlight.has(cKey)) {
            const data = await coordInFlight.get(cKey);
            if (wanted.get(uniqueId) !== key)
                return;

            // Transient states with Retry-After
            if (data?.error === 'queued' && Number.isFinite(data?.retry_after)) {
                scheduleRetryIfWanted(data.retry_after * 1000);
                return;
            }
            if (['temporarily_unavailable', 'rate_limited', 'busy'].includes(data?.error)) {
                const ra = Number.isFinite(data?.retry_after) ? data.retry_after : 1.5;
                scheduleRetryIfWanted(ra * 1000);
                return;
            }

            const addr = (data?.address?.display_name || '').trim();
            if (!addr) {
                // "empty" 200: retries controlled per uniqueId
                const n = retryCount.get(uniqueId) || 0;
                if (n < MAX_EMPTY_RETRIES) {
                    scheduleRetryIfWanted(600);
                    return;
                }
                // retries exhausted: deliver empty without caching
                onAddress?.('');
                persistAddressToDom(uniqueId, '');
                wanted.delete(uniqueId);
                resetRetry(uniqueId);
                return;
            }

            // valid addr
            lruPut(uniqueId, {
                key,
                address: addr
            });
            onAddress?.(addr);
            persistAddressToDom(uniqueId, addr);
            wanted.delete(uniqueId);
            resetRetry(uniqueId);
            return;
        }

        // Fire the request through the concurrency queue and share the WHOLE object
        const p = run(() => fetchReverseGeocode(lat, lon));
        coordInFlight.set(cKey, p);
        const data = await p;

        // The wanted key may have changed in the meantime
        if (wanted.get(uniqueId) !== key)
            return;

        // Transient states with Retry-After
        if (data?.error === 'queued' && Number.isFinite(data?.retry_after)) {
            scheduleRetryIfWanted(data.retry_after * 1000);
            return;
        }
        if (['temporarily_unavailable', 'rate_limited', 'busy'].includes(data?.error)) {
            const ra = Number.isFinite(data?.retry_after) ? data.retry_after : 1.5;
            scheduleRetryIfWanted(ra * 1000);
            return;
        }

        // "normal" 200 OK
        const addr = (data?.address?.display_name || '').trim();

        if (!addr) {
            // do NOT cache empty; retry up to MAX_EMPTY_RETRIES
            const n = retryCount.get(uniqueId) || 0;
            if (n < MAX_EMPTY_RETRIES) {
                scheduleRetryIfWanted(600);
                return;
            }
            // retries exhausted: deliver empty without caching
            onAddress?.('');
            persistAddressToDom(uniqueId, '');
            wanted.delete(uniqueId);
            resetRetry(uniqueId);
            return;
        }

        // Valid address: cache per coordinate and per uniqueId
        coordAddrCache.set(cKey, addr);
        lruPut(uniqueId, {
            key,
            address: addr
        });
        onAddress?.(addr);
        persistAddressToDom(uniqueId, addr);
        wanted.delete(uniqueId);
        resetRetry(uniqueId);

    } catch (err) {
        // network / non-2xx HTTP error: honor retry_after and transient codes
        if (wanted.get(uniqueId) === key) {
            const transitory =
                err?.code === 'temporarily_unavailable' ||
                err?.code === 'rate_limited' ||
                err?.code === 'busy' ||
                err?.status === 429 || err?.status === 503 || err?.status === 502 || err?.status === 504;
            const ra = Number.isFinite(err?.retry_after) ? err.retry_after : 1.5;
            scheduleRetryIfWanted((transitory ? ra : 1.2) * 1000);
        }
    } finally {
        coordInFlight.delete(cKey);
        if (inFlight.get(uniqueId) === key)
            inFlight.delete(uniqueId);
    }
}

export function cancelAddress(uniqueId) {
    wanted.delete(uniqueId);
    inFlight.delete(uniqueId);
    resetRetry(uniqueId);
}

export function clearGeocodeCaches() {
    posCache.clear();
    coordAddrCache.clear();
    coordInFlight.clear();
    wanted.clear();
    inFlight.clear();
    retryCount.clear();
}
