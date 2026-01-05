(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const Utils = TinyTube.Utils;
    const SafeStorage = TinyTube.SafeStorage;
    const el = TinyTube.el;

const DB = {
    loadProfile: () => {
        TinyTube.App.profileId = parseInt(SafeStorage.getItem("tt_pid", "0"));
        const names = Utils.safeParse(SafeStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        el("p-name").textContent = names[TinyTube.App.profileId];
        el("modal-profile-id").textContent = `#${TinyTube.App.profileId + 1}`;
        el("profile-name-input").value = names[TinyTube.App.profileId];
        el("api-input").value = SafeStorage.getItem("customBase", "");
        el("max-res-select").value = Utils.getPreferredMaxResolution().toString();
        TinyTube.App.autoplayEnabled = SafeStorage.getItem("tt_autoplay") === "true";
        el("autoplay-toggle").checked = TinyTube.App.autoplayEnabled;
        TinyTube.App.subsCache = null;
        TinyTube.App.subsCacheId = null;
        TinyTube.App.watchHistory = Utils.safeParse(SafeStorage.getItem(`tt_history_${TinyTube.App.profileId}`), {});
    },
    saveProfileName: (name) => {
        const names = Utils.safeParse(SafeStorage.getItem("tt_pnames"), ["User 1", "User 2", "User 3"]);
        names[TinyTube.App.profileId] = name;
        SafeStorage.setItem("tt_pnames", JSON.stringify(names));
        DB.loadProfile();
    },
    getSubs: () => {
        if (TinyTube.App.subsCache && TinyTube.App.subsCacheId === TinyTube.App.profileId) return TinyTube.App.subsCache;
        TinyTube.App.subsCache = Utils.safeParse(SafeStorage.getItem(`tt_subs_${TinyTube.App.profileId}`), []);
        TinyTube.App.subsCacheId = TinyTube.App.profileId;
        return TinyTube.App.subsCache;
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
        SafeStorage.setItem(`tt_subs_${TinyTube.App.profileId}`, JSON.stringify(subs));
        TinyTube.App.subsCache = subs;
        if (TinyTube.App.view === "PLAYER") TinyTube.HUD.updateSubBadge(!exists);
        if (TinyTube.App.menuIdx === 1) TinyTube.Feed.renderSubs();
    },
    isSubbed: (id) => !!DB.getSubs().find(s => s.id === id),
    savePosition: (videoId, position, duration) => {
        if (!videoId || !position || position < 10) return;
        if (duration && position > duration - 10) {
            delete TinyTube.App.watchHistory[videoId];
        } else {
            TinyTube.App.watchHistory[videoId] = { pos: Math.floor(position), ts: Date.now() };
            const keys = Object.keys(TinyTube.App.watchHistory);
            if (keys.length > CONFIG.WATCH_HISTORY_LIMIT) {
                keys.sort((a, b) => TinyTube.App.watchHistory[a].ts - TinyTube.App.watchHistory[b].ts);
                for (let i = 0; i < keys.length - CONFIG.WATCH_HISTORY_LIMIT; i++) {
                    delete TinyTube.App.watchHistory[keys[i]];
                }
            }
        }
        const historyKey = `tt_history_${TinyTube.App.profileId}`;
        const saveResult = SafeStorage.setItem(historyKey, JSON.stringify(TinyTube.App.watchHistory));
        if (saveResult && saveResult.trimmedHistory && saveResult.trimmedKey === historyKey) {
            TinyTube.App.watchHistory = saveResult.trimmedHistory;
        }
    },
    getPosition: (videoId) => {
        if (!videoId || !TinyTube.App.watchHistory[videoId]) return 0;
        return TinyTube.App.watchHistory[videoId].pos || 0;
    },
    clearPosition: (videoId) => {
        if (videoId && TinyTube.App.watchHistory[videoId]) {
            delete TinyTube.App.watchHistory[videoId];
            SafeStorage.setItem(`tt_history_${TinyTube.App.profileId}`, JSON.stringify(TinyTube.App.watchHistory));
        }
    },
    // Watch Later Queue Functions
    getWatchLater: () => {
        if (TinyTube.App.watchLaterQueue && TinyTube.App.watchLaterQueue.length > 0) return TinyTube.App.watchLaterQueue;
        TinyTube.App.watchLaterQueue = Utils.safeParse(SafeStorage.getItem(`tt_watchlater_${TinyTube.App.profileId}`), []);
        return TinyTube.App.watchLaterQueue;
    },
    addToWatchLater: (item) => {
        if (!item || !item.videoId) return;
        const queue = DB.getWatchLater();
        const exists = queue.find(v => v.videoId === item.videoId);
        if (exists) {
            Utils.toast("Already in Watch Later");
            return;
        }
        const videoData = {
            videoId: item.videoId,
            title: item.title,
            author: item.author,
            authorId: item.authorId,
            videoThumbnails: item.videoThumbnails,
            lengthSeconds: item.lengthSeconds,
            addedAt: Date.now()
        };
        queue.unshift(videoData);
        if (queue.length > CONFIG.WATCH_LATER_LIMIT) {
            queue.pop();
        }
        TinyTube.App.watchLaterQueue = queue;
        SafeStorage.setItem(`tt_watchlater_${TinyTube.App.profileId}`, JSON.stringify(queue));
        Utils.toast("Added to Watch Later");
    },
    removeFromWatchLater: (videoId) => {
        if (!videoId) return;
        const queue = DB.getWatchLater();
        TinyTube.App.watchLaterQueue = queue.filter(v => v.videoId !== videoId);
        SafeStorage.setItem(`tt_watchlater_${TinyTube.App.profileId}`, JSON.stringify(TinyTube.App.watchLaterQueue));
        Utils.toast("Removed from Watch Later");
    },
    isInWatchLater: (videoId) => {
        const queue = DB.getWatchLater();
        return !!queue.find(v => v.videoId === videoId);
    },
    // Full History View Functions
    getFullHistory: () => {
        if (!TinyTube.App.watchHistory) {
            TinyTube.App.watchHistory = Utils.safeParse(SafeStorage.getItem(`tt_history_${TinyTube.App.profileId}`), {});
        }
        const history = [];
        for (const videoId in TinyTube.App.watchHistory) {
            const entry = TinyTube.App.watchHistory[videoId];
            if (entry && entry.ts) {
                history.push({
                    videoId: videoId,
                    position: entry.pos || 0,
                    timestamp: entry.ts,
                    title: entry.title || 'Unknown Video',
                    author: entry.author || 'Unknown',
                    authorId: entry.authorId || '',
                    videoThumbnails: entry.videoThumbnails || []
                });
            }
        }
        history.sort((a, b) => b.timestamp - a.timestamp);
        return history.slice(0, CONFIG.HISTORY_VIEW_LIMIT);
    },
    saveVideoToHistory: (videoId, videoData) => {
        if (!videoId || !TinyTube.App.watchHistory[videoId]) return;
        TinyTube.App.watchHistory[videoId].title = videoData.title || TinyTube.App.watchHistory[videoId].title;
        TinyTube.App.watchHistory[videoId].author = videoData.author || TinyTube.App.watchHistory[videoId].author;
        TinyTube.App.watchHistory[videoId].authorId = videoData.authorId || TinyTube.App.watchHistory[videoId].authorId;
        TinyTube.App.watchHistory[videoId].videoThumbnails = videoData.videoThumbnails || TinyTube.App.watchHistory[videoId].videoThumbnails;
        SafeStorage.setItem(`tt_history_${TinyTube.App.profileId}`, JSON.stringify(TinyTube.App.watchHistory));
    }
};

TinyTube.DB = DB;
})(window);
