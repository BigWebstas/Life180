//
// MAIN
//

import { version, isActive, updateAdmin, updateConfig, updateInterval } from './globals.js';
import { initMap } from './utils/map.js';
import { loadUI, updateUI } from './utils/ui.js';
import { authCallback } from './ha/auth.js';
import { updatePersons, fitMapToAllPersons } from './screens/persons.js';
import { initZones, updateZones } from './screens/zones.js';
import { initFilter } from './screens/filter.js';
import { initializeI18n, t } from './utils/i18n.js';
import { showWindowOverlay, hideWindowOverlay } from './utils/dialogs.js';

document.addEventListener("DOMContentLoaded", async() => {
    try {
        // Handle authentication if there is a `code` parameter
        await authCallback();

        // Initialize the app
        await init();
    } catch (error) {
        console.error("Error during DOMContentLoaded:", error);
    }
});

async function init() {
    try {
        await initializeI18n();
        await initFilter();
        await initZones();
        await initMap();
        await update();
        await fitMapToAllPersons(); // zoom to the set of devices
        await loadUI();

        // Run in the background with initial error handling
        startUpdateLoop(); // no .catch: these already handle their own errors

    } catch (error) {
        console.error("Error during init:", error);
    }
}

//
// ------ UPDATE LOOP synchronized with rAF ------
// Runs update() every updateInterval seconds,
// only while the document is visible
//
function startUpdateLoop() {
    let lastRun = performance.now();

    async function frame(now) {
        // If the UI is "frozen" (e.g. Flatpickr open), do not fire updates
        if (window.__freezeUpdates > 0) {
            requestAnimationFrame(frame);
            return;
        }

        const PERIOD = (updateInterval ?? 10) * 1000; // ms
        if (now - lastRun >= PERIOD) {
            lastRun = now;
            try {
                await update();
            } catch (err) {
                console.error("update() failed:", err);
            }
        }
        requestAnimationFrame(frame); // next frame
    }

    requestAnimationFrame(frame); // start
}

async function update() {
    try {
        // Run the functions in order and stop if an error occurs
        const active = await isActive();
        if (active) {
            await updateConfig();
            await updateVersion();
            await updateAdmin();
            await updatePersons();
            await updateZones();
            await updateUI();
            hideWindowOverlay();
        } else {
            showWindowOverlay(t('disconnected'), "rgba(255, 0, 0, 0.5)", "white", "rgba(200, 0, 0, 0.8)");
        }
    } catch (error) {
        console.error("Error during major update:", error);
    }
}

async function updateVersion() {
    try {
        const inIframe = window.self !== window.top;
        if (!inIframe && version) {
            const url = new URL(window.location.href);
            const currV = url.searchParams.get("v");
            if (currV !== version) {
                url.searchParams.set("v", version);
                const next = url.toString();
                if (next !== window.location.href) {
                    window.location.replace(next);
                }
            }
        }
    } catch (error) {
        console.error("Error during updateVersion:", error);
    }
}
