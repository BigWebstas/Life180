//
// ZONES
//

import { isAdmin, fmt0, DEFAULT_COLOR, DEFAULT_ALPHA } from '../globals.js';
import { map, getDistanceFromLatLonInMeters, fitBoundsSafe, focusPoint } from '../utils/map.js';
import { deleteZone, updateZone, createZone, fetchZones } from '../ha/fetch.js';
import { updatePersonsTable } from '../screens/persons.js';
import { t, tWithVars } from '../utils/i18n.js';
import { uiConfirm, uiPrompt, uiAlert, toRgba } from '../utils/dialogs.js';

let zones = [], zoneMarkers = {}, zoneLabels = {};

function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function zoneLabelIcon(name) {
    return L.divIcon({
        className: '',
        html: `<span class="l180-zone-label">${escHtml(name)}</span>`,
    });
}

// Zone labels only make sense when zoomed in enough to tell the circles apart.
const ZONE_LABEL_MIN_ZOOM = 13;
let _zoneLabelZoomWired = false;

function applyZoneLabelVisibility() {
    const el = document.getElementById('map');
    if (!el) return;
    const z = (typeof map.getZoom === 'function') ? map.getZoom() : 20;
    el.classList.toggle('l180-hide-zone-labels', z < ZONE_LABEL_MIN_ZOOM);
}
let zonesSortColumn = "name"; // default sort column
let zonesSortAscending = true; // Orden ascendente predeterminado
let previousSortColumn = "";
let previousSortAscending = true;

const editingZones = {};
const MAX_ZONE_NAME_LENGTH = 30;
const DIACRITICS_RE = /\p{Diacritic}/gu;

const LIFE180_ICON_16_16 = './images/life18016x16.png';
const HA_ICON_16_16 = './images/ha16x16.png';

export async function initZones() {
    const addZoneButton = document.getElementById("add-zone-button");
    const deleteZoneButton = document.getElementById("delete-zone-button");
    const editZoneButton = document.getElementById("edit-zone-button");

    if (addZoneButton) {
        addZoneButton.addEventListener("click", async() => {
            try {
                await handleCreateZone();
            } catch (error) {
                console.error("Error adding a zone:", error);
            }
        });
    }

    if (deleteZoneButton) {
        deleteZoneButton.addEventListener("click", async() => {
            try {
                await handleDeleteZone();
            } catch (error) {
                console.error("Error deleting a zone:", error);
            }
        });
    }

    if (editZoneButton) {
        editZoneButton.addEventListener("click", async() => {
            try {
                await handleEditZone();
            } catch (error) {
                console.error("Error when modifying a zone:", error);
            }
        });
    }
}

export async function updateZones() {
    try {
        await fetchZones();
        await updateZonesTable();
        await updateZoneMarkers();
    } catch (error) {
        console.error("Error updating zones:", error);
        throw error;
    }
}

export async function setZones(data) {
    try {
        if (data && Array.isArray(data)) {
            zones = data; // assign the fetched data to the global variable
            console.log("Zones:", zones);
        } else {
            console.log("No valid zones were obtained from the server.");
            zones = []; // ensure `zones` is an empty array on error
        }
    } catch (error) {
        console.error("Error getting zones:", error);
        zones = []; // ensure `zones` is not left undefined if an error occurs
    }
}

