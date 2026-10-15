//
// TRIPS
// Trip list + driving totals, fed by the `trips` / `summary` the server returns.
//

import { formatDate, fmt0, escapeHtml } from '../globals.js';
import { t } from '../utils/i18n.js';

const MILES_PER_M = 1 / 1609.344;
const MPH_PER_MPS = 2.23694;

const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
};

function formatDuration(seconds) {
    const min = Math.max(1, Math.round(seconds / 60));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function tripRow(trip) {
    const place = p => escapeHtml(p.zone || t('trip_unknown_place'));
    const drive = trip.mode === 'drive';
    const events = [
        trip.hard_braking ? `<span title="${escapeHtml(t('hard_braking'))}">\u{1F6D1} ${trip.hard_braking}</span>` : '',
        trip.hard_accel ? `<span title="${escapeHtml(t('hard_accel'))}">\u26A1 ${trip.hard_accel}</span>` : '',
    ].filter(Boolean).join(' ');
    const details = [
        formatDate(trip.start_utc),
        formatDuration(trip.duration_s),
        `${fmt0(trip.max_speed_mps * MPH_PER_MPS)} ${escapeHtml(t('mi_per_hour'))}`,
        events,
    ].filter(Boolean).join(' \u00B7 ');
    return `<tr>
        <td>${drive ? '\u{1F697}' : '\u{1F45F}'}</td>
        <td><div style="font-weight:bold;">${place(trip.from)} \u2192 ${place(trip.to)}</div><div>${details}</div></td>
        <td>${fmt0(trip.distance_m * MILES_PER_M)} ${escapeHtml(t('miles'))}</td>
    </tr>`;
}

export function renderTrips(trips = []) {
    const body = document.getElementById('trips-table-body');
    if (!body) return;
    body.innerHTML = trips.length
        ? trips.map(tripRow).join('')
        : `<tr><td colspan="3">${escapeHtml(t('no_trips'))}</td></tr>`;
}

export function renderDrivingSummary(summary) {
    setText('trips-count', fmt0(summary.trips_count ?? 0));
    setText('hard-braking-count', fmt0(summary.hard_braking_count ?? 0));
    setText('hard-accel-count', fmt0(summary.hard_accel_count ?? 0));
}

export function clearTrips() {
    const body = document.getElementById('trips-table-body');
    if (body) body.innerHTML = '';
    ['trips-count', 'hard-braking-count', 'hard-accel-count'].forEach(id => setText(id, '--'));
}
