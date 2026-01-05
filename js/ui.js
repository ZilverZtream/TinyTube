(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const el = TinyTube.el;

const CardPool = {
    videoPool: [],
    channelPool: [],
    init: function() {
        this.videoPool = [];
        this.channelPool = [];
    },
    getVideo: function() {
        return this.videoPool.pop() || null;
    },
    getChannel: function() {
        return this.channelPool.pop() || null;
    },
    release: function(element, skipFocus = false) {
        if (!element) return;

        const activeElement = document.activeElement;
        const isActive = activeElement && (activeElement === element || element.contains(activeElement));

        // Rescue focus for active cards even when skipFocus is true.
        if (isActive) {
            const grid = el("grid-container");
            let fallback = null;
            if (grid) {
                if (!skipFocus) {
                    fallback = element.nextElementSibling || element.previousElementSibling;
                }
                if (!fallback || !fallback.matches('.video-card, .channel-card')) {
                    fallback = grid.querySelector('.video-card, .channel-card');
                }
            }

            if (fallback) {
                const idParts = fallback.id ? fallback.id.split('-') : [];
                const idx = parseInt(idParts[1], 10);
                TinyTube.App.focus.area = "grid";
                TinyTube.App.focus.index = Number.isNaN(idx) ? 0 : idx;
                if (typeof fallback.focus === "function") {
                    fallback.focus();
                }
                UI.updateFocus();
            } else {
                const menuHome = el("menu-home");
                if (menuHome) {
                    TinyTube.App.focus.area = "menu";
                    TinyTube.App.menuIdx = 0;
                    if (typeof menuHome.focus === "function") {
                        menuHome.focus();
                    }
                    UI.updateFocus();
                }
            }
        }

        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
        // Clean up element without destroying template structure
        element.classList.remove('focused');
        element.classList.remove('focused-btn');
        element.id = '';
        element.removeAttribute('style');

        // FIX: Reset image display state to prevent "Invisible Thumbnail" bug
        // When handleImgError sets display:none, it persists across card reuse
        const img = element.querySelector('img');
        if (img) {
            // FIX: Stop observing detached images to prevent observer leak
            // Chrome 56 (Tizen 4.0) can leak memory on detached observed nodes
            if (TinyTube.App.lazyObserver && TinyTube.App.lazyObserver.unobserve) {
                TinyTube.App.lazyObserver.unobserve(img);
            }
            img.style.display = ''; // Clear any display:none from error handler
            img.onerror = null;      // Clear old error handlers
            img.src = 'default.png';    // Reset to placeholder
            img.removeAttribute('data-src'); // Clear lazy-load marker
        }

        const isChannel = element.classList.contains('channel-card');
        element.dataset.poolType = isChannel ? 'channel' : 'video';
        // Return to pool if under limit
        const totalPoolSize = this.videoPool.length + this.channelPool.length;
        if (totalPoolSize < CONFIG.CARD_POOL_SIZE) {
            if (isChannel) {
                this.channelPool.push(element);
            } else {
                this.videoPool.push(element);
            }
        }
    },
    releaseAll: function(container) {
        if (!container) return;

        // FIX: Detect if any card currently has focus BEFORE the loop
        const activeElement = document.activeElement;
        let needsFocusRestore = false;
        const cards = container.querySelectorAll('.video-card, .channel-card');

        // Check if focus is on any card we're about to release
        cards.forEach(card => {
            if (activeElement && (activeElement === card || card.contains(activeElement))) {
                needsFocusRestore = true;
            }
        });

        // Release all cards WITHOUT moving focus (skip focus handling)
        cards.forEach(card => this.release(card, true));

        // AFTER the loop, restore focus once to prevent 50+ reflows
        if (needsFocusRestore) {
            const grid = el("grid-container");
            const remainingCard = grid ? grid.querySelector('.video-card, .channel-card') : null;

            if (remainingCard) {
                const idParts = remainingCard.id ? remainingCard.id.split('-') : [];
                const idx = parseInt(idParts[1], 10);
                TinyTube.App.focus.area = "grid";
                TinyTube.App.focus.index = Number.isNaN(idx) ? 0 : idx;
                if (typeof remainingCard.focus === "function") {
                    remainingCard.focus();
                }
                UI.updateFocus();
            } else {
                const menuHome = el("menu-home");
                if (menuHome) {
                    TinyTube.App.focus.area = "menu";
                    TinyTube.App.menuIdx = 0;
                    if (typeof menuHome.focus === "function") {
                        menuHome.focus();
                    }
                    UI.updateFocus();
                }
            }
        }
    }
};

// --- VIRTUAL SCROLL MANAGER ---
const VirtualScroll = {
    enabled: CONFIG.VIRTUAL_SCROLL_ENABLED,
    visibleStart: 0,
    visibleEnd: 0,
    totalItems: 0,
    itemHeight: 0,
    containerHeight: 0,
    itemsPerRow: 1,
    onRangeChange: null,
    scrollHandler: null,
    scrollRAFPending: false,

    getItemsPerRow: function(container) {
        let itemsPerRow = 4; // Fallback default
        if (!container) return itemsPerRow;

        const firstCard = container.querySelector('.video-card, .channel-card');
        if (firstCard && container.clientWidth > 0) {
            const cardWidth = firstCard.offsetWidth;
            if (cardWidth > 0) {
                itemsPerRow = Math.floor(container.clientWidth / cardWidth);
            }
        }
        // Ensure at least 1 card per row
        if (itemsPerRow < 1) itemsPerRow = 1;
        return itemsPerRow;
    },

    init: function() {
        const container = document.getElementById('grid-container');
        if (!container) return;

        // Remove existing scroll handler if any
        if (this.scrollHandler) {
            container.removeEventListener('scroll', this.scrollHandler);
        }

        // FIX: Use RAF lock instead of throttle to prevent double-queuing
        // (throttle uses setTimeout, updateVisible uses RAF - this caused 1-2 frame lag)
        this.scrollHandler = () => {
            if (!this.scrollRAFPending) {
                this.scrollRAFPending = true;
                requestAnimationFrame(() => {
                    this.updateVisible();
                    this.scrollRAFPending = false;
                });
            }
        };
        container.addEventListener('scroll', this.scrollHandler, { passive: true });
    },

    calculateVisible: function() {
        const container = document.getElementById('grid-container');
        if (!container || !this.enabled) return { start: 0, end: this.totalItems };

        const scrollTop = container.scrollTop;
        this.containerHeight = container.clientHeight;

        // FIX: Calculate itemsPerRow dynamically instead of hardcoding to 4
        // This prevents "pop-in" glitches if CSS changes (responsive layouts, 4K screens)
        this.itemsPerRow = this.getItemsPerRow(container);
        const firstCard = container.querySelector('.video-card, .channel-card');

        // Estimate card height (thumbnail + meta, roughly 250px)
        if (this.itemHeight === 0 && firstCard) {
            this.itemHeight = firstCard.offsetHeight + 25; // +25 for margin
        } else if (this.itemHeight === 0) {
            this.itemHeight = 275; // Fallback
        }

        const rowHeight = this.itemHeight;
        const visibleRows = Math.ceil(this.containerHeight / rowHeight);
        const currentRow = Math.floor(scrollTop / rowHeight);

        const bufferRows = Math.ceil(CONFIG.VIRTUAL_SCROLL_BUFFER / this.itemsPerRow);
        const startRow = Math.max(0, currentRow - bufferRows);
        const endRow = Math.min(
            Math.ceil(this.totalItems / this.itemsPerRow),
            currentRow + visibleRows + bufferRows
        );

        return {
            start: startRow * this.itemsPerRow,
            end: Math.min(endRow * this.itemsPerRow, this.totalItems)
        };
    },

    ensureSpacers: function(container) {
        if (!container) return { topSpacer: null, bottomSpacer: null };
        let topSpacer = container.querySelector('.vs-top-spacer');
        if (!topSpacer) {
            topSpacer = document.createElement('div');
            topSpacer.className = 'vs-top-spacer';
            container.insertBefore(topSpacer, container.firstChild);
        }
        let bottomSpacer = container.querySelector('.vs-bottom-spacer');
        if (!bottomSpacer) {
            bottomSpacer = document.createElement('div');
            bottomSpacer.className = 'vs-bottom-spacer';
            container.appendChild(bottomSpacer);
        }
        return { topSpacer, bottomSpacer };
    },

    updateVisible: function() {
        if (!this.enabled) return;
        const container = document.getElementById('grid-container');
        if (!container) return;
        const { start, end } = this.calculateVisible();
        const prevStart = this.visibleStart;
        const prevEnd = this.visibleEnd;

        // Only update if range changed significantly
        if (Math.abs(start - this.visibleStart) < 4 && Math.abs(end - this.visibleEnd) < 4) {
            return;
        }

        this.visibleStart = start;
        this.visibleEnd = end;

        if (typeof this.onRangeChange === "function") {
            this.onRangeChange({ start, end, prevStart, prevEnd });
        }

        const { topSpacer, bottomSpacer } = this.ensureSpacers(container);
        const totalRows = Math.ceil(this.totalItems / this.itemsPerRow);
        const startRow = Math.floor(start / this.itemsPerRow);
        const endRow = Math.ceil(end / this.itemsPerRow);
        const topHeight = startRow * this.itemHeight;
        const bottomHeight = Math.max(0, totalRows - endRow) * this.itemHeight;

        if (topSpacer) topSpacer.style.height = `${topHeight}px`;
        if (bottomSpacer) bottomSpacer.style.height = `${bottomHeight}px`;

        // Re-render visible range
        UI.renderVisibleRange(start, end);
    },

    reset: function() {
        this.visibleStart = 0;
        this.visibleEnd = 0;
        this.totalItems = 0;
        this.itemHeight = 0;
    }
};

const UI = {
    cacheCommonElements: () => {
        // Cache frequently accessed DOM elements for performance
        TinyTube.App.cachedElements = {
            'toast': el('toast'),
            'sidebar': el('sidebar'),
            'grid-container': el('grid-container'),
            'search-input': el('search-input'),
            'player-layer': el('player-layer'),
            'player-hud': el('player-hud'),
            'section-title': el('section-title'),
            'video-info-overlay': el('video-info-overlay'),
            'captions-overlay': el('captions-overlay'),
            'enforcement-container': el('enforcement-container'),
            'settings-overlay': el('settings-overlay')
        };

        // Cache DOM templates for fast cloning (40% faster rendering)
        const videoTemplate = document.getElementById('video-card-template');
        const channelTemplate = document.getElementById('channel-card-template');
        if (videoTemplate) TinyTube.App.videoCardTemplate = videoTemplate.content.firstElementChild;
        if (channelTemplate) TinyTube.App.channelCardTemplate = channelTemplate.content.firstElementChild;
    },
    initLazyObserver: () => {
        if ("IntersectionObserver" in window) {
            TinyTube.App.lazyObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        if (img.dataset.src) {
                            img.src = img.dataset.src;
                            img.removeAttribute("data-src");
                            TinyTube.App.lazyObserver.unobserve(img);
                        }
                    }
                });
            }, { rootMargin: `${CONFIG.LAZY_OBSERVER_MARGIN_PX}px` });
        } else {
            // Fallback for Chromium 56 (Tizen 4) - use scroll-based lazy loading
            const container = el("grid-container");
            if (!container) return;

            const loadVisibleImages = () => {
                const images = container.querySelectorAll('img[data-src]');
                const containerRect = container.getBoundingClientRect();

                images.forEach(img => {
                    const rect = img.getBoundingClientRect();
                    // Check if image is within viewport + margin
                    const inView = (
                        rect.top < containerRect.bottom + CONFIG.LAZY_OBSERVER_MARGIN_PX &&
                        rect.bottom > containerRect.top - CONFIG.LAZY_OBSERVER_MARGIN_PX
                    );

                    if (inView && img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute("data-src");
                    }
                });
            };

            // Throttled scroll handler for fallback lazy loading
            const throttledLoad = TinyTube.Utils.throttle(loadVisibleImages, 100);
            container.addEventListener('scroll', throttledLoad, { passive: true });

            // Store cleanup reference
            TinyTube.App.lazyObserver = {
                observe: () => {}, // Noop for compatibility
                disconnect: () => {
                    container.removeEventListener('scroll', throttledLoad);
                }
            };

            // Initial load
            setTimeout(loadVisibleImages, 100);
        }
    },
    // FIX: Named function to prevent closure memory leaks
    handleImgError: (e) => {
        const img = e.target;
        if (img.dataset.fallback === "1") {
            img.onerror = null;
            img.style.display = "none";
            return;
        }
        img.dataset.fallback = "1";
        img.src = "default.png";
    },
    renderGrid: (data) => {
        const items = (data || [])
            .map((item) => {
                if (!item || item.type) return item;
                let inferredType = null;
                if (item.videoId || item.videoThumbnails) {
                    inferredType = "video";
                } else if (item.authorId && item.authorThumbnails) {
                    inferredType = "channel";
                } else if (item.playlistId || item.videos) {
                    inferredType = "playlist";
                }
                return inferredType ? { ...item, type: inferredType } : item;
            })
            .filter(item => item && ["video", "channel", "shortVideo", "playlist"].includes(item.type));
        TinyTube.App.items = items;
        const grid = el("grid-container");
        if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.disconnect();

        // Release old cards to pool
        CardPool.releaseAll(grid);
        grid.textContent = "";

        for (const key in TinyTube.App.pendingDeArrow) {
            const op = TinyTube.App.pendingDeArrow[key];
            if (op && op.timer) clearTimeout(op.timer);
            if (op) op.cancelled = true;
            delete TinyTube.App.pendingDeArrow[key];
        }
        if (TinyTube.App.items.length === 0) {
            grid.innerHTML = '<div class="empty-state"><h3>No Results</h3></div>';
            VirtualScroll.reset();
            return false;
        }

        // Setup virtual scrolling
        VirtualScroll.totalItems = TinyTube.App.items.length;
        if (CONFIG.VIRTUAL_SCROLL_ENABLED && TinyTube.App.items.length > 20) {
            VirtualScroll.enabled = true;
            VirtualScroll.init();
            VirtualScroll.visibleStart = -1;
            VirtualScroll.visibleEnd = -1;
            VirtualScroll.updateVisible();
        } else {
            VirtualScroll.enabled = false;
            const topSpacer = grid.querySelector('.vs-top-spacer');
            const bottomSpacer = grid.querySelector('.vs-bottom-spacer');
            if (topSpacer) topSpacer.remove();
            if (bottomSpacer) bottomSpacer.remove();
            UI.renderVisibleRange(0, TinyTube.App.items.length); // Render all
        }

        if (TinyTube.App.focus.area !== "search" && TinyTube.App.focus.area !== "settings") {
            TinyTube.App.focus = { area: "grid", index: 0 };

            // FIX: Defer focus update to match the rAF in renderVisibleRange
            // Double defer to ensure DOM paint has occurred
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    UI.updateFocus();
                });
            });
        }
        return true;
    },
    renderVisibleRange: (start, end) => {
        const grid = el("grid-container");
        if (!grid) return;

        // Use requestAnimationFrame for smooth rendering
        requestAnimationFrame(() => {
            const frag = document.createDocumentFragment();
            const useLazy = TinyTube.App.lazyObserver !== null;
            let bottomSpacer = null;

            if (VirtualScroll.enabled) {
                const spacers = VirtualScroll.ensureSpacers(grid);
                bottomSpacer = spacers.bottomSpacer;
            }

            // Get existing cards to check what needs updating
            const existingCards = new Set();
            if (VirtualScroll.enabled) {
                const currentCards = grid.querySelectorAll('[id^="card-"]');
                currentCards.forEach(card => {
                    const idx = parseInt(card.id.split('-')[1], 10);
                    if (idx < start || idx >= end) {
                        // FIX: Skip focus handling during scroll to prevent micro-stutters
                        // Large scroll jumps (Page Down) can release 16+ cards at once
                        // Focus recalculation should happen AFTER the scroll completes
                        CardPool.release(card, true);
                    } else {
                        existingCards.add(idx);
                    }
                });
            }

            for (let idx = start; idx < end && idx < TinyTube.App.items.length; idx++) {
                // Skip if card already exists in visible range
                if (existingCards.has(idx)) continue;

                const item = TinyTube.App.items[idx];
                const isChannel = item.type === "channel";
                let div = isChannel ? CardPool.getChannel() : CardPool.getVideo();

                // DOM Template Cloning: 40% faster than createElement
                if (item.type === "channel" && TinyTube.App.channelCardTemplate) {
                    if (!div) {
                        div = TinyTube.App.channelCardTemplate.cloneNode(true);
                    }
                    div.classList.add("channel-card");
                    div.classList.remove("video-card");
                    div.dataset.poolType = "channel";
                    div.id = `card-${idx}`;

                    let thumbUrl = "default.png";
                    if (item.authorThumbnails && item.authorThumbnails[0]) thumbUrl = item.authorThumbnails[0].url;

                    const img = div.querySelector('.c-avatar');
                    if (img) {
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else {
                            img.src = thumbUrl;
                            img.removeAttribute("data-src");
                        }
                    }

                    const h3 = div.querySelector('h3');
                    if (h3) h3.textContent = item.author || '';

                    let subTag = div.querySelector('.sub-tag');
                    const isSubbed = TinyTube.DB.isSubbed(item.authorId);
                    if (isSubbed) {
                        if (!subTag) {
                            subTag = TinyTube.Utils.create("div", "sub-tag", "SUBSCRIBED");
                            div.appendChild(subTag);
                        }
                        subTag.classList.remove("hidden");
                    } else if (subTag) {
                        subTag.classList.add("hidden");
                    }
                } else if (item.type === "playlist" && TinyTube.App.videoCardTemplate) {
                    if (!div) {
                        div = TinyTube.App.videoCardTemplate.cloneNode(true);
                    }
                    div.classList.add("video-card", "playlist-card");
                    div.classList.remove("channel-card");
                    div.dataset.poolType = "video";
                    div.id = `card-${idx}`;

                    let thumbUrl = "default.png";
                    if (item.playlistThumbnail) thumbUrl = item.playlistThumbnail;
                    else if (item.playlistThumbnailUrl) thumbUrl = item.playlistThumbnailUrl;
                    else if (item.thumbnail) thumbUrl = item.thumbnail;
                    else if (item.videoThumbnails && item.videoThumbnails[0]) thumbUrl = item.videoThumbnails[0].url;

                    const img = div.querySelector('.thumb');
                    if (img) {
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else {
                            img.src = thumbUrl;
                            img.removeAttribute("data-src");
                        }
                    }

                    const durationBadge = div.querySelector('.duration-badge');
                    const rawCount = item.videoCount ?? item.itemCount ?? item.videoCountText ?? (Array.isArray(item.videos) ? item.videos.length : null);
                    let countText = "";
                    if (typeof rawCount === "number") countText = `${rawCount} videos`;
                    else if (typeof rawCount === "string") countText = rawCount;
                    if (durationBadge) {
                        if (countText) {
                            durationBadge.textContent = countText;
                            durationBadge.classList.remove("hidden");
                        } else {
                            durationBadge.textContent = "";
                            durationBadge.classList.add("hidden");
                        }
                    }

                    const liveBadge = div.querySelector('.live-badge');
                    if (liveBadge) liveBadge.classList.add("hidden");

                    const resumeBadge = div.querySelector('.resume-badge');
                    if (resumeBadge) resumeBadge.classList.add("hidden");

                    const h3 = div.querySelector('h3');
                    if (h3) {
                        h3.textContent = item.title || '';
                        h3.id = `title-${idx}`;
                    }

                    const p = div.querySelector('p');
                    if (p) {
                        let info = item.author || "";
                        if (countText) info += (info ? " • " : "") + countText;
                        p.textContent = info;
                    }
                } else if (TinyTube.App.videoCardTemplate) {
                    if (!div) {
                        div = TinyTube.App.videoCardTemplate.cloneNode(true);
                    }
                    div.classList.add("video-card");
                    div.classList.remove("playlist-card");
                    div.classList.remove("channel-card");
                    div.dataset.poolType = "video";
                    div.id = `card-${idx}`;

                    let thumbUrl = "default.png";
                    if (item.videoThumbnails && item.videoThumbnails[0]) thumbUrl = item.videoThumbnails[0].url;
                    else if (item.thumbnail) thumbUrl = item.thumbnail;

                    const img = div.querySelector('.thumb');
                    if (img) {
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else {
                            img.src = thumbUrl;
                            img.removeAttribute("data-src");
                        }
                    }

                    const durationBadge = div.querySelector('.duration-badge');
                    if (durationBadge) {
                        if (item.lengthSeconds) {
                            durationBadge.textContent = TinyTube.Utils.formatTime(item.lengthSeconds);
                            durationBadge.classList.remove("hidden");
                        } else {
                            durationBadge.textContent = "";
                            durationBadge.classList.add("hidden");
                        }
                    }

                    const liveBadge = div.querySelector('.live-badge');
                    if (liveBadge) {
                        if (item.liveNow) {
                            liveBadge.classList.remove("hidden");
                        } else {
                            liveBadge.classList.add("hidden");
                        }
                    }

                    const resumeBadge = div.querySelector('.resume-badge');
                    if (resumeBadge) {
                        const vId = TinyTube.Utils.getVideoId(item);
                        const savedPos = vId ? TinyTube.DB.getPosition(vId) : 0;
                        if (savedPos > 0) {
                            resumeBadge.textContent = TinyTube.Utils.formatTime(savedPos);
                            resumeBadge.classList.remove("hidden");
                        } else {
                            resumeBadge.textContent = "";
                            resumeBadge.classList.add("hidden");
                        }
                    }

                    const h3 = div.querySelector('h3');
                    if (h3) {
                        h3.textContent = item.title || '';
                        h3.id = `title-${idx}`;
                    }

                    const p = div.querySelector('p');
                    if (p) {
                        let info = item.author || "";
                        if (item.viewCount) info += (info ? " • " : "") + TinyTube.Utils.formatViews(item.viewCount);
                        if (item.published) info += (info ? " • " : "") + TinyTube.Utils.formatDate(item.published);
                        p.textContent = info;
                    }
                } else {
                    // Fallback to old method if templates not loaded
                    div = div || (isChannel ? CardPool.getChannel() : CardPool.getVideo());
                    if (!div) div = document.createElement("div");

                    div.textContent = "";
                    div.className = isChannel ? "channel-card" : "video-card";
                    div.id = `card-${idx}`;
                    div.dataset.poolType = isChannel ? "channel" : "video";

                    let thumbUrl = "default.png";
                    if (item.videoThumbnails && item.videoThumbnails[0]) thumbUrl = item.videoThumbnails[0].url;
                    else if (item.thumbnail) thumbUrl = item.thumbnail;
                    else if (item.authorThumbnails && item.authorThumbnails[0]) thumbUrl = item.authorThumbnails[0].url;

                    if (item.type === "channel") {
                        const img = TinyTube.Utils.create("img", "c-avatar");
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else { img.src = thumbUrl; }
                        div.appendChild(img);
                        div.appendChild(TinyTube.Utils.create("h3", null, item.author));
                        if (TinyTube.DB.isSubbed(item.authorId)) div.appendChild(TinyTube.Utils.create("div", "sub-tag", "SUBSCRIBED"));
                    } else if (item.type === "playlist") {
                        div.classList.add("playlist-card");
                        const tc = TinyTube.Utils.create("div", "thumb-container");
                        const img = TinyTube.Utils.create("img", "thumb");
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else { img.src = thumbUrl; }
                        tc.appendChild(img);
                        const rawCount = item.videoCount ?? item.itemCount ?? item.videoCountText ?? (Array.isArray(item.videos) ? item.videos.length : null);
                        let countText = "";
                        if (typeof rawCount === "number") countText = `${rawCount} videos`;
                        else if (typeof rawCount === "string") countText = rawCount;
                        if (countText) tc.appendChild(TinyTube.Utils.create("span", "duration-badge", countText));
                        div.appendChild(tc);
                        const meta = TinyTube.Utils.create("div", "meta");
                        const h3 = TinyTube.Utils.create("h3", null, item.title);
                        h3.id = `title-${idx}`;
                        meta.appendChild(h3);
                        let info = item.author || "";
                        if (countText) info += (info ? " • " : "") + countText;
                        meta.appendChild(TinyTube.Utils.create("p", null, info));
                        div.appendChild(meta);
                    } else {
                        const tc = TinyTube.Utils.create("div", "thumb-container");
                        const img = TinyTube.Utils.create("img", "thumb");
                        img.onerror = UI.handleImgError;
                        if (useLazy && idx > 7) {
                            img.dataset.src = thumbUrl;
                            img.src = "default.png";
                            if (TinyTube.App.lazyObserver) TinyTube.App.lazyObserver.observe(img);
                        } else { img.src = thumbUrl; }
                        tc.appendChild(img);
                        if (item.lengthSeconds) tc.appendChild(TinyTube.Utils.create("span", "duration-badge", TinyTube.Utils.formatTime(item.lengthSeconds)));
                        if (item.liveNow) tc.appendChild(TinyTube.Utils.create("span", "live-badge", "LIVE"));
                        const vId = TinyTube.Utils.getVideoId(item);
                        const savedPos = vId ? TinyTube.DB.getPosition(vId) : 0;
                        if (savedPos > 0) tc.appendChild(TinyTube.Utils.create("span", "resume-badge", TinyTube.Utils.formatTime(savedPos)));
                        div.appendChild(tc);
                        const meta = TinyTube.Utils.create("div", "meta");
                        const h3 = TinyTube.Utils.create("h3", null, item.title);
                        h3.id = `title-${idx}`;
                        meta.appendChild(h3);
                        let info = item.author || "";
                        if (item.viewCount) info += (info ? " • " : "") + TinyTube.Utils.formatViews(item.viewCount);
                        if (item.published) info += (info ? " • " : "") + TinyTube.Utils.formatDate(item.published);
                        meta.appendChild(TinyTube.Utils.create("p", null, info));
                        div.appendChild(meta);
                    }
                }
                frag.appendChild(div);
            }

            // Only clear grid if NOT using virtual scrolling
            if (!VirtualScroll.enabled) {
                CardPool.releaseAll(grid);
                grid.textContent = "";
            }
            if (VirtualScroll.enabled && bottomSpacer) {
                grid.insertBefore(frag, bottomSpacer);
            } else {
                grid.appendChild(frag);
            }

            if (TinyTube.App.focus.area === "grid" && end > start) {
                let focusIndex = TinyTube.App.focus.index;
                let focusCard = el(`card-${focusIndex}`);
                if (!focusCard) {
                    const clampedIndex = TinyTube.Utils.clamp(focusIndex, start, end - 1);
                    if (clampedIndex !== focusIndex) {
                        TinyTube.App.focus.index = clampedIndex;
                        focusIndex = clampedIndex;
                    }
                    focusCard = el(`card-${focusIndex}`);
                }

                if (focusCard && (!TinyTube.App.lastFocused || TinyTube.App.lastFocused.id !== focusCard.id)) {
                    requestAnimationFrame(() => {
                        UI.updateFocus();
                    });
                }
            }
        });
    },
    updateFocus: () => {
        if (TinyTube.App.lastFocused) {
            TinyTube.App.lastFocused.classList.remove("focused");
            TinyTube.App.lastFocused.classList.remove("focused-btn");
        }
        TinyTube.App.lastFocused = null;
        if (TinyTube.App.focus.area === "menu") {
            const menuItem = el(TinyTube.App.menuIds[TinyTube.App.menuIdx]);
            if (menuItem) {
                menuItem.classList.add("focused");
                TinyTube.App.lastFocused = menuItem;
            }
        } else if (TinyTube.App.focus.area === "grid") {
            const card = el(`card-${TinyTube.App.focus.index}`);
            if (card) {
                card.classList.add("focused");
                TinyTube.App.lastFocused = card;
                try {
                    if (TinyTube.App.supportsSmoothScroll) card.scrollIntoView({ block: "center", behavior: "smooth" });
                    else card.scrollIntoView(false);
                } catch {
                    TinyTube.App.supportsSmoothScroll = false;
                    card.scrollIntoView(false);
                }
                const item = TinyTube.App.items[TinyTube.App.focus.index];
                if (item && item.type !== "channel" && !item.deArrowChecked) UI.fetchDeArrow(item, TinyTube.App.focus.index);
            }
        } else if (TinyTube.App.focus.area === "search") {
            const searchInput = el("search-input");
            if (searchInput) {
                searchInput.classList.add("focused");
                TinyTube.App.lastFocused = searchInput;
            }
        } else if (TinyTube.App.focus.area === "settings") {
            const saveBtn = el("save-btn");
            if (saveBtn) {
                saveBtn.classList.add("focused-btn");
                TinyTube.App.lastFocused = saveBtn;
            }
        }
        if (TinyTube.App.view === "PLAYER" && TinyTube.App.activeLayer === "CONTROLS") {
            TinyTube.PlayerControls.updateFocus();
        }
    },
    fetchDeArrow: (item, idx) => {
        item.deArrowChecked = true;
        const vId = TinyTube.Utils.getVideoId(item);
        if (!vId) return;
        if (TinyTube.App.deArrowCache.has(vId)) { UI.applyDeArrow(TinyTube.App.deArrowCache.get(vId), idx, vId); return; }
        if (TinyTube.App.pendingDeArrow[vId]) {
            if (TinyTube.App.pendingDeArrow[vId].timer) clearTimeout(TinyTube.App.pendingDeArrow[vId].timer);
            TinyTube.App.pendingDeArrow[vId].cancelled = true;
        }
        const operation = { timer: null, cancelled: false };
        TinyTube.App.pendingDeArrow[vId] = operation;
        operation.timer = setTimeout(() => {
            if (operation.cancelled) return;
            TinyTube.Utils.fetchDedup(`${CONFIG.DEARROW_API}?videoID=${vId}`, {}, CONFIG.SPONSOR_FETCH_TIMEOUT)
                .then(r => {
                    if (operation.cancelled) return;
                    return r.json();
                })
                .then(d => {
                    if (operation.cancelled) return;
                    TinyTube.App.deArrowCache.set(vId, d);
                    UI.applyDeArrow(d, idx, vId);
                    delete TinyTube.App.pendingDeArrow[vId];
                }).catch(() => {
                    if (!operation.cancelled) delete TinyTube.App.pendingDeArrow[vId];
                });
        }, CONFIG.DEARROW_DEBOUNCE_MS);
    },
    applyDeArrow: (d, idx, originalId) => {
        if (!TinyTube.App.items[idx]) return;
        const currentId = TinyTube.Utils.getVideoId(TinyTube.App.items[idx]);
        if (currentId !== originalId) return;
        if (d.titles && d.titles[0]) {
            const t = el(`title-${idx}`);
            if (t) t.textContent = d.titles[0].title;
            TinyTube.App.items[idx].title = d.titles[0].title;
        }
    }
};

