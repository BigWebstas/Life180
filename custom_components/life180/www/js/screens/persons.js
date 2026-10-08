//
// DEVICES
//

import { haUrl, formatDate, geocodeTime, geocodeDistance, DEFAULT_ALPHA, escapeHtml } from '../globals.js';
import { fetchPersons, fetchDevices, fetchPersonTrail } from '../ha/fetch.js';
import { handleZonePosition } from '../screens/zones.js';
import { map, isValidCoordinates, getDistanceFromLatLonInMeters, fitBoundsSafe, focusPoint } from '../utils/map.js';
import { t } from '../utils/i18n.js';
import { requestAddress, cancelAddress } from '../utils/geocode.js';
import { toRgba } from '../utils/dialogs.js';

const DEFAULT_ICON_URL = './images/location-red.png';

// History trail (drawn automatically for every tracked person)
const TRAIL_HOURS = 3;
const TRAIL_COLOR = '#03a9f4';
// A 3h window barely changes in 10s, so refetch it less often than the markers.
const TRAIL_REFRESH_MS = 30000;
let _lastTrailFetch = 0;

export let persons = [];

let devices = [];
let personsDevicesMap = {};
let personsMarkers = {};
let trailLayers = {}; // { [personId]: polyline }
let personZones = {}; // { [personId]: last known zone name ('' = none) } - drives the zone-crossing pulse

const LOW_BATTERY_PCT = 15;

let sortColumn = "name";
let sortAscending = true;
let previousSortColumn = "";
let previousSortAscending = true;

const lastGeocodeRequests = {}; // { [personId]: {lat, lon, timestamp, address} }

(function ensurePersonsTintCSS() {
    if (document.getElementById('persons-tint-css'))
        return;
    const style = document.createElement('style');
    style.id = 'persons-tint-css';
    style.textContent = `
    #persons-table-body tr.selected > td {
      background-color: transparent !important;
    }
    #persons-table-body tr.zone-tinted:not(.selected) > td {
      background-color: var(--zone-bg) !important;
    }	
  `;
    document.head.appendChild(style);
})();

// Lazy observer for the person address rows
let _personsAddrObserver = null;
function ensurePersonsAddrObserver() {
    if (_personsAddrObserver)
        return _personsAddrObserver;
    const root = document.querySelector('#users .table-wrapper') || null; // if absent, use the viewport
    _personsAddrObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting)
                continue;
            const addrRow = e.target;
            _personsAddrObserver.unobserve(addrRow);

            const personId = addrRow.dataset.personId;
            const lat = Number(addrRow.dataset.latitude);
            const lon = Number(addrRow.dataset.longitude);
            const tsMs = Number(addrRow.dataset.lastUpdated);
            const uniqueId = `${personId}_${tsMs}`;

            const cell = addrRow.querySelector('td');
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || !cell)
                continue;

            // trigger resolution (uses the shared module's caches/queue/backoff)
            requestAddress(uniqueId, lat, lon, tsMs, (newAddress) => {
                lastGeocodeRequests[personId] = {
                    lat,
                    lon,
                    timestamp: tsMs,
                    address: newAddress || ""
                };

                const row = document.querySelector(`tr.person-address-row[data-person-id="${personId}"]`);
                if (row && row.dataset.lastUpdated === String(tsMs)) {
                    const cell = row.querySelector('td');
                    if (cell)
                        cell.textContent = newAddress || "";
                }
            });

        }
    }, {
        root,
        rootMargin: '200px'
    });
    return _personsAddrObserver;
}

export async function updatePersons() {
    try {
        await Promise.all([fetchPersons(), fetchDevices()]);
        await updatePersonsDevicesMap();
        await updatePersonsTable();
        await updatePersonsMarkers();
        await updatePersonTrails();
        await updatePersonsFilter();
    } catch (error) {
        console.error("Error updating devices:", error);
        throw error;
    }
}

