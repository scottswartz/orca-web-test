// Orca Tools (the /m page) as an installed phone app. Network first, so it's always the latest
// build when online; anything already loaded is kept so the tools still open with no signal
const CACHE = "orca-tools";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET" || !request.url.startsWith(self.location.origin))
        return;

    event.respondWith(fetchAndKeep(request));
});

async function fetchAndKeep(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        // Deep links come back as 404.html (the app itself), so those are kept too
        if (response.ok || request.mode === "navigate")
            cache.put(request, response.clone());
        return response;
    }
    catch (error) {
        // Offline: any page address opens the app, which then routes itself
        const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" })
            ?? (request.mode === "navigate" ? await cache.match(new URL("m", self.registration.scope)) : undefined);
        if (cached)
            return cached;
        throw error;
    }
}
