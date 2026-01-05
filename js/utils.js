(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;

// --- CHROME 56 POLYFILLS ---
// Chrome 56 (Tizen 4.0) is missing several modern JavaScript features
// Provide minimal polyfills for compatibility

// 1. AbortController (NOT in Chrome 56)
if (typeof AbortController === 'undefined') {
    console.log('TinyTube: Adding AbortController polyfill for Chrome 56');

    window.AbortSignal = function() {
        this._aborted = false;
        this._listeners = [];
    };
    AbortSignal.prototype.addEventListener = function(type, listener) {
        if (type === 'abort') {
            this._listeners.push(listener);
        }
    };
    AbortSignal.prototype.removeEventListener = function(type, listener) {
        if (type === 'abort') {
            const idx = this._listeners.indexOf(listener);
            if (idx !== -1) this._listeners.splice(idx, 1);
        }
    };
    AbortSignal.prototype._fire = function() {
        if (this._aborted) return;
        this._aborted = true;
        this._listeners.forEach(function(listener) {
            try { listener(); } catch(e) { console.error('AbortSignal listener error:', e); }
        });
    };
    Object.defineProperty(AbortSignal.prototype, 'aborted', {
        get: function() { return this._aborted; }
    });

    window.AbortController = function() {
        this.signal = new AbortSignal();
    };
    AbortController.prototype.abort = function() {
        this.signal._fire();
    };
}

// 2. Object.entries() (NOT in Chrome 56)
if (!Object.entries) {
    console.log('TinyTube: Adding Object.entries polyfill for Chrome 56');
    Object.entries = function(obj) {
        var ownProps = Object.keys(obj);
        var i = ownProps.length;
        var resArray = new Array(i);
        while (i--) {
            resArray[i] = [ownProps[i], obj[ownProps[i]]];
        }
        return resArray;
    };
}

// 3. Object.fromEntries() (NOT in Chrome 56)
if (!Object.fromEntries) {
    console.log('TinyTube: Adding Object.fromEntries polyfill for Chrome 56');
    Object.fromEntries = function(entries) {
        var obj = {};
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            obj[entry[0]] = entry[1];
        }
        return obj;
    };
}

// 4. Promise.prototype.finally() (NOT in Chrome 56 - added in Chrome 63)
if (typeof Promise !== 'undefined' && !Promise.prototype.finally) {
    console.log('TinyTube: Adding Promise.finally polyfill for Chrome 56');
    Promise.prototype.finally = function(callback) {
        var P = this.constructor;
        return this.then(
            function(value) {
                return P.resolve(callback()).then(function() { return value; });
            },
            function(reason) {
                return P.resolve(callback()).then(function() { throw reason; });
            }
        );
    };
}

// --- O(1) LRU CACHE ---
function LRUCache(limit) {
    this.limit = limit;
    this.map = new Map();
}
LRUCache.prototype.get = function(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
};
LRUCache.prototype.set = function(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.limit) {
        this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, val);
};
LRUCache.prototype.has = function(key) { return this.map.has(key); };
LRUCache.prototype.delete = function(key) { return this.map.delete(key); };

// --- WEB WORKER FOR JSON PARSING ---
const WorkerPool = {
    worker: null,
    pendingTasks: new Map(),
    taskId: 0,

    init: function() {
        if (!CONFIG.WEB_WORKER_ENABLED || this.worker) return;

        try {
            // Create inline worker for JSON parsing
            const workerCode = `
                self.onmessage = function(e) {
                    const { id, type, data } = e.data;
                    try {
                        let result;
                        if (type === 'parse') {
                            result = JSON.parse(data);
                        } else if (type === 'stringify') {
                            result = JSON.stringify(data);
                        }
                        self.postMessage({ id, result, error: null });
                    } catch (error) {
                        self.postMessage({ id, result: null, error: error.message });
                    }
                };
            `;

            const blob = new Blob([workerCode], { type: 'application/javascript' });
            this.worker = new Worker(URL.createObjectURL(blob));

            this.worker.onmessage = (e) => {
                const { id, result, error } = e.data;
                const task = this.pendingTasks.get(id);
                if (task) {
                    if (error) {
                        task.reject(new Error(error));
                    } else {
                        task.resolve(result);
                    }
                    this.pendingTasks.delete(id);
                }
            };
        } catch (e) {
            console.log('Worker init failed:', e.message);
            this.worker = null;
        }
    },

    parse: function(jsonString) {
        if (!this.worker || jsonString.length < 10000) {
            // Use main thread for small payloads
            return Promise.resolve().then(() => JSON.parse(jsonString));
        }

        return new Promise((resolve, reject) => {
            const id = this.taskId++;
            this.pendingTasks.set(id, { resolve, reject });
            this.worker.postMessage({ id, type: 'parse', data: jsonString });
        });
    }
};

