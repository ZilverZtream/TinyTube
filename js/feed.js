(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const Utils = TinyTube.Utils;
    const el = TinyTube.el;

const Feed = {
    loadHome: async () => {
        const subs = TinyTube.DB.getSubs();
        if (subs.length === 0) {
            el("section-title").textContent = "Global Trending";
            return Feed.fetch("/trending");
        }
        el("section-title").textContent = `My Feed (${subs.length})`;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Building Feed...</p></div>';
        try {
            const results = await Utils.processQueue(subs, 3, async (sub) => {
                try {
                    const res = await Utils.fetchDedup(`${TinyTube.App.api}/channels/${sub.id}/videos?page=1`);
                    if (!res.ok) return [];
                    const data = await res.json();
                    return data.slice(0, 2);
                } catch { return []; }
            });
            const feed = [].concat(...results).sort((a, b) => b.published - a.published);
            if (feed.length < 10) {
                try {
                    const tr = await (await Utils.fetchDedup(`${TinyTube.App.api}/trending`)).json();
                    if (Array.isArray(tr)) feed.push(...tr.slice(0, 10));
                } catch {}
            }
            TinyTube.UI.renderGrid(feed);
        } catch { Feed.fetch("/trending"); }
    },
    fetch: async (endpoint) => {
        if (!TinyTube.App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div></div>';
        try {
            const res = await Utils.fetchDedup(`${TinyTube.App.api}${endpoint}`);
            if (!res.ok) throw new Error();
            const data = await res.json();
            const rendered = TinyTube.UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
            return { ok: true, hasItems: rendered };
        } catch {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Connection Failed</h3><p>Perditum may be busy.</p></div>';
            return { ok: false, hasItems: false };
        }
    },
    renderSubs: () => {
        el("section-title").textContent = "Subscriptions";
        const subs = TinyTube.DB.getSubs();
        TinyTube.UI.renderGrid(subs.map(s => ({
            type: "channel", author: s.name, authorId: s.id, authorThumbnails: [{url: s.thumb}]
        })));
    },
    // Channel Page View
    loadChannel: async (channelId, channelName) => {
        if (!channelId) return;
        TinyTube.App.currentChannelId = channelId;
        el("section-title").textContent = channelName || "Channel Videos";
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Loading channel...</p></div>';
        try {
            const res = await Utils.fetchDedup(`${TinyTube.App.api}/channels/${channelId}/videos?page=1`);
            if (!res.ok) throw new Error('Channel fetch failed');
            const data = await res.json();
            TinyTube.UI.renderGrid(Array.isArray(data) ? data : (data.videos || data.items || []));
        } catch (e) {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Failed to Load Channel</h3><p>Try again later.</p></div>';
        }
    },
    // Playlist Support
    loadPlaylist: async (playlistId, playlistTitle) => {
        if (!playlistId) return;
        TinyTube.App.currentPlaylistId = playlistId;
        el("section-title").textContent = playlistTitle || "Playlist";
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Loading playlist...</p></div>';
        try {
            const res = await Utils.fetchDedup(`${TinyTube.App.api}/playlists/${playlistId}`);
            if (!res.ok) throw new Error('Playlist fetch failed');
            const data = await res.json();
            TinyTube.UI.renderGrid(data.videos || data.items || []);
        } catch (e) {
            el("grid-container").innerHTML = '<div class="network-error"><h3>Failed to Load Playlist</h3><p>Try again later.</p></div>';
        }
    },
    // Trending Categories
    loadTrendingCategory: async (category) => {
        TinyTube.App.currentTrendingCategory = category;
        const title = category ? `Trending: ${category}` : "Trending";
        el("section-title").textContent = title;
        TrendingTabs.show();
        TrendingTabs.setActive(category);
        const endpoint = category ? `/trending?type=${category}` : '/trending';
        await Feed.fetch(endpoint);
    },
    // Watch Later View
    renderWatchLater: () => {
        el("section-title").textContent = "Watch Later";
        const queue = TinyTube.DB.getWatchLater();
        if (queue.length === 0) {
            el("grid-container").innerHTML = '<div class="empty-state"><div class="icon">⏰</div><h3>No Videos in Queue</h3><p>Add videos to watch later</p></div>';
            VirtualScroll.reset();
            return;
        }
        TinyTube.UI.renderGrid(queue.map(v => ({
            type: 'video',
            videoId: v.videoId,
            title: v.title,
            author: v.author,
            authorId: v.authorId,
            videoThumbnails: v.videoThumbnails,
            lengthSeconds: v.lengthSeconds
        })));
    },
    // Full History View
    renderHistory: () => {
        el("section-title").textContent = "Watch History";
        const history = TinyTube.DB.getFullHistory();
        if (history.length === 0) {
            el("grid-container").innerHTML = '<div class="empty-state"><div class="icon">🕐</div><h3>No History</h3><p>Your watched videos will appear here</p></div>';
            VirtualScroll.reset();
            return;
        }
        TinyTube.UI.renderGrid(history.map(h => ({
            type: 'video',
            videoId: h.videoId,
            title: h.title,
            author: h.author,
            authorId: h.authorId,
            videoThumbnails: h.videoThumbnails
        })));
    }
};

TinyTube.Feed = Feed;
})(window);