// Draw the last TRAIL_HOURS of positions for every tracked person as a polyline.
async function updatePersonTrails() {
    const currentPersonIds = Object.keys(personsDevicesMap);

    // Drop trails for people who no longer have a device.
    Object.keys(trailLayers).forEach(personId => {
        if (!currentPersonIds.includes(personId)) {
            map.removeLayer(trailLayers[personId]);
            delete trailLayers[personId];
        }
    });

    if (!currentPersonIds.length)
        return;

    // Always fetch for people who don't have a trail drawn yet (new arrivals,
    // or a prior fetch that came back empty); otherwise wait for the full
    // refresh interval.
    const now = Date.now();
    const dueForRefresh = (now - _lastTrailFetch) >= TRAIL_REFRESH_MS;
    const idsToFetch = dueForRefresh
        ? currentPersonIds
        : currentPersonIds.filter(personId => !trailLayers[personId]);

    if (!idsToFetch.length)
        return;
    if (dueForRefresh)
        _lastTrailFetch = now;

    if (!map.getPane('personsTrail')) {
        const pane = map.createPane('personsTrail');
        pane.style.zIndex = 550; // above zone circles (400), below person markers (600)
        pane.style.pointerEvents = 'none';
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - TRAIL_HOURS * 3600 * 1000);
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch in batches: one request per tracked person at once can exceed the
    // browser's per-host connection limit and leave some requests queued behind
    // the others, so cap the concurrency instead of firing them all at once.
    const BATCH_SIZE = 4;
    for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
        const batch = idsToFetch.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async personId => {
            const data = await fetchPersonTrail(personId, startIso, endIso);

            const coords = (data?.positions || [])
                .map(p => {
                    const lat = p?.attributes?.latitude;
                    const lon = p?.attributes?.longitude;
                    return isValidCoordinates(lat, lon) ? [lat, lon] : null;
                })
                .filter(Boolean);

            if (trailLayers[personId]) {
                map.removeLayer(trailLayers[personId]);
                delete trailLayers[personId];
            }

            if (coords.length < 2)
                return;

            trailLayers[personId] = L.polyline(coords, {
                color: TRAIL_COLOR,
                weight: 4,
                opacity: 0.8,
                dashArray: '1,8',
                lineCap: 'round',
                pane: 'personsTrail'
            }).addTo(map);
        }));
    }
}

export async function setDevices(data) {
    try {
        devices = Array.isArray(data) ? data.filter(d => d.entity_id && d.attributes) : [];
        console.log("Devices:", devices);
    } catch (error) {
        console.error("Error processing devices:", error);
        devices = [];
    }
}

export async function setPersons(data) {
    try {
        persons = Array.isArray(data) ? data.filter(p => p.attributes?.friendly_name) : [];
        console.log("Persons:", persons);
    } catch (error) {
        console.error("Error processing persons:", error);
        persons = [];
    }
}

export async function handlePersonsSelection(personId) {
    if (!personId)
        return;

    const selectedPerson = personsMarkers[personId];
    if (!selectedPerson)
        return;

    const selectedDevice = personsDevicesMap[personId];
    if (!selectedDevice) {
        console.error(`No device was found for the person with ID: ${personId}`);
        return;
    }

    Object.values(personsMarkers).forEach(marker => marker.setZIndexOffset(500));
    selectedPerson.setZIndexOffset(600);

    const { latitude: lat, longitude: lng } = selectedDevice.attributes || {};
    if (!isValidCoordinates(lat, lng)) {
        console.error(`Invalid coordinates for ${personId}: lat=${lat}, lng=${lng}`);
        return;
    }

    try {
        map.closePopup?.();
    } catch {}
    selectedPerson.openPopup?.();
    map.invalidateSize();
    focusPoint([lat, lng], {
        zoom: map.getZoom(),
        animate: false
    });
}

