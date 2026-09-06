
import { t } from './i18n.js';
import { map } from './map.js';
import { SHOW_VISITS } from '../globals.js';
import { updateZoneActionButtons } from '../screens/zones.js';

const invalidateSoon = () => requestAnimationFrame(() => map?.invalidateSize(true));

export async function loadUI() {
    try {
        enhanceSelectWithIcons(document.getElementById('combo-select')); // screen

        const personSelect = document.getElementById('person-select');
        if (personSelect) {
            personSelect.dataset.defaultIcon = 'users';
            enhanceSelectWithIcons(personSelect);
        }

        const exportSelect = document.getElementById('export-filter');
        if (exportSelect) {
            exportSelect.dataset.defaultIcon = 'export';
            enhanceSelectWithIcons(exportSelect);
        }

        const filterContainer = document.getElementById('forms-container');
        if (window.innerWidth <= 600) {
            filterContainer.classList.add('hidden');
            filterContainer.classList.remove('visible');
        } else {
            filterContainer.classList.add('visible');
            filterContainer.classList.remove('hidden');
        }

        // Ensure all content stays hidden until the stylesheets and the DOM are ready
        if (!document.body.classList.contains('loaded')) {
            document.body.classList.add('loaded');
        }
    } catch (error) {
        console.error("Error during load:", error);
    }
}

export async function updateUI() {
    // hide VISITS in FILTER -> ZONES
    // If the <style> already exists, reuse it; otherwise create it
    let style = document.getElementById('visits-col-css');
    if (!style) {
        style = document.createElement('style');
        style.id = 'visits-col-css';
        document.head.appendChild(style);
    }

    // When hidden: hide <th data-i18n="visits"> and the 3rd body column
    style.textContent = SHOW_VISITS ? '' : `
        #summary-zones-table thead th[data-i18n="visits"] { display: none !important; }
        #summary-zones-table-body tr > td:nth-child(3) { display: none !important; }
    `;

    // FILTER -> POSITIONS -> speed
    const unitSpeed = t('mi_per_hour');
    const unitDistKm = t('miles');
    const unitDistMeters = t('feet');

    document
    .querySelectorAll('#positions-table thead th[data-i18n="speed"], #positions thead th[data-i18n="speed"]')
    .forEach(th => {
        const label = th.querySelector('.hdr-label');
        if (label)
            label.textContent = unitSpeed;
        else
            th.textContent = unitSpeed; // fallback when there is no structure
    });

    // FILTER -> ZONES -> distance (with the same fallback)
    document
    .querySelectorAll('#summary-zones-table thead th[data-i18n="distance"]')
    .forEach(th => {
        const label = th.querySelector('.hdr-label');
        if (label)
            label.textContent = unitDistKm;
        else
            th.textContent = unitDistKm; // <- this was the problem
    });

    // ZONAS -> radio
    document
    .querySelectorAll('#zones-table thead th[data-i18n="radius"] .hdr-label')
    .forEach(el => {
        el.textContent = `${unitDistMeters}`;
    });

    // PERSONS -> speed
    document
    .querySelectorAll('#persons-table thead th[data-i18n="speed"] .hdr-label')
    .forEach(el => {
        el.textContent = `${unitSpeed}`;
    });
}

window.addEventListener("message", (ev) => {
    if (ev.data?.type === "ping") {
        try {
            ev.source?.postMessage({
                type: "pong",
                id: ev.data.id
            }, ev.origin || "*");
        } catch {}
    }
});

document.getElementById('hamburger-button').addEventListener('click', async() => {
    try {
        await toggleContainer();
        invalidateSoon();
    } catch (error) {
        console.error("Error handling menu button:", error);
    }
});

document.getElementById('combo-select').addEventListener('change', function () {
    try {
        const selectedValue = this.value; // gets the selected value
        const filterContainer = document.getElementById('filter-container');
        const zonesContainer = document.getElementById('zones-container');
        const personsContainer = document.getElementById('persons-container');

        if (selectedValue === 'filter') {
            // Show filterContainer
            filterContainer.style.display = 'block';
            zonesContainer.style.display = 'none';
            personsContainer.style.display = 'none';
        } else if (selectedValue === 'zones') {
            // Show zonesContainer
            filterContainer.style.display = 'none';
            zonesContainer.style.display = 'block';
            personsContainer.style.display = 'none';

            // Do not select any zone when entering "zones"
            const zonesTableBody = document.getElementById('zones-table-body');
            if (zonesTableBody) {
                zonesTableBody.querySelectorAll('tr.selected')
                .forEach(r => r.classList.remove('selected'));
            }

            updateZoneActionButtons();

        } else if (selectedValue === 'users') {
            // Show personsContainer
            filterContainer.style.display = 'none';
            zonesContainer.style.display = 'none';
            personsContainer.style.display = 'block';

            // Do not select any person when entering "persons"
            const personsTableBody = document.getElementById('persons-table-body');
            if (personsTableBody) {
                personsTableBody.querySelectorAll('tr.selected')
                .forEach(r => r.classList.remove('selected'));
            }
            if (typeof updatePersonsTable === 'function') {
                updatePersonsTable();
            }
        }

        // close any popup open on the map:
        if (typeof map !== 'undefined' && map && typeof map.closePopup === 'function')
            map.closePopup();

        invalidateSoon();
    } catch (error) {
        console.error("Error during combo-select:", error);
    }
});

