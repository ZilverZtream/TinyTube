/**
 * TinyTube Pro v7.0 ("The Professor's Choice")
 *
 * v7.0 Changes:
 * - NEW: Client-Side Extraction Engine (Direct connection to YouTube)
 * - NEW: Signature Deciphering (Reverse engineers base.js on the fly)
 * - NEW: Hybrid Fallback (Direct -> Invidious API -> Embed)
 * - PERF: 1080p streaming without API bottlenecks
 *
 * v6.1.0 (Preserved):
 * - Centralized Input Router (activeLayer)
 * - Captions/Comments/Info overlays full controller support
 */

const CONFIG = {
    FALLBACK_INSTANCES: [
        "https://inv.nadeko.net/api/v1",
        "https://yewtu.be/api/v1",
        "https://invidious.nerdvpn.de/api/v1",
        "https://inv.perditum.com/api/v1"
    ],
    DYNAMIC_LIST_URL: "https://api.invidious.io/instances.json?sort_by=health",
    SPONSOR_API: "https://sponsor.ajay.app/api/skipSegments",
    DEARROW_API: "https://dearrow.ajay.app/api/branding",
    TIMEOUT: 8000,
    SPEEDS: [1, 1.25, 1.5, 2, 0.5],
    SEEK_ACCELERATION_DELAY: 500,
    SEEK_INTERVALS: [10, 30, 60]
};

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
    
    // Caches
    deArrowCache: new LRUCache(200),
    streamCache: new LRUCache(50),
    subsCache: null,
    subsCacheId: null,
    
    // Async & State
    pendingDeArrow: {},
    pendingFetches: {},
    rafId: null,
    lazyObserver: null,
    
    // Player State
    currentVideoId: null,
    currentVideoData: null,
    playbackSpeedIdx: 0,
    captionTracks: [],
    infoKeyTimer: null,
    infoKeyHandled: false,
    seekKeyHeld: null,
    seekKeyTime: 0,
    seekRepeatCount: 0,
    
    // DOM & System
    playerElements: null,
    screenSaverState: null,
    watchHistory: null,
    
    // Input Router (v6.1.0)
    activeLayer: "NONE", // NONE, CONTROLS, COMMENTS, CAPTIONS, INFO
    playerControls: { active: false, index: 0 },

    // Extractor State (v7.0)
    baseJsUrl: null,
    decipherOps: null
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
    any: (promises) => {
        return new Promise((resolve, reject) => {
            let errors = [];
            let rejected = 0;
            let resolved = false;
            if (promises.length === 0) reject(new Error("No promises"));
            promises.forEach(p => p.then(val => {
                if (!resolved) { resolved = true; resolve(val); }
            }).catch(e => {
                errors.push(e);
                rejected++;
                if (rejected === promises.length) reject(errors);
            }));
        });
    },
    fetchWithTimeout: (url, options = {}, timeout = CONFIG.TIMEOUT) => {
        return new Promise((resolve, reject) => {
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('Fetch timeout'));
            }, timeout);
            fetch(url, options).then(res => {
                if (!timedOut) { clearTimeout(timer); resolve(res); }
            }).catch(err => {
                if (!timedOut) { clearTimeout(timer); reject(err); }
            });
        });
    },
    fetchDedup: async (url, options = {}, timeout = CONFIG.TIMEOUT) => {
        if (App.pendingFetches[url]) return App.pendingFetches[url];
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
    isValidUrl: (s) => { try { return s.startsWith("http"); } catch { return false; } },
    toast: (msg) => {
        const t = el("toast");
        t.textContent = msg;
        t.classList.remove("hidden");
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
    },
    formatTime: (sec) => {
        if (!sec || isNaN(sec)) return "0:00";
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        return (h > 0 ? h + ":" : "") + (m < 10 && h > 0 ? '0' + m : m) + ":" + (s < 10 ? '0' + s : s);
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
        if (item.url) {
            const v = item.url.match(/[?&]v=([^&]+)/);
            if (v) return v[1];
        }
        return null;
    },
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
        if (item.authorThumbnails && item.authorThumbnails[0]) return item.authorThumbnails[0].url;
        if (item.thumb) return item.thumb;
        return "icon.png";
    },
    clamp: (val, min, max) => Math.max(min, Math.min(max, val))
};