async function updateZoneMarkers() {
    // Make sure the panes are set up
    if (!map.getPane('circlePane')) {
        map.createPane('circlePane'); // create a pane for the circles
        map.getPane('circlePane').style.zIndex = 400; // low z-index for the circles
    }

    // Toggle zone labels by zoom level (wire once)
    if (!_zoneLabelZoomWired && typeof map.on === 'function') {
        _zoneLabelZoomWired = true;
        map.on('zoom', applyZoneLabelVisibility);
        map.on('zoomend', applyZoneLabelVisibility);
    }
    applyZoneLabelVisibility();

    // Get the IDs of the current zones
    const currentZoneIds = zones.map(z => String(z.id));

    // Remove circles for zones that no longer exist
    Object.keys(zoneMarkers).forEach(zoneId => {
        if (!currentZoneIds.includes(String(zoneId))) {
            map.removeLayer(zoneMarkers[zoneId]); // remove the circle from the map
            delete zoneMarkers[zoneId]; // remove from memory
            delete editingZones[zoneId]; // remove from the edit states
        }
    });
    Object.keys(zoneLabels).forEach(zoneId => {
        if (!currentZoneIds.includes(String(zoneId))) {
            map.removeLayer(zoneLabels[zoneId]);
            delete zoneLabels[zoneId];
        }
    });

    // Add or update the current zones
    zones.forEach(zone => {
        const key = String(zone.id);
        const { latitude, longitude, radius, name, custom, visible } = zone;

        // Robust numeric validation
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radius)) {
            console.error("Invalid zone (lat/lon/radius):", zone.id);
            return;
        }

        // Hide on the map via the "visible" flag
        if (visible === false) {
            if (zoneMarkers[key]) {
                map.removeLayer(zoneMarkers[key]);
                delete zoneMarkers[key];
                delete editingZones[key];
            }
            if (zoneLabels[key]) {
                map.removeLayer(zoneLabels[key]);
                delete zoneLabels[key];
            }
            return;
        }

        // Skip zones being edited
        if (editingZones[key]) {
            return;
        }

        // Check whether a marker already exists and whether the values changed
        const existingCircle = zoneMarkers[key];
        const hasChanged = !existingCircle ||
            existingCircle.getLatLng().lat !== latitude ||
            existingCircle.getLatLng().lng !== longitude ||
            existingCircle.getRadius() !== radius;

        // Derived colors (hex border + rgba fill with default alpha)
        // Zones are always green; the per-zone color option was removed.
        const baseHex = DEFAULT_COLOR;
        const strokeColor = baseHex;
        const fillColor = toRgba(baseHex, DEFAULT_ALPHA);

        if (existingCircle) {
            const popupContent = buildZonePopup(zone);
            // ALWAYS refresh the content; if the popup is open it updates live
            if (typeof existingCircle.setPopupContent === 'function') {
                existingCircle.setPopupContent(popupContent);
            } else {
                existingCircle.bindPopup(popupContent, {
                    autoPan: false
                });
            }
            if (existingCircle.options.color !== strokeColor || existingCircle.options.fillColor !== fillColor) {
                existingCircle.setStyle({
                    color: strokeColor,
                    fillColor,
                    fillOpacity: 1
                });
            }
        }

        // Zone name label at the centre (kept in sync even on a pure rename)
        if (name && String(name).trim()) {
            if (zoneLabels[key]) {
                zoneLabels[key].setLatLng([latitude, longitude]);
                zoneLabels[key].setIcon(zoneLabelIcon(name));
            } else {
                zoneLabels[key] = L.marker([latitude, longitude], {
                    icon: zoneLabelIcon(name)
                })
                    .addTo(map)
                    .on('click', () => handleZoneRowSelection(zone.id).catch(() => {}));
            }
        } else if (zoneLabels[key]) {
            map.removeLayer(zoneLabels[key]);
            delete zoneLabels[key];
        }

        // If there are no changes and the marker already exists, skip
        if (!hasChanged) {
            return;
        }

        // If a circle already exists for the zone, save the popup state
        let isPopupOpen = false;
        if (zoneMarkers[key]) {
            const prevCircle = zoneMarkers[key];
            const wasOpen = prevCircle.isPopupOpen();
            isPopupOpen = wasOpen;
            map.removeLayer(prevCircle);
            delete zoneMarkers[key];
        }

        const circle = L.circle([latitude, longitude], {
            radius,
            color: strokeColor, // borde en hex
            fillColor, // relleno rgba(...)
            fillOpacity: 1, // the alpha is already in fillColor
            opacity: 0.8,
            pane: 'circlePane',
        }).addTo(map);

        // Enable editing if leaflet-editable is present
        if (isAdmin && custom && typeof circle.enableEdit === 'function') {
            circle.enableEdit();
        }

        circle.bindPopup(buildZonePopup(zone), {
            autoPan: false
        });

        // If the popup was open, reopen it with the updated content
        if (isPopupOpen) {
            circle.openPopup();
        }

        // Customize the click event to center and open the popup
        circle.on('click', async() => {
            try {
                // Adjust the zoom to frame the circle (with padding)
                fitBoundsSafe(circle.getBounds(), {
                    animate: false,
                    base: 24,
                    extraRight: 16
                });

                // Open the circle's popup
                circle.openPopup();

                // Call the async function to handle the row selection
                await handleZoneRowSelection(zone.id);
            } catch (error) {
                console.error("Error handling zone row selection:", error);
            }
        });

        // Detect vertex movement
        circle.on('editable:vertex:dragstart', () => {
            editingZones[key] = true; // mark as editing
            map.closePopup(); // close any popup open on the map
        });

        circle.on('editable:vertex:dragend', async() => { // make sure this function is async
            editingZones[key] = false; // mark as not editing

            const updatedLatLng = circle.getLatLng(); // new center position
            const updatedRadius = circle.getRadius(); // Nuevo radio

            // ALWAYS re-fetch the "fresh" zone object by id to avoid stale closures
            const z = (zones.find(zz => String(zz.id) === String(zone.id)) || zone);

            // 1) Update the local model so the table and popup reflect the change instantly
            z.latitude = updatedLatLng.lat;
            z.longitude = updatedLatLng.lng;
            z.radius = updatedRadius;

            // 2) Refresh the popup with the updated content (name/radius/units)
            const newHtml = buildZonePopup(z);
            if (typeof circle.setPopupContent === 'function') {
                circle.setPopupContent(newHtml);
            } else {
                circle.bindPopup(newHtml, {
                    autoPan: false
                });
            }
            circle.openPopup();

            // 3) Refresh the table immediately (the selection is kept)
            await updateZonesTable();

            // 4) If applicable, persist the change to the server and re-sync
            if (isAdmin && z.custom) {
                try {
                    const response = await updateZone(
                            z.id,
                            z.name, // fresh name (avoids "reviving" the old name)
                            updatedRadius,
                            updatedLatLng.lat,
                            updatedLatLng.lng,
                            DEFAULT_COLOR,
                            z.visible !== false);

                    if (response && response.success) {
                        await fetchZones(); // sync 'zones' with the server
                        await updateZonesTable(); // ensure the table stays aligned
                        await updateZoneMarkers(); // revalida estilos/markers
                        await handleZoneRowSelection(z.id);
                        console.log(`Zone with ID ${z.id} updated on server.`);
                    } else {
                        console.error(`Error updating zone with ID ${z.id} on server.`);
                    }
                } catch (error) {
                    console.error("Error in zone update request:", error);
                }
            }
        });

        // Store the circle in the markers
        zoneMarkers[key] = circle;
    });
}

