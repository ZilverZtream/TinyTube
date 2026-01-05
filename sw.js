// TinyTube Service Worker for API Caching
// Cache API responses for 5-10 minutes to improve performance

const CACHE_NAME = 'tinytube-api-cache-v2';
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds
const MAX_CACHE_ENTRIES = 50; // Limit cache size to prevent storage bloat

// API paths safe to cache
const CACHEABLE_PATHS = [
    '/trending',
    '/api/v1/trending'
];

const cacheContext = {
    profileId: '0',
    customBase: ''
};
let cacheDisabled = false;

// Check if URL should be cached
function shouldCache(url) {
    const pathname = url.pathname;
    return CACHEABLE_PATHS.some((path) => pathname === path);
}

function isSafeToCache(request) {
    return !request.headers.has('Authorization') && !request.headers.has('Cookie');
}

function buildCacheKey(request) {
    const url = new URL(request.url);
    const acceptLanguage = request.headers.get('Accept-Language') || '';
    url.searchParams.set('__sw_accept_language', acceptLanguage);
    url.searchParams.set('__sw_profile', cacheContext.profileId);
    url.searchParams.set('__sw_api', cacheContext.customBase);
    return new Request(url.toString(), { method: 'GET' });
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
    const url = new URL(request.url);

    // Only cache GET requests to API endpoints
    if (cacheDisabled || request.method !== 'GET' || !shouldCache(url) || !isSafeToCache(request)) {
        return;
    }

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cacheKey = buildCacheKey(request);
            try {
                // Try to get from cache first
                const cachedResponse = await cache.match(cacheKey);

                if (cachedResponse) {
                    // Check if cache is still fresh
                    const cachedTime = cachedResponse.headers.get('sw-cached-time');
                    if (!cachedTime || Number.isNaN(parseInt(cachedTime, 10))) {
                        console.log('Service Worker: Cache timestamp missing/invalid, invalidating:', url);
                        await cache.delete(cacheKey);
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
                                            cache.put(cacheKey, newResponse);
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
                        cache.put(cacheKey, newResponse);
                        // Enforce cache size limit after adding new entry
                        enforceCacheLimit(cache);
                    });
                }

                return response;
            } catch (error) {
                console.log('Service Worker: Fetch failed, trying cache:', error);
                // If network fails, try cache even if expired
                const cachedResponse = await cache.match(cacheKey);
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
    if (event.data && event.data.type === 'SET_CACHE_CONTEXT') {
        const nextProfileId = event.data.profileId;
        const nextCustomBase = event.data.customBase;
        cacheContext.profileId = nextProfileId !== undefined ? String(nextProfileId) : cacheContext.profileId;
        cacheContext.customBase = nextCustomBase || '';
        cacheDisabled = event.data.disableCache === true;
    }
});
