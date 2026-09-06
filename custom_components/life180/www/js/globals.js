//	
// GLOBALS
//

import { fetchAdmin, fetchConnection, fetchConfig, fetchManifest } from './ha/fetch.js';
import { currentLang, t } from './utils/i18n.js';



export const USE_MAP = '3D';
export const SHOW_VISITS = false;
export const DEFAULT_COLOR = '#008000';
export const DEFAULT_ALPHA = 0.3

// Number formatters
export const fmt0 = formatNumber({
    max: 0
}); // integers (auto locale -> en-GB fallback)
export const fmt2 = formatNumber({
    min: 2,
    max: 2
}); // 2 decimals (auto locale -> en-GB fallback)

export let isAdmin = false;
export let isConnected = false;
export let version = "";
export let updateInterval = 10;
export let geocodeTime = 30;
export let geocodeDistance = 20;
export let updatePos = 1;
export let enableDebug = false;

// Raster tile URL template for a base layer. Always routed through the local
// tile endpoint; when the server-side cache is disabled that endpoint just
// redirects to upstream. Libraries substitute {z}/{x}/{y}.
export function tileUrl(source) {
    return `${haUrl}/api/life180/tile/${source}/{z}/{x}/{y}`;
}

// --- Theme -----------------------------------------------------------------
// True when the app should render dark. Embedded in HA the theme bridge (see
// index.html) stamps data-ha-dark on <html>; standalone we fall back to the
// OS preference.
export function isDarkTheme() {
    try {
        const haDark = document.documentElement.getAttribute('data-ha-dark');
        if (haDark === '1') return true;
        if (haDark === '0') return false;
        return !!(window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
        return false;
    }
}

// Run `cb` whenever the effective light/dark state may have changed.
export function onThemeChange(cb) {
    const fire = () => { try { cb(); } catch (e) { console.error(e); } };
    try {
        window.matchMedia('(prefers-color-scheme: dark)')
            .addEventListener('change', fire);
    } catch {}
    try {
        new MutationObserver(fire).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-ha-dark', 'data-theme', 'class', 'style'],
        });
    } catch {}
}

// Store for the original console references
const originalConsole = {
    log: console.log,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
};

// Home Assistant base URL (overridable via ?haUrl=... in the URL)
function normalizeHaUrl(input) {
  if (!input) return null;
  let s = String(input).trim();

  // Supports "scheme-relative" URLs (//host:port)
  if (s.startsWith("//")) s = `${location.protocol}${s}`;

  try {
    // If there is no protocol, resolve it relative to the page (supports "/proxy" or "ha")
    const hasProto = /^https?:\/\//i.test(s);
    const u = hasProto ? new URL(s) : new URL(s, window.location.href);

    // KEEP origin + pathname (do not trim the base path)
    // and remove only the trailing slashes
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    console.warn("[haUrl] Invalid value in query:", input, "-> using location.origin");
    return null;
  }
}

const qs = new URLSearchParams(window.location.search);
const haUrlOverride = qs.get("haUrl") ?? qs.get("haurl") ?? qs.get("ha_url");
export const haUrl = normalizeHaUrl(haUrlOverride) ?? location.origin;



export async function updateAdmin() {
    try {
		isAdmin = await fetchAdmin();
    } catch (error) {
        console.error("Error checking admin set:", error);
		throw error;
    }
}

export async function updateConfig() {
    try {
		const config = await fetchConfig();		
		
		if (config){

			version = config.version;

			if (typeof config.update_interval === "number" && config.update_interval >= 10) {
				updateInterval = config.update_interval;
			}		
			if (typeof config.geocode_time === "number" && config.geocode_time >= 10) {
				geocodeTime = config.geocode_time;
			}	
			if (typeof config.geocode_distance === "number" && config.geocode_distance >= 20) {
				geocodeDistance = config.geocode_distance;
			}	
			if (typeof config.enable_debug === "boolean") {
				enableDebug = config.enable_debug;
			}
		}
		await configureConsole();		
		console.log("Configuration: ", config);
    } catch (error) {
        console.error("Error checking admin set: ", error);
		throw error;
    }
}

export async function updateConnection() {
    try {
		isConnected = await fetchConnection();
    } catch (error) {
        console.error("Error checking the connection establishment:", error);
		throw error;
    }
}

export async function isActive() {
    try {
        await fetchManifest();
        return true;
    } catch (error) {
        console.warn(`HA is Inactive`);
        return false;
    }
}

export async function configureConsole() {
    if (!enableDebug) {
        // Production mode: disable console messages except warnings and errors
        console.log = () => {};
        console.debug = () => {};
        console.info = () => {};
        console.warn = (...args) => originalConsole.warn("[WARNING]:", ...args);
        console.error = (...args) => originalConsole.error("[ERROR]:", ...args);
    } else {
        // Development mode: enable messages with timestamps
        const getTimeStamp = () => {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
            return `[${hours}:${minutes}:${seconds}:${milliseconds}]`;
        };

        console.log = (...args) => originalConsole.log(getTimeStamp(), ...args);
        console.debug = (...args) => originalConsole.debug(getTimeStamp(), ...args);
        console.info = (...args) => originalConsole.info(getTimeStamp(), ...args);
        console.warn = (...args) => originalConsole.warn(getTimeStamp(), "[WARNING]:", ...args);
        console.error = (...args) => originalConsole.error(getTimeStamp(), "[ERROR]:", ...args);
    }
}

export function formatDate(date, hour = true) {
    const parsedDate = new Date(date);
	if (hour) {
		const options = {
			weekday: 'short',
			day: '2-digit',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		};
		// Use `currentLang` or a default language (e.g. 'en')
		return parsedDate.toLocaleString(currentLang || 'en', options);
	} else {
		const options = {
			weekday: 'long',
			day: '2-digit',
			month: 'short',
			hour12: false,
		};
		// Use `currentLang` or a default language (e.g. 'en')
		return parsedDate.toLocaleString(currentLang || 'en', options);
	}
}

function formatNumber({
    locale,
    min = 0,
    max = 0,
    grouping = true
} = {}) {
  // Browser locale; if unavailable, en-GB
  const L =
    locale ??
    ((typeof navigator !== "undefined" &&
      (navigator.languages?.[0] || navigator.language)) ||
      "en-GB");

  const nf = new Intl.NumberFormat(L, {
    style: "decimal",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
    useGrouping: grouping,           // forces group separators (1,234 / 1.234 / 1 234... per locale)
  });

  return n => nf.format(Number(n) || 0);
}