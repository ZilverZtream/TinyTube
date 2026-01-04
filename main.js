/**
 * TinyTube Pro v5.1.0 (Tizen 4.0+ Optimized)
 *
 * Bug Fixes:
 * - Fixed: Missing getAuthorThumb function (runtime crash)
 * - Fixed: Incorrect Invidious API endpoint (/streams -> /videos)
 * - Fixed: SponsorBlock skip loop (repeated skipping at segment boundaries)
 * - Fixed: AbortController crash on Tizen 4.0 (uses token pattern)
 * - Fixed: DeArrow pending tokens now cleaned on view change
 *
 * Optimizations:
 * - GPU-accelerated progress bar (CSS transform instead of width)
 * - Lazy image loading with IntersectionObserver (200px preload margin)
 * - O(1) subscription cache (invalidated on change)
 * - O(1) LRU Cache for DeArrow data (200 item limit)
 * - O(log n) Binary Search for SponsorBlock segments
 * - Parallel fetch for SponsorBlock + video streams
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
    lastSkippedSeg: null, // Prevent skip loops
    exitCounter: 0,
    deArrowCache: new LRUCache(200),
    // Cancellation Tokens for Tizen 4.0 (No AbortController)
    pendingDeArrow: {},
    rafId: null, // Animation Frame ID
    // Subscription cache (invalidated on change)
    subsCache: null,
    subsCacheId: null,
    // Lazy load observer (Tizen 4.0+ has IntersectionObserver)
    lazyObserver: null
};

const el = (id) => document.getElementById(id);

// --- 1. UTILS ---
const Utils = {
    create: (tag, cls, text) => {
        const e = document.createElement(tag);
        if(cls) e.className = cls;
        if(text) e.textContent = text;
        return e;
    },
    safeParse: (str, def) => {
        try { return JSON.parse(str) || def; } catch { return def; }
    },
    // Safe Promise.any for Chrome 56
    any: (promises) => {
        return new Promise((resolve, reject) => {
            let errors = [];
            let rejected = 0;
            if(promises.length === 0) reject(new Error("No promises"));
            promises.forEach(p => p.then(resolve).catch(e => {
                errors.push(e);
                rejected++;
                if (rejected === promises.length) reject(errors);
            }));
        });
    },
    processQueue: async (items, limit, asyncFn) => {
        let results = [];
        const executing = [];
        for (const item of items) {
            const p = asyncFn(item).then(r => results.push(r));
            const wrapped = p.then(() => {
                const idx = executing.indexOf(wrapped);
                if (idx !== -1) executing.splice(idx, 1);
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
        // Reuse timer to prevent closure leaks
        clearTimeout(t._timer);
        t._timer = setTimeout(() => t.classList.add("hidden"), 3000);
    },
    formatTime: (sec) => {
        if (!sec || isNaN(sec)) return "0:00";
        const h = Math.floor(sec/3600);
        const m = Math.floor((sec%3600)/60);
        const s = Math.floor(sec%60);
        if (h > 0) return h + ":" + (m<10?'0'+m:m) + ":" + (s<10?'0'+s:s);
        return m + ":" + (s<10?'0'+s:s);
    },
    formatViews: (num) => {
        if (!num) return "";
        if (num >= 1e6) return (num/1e6).toFixed(1).replace(/\.0$/,'') + "M views";
        if (num >= 1e3) return (num/1e3).toFixed(1).replace(/\.0$/,'') + "K views";
        return num + " views";
    },
    formatDate: (ts) => {
        if (!ts) return "";
        const diff = (Date.now()/1000) - ts;
        if (diff < 3600) return Math.floor(diff/60) + " min ago";
        if (diff < 86400) return Math.floor(diff/3600) + " hours ago";
        if (diff < 604800) return Math.floor(diff/86400) + " days ago";
        if (diff < 2592000) return Math.floor(diff/604800) + " weeks ago";
        if (diff < 31536000) return Math.floor(diff/2592000) + " months ago";
        return Math.floor(diff/31536000) + " years ago";
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
    // Extract author thumbnail from item
    getAuthorThumb: (item) => {
        if (!item) return "icon.png";
        if (item.authorThumbnails && item.authorThumbnails[0]) {
            return item.authorThumbnails[0].url;
        }
        if (item.thumb) return item.thumb;
        return "icon.png";
    }
};

// --- 2. LOCAL DB ---
const DB = {
    loadProfile: () => {
        App.profileId = parseInt(localStorage.getItem("tt_pid") || "0");
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        el("p-name").textContent = names[App.profileId];
        el("modal-profile-id").textContent = `#${App.profileId + 1}`;
        el("profile-name-input").value = names[App.profileId];
        // Invalidate subs cache on profile load
        App.subsCache = null;
        App.subsCacheId = null;
    },
    saveProfileName: (name) => {
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        names[App.profileId] = name;
        localStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    // Cached subscription getter (O(1) after first call)
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
        let subs = DB.getSubs().slice(); // Clone to avoid mutation
        const exists = subs.find(s => s.id === id);
        if (exists) {
            subs = subs.filter(s => s.id !== id);
            Utils.toast(`Unsubscribed: ${name}`);
        } else {
            subs.push({ id, name, thumb });
            Utils.toast(`Subscribed: ${name}`);
        }
        localStorage.setItem(`tt_subs_${App.profileId}`, JSON.stringify(subs));
        // Update cache
        App.subsCache = subs;
        if(App.view === "PLAYER") HUD.updateSubBadge(!exists);
        if(App.menuIdx === 1) Feed.renderSubs();
    },
    isSubbed: (id) => !!DB.getSubs().find(s => s.id === id)
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
        if(cached && await Network.ping(cached)) {
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
            const timeout = new Promise((_, r) => setTimeout(() => r(), 2500));
            const req = fetch(`${url}/trending`);
            const res = await Promise.race([req, timeout]);
            return res && res.ok;
        } catch(e) { return false; }
    },
    updateInstanceList: async () => {
        try {
            const res = await fetch(DYNAMIC_LIST_URL);
            const data = await res.json();
            const fresh = data.filter(i => i[1].api && i[1].type === "https").map(i => i[1].uri + "/api/v1").slice(0, 8);
            if(fresh.length) localStorage.setItem("cached_instances", JSON.stringify(fresh));
        } catch(e) {}
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
                    const res = await fetch(`${App.api}/channels/${sub.id}/videos?page=1`);
                    if(!res.ok) return [];
                    const data = await res.json();
                    return data.slice(0, 2); 
                } catch(e) { return []; }
            });

            const feed = [].concat(...results).sort((a,b) => b.published - a.published);
            
            // Fill with trending if empty
            if (feed.length < 10) {
                try {
                    const tr = await (await fetch(`${App.api}/trending`)).json();
                    if(Array.isArray(tr)) feed.push(...tr.slice(0, 10));
                } catch(e){}
            }
            UI.renderGrid(feed);
        } catch (e) {
            Feed.fetch("/trending");
        }
    },
    fetch: async (endpoint) => {
        if(!App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div></div>';
        try {
            const res = await fetch(`${App.api}${endpoint}`);
            if(!res.ok) throw new Error();
            const data = await res.json();
            UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
        } catch(e) { 
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
    // Initialize lazy loading observer (call once on app start)
    initLazyObserver: () => {
        if (!("IntersectionObserver" in window)) return; // Fallback for very old Tizen
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
        }, { rootMargin: "200px" }); // Preload 200px before visible
    },
    // Handle broken image fallback
    handleImgError: (img) => {
        img.onerror = null; // Prevent infinite loop
        img.src = "icon.png";
    },
    renderGrid: (data) => {
        App.items = data || [];
        const grid = el("grid-container");
        grid.textContent = "";

        // Clear pending DeArrow tokens
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
            if(item.type && item.type !== "video" && item.type !== "channel" && item.type !== "shortVideo") continue;

            const div = Utils.create("div", item.type === "channel" ? "channel-card" : "video-card");
            div.id = `card-${idx}`;

            // Thumb
            let thumbUrl = "icon.png";
            if (item.videoThumbnails && item.videoThumbnails[0]) thumbUrl = item.videoThumbnails[0].url;
            else if (item.thumbnail) thumbUrl = item.thumbnail;
            else if (item.authorThumbnails && item.authorThumbnails[0]) thumbUrl = item.authorThumbnails[0].url;

            if (item.type === "channel") {
                const img = Utils.create("img", "c-avatar");
                img.onerror = function() { UI.handleImgError(this); };
                if (useLazy && idx > 7) { // Lazy load after first 8 items
                    img.dataset.src = thumbUrl;
                    img.src = "icon.png";
                    App.lazyObserver.observe(img);
                } else {
                    img.src = thumbUrl;
                }
                div.appendChild(img);
                div.appendChild(Utils.create("h3", null, item.author));
                if(DB.isSubbed(item.authorId)) div.appendChild(Utils.create("div", "sub-tag", "SUBSCRIBED"));
            } else {
                const tc = Utils.create("div", "thumb-container");
                const img = Utils.create("img", "thumb");
                img.onerror = function() { UI.handleImgError(this); };
                if (useLazy && idx > 7) { // Lazy load after first 8 items
                    img.dataset.src = thumbUrl;
                    img.src = "icon.png";
                    App.lazyObserver.observe(img);
                } else {
                    img.src = thumbUrl;
                }
                tc.appendChild(img);

                if (item.lengthSeconds) tc.appendChild(Utils.create("span", "duration-badge", Utils.formatTime(item.lengthSeconds)));
                if (item.liveNow) tc.appendChild(Utils.create("span", "live-badge", "LIVE"));

                div.appendChild(tc);

                const meta = Utils.create("div", "meta");
                const h3 = Utils.create("h3", null, item.title);
                h3.id = `title-${idx}`;
                meta.appendChild(h3);

                let info = item.author || "";
                if(item.viewCount) info += (info ? " • " : "") + Utils.formatViews(item.viewCount);
                if(item.published) info += (info ? " • " : "") + Utils.formatDate(item.published);

                meta.appendChild(Utils.create("p", null, info));
                div.appendChild(meta);
            }
            frag.appendChild(div);
            idx++;
        }
        grid.appendChild(frag);

        App.focus = { area: "grid", index: 0 };
        UI.updateFocus();
    },
    updateFocus: () => {
        document.querySelectorAll(".focused").forEach(e => e.classList.remove("focused"));
        
        if (App.focus.area === "menu") {
            el(["menu-home", "menu-subs", "menu-search", "menu-settings"][App.menuIdx]).classList.add("focused");
        } else if (App.focus.area === "grid") {
            const card = el(`card-${App.focus.index}`);
            if (card) {
                card.classList.add("focused");
                card.scrollIntoView({block: "center", behavior: "smooth"});
                const item = App.items[App.focus.index];
                if (item && item.type !== "channel" && !item.deArrowChecked) {
                    UI.fetchDeArrow(item, App.focus.index);
                }
            }
        } else if (App.focus.area === "search") el("search-input").classList.add("focused");
        else if (App.focus.area === "settings") el("save-btn").classList.add("focused-btn");
    },
    fetchDeArrow: (item, idx) => {
        item.deArrowChecked = true;
        const vId = Utils.getVideoId(item);
        if(!vId) return;

        if(App.deArrowCache.has(vId)) {
            UI.applyDeArrow(App.deArrowCache.get(vId), idx, vId);
            return;
        }

        // Tizen 4.0 Safe "Debounce + Cancellation"
        // We use a simple token object instead of AbortController
        if (App.pendingDeArrow[vId]) clearTimeout(App.pendingDeArrow[vId]);

        App.pendingDeArrow[vId] = setTimeout(() => {
            fetch(`${DEARROW_API}?videoID=${vId}`)
                .then(r => r.json())
                .then(d => {
                    App.deArrowCache.set(vId, d);
                    UI.applyDeArrow(d, idx, vId);
                    delete App.pendingDeArrow[vId];
                }).catch(() => delete App.pendingDeArrow[vId]);
        }, 300); // 300ms debounce
    },
    applyDeArrow: (d, idx, originalId) => {
        if (!App.items[idx]) return;
        const currentId = Utils.getVideoId(App.items[idx]);
        if (currentId !== originalId) return;

        if(d.titles && d.titles[0]) {
            const t = el(`title-${idx}`);
            if(t) t.textContent = d.titles[0].title;
            App.items[idx].title = d.titles[0].title;
        }
    }
};

// --- 6. PLAYER ---
const Player = {
    start: async (item) => {
        if(!item) return;
        App.view = "PLAYER";
        App.playerMode = "BYPASS";
        el("player-layer").classList.remove("hidden");
        el("player-hud").classList.add("visible");

        const vId = Utils.getVideoId(item);
        el("player-title").textContent = item.title;
        HUD.updateSubBadge(DB.isSubbed(item.authorId));

        // Get thumbnail for poster
        let posterUrl = "";
        if (item.videoThumbnails && item.videoThumbnails[0]) {
            posterUrl = item.videoThumbnails[0].url;
        } else if (item.thumbnail) {
            posterUrl = item.thumbnail;
        }

        const p = el("native-player");
        if (posterUrl) p.poster = posterUrl;

        // Parallel fetch: SponsorBlock + Video streams
        const sponsorPromise = fetch(`${SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo","intro"]`)
            .then(r => r.ok ? r.json() : [])
            .then(s => { App.sponsorSegs = s.sort((a, b) => a.segment[0] - b.segment[0]); })
            .catch(() => { App.sponsorSegs = []; });

        if (App.api) {
            try {
                const [res] = await Promise.all([
                    fetch(`${App.api}/videos/${vId}`),
                    sponsorPromise // Run in parallel
                ]);
                const data = await res.json();

                // Use formatStreams (combined audio+video) - best for Tizen 4.0
                const streams = data.formatStreams || [];
                const adaptiveStreams = data.adaptiveFormats || [];

                // Prefer 720p/1080p combined streams for compatibility
                let stream = streams.find(s => s.qualityLabel === "1080p" || s.quality === "1080p")
                          || streams.find(s => s.qualityLabel === "720p" || s.quality === "720p")
                          || streams.find(s => s.container === "mp4")
                          || streams[0];

                // Fallback to adaptive formats if no combined streams
                if (!stream && adaptiveStreams.length) {
                    stream = adaptiveStreams.find(s => s.container === "mp4" && s.encoding === "h264")
                          || adaptiveStreams.find(s => s.container === "mp4");
                }

                // Final fallback: try any playable format
                if (!stream) {
                    const allStreams = [...streams, ...adaptiveStreams];
                    for (const s of allStreams) {
                        const mime = s.mimeType || s.type || "video/mp4";
                        if (p.canPlayType(mime)) { stream = s; break; }
                    }
                }

                if (stream && stream.url) {
                    p.src = stream.url;
                    p.style.display = "block";
                    p.play();
                    Player.setupHUD(p);
                    // Start Render Loop
                    if (App.rafId) cancelAnimationFrame(App.rafId);
                    App.rafId = requestAnimationFrame(Player.renderLoop);
                    return;
                }
            } catch(e) {}
        }
        Player.enforce(vId);
    },
    enforce: (vId) => {
        App.playerMode = "ENFORCE";
        el("native-player").style.display = "none";
        el("enforcement-container").innerHTML = `<iframe src="https://www.youtube.com/embed/${vId}?autoplay=1" allowfullscreen></iframe>`;
    },
    setupHUD: (p) => {
        const show = () => {
            el("player-hud").classList.add("visible");
            clearTimeout(App.hudTimer);
            App.hudTimer = setTimeout(() => el("player-hud").classList.remove("visible"), 4000);
        };
        p.onplay = show;
        p.onpause = show;
        p.onseeked = show;
    },
    // GOD TIER: 60FPS UI Loop decoupled from Audio Clock
    renderLoop: () => {
        if (App.view !== "PLAYER") return;

        const p = el("native-player");
        if (!p.paused && !isNaN(p.duration)) {
            const pct = p.currentTime / p.duration;
            // Use GPU-accelerated scaleX transform
            el("progress-fill").style.transform = "scaleX(" + pct + ")";
            el("curr-time").textContent = Utils.formatTime(p.currentTime);
            el("total-time").textContent = Utils.formatTime(p.duration);

            // Binary Search for Segment (with skip loop protection)
            const seg = Utils.findSegment(p.currentTime);
            if (seg && seg !== App.lastSkippedSeg) {
                App.lastSkippedSeg = seg;
                // Add 0.1s offset to prevent landing at exact boundary
                p.currentTime = seg.segment[1] + 0.1;
                Utils.toast("Skipped sponsor");
            } else if (!seg) {
                // Clear last skipped when out of any segment
                App.lastSkippedSeg = null;
            }
        }
        App.rafId = requestAnimationFrame(Player.renderLoop);
    },
    stop: () => {
        const p = el("native-player");
        p.pause();
        p.src = "";
        p.poster = "";
        el("enforcement-container").innerHTML = "";
        el("progress-fill").style.transform = "scaleX(0)";
        if (App.rafId) cancelAnimationFrame(App.rafId);
        App.rafId = null;
        App.lastSkippedSeg = null;
        App.sponsorSegs = [];
    }
};

// --- 7. INPUT ---
function setupRemote() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && App.view === "PLAYER") el("native-player").pause();
    });

    document.addEventListener('keydown', (e) => {
        if (e.keyCode !== 10009) App.exitCounter = 0;

        if (App.view === "PLAYER") {
            const p = el("native-player");
            const item = App.items[App.focus.index];
            switch(e.keyCode) {
                case 10009: // BACK
                    App.view = "BROWSE";
                    el("player-layer").classList.add("hidden");
                    Player.stop();
                    break;
                case 415: case 13: 
                    if(App.playerMode==="BYPASS") p.paused ? p.play() : p.pause(); 
                    break;
                case 37: if(App.playerMode==="BYPASS") p.currentTime -= 10; break;
                case 39: if(App.playerMode==="BYPASS") p.currentTime += 10; break;
                case 403: // RED
                    const vId = Utils.getVideoId(item);
                    if(App.playerMode==="BYPASS") Player.enforce(vId);
                    else { el("enforcement-container").innerHTML=""; p.style.display="block"; p.play(); App.playerMode="BYPASS"; }
                    break;
                case 406: // BLUE
                    if(item.authorId) DB.toggleSub(item.authorId, item.author, Utils.getAuthorThumb(item));
                    break;
            }
            return;
        }

        if (App.view === "SETTINGS") {
            switch(e.keyCode) {
                case 10009: // BACK
                    el("settings-overlay").classList.add("hidden");
                    App.view = "BROWSE";
                    break;
                case 13: // ENTER
                    App.actions.saveSettings();
                    break;
                case 38: // UP - Focus previous input
                case 40: // DOWN - Focus next input
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
            if (e.keyCode === 40) { App.focus.area = "grid"; UI.updateFocus(); }
            return;
        }

        switch(e.keyCode) {
            case 38: // UP
                if (App.focus.area === "grid" && App.focus.index >= 4) App.focus.index -= 4;
                else if (App.focus.area === "menu") { App.menuIdx--; if(App.menuIdx<0)App.menuIdx=0; }
                break;
            case 40: // DOWN
                if (App.focus.area === "grid") {
                    const next = App.focus.index + 4;
                    if (next < App.items.length) App.focus.index = next;
                    else {
                        // Deadzone Fix: Snap to last item if on last row
                        const rowStart = Math.floor(App.focus.index / 4) * 4;
                        if (rowStart + 4 < App.items.length) App.focus.index = App.items.length - 1;
                    }
                }
                else if (App.focus.area === "menu") { App.menuIdx++; if(App.menuIdx>3)App.menuIdx=3; }
                break;
            case 37: // LEFT
                if (App.focus.area === "grid") {
                    if (App.focus.index % 4 === 0) { App.focus.area = "menu"; el("sidebar").classList.add("expanded"); }
                    else App.focus.index--;
                }
                break;
            case 39: // RIGHT
                if (App.focus.area === "menu") { App.focus.area = "grid"; el("sidebar").classList.remove("expanded"); App.focus.index = 0; }
                else if (App.focus.area === "grid" && App.focus.index < App.items.length - 1) App.focus.index++;
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
                    if(i.authorId) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i));
                 }
                 break;
            case 10009: // BACK
                if (App.focus.area === "search") {
                    App.focus.area = "menu";
                    el("search-input").classList.add("hidden");
                } else {
                    App.exitCounter++;
                    if(App.exitCounter >= 2) {
                        if(typeof tizen!=='undefined') tizen.application.getCurrentApplication().exit();
                    } else Utils.toast("Back Again to Exit");
                }
                break;
        }
        UI.updateFocus();
    });
}

App.actions = {
    menuSelect: () => {
        if(App.menuIdx===0) Feed.loadHome();
        if(App.menuIdx===1) Feed.renderSubs();
        if(App.menuIdx===2) { 
            App.focus.area="search"; 
            const inp = el("search-input");
            inp.classList.remove("hidden"); 
            inp.focus(); 
        }
        if(App.menuIdx===3) { App.view="SETTINGS"; el("settings-overlay").classList.remove("hidden"); }
    },
    runSearch: () => {
        const inp = el("search-input");
        const q = inp.value;
        inp.blur(); // Fix Ghost Keyboard
        inp.classList.add("hidden");
        Feed.fetch(`/search?q=${encodeURIComponent(q)}`);
    },
    switchProfile: () => {
        localStorage.setItem("tt_pid", (App.profileId + 1) % 3);
        location.reload();
    },
    saveSettings: () => {
        const name = el("profile-name-input").value.trim();
        const api = el("api-input").value.trim();
        if(name) DB.saveProfileName(name.substring(0,20)); // Limit length
        if(api && Utils.isValidUrl(api)) localStorage.setItem("customBase", api);
        else localStorage.removeItem("customBase");
        location.reload();
    }
};

const HUD = {
    updateSubBadge: (isSubbed) => {
        const b = el("sub-badge");
        b.className = isSubbed ? "badge active" : "badge";
        b.textContent = isSubbed ? "SUBSCRIBED" : "SUBSCRIBE";
    }
};

window.onload = async () => {
    const tick = () => el("clock").textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    tick(); setInterval(tick, 60000);

    // Initialize lazy loading for images (Tizen 4.0+ has IntersectionObserver)
    UI.initLazyObserver();

    if(typeof tizen !== 'undefined') {
        const k = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Blue', 'Return'];
        k.forEach(key => { try { tizen.tvinputdevice.registerKey(key); } catch(e){} });
    }

    el("backend-status").textContent = "Init...";
    setupRemote();
    DB.loadProfile();
    await Network.connect();
};
