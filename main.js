/**
 * TinyTube Pro (Jan 2026) - Final Gold Master
 * Features: Client-Side Feed, Profiles, Search (Video+Channel), DeArrow, Resilience
 */

// --- CONFIG ---
const INSTANCES = [
    "https://inv.nadeko.net/api/v1",
    "https://yewtu.be/api/v1",
    "https://invidious.nerdvpn.de/api/v1",
    "https://invidious.f5.si/api/v1",
    "https://inv.perditum.com/api/v1"
];
const SPONSOR_API = "https://sponsor.ajay.app/api/skipSegments";
const DEARROW_API = "https://dearrow.ajay.app/api/branding";

// --- STATE MACHINE ---
const App = {
    view: "BROWSE",         // BROWSE | PLAYER | SETTINGS
    api: null,              // Active Invidious Instance
    items: [],              // Grid Data (Videos or Channels)
    focus: { area: "menu", index: 0 },
    menuIdx: 0,
    profileId: 0,
    playerMode: "BYPASS",   // BYPASS | ENFORCE
    sponsorSegs: []
};

// --- DOM CACHE ---
const el = (id) => document.getElementById(id);

// --- INITIALIZATION ---
window.onload = async () => {
    updateClock();
    setInterval(updateClock, 60000);
    
    // Tizen Remote Keys
    if(typeof tizen !== 'undefined') {
        const keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', '0', '1', 'ColorF0Red', 'ColorF1Green', 'ColorF2Blue', 'Return'];
        keys.forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch(e){} });
    }

    setupRemote();
    DB.loadProfile();
    await Network.connect();
};

function log(msg) { el("backend-status").innerText = msg; console.log(msg); }
function updateClock() { el("clock").innerText = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }

// --- 1. LOCAL DATABASE (Client-Side State) ---
const DB = {
    // Profile Management
    loadProfile: () => {
        App.profileId = parseInt(localStorage.getItem("tt_pid") || "0");
        const names = JSON.parse(localStorage.getItem("tt_pnames") || '["User 1", "User 2", "User 3"]');
        el("p-name").innerText = names[App.profileId];
        el("modal-profile-id").innerText = `#${App.profileId + 1}`;
        el("profile-name-input").value = names[App.profileId];
    },
    saveProfileName: (name) => {
        const names = JSON.parse(localStorage.getItem("tt_pnames") || '["User 1", "User 2", "User 3"]');
        names[App.profileId] = name;
        localStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    
    // Subscription Management (JSON DB)
    getSubs: () => JSON.parse(localStorage.getItem(`tt_subs_${App.profileId}`) || "[]"),
    
    toggleSub: (id, name, thumb) => {
        if (!id) return;
        let subs = DB.getSubs();
        const existing = subs.find(s => s.id === id);
        
        if (existing) {
            subs = subs.filter(s => s.id !== id);
            HUD.toast(`Unsubscribed: ${name}`);
        } else {
            subs.push({ id, name, thumb });
            HUD.toast(`Subscribed: ${name}`);
        }
        localStorage.setItem(`tt_subs_${App.profileId}`, JSON.stringify(subs));
        
        // Live Update UI if needed
        if (App.view === "PLAYER") HUD.updateSubBadge(!existing);
        if (App.menuIdx === 1) Feed.renderSubs(); // Refresh sub list if viewing it
    },
    
    isSubbed: (id) => !!DB.getSubs().find(s => s.id === id)
};

// --- 2. NETWORK ENGINE ---
const Network = {
    connect: async () => {
        const custom = localStorage.getItem("customBase");
        if (custom) {
            App.api = custom;
            Feed.loadHome();
            return;
        }

        log("Optimizing Network...");
        // Race condition to find fastest instance
        for (const url of INSTANCES) {
            try {
                // Short timeout ping
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), 3000);
                const res = await fetch(`${url}/trending`, { signal: controller.signal });
                clearTimeout(id);
                
                if (res.ok) {
                    App.api = url;
                    log(`Online: ${url.split('/')[2]}`);
                    Feed.loadHome();
                    return;
                }
            } catch(e){}
        }
        el("grid-container").innerHTML = "<h3>Network Error</h3><p>Public proxies unavailable.</p>";
    }
};

