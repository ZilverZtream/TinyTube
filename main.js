/**
 * TinyTube Pro v6.1.0 (Tizen 4.0+ Optimized)
 *
 * v6.1.0 Changes:
 * - CRITICAL FIX: Ghost Menu Bug - Captions overlay now receives remote input
 * - CRITICAL FIX: Info Overlay Trap - Can now scroll description with UP/DOWN
 * - NEW: Centralized Input Router with activeLayer tracking (NONE, CONTROLS, COMMENTS, CAPTIONS, INFO)
 * - NEW: Captions controller with full keyboard navigation
 * - NEW: Player.scrollInfo() for scrolling long video descriptions
 * - FIX: All overlays properly lock/unlock input focus
 * - FIX: HUD properly pins when any overlay is visible
 *
 * v6.0.2 Changes:
 * - FIX: Zombie audio race condition - verify app state after async fetch in Player.start
 * - FIX: Add webapis.js for Tizen hardware APIs (screensaver control, 4K switching)
 * - FIX: Disable screensaver during playback to prevent screen dimming
 * - FIX: Sticky keyboard glitch - blur search input when navigating away with DOWN key
 *
 * v6.0.1 Changes:
 * - FIX: Request deduplication now actually used in Feed.loadHome, Feed.fetch, and DeArrow
 * - FIX: Removed unused variable in Utils.processQueue
 *
 * v6.0.0 Changes:
 * - CRITICAL FIX: SponsorBlock no longer blocks video playback (fire-and-forget)
 * - CRITICAL FIX: Grid navigation deadzone on partial last rows
 * - CRITICAL FIX: Fetch timeout with graceful fallback (8s default)
 * - CRITICAL FIX: renderLoop memory leak on Player.start failure
 * - FIX: Seek bounds checking (clamp to 0 - duration)
 * - FIX: JSON parse error handling in Player.start
 * - FIX: Utils.any no longer calls resolve multiple times
 * - PERF: Cached DOM element references in render loop (60fps)
 * - PERF: Stream URL caching to avoid re-fetch on replay
 * - PERF: Request deduplication for concurrent fetches
 * - UI: Buffering spinner overlay during video load
 * - UI: Buffer progress bar (gray) showing preloaded data
 * - UI: Playback speed control (GREEN button: 1x → 1.25x → 1.5x → 2x → 0.5x → 1x)
 * - UI: Continue Watching - resume from last position
 * - UI: Hold-to-seek acceleration (10s → 30s → 60s)
 * - UI: Video info overlay (YELLOW button)
 * - UI: Keyboard shortcuts help (INFO button or hold OK)
 *
 * Previous (v5.1.0):
 * - Fixed: Missing getAuthorThumb function (runtime crash)
 * - Fixed: Incorrect Invidious API endpoint (/streams -> /videos)
 * - Fixed: SponsorBlock skip loop (repeated skipping at segment boundaries)
 * - Fixed: AbortController crash on Tizen 4.0 (uses token pattern)
 * - Fixed: DeArrow pending tokens now cleaned on view change
 * - GPU-accelerated progress bar (CSS transform instead of width)
 * - Lazy image loading with IntersectionObserver (200px preload margin)
 * - O(1) subscription cache (invalidated on change)
 * - O(1) LRU Cache for DeArrow data (200 item limit)
 * - O(log n) Binary Search for SponsorBlock segments
 * - 60 FPS UI loop via requestAnimationFrame
 * - Broken thumbnail fallback to icon.png
 * - Video poster image for better loading UX
 * - Settings modal keyboard navigation (Up/Down arrows)
 */

const FALLBACK_INSTANCES = [
    "https://inv.nadeko.net/api/v1",
    "https://yewtu.be/api/v1",
    "https://invidious.nerdvpn.de/api/v1",
    "https://inv.perditum.com/api/v1"
];
const DYNAMIC_LIST_URL = "https://api.invidious.io/instances.json?sort_by=health";
const SPONSOR_API = "https://sponsor.ajay.app/api/skipSegments";
const DEARROW_API = "https://dearrow.ajay.app/api/branding";
const CONCURRENCY_LIMIT = 3;
const FETCH_TIMEOUT = 8000; // 8 second timeout for all fetches
const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2, 0.5]; // Cycle through these
const SEEK_ACCELERATION_DELAY = 500; // ms before acceleration kicks in
const SEEK_INTERVALS = [10, 30, 60]; // seconds: tap, hold short, hold long
const WATCH_HISTORY_LIMIT = 50; // Max videos to remember position for

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

const App = {
    view: "BROWSE",
    api: null,
    items: [],
    focus: { area: "menu", index: 0 },
    menuIdx: 0,
    profileId: 0,
    playerMode: "BYPASS",
    sponsorSegs: [],
    lastSkippedSeg: null,
    exitCounter: 0,
    deArrowCache: new LRUCache(200),
    streamCache: new LRUCache(50), // Cache stream URLs
    pendingDeArrow: {},
    pendingFetches: {}, // Deduplication: track in-flight requests
    rafId: null,
    subsCache: null,
    subsCacheId: null,
    lazyObserver: null,
    supportsSmoothScroll: true,
    // Player state
    currentVideoId: null,
    currentVideoData: null, // Full video metadata for info overlay
    playbackSpeedIdx: 0,
    captionTracks: [],
    infoKeyTimer: null,
    infoKeyHandled: false,
    // Seek acceleration state
    seekKeyHeld: null, // 'left' or 'right' or null
    seekKeyTime: 0, // When key was first pressed
    seekRepeatCount: 0,
    // Cached DOM elements for render loop (60fps optimization)
    playerElements: null,
    screenSaverState: null,
    // Watch history for resume
    watchHistory: null,
    // Input layer routing - v6.1.0: Centralized input router
    // NONE = standard player, CONTROLS = control bar, COMMENTS/CAPTIONS/INFO = overlays
    activeLayer: "NONE",
    playerControls: {
        active: false,
        index: 0
    }
};

const el = (id) => document.getElementById(id);