export function updatePersonsFilter() {
    const select = document.getElementById('person-select');
    if (!select)
        return;
    const prevSelected = select.value;

    const fragment = document.createDocumentFragment();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = t('select_user');
    fragment.appendChild(defaultOption);

    persons
    .filter(p => Boolean(personsDevicesMap[p.entity_id])) // only persons with a valid device
    .forEach(person => {
        const option = document.createElement('option');
        option.value = person.entity_id;
        const label = person.attributes.friendly_name || person.attributes.id || person.entity_id;
        option.textContent = (label || "").trim();
        fragment.appendChild(option);
    });

    // Replace all options at once
    select.innerHTML = '';
    select.appendChild(fragment);

    const hasPersons = select.options.length > 1;
    const prevStillValid = !!(prevSelected && personsDevicesMap[prevSelected]);

    if (hasPersons && prevStillValid) {
        // Keep the previous selection if it is still valid
        select.value = prevSelected;
    } else {
        // No persons, or the selection no longer exists -> force the "no user" logic
        select.value = '';
        // fire the change so the personSelect listener runs (hides the calendar and export)
        select.dispatchEvent(new Event('change', {
                bubbles: true
            }));
    }
}

export async function fitMapToAllPersons() {
    try {
        const coords = Object.values(personsDevicesMap)
            .filter(device => device.attributes.latitude && device.attributes.longitude)
            .map(device => [device.attributes.latitude, device.attributes.longitude]);

        if (!coords.length) {
            console.log("There are no devices with coordinates to adjust the map.");
            map.fitWorld();
            return;
        }

        const bounds = L.latLngBounds(coords);
        fitBoundsSafe(bounds, {
            animate: false,
            base: 24,
            extraRight: 16
        });
    } catch (error) {
        console.error("Error doing fitMapToAllDevices:", error);
    }
}

async function updatePersonsDevicesMap() {
    personsDevicesMap = {};

    for (const person of persons) {
        const trackers = person.attributes?.device_trackers;
        let trackerEntityId = null;

        // The first device_tracker in the array
        if (Array.isArray(trackers) && typeof trackers[0] === 'string' && trackers[0].trim() !== '') {
            trackerEntityId = trackers[0].trim();
        }

        const device = devices.find(d => d.entity_id === trackerEntityId);
        if (!device) {
            continue;
        }

        // Ensure numeric, valid lat/lon (does not reject 0,0)
        const lat = Number(device.attributes?.latitude);
        const lon = Number(device.attributes?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            console.log(`The device_tracker '${trackerEntityId}' of ${person.attributes.friendly_name || person.entity_id} does not have valid lat/lng.`);
            continue;
        }

        personsDevicesMap[person.entity_id] = device;
    }

    console.log("Devices to persons:", personsDevicesMap);
}

export function resolveWithHaUrl(pathLike) {
  if (!pathLike) return "";
  // Ensure a trailing slash on the base so it honors the haUrl pathname
  return new URL(pathLike, haUrl + "/").href;
}

// Ease-out glide between two marker positions instead of snapping on update.
const MARKER_GLIDE_MS = 400;
function glideMarkerTo(marker, [fromLat, fromLng], [toLat, toLng]) {
    if (marker.__l180GlideRaf)
        cancelAnimationFrame(marker.__l180GlideRaf);

    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / MARKER_GLIDE_MS);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        marker.setLatLng([
            fromLat + (toLat - fromLat) * eased,
            fromLng + (toLng - fromLng) * eased
        ]);
        marker.__l180GlideRaf = t < 1 ? requestAnimationFrame(step) : null;
    };
    marker.__l180GlideRaf = requestAnimationFrame(step);
}

