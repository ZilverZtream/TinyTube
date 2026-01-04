/**
 * TinyTube Pro v3.5 (Diamond Edition)
 * - Fixed: Tizen 4.0 Compatibility (Promise.any polyfill)
 * - Fixed: Invisible HUD bug
 * - Fixed: DeArrow async race condition
 * - Fixed: Exit logic reset
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

const App = {
    view: "BROWSE",
    api: null,
    items: [],
    focus: { area: "menu", index: 0 },
    menuIdx: 0,
    profileId: 0,
    playerMode: "BYPASS",
    sponsorSegs: [],
    exitCounter: 0,
    deArrowCache: new Map(),
    hudTimer: null
};

const el = (id) => document.getElementById(id);

// --- 1. SAFE UTILS ---
const Utils = {
    create: (tag, cls, text) => {
        const e = document.createElement(tag);
        if(cls) e.className = cls;
        if(text) e.textContent = text;
        return e;
    },
    safeParse: (str, def) => {
        try { return JSON.parse(str) || def; } 
        catch { return def; }
    },
    // FIX 1: Tizen 4.0 Polyfill for Promise.any
    any: (promises) => {
        return new Promise((resolve, reject) => {
            let errors = [];
            let rejectedCount = 0;
            if(promises.length === 0) reject(new Error("No promises"));
            promises.forEach(p => p.then(resolve).catch(e => {
                errors.push(e);
                rejectedCount++;
                if (rejectedCount === promises.length) reject(errors);
            }));
        });
    },
    processQueue: async (items, limit, asyncFn) => {
        let results = [];
        const executing = [];
        for (const item of items) {
            const p = asyncFn(item).then(r => results.push(r));
            executing.push(p);
            if (executing.length >= limit) {
                await Promise.race(executing);
                executing.splice(executing.findIndex(e => e === p), 1);
            }
        }
        await Promise.all(executing);
        return results;
    },
    toast: (msg) => {
        const t = el("toast");
        t.textContent = msg;
        t.classList.remove("hidden");
        if(t.timer) clearTimeout(t.timer);
        t.timer = setTimeout(() => t.classList.add("hidden"), 3000);
    },
    formatTime: (sec) => {
        if (!sec || isNaN(sec)) return "0:00";
        const m = Math.floor(sec/60);
        const s = Math.floor(sec%60);
        return `${m}:${s<10?'0'+s:s}`;
    }
};

// --- 2. LOCAL DATABASE ---
const DB = {
    loadProfile: () => {
        App.profileId = parseInt(localStorage.getItem("tt_pid") || "0");
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        el("p-name").textContent = names[App.profileId];
        el("modal-profile-id").textContent = `#${App.profileId + 1}`;
        el("profile-name-input").value = names[App.profileId];
    },
    saveProfileName: (name) => {
        const names = Utils.safeParse(localStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        names[App.profileId] = name;
        localStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    getSubs: () => Utils.safeParse(localStorage.getItem(`tt_subs_${App.profileId}`), []),
    toggleSub: (id, name, thumb) => {
        if (!id) return;
        let subs = DB.getSubs();
        const exists = subs.find(s => s.id === id);
        if (exists) {
            subs = subs.filter(s => s.id !== id);
            Utils.toast(`Unsubscribed: ${name}`);
        } else {
            subs.push({ id, name, thumb });
            Utils.toast(`Subscribed: ${name}`);
        }
        localStorage.setItem(`tt_subs_${App.profileId}`, JSON.stringify(subs));
        if(App.view === "PLAYER") HUD.updateSubBadge(!exists);
        if(App.menuIdx === 1) Feed.renderSubs(); 
    },
    isSubbed: (id) => !!DB.getSubs().find(s => s.id === id)
};

// --- 3. NETWORK ENGINE ---
const Network = {
    connect: async () => {
        const custom = localStorage.getItem("customBase");
        if (custom) {
            App.api = custom;
            Feed.loadHome();
            return;
        }

        const cached = localStorage.getItem("lastWorkingApi");
        if(cached) {
            try {
                if(await Network.ping(cached)) {
                    App.api = cached;
                    log(`Restored: ${cached.split('/')[2]}`);
                    Feed.loadHome();
                    Network.updateInstanceList();
                    return;
                }
            } catch(e) {}
        }

        log("Scanning Network Mesh...");
        const instances = Utils.safeParse(localStorage.getItem("cached_instances"), FALLBACK_INSTANCES);
        
        const pings = instances.map(url => 
            Network.ping(url).then(ok => ok ? url : Promise.reject())
        );

        try {
            // FIX: Use polyfill instead of Promise.any
            const winner = await Utils.any(pings);
            App.api = winner;
            log(`Connected: ${winner.split('/')[2]}`);
            localStorage.setItem("lastWorkingApi", winner);
            Feed.loadHome();
            Network.updateInstanceList();
        } catch (e) {
            el("grid-container").innerHTML = "<h3>Network Error</h3><p>All nodes unreachable.</p>";
        }
    },
    ping: async (url) => {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2500);
            const res = await fetch(`${url}/trending`, { signal: controller.signal });
            clearTimeout(id);
            return res.ok;
        } catch { return false; }
    },
    updateInstanceList: async () => {
        try {
            const res = await fetch(DYNAMIC_LIST_URL);
            const data = await res.json();
            const fresh = data.filter(i => i[1].api && i[1].type === "https").map(i => i[1].uri + "/api/v1").slice(0, 8);
            if(fresh.length > 0) localStorage.setItem("cached_instances", JSON.stringify(fresh));
        } catch(e) {}
    }
};

// --- 4. FEED ENGINE ---
const Feed = {
    loadHome: async () => {
        const subs = DB.getSubs();
        if (subs.length === 0) {
            el("section-title").textContent = "Global Trending (No Subs)";
            return Feed.fetch("/trending");
        }

        el("section-title").textContent = `My Feed (${subs.length})`;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon">🔄</div><p>Aggregating...</p></div>';

        try {
            const results = await Utils.processQueue(subs, CONCURRENCY_LIMIT, async (sub) => {
                try {
                    const res = await fetch(`${App.api}/channels/${sub.id}/videos?page=1`);
                    if(!res.ok) return [];
                    const data = await res.json();
                    return data.slice(0, 2); 
                } catch { return []; }
            });

            const feed = results.flat().sort((a,b) => b.published - a.published);
            if (feed.length < 10) {
                const trend = await (await fetch(`${App.api}/trending`)).json();
                feed.push(...trend.slice(0, 10));
            }
            UI.renderGrid(feed);
        } catch (e) {
            Feed.fetch("/trending");
        }
    },
    fetch: async (endpoint) => {
        if(!App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon">🔄</div></div>';
        try {
            const res = await fetch(`${App.api}${endpoint}`);
            const data = await res.json();
            UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
        } catch(e) { log("Feed Error"); }
    },
    renderSubs: () => {
        el("section-title").textContent = "Manage Subscriptions";
        const subs = DB.getSubs();
        UI.renderGrid(subs.map(s => ({
            type: "channel", author: s.name, authorId: s.id, authorThumbnails: [{url: s.thumb}]
        })));
    }
};

// --- 5. UI RENDERER ---
const UI = {
    renderGrid: (data) => {
        App.items = data || [];
        const grid = el("grid-container");
        grid.textContent = "";

        if (App.items.length === 0) {
            grid.innerHTML = "<p>No results found.</p>";
            return;
        }

        App.items.forEach((item, idx) => {
            if(item.type && item.type !== "video" && item.type !== "channel" && item.type !== "shortVideo") return;

            const div = Utils.create("div", item.type === "channel" ? "channel-card" : "video-card");
            div.id = `card-${idx}`;

            const img = Utils.create("img", item.type === "channel" ? "c-avatar" : "thumb");
            img.src = (item.videoThumbnails?.[0]?.url || item.authorThumbnails?.[0]?.url || "icon.png");
            img.onerror = function() { this.src = "icon.png"; };
            div.appendChild(img);

            if (item.type === "channel") {
                div.appendChild(Utils.create("h3", null, item.author));
                if(DB.isSubbed(item.authorId)) div.appendChild(Utils.create("div", "sub-tag", "SUBSCRIBED"));
            } else {
                const meta = Utils.create("div", "meta");
                const h3 = Utils.create("h3", null, item.title);
                h3.id = `title-${idx}`;
                meta.appendChild(h3);
                meta.appendChild(Utils.create("p", null, item.author));
                div.appendChild(meta);
            }
            grid.appendChild(div);
        });

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
        } else if (App.focus.area === "search") {
            el("search-input").classList.add("focused");
        } else if (App.focus.area === "settings") {
            el("save-btn").classList.add("focused-btn");
        }
    },
    fetchDeArrow: (item, idx) => {
        item.deArrowChecked = true;
        const vId = item.videoId || item.url?.split("v=")[1];
        if(!vId) return;

        if(App.deArrowCache.has(vId)) {
            UI.applyDeArrow(App.deArrowCache.get(vId), idx, vId);
            return;
        }

        // Cache Limit Cleanup
        if (App.deArrowCache.size > 200) App.deArrowCache.clear();

        fetch(`${DEARROW_API}?videoID=${vId}`)
            .then(r=>r.json())
            .then(d=>{
                App.deArrowCache.set(vId, d);
                UI.applyDeArrow(d, idx, vId);
            }).catch(()=>{});
    },
    // FIX 3: Race Condition check
    applyDeArrow: (d, idx, originalId) => {
        if (!App.items[idx]) return;
        const currentId = App.items[idx].videoId || App.items[idx].url?.split("v=")[1];
        
        // Safety check: Is the item at this index still the same video?
        if (currentId !== originalId) return;

        if(d.titles?.[0]) {
            const elTitle = el(`title-${idx}`);
            if(elTitle) elTitle.textContent = d.titles[0].title;
            App.items[idx].title = d.titles[0].title;
        }
    }
};

// --- 6. PLAYER ENGINE ---
const Player = {
    start: async (item) => {
        App.view = "PLAYER";
        App.playerMode = "BYPASS";
        el("player-layer").classList.remove("hidden");
        // FIX 2: Make HUD visible
        el("player-hud").classList.add("visible");
        
        const vId = item.videoId || item.url.split("v=")[1];
        el("player-title").textContent = item.title;
        HUD.updateSubBadge(DB.isSubbed(item.authorId));

        fetch(`${SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo","intro"]`)
            .then(r=>r.ok?r.json():[]).then(s => App.sponsorSegs = s).catch(()=>{});

        if (App.api) {
            try {
                const res = await fetch(`${App.api}/streams/${vId}`);
                const data = await res.json();
                
                const p = el("native-player");
                let validStream = data.videoStreams.find(s => s.quality === "1080p" && s.format === "MPEG-4") 
                               || data.videoStreams.find(s => s.format === "MPEG-4");

                if(!validStream && data.videoStreams.length > 0) {
                    for(let s of data.videoStreams) {
                         if(p.canPlayType(s.mimeType) !== "") { validStream = s; break; }
                    }
                }

                if(validStream) {
                    p.src = validStream.url;
                    p.style.display = "block";
                    p.play();
                    Player.setupHUD(p);
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
        Utils.toast("Enforcement Mode Active");
    },
    setupHUD: (p) => {
        // Reset timer on interaction
        const resetTimer = () => {
            el("player-hud").classList.add("visible");
            if(App.hudTimer) clearTimeout(App.hudTimer);
            App.hudTimer = setTimeout(() => el("player-hud").classList.remove("visible"), 4000);
        };

        p.ontimeupdate = () => {
            el("progress-fill").style.width = (p.currentTime / p.duration * 100) + "%";
            el("curr-time").textContent = Utils.formatTime(p.currentTime);
            el("total-time").textContent = Utils.formatTime(p.duration);

            for(const s of App.sponsorSegs) {
                if(p.currentTime >= s.segment[0] && p.currentTime < s.segment[1]) {
                    p.currentTime = s.segment[1];
                    Utils.toast("Skipped Sponsor");
                }
            }
        };

        // Hook interactions to show HUD
        ["play", "pause", "seeked"].forEach(e => p.addEventListener(e, resetTimer));
    }
};

// --- 7. INPUT HANDLER ---
function setupRemote() {
    document.addEventListener('keydown', (e) => {
        // FIX 4: HOTEL CALIFORNIA (Safety Check)
        if (e.keyCode !== 10009) App.exitCounter = 0;

        if (App.view === "PLAYER") {
            const p = el("native-player");
            const item = App.items[App.focus.index];
            switch(e.keyCode) {
                case 10009: // BACK
                    App.view = "BROWSE";
                    el("player-layer").classList.add("hidden");
                    p.pause(); p.src=""; el("enforcement-container").innerHTML="";
                    break;
                case 415: case 13: if(App.playerMode==="BYPASS") p.paused?p.play():p.pause(); break;
                case 37: if(App.playerMode==="BYPASS") p.currentTime -= 10; break;
                case 39: if(App.playerMode==="BYPASS") p.currentTime += 10; break;
                case 403: // RED
                    const vId = item.videoId || item.url.split("v=")[1];
                    if(App.playerMode==="BYPASS") Player.enforce(vId);
                    else { el("enforcement-container").innerHTML=""; p.style.display="block"; p.play(); App.playerMode="BYPASS"; }
                    break;
                case 406: // BLUE
                    if(item.authorId) DB.toggleSub(item.authorId, item.author);
                    break;
            }
            return;
        }

        if (App.view === "SETTINGS") {
            if(e.keyCode === 10009) { el("settings-overlay").classList.add("hidden"); App.view = "BROWSE"; }
            if(e.keyCode === 13) App.actions.saveSettings();
            return;
        }

        if (App.focus.area === "search") {
            if (e.keyCode === 13) App.actions.runSearch();
            if (e.keyCode === 40) { App.focus.area = "grid"; UI.updateFocus(); }
            return;
        }

        // BROWSE NAV
        switch(e.keyCode) {
            case 38: // UP
                if (App.focus.area === "grid" && App.focus.index >= 4) App.focus.index -= 4;
                else if (App.focus.area === "menu") { App.menuIdx--; if(App.menuIdx<0)App.menuIdx=0; }
                break;
            case 40: // DOWN
                if (App.focus.area === "grid") App.focus.index += 4;
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
                else if (App.focus.area === "grid") App.focus.index++;
                break;
            case 13: // ENTER
                if (App.focus.area === "menu") App.actions.menuSelect();
                if (App.focus.area === "grid") {
                    const item = App.items[App.focus.index];
                    if (item.type === "channel") DB.toggleSub(item.authorId, item.author, item.authorThumbnails?.[0]?.url);
                    else Player.start(item);
                }
                break;
            case 406: // BLUE
                 if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if(i.authorId) DB.toggleSub(i.authorId, i.author, i.authorThumbnails?.[0]?.url);
                 }
                 break;
            case 10009: // BACK
                if (App.focus.area === "search") {
                    App.focus.area = "menu";
                    el("search-input").classList.add("hidden");
                } else {
                    App.exitCounter++;
                    if(App.exitCounter >= 2) tizen.application.getCurrentApplication().exit();
                    else Utils.toast("Press Back Again to Exit");
                }
                break;
        }
        UI.updateFocus();
    });
}

// --- ACTIONS ---
const App.actions = {
    menuSelect: () => {
        if(App.menuIdx===0) Feed.loadHome();
        if(App.menuIdx===1) Feed.renderSubs();
        if(App.menuIdx===2) { App.focus.area="search"; el("search-input").classList.remove("hidden"); el("search-input").focus(); }
        if(App.menuIdx===3) { App.view="SETTINGS"; el("settings-overlay").classList.remove("hidden"); }
    },
    runSearch: () => {
        const q = el("search-input").value;
        el("search-input").classList.add("hidden");
        Feed.fetch(`/search?q=${encodeURIComponent(q)}`);
    },
    switchProfile: () => {
        const next = (App.profileId + 1) % 3;
        localStorage.setItem("tt_pid", next);
        location.reload();
    },
    saveSettings: () => {
        const name = el("profile-name-input").value.trim();
        const api = el("api-input").value.trim();
        if(name) DB.saveProfileName(name);
        if(api) localStorage.setItem("customBase", api);
        else localStorage.removeItem("customBase");
        location.reload();
    }
};

const HUD = {
    updateSubBadge: (isSubbed) => {
        const b = el("sub-badge");
        b.className = isSubbed ? "badge active" : "badge";
        b.textContent = isSubbed ? "SUBSCRIBED" : "SUBSCRIBE (Blue)";
    }
};

// --- BOOT ---
window.onload = async () => {
    const tick = () => el("clock").textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    tick(); setInterval(tick, 60000);
    
    if(typeof tizen !== 'undefined') {
        const k = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Blue', 'Return'];
        k.forEach(key => { try { tizen.tvinputdevice.registerKey(key); } catch(e){} });
    }

    log("Initializing...");
    setupRemote();
    DB.loadProfile();
    await Network.connect();
};
function log(msg) { el("backend-status").textContent = msg; console.log(msg); }