// --- 1. UTILS ---
const Utils = {
    create: (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    },
    safeParse: (str, def) => {
        try { return JSON.parse(str) || def; } catch { return def; }
    },
    // Safe Promise.any for Chrome 56 - fixed to only resolve once
    any: (promises) => {
        return new Promise((resolve, reject) => {
            let errors = [];
            let rejected = 0;
            let resolved = false;
            if (promises.length === 0) reject(new Error("No promises"));
            promises.forEach(p => p.then(val => {
                if (!resolved) {
                    resolved = true;
                    resolve(val);
                }
            }).catch(e => {
                errors.push(e);
                rejected++;
                if (rejected === promises.length) reject(errors);
            }));
        });
    },
    // Fetch with timeout (Tizen 4.0 safe - no AbortController)
    fetchWithTimeout: (url, options = {}, timeout = FETCH_TIMEOUT) => {
        return new Promise((resolve, reject) => {
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('Fetch timeout'));
            }, timeout);

            fetch(url, options)
                .then(res => {
                    if (!timedOut) {
                        clearTimeout(timer);
                        resolve(res);
                    }
                })
                .catch(err => {
                    if (!timedOut) {
                        clearTimeout(timer);
                        reject(err);
                    }
                });
        });
    },
    // Deduplicated fetch - prevents duplicate concurrent requests
    fetchDedup: async (url, options = {}, timeout = FETCH_TIMEOUT) => {
        if (App.pendingFetches[url]) {
            return App.pendingFetches[url];
        }
        const promise = Utils.fetchWithTimeout(url, options, timeout)
            .finally(() => { delete App.pendingFetches[url]; });
        App.pendingFetches[url] = promise;
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
    isValidUrl: (string) => {
        try { return string.startsWith("http"); } catch (_) { return false; }
    },
    toast: (msg) => {
        const t = el("toast");
        t.textContent = msg;
        t.classList.remove("hidden");
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
    },
    formatTime: (sec) => {
        if (!sec || isNaN(sec)) return "0:00";
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        if (h > 0) return h + ":" + (m < 10 ? '0' + m : m) + ":" + (s < 10 ? '0' + s : s);
        return m + ":" + (s < 10 ? '0' + s : s);
    },
    formatViews: (num) => {
        if (!num) return "";
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
    formatFullDate: (ts) => {
        if (!ts) return "";
        const d = new Date(ts * 1000);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    },
    getVideoId: (item) => {
        if (!item) return null;
        if (item.videoId) return item.videoId;
        if (!item.url) return null;
        const v = item.url.match(/[?&]v=([^&]+)/);
        if (v) return v[1];
        return null;
    },
    // Binary Search for O(log n) SponsorBlock skipping
    findSegment: (time) => {
        let l = 0, r = App.sponsorSegs.length - 1;
        while (l <= r) {
            const m = (l + r) >>> 1;
            const s = App.sponsorSegs[m];
            if (time >= s.segment[0] && time < s.segment[1]) return s;
            if (time < s.segment[0]) r = m - 1;
            else l = m + 1;
        }
        return null;
    },
    getAuthorThumb: (item) => {
        if (!item) return "icon.png";
        if (item.authorThumbnails && item.authorThumbnails[0]) {
            return item.authorThumbnails[0].url;
        }
        if (item.thumb) return item.thumb;
        return "icon.png";
    },
    // Clamp value between min and max
    clamp: (val, min, max) => Math.max(min, Math.min(max, val))
};

// --- 2. LOCAL DB ---
const DB = {
    loadProfile: () => {
        App.profileId = parseInt(localStorage.getItem("tt_pid") || "0");
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        el("p-name").textContent = names[App.profileId];
        el("modal-profile-id").textContent = `#${App.profileId + 1}`;
        el("profile-name-input").value = names[App.profileId];
        App.subsCache = null;
        App.subsCacheId = null;
        // Load watch history
        App.watchHistory = Utils.safeParse(localStorage.getItem(`tt_history_${App.profileId}`), {});
    },
    saveProfileName: (name) => {
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        names[App.profileId] = name;
        localStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    getSubs: () => {
        if (App.subsCache && App.subsCacheId === App.profileId) {
            return App.subsCache;
        }
        App.subsCache = Utils.safeParse(localStorage.getItem(`tt_subs_${App.profileId}`), []);
        App.subsCacheId = App.profileId;
        return App.subsCache;
    },
    toggleSub: (id, name, thumb) => {
        if (!id) return;
        let subs = DB.getSubs().slice();
        const exists = subs.find(s => s.id === id);
        if (exists) {
            subs = subs.filter(s => s.id !== id);
            Utils.toast(`Unsubscribed: ${name}`);
        } else {
            subs.push({ id, name, thumb });
            Utils.toast(`Subscribed: ${name}`);
        }
        localStorage.setItem(`tt_subs_${App.profileId}`, JSON.stringify(subs));
        App.subsCache = subs;
        if (App.view === "PLAYER") HUD.updateSubBadge(!exists);
        if (App.menuIdx === 1) Feed.renderSubs();
    },
    isSubbed: (id) => !!DB.getSubs().find(s => s.id === id),
    // Watch history for resume playback
    savePosition: (videoId, position, duration) => {
        if (!videoId || !position || position < 10) return; // Don't save if < 10s
        if (duration && position > duration - 10) {
            // Near end, remove from history (completed)
            delete App.watchHistory[videoId];
        } else {
            App.watchHistory[videoId] = { pos: Math.floor(position), ts: Date.now() };
            // Limit history size
            const keys = Object.keys(App.watchHistory);
            if (keys.length > WATCH_HISTORY_LIMIT) {
                // Remove oldest entries
                keys.sort((a, b) => App.watchHistory[a].ts - App.watchHistory[b].ts);
                for (let i = 0; i < keys.length - WATCH_HISTORY_LIMIT; i++) {
                    delete App.watchHistory[keys[i]];
                }
            }
        }
        localStorage.setItem(`tt_history_${App.profileId}`, JSON.stringify(App.watchHistory));
    },
    getPosition: (videoId) => {
        if (!videoId || !App.watchHistory[videoId]) return 0;
        return App.watchHistory[videoId].pos || 0;
    },
    clearPosition: (videoId) => {
        if (videoId && App.watchHistory[videoId]) {
            delete App.watchHistory[videoId];
            localStorage.setItem(`tt_history_${App.profileId}`, JSON.stringify(App.watchHistory));
        }
    }
};

// --- 3. NETWORK ---
const Network = {
    connect: async () => {
        const custom = localStorage.getItem("customBase");
        if (custom && Utils.isValidUrl(custom)) {
            App.api = custom;
            Feed.loadHome();
            return;
        } else if (custom) {
            localStorage.removeItem("customBase");
        }

        const cached = localStorage.getItem("lastWorkingApi");
        if (cached && await Network.ping(cached)) {
            App.api = cached;
            el("backend-status").textContent = `Restored: ${cached.split('/')[2]}`;
            Feed.loadHome();
            Network.updateInstanceList();
            return;
        }

        el("backend-status").textContent = "Scanning Mesh...";
        const instances = Utils.safeParse(localStorage.getItem("cached_instances"), FALLBACK_INSTANCES);

        const pings = instances.map(url =>
            Network.ping(url).then(ok => ok ? url : Promise.reject())
        );

        try {
            const winner = await Utils.any(pings);
            App.api = winner;
            el("backend-status").textContent = `Connected: ${winner.split('/')[2]}`;
            localStorage.setItem("lastWorkingApi", winner);
            Feed.loadHome();
            Network.updateInstanceList();
        } catch (e) {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Network Error</h3><p>No nodes available.</p></div>';
        }
    },
    ping: async (url) => {
        try {
            const res = await Utils.fetchWithTimeout(`${url}/trending`, {}, 2500);
            return res && res.ok;
        } catch (e) { return false; }
    },
    updateInstanceList: async () => {
        try {
            const res = await Utils.fetchWithTimeout(DYNAMIC_LIST_URL, {}, 5000);
            const data = await res.json();
            const fresh = data.filter(i => i[1].api && i[1].type === "https").map(i => i[1].uri + "/api/v1").slice(0, 8);
            if (fresh.length) localStorage.setItem("cached_instances", JSON.stringify(fresh));
        } catch (e) {}
    }
};

// --- 4. FEED ---
const Feed = {
    loadHome: async () => {
        const subs = DB.getSubs();
        if (subs.length === 0) {
            el("section-title").textContent = "Global Trending";
            return Feed.fetch("/trending");
        }

        el("section-title").textContent = `My Feed (${subs.length})`;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Building Feed...</p></div>';

        try {
            const results = await Utils.processQueue(subs, CONCURRENCY_LIMIT, async (sub) => {
                try {
                    const res = await Utils.fetchDedup(`${App.api}/channels/${sub.id}/videos?page=1`);
                    if (!res.ok) return [];
                    const data = await res.json();
                    return data.slice(0, 2);
                } catch (e) { return []; }
            });

            const feed = [].concat(...results).sort((a, b) => b.published - a.published);

            if (feed.length < 10) {
                try {
                    const tr = await (await Utils.fetchDedup(`${App.api}/trending`)).json();
                    if (Array.isArray(tr)) feed.push(...tr.slice(0, 10));
                } catch (e) {}
            }
            UI.renderGrid(feed);
        } catch (e) {
            Feed.fetch("/trending");
        }
    },
    fetch: async (endpoint) => {
        if (!App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div></div>';
        try {
            const res = await Utils.fetchDedup(`${App.api}${endpoint}`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
        } catch (e) {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Error</h3><p>Connection failed.</p></div>';
        }
    },
    renderSubs: () => {
        el("section-title").textContent = "Subscriptions";
        const subs = DB.getSubs();
        UI.renderGrid(subs.map(s => ({
            type: "channel", author: s.name, authorId: s.id, authorThumbnails: [{url: s.thumb}]
        })));
    }
};

// --- 5. UI ---
const UI = {
    initLazyObserver: () => {
        if (!("IntersectionObserver" in window)) return;
        App.lazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute("data-src");
                        App.lazyObserver.unobserve(img);
                    }
                }
            });
        }, { rootMargin: "200px" });
    },
    handleImgError: (img) => {
        img.onerror = null;
        img.src = "icon.png";
    },
    renderGrid: (data) => {
        const items = (data || []).filter(item => item && ["video", "channel", "shortVideo"].includes(item.type));
        App.items = items;
        const grid = el("grid-container");
        if (App.lazyObserver) App.lazyObserver.disconnect();
        grid.textContent = "";

        for (const key in App.pendingDeArrow) {
            clearTimeout(App.pendingDeArrow[key]);
            delete App.pendingDeArrow[key];
        }

        if (App.items.length === 0) {
            grid.innerHTML = '<div class="empty-state"><h3>No Results</h3></div>';
            return;
        }

        const frag = document.createDocumentFragment();
        const useLazy = App.lazyObserver !== null;
        let idx = 0;

        for (const item of App.items) {
            const div = Utils.create("div", item.type === "channel" ? "channel-card" : "video-card");
            div.id = `card-${idx}`;

            let thumbUrl = "icon.png";
            if (item.videoThumbnails && item.videoThumbnails[0]) thumbUrl = item.videoThumbnails[0].url;
            else if (item.thumbnail) thumbUrl = item.thumbnail;
            else if (item.authorThumbnails && item.authorThumbnails[0]) thumbUrl = item.authorThumbnails[0].url;

            if (item.type === "channel") {
                const img = Utils.create("img", "c-avatar");
                img.onerror = function() { UI.handleImgError(this); };
                if (useLazy && idx > 7) {
                    img.dataset.src = thumbUrl;
                    img.src = "icon.png";
                    App.lazyObserver.observe(img);
                } else {
                    img.src = thumbUrl;
                }
                div.appendChild(img);
                div.appendChild(Utils.create("h3", null, item.author));
                if (DB.isSubbed(item.authorId)) div.appendChild(Utils.create("div", "sub-tag", "SUBSCRIBED"));
            } else {
                const tc = Utils.create("div", "thumb-container");
                const img = Utils.create("img", "thumb");
                img.onerror = function() { UI.handleImgError(this); };
                if (useLazy && idx > 7) {
                    img.dataset.src = thumbUrl;
                    img.src = "icon.png";
                    App.lazyObserver.observe(img);
                } else {
                    img.src = thumbUrl;
                }
                tc.appendChild(img);

                if (item.lengthSeconds) tc.appendChild(Utils.create("span", "duration-badge", Utils.formatTime(item.lengthSeconds)));
                if (item.liveNow) tc.appendChild(Utils.create("span", "live-badge", "LIVE"));

                // Show resume indicator if we have saved position
                const vId = Utils.getVideoId(item);
                const savedPos = vId ? DB.getPosition(vId) : 0;
                if (savedPos > 0) {
                    const resumeBadge = Utils.create("span", "resume-badge", Utils.formatTime(savedPos));
                    tc.appendChild(resumeBadge);
                }

                div.appendChild(tc);

                const meta = Utils.create("div", "meta");
                const h3 = Utils.create("h3", null, item.title);
                h3.id = `title-${idx}`;
                meta.appendChild(h3);

                let info = item.author || "";
                if (item.viewCount) info += (info ? " • " : "") + Utils.formatViews(item.viewCount);
                if (item.published) info += (info ? " • " : "") + Utils.formatDate(item.published);

                meta.appendChild(Utils.create("p", null, info));
                div.appendChild(meta);
            }
            frag.appendChild(div);
            idx++;
        }
        grid.appendChild(frag);

        if (App.focus.area !== "search" && App.focus.area !== "settings") {
            App.focus = { area: "grid", index: 0 };
            UI.updateFocus();
        }
    },
    updateFocus: () => {
        document.querySelectorAll(".focused").forEach(e => e.classList.remove("focused"));

        if (App.focus.area === "menu") {
            el(["menu-home", "menu-subs", "menu-search", "menu-settings"][App.menuIdx]).classList.add("focused");
        } else if (App.focus.area === "grid") {
            const card = el(`card-${App.focus.index}`);
            if (card) {
                card.classList.add("focused");
                try {
                    if (App.supportsSmoothScroll) {
                        card.scrollIntoView({ block: "center", behavior: "smooth" });
                    } else {
                        card.scrollIntoView(false);
                    }
                } catch (e) {
                    App.supportsSmoothScroll = false;
                    card.scrollIntoView(false);
                }
                const item = App.items[App.focus.index];
                if (item && item.type !== "channel" && !item.deArrowChecked) {
                    UI.fetchDeArrow(item, App.focus.index);
                }
            }
        } else if (App.focus.area === "search") el("search-input").classList.add("focused");
        else if (App.focus.area === "settings") el("save-btn").classList.add("focused-btn");

        if (App.view === "PLAYER") {
            PlayerControls.updateFocus();
        }
    },
    fetchDeArrow: (item, idx) => {
        item.deArrowChecked = true;
        const vId = Utils.getVideoId(item);
        if (!vId) return;

        if (App.deArrowCache.has(vId)) {
            UI.applyDeArrow(App.deArrowCache.get(vId), idx, vId);
            return;
        }

        if (App.pendingDeArrow[vId]) clearTimeout(App.pendingDeArrow[vId]);

        App.pendingDeArrow[vId] = setTimeout(() => {
            Utils.fetchDedup(`${DEARROW_API}?videoID=${vId}`, {}, 5000)
                .then(r => r.json())
                .then(d => {
                    App.deArrowCache.set(vId, d);
                    UI.applyDeArrow(d, idx, vId);
                    delete App.pendingDeArrow[vId];
                }).catch(() => delete App.pendingDeArrow[vId]);
        }, 300);
    },
    applyDeArrow: (d, idx, originalId) => {
        if (!App.items[idx]) return;
        const currentId = Utils.getVideoId(App.items[idx]);
        if (currentId !== originalId) return;

        if (d.titles && d.titles[0]) {
            const t = el(`title-${idx}`);
            if (t) t.textContent = d.titles[0].title;
            App.items[idx].title = d.titles[0].title;
        }
    }
};