async function updatePersonsMarkers() {
    if (!map.getPane('personsMarkers')) {
        const pane = map.createPane('personsMarkers');
        pane.style.zIndex = 600; // above circlePane (400)
        pane.style.pointerEvents = 'none';
    }

    const currentPersonIds = Object.keys(personsDevicesMap);

    Object.keys(personsMarkers).forEach(personId => {
        if (!currentPersonIds.includes(personId)) {
            map.removeLayer(personsMarkers[personId]);
            delete personsMarkers[personId];
        }
    });

    currentPersonIds.forEach(personId => {
        const device = personsDevicesMap[personId];
        const { latitude, longitude, friendly_name, speed } = device.attributes;
        const bat = readBattery(device);
        const batteryLevel = bat != null ? `<br>${t('battery')}: ${bat}${t('percentage')}` : "";

        // Floating badge above the marker while the person is moving.
        // Under 3 mph -> on foot (shoe), 3 mph and up -> driving (car).
        // Each mode gets its own CSS animation class (see .l180-mode-walk/.l180-mode-drive).
        const speedMph = Math.round((Number(speed) || 0) * 2.23694);
        const isDriving = speedMph >= 3;
        const modeIcon = isDriving ? '🚗' : '👟';
        const modeClass = isDriving ? 'l180-mode-drive' : 'l180-mode-walk';
        const isMoving = speedMph >= 1;
        const isLowBattery = bat != null && bat <= LOW_BATTERY_PCT;
        const battClass = isLowBattery ? ' l180-battery-low' : '';

        // Pill pinned over the avatar: always shows the battery %, and adds
        // the mode icon (animated) + speed while moving. Pulses red when low.
        const moveBadge = (isMoving || bat != null)
            ? `<div class="l180-move-badge${battClass}">${isMoving
                ? `<span class="l180-move-mode ${modeClass}">${modeIcon}</span>${speedMph} ${t('mi_per_hour')}${bat != null ? ' · ' : ''}`
                : '🔋 '}${bat != null ? `${bat}%` : ''}</div>`
            : '';

        if (!isValidCoordinates(latitude, longitude))
            return;

        // Zone-crossing pulse: fires exactly one rebuild when the person's
        // zone actually changes (not on first sighting).
        const zone = handleZonePosition(latitude, longitude);
        const zoneName = zone ? zone.name : '';
        const prevZoneName = personZones[personId];
        const zoneJustChanged = prevZoneName !== undefined && prevZoneName !== zoneName;
        personZones[personId] = zoneName;

        const formattedDate = formatDate(device.last_updated || t("date_unavailable"));
        const personObj = persons.find(p => p.entity_id === personId);
        const ownerName = personObj?.attributes.friendly_name || '';
        const iconUrl = resolveWithHaUrl(personObj?.attributes.entity_picture) || DEFAULT_ICON_URL;

        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        const popupContent = `
		  <strong>${escapeHtml(ownerName)}</strong> (${escapeHtml(friendly_name)})<br>
		  ${formattedDate}<br>
		  ${t('speed')}: ${Math.round((speed || 0) * 2.23694)} ${t('mi_per_hour')}
		  ${batteryLevel}
		  <br><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer"><strong>${t('open_location')}</strong></a>
		`;

        // Rebuild the icon/popup DOM only when their content actually changed.
        // Including the pulse flag here forces exactly one rebuild to show it,
        // then one more to clear it on the following cycle.
        const iconSig = `${iconUrl}|${moveBadge}|${zoneJustChanged ? 'pulse' : ''}`;
        const wrapAttrs = zoneJustChanged ? ' class="l180-zone-pulse"' : '';

        if (personsMarkers[personId]) {
            const existing = personsMarkers[personId];

            const prevLatLng = existing.getLatLng();
            if (prevLatLng.lat !== latitude || prevLatLng.lng !== longitude)
                glideMarkerTo(existing, [prevLatLng.lat, prevLatLng.lng], [latitude, longitude]);
            existing.__l180Target = [latitude, longitude]; // real position, even mid-glide

            if (existing.__l180IconSig !== iconSig) {
                existing.__l180IconSig = iconSig;
                existing.setIcon(L.divIcon({
                    className: '',
                    html: `<div style="position:relative;width:48px;height:48px;"${wrapAttrs}>${moveBadge}<img src="${escapeHtml(iconUrl)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;" /></div>`,
                    iconSize: [48, 48],
                    iconAnchor: [24, 24],
                    popupAnchor: [0, -24],
                }));
            }

            const p = existing.getPopup?.();
            if (p) {
                if (existing.__l180Popup !== popupContent) {
                    existing.__l180Popup = popupContent;
                    p.setContent(popupContent);
                }
            } else {
                existing.__l180Popup = popupContent;
                existing.bindPopup(popupContent, {
                    autoPan: false
                });
            }
        } else {
            const markerIcon = L.divIcon({
                className: '',
                html: `<div style="position:relative;width:48px;height:48px;"${wrapAttrs}>${moveBadge}<img src="${escapeHtml(iconUrl)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;" /></div>`,
                iconSize: [48, 48],
                iconAnchor: [24, 24],
                popupAnchor: [0, -24],
            });

            personsMarkers[personId] = L.marker([latitude, longitude], {
                icon: markerIcon,
                pane: 'personsMarkers'
            })
                .addTo(map)
                .bindPopup(popupContent, {
                    autoPan: false
                })
                .on('click', async() => {
                    await handlePersonRowSelection(personId);
                    map.invalidateSize();
                    const marker = personsMarkers[personId];
                    const target = marker.getLatLng();
                    const [ll_lat, ll_lng] = marker.__l180Target || [target.lat, target.lng];
                    focusPoint([ll_lat, ll_lng], {
                        zoom: map.getZoom(),
                        animate: false
                    });
                    try {
                        map.closePopup?.();
                    } catch {}
                    marker.openPopup?.();
                });
            personsMarkers[personId].__l180IconSig = iconSig;
            personsMarkers[personId].__l180Popup = popupContent;
            personsMarkers[personId].__l180Target = [latitude, longitude];
        }
    });
}

