(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const LRUCache = TinyTube.LRUCache;
    const Utils = TinyTube.Utils;
    const SafeStorage = TinyTube.SafeStorage;
    const el = TinyTube.el;
    const DB = TinyTube.DB;
    const Network = TinyTube.Network;
    const Feed = TinyTube.Feed;
    const UI = TinyTube.UI;
    const SearchFilters = TinyTube.SearchFilters;
    const TrendingTabs = TinyTube.TrendingTabs;
    const CardPool = TinyTube.CardPool;
    const VirtualScroll = TinyTube.VirtualScroll;
    const WorkerPool = TinyTube.WorkerPool;
    const CipherBreaker = TinyTube.CipherBreaker;
    const Player = TinyTube.Player;
    const PlayerControls = TinyTube.PlayerControls;
    const Comments = TinyTube.Comments;
    const ScreenSaver = TinyTube.ScreenSaver;
    const Shortcuts = TinyTube.Shortcuts;
    const Quality = TinyTube.Quality;
    const Chapters = TinyTube.Chapters;
    const Captions = TinyTube.Captions;

const App = {
    view: "BROWSE",
    api: CONFIG.PRIMARY_API,
    items: [],
    focus: { area: "menu", index: 0 },
    menuIdx: 0,
    menuIds: ["menu-home", "menu-subs", "menu-trending", "menu-history", "menu-watchlater", "menu-search", "menu-settings"],
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
    renderTimer: null,
    renderAnimationFrame: null,
    lazyObserver: null,
    supportsSmoothScroll: true,
    lastFocused: null,

    currentVideoId: null,
    currentVideoData: null,
    currentStreamUrl: null,
    currentVideoLoadId: 0,
    currentVideoAbortController: null,
    preloadAbortController: null,
    upNext: [],
    autoplayEnabled: false,
    playbackSpeedIdx: 0,
    captionTracks: [],
    infoKeyTimer: null,
    infoKeyHandled: false,
    seekKeyHeld: null,
    seekKeyTime: 0,
    seekRepeatCount: 0,
    hudTimer: null,
    lastRenderSec: null,
    lastRenderDuration: null,
    playerErrorRetries: 0,

    playerElements: null,
    cachedElements: null,
    watchHistory: null,

    activeLayer: "NONE",
    playerControls: { active: false, index: 0 },

    embedMessageHandler: null,
    embedTimeout: null,

    nextVideoPreloader: null,
    preloadedNextVideo: null,
    lastSponsorCheckTime: 0,

    // New Features State
    currentChannelId: null,
    currentPlaylistId: null,
    currentTrendingCategory: '',
    searchFilters: { sort: 'relevance', date: '', duration: '', type: 'video' },
    watchLaterQueue: [],
    videoChapters: [],
    availableQualities: [],
    currentQuality: null,
    qualityIndex: 0,
    chaptersIndex: 0,
    filterFocusIndex: 0,
    categoryFocusIndex: 0
};

TinyTube.App = App;

App.actions = {
    menuSelect: () => {
        // Hide category tabs and filters when switching views
        TrendingTabs.hide();
        SearchFilters.hide();

        if(App.menuIdx===0) Feed.loadHome();
        else if(App.menuIdx===1) Feed.renderSubs();
        else if(App.menuIdx===2) Feed.loadTrendingCategory('');
        else if(App.menuIdx===3) Feed.renderHistory();
        else if(App.menuIdx===4) Feed.renderWatchLater();
        else if(App.menuIdx===5) {
            App.focus.area="search";
            el("search-input").classList.remove("hidden");
            el("search-input").focus();
            SearchFilters.show();
            SearchFilters.updateUI();
        }
        else if(App.menuIdx===6) { App.view="SETTINGS"; el("settings-overlay").classList.remove("hidden"); }
    },
    runSearch: async () => {
        const input = el("search-input");
        const q = input.value.trim();
        if (!q) return;

        // Build search URL with filters
        let searchUrl = `/search?q=${encodeURIComponent(q)}`;
        if (App.searchFilters.sort && App.searchFilters.sort !== 'relevance') {
            searchUrl += `&sort_by=${App.searchFilters.sort}`;
        }
        if (App.searchFilters.date) {
            searchUrl += `&date=${App.searchFilters.date}`;
        }
        if (App.searchFilters.duration) {
            searchUrl += `&duration=${App.searchFilters.duration}`;
        }
        if (App.searchFilters.type && App.searchFilters.type !== 'video') {
            searchUrl += `&type=${App.searchFilters.type}`;
        }

        const result = await Feed.fetch(searchUrl);
        if (result && result.ok && result.hasItems) {
            input.blur();
            App.focus.area = "grid";
            UI.updateFocus();
        } else {
            input.focus();
        }
    },
    saveSettings: () => {
        const name = el("profile-name-input").value.trim();
        const api = el("api-input").value.trim();
        const maxRes = el("max-res-select").value;
        const autoplayEnabled = el("autoplay-toggle").checked;
        let apiError = false;
        if(name) DB.saveProfileName(name);
        if (api) {
            if (Utils.isValidUrl(api)) {
                SafeStorage.setItem("customBase", Utils.normalizeUrl(api));
            } else {
                apiError = true;
                SafeStorage.removeItem("customBase");
            }
        } else {
            SafeStorage.removeItem("customBase");
        }
        if (maxRes) SafeStorage.setItem("tt_max_res", maxRes);
        const oldAutoplay = App.autoplayEnabled;
        App.autoplayEnabled = autoplayEnabled;
        SafeStorage.setItem("tt_autoplay", autoplayEnabled ? "true" : "false");

        // Reload data instead of full page reload
        el("settings-overlay").classList.add("hidden");
        App.view = "BROWSE";

        // Clear caches
        App.deArrowCache.map.clear();
        App.streamCache.map.clear();
        App.subsCache = null;
        App.subsCacheId = null;

        // Reconnect to API and reload feed
        Network.connect();
        if (apiError) {
            Utils.toast("Custom API must use https://");
        } else {
            Utils.toast("Settings saved");
        }
    },
    switchProfile: () => {
        App.profileId = (App.profileId + 1) % 3;
        SafeStorage.setItem("tt_pid", App.profileId.toString());

        // Clear caches before loading new profile
        App.deArrowCache.map.clear();
        App.streamCache.map.clear();
        App.subsCache = null;
        App.subsCacheId = null;

        DB.loadProfile();

        // Reload feed for new profile
        if (App.view === "BROWSE") {
            if (App.menuIdx === 0) Feed.loadHome();
            else if (App.menuIdx === 1) Feed.renderSubs();
        }

        Utils.toast("Switched to Profile #" + (App.profileId + 1));
    }
};

function setupRemote() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && App.view === "PLAYER") {
            el("native-player").pause();
            App.seekKeyHeld = null;
            App.seekKeyTime = 0;
        }
    });
    document.addEventListener('keyup', (e) => {
        if ([37,39,412,417].includes(e.keyCode)) { App.seekKeyHeld = null; App.seekKeyTime = 0; }
        if (e.keyCode === 457 && App.view === "PLAYER") {
            if (App.infoKeyTimer) { clearTimeout(App.infoKeyTimer); App.infoKeyTimer = null; if (!App.infoKeyHandled) Player.toggleInfo(); }
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.keyCode !== 10009) App.exitCounter = 0;

        // Shortcuts overlay - only accessible via player controls
        if (App.activeLayer === "SHORTCUTS") {
            if (e.keyCode === 13 || e.keyCode === 10009) Shortcuts.close();
            return;
        }

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
            if (App.activeLayer === "QUALITY") {
                if (e.keyCode === 38) Quality.move(-1);
                else if (e.keyCode === 40) Quality.move(1);
                else if (e.keyCode === 13) Quality.select();
                else if (e.keyCode === 10009) Quality.close();
                return;
            }
            if (App.activeLayer === "CHAPTERS") {
                if (e.keyCode === 38) Chapters.move(-1);
                else if (e.keyCode === 40) Chapters.move(1);
                else if (e.keyCode === 13) Chapters.select();
                else if (e.keyCode === 10009) Chapters.close();
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
                        if (!App.renderTimer) Player.startRenderLoop();
                    }
                    break;
                }
                case 404: if (App.playerMode === "BYPASS") Player.cycleSpeed(); break;
                case 405: Comments.open(); break;
                case 406: const i=App.currentVideoData; if(i) DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i)); break;
                case 457:
                    if(!App.infoKeyTimer) {
                        App.infoKeyHandled=false;
                        App.infoKeyTimer=setTimeout(()=>{ App.infoKeyHandled=true; App.infoKeyTimer=null; Player.toggleCaptions(); }, CONFIG.INFO_KEY_LONG_PRESS_MS);
                    } break;
            }
            return;
        }
        if (App.view === "SETTINGS") {
            if (e.keyCode === 10009) { el("settings-overlay").classList.add("hidden"); App.view = "BROWSE"; }
            else if (e.keyCode === 13) App.actions.saveSettings();
            else if (e.keyCode === 38 || e.keyCode === 40) {
                const inputs = ["profile-name-input", "api-input", "max-res-select", "save-btn"];
                const active = document.activeElement;
                let idx = inputs.indexOf(active ? active.id : "");
                idx = e.keyCode === 40 ? Math.min(idx + 1, inputs.length - 1) : Math.max(idx - 1, 0);
                el(inputs[idx]).focus();
            }
            return;
        }
        // Search Filters Navigation
        if (App.focus.area === "filters") {
            if (e.keyCode === 37) SearchFilters.moveFocus(-1);
            else if (e.keyCode === 39) SearchFilters.moveFocus(1);
            else if (e.keyCode === 13) SearchFilters.activateFocused();
            else if (e.keyCode === 40) { App.focus.area = "grid"; App.focus.index = 0; UI.updateFocus(); }
            else if (e.keyCode === 10009) { App.focus.area = "search"; el("search-input").focus(); }
            return;
        }

        // Trending Tabs Navigation
        if (App.focus.area === "tabs") {
            if (e.keyCode === 37) TrendingTabs.moveFocus(-1);
            else if (e.keyCode === 39) TrendingTabs.moveFocus(1);
            else if (e.keyCode === 13) TrendingTabs.activateFocused();
            else if (e.keyCode === 40) { App.focus.area = "grid"; App.focus.index = 0; UI.updateFocus(); }
            else if (e.keyCode === 10009) { App.focus.area = "menu"; UI.updateFocus(); }
            return;
        }

        if (App.focus.area === "search") {
            if (e.keyCode === 13) App.actions.runSearch();
            else if (e.keyCode === 40) {
                // Move to filters if visible, otherwise to grid
                if (!el("search-filters").classList.contains("hidden")) {
                    App.focus.area = "filters";
                    App.filterFocusIndex = 0;
                    SearchFilters.moveFocus(0);
                } else {
                    el("search-input").blur();
                    App.focus.area = "grid";
                }
                UI.updateFocus();
            }
            else if (e.keyCode === 10009) { el("search-input").classList.add("hidden"); SearchFilters.hide(); App.focus.area = "menu"; UI.updateFocus(); }
            return;
        }

        switch (e.keyCode) {
            case 38:
                if (App.focus.area === "grid") {
                    const itemsPerRow = VirtualScroll.getItemsPerRow(document.getElementById('grid-container'));
                    if (App.focus.index >= itemsPerRow) {
                        App.focus.index -= itemsPerRow;
                    } else {
                        // Move to tabs if visible, otherwise to menu
                        if (!el("trending-tabs").classList.contains("hidden")) {
                            App.focus.area = "tabs";
                            App.categoryFocusIndex = 0;
                            TrendingTabs.moveFocus(0);
                        } else if (!el("search-filters").classList.contains("hidden")) {
                            App.focus.area = "filters";
                            App.filterFocusIndex = 0;
                            SearchFilters.moveFocus(0);
                        }
                    }
                }
                else if (App.focus.area === "menu") { App.menuIdx--; if(App.menuIdx<0) App.menuIdx=0; }
                break;
            case 40:
                if (App.focus.area === "grid") {
                    const itemsPerRow = VirtualScroll.getItemsPerRow(document.getElementById('grid-container'));
                    const row = Math.floor(App.focus.index / itemsPerRow);
                    const total = Math.ceil(App.items.length / itemsPerRow);
                    if (row < total - 1) {
                        const next = App.focus.index + itemsPerRow;
                        App.focus.index = next < App.items.length ? next : App.items.length - 1;
                    }
                } else if (App.focus.area === "menu") { App.menuIdx++; if(App.menuIdx>App.menuIds.length-1) App.menuIdx=App.menuIds.length-1; }
                break;
            case 37:
                if (App.focus.area === "grid") {
                    if (App.focus.index % 4 === 0) { App.focus.area = "menu"; el("sidebar").classList.add("expanded"); }
                    else App.focus.index--;
                }
                else if (App.focus.area === "tabs") TrendingTabs.moveFocus(-1);
                else if (App.focus.area === "filters") SearchFilters.moveFocus(-1);
                break;
            case 39:
                if (App.focus.area === "menu") { App.focus.area = "grid"; el("sidebar").classList.remove("expanded"); App.focus.index = 0; }
                else if (App.focus.area === "grid" && App.focus.index < App.items.length - 1) App.focus.index++;
                else if (App.focus.area === "tabs") TrendingTabs.moveFocus(1);
                else if (App.focus.area === "filters") SearchFilters.moveFocus(1);
                break;
            case 13:
                if (App.focus.area === "menu") App.actions.menuSelect();
                else if (App.focus.area === "grid") {
                    const i = App.items[App.focus.index];
                    if (i.type === "channel") DB.toggleSub(i.authorId, i.author, Utils.getAuthorThumb(i));
                    else if (i.type === "playlist") Feed.loadPlaylist(i.playlistId, i.title);
                    else Player.start(i);
                }
                else if (App.focus.area === "tabs") TrendingTabs.activateFocused();
                else if (App.focus.area === "filters") SearchFilters.activateFocused();
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

    // Initialize performance optimizations
    CardPool.init();
    WorkerPool.init();

    // Register service worker for API caching
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('sw.js');
            console.log('Service Worker registered successfully');
        } catch (e) {
            console.log('Service Worker registration failed:', e.message);
        }
    }

    // Add debounced window resize handler for virtual scrolling
    const handleResize = Utils.debounce(() => {
        if (VirtualScroll.enabled) {
            VirtualScroll.itemHeight = 0; // Reset to recalculate
            VirtualScroll.updateVisible();
        }
    }, CONFIG.RESIZE_DEBOUNCE_MS);
    window.addEventListener('resize', handleResize, { passive: true });

    // Store for cleanup
    App.resizeHandler = handleResize;

    UI.cacheCommonElements();
    UI.initLazyObserver();
    Comments.init();
    PlayerControls.init();
    TrendingTabs.init();
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

    // --- STARTUP SEQUENCE ---
    el("backend-status").textContent = "Connecting...";
    await Network.connect();

    const updateBackendStatus = (cipherStatus) => {
        const apiLabel = App.api === CONFIG.PRIMARY_API ? "Perditum" : "Custom";
        el("backend-status").textContent = `API: ${apiLabel} | Cipher: ${cipherStatus}`;
    };

    updateBackendStatus("checking...");
    CONFIG.CIPHER_SEQUENCE = CONFIG.DEFAULT_CIPHER;

    requestAnimationFrame(() => {
        const cipherTimeoutMs = 4000;
        let cipherResolved = false;
        const cipherTimeout = setTimeout(() => {
            if (!cipherResolved) {
                CONFIG.CIPHER_SEQUENCE = CONFIG.DEFAULT_CIPHER;
                updateBackendStatus("default (timeout)");
            }
        }, cipherTimeoutMs);

        CipherBreaker.run()
            .then((freshCipher) => {
                cipherResolved = true;
                clearTimeout(cipherTimeout);
                CONFIG.CIPHER_SEQUENCE = freshCipher;
                updateBackendStatus("updated");
            })
            .catch((error) => {
                cipherResolved = true;
                clearTimeout(cipherTimeout);
                console.log("Cipher breaker failed:", error?.message || error);
                updateBackendStatus("default (error)");
            });
    });
};

// --- CLEANUP ON EXIT ---
window.onbeforeunload = () => {
    if (App.lazyObserver) {
        App.lazyObserver.disconnect();
    }
    if (App.resizeHandler) {
        window.removeEventListener('resize', App.resizeHandler);
    }
    Player.cleanupEmbedResources();
};
})(window);