export async function handleZoneRowSelection(zoneId) {

    const zonesTableBody = document.getElementById('zones-table-body');
    if (!zonesTableBody) {
        console.error("The zone table tbody was not found.");
        return;
    }

    const row = zonesTableBody.querySelector(`tr[data-zone-id="${String(zoneId)}"]`);
    if (!row) {
        console.error("No row found for the zone:", zoneId);
        return;
    }

    // Switch the combo to "Zones" only if needed
    const comboSelect = document.getElementById('combo-select');
    if (comboSelect && comboSelect.value !== 'zones') {
        comboSelect.value = 'zones';

        // Fire the change event manually to update the UI
        const changeEvent = new Event('change', {
            bubbles: true
        });
        comboSelect.dispatchEvent(changeEvent);
    }

    // Highlight the row in the zones table
    zonesTableBody.querySelectorAll('tr').forEach(r => r.classList.remove('selected')); // clear the previous selection
    row.classList.add('selected'); // highlight the selected row

    // Ensure the row is visible before scrolling
    row.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
    });

    // Call updateZoneActionButtons only if a row is selected
    if (typeof updateZoneActionButtons === "function") {
        updateZoneActionButtons();
    }
}

export async function updateZoneActionButtons() {
    const zonesTableBody = document.getElementById('zones-table-body');
    if (!zonesTableBody) {
        console.error("Zone table body not found.");
        return;
    }

    const rows = zonesTableBody.querySelectorAll('tr');
    const addButton = document.getElementById('add-zone-button');
    const deleteButton = document.getElementById('delete-zone-button');
    const editButton = document.getElementById('edit-zone-button');
    const zoneActions = document.getElementById('zone-actions');
    if (!zoneActions)
        return;

    // Hide all buttons at the start to avoid conflicts (only those that exist)
    [addButton, deleteButton, editButton].filter(Boolean).forEach(btn => btn.classList.add('hidden'));

    // Handle the button container visibility based on admin permissions
    zoneActions.style.display = isAdmin ? 'flex' : 'none';
    if (!isAdmin)
        return;

    // If there are no rows, only show the "Add" button
    if (rows.length === 0) {
        addButton.classList.remove('hidden');
    } else {
        const selectedRow = zonesTableBody.querySelector('tr.selected');

        if (!selectedRow) {
            // If no row is selected, only show "Add"
            addButton.classList.remove('hidden');
        } else {
            const isCustom = selectedRow.dataset.custom === "true";
            addButton.classList.remove('hidden');
            if (isCustom) {
                deleteButton.classList.remove('hidden'); // delete only custom
            }
            editButton.classList.remove('hidden'); // editar siempre (custom y HA)
        }
    }

    // Determine how many buttons are visible
    const visibleButtons = [addButton, deleteButton, editButton]
    .filter(Boolean)
    .filter(btn => !btn.classList.contains('hidden'));

    // If only one button is visible, apply the 'single-button' class
    if (visibleButtons.length === 1) {
        zoneActions.classList.add('single-button');
        visibleButtons[0].style.flex = '1';
    } else {
        zoneActions.classList.remove('single-button');
        visibleButtons.forEach(button => (button.style.flex = '1'));
    }
}