async function toggleContainer() {
    try {
        const formsContainer = document.getElementById('forms-container');
        const isHidden = formsContainer.classList.contains('hidden');

        if (isHidden) {
            // Show the edit container
            formsContainer.classList.remove('hidden');
            formsContainer.classList.add('visible');
        } else {
            // Hide the edit container
            formsContainer.classList.add('hidden');
            formsContainer.classList.remove('visible');
        }
    } catch (error) {
        console.error("Error during toggleContainer:", error);
    }
}

// SVG icons (extend this map whenever you want)
const ICONS = {
    users: '<path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z"/>',
    zones: '<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 14.5 9 2.5 2.5 0 0 1 12 11.5z"/>',
    filter: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
    export: '<path d="M12 3v10"/><path d="M8 7l4-4 4 4"/><path d="M4 21h16v-2a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2z"/>',
    dot: '<circle cx="12" cy="12" r="5"/>'
};
const svg = (name) =>
`<svg class="id-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;

function enhanceSelectWithIcons(select) {
    if (!select || select.dataset.enhanced === "1")
        return;

    // Wrapper and button
    const wrap = document.createElement('div');
    wrap.className = 'id-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'id-toggle';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', select.id + '-menu');

    const menu = document.createElement('div');
    menu.className = 'id-menu';
    menu.id = select.id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-hidden', 'true');
    menu.hidden = true;

    // Insert the UI and hide the select
    select.classList.add('id-visually-hidden');
    select.parentNode.insertBefore(wrap, select.nextSibling);
    wrap.appendChild(btn);
    wrap.appendChild(menu);

    function currentOption() {
        return select.selectedOptions[0] || select.options[0];
    }

    function iconFor(opt) {
        // Priority: option's data-icon -> select's data-default-icon -> value -> dot
        return (opt?.dataset.icon) || select.dataset.defaultIcon || (opt?.value) || 'dot';
    }

    function updateButtonLabel() {
        const opt = currentOption();
        const iconName = iconFor(opt);
        btn.innerHTML = `${svg(iconName)}<span class="id-text">${opt?.text || ''}</span><span class="id-caret" aria-hidden="true">▾</span>`;
    }

    function buildMenu() {
        menu.innerHTML = '';
        Array.from(select.options).forEach((opt, idx) => {
            const optBtn = document.createElement('button');
            optBtn.type = 'button';
            optBtn.className = 'id-option';
            optBtn.setAttribute('role', 'option');
            optBtn.dataset.value = opt.value;
            optBtn.setAttribute('aria-selected', String(opt.selected));
            optBtn.innerHTML = `${svg(iconFor(opt))}<span>${opt.text}</span>`;
            if (opt.disabled) {
                optBtn.disabled = true;
                optBtn.style.opacity = .5;
                optBtn.style.cursor = 'not-allowed';
            }
            optBtn.addEventListener('click', () => {
                if (opt.disabled)
                    return;
                select.value = opt.value;
                select.dispatchEvent(new Event('change', {
                        bubbles: true
                    }));
                closeMenu();
                btn.focus();
            });
            menu.appendChild(optBtn);
            // Roving tabindex within the menu
            optBtn.tabIndex = (opt.selected || (!select.value && idx === 0)) ? 0 : -1;
        });
    }

    function openMenu() {
        buildMenu();
        menu.hidden = false;
        menu.setAttribute('aria-hidden', 'false');
        btn.setAttribute('aria-expanded', 'true');
        // Focus the selected option
        const selected = menu.querySelector('.id-option[aria-selected="true"]') || menu.querySelector('.id-option');
        selected?.focus();
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKeyNav);
    }

    function closeMenu() {
        menu.hidden = true;
        menu.setAttribute('aria-hidden', 'true');
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKeyNav);
    }

    function toggleMenu() {
        if (menu.hidden)
            openMenu();
        else
            closeMenu();
    }

    function onDocClick(e) {
        if (!wrap.contains(e.target))
            closeMenu();
    }

    function onKeyNav(e) {
        const focusables = Array.from(menu.querySelectorAll('.id-option:not([disabled])'));
        const idx = focusables.indexOf(document.activeElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMenu();
            btn.focus();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            (focusables[idx + 1] || focusables[0])?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            (focusables[idx - 1] || focusables.at(-1))?.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            focusables[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            focusables.at(-1)?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
            if (document.activeElement?.classList.contains('id-option')) {
                e.preventDefault();
                document.activeElement.click();
            }
        }
    }

    // Sync if your logic changes the <select>
    select.addEventListener('change', () => {
        updateButtonLabel();
        // Mark selected in the menu if it is open
        menu.querySelectorAll('.id-option').forEach(b => {
            b.setAttribute('aria-selected', String(b.dataset.value === select.value));
        });
    });

    // Open/close and navigation from the button
    btn.addEventListener('click', toggleMenu);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu();
        }
    });

    // Observer: if you add/remove/modify options, it updates automatically
    const obs = new MutationObserver(() => {
        updateButtonLabel();
        if (!menu.hidden)
            buildMenu();
    });
    obs.observe(select, {
        childList: true,
        subtree: true,
        characterData: true
    });

    // Initial
    updateButtonLabel();
    select.dataset.enhanced = "1";
}
