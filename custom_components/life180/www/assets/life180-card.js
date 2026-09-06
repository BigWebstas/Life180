import { html, css, LitElement } from "https://cdn.jsdelivr.net/npm/lit@2.8.0/+esm";

// Reads the version from the card resource itself: ...life180-card.js?v=X.Y.Z
const CARD_VERSION = (() => {
    try {
        return new URL(import.meta.url).searchParams.get("v") || "";
    } catch {
        return "";
    }
})();

const RELOAD_TS_KEY = "life180:last-reload-ts";

class Life180Card extends LitElement {
    static properties = {
        hass: {
            attribute: false
        },
        _height: {
            state: true
        },
        config: {
            attribute: false
        },
    };

    setConfig(config) {
        this.config = {
            title: config.title ?? "Life180",
            height: config.height ?? "600px", // px, %, vh...
            src: config.src,
        };
        // height used by getCardSize()
        this._height = this.config.height;
    }

    /** Approximate size in "rows" (50 px) for the editor */
    getCardSize() {
        const px = parseInt(this._height, 10) || 600;
        return Math.ceil(px / 50) + 1;
    }

    render() {
        const src = this._iframeSrc();
        return html `
      <ha-card>
        <iframe
          id="life180-iframe"
          src=${src}
          style="width:100%;height:${this._height};border:none;"
          loading="lazy"
        ></iframe>
      </ha-card>
    `;
    }

    static styles = css `
    :host {
      display: block;
    }
    ha-card {
      overflow: hidden;
    }
  `;

    /** Build the iframe URL, honoring sub-paths/proxy and adding the card's ?v= */
    _iframeSrc() {
        // 1) if the user passed a src in the config, use it (and add ?v= if absent)
        const base =
            this.config?.src ||
            this.hass?.hassUrl?.("/life180/index.html") ||
            new URL("life180/index.html", location.href).toString();

        try {
            const u = new URL(base, location.href);
            if (CARD_VERSION && !u.searchParams.has("v")) {
                u.searchParams.set("v", CARD_VERSION);
            }
            return u.toString();
        } catch {
            // fallback if base is not a valid URL for new URL()
            return CARD_VERSION && !String(base).includes("?")
             ? `${base}?v=${encodeURIComponent(CARD_VERSION)}`
             : base;
        }
    }

    firstUpdated() {
        // Prepare to answer token requests from the iframe and set the origin
        this._setupTokenResponder();
        try {
            const src = this._iframeSrc();
            this._iframeOrigin = new URL(src, location.href).origin;
        } catch {
            this._iframeOrigin = location.origin;
        }
    }

    connectedCallback() {
        super.connectedCallback();
        this._startVersionWatcher();

        // visibilitychange -> when back to visible, reset the throttle if versions match
        this._onVisibilityBound = async() => {
            if (document.visibilityState === "visible") {
                await this._maybeResetReloadThrottle();
            }
        };
        document.addEventListener("visibilitychange", this._onVisibilityBound);

        // IntersectionObserver -> when the card enters the viewport, reset the throttle if versions match
        this._onIntersectBound = async(entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                await this._maybeResetReloadThrottle();
            }
        };
        this._io = new IntersectionObserver(this._onIntersectBound, {
            threshold: 0.2
        });
        this._io.observe(this);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopVersionWatcher();

