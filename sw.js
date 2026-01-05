// TinyTube Service Worker for API Caching
// Cache API responses for 5-10 minutes to improve performance

const CACHE_NAME = 'tinytube-api-cache-v1';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds
const MAX_CACHE_ENTRIES = 50; // Limit cache size to prevent storage bloat

// API patterns to cache
const CACHEABLE_APIS = [
    'trending',
    'search',
    'popular',
    'feed',
    '/api/v1/trending',
    '/api/v1/popular',
    '/api/v1/search'
];

// Check if URL should be cached
function shouldCache(url) {
    return CACHEABLE_APIS.some(pattern => url.includes(pattern));
}

// Enforce cache size limit using LRU strategy
async function enforceCacheLimit(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_CACHE_ENTRIES) {
        // Delete oldest entries (first in cache)
        const entriesToDelete = keys.length - MAX_CACHE_ENTRIES;
        for (let i = 0; i < entriesToDelete; i++) {
            await cache.delete(keys[i]);
        }
        console.log(`Service Worker: Deleted ${entriesToDelete} old cache entries`);
    }
}

// Install event
self.addEventListener('install', (event) => {
    console.log('Service Worker: Installing...');
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    console.log('Service Worker: Activating...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Clearing old cache');
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// Fetch event with caching strategy
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = request.url;

    // Only cache GET requests to API endpoints
    if (request.method !== 'GET' || !shouldCache(url)) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            try {
                // Try to get from cache first
                const cachedResponse = await cache.match(request);

                if (cachedResponse) {
                    // Check if cache is still fresh
                    const cachedTime = cachedResponse.headers.get('sw-cached-time');
                    if (!cachedTime || Number.isNaN(parseInt(cachedTime, 10))) {
                        console.log('Service Worker: Cache timestamp missing/invalid, invalidating:', url);
                        await cache.delete(request);
                    } else {
                        const age = Date.now() - parseInt(cachedTime, 10);
                        if (age < CACHE_DURATION) {
                            console.log('Service Worker: Serving from cache:', url);
                            // Fetch in background to update cache
                            fetch(request)
                                .then(response => {
                                    if (response && response.status === 200) {
                                        const responseClone = response.clone();
                                        const headers = new Headers(responseClone.headers);
                                        headers.append('sw-cached-time', Date.now().toString());

                                        responseClone.blob().then(blob => {
                                            const newResponse = new Response(blob, {
                                                status: responseClone.status,
                                                statusText: responseClone.statusText,
                                                headers: headers
                                            });
                                            cache.put(request, newResponse);
                                        });
                                    }
                                })
                                .catch(() => {});

                            return cachedResponse;
                        }
                    }
                }

                // Fetch from network
                console.log('Service Worker: Fetching from network:', url);
                const response = await fetch(request);

                // Cache successful responses
                if (response && response.status === 200) {
                    const responseClone = response.clone();

                    // Add timestamp header
                    const headers = new Headers(responseClone.headers);
                    headers.append('sw-cached-time', Date.now().toString());

                    responseClone.blob().then(blob => {
                        const newResponse = new Response(blob, {
                            status: responseClone.status,
                            statusText: responseClone.statusText,
                            headers: headers
                        });
                        cache.put(request, newResponse);
                        // Enforce cache size limit after adding new entry
                        enforceCacheLimit(cache);
                    });
                }

                return response;
            } catch (error) {
                console.log('Service Worker: Fetch failed, trying cache:', error);
                // If network fails, try cache even if expired
                const cachedResponse = await cache.match(request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                throw error;
            }
        })
    );
});

// Message event for cache control
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        event.waitUntil(
            caches.delete(CACHE_NAME).then(() => {
                console.log('Service Worker: Cache cleared');
            })
        );
    }
});