// --- 6. PLAYER ---
const Player = {
    // Cache DOM elements for 60fps render loop
    cacheElements: () => {
        App.playerElements = {
            player: el("native-player"),
            progressFill: el("progress-fill"),
            bufferFill: el("buffer-fill"),
            currTime: el("curr-time"),
            totalTime: el("total-time"),
            bufferingSpinner: el("buffering-spinner"),
            speedBadge: el("speed-badge")
        };
    },

    captionLangKey: () => `tt_caption_lang_${App.profileId}`,

    clearCaptions: () => {
        const p = App.playerElements ? App.playerElements.player : el("native-player");
        if (!p) return;
        p.querySelectorAll("track").forEach(track => track.remove());
        App.captionTracks = [];
    },

    setCaptionMode: (lang, mode) => {
        App.captionTracks.forEach(track => {
            if (!track || !track.track) return;
            if (lang && track.srclang === lang) {
                track.track.mode = mode;
            } else {
                track.track.mode = "hidden";
            }
        });
    },

    openCaptionsMenu: () => {
        const overlay = el("captions-overlay");
        const list = el("captions-list");
        if (!overlay || !list) return;

        if (!App.captionTracks.length) {
            Utils.toast("No captions available");
            return;
        }

        const isVisible = !overlay.classList.contains("hidden");
        if (isVisible) {
            overlay.classList.add("hidden");
            return;
        }

        if (Comments.isOpen()) Comments.close();
        el("video-info-overlay").classList.add("hidden");

        list.textContent = "";
        const currentLang = localStorage.getItem(Player.captionLangKey()) || "";
        App.captionTracks.forEach(track => {
            if (!track) return;
            const label = track.label || track.srclang || "Captions";
            const text = track.srclang ? `${label} (${track.srclang})` : label;
            const option = Utils.create("button", "captions-option", text);
            option.type = "button";
            if (!track.srclang) {
                option.disabled = true;
            } else {
                if (track.srclang === currentLang) option.classList.add("active");
                option.addEventListener("click", () => {
                    localStorage.setItem(Player.captionLangKey(), track.srclang);
                    Player.setCaptionMode(track.srclang, "showing");
                    overlay.classList.add("hidden");
                });
            }
            list.appendChild(option);
        });

        overlay.classList.remove("hidden");
        HUD.refreshPinned();
    },

    setupCaptions: (data) => {
        Player.clearCaptions();
        if (!data || !Array.isArray(data.captions)) return;

        const storedLang = localStorage.getItem(Player.captionLangKey()) || "";
        const captions = data.captions.map(caption => {
            if (!caption) return null;
            const src = caption.url || caption.vttUrl || caption.baseUrl || caption.caption_url;
            if (!src) return null;
            const srclang = caption.language_code || caption.languageCode || caption.srclang || caption.code || "";
            const label = caption.label || caption.name || srclang || "Subtitles";
            return { src, srclang, label };
        }).filter(Boolean);

        if (!captions.length) return;

        const p = App.playerElements.player;
        captions.forEach(caption => {
            const track = document.createElement("track");
            track.kind = "subtitles";
            track.label = caption.label;
            if (caption.srclang) track.srclang = caption.srclang;
            track.src = caption.src;
            p.appendChild(track);
            App.captionTracks.push(track);
        });

        if (storedLang) {
            Player.setCaptionMode(storedLang, "showing");
        }
    },

    toggleCaptions: () => {
        if (!App.captionTracks.length) {
            Utils.toast("No captions available");
            return;
        }

        const showingTrack = App.captionTracks.find(track => track.track && track.track.mode === "showing");
        if (showingTrack) {
            App.captionTracks.forEach(track => {
                if (track.track) track.track.mode = "hidden";
            });
            Utils.toast("Captions off");
            return;
        }

        let lang = localStorage.getItem(Player.captionLangKey()) || "";
        if (!lang) {
            const firstTrack = App.captionTracks.find(track => track.srclang);
            lang = firstTrack ? firstTrack.srclang : "";
        }

        if (lang) {
            localStorage.setItem(Player.captionLangKey(), lang);
            Player.setCaptionMode(lang, "showing");
            Utils.toast(`Captions: ${lang}`);
        } else {
            Utils.toast("No captions available");
        }
    },
    cycleCaptionLanguage: () => {
        if (!App.captionTracks.length) {
            Utils.toast("No captions available");
            return;
        }

        const tracks = App.captionTracks.filter(track => track && track.srclang);
        if (!tracks.length) {
            Utils.toast("No captions available");
            return;
        }

        const currentLang = localStorage.getItem(Player.captionLangKey()) || "";
        const activeTrack = tracks.find(track => track.track && track.track.mode === "showing");
        const activeLang = activeTrack ? activeTrack.srclang : currentLang || tracks[0].srclang;
        const currentIndex = tracks.findIndex(track => track.srclang === activeLang);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tracks.length;
        const nextLang = tracks[nextIndex].srclang;

        localStorage.setItem(Player.captionLangKey(), nextLang);
        Player.setCaptionMode(nextLang, "showing");
        Utils.toast(`Captions: ${nextLang}`);
    },

    start: async (item, retryCount = 0) => {
        if (!item) return;
        App.view = "PLAYER";
        App.playerMode = "BYPASS";
        App.playbackSpeedIdx = 0;
        App.playerControls.active = false;
        App.playerControls.index = 0;
        App.activeLayer = "NONE";
        App.currentVideoData = null;
        el("player-layer").classList.remove("hidden");
        el("player-hud").classList.add("visible");
        ScreenSaver.disable();

        // Cache DOM elements if not already
        if (!App.playerElements) Player.cacheElements();

        const vId = Utils.getVideoId(item);
        if (!vId) {
            Utils.toast("Missing video ID");
            return;
        }
        App.currentVideoId = vId;
        el("player-title").textContent = item.title;
        HUD.updateSubBadge(DB.isSubbed(item.authorId));
        HUD.updateSpeedBadge(1);
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        Comments.reset();
        Player.clearCaptions();

        // Get thumbnail for poster
        let posterUrl = "";
        if (item.videoThumbnails && item.videoThumbnails[0]) {
            posterUrl = item.videoThumbnails[0].url;
        } else if (item.thumbnail) {
            posterUrl = item.thumbnail;
        }

        const p = App.playerElements.player;
        let errorHandled = false;
        if (posterUrl) p.poster = posterUrl;

        // Show buffering spinner
        App.playerElements.bufferingSpinner.classList.remove("hidden");

        // FIRE-AND-FORGET: SponsorBlock fetch (no longer blocks playback!)
        App.sponsorSegs = [];
        const sponsorCategories = encodeURIComponent('["sponsor","selfpromo","intro"]');
        Utils.fetchWithTimeout(`${SPONSOR_API}?videoID=${vId}&categories=${sponsorCategories}`, {}, 5000)
            .then(r => r.ok ? r.json() : [])
            .then(s => {
                if (Array.isArray(s)) {
                    App.sponsorSegs = s.sort((a, b) => a.segment[0] - b.segment[0]);
                }
            })
            .catch(() => { App.sponsorSegs = []; });

        const handlePlaybackError = () => {
            if (errorHandled) return;
            if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;
            errorHandled = true;
            App.streamCache.map.delete(vId);
            App.currentVideoData = null;
            App.playerElements.bufferingSpinner.classList.add("hidden");
            if (retryCount < 1) {
                Player.start(item, retryCount + 1);
            } else {
                Player.enforce(vId);
            }
        };

        p.onerror = handlePlaybackError;
        p.onstalled = handlePlaybackError;

        if (App.api) {
            // Check stream cache first
            let streamUrl = null;
            const cached = App.streamCache.get(vId);
            if (cached && cached.url) {
                streamUrl = cached.url;
                App.currentVideoData = cached.data;
                Player.setupCaptions(App.currentVideoData);
            }

            if (!streamUrl) {
                try {
                    const res = await Utils.fetchWithTimeout(`${App.api}/videos/${vId}`);

                    // CRITICAL: Check if user navigated away during fetch
                    if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;

                    if (!res.ok) throw new Error('Video fetch failed');

                    let data;
                    try {
                        data = await res.json();
                    } catch (jsonErr) {
                        throw new Error('Invalid JSON response');
                    }

                    // Check again after JSON parsing (another async operation)
                    if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;

                    App.currentVideoData = data;
                    Player.setupCaptions(App.currentVideoData);

                    const streams = data.formatStreams || [];
                    const adaptiveStreams = data.adaptiveFormats || [];

                    let stream = streams.find(s => s.qualityLabel === "1080p" || s.quality === "1080p")
                              || streams.find(s => s.qualityLabel === "720p" || s.quality === "720p")
                              || streams.find(s => s.container === "mp4")
                              || streams[0];

                    if (!stream && adaptiveStreams.length) {
                        stream = adaptiveStreams.find(s => s.container === "mp4" && s.encoding === "h264")
                              || adaptiveStreams.find(s => s.container === "mp4");
                    }

                    if (!stream) {
                        const allStreams = [...streams, ...adaptiveStreams];
                        for (const s of allStreams) {
                            const mime = s.mimeType || s.type || "video/mp4";
                            if (p.canPlayType(mime)) { stream = s; break; }
                        }
                    }

                    if (stream && stream.url) {
                        streamUrl = stream.url;
                        // Cache the stream URL
                        App.streamCache.set(vId, { url: streamUrl, data: data });
                    }
                } catch (e) {
                    App.playerElements.bufferingSpinner.classList.add("hidden");
                    Player.enforce(vId);
                    return;
                }
            }

            if (streamUrl) {
                p.src = streamUrl;
                p.style.display = "block";

                // Resume from saved position
                const savedPos = DB.getPosition(vId);
                if (savedPos > 0) {
                    p.currentTime = savedPos;
                    Utils.toast(`Resuming from ${Utils.formatTime(savedPos)}`);
                }

                p.play();
                Player.setupHUD(p);

                // Start Render Loop ONLY after successful setup
                if (App.rafId) cancelAnimationFrame(App.rafId);
                App.rafId = requestAnimationFrame(Player.renderLoop);
                return;
            }
        }

        App.playerElements.bufferingSpinner.classList.add("hidden");
        Player.enforce(vId);
    },

    enforce: (vId) => {
        App.playerMode = "ENFORCE";
        App.playerElements.player.style.display = "none";
        App.playerElements.bufferingSpinner.classList.add("hidden");
        el("enforcement-container").innerHTML = `<iframe src="https://www.youtube.com/embed/${vId}?autoplay=1" allowfullscreen></iframe>`;
    },

    setupHUD: (p) => {
        const show = () => {
            HUD.show();
        };

        p.onplay = () => {
            App.playerElements.bufferingSpinner.classList.add("hidden");
            show();
        };
        p.onpause = show;
        p.onseeked = show;
        p.onwaiting = () => {
            App.playerElements.bufferingSpinner.classList.remove("hidden");
        };
        p.onplaying = () => {
            App.playerElements.bufferingSpinner.classList.add("hidden");
        };
    },

    // 60FPS UI Loop with cached DOM elements
    renderLoop: () => {
        if (App.view !== "PLAYER") {
            if (App.rafId !== null) {
                cancelAnimationFrame(App.rafId);
                App.rafId = null;
            }
            return;
        }

        const pe = App.playerElements;
        const p = pe.player;

        if (!p.paused && !isNaN(p.duration)) {
            const pct = p.currentTime / p.duration;
            pe.progressFill.style.transform = "scaleX(" + pct + ")";
            pe.currTime.textContent = Utils.formatTime(p.currentTime);
            pe.totalTime.textContent = Utils.formatTime(p.duration);

            // Update buffer bar
            if (p.buffered.length > 0) {
                const bufferedEnd = p.buffered.end(p.buffered.length - 1);
                const bufferPct = bufferedEnd / p.duration;
                pe.bufferFill.style.transform = "scaleX(" + bufferPct + ")";
            }

            // Binary Search for Segment (with skip loop protection)
            const seg = Utils.findSegment(p.currentTime);
            if (seg && seg !== App.lastSkippedSeg) {
                App.lastSkippedSeg = seg;
                p.currentTime = seg.segment[1] + 0.1;
                Utils.toast("Skipped sponsor");
            } else if (!seg) {
                App.lastSkippedSeg = null;
            }
        }
        App.rafId = requestAnimationFrame(Player.renderLoop);
    },

    seek: (direction, accelerated = false) => {
        const p = App.playerElements.player;
        if (App.playerMode !== "BYPASS" || isNaN(p.duration)) return;

        let seekAmount = SEEK_INTERVALS[0]; // 10s default

        if (accelerated) {
            const heldTime = performance.now() - App.seekKeyTime;
            if (heldTime > 2000) {
                seekAmount = SEEK_INTERVALS[2]; // 60s
            } else if (heldTime > SEEK_ACCELERATION_DELAY) {
                seekAmount = SEEK_INTERVALS[1]; // 30s
            }
        }

        const newTime = direction === 'left'
            ? p.currentTime - seekAmount
            : p.currentTime + seekAmount;

        // Clamp to valid range
        p.currentTime = Utils.clamp(newTime, 0, p.duration);
    },

    cycleSpeed: () => {
        const p = App.playerElements.player;
        App.playbackSpeedIdx = (App.playbackSpeedIdx + 1) % PLAYBACK_SPEEDS.length;
        const speed = PLAYBACK_SPEEDS[App.playbackSpeedIdx];
        p.playbackRate = speed;
        HUD.updateSpeedBadge(speed);
        Utils.toast(`Speed: ${speed}x`);
    },

    toggleInfo: () => {
        const overlay = el("video-info-overlay");
        const isVisible = !overlay.classList.contains("hidden");

        if (isVisible) {
            overlay.classList.add("hidden");
            App.activeLayer = "CONTROLS";
            PlayerControls.setActive(true);
        } else {
            if (Comments.isOpen()) Comments.close();
            el("captions-overlay").classList.add("hidden");
            // Populate info
            const data = App.currentVideoData;
            if (data) {
                el("info-title").textContent = data.title || "Unknown";
                el("info-author").textContent = data.author || "Unknown";
                el("info-views").textContent = Utils.formatViews(data.viewCount);
                el("info-date").textContent = Utils.formatFullDate(data.published);
                el("info-description").textContent = data.description || "No description available.";
            }
            overlay.classList.remove("hidden");
            App.activeLayer = "INFO";
        }
        HUD.refreshPinned();
    },

    scrollInfo: (direction) => {
        const overlay = el("video-info-overlay");
        if (overlay.classList.contains("hidden")) return;
        const delta = 80 * direction;
        overlay.scrollTop = Utils.clamp(overlay.scrollTop + delta, 0, overlay.scrollHeight);
    },

    stop: () => {
        const p = App.playerElements ? App.playerElements.player : el("native-player");

        // Save position before stopping
        if (App.currentVideoId && p.currentTime > 10) {
            DB.savePosition(App.currentVideoId, p.currentTime, p.duration);
        }

        p.pause();
        p.src = "";
        p.poster = "";
        p.playbackRate = 1;
        el("enforcement-container").innerHTML = "";
        el("progress-fill").style.transform = "scaleX(0)";
        el("buffer-fill").style.transform = "scaleX(0)";
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        Comments.reset();
        Comments.close();
        if (App.playerElements) {
            App.playerElements.bufferingSpinner.classList.add("hidden");
        }
        if (App.rafId) cancelAnimationFrame(App.rafId);
        App.rafId = null;
        App.lastSkippedSeg = null;
        App.sponsorSegs = [];
        App.currentVideoId = null;
        App.currentVideoData = null;
        App.seekKeyHeld = null;
        App.playerControls.active = false;
        App.playerControls.index = 0;
        App.activeLayer = "NONE";
        Player.clearCaptions();
        ScreenSaver.restore();
    }
};

