(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const Utils = TinyTube.Utils;
    const el = TinyTube.el;
    const TrendingTabs = TinyTube.TrendingTabs;
    const VirtualScroll = TinyTube.VirtualScroll;

const Feed = {
    loadHome: () => {
        const subs = TinyTube.DB.getSubs();
        if (subs.length === 0) {
            el("section-title").textContent = "Global Trending";
            return Feed.fetch("/trending");
        }
        el("section-title").textContent = `My Feed (${subs.length})`;
        TinyTube.CardPool.releaseAll(el("grid-container"));
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Building Feed...</p></div>';
        return Utils.processQueue(subs, 3, (sub) => {
            return Utils.fetchDedup(`${TinyTube.App.api}/channels/${sub.id}/videos?page=1`)
                .then(res => {
                    if (!res.ok) return [];
                    return res.json().then(data => data.slice(0, 2));
                })
                .catch(() => []);
        })
            .then(results => {
                const feed = [].concat(...results).sort((a, b) => b.published - a.published);
                if (feed.length < 10) {
                    return Utils.fetchDedup(`${TinyTube.App.api}/trending`)
                        .then(res => res.json())
                        .then(tr => {
                            if (Array.isArray(tr)) feed.push(...tr.slice(0, 10));
                            return feed;
                        })
                        .catch(() => feed);
                }
                return feed;
            })
            .then(feed => {
                TinyTube.UI.renderGrid(feed);
            })
            .catch(() => Feed.fetch("/trending"));
    },
    fetch: (endpoint) => {
        if (!TinyTube.App.api) return;
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div></div>';
        return Utils.fetchDedup(`${TinyTube.App.api}${endpoint}`)
            .then(res => {
                if (!res.ok) throw new Error();
                return res.json();
            })
            .then(data => {
                const rendered = TinyTube.UI.renderGrid(Array.isArray(data) ? data : (data.items || []));
                return { ok: true, hasItems: rendered };
            })
            .catch(() => {
                el("grid-container").innerHTML = '<div class="network-error"><h3>Connection Failed</h3><p>Perditum may be busy.</p></div>';
                return { ok: false, hasItems: false };
            });
    },
    renderSubs: () => {
        el("section-title").textContent = "Subscriptions";
        const subs = TinyTube.DB.getSubs();
        TinyTube.UI.renderGrid(subs.map(s => ({
            type: "channel", author: s.name, authorId: s.id, authorThumbnails: [{url: s.thumb}]
        })));
    },
    // Channel Page View
    loadChannel: (channelId, channelName) => {
        if (!channelId) return;
        TinyTube.App.currentChannelId = channelId;
        el("section-title").textContent = channelName || "Channel Videos";
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Loading channel...</p></div>';
        return Utils.fetchDedup(`${TinyTube.App.api}/channels/${channelId}/videos?page=1`)
            .then(res => {
                if (!res.ok) throw new Error('Channel fetch failed');
                return res.json();
            })
            .then(data => {
                TinyTube.UI.renderGrid(Array.isArray(data) ? data : (data.videos || data.items || []));
            })
            .catch(() => {
                el("grid-container").innerHTML = '<div class="network-error"><h3>Failed to Load Channel</h3><p>Try again later.</p></div>';
            });
    },
    // Playlist Support
    loadPlaylist: (playlistId, playlistTitle) => {
        if (!playlistId) return;
        TinyTube.App.currentPlaylistId = playlistId;
        el("section-title").textContent = playlistTitle || "Playlist";
        el("grid-container").innerHTML = '<div class="loading-spinner"><div class="spinner-icon"></div><p>Loading playlist...</p></div>';
        return Utils.fetchDedup(`${TinyTube.App.api}/playlists/${playlistId}`)
            .then(res => {
                if (!res.ok) throw new Error('Playlist fetch failed');
                return res.json();
            })
            .then(data => {
                TinyTube.UI.renderGrid(data.videos || data.items || []);
            })
            .catch(() => {
                el("grid-container").innerHTML = '<div class="network-error"><h3>Failed to Load Playlist</h3><p>Try again later.</p></div>';
            });
    },
    // Trending Categories
    loadTrendingCategory: (category) => {
        TinyTube.App.currentTrendingCategory = category;
        const title = category ? `Trending: ${category}` : "Trending";
        el("section-title").textContent = title;
        TrendingTabs.show();
        TrendingTabs.setActive(category);
        const endpoint = category ? `/trending?type=${category}` : '/trending';
        return Feed.fetch(endpoint);
    },
    // Watch Later View
    renderWatchLater: () => {
        el("section-title").textContent = "Watch Later";
        const queue = TinyTube.DB.getWatchLater();
        if (queue.length === 0) {
            el("grid-container").innerHTML = '<div class="empty-state"><div class="icon">⏰</div><h3>No Videos in Queue</h3><p>Add videos to watch later</p></div>';
            if (TinyTube.VirtualScroll && TinyTube.VirtualScroll.reset) {
                TinyTube.VirtualScroll.reset();
            }
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
            if (TinyTube.VirtualScroll && TinyTube.VirtualScroll.reset) {
                TinyTube.VirtualScroll.reset();
            }
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