        if (this._onVisibilityBound) {
            document.removeEventListener("visibilitychange", this._onVisibilityBound);
            this._onVisibilityBound = null;
        }
        if (this._io) {
            try {
                this._io.disconnect();
            } catch {}
            this._io = null;
        }
        if (this._onMessageBound) {
            window.removeEventListener("message", this._onMessageBound);
            this._onMessageBound = null;
        }
    }

    _startVersionWatcher() {
        if (this._versionTimer)
            return;
        this._reloaded = false;
        this._versionTimer = setInterval(() => {
            if (document.visibilityState !== "visible")
                return;
            this._checkAndMaybeReload();
        }, 3000);
    }

    _stopVersionWatcher() {
        if (this._versionTimer) {
            clearInterval(this._versionTimer);
            this._versionTimer = null;
        }
    }

    async _checkAndMaybeReload() {
        const sv = await this._fetchServerVersion();
        if (!sv || !CARD_VERSION || sv === CARD_VERSION)
            return;
        if (this._reloaded)
            return;

        const ready =
            document.visibilityState === "visible" &&
            this.isConnected &&
            this.hass?.connection?.connected &&
            !this._isEditMode();
        if (!ready)
            return;

        if (!(await this._tryMarkReload(30000)))
            return;

        this._reloaded = true;
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                window.location.reload();
            }));
    }

    async _maybeResetReloadThrottle() {
        try {
            const sv = await this._fetchServerVersion();
            if (sv && CARD_VERSION && sv === CARD_VERSION) {
                sessionStorage.setItem(RELOAD_TS_KEY, "0");
            }
        } catch {}
    }

    _setupTokenResponder() {
        const SKEW_MS = 60_000; // refresh if <60s left
        const FALLBACK_TTL_MS = 8 * 60 * 1000; // if the token has no 'exp'

        let lastToken = "";
        let lastExpMs = 0;
        let lastGotAt = 0;
        let refreshing = null;

        const getCurrentToken = () =>
        this.hass?.auth?.data?.access_token ||
        this.hass?.connection?.options?.auth?.accessToken ||
        "";

        // Decode the JWT (Base64URL -> Base64) and get 'exp' in ms
        const tokenExpMs = (tok) => {
            try {
                const part = tok?.split(".")?.[1];
                if (!part)
                    return 0;
                const base64 = part.replace(/-/g, "+").replace(/_/g, "/")
                    .padEnd(Math.ceil(part.length / 4) * 4, "=");
                const payload = JSON.parse(atob(base64));
                return payload?.exp ? payload.exp * 1000 : 0;
            } catch {
                return 0;
            }
        };

        // Does it need refreshing?
        const needRefresh = (tok) => {
            if (!tok)
                return true;

            const expMs = tokenExpMs(tok);
            if (expMs) {
                lastExpMs = expMs;
                return (Date.now() + SKEW_MS) >= expMs;
            }
            // no 'exp': use the fallback TTL since we obtained it
            return (Date.now() - lastGotAt) > FALLBACK_TTL_MS;
        };

        const getFreshToken = async() => {
            let t = getCurrentToken();
            if (!needRefresh(t))
                return t;

            // Refresh throttle to avoid parallel refreshes
            refreshing ??= (async() => {
                try {
                    await this.hass?.auth?.refreshAccessToken?.();
                } catch (e) {
                    console.warn("refreshAccessToken failed:", e);
                }
                const nt = getCurrentToken();
                if (nt) {
                    lastToken = nt;
                    lastGotAt = Date.now();
                    lastExpMs = tokenExpMs(nt) || 0;
                }
            })();
            try {
                await refreshing;
            } finally {
                refreshing = null;
            }

            return getCurrentToken();
        };

        this._onMessageBound = async(ev) => {
            if (ev.data?.type !== "request-token")
                return;

            // Security: origin + iframe window
            if (this._iframeOrigin && ev.origin && ev.origin !== this._iframeOrigin)
                return;
            const iframe = this.renderRoot.querySelector("#life180-iframe");
            if (!iframe || iframe.contentWindow !== ev.source)
                return;

            // wait for hass to exist (async dashboard)
            for (let i = 0; i < 50 && !this.hass; i++)
                await new Promise(r => setTimeout(r, 100));

            const token = await getFreshToken();
            if (!token) {
                console.warn("No token available to send");
                return;
            }

            // Update the cache if it changed
            if (token !== lastToken) {
                lastToken = token;
                lastExpMs = tokenExpMs(token) || 0;
                lastGotAt = Date.now();
            }

            const targetOrigin = ev.origin || this._iframeOrigin || location.origin;
            ev.source.postMessage({
                type: "auth-token",
                token,
                reqId: ev.data?.reqId,
                exp: lastExpMs || undefined
            },
                targetOrigin);
        };

        window.addEventListener("message", this._onMessageBound);
    }

    async _tryMarkReload(waitTime = 30000) {
        const now = Date.now();

        try {
            const last = Number(sessionStorage.getItem(RELOAD_TS_KEY) || 0);
            if (now - last <= waitTime)
                return false;
            sessionStorage.setItem(RELOAD_TS_KEY, String(now));
            return true;
        } catch {}

        // Fallback without sessionStorage (strict private browsing, etc.)
        if (!this._noStoragePromise) {
            this._noStoragePromise = new Promise((resolve) => {
                setTimeout(() => {
                    this._noStoragePromise = null; // release for future attempts
                    resolve(true);
                }, waitTime);
            });
        }
        return this._noStoragePromise;
    }

    _isEditMode() {
        try {
            const ha = document.querySelector("home-assistant");
            const main = ha?.shadowRoot?.querySelector("home-assistant-main");
            const panel = main?.shadowRoot?.querySelector("ha-panel-lovelace");
            const root = panel?.shadowRoot?.querySelector("hui-root");
            return !!root?.lovelace?.editMode;
        } catch {
            return false;
        }
    }

    async _fetchServerVersion() {
        try {
            const data = await this.hass.callApi("GET", "life180/config");
            return data?.version ?? null;
        } catch (err) {
            console.error("Failed to fetch config:", err);
            return null;
        }
    }

}

if (!customElements.get("life180-card")) {
    customElements.define("life180-card", Life180Card);
}

/* Card visible in the visual editor */
window.customCards = window.customCards || [];
window.customCards.push({
    type: "life180-card",
    name: "Life180",
    description: "Life180 Card",
    preview: true,
});