async function handleDeleteZone() {
    const zonesTableBody = document.getElementById('zones-table-body');
    const selectedRow = zonesTableBody.querySelector('tr.selected');

    if (!selectedRow) {
        uiAlert(t('select_delete_zone'), {
            title: t('zones')
        });
        return;
    }

    const zoneId = selectedRow.dataset.zoneId;
    const name = selectedRow.dataset.name;

    if (!zoneId) {
        console.error("The selected zone ID was not found.");
        return;
    }

    const confirmDelete = await uiConfirm(
            tWithVars('confirm_delete_zone', {
                name
            }), {
            type: 'danger',
            okLabel: t('delete'),
            title: t('zones')
        });

    if (!confirmDelete) {
        return; // cancel the operation if the user does not confirm
    }

    try {
        await deleteZone(zoneId); // call the function to delete the zone

        // Actualizar
        await fetchZones();
        await updateZonesTable();
        await updateZoneMarkers();
    } catch (error) {
        console.error("Error trying to delete zone:", error);
        uiAlert(t('error_deleting_zone'), {
            title: t('zones')
        });
    }
}

async function handleEditZone() {
    const zonesTableBody = document.getElementById('zones-table-body');
    if (!zonesTableBody) {
        console.error("Zone table body not found.");
        return;
    }

    const selectedRow = zonesTableBody.querySelector('tr.selected');
    if (!selectedRow) {
        uiAlert(t('select_zone'), {
            title: t('zones')
        });
        return;
    }

    const zoneId = selectedRow.dataset.zoneId;
    const zone = zones.find(z => String(z.id) === String(zoneId));

    if (!zone) {
        uiAlert(t('error_finding_zone'), {
            title: t('zones')
        });
        return;
    }

    const isHA = !zone.custom;
    const res = await uiPrompt(
            isHA ? t('zone_name_ha') : t('enter_zone_name'),
            zone.name || t('zone_without_name'), {
            title: t('zones'),
            withVisibility: true,
            visibilityValue: (zone.visible !== false),
            visibilityLabel: t ? t('show_on_map') : 'Show on the map',
            // If it is HA, we do not allow changing the name:
            inputDisabled: isHA,
        });
    if (res === null)
        return;

    const newVisible = (res.visible !== undefined) ? !!res.visible : (zone.visible !== false);
    const newColor = DEFAULT_COLOR;

    let cleaned = zone.name;
    if (!isHA) {
        cleaned = normalizeZoneNameInput(res.value);
        if (cleaned === null)
            return;
    }

    // If neither the (normalized) name, nor the color, nor the visibility changed -> exit
    if (
        (!isHA && canonZoneName(cleaned) === canonZoneName(zone.name)) &&
        newColor === (zone.color || DEFAULT_COLOR) &&
        (newVisible === (zone.visible !== false))) {
        return;
    }

    // Name uniqueness only applies to custom zones
    if (!isHA) {
        await fetchZones();
        if (isZoneNameTaken(cleaned, {
                excludeId: zone.id
            })) {
            uiAlert(t('zone_name_exists'), {
                title: t('zones')
            });
            return;
        }
    }

    try {
        const response = await updateZone(
                zone.id,
                cleaned, // name (ignored by the server if HA)
                zone.radius,
                zone.latitude,
                zone.longitude,
                newColor,
                newVisible // NEW: visibility
            );

        if (response && response.success) {
            if (!isHA)
                zone.name = cleaned; // local refresh only if custom
            zone.color = newColor;
            zone.visible = newVisible;

            await fetchZones();
            await updateZonesTable();
            await updateZoneMarkers();
            await handleZoneRowSelection(zone.id);
        } else {
            uiAlert(t('error_updating_zone'), {
                title: t('zones')
            });
        }
    } catch (error) {
        console.error("Error in zone update request:", error);
        uiAlert(t('error_updating_zone'), {
            title: t('zones')
        });
    }
}