// --- 6. COMMENTS ---
const Comments = {
    state: {
        open: false,
        loading: false,
        nextPage: null,
        page: 1,
        count: 0,
        videoId: null
    },
    elements: null,
    cacheElements: () => {
        Comments.elements = {
            overlay: el("comments-overlay"),
            list: el("comments-list"),
            footer: el("comments-footer"),
            count: el("comments-count"),
            page: el("comments-page")
        };
    },
    init: () => {
        if (!Comments.elements) Comments.cacheElements();
        Comments.reset();
    },
    isOpen: () => Comments.state.open,
    reset: () => {
        if (!Comments.elements) Comments.cacheElements();
        Comments.state.open = false;
        Comments.state.loading = false;
        Comments.state.nextPage = null;
        Comments.state.page = 1;
        Comments.state.count = 0;
        Comments.state.videoId = null;
        Comments.elements.list.textContent = "";
        Comments.elements.footer.classList.add("hidden");
        Comments.elements.count.textContent = "0 comments";
        Comments.elements.page.textContent = "Page 1";
    },
    open: async () => {
        if (!App.currentVideoId || !App.api) return;
        if (!Comments.elements) Comments.cacheElements();
        Comments.state.open = true;
        Comments.elements.overlay.classList.remove("hidden");
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        App.activeLayer = "COMMENTS";
        HUD.refreshPinned();

        if (Comments.state.videoId !== App.currentVideoId) {
            Comments.reset();
            Comments.state.open = true;
            Comments.elements.overlay.classList.remove("hidden");
            Comments.elements.list.textContent = "Loading comments...";
            App.activeLayer = "COMMENTS";
            await Comments.loadPage();
        }
    },
    close: () => {
        if (!Comments.elements) Comments.cacheElements();
        Comments.state.open = false;
        Comments.elements.overlay.classList.add("hidden");
        App.activeLayer = "CONTROLS";
        PlayerControls.setActive(true);
        HUD.refreshPinned();
    },
    toggle: () => {
        if (Comments.isOpen()) {
            Comments.close();
        } else {
            Comments.open();
        }
    },
    sanitizeText: (text) => {
        if (!text) return "";
        return text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    },
    loadPage: async () => {
        if (Comments.state.loading || !App.currentVideoId || !App.api) return;
        Comments.state.loading = true;
        Comments.elements.footer.classList.remove("hidden");

        const vId = App.currentVideoId;
        const params = [];
        if (Comments.state.nextPage) {
            params.push(`continuation=${encodeURIComponent(Comments.state.nextPage)}`);
        }
        const url = `${App.api}/comments/${vId}${params.length ? "?" + params.join("&") : ""}`;

        try {
            const res = await Utils.fetchWithTimeout(url, {}, 8000);
            if (!res.ok) throw new Error("Comments fetch failed");
            const data = await res.json();
            if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;

            const comments = data.comments || [];
            if (Comments.state.page === 1 && comments.length === 0) {
                Comments.elements.list.textContent = "No comments yet.";
            } else {
                Comments.render(comments);
            }

            if (data.commentCount) {
                Comments.state.count = data.commentCount;
                Comments.elements.count.textContent = `${data.commentCount} comments`;
            } else if (!Comments.state.count) {
                Comments.state.count = Comments.elements.list.children.length;
                Comments.elements.count.textContent = `${Comments.state.count} comments`;
            }

            Comments.state.nextPage = data.continuation || data.nextpage || null;
            Comments.state.videoId = vId;
            Comments.elements.page.textContent = `Page ${Comments.state.page}`;
            Comments.state.page += 1;
        } catch (e) {
            if (Comments.state.page === 1) {
                Comments.elements.list.textContent = "Unable to load comments.";
            }
        } finally {
            Comments.state.loading = false;
            if (!Comments.state.nextPage) {
                Comments.elements.footer.classList.add("hidden");
            } else {
                Comments.elements.footer.textContent = "Loading more...";
                Comments.elements.footer.classList.remove("hidden");
            }
        }
    },
    render: (items) => {
        if (!items || items.length === 0) return;
        if (Comments.elements.list.textContent === "Loading comments...") {
            Comments.elements.list.textContent = "";
        }
        items.forEach((item) => {
            const row = Utils.create("div", "comment-item");
            const author = Utils.create("div", "comment-author", item.author || "Unknown");
            const metaText = [];
            if (item.published) metaText.push(Utils.formatDate(item.published));
            if (item.likeCount) metaText.push(`${item.likeCount} likes`);
            const meta = Utils.create("div", "comment-meta", metaText.join(" • "));
            const content = Utils.create("div", "comment-text", Comments.sanitizeText(item.content || item.contentHtml || ""));
            row.appendChild(author);
            if (meta.textContent) row.appendChild(meta);
            row.appendChild(content);
            Comments.elements.list.appendChild(row);
        });
    },
    scroll: (direction) => {
        if (!Comments.isOpen()) return;
        const list = Comments.elements.list;
        const delta = 140 * direction;
        list.scrollTop = Utils.clamp(list.scrollTop + delta, 0, list.scrollHeight);
        const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
        if (direction > 0 && nearBottom && Comments.state.nextPage && !Comments.state.loading) {
            Comments.loadPage();
        }
    }
};

