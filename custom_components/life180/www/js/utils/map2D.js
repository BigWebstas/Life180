// utils/map2D.js 

import { loadCSSOnce, loadScriptOnce } from './loader.js';
import {t} from './i18n.js';
import { tileUrl, basemapSource, onThemeChange } from '../globals.js';

export let map;

const v = '1.9.4';

const CDN = {
	leafletCSS: './vendor/leaflet/leaflet.css?v='+v,
	leafletJS:  './vendor/leaflet/leaflet.js?v='+v,
	geocoderCSS:'./vendor/leaflet-control-geocoder/Control.Geocoder.css?v='+v,
	geocoderJS: './vendor/leaflet-control-geocoder/Control.Geocoder.js?v='+v,
	editableJS: './vendor/leaflet-editable/Leaflet.Editable.min.js?v='+v,
};

async function ensureLeafletLoaded() {
  await loadCSSOnce(CDN.leafletCSS);
  await loadCSSOnce(CDN.geocoderCSS);

  await loadScriptOnce(CDN.leafletJS,  { test: () => !!window.L });
  await loadScriptOnce(CDN.editableJS, { test: () => !!(window.L && L.Editable) });
  await loadScriptOnce(CDN.geocoderJS, { test: () => !!(window.L && L.Control && L.Control.Geocoder) });
}

export async function initMap() {
    try {
		await ensureLeafletLoaded();

        // Default map configuration
        const mapOptions = {
            center: [40.4168, -3.7038], // Madrid
            zoom: 6,
            editable: true,
			preferCanvas: true,   
        };

        // Initialize the map
        map = L.map('map', mapOptions);

        // Base layer: OSM in light, CARTO dark in dark. No layer switcher.
        const baseTiles = L.tileLayer(tileUrl(basemapSource()), {
            maxZoom: 19,
            minZoom: 1,
            crossOrigin: true,
            attribution: '© OpenStreetMap contributors, © CARTO',
        }).addTo(map);
        onThemeChange(() => baseTiles.setUrl(tileUrl(basemapSource())));

		map.attributionControl.setPosition('bottomleft');

        // Scale in the bottom-left so it does not collide with the geocoder
        const scaleCtl = L.control.scale({
            position: 'bottomleft'
        }).addTo(map);

        // ---- Invalidations for size/visibility ----
        const invalidate = () => map && map.invalidateSize(true);

        document.body.addEventListener(
            "transitionend",
            (e) => {
            if (e.target === document.body && e.propertyName === "opacity") {
                setTimeout(invalidate, 0);
            }
        }, {
            once: true
        });

        const mapEl = document.getElementById("map");
        if (mapEl && "ResizeObserver" in window) {
            const ro = new ResizeObserver(() => invalidate());
            ro.observe(mapEl);
        }

        window.addEventListener("resize", invalidate);
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden)
                setTimeout(invalidate, 0);
        });

        setTimeout(invalidate, 350);

        // ---- Geocoder en bottom-left ----
        const acceptLang = (navigator.languages && navigator.languages.length)
         ? navigator.languages.join(',')
         : (navigator.language || 'en');

        const geocoder = L.Control.geocoder({
            position: 'bottomleft',
            placeholder: t('search_place'), 
            collapsed: false,
            defaultMarkGeocode: false,
            geocoder: L.Control.Geocoder.nominatim({
                geocodingQueryParams: {
                    'accept-language': acceptLang,
                    limit: 5
                    // email: 'your_email@example.com'
                }
            })
        })
            .on('markgeocode', (e) => {
                const { center, name, bbox } = e.geocode;
                if (bbox)
                    map.fitBounds(bbox);
                else
                    map.setView(center, 16);

                L.popup({
                    // useful options:
                    autoClose: true, // closes other popups
                    closeOnClick: true, // closes when clicking the map
                    keepInView: true // tries to keep it in view on pan/zoom
                    // className: 'my-popup' // for custom styles
                })
                .setLatLng(center)
                .setContent(name)
                .openOn(map);
            })
            .addTo(map);

        // Bias by current view (for local search; remove bounded for global)
        function updateSearchBias() {
            const b = map.getBounds();
            geocoder.options.geocoder.options.geocodingQueryParams.viewbox =
                [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
            geocoder.options.geocoder.options.geocodingQueryParams.bounded = 1; // remove this line for global
        }
        map.on('moveend', updateSearchBias);
        updateSearchBias();
		
		setTimeout(() => map.invalidateSize(true), 0);

    } catch (error) {
        console.error("Error starting map:", error);
    }
}

export function isValidCoordinates(lat, lng) {
    return lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
}

export function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = degToRad(lat2 - lat1);
    const dLon = degToRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // returns the distance in meters
}

function degToRad(deg) {
    return deg * (Math.PI / 180);
}