// --- 3. FEED & SEARCH ENGINE ---
const Feed = {
    loadHome: async () => {
        const subs = DB.getSubs();
        if (subs.length === 0) {
            el("section-title").innerText = "Global Trending (No Subs)";
            return Feed.fetch("/trending");
        }

        // Parallel Aggregation (The "Engineering" Feature)
        el("section-title").innerText = `My Feed (${subs.length})`;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon">🔄</div><p>Aggregating Personal Feed...</p></div>';

        try {
            // Fetch top 2 videos from every sub in parallel
            const tasks = subs.map(s => 
                fetch(`${App.api}/channels/${s.id}/videos?page=1`)
                    .then(r => r.ok ? r.json() : [])
                    .then(list => list.slice(0, 2)) // Limit 2 per channel
                    .catch(() => [])
            );

            const results = await Promise.all(tasks);
            // Flatten and Sort by Date
            const feed = results.flat().sort((a,b) => b.published - a.published);
            
            // Mix in trending if feed is sparse
            if (feed.length < 10) {
                const trend = await (await fetch(`${App.api}/trending`)).json();
                feed.push(...trend.slice(0, 10));
            }
            
            UI.renderGrid(feed);
        } catch (e) {
            Feed.fetch("/trending"); // Fallback
        }
    },

    fetch: async (endpoint) => {
        if(!App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon">🔄</div></div>';
        try {
            const res = await fetch(`${App.api}${endpoint}`);
            const data = await res.json();
            // Handle Search results (contain types) vs Trending
            const items = Array.isArray(data) ? data : (data.items || []);
            UI.renderGrid(items);
        } catch(e) { log("API Error"); }
    },

    renderSubs: () => {
        el("section-title").innerText = "Manage Subscriptions";
        const subs = DB.getSubs();
        UI.renderGrid(subs.map(s => ({
            type: "channel",
            author: s.name,
            authorId: s.id,
            authorThumbnails: [{url: s.thumb}]
        })));
    }
};

// --- 4. UI & RENDERER ---
const UI = {
    renderGrid: (data) => {
        App.items = data || [];
        const grid = el("grid-container");
        grid.innerHTML = "";
        
        if (App.items.length === 0) { grid.innerHTML = "<p>No results found.</p>"; return; }

        App.items.forEach((item, idx) => {
            const isChannel = item.type === "channel";
            
            // Filter junk
            if (!isChannel && item.type !== "video" && item.type !== "shortVideo") return;

            const div = document.createElement("div");
            div.id = `card-${idx}`;
            
            if (isChannel) {
                // CHANNEL CARD
                div.className = "channel-card";
                const thumb = item.authorThumbnails?.[0]?.url || "icon.png";
                div.innerHTML = `
                    <img class="c-avatar" src="${thumb}">
                    <h3>${item.author}</h3>
                    ${DB.isSubbed(item.authorId) ? '<div class="sub-tag">SUBSCRIBED</div>' : ''}
                `;
            } else {
                // VIDEO CARD
                div.className = "video-card";
                const thumb = item.videoThumbnails?.[0]?.url || item.thumbnail;
                div.innerHTML = `
                    <img class="thumb" src="${thumb}">
                    <div class="meta">
                        <h3 id="title-${idx}">${item.title}</h3>
                        <p>${item.author}</p>
                    </div>
                `;
                
                // DeArrow Integration
                const vId = item.videoId || item.url?.split("v=")[1];
                if (vId) {
                    fetch(`${DEARROW_API}?videoID=${vId}`).then(r=>r.json()).then(d=>{
                        if(d.titles?.[0]) {
                            el(`title-${idx}`).innerText = d.titles[0].title;
                            App.items[idx].title = d.titles[0].title;
                        }
                    }).catch(()=>{});
                }
            }
            grid.appendChild(div);
        });

        App.focus = { area: "grid", index: 0 };
        UI.updateFocus();
    },

    updateFocus: () => {
        document.querySelectorAll(".focused").forEach(e => e.classList.remove("focused"));
        
        if (App.focus.area === "menu") {
            const ids = ["menu-home", "menu-subs", "menu-search", "menu-settings"];
            el(ids[App.menuIdx]).classList.add("focused");
        } else if (App.focus.area === "grid") {
            const card = el(`card-${App.focus.index}`);
            if (card) {
                card.classList.add("focused");
                card.scrollIntoView({block: "center", behavior: "smooth"});
            }
        } else if (App.focus.area === "search") {
            el("search-input").classList.add("focused");
        } else if (App.focus.area === "settings") {
            // Simple focus on Save button for demo
            el("save-btn").classList.add("focused-btn");
        }
    }
};

// --- 5. PLAYER ENGINE ---
const Player = {
    start: async (item) => {
        App.view = "PLAYER";
        App.playerMode = "BYPASS";
        el("player-layer").classList.remove("hidden");
        
        const vId = item.videoId || item.url.split("v=")[1];
        
        // Update Title & Badge
        el("player-title").innerText = item.title;
        HUD.updateSubBadge(DB.isSubbed(item.authorId));

        // Load SponsorBlock
        fetch(`${SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo","intro"]`)
            .then(r=>r.ok?r.json():[]).then(s => App.sponsorSegs = s).catch(()=>{});

        // Try Native Stream
        if (App.api) {
            try {
                const res = await fetch(`${App.api}/streams/${vId}`);
                const data = await res.json();
                const stream = data.videoStreams.find(s => s.quality === "1080p" && s.format === "MPEG-4") || data.videoStreams[0];
                
                const p = el("native-player");
                p.src = stream.url;
                p.style.display = "block";
                p.play();
                Player.setupHUD(p);
                return;
            } catch(e) {}
        }
        Player.enforce(vId);
    },

    enforce: (vId) => {
        App.playerMode = "ENFORCE";
        el("native-player").style.display = "none";
        el("enforcement-container").innerHTML = `<iframe src="https://www.youtube.com/embed/${vId}?autoplay=1" allowfullscreen></iframe>`;
        HUD.toast("Enforcement Mode Active");
    },

    setupHUD: (p) => {
        p.ontimeupdate = () => {
            el("progress-fill").style.width = (p.currentTime / p.duration * 100) + "%";
            for(const s of App.sponsorSegs) {
                if(p.currentTime >= s.segment[0] && p.currentTime < s.segment[1]) {
                    p.currentTime = s.segment[1];
                    HUD.toast("Skipped Sponsor");
                }
            }
        };
    }
};

// --- 6. INPUT HANDLER ---
function setupRemote() {
    document.addEventListener('keydown', (e) => {
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
                case 403: // RED (Toggle)
                    const vId = item.videoId || item.url.split("v=")[1];
                    if(App.playerMode==="BYPASS") Player.enforce(vId);
                    else { el("enforcement-container").innerHTML=""; p.style.display="block"; p.play(); App.playerMode="BYPASS"; }
                    break;
                case 406: // BLUE (Sub)
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

        // BROWSE NAVIGATION
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
                    if (item.type === "channel") {
                        DB.toggleSub(item.authorId, item.author, item.authorThumbnails?.[0]?.url);
                    } else {
                        Player.start(item);
                    }
                }
                break;
            case 406: // BLUE (Sub from grid)
                if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if(i.authorId) DB.toggleSub(i.authorId, i.author, i.authorThumbnails?.[0]?.url);
                }
                break;
            case 10009: // BACK
                tizen.application.getCurrentApplication().exit();
                break;
        }
        UI.updateFocus();
    });
}

// --- ACTIONS & UTILS ---
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
    toast: (msg) => {
        // Use sponsor badge as temp toast
        const b = el("sponsor-badge");
        b.innerText = msg;
        b.classList.remove("hidden");
        setTimeout(() => b.classList.add("hidden"), 2000);
    },
    updateSubBadge: (isSubbed) => {
        const b = el("sub-badge");
        b.className = isSubbed ? "badge active" : "badge";
        b.innerText = isSubbed ? "SUBSCRIBED" : "SUBSCRIBE (Blue)";
    }
};