VirtualScroll.onRangeChange = ({ start, end, prevStart, prevEnd }) => {
    if (TinyTube.App.focus.area !== "grid") return;
    if (end <= start) return;
    const focusIndex = TinyTube.App.focus.index;
    const wasVisible = focusIndex >= prevStart && focusIndex < prevEnd;
    const nowVisible = focusIndex >= start && focusIndex < end;
    if (wasVisible && !nowVisible) {
        TinyTube.App.focus.index = TinyTube.Utils.clamp(focusIndex, start, end - 1);
    }
};

// --- 7. NEW FEATURE MODULES ---

// Search Filters Module
const SearchFilters = {
    show: () => {
        el("search-filters").classList.remove("hidden");
    },
    hide: () => {
        el("search-filters").classList.add("hidden");
        TinyTube.App.filterFocusIndex = 0;

        // FIX: Restore focus to search input or grid to prevent focus trap
        const searchInput = el("search-input");
        if (searchInput) {
            TinyTube.App.focus.area = "search";
            searchInput.focus();
            TinyTube.UI.updateFocus();
        } else {
            // Fallback to grid if search input not available
            TinyTube.App.focus.area = "grid";
            TinyTube.App.focus.index = 0;
            TinyTube.UI.updateFocus();
        }
    },
    updateUI: () => {
        const filters = TinyTube.App.searchFilters;
        const dateLabel = filters.date ? filters.date.charAt(0).toUpperCase() + filters.date.slice(1) : 'Any';
        const durationLabel = filters.duration ? filters.duration.charAt(0).toUpperCase() + filters.duration.slice(1) : 'Any';
        const sortLabel = filters.sort.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const typeLabel = filters.type.charAt(0).toUpperCase() + filters.type.slice(1);

        el("filter-sort").textContent = `Sort: ${sortLabel} ▼`;
        el("filter-date").textContent = `Date: ${dateLabel} ▼`;
        el("filter-duration").textContent = `Duration: ${durationLabel} ▼`;
        el("filter-type").textContent = `Type: ${typeLabel} ▼`;
    },
    cycleSort: () => {
        const sorts = CONFIG.SEARCH_FILTERS.sort;
        const currentIndex = sorts.indexOf(TinyTube.App.searchFilters.sort);
        TinyTube.App.searchFilters.sort = sorts[(currentIndex + 1) % sorts.length];
        SearchFilters.updateUI();
        TinyTube.App.actions.runSearch();
    },
    cycleDate: () => {
        const dates = CONFIG.SEARCH_FILTERS.date;
        const currentIndex = dates.indexOf(TinyTube.App.searchFilters.date);
        TinyTube.App.searchFilters.date = dates[(currentIndex + 1) % dates.length];
        SearchFilters.updateUI();
        TinyTube.App.actions.runSearch();
    },
    cycleDuration: () => {
        const durations = CONFIG.SEARCH_FILTERS.duration;
        const currentIndex = durations.indexOf(TinyTube.App.searchFilters.duration);
        TinyTube.App.searchFilters.duration = durations[(currentIndex + 1) % durations.length];
        SearchFilters.updateUI();
        TinyTube.App.actions.runSearch();
    },
    cycleType: () => {
        const types = CONFIG.SEARCH_FILTERS.type;
        const currentIndex = types.indexOf(TinyTube.App.searchFilters.type);
        TinyTube.App.searchFilters.type = types[(currentIndex + 1) % types.length];
        SearchFilters.updateUI();
        TinyTube.App.actions.runSearch();
    },
    moveFocus: (delta) => {
        const buttons = ['filter-sort', 'filter-date', 'filter-duration', 'filter-type'];
        buttons.forEach(id => el(id).classList.remove('focused'));
        TinyTube.App.filterFocusIndex = (TinyTube.App.filterFocusIndex + delta + buttons.length) % buttons.length;
        el(buttons[TinyTube.App.filterFocusIndex]).classList.add('focused');
    },
    activateFocused: () => {
        const actions = [SearchFilters.cycleSort, SearchFilters.cycleDate, SearchFilters.cycleDuration, SearchFilters.cycleType];
        actions[TinyTube.App.filterFocusIndex]();
    }
};