const PerformanceUtils = {
    throttle: function(func, wait) {
        let timeout = null;
        let previous = 0;

        return function(...args) {
            const now = Date.now();
            const remaining = wait - (now - previous);

            if (remaining <= 0 || remaining > wait) {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                previous = now;
                func.apply(this, args);
            } else if (!timeout) {
                timeout = setTimeout(() => {
                    previous = Date.now();
                    timeout = null;
                    func.apply(this, args);
                }, remaining);
            }
        };
    },

    debounce: function(func, wait) {
        let timeout = null;

        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                func.apply(this, args);
            }, wait);
        };
    }
};

const EventBus = (() => {
    const listeners = {};
    return {
        on: (event, handler) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        },
        off: (event, handler) => {
            if (!listeners[event]) return;
            listeners[event] = listeners[event].filter(cb => cb !== handler);
        },
        emit: (event, payload) => {
            if (!listeners[event]) return;
            listeners[event].forEach(handler => {
                try { handler(payload); } catch (e) { console.error('EventBus handler error:', e); }
            });
        }
    };
})();

const el = (id) => {
    if (typeof id === "string" && (id.startsWith("card-") || id.startsWith("title-"))) {
        return document.getElementById(id);
    }
    const app = TinyTube.App;
    // Check cache first for frequently accessed elements
    if (app && app.cachedElements && app.cachedElements[id]) {
        return app.cachedElements[id];
    }
    const element = document.getElementById(id);
    // Cache the element for future lookups
    if (element && app && app.cachedElements) {
        app.cachedElements[id] = element;
    }
    return element;
};

const SafeStorage = {
    setItem: (key, value) => {
        try {
            localStorage.setItem(key, value);
            return { success: true, trimmedHistory: null, trimmedKey: null };
        } catch (e) {
            let cleanup = null;
            if (e.name === CONFIG.LOCALSTORAGE_QUOTA_EXCEEDED || e.name === 'QuotaExceededError') {
                console.log(`localStorage quota exceeded for key: ${key}`);
                // Implement LRU eviction strategy
                cleanup = SafeStorage.freeUpSpace(key, value);
                if (cleanup && cleanup.freed) {
                    let retryValue = value;
                    if (cleanup.trimmedKey === key && cleanup.trimmedHistory) {
                        retryValue = JSON.stringify(cleanup.trimmedHistory);
                    }
                    // Retry after cleanup
                    try {
                        localStorage.setItem(key, retryValue);
                        return { success: true, trimmedHistory: cleanup.trimmedHistory, trimmedKey: cleanup.trimmedKey };
                    } catch (retryError) {
                        console.log(`localStorage quota still exceeded after cleanup`);
                        Utils.toast("Storage full - data may not save");
                        return { success: false, trimmedHistory: cleanup.trimmedHistory, trimmedKey: cleanup.trimmedKey };
                    }
                }
            } else {
                console.log(`localStorage error: ${e.message}`);
            }
            return { success: false, trimmedHistory: cleanup ? cleanup.trimmedHistory : null, trimmedKey: cleanup ? cleanup.trimmedKey : null };
        }
    },
    freeUpSpace: (currentKey, currentValue = null) => {
        try {
            let freed = false;
            let trimmedHistory = null;
            let trimmedKey = null;

            // 1. Clear cipher cache if not the current key
            const cipherKey = CONFIG.CIPHER_CACHE_KEY;
            if (currentKey !== cipherKey && localStorage.getItem(cipherKey)) {
                localStorage.removeItem(cipherKey);
                console.log('Cleared cipher cache');
                freed = true;
            }

            // 2. Clear oldest history entries (keep only last 25 instead of 50)
            for (let pid = 0; pid < 3; pid++) {
                const historyKey = `tt_history_${pid}`;
                const historyData = historyKey === currentKey && currentValue
                    ? Utils.safeParse(currentValue, {})
                    : Utils.safeParse(localStorage.getItem(historyKey), {});
                const entries = Object.entries(historyData);
                if (entries.length > 25) {
                    // Sort by timestamp and keep only newest 25
                    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
                    const trimmed = Object.fromEntries(entries.slice(0, 25));
                    localStorage.setItem(historyKey, JSON.stringify(trimmed));
                    console.log(`Trimmed history for profile ${pid}: ${entries.length} -> 25`);
                    freed = true;
                    if (historyKey === currentKey) {
                        trimmedHistory = trimmed;
                        trimmedKey = historyKey;
                    }
                }
            }

            // 3. Clear DeArrow cache (in-memory, but reset it)
            if (TinyTube.App && TinyTube.App.deArrowCache && TinyTube.App.deArrowCache.map) {
                TinyTube.App.deArrowCache.map.clear();
                console.log('Cleared DeArrow cache');
            }

            return { freed, trimmedHistory, trimmedKey };
        } catch (cleanupError) {
            console.log(`Cleanup error: ${cleanupError.message}`);
            return { freed: false, trimmedHistory: null, trimmedKey: null };
        }
    },
    getItem: (key, fallback = null) => {
        try {
            return localStorage.getItem(key) || fallback;
        } catch (e) {
            console.log(`localStorage read error for ${key}: ${e.message}`);
            return fallback;
        }
    },
    removeItem: (key) => {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            console.log(`localStorage remove error for ${key}: ${e.message}`);
            return false;
        }
    }
};