export async function handlePersonRowSelection(personId) {
    // 1) Switch to the "users" tab before touching the DOM
    const comboSelect = document.getElementById('combo-select');
    const switched = comboSelect && comboSelect.value !== 'users';
    if (switched) {
        comboSelect.value = 'users';
        comboSelect.dispatchEvent(new Event('change', {
                bubbles: true
            }));
        // Wait a frame so the table DOM renders
        await new Promise(r => requestAnimationFrame(r));
    }

    // 2) Ensure the tbody exists (try twice in case it is still mounting)
    let personTableBody = document.getElementById('persons-table-body');
    if (!personTableBody) {
        await new Promise(r => requestAnimationFrame(r));
        personTableBody = document.getElementById('persons-table-body');
    }
    if (!personTableBody) {
        console.error("Person table tbody not found.");
        return;
    }

    // 3) Find the row robustly (CSS.escape just in case)
    const safeId = (window.CSS && CSS.escape) ? CSS.escape(personId) : personId.replace(/"/g, '\\"');
    let row = personTableBody.querySelector(`tr[data-person-id="${safeId}"]`);
    if (!row) {
        // Fallback: search by dataset (in case of intermediate renders)
        row = Array.from(personTableBody.querySelectorAll('tr')).find(r => r.dataset.personId === personId);
    }
    if (!row)
        return;

    const addressRow = row.nextElementSibling && row.nextElementSibling.classList.contains('person-address-row')
         ? row.nextElementSibling : null;

    // 4) Restore the previous selection's tints and apply the new selection
    personTableBody.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    if (addressRow)
        addressRow.classList.add('selected');

    // 5) Scroll into view
    row.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
    });
}

// ----------- Tabla -----------
export function updatePersonsTableHeaders() {
    const table = document.querySelector("#persons-table");
    if (!table) {
        console.error("Zone summary table not found.");
        return;
    }

    const headers = table.querySelectorAll("thead th");

    headers.forEach(header => {
        const columnKey = header.getAttribute("data-i18n");
        let columnName = "";

        switch (columnKey) {
        case "name":
            columnName = "name";
            break;
        case "date":
            columnName = "date";
            break;
        case "speed":
            columnName = "speed";
            break;
        case "percentage":
            columnName = "percentage";
            break;
        case "zone":
            columnName = "zone";
            break;
        }
        if (!columnName)
            return;

        header.style.cursor = "pointer";
        header.onclick = () => {
            if (sortColumn === columnName)
                sortAscending = !sortAscending;
            else {
                sortColumn = columnName;
                sortAscending = true;
            }
            updatePersonsTable();
        };

        const arrow = (sortColumn === columnName) ? (sortAscending ? "▲" : "▼") : "";

        // Label to be shown in the TH
        const label =
            columnKey === "speed"
             ? t("mi_per_hour")
             : t(columnKey);

        header.innerHTML = `
		  <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:30px;">
			<span class="hdr-label">${label}</span>
			<span class="hdr-arrow" style="font-size:12px;">${arrow}</span>
		  </div>
		`;
    });
}

function applyTint(tr, color) {
    if (!tr)
        return;
    if (color) {
        tr.classList.add('zone-tinted');
        tr.style.setProperty('--zone-bg', color);
    } else {
        tr.classList.remove('zone-tinted');
        tr.style.removeProperty('--zone-bg');
    }
}