// Trending Category Tabs Module
const TrendingTabs = {
    show: () => {
        el("trending-tabs").classList.remove("hidden");
    },
    hide: () => {
        el("trending-tabs").classList.add("hidden");
        TinyTube.App.categoryFocusIndex = 0;
    },
    setActive: (category) => {
        const tabs = el("trending-tabs").querySelectorAll('.cat-tab');
        tabs.forEach(tab => {
            if (tab.dataset.cat === category) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
    },
    moveFocus: (delta) => {
        const tabs = el("trending-tabs").querySelectorAll('.cat-tab');
        tabs.forEach(tab => tab.classList.remove('focused'));
        TinyTube.App.categoryFocusIndex = (TinyTube.App.categoryFocusIndex + delta + tabs.length) % tabs.length;
        tabs[TinyTube.App.categoryFocusIndex].classList.add('focused');
    },
    activateFocused: () => {
        const tabs = el("trending-tabs").querySelectorAll('.cat-tab');
        const category = tabs[TinyTube.App.categoryFocusIndex].dataset.cat;
        TinyTube.Feed.loadTrendingCategory(category);
    },
    init: () => {
        const tabs = el("trending-tabs").querySelectorAll('.cat-tab');
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => {
                TinyTube.Feed.loadTrendingCategory(tab.dataset.cat);
            });
        });
    }
};

TinyTube.EventBus.on('player:state-change', (state) => {
    if (!TinyTube.App) return;
    if (state === 'playing' || state === 'paused' || state === 'stopped' || state === 'loading') {
        if (TinyTube.App.view === 'PLAYER') {
            UI.updateFocus();
        }
    }
});

TinyTube.CardPool = CardPool;
TinyTube.VirtualScroll = VirtualScroll;
TinyTube.UI = UI;
TinyTube.SearchFilters = SearchFilters;
TinyTube.TrendingTabs = TrendingTabs;
})(window);