async function handleCreateZone() {
    if (!map) {
        console.error("The map is not initialized.");
        return null;
    }

    // Ask the user for the zone name
    const res = await uiPrompt(t('enter_zone_name'), '', {
        title: t('zones'),
    });
    if (res === null)
        return; // cancelado
    const cleaned = normalizeZoneNameInput(res.value);
    if (cleaned === null)
        return;

    // unique zone names
    await fetchZones();
    if (isZoneNameTaken(cleaned)) {
        uiAlert(t('zone_name_exists'), {
            title: t('zones')
        });
        return;
    }

    // Get the current map center
    const center = map.getCenter();
    const latitude = center.lat;
    const longitude = center.lng;

    const radius = 100; // Radio fijo de 100 metros

    try {
        // Create the zone with the validated name
        const color = DEFAULT_COLOR;
        const newZoneId = await createZone(cleaned, radius, latitude, longitude, "mdi:map-marker", false, true, color);
        if (newZoneId) {
            await fetchZones();
            await updateZonesTable();
            await updateZoneMarkers();
            await handleZoneRowSelection(newZoneId);

            // Simulate the click on the table row (same UX as tapping in the table):
            const tbody = document.getElementById('zones-table-body');
            const row = tbody?.querySelector(`tr[data-zone-id="${String(newZoneId)}"]`);
            if (row) {
                // This triggers _lastPressFromZones(), frames the circle and opens the popup to the north,
                // and, if applicable, shows the edit handles (isAdmin && custom).
                row.click(); // equivalent to the user tapping the row
            } else {
                // Fallback in case something fails while building the table
                const marker = zoneMarkers[String(newZoneId)];
                if (marker) {
                    fitBoundsSafe(marker.getBounds(), {
                        animate: false,
                        base: 24,
                        extraRight: 16
                    });
                    marker.openPopup();
                }
            }

            console.log(`Zone created successfully. ID: ${newZoneId}`);
            return newZoneId;
        } else {
            console.error("Failed to create zone.");
            uiAlert(t('error_creating_zone'), {
                title: t('zones')
            });
            return null;
        }
    } catch (error) {
        console.error("Error in zone update request:", error);
        uiAlert(t('error_creating_zone'), {
            title: t('zones')
        });
    }
}