export async function updatePersonsTable() {
    try {
        const tableBody = document.getElementById("persons-table-body");
        if (!tableBody) {
            console.error("Person table tbody not found.");
            return;
        }

        const selectedRow = tableBody.querySelector("tr.selected");
        const selectedPersonId = selectedRow ? selectedRow.dataset.personId : null;

        const peopleWithDevice = persons.filter(p => personsDevicesMap[p.entity_id]);

        const sortedPersons = [...peopleWithDevice].sort((a, b) => {
            const deviceA = personsDevicesMap[a.entity_id] || {};
            const deviceB = personsDevicesMap[b.entity_id] || {};
            let valueA,
            valueB;

            switch (sortColumn) {
            case "name":
                valueA = a.attributes.friendly_name || a.entity_id;
                valueB = b.attributes.friendly_name || b.entity_id;
                return sortAscending ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA);
            case "date":
                valueA = deviceA.last_updated ? new Date(deviceA.last_updated).getTime() : 0;
                valueB = deviceB.last_updated ? new Date(deviceB.last_updated).getTime() : 0;
                return sortAscending ? valueA - valueB : valueB - valueA;
            case "speed":
                valueA = parseFloat(deviceA.attributes?.speed) || 0;
                valueB = parseFloat(deviceB.attributes?.speed) || 0;
                return sortAscending ? valueA - valueB : valueB - valueA;
            case "percentage":
                valueA = Number(readBattery(deviceA)) || 0;
                valueB = Number(readBattery(deviceB)) || 0;
                return sortAscending ? valueA - valueB : valueB - valueA;
            case "zone":
                valueA = handleZonePosition(deviceA.attributes?.latitude, deviceA.attributes?.longitude)?.name || "";
                valueB = handleZonePosition(deviceB.attributes?.latitude, deviceB.attributes?.longitude)?.name || "";
                return sortAscending ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA);
            default:
                return 0;
            }
        });

        const existingRows = Array.from(tableBody.querySelectorAll("tr"));
        const io = ensurePersonsAddrObserver();

        sortedPersons.forEach((person, index) => {
            const personId = person.entity_id;
            const friendlyName = person.attributes.friendly_name || personId;

            let time = "",
            speed = "",
            battery = null,
            currentZoneName = "",
            address = "";
            let zone = null;
            let lat,
            lon,
            lastUpdated;

            let shouldRequestGeocode = false;

            if (personsDevicesMap[personId]) {
                const device = personsDevicesMap[personId];
                battery = readBattery(device);
                time = formatDate(device.last_updated);
                speed = Math.round((device.attributes.speed || 0) * 2.23694);
                zone = handleZonePosition(device.attributes.latitude, device.attributes.longitude);
                currentZoneName = zone ? zone.name : "";

                lat = Number(device.attributes.latitude);
                lon = Number(device.attributes.longitude);
                lastUpdated = new Date(device.last_updated).getTime();

                const last = lastGeocodeRequests[personId];
                address = last?.address || "";

                if (!last) {
                    shouldRequestGeocode = true;
                } else {
                    const dist = getDistanceFromLatLonInMeters(last.lat, last.lon, lat, lon);
                    const timeDiff = (lastUpdated - (last.timestamp || 0)) / 1000;
                    if (dist >= geocodeDistance && timeDiff >= geocodeTime) {
                        address = "";
                        shouldRequestGeocode = true;
                    }
                }
            }

            let row = existingRows.find(r => r.dataset.personId === personId && !r.classList.contains('person-address-row'));
            let addressRow = row ? row.nextElementSibling : null;

            if (!row) {
                row = document.createElement("tr");
                row.dataset.personId = personId;
                row.style.cursor = "pointer";

                addressRow = document.createElement("tr");
                addressRow.dataset.personId = personId;
                addressRow.classList.add("person-address-row");
                addressRow.style.cursor = "pointer";

                const addressCell = document.createElement("td");
                addressCell.setAttribute("colspan", "5");
                addressCell.textContent = address || "";
                addressCell.style.borderBottom = "1px solid rgba(0,0,0,0.1)";
                addressRow.appendChild(addressCell);

                tableBody.appendChild(row);
                tableBody.appendChild(addressRow);
            }

            const newContent = `
				<td><p style="font-weight:bold;color:var(--l180-text);margin:0;">${escapeHtml(friendlyName)}</p></td>
				<td>${time}</td>
				<td>${escapeHtml(currentZoneName)}</td>
				<td>${speed}</td>
				<td>${battery != null ? battery + '%' : ''}</td>
			  `;
            if (row.innerHTML !== newContent)
                row.innerHTML = newContent;

            // Tint like zones using a class + CSS var (global helper)
            const tint = zoneTintRgba(zone, DEFAULT_ALPHA);
            applyTint(row, tint);
            applyTint(addressRow, tint);

            // Replaces the whole "Data for the observer..." block
            if (addressRow) {
                const td = addressRow.querySelector("td");
                addressRow.dataset.latitude = Number.isFinite(lat) ? String(lat) : '';
                addressRow.dataset.longitude = Number.isFinite(lon) ? String(lon) : '';
                addressRow.dataset.lastUpdated = Number.isFinite(lastUpdated) ? String(lastUpdated) : '0';

                const hasLast = Boolean(lastGeocodeRequests[personId]);
                const needsGeocode = shouldRequestGeocode || (!hasLast && Number.isFinite(lat) && Number.isFinite(lon));

                if (needsGeocode) {
                    if (td && td.textContent !== "…")
                        td.textContent = "…";
                    io.observe(addressRow);
                } else {
                    cancelAddress(`${personId}_${addressRow?.dataset?.lastUpdated ?? ''}`);
                    if (td && td.textContent !== address)
                        td.textContent = address || "";
                }
            }

            // Click selection
            const selectPerson = () => {
                tableBody.querySelectorAll("tr.selected").forEach(r => r.classList.remove("selected"));
                row.classList.add("selected");
                if (addressRow)
                    addressRow.classList.add("selected");
                handlePersonsSelection(personId);
            };

            row.onclick = selectPerson;
            if (addressRow)
                addressRow.onclick = selectPerson;

            // Keep the order (2 rows per person)
            if (tableBody.children[index * 2] !== row) {
                tableBody.insertBefore(row, tableBody.children[index * 2]);
                tableBody.insertBefore(addressRow, row.nextSibling);
            }

            // Keep the selection
            if (personId === selectedPersonId) {
                row.classList.add("selected");
                if (addressRow)
                    addressRow.classList.add("selected");
            }
        });

        // clean up orphan rows
        Array.from(tableBody.querySelectorAll("tr")).forEach(r => {
            const id = r.dataset.personId;
            if (!sortedPersons.some(p => p.entity_id === id)) {
                if (r.nextElementSibling && r.nextElementSibling.classList.contains("person-address-row")) {
                    r.nextElementSibling.remove();
                }
                r.remove();
            }
        });

        if (previousSortColumn !== sortColumn || previousSortAscending !== sortAscending) {
            updatePersonsTableHeaders();
            previousSortColumn = sortColumn;
            previousSortAscending = sortAscending;
        }
    } catch (error) {
        console.error("Error updating people table:", error);
    }
}

//
// Helper for the background color based on the zone
//

export function zoneTintRgba(zone, alpha = DEFAULT_ALPHA) {
    if (!zone || !zone.color)
        return null; // no color => no tint
    const a = Math.min(1, Math.max(0, Number(alpha) || 0));
    return toRgba(zone.color, a) || zone.color;
}

function readBattery(dev) {
    const candidates = [
        dev?.battery_level,
        dev?.attributes?.battery_level,
        dev?.attributes?.battery_percentage,
        dev?.attributes?.battery_percent,
        dev?.attributes?.batteryLevel,
        dev?.attributes?.battery,
        dev?.attributes?.bat,
    ];
    for (let v of candidates) {
        if (v === null || v === undefined || v === '') continue;
        let n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (n > 0 && n <= 1) n *= 100;          // 0-1 fraction -> percent
        return Math.max(0, Math.min(100, Math.round(n)));
    }
    return null;
}
