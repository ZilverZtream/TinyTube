/**
 * TinyTube Pro v11.1 ("The Fixer")
 *
 * v11.1 Fixes:
 * - RESTORED: App.actions (Menu/Search/Settings logic)
 * - RESTORED: HUD object (Player UI state management)
 * - RESTORED: ScreenSaver object (Tizen hardware control)
 * - FIX: Safe access for data.formatStreams in API fallback
 *
 * v11.0 Strategy (Preserved):
 * - Perditum Primary -> Innertube Stealth -> Embed
 */

const CONFIG = {
    PRIMARY_API: "https://inv.perditum.com/api/v1",
    SPONSOR_API: "https://sponsor.ajay.app/api/skipSegments",
    DEARROW_API: "https://dearrow.ajay.app/api/branding",
    TIMEOUT: 8000,
    SPEEDS: [1, 1.25, 1.5, 2, 0.5],
    SEEK_ACCELERATION_DELAY: 500,
    SEEK_INTERVALS: [10, 30, 60],
    WATCH_HISTORY_LIMIT: 50,
    CLIENT_NAME: "ANDROID",
    CLIENT_VERSION: "20.51.39",
    SDK_VERSION: 35,
    USER_AGENT: "com.google.android.youtube/20.51.39 (Linux; U; Android 15; US) gzip"
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
    api: CONFIG.PRIMARY_API,
    items: [],
    focus: { area: "menu", index: 0 },
    menuIdx: 0,
    profileId: 0,
    playerMode: "BYPASS",
    sponsorSegs: [],
    lastSkippedSeg: null,
    exitCounter: 0,
    
    deArrowCache: new LRUCache(200),
    streamCache: new LRUCache(50),
    subsCache: null,
    subsCacheId: null,
    
    pendingDeArrow: {},
    pendingFetches: {},
    rafId: null,
    lazyObserver: null,
    supportsSmoothScroll: true,
    lastFocused: null,
    
    currentVideoId: null,
    currentVideoData: null,
    currentStreamUrl: null,
    playbackSpeedIdx: 0,
    captionTracks: [],
    infoKeyTimer: null,
    infoKeyHandled: false,
    seekKeyHeld: null,
    seekKeyTime: 0,
    seekRepeatCount: 0,
    hudTimer: null,
    lastRenderSec: null,
    
    playerElements: null,
    watchHistory: null,
    
    activeLayer: "NONE",
    playerControls: { active: false, index: 0 }
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
    getVideoId: (item) => {
        if (!item) return null;
        var raw = item.videoId || (item.url && (item.url.match(/[?&]v=([^&]+)/) || [])[1]);
        if (!raw) return null;
        return /^[a-zA-Z0-9_-]{11}$/.test(raw) ? raw : null;
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
    clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
    getFormatHeight: (format) => {
        if (!format) return 0;
        if (format.height) return format.height;
        if (format.qualityLabel) {
            const match = format.qualityLabel.match(/(\d{3,4})p/i);
            if (match) return parseInt(match[1], 10);
        }
        return 0;
    },
    isHighRes: (format) => {
        const label = (format.qualityLabel || "").toLowerCase();
        return label.includes("2160") || label.includes("4k") || Utils.getFormatHeight(format) > 1080;
    },
    pickPreferredStream: (formats) => {
        const candidates = (formats || []).filter(f => {
            if (!f) return false;
            if (f.container === "mp4") return true;
            return f.mimeType && f.mimeType.indexOf("video/mp4") !== -1;
        });
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

// --- 2. EXTRACTOR (INNERTUBE STEALTH) ---
const Extractor = {
    parseCipher: (cipher) => {
        if (!cipher) return null;
        const params = new URLSearchParams(cipher);
        const url = params.get("url");
        const s = params.get("s");
        const sp = params.get("sp") || "signature";
        const sig = params.get("sig") || params.get("signature");
        return { url, s, sp, sig };
    },
    decipherSignature: (sig) => {
        if (!sig) return "";
        try {
            const chars = sig.split("");
            if (chars.length < 5) return sig;
            const swap = (arr, idx) => {
                const pos = idx % arr.length;
                const tmp = arr[0];
                arr[0] = arr[pos];
                arr[pos] = tmp;
            };
            swap(chars, 3);
            chars.reverse();
            return chars.join("");
        } catch {
            return sig;
        }
    },
    resolveFormatUrl: (format) => {
        if (!format) return "";
        if (format.url) return format.url;
        if (format.signatureCipher) {
            const parsed = Extractor.parseCipher(format.signatureCipher);
            if (!parsed || !parsed.url) return "";
            if (parsed.sig) return `${parsed.url}&${parsed.sp}=${parsed.sig}`;
            if (parsed.s) {
                const deciphered = Extractor.decipherSignature(parsed.s);
                return `${parsed.url}&${parsed.sp}=${deciphered}`;
            }
        }
        return "";
    },
    extractInnertube: async (videoId) => {
        try {
            const body = {
                context: {
                    client: {
                        clientName: CONFIG.CLIENT_NAME,
                        clientVersion: CONFIG.CLIENT_VERSION,
                        androidSdkVersion: CONFIG.SDK_VERSION,
                        osName: "Android", osVersion: "15",
                        platform: "MOBILE",
                        hl: "en", gl: "US", utcOffsetMinutes: 0
                    },
                    thirdParty: { embedUrl: "https://www.youtube.com" }
                },
                videoId: videoId,
                contentCheckOkay: true,
                racyCheckOkay: true
            };

            const res = await Utils.fetchWithTimeout("https://www.youtube.com/youtubei/v1/player", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": CONFIG.USER_AGENT,
                    "X-YouTube-Client-Name": "3",
                    "X-YouTube-Client-Version": CONFIG.CLIENT_VERSION,
                    "Origin": "https://www.youtube.com",
                    "Referer": "https://www.youtube.com",
                    "Accept-Language": "en-US,en;q=0.9"
                },
                body: JSON.stringify(body)
            }, 12000);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (!data.playabilityStatus || data.playabilityStatus.status !== "OK") {
                throw new Error((data.playabilityStatus && data.playabilityStatus.reason) || "Unplayable");
            }

            const streamingData = data.streamingData;
            if (!streamingData) throw new Error("No streams");

            const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];

            const resolvedFormats = formats.map((format) => {
                const url = Extractor.resolveFormatUrl(format);
                return url ? Object.assign({}, format, { resolvedUrl: url }) : null;
            }).filter(Boolean);

            let best = Utils.pickPreferredStream(resolvedFormats.filter(f => f.resolvedUrl && f.audioQuality));
            if (!best) best = Utils.pickPreferredStream(resolvedFormats);
            if (!best || !best.resolvedUrl) throw new Error("No direct URL");

            var captionTracks = data.captions && data.captions.playerCaptionsTracklistRenderer && data.captions.playerCaptionsTracklistRenderer.captionTracks;
            var captions = captionTracks ? captionTracks.map(function(c) {
                return {
                    url: c.baseUrl + "&fmt=vtt",
                    language_code: c.languageCode,
                    name: (c.name && c.name.simpleText) || c.languageCode,
                    vttUrl: c.baseUrl + "&fmt=vtt"
                };
            }) : [];

            var publishDate = data.microformat && data.microformat.playerMicroformatRenderer && data.microformat.playerMicroformatRenderer.publishDate;
            return {
                url: best.resolvedUrl + "&alr=yes",
                meta: {
                    title: data.videoDetails.title,
                    author: data.videoDetails.author,
                    viewCount: data.videoDetails.viewCountText || data.videoDetails.viewCount || "0 views",
                    description: data.videoDetails.shortDescription || "",
                    published: publishDate ? (Date.parse(publishDate) / 1000) : (Date.now() / 1000),
                    captions: captions
                }
            };
        } catch (e) {
            console.log("Innertube failed:", e.message);
            throw e;
        }
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
        el("api-input").value = localStorage.getItem("customBase") || "";
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
        if (custom && Utils.isValidUrl(custom)) { 
            App.api = custom; 
            el("backend-status").textContent = "API: Custom";
        } else {
            App.api = CONFIG.PRIMARY_API;
            el("backend-status").textContent = "API: Perditum";
        }
        Feed.loadHome();
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
            const results = await Utils.processQueue(subs, 3, async (sub) => {
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
            const rendered = UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
            return { ok: true, hasItems: rendered };
        } catch {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Connection Failed</h3><p>Perditum may be busy.</p></div>';
            return { ok: false, hasItems: false };
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
            return false;
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
        return true;
    },
    updateFocus: () => {
        if (App.lastFocused) {
            App.lastFocused.classList.remove("focused");
            App.lastFocused.classList.remove("focused-btn");
        }
        App.lastFocused = null;
        if (App.focus.area === "menu") {
            const menuItem = el(["menu-home", "menu-subs", "menu-search", "menu-settings"][App.menuIdx]);
            if (menuItem) {
                menuItem.classList.add("focused");
                App.lastFocused = menuItem;
            }
        } else if (App.focus.area === "grid") {
            const card = el(`card-${App.focus.index}`);
            if (card) {
                card.classList.add("focused");
                App.lastFocused = card;
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
        } else if (App.focus.area === "search") {
            const searchInput = el("search-input");
            if (searchInput) {
                searchInput.classList.add("focused");
                App.lastFocused = searchInput;
            }
        } else if (App.focus.area === "settings") {
            const saveBtn = el("save-btn");
            if (saveBtn) {
                saveBtn.classList.add("focused-btn");
                App.lastFocused = saveBtn;
            }
        }

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

// --- 7. PLAYER ---
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
        App.currentStreamUrl = null;
        App.lastRenderSec = null;
        
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
        p.pause();
        p.src = "";
        let posterUrl = "";
        if (item.videoThumbnails && item.videoThumbnails[0]) posterUrl = item.videoThumbnails[0].url;
        else if (item.thumbnail) posterUrl = item.thumbnail;
        if(posterUrl) p.poster = posterUrl;

        App.playerElements.bufferingSpinner.classList.remove("hidden");

        App.sponsorSegs = [];
        Utils.fetchWithTimeout(`${CONFIG.SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo"]`, {}, 5000)
            .then(r=>r.json()).then(s => { if(Array.isArray(s)) App.sponsorSegs=s.sort((a,b)=>a.segment[0]-b.segment[0]); })
            .catch(()=>{});

        const isCurrent = () => App.view === "PLAYER" && App.currentVideoId === vId;
        let streamUrl = null;

        if (App.api) {
            try {
                const res = await Utils.fetchWithTimeout(`${App.api}/videos/${vId}`);
                if (!isCurrent()) return;
                if (res.ok) {
                    const data = await res.json();
                    if (!isCurrent()) return;
                    App.currentVideoData = data;
                    Player.setupCaptions(data);

                    const formats = (data.formatStreams || []).filter(s => s && s.url && (s.container === "mp4" || (s.mimeType || "").indexOf("video/mp4") !== -1));
                    const preferred = Utils.pickPreferredStream(formats);
                    if (preferred && preferred.url) {
                        streamUrl = preferred.url;
                        Utils.toast("Src: API");
                    }
                }
            } catch(e) { console.log("API failed"); }
        }

        if (!streamUrl) {
            try {
                const direct = await Extractor.extractInnertube(vId);
                if (!isCurrent()) return;
                if (direct && direct.url) {
                    streamUrl = direct.url;
                    App.currentVideoData = direct.meta;
                    if (direct.meta.captions && direct.meta.captions.length) Player.setupCaptions({captions: direct.meta.captions});
                    Utils.toast("Src: Direct (Exp)");
                }
            } catch(e) { console.log("Innertube failed"); }
        }

        if (streamUrl) {
            App.currentStreamUrl = streamUrl;
            p.src = streamUrl;
            p.style.display = "block";
            const savedPos = DB.getPosition(vId);
            if (savedPos > 0) { p.currentTime = savedPos; Utils.toast(`Resume: ${Utils.formatTime(savedPos)}`); }
            p.play();
            Player.setupHUD(p);
            if (App.rafId) cancelAnimationFrame(App.rafId);
            App.rafId = requestAnimationFrame(Player.renderLoop);
        } else {
            Player.enforce(vId);
        }
        App.playerElements.bufferingSpinner.classList.add("hidden");
    },
    
    enforce: (vId) => {
        App.playerMode = "ENFORCE";
        const p = App.playerElements.player;
        p.style.display = "none";
        p.pause();
        if (App.rafId) cancelAnimationFrame(App.rafId);
        App.rafId = null;
        el("enforcement-container").innerHTML = `
            <iframe src="https://www.youtube.com/embed/${vId}?autoplay=1&playsinline=1" 
                    width="100%" height="100%" frameborder="0" 
                    allow="autoplay; encrypted-media" allowfullscreen>
            </iframe>`;
        Utils.toast("Src: Embed");
    },
    setupHUD: (p) => {
        const show = () => HUD.show();
        p.onplay = () => {
            App.playerElements.bufferingSpinner.classList.add("hidden");
            show();
            if (!App.rafId && App.playerMode === "BYPASS") App.rafId = requestAnimationFrame(Player.renderLoop);
        };
        p.onpause = show;
        p.onseeked = show;
        p.onwaiting = () => App.playerElements.bufferingSpinner.classList.remove("hidden");
        p.onplaying = () => App.playerElements.bufferingSpinner.classList.add("hidden");
    },
    renderLoop: () => {
        if (App.view !== "PLAYER") {
            if(App.rafId) cancelAnimationFrame(App.rafId);
            App.rafId = null;
            return;
        }
        const p = App.playerElements.player;
        if (App.playerMode === "ENFORCE" || p.paused) {
            App.rafId = null;
            return;
        }
        if (!isNaN(p.duration)) {
            const currentSec = Math.floor(p.currentTime);
            if (currentSec !== App.lastRenderSec) {
                App.lastRenderSec = currentSec;
                const pe = App.playerElements;
                pe.progressFill.style.transform = `scaleX(${p.currentTime / p.duration})`;
                pe.currTime.textContent = Utils.formatTime(p.currentTime);
                pe.totalTime.textContent = Utils.formatTime(p.duration);
                if(p.buffered.length) pe.bufferFill.style.transform = `scaleX(${p.buffered.end(p.buffered.length-1) / p.duration})`;
            }
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
            App.activeLayer = "CONTROLS";
            PlayerControls.setActive(true);
        } else {
            if (Comments.isOpen()) Comments.close();
            el("captions-overlay").classList.add("hidden");
            const d = App.currentVideoData;
            if (d) {
                el("info-title").textContent = d.title || "";
                el("info-author").textContent = d.author || "";
                el("info-views").textContent = Utils.formatViews(d.viewCount);
                el("info-date").textContent = Utils.formatDate(d.published);
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
        App.lastRenderSec = null;
        App.currentStreamUrl = null;
        Player.clearCaptions();
        ScreenSaver.restore();
    }
};

// --- 8. CONTROLLERS ---
// RESTORED (v11.1)
App.actions = {
    menuSelect: () => {
        if(App.menuIdx===0) Feed.loadHome();
        if(App.menuIdx===1) Feed.renderSubs();
        if(App.menuIdx===2) { App.focus.area="search"; el("search-input").classList.remove("hidden"); el("search-input").focus(); }
        if(App.menuIdx===3) { App.view="SETTINGS"; el("settings-overlay").classList.remove("hidden"); }
    },
    runSearch: async () => {
        const input = el("search-input");
        const q = input.value.trim();
        if (!q) return;
        const result = await Feed.fetch(`/search?q=${encodeURIComponent(q)}`);
        if (result && result.ok && result.hasItems) {
            input.blur();
            input.classList.add("hidden");
            App.focus.area = "grid";
            UI.updateFocus();
        } else {
            input.focus();
        }
    },
    saveSettings: () => {
        const name = el("profile-name-input").value.trim();
        const api = el("api-input").value.trim();
        if(name) DB.saveProfileName(name);
        if(api && Utils.isValidUrl(api)) localStorage.setItem("customBase", api);
        else localStorage.removeItem("customBase");
        location.reload();
    },
    switchProfile: () => {
        App.profileId = (App.profileId + 1) % 3;
        localStorage.setItem("tt_pid", App.profileId.toString());
        DB.loadProfile();
        Utils.toast("Switched to Profile #" + (App.profileId + 1));
    }
};

// RESTORED (v11.1)
const HUD = {
    show: () => {
        el("player-hud").classList.add("visible");
        if(App.hudTimer) clearTimeout(App.hudTimer);
        App.hudTimer = setTimeout(() => el("player-hud").classList.remove("visible"), 4000);
    },
    updateSubBadge: (isSubbed) => {
        const b = el("sub-badge");
        if(b) {
            b.className = isSubbed ? "badge active" : "badge";
            b.textContent = isSubbed ? "SUBSCRIBED" : "SUBSCRIBE";
        }
    },
    updateSpeedBadge: (speed) => {
        const b = el("speed-badge");
        if(b) {
            b.textContent = speed + "x";
            if(speed === 1) b.classList.add("hidden");
            else b.classList.remove("hidden");
        }
    },
    refreshPinned: () => {
        const overlayOpen = App.activeLayer !== "NONE" && App.activeLayer !== "CONTROLS";
        if(overlayOpen) {
            el("player-hud").classList.add("visible");
            if(App.hudTimer) clearTimeout(App.hudTimer);
        } else {
            HUD.show();
        }
    }
};

// RESTORED (v11.1)
const ScreenSaver = {
    disable: () => {
        if (window.webapis && window.webapis.appcommon) {
            webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
        }
    },
    restore: () => {
        if (window.webapis && window.webapis.appcommon) {
            webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON);
        }
    },
    defaultState: () => {
        return window.webapis && window.webapis.appcommon ? 
            webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON : null;
    }
};

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
        Comments.elements.count.textContent = "0 comments";
        Comments.elements.page.textContent = "Page 1";
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
            if(!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            if(data.comments) {
                if(Comments.state.page===1) {
                    Comments.elements.list.textContent = "";
                    const count = data.commentCount || data.comments.length;
                    Comments.elements.count.textContent = count + " comment" + (count !== 1 ? "s" : "");
                }
                Comments.elements.page.textContent = "Page " + Comments.state.page;
                data.comments.forEach(function(c) {
                    var d = Utils.create("div", "comment-item");
                    var author = Utils.create("div", "comment-author");
                    author.textContent = c.author || "";
                    var text = Utils.create("div", "comment-text");
                    text.textContent = c.content || c.contentText || "";
                    d.appendChild(author);
                    d.appendChild(text);
                    Comments.elements.list.appendChild(d);
                });
            }
            Comments.state.nextPage = data.continuation;
            Comments.state.page++;
        } catch(e) { Comments.elements.list.textContent = "Error loading comments."; }
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
        Captions.buttons.forEach(function(b, i) {
            if(i === Captions.index) {
                b.classList.add("focused");
                try { b.scrollIntoView({block:"center"}); }
                catch(e) { b.scrollIntoView(false); }
            }
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

// --- 9. INPUT ROUTER ---
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
            if (App.activeLayer === "COMMENTS") {
                if (e.keyCode === 38) Comments.scroll(-1);
                else if (e.keyCode === 40) Comments.scroll(1);
                else if (e.keyCode === 10009 || e.keyCode === 405) Comments.close();
                return;
            }
            if (App.activeLayer === "CAPTIONS") {
                if (e.keyCode === 38) Captions.move(-1);
                else if (e.keyCode === 40) Captions.move(1);
                else if (e.keyCode === 13) Captions.select();
                else if (e.keyCode === 10009) Captions.close();
                return;
            }
            if (App.activeLayer === "INFO") {
                if (e.keyCode === 38) Player.scrollInfo(-1);
                else if (e.keyCode === 40) Player.scrollInfo(1);
                else if (e.keyCode === 10009 || e.keyCode === 457) Player.toggleInfo();
                return;
            }
            if (App.activeLayer === "CONTROLS") {
                if (e.keyCode === 37) PlayerControls.move(-1);
                else if (e.keyCode === 39) PlayerControls.move(1);
                else if (e.keyCode === 38 || e.keyCode === 10009) PlayerControls.setActive(false);
                else if (e.keyCode === 13 || e.keyCode === 415) PlayerControls.activateFocused();
                return;
            }

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
                case 403: {
                    const vId = App.currentVideoId;
                    if(App.playerMode==="BYPASS") {
                        Player.enforce(vId);
                    } else {
                        el("enforcement-container").innerHTML="";
                        if (!p.src && App.currentStreamUrl) p.src = App.currentStreamUrl;
                        p.style.display="block";
                        p.play();
                        App.playerMode="BYPASS";
                        if (!App.rafId) App.rafId = requestAnimationFrame(Player.renderLoop);
                    }
                    break;
                }
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
    App.supportsSmoothScroll = !(typeof tizen !== 'undefined' || /tizen/i.test(navigator.userAgent));
    if (typeof tizen !== 'undefined') {
        ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Return', 'Info'].forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
    }
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