// --- 6b. CAPTIONS CONTROLLER (v6.1.0) ---
const Captions = {
    index: 0,
    buttons: [],
    isOpen: () => !el("captions-overlay").classList.contains("hidden"),
    open: () => {
        App.activeLayer = "CAPTIONS";
        Player.openCaptionsMenu();
        // Re-query buttons after they are created
        Captions.buttons = Array.from(document.querySelectorAll(".captions-option"));
        Captions.index = Captions.buttons.findIndex(b => b.classList.contains("active"));
        if (Captions.index === -1) Captions.index = 0;
        Captions.updateFocus();
        HUD.refreshPinned();
    },
    close: () => {
        el("captions-overlay").classList.add("hidden");
        App.activeLayer = "CONTROLS";
        PlayerControls.setActive(true);
        HUD.refreshPinned();
    },
    move: (delta) => {
        if (!Captions.buttons.length) return;
        Captions.index = (Captions.index + delta + Captions.buttons.length) % Captions.buttons.length;
        Captions.updateFocus();
    },
    updateFocus: () => {
        Captions.buttons.forEach((b, i) => {
            if (i === Captions.index) {
                b.classList.add("focused");
                b.scrollIntoView({ block: "center", behavior: "smooth" });
            } else {
                b.classList.remove("focused");
            }
        });
    },
    select: () => {
        if (Captions.buttons[Captions.index]) {
            Captions.buttons[Captions.index].click();
        }
        Captions.close();
    }
};