export function handleZonePosition(latitude, longitude, opts = {}) {
    const { accuracy = 0,
    includePassive = false,
    // You can tune them per call:
    epsilonM = 0.5, // tolerance in meters for ties
    epsilonDeg = 1e-5, // ~1 m to group centers
     } = opts;

    // Helpers locales
    const quant = v => Math.round(v / epsilonDeg);
    const centerKey = (lat, lon) => `${quant(lat)},${quant(lon)}`;

    // Validaciones
    if (
        latitude == null || longitude == null ||
        Number.isNaN(latitude) || Number.isNaN(longitude))
        return null;

    // 1) Candidates that contain the point (radius + accuracy)
    const candidates = [];
    for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        if (!z)
            continue;
        if (z.passive && !includePassive)
            continue;

        // Use the existing distance-in-meters function:
        const d = getDistanceFromLatLonInMeters(latitude, longitude, z.latitude, z.longitude);
        const effectiveRadius = (Number(z.radius) || 0) + (Number(accuracy) || 0);

        if (d <= effectiveRadius) {
            candidates.push({
                zone: z,
                idx: i,
                distanceToCenter: d,
                key: centerKey(z.latitude, z.longitude),
                radius: Number(z.radius) || 0,
                id: z.entity_id || z.id || z.name || `idx:${i}`,
            });
        }
    }

    if (candidates.length === 0)
        return null;
    if (candidates.length === 1)
        return candidates[0].zone;

    // 2) Concentric: keep the smallest radius for each center
    const byCenterBest = new Map();
    for (const c of candidates) {
        const prev = byCenterBest.get(c.key);
        if (!prev || c.radius < prev.radius - epsilonM) {
            byCenterBest.set(c.key, c);
        } else if (Math.abs(c.radius - prev.radius) <= epsilonM) {
            if (String(c.id) < String(prev.id))
                byCenterBest.set(c.key, c);
        }
    }
    const reduced = Array.from(byCenterBest.values());
    if (reduced.length === 1)
        return reduced[0].zone;

    // 3) Different centers: nearest; then smallest radius; then stable id
    reduced.sort((a, b) => {
        const dd = a.distanceToCenter - b.distanceToCenter;
        if (Math.abs(dd) > epsilonM)
            return dd;

        const dr = a.radius - b.radius;
        if (Math.abs(dr) > epsilonM)
            return dr;

        return String(a.id).localeCompare(String(b.id));
    });

    return reduced[0].zone;
}

export async function showZone(idZone) {
    if (!idZone)
        return;
    const key = String(idZone);
    const circle = zoneMarkers[key];
    if (circle) {
        focusPoint(circle.getLatLng(), {
            zoom: map.getZoom(),
            animate: false
        });
        circle.openPopup();
    } else {
        console.error("Marker for zone not found:", key);
    }
}