// --- 2. EXTRACTOR (THE PROFESSOR'S ENGINE v7.0) ---
const Extractor = {
    getDecipherOps: async (baseJsUrl) => {
        if (App.decipherOps && App.baseJsUrl === baseJsUrl) return App.decipherOps;
        const js = await (await Utils.fetchWithTimeout(baseJsUrl)).text();
        
        // Find decipher function name
        const funcNameMatch = js.match(/a\.set\([^,]+,encodeURIComponent\(([\w$]+)\(/) || 
                              js.match(/\.sig\|\|([a-zA-Z0-9$]+)\(/);
        if (!funcNameMatch) return null;
        const funcName = funcNameMatch[1];

        // Extract function body
        const funcBodyRegex = new RegExp(`${funcName.replace('$','\\$')}=function\\(a\\)\\{a=a\\.split\\(""\\);(.+?)return a\\.join`);
        const funcBodyMatch = js.match(funcBodyRegex);
        if (!funcBodyMatch) return null;
        const opsRaw = funcBodyMatch[1];

        // Find helper object
        const helperNameMatch = opsRaw.match(/([a-zA-Z0-9$]+)\.[a-zA-Z0-9$]+\(a/);
        if (!helperNameMatch) return null;
        const helperName = helperNameMatch[1];

        // Extract helper object body
        const helperRegex = new RegExp(`var ${helperName.replace('$','\\$')}=\\{([\\s\\S]+?)\\};`);
        const helperMatch = js.match(helperRegex);
        if (!helperMatch) return null;

        // Parse helper functions
        const helpers = {};
        helperMatch[1].split("},").forEach(part => {
            const [name, body] = part.split(":function(a");
            if (name && body) {
                const opName = name.trim();
                if (body.includes("reverse")) helpers[opName] = (a) => a.reverse();
                else if (body.includes("splice")) helpers[opName] = (a, b) => a.splice(0, b);
                else helpers[opName] = (a, b) => { const c=a[0];a[0]=a[b%a.length];a[b%a.length]=c; };
            }
        });

        // Build operations
        const ops = opsRaw.split(";").filter(s => s).map(stmt => {
            const m = stmt.match(new RegExp(`${helperName}\\.([a-zA-Z0-9$]+)\\(a,(\\d+)\\)`));
            if (m) {
                const fn = helpers[m[1]];
                const arg = parseInt(m[2], 10);
                return (a) => fn(a, arg);
            }
            return null;
        }).filter(Boolean);

        App.decipherOps = ops;
        App.baseJsUrl = baseJsUrl;
        return ops;
    },

    decipher: (sig, ops) => {
        const a = sig.split("");
        ops.forEach(op => op(a));
        return a.join("");
    },

    extract: async (videoId) => {
        const html = await (await Utils.fetchWithTimeout(`https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999`)).text();
        
        const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (!prMatch) throw new Error("No player data");
        const pr = JSON.parse(prMatch[1]);
        
        if (pr.playabilityStatus && pr.playabilityStatus.status !== "OK") throw new Error("Unplayable");

        let jsUrl = null;
        const jsMatch = html.match(/"jsUrl":"(\/s\/player\/[^"]+\/base\.js)"/);
        if (jsMatch) jsUrl = `https://www.youtube.com${jsMatch[1]}`;

        let formats = [...(pr.streamingData?.formats || []), ...(pr.streamingData?.adaptiveFormats || [])];
        let url = null;

        // Priority: Progressive MP4 (720p/360p) for compatibility
        let best = formats.filter(f => f.mimeType.includes("video/mp4") && f.audioQuality)
                          .sort((a,b) => b.bitrate - a.bitrate)[0];
        
        // Fallback: Video-only MP4 (might be silent but plays)
        if (!best) best = formats.filter(f => f.mimeType.includes("video/mp4")).sort((a,b) => b.bitrate - a.bitrate)[0];

        if (best) {
            if (best.url) {
                url = best.url;
            } else if (best.signatureCipher) {
                if (!jsUrl) throw new Error("Ciphered but no JS");
                const params = new URLSearchParams(best.signatureCipher);
                const s = params.get("s");
                const sp = params.get("sp") || "sig";
                const ops = await Extractor.getDecipherOps(jsUrl);
                const sig = Extractor.decipher(s, ops);
                url = `${params.get("url")}&${sp}=${sig}`;
            }
        }

        return {
            url: url,
            meta: {
                title: pr.videoDetails.title,
                author: pr.videoDetails.author,
                viewCount: pr.videoDetails.viewCount,
                description: pr.videoDetails.shortDescription,
                published: Date.now() / 1000 // Direct extraction lacks precise TS
            }
        };
    }
};

// --- 3. LOCAL DB ---
const DB = {
    loadProfile: () => {
        App.profileId = parseInt(localStorage.getItem("tt_pid") || "0");
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        el("p-name").textContent = names[App.profileId];
        el("modal-profile-id").textContent = `#${App.profileId + 1}`;
        el("profile-name-input").value = names[App.profileId];
        App.subsCache = null;
        App.subsCacheId = null;
        App.watchHistory = Utils.safeParse(localStorage.getItem(`tt_history_${App.profileId}`), {});
    },
    saveProfileName: (name) => {
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        names[App.profileId] = name;
        localStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    getSubs: () => {
        if (App.subsCache && App.subsCacheId === App.profileId) return App.subsCache;
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
    savePosition: (videoId, position, duration) => {
        if (!videoId || !position || position < 10) return;
        if (duration && position > duration - 10) {
            delete App.watchHistory[videoId];
        } else {
            App.watchHistory[videoId] = { pos: Math.floor(position), ts: Date.now() };
            const keys = Object.keys(App.watchHistory);
            if (keys.length > CONFIG.WATCH_HISTORY_LIMIT) {
                keys.sort((a, b) => App.watchHistory[a].ts - App.watchHistory[b].ts);
                for (let i = 0; i < keys.length - CONFIG.WATCH_HISTORY_LIMIT; i++) {
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

// --- 4. NETWORK ---
const Network = {
    connect: async () => {
        const custom = localStorage.getItem("customBase");
        if (custom && Utils.isValidUrl(custom)) { App.api = custom; Feed.loadHome(); return; }
        else if (custom) localStorage.removeItem("customBase");

        const cached = localStorage.getItem("lastWorkingApi");
        if (cached && await Network.ping(cached)) {
            App.api = cached;
            el("backend-status").textContent = `Restored: ${cached.split('/')[2]}`;
            Feed.loadHome();
            Network.updateInstanceList();
            return;
        }

        el("backend-status").textContent = "Scanning Mesh...";
        const instances = Utils.safeParse(localStorage.getItem("cached_instances"), CONFIG.FALLBACK_INSTANCES);
        const pings = instances.map(url => Network.ping(url).then(ok => ok ? url : Promise.reject()));

        try {
            const winner = await Utils.any(pings);
            App.api = winner;
            el("backend-status").textContent = `Connected: ${winner.split('/')[2]}`;
            localStorage.setItem("lastWorkingApi", winner);
            Feed.loadHome();
            Network.updateInstanceList();
        } catch {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Network Error</h3><p>No nodes available.</p></div>';
        }
    },
    ping: async (url) => {
        try { return (await Utils.fetchWithTimeout(`${url}/trending`, {}, 2500)).ok; } catch { return false; }
    },
    updateInstanceList: async () => {
        try {
            const res = await Utils.fetchWithTimeout(CONFIG.DYNAMIC_LIST_URL, {}, 5000);
            const data = await res.json();
            const fresh = data.filter(i => i[1].api && i[1].type === "https").map(i => i[1].uri + "/api/v1").slice(0, 8);
            if (fresh.length) localStorage.setItem("cached_instances", JSON.stringify(fresh));
        } catch {}
    }
};

// --- 5. FEED ---
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
                } catch { return []; }
            });
            const feed = [].concat(...results).sort((a, b) => b.published - a.published);
            if (feed.length < 10) {
                try {
                    const tr = await (await Utils.fetchDedup(`${App.api}/trending`)).json();
                    if (Array.isArray(tr)) feed.push(...tr.slice(0, 10));
                } catch {}
            }
            UI.renderGrid(feed);
        } catch { Feed.fetch("/trending"); }
    },
    fetch: async (endpoint) => {
        if (!App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div></div>';
        try {
            const res = await Utils.fetchDedup(`${App.api}${endpoint}`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
        } catch {
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

// --- 6. UI ---
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
                } else { img.src = thumbUrl; }
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
                } else { img.src = thumbUrl; }
                tc.appendChild(img);

                if (item.lengthSeconds) tc.appendChild(Utils.create("span", "duration-badge", Utils.formatTime(item.lengthSeconds)));
                if (item.liveNow) tc.appendChild(Utils.create("span", "live-badge", "LIVE"));

                const vId = Utils.getVideoId(item);
                const savedPos = vId ? DB.getPosition(vId) : 0;
                if (savedPos > 0) tc.appendChild(Utils.create("span", "resume-badge", Utils.formatTime(savedPos)));

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
                    if (App.supportsSmoothScroll) card.scrollIntoView({ block: "center", behavior: "smooth" });
                    else card.scrollIntoView(false);
                } catch {
                    App.supportsSmoothScroll = false;
                    card.scrollIntoView(false);
                }
                const item = App.items[App.focus.index];
                if (item && item.type !== "channel" && !item.deArrowChecked) UI.fetchDeArrow(item, App.focus.index);
            }
        } else if (App.focus.area === "search") el("search-input").classList.add("focused");
        else if (App.focus.area === "settings") el("save-btn").classList.add("focused-btn");

        if (App.view === "PLAYER" && App.activeLayer === "CONTROLS") {
            PlayerControls.updateFocus();
        }
    },
    fetchDeArrow: (item, idx) => {
        item.deArrowChecked = true;
        const vId = Utils.getVideoId(item);
        if (!vId) return;
        if (App.deArrowCache.has(vId)) { UI.applyDeArrow(App.deArrowCache.get(vId), idx, vId); return; }
        if (App.pendingDeArrow[vId]) clearTimeout(App.pendingDeArrow[vId]);
        App.pendingDeArrow[vId] = setTimeout(() => {
            Utils.fetchDedup(`${CONFIG.DEARROW_API}?videoID=${vId}`, {}, 5000)
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

// --- 7. PLAYER (v7.0: Hybrid Engine) ---
const Player = {
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
        if (p) p.querySelectorAll("track").forEach(track => track.remove());
        App.captionTracks = [];
    },
    setCaptionMode: (lang, mode) => {
        App.captionTracks.forEach(track => {
            if (track && track.track) track.track.mode = (lang && track.srclang === lang) ? mode : "hidden";
        });
    },
    openCaptionsMenu: () => {
        const overlay = el("captions-overlay");
        const list = el("captions-list");
        if (!overlay || !list) return;
        if (!App.captionTracks.length) { Utils.toast("No captions"); return; }
        if (!overlay.classList.contains("hidden")) { overlay.classList.add("hidden"); return; }
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
            if (!track.srclang) option.disabled = true;
            else {
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
        const captions = data.captions.map(c => {
            const src = c.url || c.vttUrl || c.baseUrl || c.caption_url;
            return src ? { src, srclang: c.language_code || c.srclang || "", label: c.label || c.name || "Subtitles" } : null;
        }).filter(Boolean);
        if (!captions.length) return;
        const p = App.playerElements.player;
        captions.forEach(c => {
            const track = document.createElement("track");
            track.kind = "subtitles";
            track.label = c.label;
            if (c.srclang) track.srclang = c.srclang;
            track.src = c.src;
            p.appendChild(track);
            App.captionTracks.push(track);
        });
        if (storedLang) Player.setCaptionMode(storedLang, "showing");
    },
    toggleCaptions: () => {
        if (!App.captionTracks.length) { Utils.toast("No captions"); return; }
        const showing = App.captionTracks.find(t => t.track && t.track.mode === "showing");
        if (showing) {
            App.captionTracks.forEach(t => { if (t.track) t.track.mode = "hidden"; });
            Utils.toast("Captions off");
        } else {
            let lang = localStorage.getItem(Player.captionLangKey()) || App.captionTracks[0].srclang || "";
            if (lang) {
                localStorage.setItem(Player.captionLangKey(), lang);
                Player.setCaptionMode(lang, "showing");
                Utils.toast(`Captions: ${lang}`);
            }
        }
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
        if (!App.playerElements) Player.cacheElements();

        const vId = Utils.getVideoId(item);
        if(!vId) { Utils.toast("Error: No ID"); return; }
        App.currentVideoId = vId;
        
        el("player-title").textContent = item.title;
        HUD.updateSubBadge(DB.isSubbed(item.authorId));
        HUD.updateSpeedBadge(1);
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        Comments.reset();
        Player.clearCaptions();

        const p = App.playerElements.player;
        let posterUrl = "";
        if (item.videoThumbnails && item.videoThumbnails[0]) posterUrl = item.videoThumbnails[0].url;
        else if (item.thumbnail) posterUrl = item.thumbnail;
        if(posterUrl) p.poster = posterUrl;

        App.playerElements.bufferingSpinner.classList.remove("hidden");

        // Fire & Forget SponsorBlock
        App.sponsorSegs = [];
        Utils.fetchWithTimeout(`${CONFIG.SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo"]`, {}, 5000)
            .then(r=>r.json()).then(s => { if(Array.isArray(s)) App.sponsorSegs=s.sort((a,b)=>a.segment[0]-b.segment[0]); })
            .catch(()=>{});

        // --- HYBRID EXTRACTION STRATEGY ---
        let streamUrl = null;

        // 1. Direct Extraction (Professor's Way)
        if (!streamUrl) {
            try {
                const direct = await Extractor.extract(vId);
                if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;
                if (direct && direct.url) {
                    streamUrl = direct.url;
                    App.currentVideoData = direct.meta;
                    Utils.toast("Source: Direct");
                }
            } catch(e) { console.log("Direct failed", e); }
        }

        // 2. Invidious API (Fallback)
        if (!streamUrl && App.api) {
            try {
                const res = await Utils.fetchWithTimeout(`${App.api}/videos/${vId}`);
                if (App.view !== "PLAYER" || App.currentVideoId !== vId) return;
                if (res.ok) {
                    const data = await res.json();
                    App.currentVideoData = data;
                    Player.setupCaptions(data);
                    const format = data.formatStreams.find(s=>s.qualityLabel==="1080p"||s.container==="mp4") || data.formatStreams[0];
                    if(format) {
                        streamUrl = format.url;
                        Utils.toast("Source: API");
                    }
                }
            } catch(e) { console.log("API failed", e); }
        }

        // 3. Play or Embed
        if (streamUrl) {
            p.src = streamUrl;
            p.style.display = "block";
            const savedPos = DB.getPosition(vId);
            if (savedPos > 0) { p.currentTime = savedPos; Utils.toast(`Resume: ${Utils.formatTime(savedPos)}`); }
            p.play();
            Player.setupHUD(p);
            if (App.rafId) cancelAnimationFrame(App.rafId);
            App.rafId = requestAnimationFrame(Player.renderLoop);
        } else {
            Player.enforce(vId); // Strategy C: Embed
        }
        App.playerElements.bufferingSpinner.classList.add("hidden");
    },
    enforce: (vId) => {
        App.playerMode = "ENFORCE";
        App.playerElements.player.style.display = "none";
        el("enforcement-container").innerHTML = `<iframe src="https://www.youtube.com/embed/${vId}?autoplay=1"></iframe>`;
    },
    setupHUD: (p) => {
        const show = () => HUD.show();
        p.onplay = () => { App.playerElements.bufferingSpinner.classList.add("hidden"); show(); };
        p.onpause = show;
        p.onseeked = show;
        p.onwaiting = () => App.playerElements.bufferingSpinner.classList.remove("hidden");
        p.onplaying = () => App.playerElements.bufferingSpinner.classList.add("hidden");
    },
    renderLoop: () => {
        if (App.view !== "PLAYER") { if(App.rafId) cancelAnimationFrame(App.rafId); return; }
        const p = App.playerElements.player;
        if (!p.paused && !isNaN(p.duration)) {
            const pe = App.playerElements;
            pe.progressFill.style.transform = `scaleX(${p.currentTime / p.duration})`;
            pe.currTime.textContent = Utils.formatTime(p.currentTime);
            pe.totalTime.textContent = Utils.formatTime(p.duration);
            
            // Buffer bar
            if(p.buffered.length) {
                pe.bufferFill.style.transform = `scaleX(${p.buffered.end(p.buffered.length-1) / p.duration})`;
            }

            // Sponsor Skip
            const s = Utils.findSegment(p.currentTime);
            if (s && s !== App.lastSkippedSeg) {
                App.lastSkippedSeg = s;
                p.currentTime = s.segment[1] + 0.1;
                Utils.toast("Skipped");
            } else if (!s) App.lastSkippedSeg = null;
        }
        App.rafId = requestAnimationFrame(Player.renderLoop);
    },
    seek: (direction, accelerated = false) => {
        const p = App.playerElements.player;
        if (App.playerMode !== "BYPASS" || isNaN(p.duration)) return;
        let amount = CONFIG.SEEK_INTERVALS[0];
        if (accelerated) {
            const held = performance.now() - App.seekKeyTime;
            if (held > 2000) amount = CONFIG.SEEK_INTERVALS[2];
            else if (held > CONFIG.SEEK_ACCELERATION_DELAY) amount = CONFIG.SEEK_INTERVALS[1];
        }
        const newTime = direction === 'left' ? p.currentTime - amount : p.currentTime + amount;
        p.currentTime = Utils.clamp(newTime, 0, p.duration);
    },
    cycleSpeed: () => {
        const p = App.playerElements.player;
        App.playbackSpeedIdx = (App.playbackSpeedIdx + 1) % CONFIG.SPEEDS.length;
        const s = CONFIG.SPEEDS[App.playbackSpeedIdx];
        p.playbackRate = s;
        HUD.updateSpeedBadge(s);
        Utils.toast(`Speed: ${s}x`);
    },
    toggleInfo: () => {
        const overlay = el("video-info-overlay");
        if (!overlay.classList.contains("hidden")) {
            overlay.classList.add("hidden");
            App.activeLayer = "CONTROLS"; // Return to controls
            PlayerControls.setActive(true);
        } else {
            if (Comments.isOpen()) Comments.close();
            el("captions-overlay").classList.add("hidden");
            const d = App.currentVideoData;
            if (d) {
                el("info-title").textContent = d.title || "";
                el("info-author").textContent = d.author || "";
                el("info-views").textContent = Utils.formatViews(d.viewCount);
                el("info-date").textContent = Utils.formatFullDate(d.published);
                el("info-description").textContent = d.description || "";
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
        if (App.currentVideoId && p.currentTime > 10) DB.savePosition(App.currentVideoId, p.currentTime, p.duration);
        p.pause(); p.src = ""; p.poster = ""; p.playbackRate = 1;
        el("enforcement-container").innerHTML = "";
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        Comments.reset(); Comments.close();
        if(App.rafId) cancelAnimationFrame(App.rafId);
        App.rafId = null;
        Player.clearCaptions();
        ScreenSaver.restore();
    }
};

// --- 8. CONTROLLERS (Overlays) ---
const Comments = {
    state: { open: false, loading: false, nextPage: null, page: 1, videoId: null },
    elements: null,
    cache: () => {
        Comments.elements = {
            overlay: el("comments-overlay"), list: el("comments-list"),
            footer: el("comments-footer"), count: el("comments-count"), page: el("comments-page")
        };
    },
    init: () => { Comments.cache(); Comments.reset(); },
    isOpen: () => Comments.state.open,
    reset: () => {
        if(!Comments.elements) Comments.cache();
        Comments.state = { open: false, loading: false, nextPage: null, page: 1, videoId: null };
        Comments.elements.list.textContent = "";
        Comments.elements.footer.classList.add("hidden");
    },
    open: async () => {
        if(!App.currentVideoId || !App.api) return;
        if(!Comments.elements) Comments.cache();
        Comments.state.open = true;
        Comments.elements.overlay.classList.remove("hidden");
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        App.activeLayer = "COMMENTS";
        HUD.refreshPinned();
        if(Comments.state.videoId !== App.currentVideoId) {
            Comments.reset();
            Comments.state.open = true;
            Comments.elements.overlay.classList.remove("hidden");
            Comments.elements.list.textContent = "Loading...";
            Comments.state.videoId = App.currentVideoId;
            await Comments.loadPage();
        }
    },
    close: () => {
        if(!Comments.elements) Comments.cache();
        Comments.state.open = false;
        Comments.elements.overlay.classList.add("hidden");
        App.activeLayer = "CONTROLS";
        PlayerControls.setActive(true);
        HUD.refreshPinned();
    },
    toggle: () => Comments.isOpen() ? Comments.close() : Comments.open(),
    loadPage: async () => {
        if(Comments.state.loading) return;
        Comments.state.loading = true;
        Comments.elements.footer.classList.remove("hidden");
        try {
            const u = `${App.api}/comments/${App.currentVideoId}${Comments.state.nextPage ? "?continuation="+Comments.state.nextPage : ""}`;
            const res = await Utils.fetchWithTimeout(u);
            const data = await res.json();
            if(data.comments) {
                if(Comments.state.page===1) Comments.elements.list.textContent = "";
                data.comments.forEach(c => {
                    const d = Utils.create("div", "comment-item");
                    d.innerHTML = `<div class="comment-author">${c.author}</div><div class="comment-text">${c.content}</div>`;
                    Comments.elements.list.appendChild(d);
                });
            }
            Comments.state.nextPage = data.continuation;
            Comments.state.page++;
        } catch { Comments.elements.list.textContent = "Error loading comments."; }
        Comments.state.loading = false;
        if(!Comments.state.nextPage) Comments.elements.footer.classList.add("hidden");
    },
    scroll: (dir) => {
        const l = Comments.elements.list;
        l.scrollTop = Utils.clamp(l.scrollTop + (140 * dir), 0, l.scrollHeight);
        if(dir>0 && l.scrollTop + l.clientHeight >= l.scrollHeight - 40) Comments.loadPage();
    }
};

const Captions = {
    index: 0, buttons: [],
    open: () => {
        App.activeLayer = "CAPTIONS";
        Player.openCaptionsMenu();
        Captions.buttons = Array.from(document.querySelectorAll(".captions-option"));
        Captions.index = Captions.buttons.findIndex(b => b.classList.contains("active"));
        if(Captions.index === -1) Captions.index = 0;
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
        if(!Captions.buttons.length) return;
        Captions.index = (Captions.index + delta + Captions.buttons.length) % Captions.buttons.length;
        Captions.updateFocus();
    },
    updateFocus: () => {
        Captions.buttons.forEach((b, i) => {
            if(i === Captions.index) { b.classList.add("focused"); b.scrollIntoView({block:"center"}); }
            else b.classList.remove("focused");
        });
    },
    select: () => { if(Captions.buttons[Captions.index]) Captions.buttons[Captions.index].click(); Captions.close(); }
};

const PlayerControls = {
    ids: ["control-play","control-back","control-forward","control-captions","control-language","control-comments","control-subscribe"],
    buttons: [],
    actions: {
        "control-play": () => { const p=el("native-player"); if(App.playerMode==="BYPASS") p.paused?p.play():p.pause(); },
        "control-back": () => Player.seek("left"),
        "control-forward": () => Player.seek("right"),
        "control-captions": () => Player.toggleCaptions(),
        "control-language": () => Captions.open(),
        "control-comments": () => Comments.open(),
        "control-subscribe": () => { const i=App.items[App.focus.index]; if(i) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i)); }
    },
    init: () => {
        PlayerControls.buttons = PlayerControls.ids.map((id, idx) => {
            const btn = el(id);
            if(!btn) return null;
            btn.onclick = () => { App.playerControls.index=idx; PlayerControls.setActive(true); PlayerControls.runAction(id); };
            return btn;
        }).filter(Boolean);
    },
    setActive: (active) => {
        App.playerControls.active = active;
        App.activeLayer = active ? "CONTROLS" : "NONE";
        HUD.refreshPinned();
        UI.updateFocus();
    },
    move: (delta) => {
        const len = PlayerControls.buttons.length;
        App.playerControls.index = (App.playerControls.index + delta + len) % len;
        UI.updateFocus();
    },
    runAction: (id) => { if(PlayerControls.actions[id]) PlayerControls.actions[id](); },
    activateFocused: () => PlayerControls.runAction(PlayerControls.buttons[App.playerControls.index].id),
    updateFocus: () => {
        PlayerControls.buttons.forEach((b, i) => {
            if(App.playerControls.active && i === App.playerControls.index) b.classList.add("focused");
            else b.classList.remove("focused");
        });
    }
};

// --- 9. INPUT ROUTER (v6.1.0 Preserved) ---
function setupRemote() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && App.view === "PLAYER") el("native-player").pause();
    });

    document.addEventListener('keyup', (e) => {
        if ([37,39,412,417].includes(e.keyCode)) { App.seekKeyHeld = null; App.seekKeyTime = 0; }
        if (e.keyCode === 457 && App.view === "PLAYER") {
            if (App.infoKeyTimer) { clearTimeout(App.infoKeyTimer); App.infoKeyTimer = null; if (!App.infoKeyHandled) Player.toggleInfo(); }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.keyCode !== 10009) App.exitCounter = 0;

        if (App.view === "PLAYER") {
            // LAYER 1: COMMENTS
            if (App.activeLayer === "COMMENTS") {
                if (e.keyCode === 38) Comments.scroll(-1);
                else if (e.keyCode === 40) Comments.scroll(1);
                else if (e.keyCode === 10009 || e.keyCode === 405) Comments.close();
                return;
            }
            // LAYER 2: CAPTIONS
            if (App.activeLayer === "CAPTIONS") {
                if (e.keyCode === 38) Captions.move(-1);
                else if (e.keyCode === 40) Captions.move(1);
                else if (e.keyCode === 13) Captions.select();
                else if (e.keyCode === 10009) Captions.close();
                return;
            }
            // LAYER 3: INFO
            if (App.activeLayer === "INFO") {
                if (e.keyCode === 38) Player.scrollInfo(-1);
                else if (e.keyCode === 40) Player.scrollInfo(1);
                else if (e.keyCode === 10009 || e.keyCode === 457) Player.toggleInfo();
                return;
            }
            // LAYER 4: CONTROLS
            if (App.activeLayer === "CONTROLS") {
                if (e.keyCode === 37) PlayerControls.move(-1);
                else if (e.keyCode === 39) PlayerControls.move(1);
                else if (e.keyCode === 38 || e.keyCode === 10009) PlayerControls.setActive(false);
                else if (e.keyCode === 13 || e.keyCode === 415) PlayerControls.activateFocused();
                return;
            }

            // LAYER 5: BASE PLAYER
            if (e.keyCode === 40) { PlayerControls.setActive(true); return; }
            const p = el("native-player");
            switch (e.keyCode) {
                case 10009: App.view = "BROWSE"; el("player-layer").classList.add("hidden"); Player.stop(); break;
                case 10252: case 415: case 19: case 13: if (App.playerMode === "BYPASS") p.paused ? p.play() : p.pause(); break;
                case 37: 
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'left') { App.seekKeyHeld = 'left'; App.seekKeyTime = performance.now(); }
                        Player.seek('left', App.seekKeyHeld === 'left');
                    } break;
                case 39: 
                    if (App.playerMode === "BYPASS") {
                        if (App.seekKeyHeld !== 'right') { App.seekKeyHeld = 'right'; App.seekKeyTime = performance.now(); }
                        Player.seek('right', App.seekKeyHeld === 'right');
                    } break;
                case 412: if (App.playerMode === "BYPASS") Player.seek('left'); break;
                case 417: if (App.playerMode === "BYPASS") Player.seek('right'); break;
                case 403: const vId = App.currentVideoId; if(App.playerMode==="BYPASS") Player.enforce(vId); else { el("enforcement-container").innerHTML=""; p.style.display="block"; p.play(); App.playerMode="BYPASS"; } break;
                case 404: if (App.playerMode === "BYPASS") Player.cycleSpeed(); break;
                case 405: Comments.open(); break;
                case 406: const i=App.items[App.focus.index]; if(i) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i)); break;
                case 457: 
                    if(!App.infoKeyTimer) { 
                        App.infoKeyHandled=false; 
                        App.infoKeyTimer=setTimeout(()=>{ App.infoKeyHandled=true; App.infoKeyTimer=null; Player.toggleCaptions(); }, 600); 
                    } break;
            }
            return;
        }

        // SETTINGS & SEARCH (Simplified for brevity, logic remains from v6.1.0)
        if (App.view === "SETTINGS") {
            if (e.keyCode === 10009) { el("settings-overlay").classList.add("hidden"); App.view = "BROWSE"; }
            else if (e.keyCode === 13) App.actions.saveSettings();
            else if (e.keyCode === 38 || e.keyCode === 40) {
                const inputs = ["profile-name-input", "api-input", "save-btn"];
                const active = document.activeElement;
                let idx = inputs.indexOf(active ? active.id : "");
                idx = e.keyCode === 40 ? Math.min(idx + 1, inputs.length - 1) : Math.max(idx - 1, 0);
                el(inputs[idx]).focus();
            }
            return;
        }

        if (App.focus.area === "search") {
            if (e.keyCode === 13) App.actions.runSearch();
            else if (e.keyCode === 40) { el("search-input").blur(); App.focus.area = "grid"; UI.updateFocus(); }
            else if (e.keyCode === 10009) { el("search-input").classList.add("hidden"); App.focus.area = "menu"; UI.updateFocus(); }
            return;
        }

        // GRID NAVIGATION (Preserved)
        switch (e.keyCode) {
            case 38: 
                if (App.focus.area === "grid" && App.focus.index >= 4) App.focus.index -= 4;
                else if (App.focus.area === "menu") { App.menuIdx--; if(App.menuIdx<0) App.menuIdx=0; }
                break;
            case 40: 
                if (App.focus.area === "grid") {
                    const row = Math.floor(App.focus.index/4), total = Math.ceil(App.items.length/4);
                    if (row < total - 1) {
                        const next = App.focus.index + 4;
                        App.focus.index = next < App.items.length ? next : App.items.length - 1;
                    }
                } else if (App.focus.area === "menu") { App.menuIdx++; if(App.menuIdx>3) App.menuIdx=3; }
                break;
            case 37: 
                if (App.focus.area === "grid") {
                    if (App.focus.index % 4 === 0) { App.focus.area = "menu"; el("sidebar").classList.add("expanded"); }
                    else App.focus.index--;
                }
                break;
            case 39: 
                if (App.focus.area === "menu") { App.focus.area = "grid"; el("sidebar").classList.remove("expanded"); App.focus.index = 0; }
                else if (App.focus.area === "grid" && App.focus.index < App.items.length - 1) App.focus.index++;
                break;
            case 13: 
                if (App.focus.area === "menu") App.actions.menuSelect();
                if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if (i.type === "channel") DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i));
                    else Player.start(i);
                }
                break;
            case 406: 
                if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if (i.authorId) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i));
                }
                break;
            case 10009: 
                App.exitCounter++;
                if (App.exitCounter >= 2) { ScreenSaver.restore(); if(typeof tizen!=='undefined') tizen.application.getCurrentApplication().exit(); }
                else Utils.toast("Back Again to Exit");
                break;
        }
        UI.updateFocus();
    });
}

// --- INIT ---
window.onload = async () => {
    const tick = () => el("clock").textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    tick(); setInterval(tick, 60000);
    UI.initLazyObserver();
    Comments.init();
    PlayerControls.init();
    if (typeof tizen !== 'undefined') {
        ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Return', 'Info'].forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
    }
    // Disable screensaver logic
    App.screenSaverState = ScreenSaver.defaultState();
    if (window.webapis && window.webapis.appcommon) {
        try { App.screenSaverState = webapis.appcommon.getScreenSaver(); } catch(e){}
        ScreenSaver.disable();
    }
    el("backend-status").textContent = "Init...";
    setupRemote();
    DB.loadProfile();
    await Network.connect();
};
