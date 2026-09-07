// life180.js - vanilla Web Component (production)

// Reads the version set in module_url: "...life180.js?v=0.0.30"
const PANEL_VERSION = (() => {
    try {
        return new URL(import.meta.url).searchParams.get("v") || "";
    } catch {
        return "";
    }
})();

// null = undetermined; true/false = dark/light. Handles #rgb, #rrggbb,
// rgb()/rgba() and the black/white keywords.
function _isDarkColor(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    if (str === "transparent" || str === "white" || str === "#fff" || str === "#ffffff") return false;
    if (str === "black" || str === "#000" || str === "#000000") return true;
    let r, g, b;
    const m = str.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
    else {
        let h = str.replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (h.length < 6 || /[^0-9a-f]/.test(h.slice(0, 6))) return null;
        r = parseInt(h.slice(0, 2), 16);
        g = parseInt(h.slice(2, 4), 16);
        b = parseInt(h.slice(4, 6), 16);
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}

class Life180Panel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({
            mode: "open"
        });
        this.shadowRoot.innerHTML = `
      <style>
        :host{
          display:block; height:100%;
          background:var(--primary-background-color);
          color:var(--primary-text-color);
          font-family:var(--mdc-typography-font-family,
            system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",
            "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji");
          -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
          position:relative;
        }
        .wrap {display:flex; flex-direction:column; min-height:0; height:100vh;}
        @supports (height: 100dvh) {.wrap{ height:100dvh; }}
        .toolbar{
          height:calc(56px + env(safe-area-inset-top));
          padding-top:env(safe-area-inset-top);
          display:flex; align-items:center; gap:12px; padding:0 12px;
          background:var(--app-header-background-color, var(--primary-color));
          color:var(--app-header-text-color, #fff);
          font:inherit;
        }
        .menu-btn{
          background:transparent; border:0; color:inherit;
          width:40px; height:40px; border-radius:8px; cursor:pointer;
          display:grid; place-items:center;
        }
        .menu-btn svg{ width:24px; height:24px; display:block; }
        @media (min-width:872px){ .menu-btn{ display:none; } }
        .title{
          font:inherit; font-size:20px;
          font-weight: var(--ha-toolbar-title-weight, 400);
          flex-grow:1; text-align:left; padding-left:16px; color:inherit;
        }
        .content{ flex:1 1 auto; min-height:0; display:flex; overscroll-behavior:contain; }
        iframe{ flex:1 1 auto; min-height:0; width:100%; border:none; display:block; }

        /* optional: styles to react to the narrow mode */
        :host(.is-narrow) .title { font-size:18px; padding-left:8px; }
      </style>

      <div class="wrap">
        <header class="toolbar" role="toolbar">
          <button type="button" class="menu-btn" aria-label="Open menu">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16"/>
            </svg>
          </button>
          <div class="title">Life180</div>
        </header>

        <main class="content">
          <iframe id="life180-iframe" title="Life180"></iframe>
        </main>
      </div>
    `;
    }

    static get observedAttributes() {
        return ["narrow"];
    }

    // Home Assistant injects .hass and .narrow as props on the custom element
    set hass(val) {
        this._hass = val;
        // If the context changes (e.g. mobile app/proxy), rebuild the URL
        if (this.isConnected)
            this._setIframeSrc();
    }
    get hass() {
        return this._hass;
    }

    // Reflect the .narrow prop into a class/attribute for optional styles
    set narrow(v) {
        const on = !!v;
        this.classList.toggle("is-narrow", on);
        this.toggleAttribute("narrow", on);
    }

    attributeChangedCallback(name, _oldV, newV) {
        if (name === "narrow") {
            const on = newV !== null && newV !== "false";
            this.classList.toggle("is-narrow", on);
        }
    }

    connectedCallback() {
        // Save and force margin 0 on <body>, then restore it in disconnected
        this._prevBodyMargin = document.body.style.margin;
        document.body.style.margin = "0";

        const iframe = this.shadowRoot.getElementById("life180-iframe");
        if (iframe) {
            // Harden the iframe (security)
            iframe.setAttribute(
                "sandbox",
                [
                    "allow-scripts",
                    "allow-same-origin",
                    "allow-forms",
                    "allow-modals",
                    "allow-popups",
                    "allow-popups-to-escape-sandbox",
                    "allow-top-navigation-by-user-activation",
                    "allow-downloads"
                ].join(" "));
            iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
            // If you need extra APIs, uncomment: iframe.setAttribute("allow", "fullscreen; clipboard-write");

            // Load/failure signals (detecting network/CORS problems)
            iframe.addEventListener("error", () => {
                console.error("iframe load error");
            }, {
                once: true
            });
        }

        this.shadowRoot.querySelector(".menu-btn")?.addEventListener("click", () => this._toggleMenu());

        // Handlers
        this._visHandler = () => {
            if (!document.hidden)
                this._syncThemeFromParent();
        };
        this._pageShow = (e) => {
            if (e.persisted)
                this._syncThemeFromParent();
        };
        this._msgHandler = (ev) => {
            this._handleTokenRequest(ev);
            this._maybeAnswerThemeRequest(ev);
        };
        this._themeHandler = () => this._syncThemeFromParent();

        // Watch for parent theme changes (event and mutations on <html>)
        try {
            window.addEventListener("ha-theme-changed", this._themeHandler);
            const P = window.parent;
            const root = P?.document?.documentElement;
            if (root && "MutationObserver" in window) {
                this._themeMO = new MutationObserver(this._themeHandler);
                this._themeMO.observe(root, {
                    attributes: true,
                    attributeFilter: ["style", "class"]
                });
            }
        } catch (err) {
            console.log("Theme observers not attached:", err?.message || err);
        }

        document.addEventListener("visibilitychange", this._visHandler);
        window.addEventListener("message", this._msgHandler);
        window.addEventListener("pageshow", this._pageShow);

        // Initialization
        this._syncThemeFromParent();
        this._setIframeSrc();
    }

    disconnectedCallback() {
        // Listener cleanup
        document.removeEventListener("visibilitychange", this._visHandler);
        window.removeEventListener("pageshow", this._pageShow);
        window.removeEventListener("message", this._msgHandler);
        window.removeEventListener("ha-theme-changed", this._themeHandler);
        try {
            this._themeMO?.disconnect();
        } catch {}

        // Restore the original <body> margin
        if (this._prevBodyMargin !== undefined) {
            document.body.style.margin = this._prevBodyMargin;
        }
    }

    _setIframeSrc() {
        const iframe = this.shadowRoot?.getElementById("life180-iframe");
        if (!iframe)
            return;

        const base =
            this._hass?.hassUrl?.("/life180_static/index.html") ||
            new URL("life180_static/index.html", location.href).toString();

        let url = base;
        try {
            const u = new URL(base, location.href);
            if (PANEL_VERSION && !u.searchParams.has("v")) {
                u.searchParams.set("v", PANEL_VERSION);
            }
            url = u.toString();
            // store the iframe's expected origin
            this._iframeOrigin = u.origin;
        } catch (err) {
            console.error("URL error:", err?.message || err);
            this._iframeOrigin = ""; // unavailable
        }

        if (iframe.src !== url)
            iframe.src = url;
    }

    _toggleMenu() {
        const P = window.parent || window.top;
        try {
            // official event
            P.dispatchEvent(new P.CustomEvent("hass-toggle-menu", {
                    bubbles: true,
                    composed: true
                }));
            P.document.querySelector("home-assistant")
            ?.dispatchEvent(new P.CustomEvent("hass-toggle-menu", {
                    bubbles: true,
                    composed: true
                }));
        } catch {}
        try {
            // internal DOM fallback
            const ha = P.document.querySelector("home-assistant");
            const main = ha?.shadowRoot?.querySelector("home-assistant-main");
            const sr = main?.shadowRoot;
            const drawer = sr?.querySelector("ha-drawer, app-drawer, app-drawer-layout app-drawer");
            if (drawer) {
                if (typeof drawer.toggle === "function")
                    drawer.toggle();
                else {
                    drawer.open = !drawer.open;
                    drawer.dispatchEvent(new P.CustomEvent("opened-changed", {
                            bubbles: true,
                            composed: true,
                            detail: {
                                value: drawer.open
                            }
                        }));
                }
                return;
            }
            if (typeof main?.toggleMenu === "function")
                main.toggleMenu();
        } catch (e) {
            console.error("toggleMenu error:", e?.message || e);
        }
    }

    _syncThemeFromParent() {
        try {
            const P = window.parent;
            const root = P?.document?.documentElement;
            if (!root)
                return;
            const csRoot = P.getComputedStyle(root);
            const csBody = P.getComputedStyle(P.document.body);

            const KEYS = [
                "--app-header-background-color", "--app-header-text-color",
                "--primary-color", "--accent-color",
                "--primary-text-color", "--secondary-text-color", "--text-primary-color",
                "--primary-background-color", "--secondary-background-color",
                "--card-background-color", "--ha-card-background", "--divider-color",
                "--error-color", "--warning-color", "--success-color",
                "--ha-card-border-radius", "--ha-card-box-shadow",
            ];
            const vars = {};
            KEYS.forEach(v => {
                const val = (csRoot.getPropertyValue(v) || "").trim();
                if (val) {
                    vars[v] = val;
                    this.style.setProperty(v, val);
                }
            });

            const famVar = (csRoot.getPropertyValue("--mdc-typography-font-family") || "").trim();
            const famBody = (csBody.fontFamily || "").trim();
            const fam = famVar || famBody ||
                'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji"';
            vars["--mdc-typography-font-family"] = fam;

            document.documentElement.style.setProperty("--mdc-typography-font-family", fam);
            this.style.setProperty("--mdc-typography-font-family", fam);
            this.style.fontFamily = `var(--mdc-typography-font-family, ${fam})`;

            const weightBody = (csBody.fontWeight || "400").toString().trim();
            this.style.setProperty("--ha-toolbar-title-weight", weightBody);

            // Is the HA theme dark? color-scheme, then bg colour (hex or rgb),
            // then the page body bg, then the inverse of the text colour.
            const scheme = (csRoot.getPropertyValue("color-scheme") || "").trim().toLowerCase();
            let dark = null;
            if (scheme.includes("dark") && !scheme.includes("light")) dark = true;
            else if (scheme.includes("light") && !scheme.includes("dark")) dark = false;
            if (dark === null) dark = _isDarkColor(csRoot.getPropertyValue("--primary-background-color"));
            if (dark === null) dark = _isDarkColor(csBody.backgroundColor);
            if (dark === null) {
                const td = _isDarkColor(csRoot.getPropertyValue("--primary-text-color"));
                if (td !== null) dark = !td;
            }
            if (dark === null) dark = false;

            // Relay into the app iframe: its own window.parent may be a bare
            // wrapper with no theme, so it can't read HA directly in every setup.
            this._lastTheme = { vars, dark };
            const iframe = this.shadowRoot?.getElementById("life180-iframe");
            const cw = iframe && iframe.contentWindow;
            if (cw) {
                try {
                    cw.postMessage({ type: "life180-theme", vars, dark },
                        this._iframeOrigin || "*");
                } catch (_) {}
            }
        } catch (err) {
            console.error("syncTheme error:", err?.message || err);
        }
    }

    _maybeAnswerThemeRequest(ev) {
        if (ev?.data?.type !== "life180-request-theme")
            return;
        if (this._lastTheme && ev.source) {
            try {
                ev.source.postMessage(
                    { type: "life180-theme", ...this._lastTheme },
                    ev.origin || this._iframeOrigin || "*");
            } catch (_) {}
        }
        this._syncThemeFromParent();
    }

    async _handleTokenRequest(ev) {
        if (ev?.data?.type !== "request-token")
            return;

        const iframe = this.shadowRoot?.getElementById("life180-iframe");
        if (!iframe || iframe.contentWindow !== ev.source)
            return;

        // Security: validate origin if known
        if (this._iframeOrigin && ev.origin && ev.origin !== this._iframeOrigin) {
            console.log("Message ignored due to unexpected origin:", ev.origin, "≠", this._iframeOrigin);
            return;
        }

        const SKEW_MS = 60_000; // refresh if <60s of life left
        const FALLBACK_TTL_MS = 8 * 60 * 1000; // in case the token has no 'exp'
        this._lastToken ??= "";
        this._lastExpMs ??= 0;
        this._lastGotAt ??= 0;

        // Local functions (all in the same function)
        const getCurrentToken = () =>
        this.hass?.auth?.data?.access_token || // preferred
        this.hass?.connection?.options?.auth?.accessToken || ""; // fallback

        const tokenExpMs = (tok) => {
            try {
                const part = tok?.split(".")?.[1];
                if (!part)
                    return 0;
                // Base64URL -> Base64 + padding
                const base64 = part.replace(/-/g, "+").replace(/_/g, "/")
                    .padEnd(Math.ceil(part.length / 4) * 4, "=");
                const payload = JSON.parse(atob(base64));
                return payload?.exp ? payload.exp * 1000 : 0; // to ms
            } catch {
                return 0;
            }
        };

        const needRefresh = () => {
            if (!this._lastToken)
                return true;
            if (this._lastExpMs)
                return (Date.now() + SKEW_MS) >= this._lastExpMs;
            // no exp: use the fallback TTL
            return (Date.now() - this._lastGotAt) > FALLBACK_TTL_MS;
        };

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // 1) Update the cache from the runtime if it changed
        const runtime = getCurrentToken();
        if (runtime && runtime !== this._lastToken) {
            this._lastToken = runtime;
            this._lastGotAt = Date.now();
            this._lastExpMs = tokenExpMs(runtime) || 0;
        }

        // 2) Refresh if close to expiring (throttled)
        if (needRefresh()) {
            this._refreshing ??= (async() => {
                for (let i = 0; i < 50 && !this.hass; i++)
                    await sleep(100); // wait for hass
                try {
                    await this.hass?.auth?.refreshAccessToken?.();
                } catch (e) {
                    console.warn("refreshAccessToken failed:", e);
                }
                const t = getCurrentToken();
                if (t) {
                    this._lastToken = t;
                    this._lastGotAt = Date.now();
                    this._lastExpMs = tokenExpMs(t) || 0;
                }
            })();
            try {
                await this._refreshing;
            } finally {
                this._refreshing = null;
            }
        }

        const token = this._lastToken;
        if (!token) {
            console.log("No token available to send");
            return;
        }

        // 3) Reply (includes exp so the iframe knows when to ask again)
        const targetOrigin = ev.origin || this._iframeOrigin || location.origin;
        try {
            ev.source.postMessage({
                type: "auth-token",
                token,
                exp: this._lastExpMs || undefined,
                reqId: ev.data?.reqId,
            }, targetOrigin);
        } catch (e) {
            console.error("postMessage failed:", e);
        }
    }

}

if (!customElements.get("life180-panel"))
    customElements.define("life180-panel", Life180Panel);