const PlayerControls = {
    ids: [
        "control-play",
        "control-back",
        "control-forward",
        "control-captions",
        "control-language",
        "control-comments",
        "control-subscribe"
    ],
    buttons: [],
    actions: {
        "control-play": () => {
            const p = App.playerElements ? App.playerElements.player : el("native-player");
            if (App.playerMode === "BYPASS") p.paused ? p.play() : p.pause();
        },
        "control-back": () => Player.seek("left"),
        "control-forward": () => Player.seek("right"),
        "control-captions": () => Player.toggleCaptions(),
        "control-language": () => Captions.open(), // Use Captions controller with proper layer management
        "control-comments": () => {
            App.activeLayer = "COMMENTS";
            Comments.open();
        },
        "control-subscribe": () => {
            const item = App.items[App.focus.index];
            if (item && item.authorId) DB.toggleSub(item.authorId, item.author, Utils.getAuthorThumb(item));
        }
    },
    init: () => {
        PlayerControls.buttons = PlayerControls.ids.map((id, idx) => {
            const btn = el(id);
            if (!btn) return null;
            btn.addEventListener("click", () => {
                App.playerControls.index = idx;
                PlayerControls.setActive(true);
                PlayerControls.runAction(id);
            });
            btn.addEventListener("keydown", (e) => {
                if (e.keyCode === 13) {
                    App.playerControls.index = idx;
                    PlayerControls.setActive(true);
                    PlayerControls.runAction(id);
                }
            });
            return btn;
        }).filter(Boolean);
    },
    setActive: (active) => {
        App.playerControls.active = active;
        if (active) {
            if (App.playerControls.index >= PlayerControls.buttons.length) {
                App.playerControls.index = 0;
            }
            App.activeLayer = "CONTROLS";
        } else {
            App.activeLayer = "NONE";
        }
        HUD.refreshPinned();
        UI.updateFocus();
    },
    move: (delta) => {
        if (!App.playerControls.active || PlayerControls.buttons.length === 0) return;
        const len = PlayerControls.buttons.length;
        App.playerControls.index = (App.playerControls.index + delta + len) % len;
        UI.updateFocus();
    },
    runAction: (id) => {
        const action = PlayerControls.actions[id];
        if (action) action();
        HUD.refreshPinned();
    },
    activateFocused: () => {
        const btn = PlayerControls.buttons[App.playerControls.index];
        if (btn) PlayerControls.runAction(btn.id);
    },
    updateFocus: () => {
        PlayerControls.buttons.forEach(btn => btn.classList.remove("focused"));
        if (!App.playerControls.active) return;
        const btn = PlayerControls.buttons[App.playerControls.index];
        if (btn) {
            btn.classList.add("focused");
            if (typeof btn.focus === "function") btn.focus({ preventScroll: true });
        }
    }
};

