//
// AUTH
//

import { haUrl } from '../globals.js';
import { fetchTokenRefresh, fetchAuthCallback } from './fetch.js';

let inflight = null;

export async function authCallback() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has("code")) {
            const code = urlParams.get("code");
            await fetchAuthCallback(code);
        }
    } catch (error) {
        console.error("Error during authentication:", error);
        throw error;
    }
}

export async function getToken() {
    // Avoid parallel requests
    if (!inflight) {
        inflight = (async() => {
            const inIframe = window !== window.parent;
            if (inIframe) {
                const { token, exp } = await requestTokenFromParent(); // exp in ms or 0
                if (!token || !token.trim())
                    throw new Error("Empty token from parent");
                return token;
            } else {
                // Standalone mode (no iframe): use local HA auth if available
                await authenticate(); // existing function
                const raw = localStorage.getItem("hassTokens");
                const tokens = raw ? JSON.parse(raw) : null;
                if (!tokens?.access_token)
                    throw new Error("No access_token in hassTokens");

                const expMs = typeof tokens.expires === "number" ? tokens.expires : 0;
				const now = Date.now();
                if (expMs && now >= expMs) {
                    throw new Error("Token has expired");
                }
                return tokens.access_token;
            }
        })().finally(() => {
            inflight = null;
        });
    }
    return inflight;
}

function requestTokenFromParent(timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const reqId = Math.random().toString(36).slice(2);
        const expectedSource = window.parent;

        // Try to derive the parent's real origin from the referrer; otherwise use the iframe's
        let parentOrigin = "";
        try {
            parentOrigin = new URL(document.referrer).origin;
        } catch {}
        if (!parentOrigin)
            parentOrigin = window.location.origin;

        const timer = setTimeout(() => {
            window.removeEventListener("message", onMsg);
            reject(new Error("Token not returned"));
        }, timeoutMs);

        function onMsg(event) {
            // 1) check that it comes from the parent
            if (event.source !== expectedSource)
                return;

            // 2) check the origin (of the parent). We allow both parentOrigin and the local origin in case of deployments where both match.
            if (event.origin !== parentOrigin && event.origin !== window.location.origin)
                return;

            const d = event.data || {};
            if (d.type === "auth-token" && d.reqId === reqId && d.token) {
                clearTimeout(timer);
                window.removeEventListener("message", onMsg);
                // d.exp may arrive in ms (as sent from the card/panel). Normalize it to a number or 0.
                const exp = (typeof d.exp === "number" && isFinite(d.exp)) ? d.exp : 0;
                resolve({
                    token: d.token,
                    exp
                });
            }
        }

        window.addEventListener("message", onMsg);

        // Send the request to the derived origin (if this fails in your environment, use "*" but keep the security checks in onMsg)
        window.parent.postMessage({
            type: "request-token",
            reqId
        }, parentOrigin || "*");
    });
}

async function authenticate() {
    const storedTokensRaw = localStorage.getItem("hassTokens");

    try {
        if (storedTokensRaw) {
            const tokenData = JSON.parse(storedTokensRaw);

            // Check whether the token is still valid
            const exp = Number(tokenData.expires || 0);
            if (exp && Date.now() < (exp - 15 * 60 * 1000)) {
                return; // Stop the flow if the token is valid
            }

            console.log("The token has expired. Trying to renew it...");
            const renewed = await renewToken(tokenData.refresh_token);
            if (renewed)
                return; // Stop the flow if the token renews successfully
        }

        // Redirect if there is no valid token
        console.log("No valid token found. Redirecting to authorize...");

        const redirectUri = `${haUrl}/life180/index.html`;
        const authUrl = `${haUrl}/auth/authorize?client_id=${encodeURIComponent(`${haUrl}/`)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
        window.location.href = authUrl;
    } catch (error) {
        console.error("Error during authenticate:", error);
    }
}

async function renewToken(refreshToken) {
    try {
        const tokenData = await fetchTokenRefresh(refreshToken);

        if (!tokenData) {
            console.error("Failed to renew token.");
            return false;
        }

        // Retrieve the original token to copy missing data
        const storedTokensRaw = localStorage.getItem("hassTokens");
        if (!storedTokensRaw) {
            console.error("No existing token found in local storage.");
            return false;
        }

        const originalTokens = JSON.parse(storedTokensRaw);

        // Copy missing fields from the original token
        tokenData.refresh_token = originalTokens.refresh_token; // keep the refresh_token
        tokenData.hassUrl = originalTokens.hassUrl; // ensure hassUrl is kept
        tokenData.clientId = originalTokens.clientId; // keep clientId
        tokenData.ha_auth_provider = originalTokens.ha_auth_provider; // keep ha_auth_provider

        // Compute and store the new expiry
        tokenData.expires = Date.now() + tokenData.expires_in * 1000;

        // Store the renewed token in localStorage
        localStorage.setItem("hassTokens", JSON.stringify(tokenData));
        console.log("Token renewed and stored:", tokenData);

        return true;
    } catch (error) {
        console.error("Error processing renewed token:", error);
        return false; // signals that the renewal failed
    }
}