const sanitizeVideoId = function(value) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
};

let fetchDedupNonce = 0;

const Utils = {
    create: (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    },
    safeParse: (str, def) => {
        try {
            const parsed = JSON.parse(str);
            return parsed === undefined ? def : parsed;
        } catch {
            return def;
        }
    },
    throttle: (func, wait) => PerformanceUtils.throttle(func, wait),
    debounce: (func, wait) => PerformanceUtils.debounce(func, wait),
    fetchWithTimeout: (url, options = {}, timeout = CONFIG.TIMEOUT) => {
        // FIX: Removed manual Accept-Encoding header to prevent CORS preflight
        // Browsers automatically handle compression negotiation (gzip, deflate, br)
        // Manually setting this header converts "Simple Request" to "Complex Request"
        // which forces an OPTIONS preflight, adding 200-500ms latency per request
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const originalSignal = options.signal;
            let timedOut = false;
            let abortHandler = null;
            const cleanup = () => {
                if (abortHandler && originalSignal) {
                    originalSignal.removeEventListener('abort', abortHandler);
                }
            };
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                cleanup();
                reject(new Error('Fetch timeout'));
            }, timeout);

            // Handle abort signal cleanup
            if (originalSignal) {
                abortHandler = () => {
                    if (!timedOut) {
                        clearTimeout(timer);
                        controller.abort();
                        cleanup();
                        reject(new DOMException('Aborted', 'AbortError'));
                    }
                };
                originalSignal.addEventListener('abort', abortHandler);
            }

            const mergedOptions = Object.assign({}, options, { signal: controller.signal });
            fetch(url, mergedOptions).then(res => {
                if (!timedOut) {
                    clearTimeout(timer);
                    cleanup();
                    resolve(res);
                }
            }).catch(err => {
                if (!timedOut) {
                    clearTimeout(timer);
                    cleanup();
                    reject(err);
                }
            });
        });
    },
    fetchDedup: async (url, options = {}, timeout = CONFIG.TIMEOUT) => {
        if (options.signal) {
            return Utils.fetchWithTimeout(url, options, timeout);
        }
        const buildCacheKey = () => {
            try {
                const method = (options.method || 'GET').toUpperCase();
                let headersEntries = [];
                if (options.headers) {
                    if (typeof Headers !== 'undefined') {
                        const headersObj = options.headers instanceof Headers
                            ? options.headers
                            : new Headers(options.headers);
                        headersEntries = Array.from(headersObj.entries());
                    } else if (Array.isArray(options.headers)) {
                        headersEntries = options.headers;
                    } else if (typeof options.headers === 'object') {
                        headersEntries = Object.entries(options.headers);
                    } else {
                        headersEntries = [[String(options.headers), '']];
                    }
                }

                const normalized = {
                    method: method,
                    headers: headersEntries
                };

                const normalizeBody = (body) => {
                    if (body == null) return null;
                    if (typeof body === 'string') return body;
                    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                        return body.toString();
                    }
                    if (typeof FormData !== 'undefined' && body instanceof FormData) {
                        const entries = [];
                        if (typeof body.forEach !== 'function') return null;
                        body.forEach((value, key) => {
                            let normalizedValue = null;
                            if (typeof value === 'string') {
                                normalizedValue = value;
                            } else if (typeof File !== 'undefined' && value instanceof File) {
                                normalizedValue = {
                                    name: value.name,
                                    size: value.size,
                                    type: value.type,
                                    lastModified: value.lastModified
                                };
                            } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
                                normalizedValue = { size: value.size, type: value.type };
                            } else {
                                normalizedValue = String(value);
                            }
                            entries.push([key, normalizedValue]);
                        });
                        entries.sort((a, b) => {
                            const keyCompare = a[0].localeCompare(b[0]);
                            if (keyCompare !== 0) return keyCompare;
                            return JSON.stringify(a[1]).localeCompare(JSON.stringify(b[1]));
                        });
                        return JSON.stringify(entries);
                    }
                    if (typeof body === 'object') {
                        const stableStringify = (value) => {
                            if (value === null || typeof value !== 'object') {
                                return JSON.stringify(value);
                            }
                            if (Array.isArray(value)) {
                                return '[' + value.map(stableStringify).join(',') + ']';
                            }
                            const keys = Object.keys(value).sort();
                            const items = keys.map((key) => {
                                return JSON.stringify(key) + ':' + stableStringify(value[key]);
                            });
                            return '{' + items.join(',') + '}';
                        };
                        return stableStringify(body);
                    }
                    return null;
                };

                const normalizedBody = normalizeBody(options.body);
                if (normalizedBody !== null) {
                    normalized.body = normalizedBody;
                } else if (options.body !== undefined) {
                    return null;
                }

                return url + '|' + JSON.stringify(normalized);
            } catch (e) {
                return null;
            }
        };

        const normalizedKey = buildCacheKey();
        const cacheKey = normalizedKey || (url + '|dedup-skip:' + Date.now() + ':' + (fetchDedupNonce++));
        const app = TinyTube.App;
        if (app && app.pendingFetches && app.pendingFetches[cacheKey]) {
            if (CONFIG.DEBUG) {
                console.log('TinyTube: fetchDedup hit for key', cacheKey);
            }
            return app.pendingFetches[cacheKey];
        }
        const promise = Utils.fetchWithTimeout(url, options, timeout)
            .finally(() => {
                if (app && app.pendingFetches) delete app.pendingFetches[cacheKey];
            });
        if (app && app.pendingFetches) {
            app.pendingFetches[cacheKey] = promise;
        }
        return promise;
    },
    processQueue: async (items, limit, asyncFn) => {
        let results = new Array(items.length);
        const executing = [];
        for (let i = 0; i < items.length; i++) {
            const idx = i;
            const p = asyncFn(items[i]).then(r => { results[idx] = r; });
            const wrapped = p.then(() => {
                const pos = executing.indexOf(wrapped);
                if (pos !== -1) executing.splice(pos, 1);
            });
            executing.push(wrapped);
            if (executing.length >= limit) await Promise.race(executing);
        }
        await Promise.all(executing);
        return results;
    },
    isValidUrl: (s) => { try { return s.startsWith("http"); } catch { return false; } },
    toast: (msg) => {
        const t = el("toast");
        if (!t) return;
        t.textContent = msg;
        t.classList.remove("hidden");
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.add("hidden"), CONFIG.TOAST_DURATION_MS);
    },
    formatTime: (sec) => {
        if (!sec || isNaN(sec)) return "0:00";
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        return (h > 0 ? h + ":" : "") + (m < 10 && h > 0 ? '0' + m : m) + ":" + (s < 10 ? '0' + s : s);
    },
    formatViews: (num) => {
        if (!num) return "";
        if (typeof num === 'string') return num;
        if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + "M views";
        if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + "K views";
        return num + " views";
    },
    formatDate: (ts) => {
        if (!ts) return "";
        const diff = (Date.now() / 1000) - ts;
        if (diff < 3600) return Math.floor(diff / 60) + " min ago";
        if (diff < 86400) return Math.floor(diff / 3600) + " hours ago";
        if (diff < 604800) return Math.floor(diff / 86400) + " days ago";
        if (diff < 2592000) return Math.floor(diff / 604800) + " weeks ago";
        if (diff < 31536000) return Math.floor(diff / 2592000) + " months ago";
        return Math.floor(diff / 31536000) + " years ago";
    },
    sanitizeVideoId: sanitizeVideoId,
    getVideoId: (item) => {
        if (!item) return null;
        var raw = item.videoId || (item.url && (item.url.match(CONFIG.REGEX_URL_VIDEO_PARAM) || [])[1]);
        if (!raw) return null;
        return sanitizeVideoId(raw);
    },
    findSegment: (time) => {
        const segs = (TinyTube.App && TinyTube.App.sponsorSegs) || [];
        let l = 0, r = segs.length - 1;
        while (l <= r) {
            const m = Math.floor((l + r) / 2);
            const s = segs[m];
            if (time >= s.segment[0] && time < s.segment[1]) return s;
            if (time < s.segment[0]) r = m - 1;
            else l = m + 1;
        }
        return null;
    },
    getAuthorThumb: (item) => {
        if (!item) return "default.png";
        if (item.authorThumbnails && item.authorThumbnails[0]) return item.authorThumbnails[0].url;
        if (item.thumb) return item.thumb;
        return "default.png";
    },
    clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
    getFormatHeight: (format) => {
        if (!format) return 0;
        if (format.height) return format.height;
        if (format.qualityLabel) {
            const match = format.qualityLabel.match(CONFIG.REGEX_QUALITY_LABEL);
            if (match) return parseInt(match[1], 10);
        }
        return 0;
    },
    getPreferredMaxResolution: () => {
        const stored = SafeStorage.getItem("tt_max_res");
        const parsed = parseInt(stored, 10);
        const allowed = [360, 480, 720, 1080];
        if (allowed.includes(parsed)) return parsed;
        return 1080;
    },
    applyResolutionCap: (formats) => {
        const cap = Utils.getPreferredMaxResolution();
        if (!cap) return formats || [];
        const filtered = (formats || []).filter(f => {
            const height = Utils.getFormatHeight(f);
            return height && height <= cap;
        });
        return filtered.length ? filtered : (formats || []);
    },
    isHighRes: (format) => {
        const label = (format.qualityLabel || "").toLowerCase();
        return label.includes("2160") || label.includes("4k") || Utils.getFormatHeight(format) > 1080;
    },
    pickPreferredStream: (formats) => {
        const candidates = Utils.applyResolutionCap((formats || []).filter(f => {
            if (!f) return false;
            if (f.container === "mp4") return true;
            return f.mimeType && f.mimeType.indexOf("video/mp4") !== -1;
        }));
        const filtered = candidates.filter(f => !Utils.isHighRes(f));
        const byHeight = (a, b) => Utils.getFormatHeight(b) - Utils.getFormatHeight(a);
        const prefers = (list) => list.sort(byHeight);
        const prefer1080 = prefers(filtered.filter(f => Utils.getFormatHeight(f) === 1080));
        if (prefer1080.length) return prefer1080[0];
        const prefer720 = prefers(filtered.filter(f => Utils.getFormatHeight(f) === 720));
        if (prefer720.length) return prefer720[0];
        const fallback = prefers(filtered);
        return fallback[0] || null;
    }
};

TinyTube.LRUCache = LRUCache;
TinyTube.WorkerPool = WorkerPool;
TinyTube.PerformanceUtils = PerformanceUtils;
TinyTube.EventBus = EventBus;
TinyTube.SafeStorage = SafeStorage;
TinyTube.Utils = Utils;
TinyTube.el = el;
})(window);