// --- 7. INPUT ---
function setupRemote() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && App.view === "PLAYER") {
            const p = App.playerElements ? App.playerElements.player : el("native-player");
            p.pause();
        }
    });

    // Handle key release for seek acceleration
    document.addEventListener('keyup', (e) => {
        if (e.keyCode === 37 || e.keyCode === 39 || e.keyCode === 412 || e.keyCode === 417) {
            App.seekKeyHeld = null;
            App.seekKeyTime = 0;
        }
        if (e.keyCode === 457 && App.view === "PLAYER") {
            if (App.infoKeyTimer) {
                clearTimeout(App.infoKeyTimer);
                App.infoKeyTimer = null;
                if (!App.infoKeyHandled) Player.toggleInfo();
                App.infoKeyHandled = false;
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.keyCode !== 10009) App.exitCounter = 0;

        if (App.view === "PLAYER") {
            const p = App.playerElements ? App.playerElements.player : el("native-player");
            const item = App.items[App.focus.index];

            // ============================================
            // v6.1.0: CENTRALIZED INPUT ROUTER
            // Route keys based on activeLayer to fix Ghost Menu bug
            // ============================================

            // 1. Handle COMMENTS layer (highest priority overlay)
            if (App.activeLayer === "COMMENTS") {
                switch (e.keyCode) {
                    case 38: // UP - scroll comments
                        Comments.scroll(-1);
                        return;
                    case 40: // DOWN - scroll comments
                        Comments.scroll(1);
                        return;
                    case 10009: // BACK - close comments
                        Comments.close();
                        return;
                    case 405: // YELLOW - toggle comments
                        Comments.toggle();
                        return;
                }
            }

            // 2. Handle CAPTIONS layer (v6.1.0 fix for Ghost Menu bug)
            if (App.activeLayer === "CAPTIONS") {
                switch (e.keyCode) {
                    case 38: // UP - navigate captions menu
                        Captions.move(-1);
                        return;
                    case 40: // DOWN - navigate captions menu
                        Captions.move(1);
                        return;
                    case 13: // ENTER - select caption language
                        Captions.select();
                        return;
                    case 10009: // BACK - close captions menu
                        Captions.close();
                        return;
                }
            }

            // 3. Handle INFO layer (v6.1.0 fix for Info Overlay Trap)
            if (App.activeLayer === "INFO") {
                switch (e.keyCode) {
                    case 38: // UP - scroll info up
                        Player.scrollInfo(-1);
                        return;
                    case 40: // DOWN - scroll info down
                        Player.scrollInfo(1);
                        return;
                    case 10009: // BACK - close info overlay
                    case 457: // INFO - toggle info overlay
                        Player.toggleInfo();
                        return;
                }
            }

            // 4. Handle CONTROLS layer (player control bar)
            if (App.activeLayer === "CONTROLS") {
                switch (e.keyCode) {
                    case 37: // LEFT - move to previous control
                        PlayerControls.move(-1);
                        return;
                    case 39: // RIGHT - move to next control
                        PlayerControls.move(1);
                        return;
                    case 38: // UP - exit controls layer
                        PlayerControls.setActive(false);
                        return;
                    case 10009: // BACK - exit controls (not player)
                        PlayerControls.setActive(false);
                        return;
                    case 13: // ENTER - activate focused control
                    case 415: // PLAY/OK - activate focused control
                        PlayerControls.activateFocused();
                        return;
                }
            }

            // 5. Handle NONE layer (standard player controls)
            // DOWN activates control bar
            if (e.keyCode === 40) {
                PlayerControls.setActive(true);
                return;
            }

            switch (e.keyCode) {
                case 10009: // BACK - Exit Player
                    App.view = "BROWSE";
                    el("player-layer").classList.add("hidden");
                    Comments.reset();
                    Player.stop();
                    break;
                // Tizen media keycodes: MediaPlayPause=10252, MediaPlay=415, MediaPause=19
                case 10252: // MediaPlayPause
                case 415: // PLAY
                case 19: // PAUSE
                case 13: // OK/ENTER
                    if (App.playerMode === "BYPASS") p.paused ? p.play() : p.pause();
                    break;
                case 37: // LEFT - seek back with acceleration
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'left') {
                            App.seekKeyHeld = 'left';
                            App.seekKeyTime = performance.now();
                        }
                        Player.seek('left', App.seekKeyHeld === 'left');
                    }
                    break;
                case 39: // RIGHT - seek forward with acceleration
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'right') {
                            App.seekKeyHeld = 'right';
                            App.seekKeyTime = performance.now();
                        }
                        Player.seek('right', App.seekKeyHeld === 'right');
                    }
                    break;
                // Tizen media keycodes: MediaRewind=412, MediaFastForward=417
                case 412: // REWIND
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'left') {
                            App.seekKeyHeld = 'left';
                            App.seekKeyTime = performance.now();
                        }
                        Player.seek('left', App.seekKeyHeld === 'left');
                    }
                    break;
                case 417: // FAST FORWARD
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'right') {
                            App.seekKeyHeld = 'right';
                            App.seekKeyTime = performance.now();
                        }
                        Player.seek('right', App.seekKeyHeld === 'right');
                    }
                    break;
                case 403: // RED - Toggle player mode
                    const vId = App.currentVideoId;
                    if (App.playerMode === "BYPASS") {
                        if (!vId) break;
                        Player.enforce(vId);
                    } else {
                        el("enforcement-container").innerHTML = "";
                        p.style.display = "block";
                        p.play();
                        App.playerMode = "BYPASS";
                    }
                    break;
                case 404: // GREEN - Playback speed
                    if (App.playerMode === "BYPASS") Player.cycleSpeed();
                    break;
                case 405: // YELLOW - Comments
                    Comments.toggle();
                    break;
                case 406: // BLUE - Subscribe
                    if (item && item.authorId) DB.toggleSub(item.authorId, item.author, Utils.getAuthorThumb(item));
                    break;
                case 457: // INFO button (some remotes)
                    if (!App.infoKeyTimer) {
                        App.infoKeyHandled = false;
                        App.infoKeyTimer = setTimeout(() => {
                            App.infoKeyHandled = true;
                            App.infoKeyTimer = null;
                            Player.toggleCaptions();
                        }, 600);
                    }
                    break;
            }
            return;
        }

        if (App.view === "SETTINGS") {
            switch (e.keyCode) {
                case 10009: // BACK
                    el("settings-overlay").classList.add("hidden");
                    App.view = "BROWSE";
                    break;
                case 13: // ENTER
                    App.actions.saveSettings();
                    break;
                case 38: // UP
                case 40: // DOWN
                    const inputs = ["profile-name-input", "api-input", "save-btn"];
                    const active = document.activeElement;
                    let idx = inputs.indexOf(active ? active.id : "");
                    if (idx === -1) idx = 0;
                    else idx = e.keyCode === 40 ? Math.min(idx + 1, inputs.length - 1) : Math.max(idx - 1, 0);
                    el(inputs[idx]).focus();
                    break;
            }
            return;
        }

        if (App.focus.area === "search") {
            if (e.keyCode === 13) App.actions.runSearch();
            if (e.keyCode === 40) {
                el("search-input").blur(); // Force close virtual keyboard (IME)
                App.focus.area = "grid";
                UI.updateFocus();
            }
            if (e.keyCode === 10009) {
                el("search-input").classList.add("hidden");
                App.focus.area = "menu";
                UI.updateFocus();
            }
            return;
        }

        switch (e.keyCode) {
            case 38: // UP
                if (App.focus.area === "grid" && App.focus.index >= 4) App.focus.index -= 4;
                else if (App.focus.area === "menu") { App.menuIdx--; if (App.menuIdx < 0) App.menuIdx = 0; }
                break;
            case 40: // DOWN
                if (App.focus.area === "grid") {
                    const itemCount = App.items.length;
                    const cols = 4;
                    const currentRow = Math.floor(App.focus.index / cols);
                    const currentCol = App.focus.index % cols;
                    const totalRows = Math.ceil(itemCount / cols);

                    if (currentRow < totalRows - 1) {
                        // Not on the last row
                        const nextIdx = App.focus.index + cols;
                        if (nextIdx < itemCount) {
                            App.focus.index = nextIdx;
                        } else {
                            // Target position doesn't exist, go to last item in next row
                            App.focus.index = itemCount - 1;
                        }
                    }
                    // If on last row, do nothing (stay in place)
                } else if (App.focus.area === "menu") {
                    App.menuIdx++;
                    if (App.menuIdx > 3) App.menuIdx = 3;
                }
                break;
            case 37: // LEFT
                if (App.focus.area === "grid") {
                    if (App.focus.index % 4 === 0) {
                        App.focus.area = "menu";
                        el("sidebar").classList.add("expanded");
                    } else {
                        App.focus.index--;
                    }
                }
                break;
            case 39: // RIGHT
                if (App.focus.area === "menu") {
                    App.focus.area = "grid";
                    el("sidebar").classList.remove("expanded");
                    App.focus.index = 0;
                } else if (App.focus.area === "grid" && App.focus.index < App.items.length - 1) {
                    App.focus.index++;
                }
                break;
            case 13: // ENTER
                if (App.focus.area === "menu") App.actions.menuSelect();
                if (App.focus.area === "grid") {
                    const item = App.items[App.focus.index];
                    if (item.type === "channel") DB.toggleSub(item.authorId, item.author, Utils.getAuthorThumb(item));
                    else Player.start(item);
                }
                break;
            case 406: // BLUE
                if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if (i.authorId) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i));
                }
                break;
            case 10009: // BACK
                App.exitCounter++;
                if (App.exitCounter >= 2) {
                    ScreenSaver.restore();
                    if (typeof tizen !== 'undefined') tizen.application.getCurrentApplication().exit();
                } else Utils.toast("Back Again to Exit");
                break;
        }
        UI.updateFocus();
    });
}