async function updateZonesTable() {
    const zonesTableBody = document.getElementById('zones-table-body');

    if (!zonesTableBody) {
        console.error("Zone table body not found.");
        updatePersonsTable();
        updateZoneActionButtons();
        return;
    }

    // Store the currently selected row
    const selectedRow = zonesTableBody.querySelector('tr.selected');
    const selectedZoneId = selectedRow ? selectedRow.dataset.zoneId : null;

    // Sort the zones by the selected column
    const sortedZones = [...zones].sort((a, b) => {
        let valueA,
        valueB;

        switch (zonesSortColumn) {
        case "vmap": { // map column (visibility), if you decide to enable sorting on 'column_map'
                const visA = (a.visible === false) ? 1 : 0; // 0 visible, 1 not visible
                const visB = (b.visible === false) ? 1 : 0;
                if (visA !== visB) {
                    return zonesSortAscending ? visA - visB : visB - visA;
                }
                const nameA = canonZoneName(a.name);
                const nameB = canonZoneName(b.name);
                return zonesSortAscending ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
            }
        case "ctype": { // type column (custom vs HA) -> icon
                // Ascending: custom first (0) then HA (1). Reversed for descending.
                const typeA = a.custom ? 0 : 1;
                const typeB = b.custom ? 0 : 1;
                if (typeA !== typeB) {
                    return zonesSortAscending ? typeA - typeB : typeB - typeA;
                }
                const nameA = canonZoneName(a.name);
                const nameB = canonZoneName(b.name);
                return zonesSortAscending ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
            }
        case "radius":
            valueA = Number(a.radius) || 0;
            valueB = Number(b.radius) || 0;
            return zonesSortAscending ? valueA - valueB : valueB - valueA;
        case "name":
        default:
            valueA = (a.name || "").toLowerCase();
            valueB = (b.name || "").toLowerCase();
            return zonesSortAscending ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA); // alphabetical order
        }
    });

    // Get the table's current rows
    const existingRows = Array.from(zonesTableBody.querySelectorAll('tr'));

    // Update or add rows
    sortedZones.forEach((zone, index) => {
        const { id, latitude, longitude, name, custom } = zone;

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            console.error("Invalid coordinates for the zone:", id);
            return;
        }

        let row = existingRows.find(row => String(row.dataset.zoneId) === String(id));

        if (!row) {
            // Create a new row if it does not exist
            row = document.createElement('tr');
            row.dataset.zoneId = String(id);
            row.dataset.custom = String(custom);
            row.dataset.name = name;
            row.style.cursor = 'pointer'; // change the cursor on hover
            zonesTableBody.appendChild(row);
        }

        // Determine the content of the first column
        const color = DEFAULT_COLOR;
        const isVisible = zone.visible !== false; // visible by default
        row.dataset.visible = String(isVisible);
        row.style.setProperty('--color-bg', toRgba(color, DEFAULT_ALPHA));
        const adminColumnContent = isVisible
             ? `<div style="
              width:12px; height:12px; border:2px solid ${color};
              border-radius:50%;
              background-color:${toRgba(color, 0.3)};
              margin:auto;"></div>`
             : ``; // no circle if not visible

        // Second column: type icon (custom vs HA)
        const typeIcon = zone.custom ? LIFE180_ICON_16_16 : HA_ICON_16_16;
        const typeAlt = zone.custom ? 'custom' : 'ha';
        const typeColumnContent = `<img src="${typeIcon}" alt="${typeAlt}" width="16" height="16" style="display:block;margin:auto;">`;

        const radiusText = `${fmt0(zone.radius * 3.28084)}`; // metros -> pies

        // Update the row content if needed
        const newContent = `
		  <td>${adminColumnContent}</td>
          <td>${typeColumnContent}</td>
		  <td>${name || t('zone_without_name')}</td>
		  <td>${radiusText}</td>
		`;

        if (row.innerHTML !== newContent) {
            row.innerHTML = newContent;
            row.dataset.name = name;
        }

        // Attach a click event to center on the map and show the popup
        row.onclick = () => {
            const marker = zoneMarkers[String(id)];
            if (marker) {
                const circleBounds = marker.getBounds();
                fitBoundsSafe(circleBounds, {
                    animate: false,
                    base: 24,
                    extraRight: 16
                });
                marker.openPopup(); // show the popup
            } else {
                console.error("No marker found for the zone:", id);
            }

            // Handle the row selection
            zonesTableBody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');

            // Update the buttons after selecting a row
            updateZoneActionButtons();
        };

        // Ensure the row is in the correct position (reorder if needed)
        if (zonesTableBody.children[index] !== row) {
            zonesTableBody.insertBefore(row, zonesTableBody.children[index]);
        }

        // Keep the selection if the current zone is selected
        if (String(id) === String(selectedZoneId)) {
            row.classList.add('selected');
        }
    });

    // Remove rows for zones that no longer exist
    existingRows.forEach(row => {
        if (!sortedZones.some(zone => String(zone.id) === String(row.dataset.zoneId))) {
            row.remove();
        }
    });

    // Update the buttons after processing the zones
    updateZoneActionButtons();
    updatePersonsTable();

    // Update headers with sort arrows
    if (previousSortColumn !== zonesSortColumn || previousSortAscending !== zonesSortAscending) {
        updateZonesTableHeaders();
        previousSortColumn = zonesSortColumn;
        previousSortAscending = zonesSortAscending;
    }
}

