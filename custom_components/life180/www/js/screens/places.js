//
// PLACES
// Repeat stops outside every zone (from the server's `places`), with a
// one-tap "Save as zone".
//

import { isAdmin, fmt0, escapeHtml } from '../globals.js';
import { t } from '../utils/i18n.js';
import { requestAddress } from '../utils/geocode.js';
import { handleCreateZone } from './zones.js';

function formatDuration(seconds) {
    const min = Math.max(1, Math.round(seconds / 60));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function renderPlaces(places = []) {
    const body = document.getElementById('summary-places-table-body');
    if (!body) return;
    body.innerHTML = places.map((p, i) => `<tr data-place="${i}">
        <td><div style="font-weight:bold;">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</div><div class="place-address"></div></td>
        <td>${fmt0(p.visits)}</td>
        <td>${formatDuration(p.total_s)}</td>
        <td>${isAdmin ? `<button class="btn btn-primary place-save">${escapeHtml(t('save_as_zone'))}</button>` : ''}</td>
    </tr>`).join('');

    places.forEach((p, i) => {
        const row = body.querySelector(`tr[data-place="${i}"]`);
        const when = Date.parse(p.last_utc) || 0;
        requestAddress(`place_${i}_${when}`, p.lat, p.lon, when, address => {
            const cell = row.querySelector('.place-address');
            if (cell) cell.textContent = address || '';
        });
        row.querySelector('.place-save')?.addEventListener('click', async event => {
            const button = event.currentTarget;
            button.disabled = true;
            const id = await handleCreateZone({ lat: p.lat, lng: p.lon });
            if (id) button.replaceWith(document.createTextNode(t('saved')));
            else button.disabled = false;
        });
    });
    document.getElementById('summary-places')?.classList.toggle('hidden', places.length === 0);
}

export function clearPlaces() {
    renderPlaces([]);
}