App.actions = {
    menuSelect: () => {
        if (App.menuIdx === 0) Feed.loadHome();
        if (App.menuIdx === 1) Feed.renderSubs();
        if (App.menuIdx === 2) {
            App.focus.area = "search";
            const inp = el("search-input");
            inp.classList.remove("hidden");
            inp.focus();
        }
        if (App.menuIdx === 3) { App.view = "SETTINGS"; el("settings-overlay").classList.remove("hidden"); }
    },
    runSearch: () => {
        const inp = el("search-input");
        const q = inp.value;
        inp.blur();
        inp.classList.add("hidden");
        Feed.fetch(`/search?q=${encodeURIComponent(q)}`);
    },
    switchProfile: () => {
        localStorage.setItem("tt_pid", (App.profileId + 1) % 3);
        location.reload();
    },
    saveSettings: async () => {
        const name = el("profile-name-input").value.trim();
        const api = el("api-input").value.trim();
        if (name) DB.saveProfileName(name.substring(0, 20));
        if (!api) {
            localStorage.removeItem("customBase");
            location.reload();
            return;
        }

        let base = api.replace(/\/+$/, "");
        if (!base.endsWith("/api/v1")) base = `${base}/api/v1`;

        if (!Utils.isValidUrl(base)) {
            Utils.toast("Invalid API URL");
            return;
        }

        try {
            const res = await Utils.fetchWithTimeout(`${base}/trending`, {}, 2500);
            if (!res || !res.ok) throw new Error("API check failed");
            localStorage.setItem("customBase", base);
            location.reload();
        } catch (e) {
            Utils.toast("API check failed");
        }
    }
};

const HUD = {
    pinned: false,
    updateSubBadge: (isSubbed) => {
        const b = el("sub-badge");
        b.className = isSubbed ? "badge active" : "badge";
        b.textContent = isSubbed ? "SUBSCRIBED" : "SUBSCRIBE";
    },
    updateSpeedBadge: (speed) => {
        const b = el("speed-badge");
        if (speed === 1) {
            b.classList.add("hidden");
        } else {
            b.textContent = speed + "x";
            b.classList.remove("hidden");
        }
    },
    show: () => {
        el("player-hud").classList.add("visible");
        HUD.scheduleHide();
    },
    scheduleHide: () => {
        clearTimeout(App.hudTimer);
        App.hudTimer = setTimeout(() => {
            if (HUD.pinned || App.playerControls.active || !el("video-info-overlay").classList.contains("hidden")) return;
            el("player-hud").classList.remove("visible");
            el("video-info-overlay").classList.add("hidden");
        }, 4000);
    },
    refreshPinned: () => {
        // v6.1.0: Check all overlay layers for pinning HUD
        const infoVisible = !el("video-info-overlay").classList.contains("hidden");
        const commentsVisible = !el("comments-overlay").classList.contains("hidden");
        const captionsVisible = !el("captions-overlay").classList.contains("hidden");
        const anyOverlayVisible = infoVisible || commentsVisible || captionsVisible;
        HUD.pinned = App.playerControls.active || anyOverlayVisible || App.activeLayer !== "NONE";
        if (HUD.pinned) {
            el("player-hud").classList.add("visible");
            clearTimeout(App.hudTimer);
        } else {
            HUD.scheduleHide();
        }
    }
};

const ScreenSaver = {
    defaultState: () => {
        if (window.webapis && window.webapis.appcommon && webapis.appcommon.AppCommonScreenSaverState) {
            return webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON;
        }
        return "SCREEN_SAVER_ON";
    },
    normalizeState: (state) => {
        if (!window.webapis || !window.webapis.appcommon) return null;
        if (typeof state === "string" && webapis.appcommon.AppCommonScreenSaverState) {
            return webapis.appcommon.AppCommonScreenSaverState[state] || state;
        }
        return state;
    },
    setState: (state) => {
        if (!window.webapis || !window.webapis.appcommon) return;
        const resolvedState = ScreenSaver.normalizeState(state);
        if (!resolvedState) return;
        try {
            webapis.appcommon.setScreenSaver(resolvedState);
        } catch (e) {}
    },
    disable: () => {
        if (!window.webapis || !window.webapis.appcommon) return;
        if (!webapis.appcommon.AppCommonScreenSaverState) return;
        ScreenSaver.setState(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
    },
    restore: () => {
        ScreenSaver.setState(App.screenSaverState);
    }
};

window.onload = async () => {
    const tick = () => el("clock").textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    tick();
    setInterval(tick, 60000);

    UI.initLazyObserver();
    Comments.init();
    PlayerControls.init();

    if (typeof tizen !== 'undefined') {
        const k = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Return', 'Info'];
        k.forEach(key => { try { tizen.tvinputdevice.registerKey(key); } catch (e) {} });
    }

    // Disable screensaver to prevent screen dimming during video playback
    App.screenSaverState = ScreenSaver.defaultState();
    if (window.webapis && window.webapis.appcommon) {
        if (typeof webapis.appcommon.getScreenSaver === "function") {
            try {
                const currentState = webapis.appcommon.getScreenSaver();
                if (currentState) App.screenSaverState = currentState;
            } catch (e) {}
        }
        ScreenSaver.disable();
    }

    el("backend-status").textContent = "Init...";
    setupRemote();
    DB.loadProfile();
    await Network.connect();
};