function updateZonesTableHeaders() {
    const table = document.querySelector("#zones-table");
    if (!table) {
        console.error("Zone summary table not found.");
        return;
    }

    const headers = table.querySelectorAll("thead th");

    headers.forEach((header, idx) => {
        // Read the i18n key declared in the HTML
        const columnKey = header.getAttribute("data-i18n") || "";
        let columnName = "";

        // Mapping: i18n keys -> internal column name for the sorter
        // column_map  -> vmap  (visibility, if you want to enable it)
        // column_type -> ctype (custom vs ha)
        // name        → name
        // radius      → radius
        switch (columnKey) {
        case "column_map":
            columnName = "vmap";
            break;
        case "column_type":
            columnName = "ctype";
            break;
        case "name":
            columnName = "name";
            break;
        case "radius":
            columnName = "radius";
            break;
        }

        if (!columnName)
            return;

        header.style.cursor = "pointer";
        header.onclick = () => {
            if (zonesSortColumn === columnName) {
                zonesSortAscending = !zonesSortAscending;
            } else {
                zonesSortColumn = columnName;
                zonesSortAscending = true;
            }
            updateZonesTable();
        };

        let arrow = "";

        if (zonesSortColumn === columnName) {
            arrow = zonesSortAscending ? "▲" : "▼";
        }

        const label = (columnKey === 'radius')
         ? t('feet')
         : t(columnKey);

        header.innerHTML = `
		  <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:30px;">
			<span class="hdr-label">${label}</span>
			<span style="font-size:12px;">${arrow}</span>
		  </div>
		`;
    });
}

function normalizeZoneNameInput(name) {
    const trimmed = (name || "").trim();

    if (trimmed === "") {
        uiAlert(t('empty_name'), {
            title: t('zones')
        });
        return null;
    }
    if (trimmed.length > MAX_ZONE_NAME_LENGTH) {
        uiAlert(t('long_zone'), {
            title: t('zones')
        });
        return null;
    }
    return trimmed;
}

function canonZoneName(s) {
    return (s ?? "")
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_RE, "") // quita acentos
    .replace(/\s+/g, " ") // colapsa espacios
    .trim();
}

function isZoneNameTaken(name, {
    excludeId = null
} = {}) {
    const cand = canonZoneName(name);
    if (!cand)
        return false;
    return zones.some(z =>
        z &&
        canonZoneName(z.name) === cand &&
        (excludeId == null || String(z.id) !== String(excludeId)));
}

// --- Reusable helpers ---
function buildZonePopup(zone) {
    const { latitude, longitude, radius } = zone;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
    const r = fmt0(radius * 3.28084); // metros -> pies
    const unit = t('feet');
    return `
    <strong>${zone.name || t("zone_without_name")}</strong><br>
    ${t('radius')}: ${r} ${unit}
    <br><br><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer"><strong>${t('open_location')}</strong></a>
  `;
}

// === public helpers to look up zones by id ===
export function getZoneById(id) {
    return zones.find(z => String(z?.id) === String(id)) || null;
}

export function getZoneStyleById(id) {
    const z = getZoneById(id);
    if (!z)
        return null;
    const baseHex = DEFAULT_COLOR;
    return {
        id: z.id,
        name: z.name,
        lat: z.latitude,
        lon: z.longitude,
        color: baseHex,
    };
}
