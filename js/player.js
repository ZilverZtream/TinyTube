(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const el = TinyTube.el;

const Quality = {
    open: () => {
        if (!TinyTube.App.availableQualities || TinyTube.App.availableQualities.length === 0) {
            TinyTube.Utils.toast("No quality options available");
            return;
        }
        const overlay = el("quality-overlay");
        const list = el("quality-list");
        if (!overlay || !list) return;

        if (!overlay.classList.contains("hidden")) {
            Quality.close();
            return;
        }

        // Close other overlays
        el("captions-overlay").classList.add("hidden");
        el("chapters-overlay").classList.add("hidden");
        el("video-info-overlay").classList.add("hidden");
        if (Comments.isOpen()) Comments.close();

        list.textContent = "";
        TinyTube.App.qualityIndex = 0;

        TinyTube.App.availableQualities.forEach((q, index) => {
            const option = TinyTube.Utils.create("button", "quality-option");
            option.type = "button";

            const labelSpan = document.createElement('span');
            labelSpan.textContent = q.qualityLabel || `${q.height}p`;
            option.appendChild(labelSpan);

            if (q.bitrate) {
                const bitrateSpan = document.createElement('span');
                bitrateSpan.className = 'quality-bitrate';
                bitrateSpan.textContent = `${Math.round(q.bitrate / 1000)} kbps`;
                option.appendChild(bitrateSpan);
            }

            if (TinyTube.App.currentQuality && TinyTube.App.currentQuality.url === q.url) {
                option.classList.add('active');
                TinyTube.App.qualityIndex = index;
            }

            if (index === TinyTube.App.qualityIndex) {
                option.classList.add('focused');
            }

            option.addEventListener('click', () => Quality.select(index));
            list.appendChild(option);
        });

        overlay.classList.remove("hidden");
        TinyTube.App.activeLayer = "QUALITY";
    },
    close: () => {
        el("quality-overlay").classList.add("hidden");
        TinyTube.App.activeLayer = "NONE";
    },
    move: (delta) => {
        const options = el("quality-list").querySelectorAll('.quality-option');
        if (!options.length) return;

        options[TinyTube.App.qualityIndex].classList.remove('focused');
        TinyTube.App.qualityIndex = (TinyTube.App.qualityIndex + delta + options.length) % options.length;
        options[TinyTube.App.qualityIndex].classList.add('focused');

        // Scroll into view
        options[TinyTube.App.qualityIndex].scrollIntoView({ block: 'nearest', behavior: TinyTube.App.supportsSmoothScroll ? 'smooth' : 'auto' });
    },
    select: (index) => {
        if (index === undefined) index = TinyTube.App.qualityIndex;
        const quality = TinyTube.App.availableQualities[index];
        if (!quality || !quality.url) return;

        const player = el("native-player");
        if (!player) return;

        const currentTime = player.currentTime;
        const wasPlaying = !player.paused;

        TinyTube.App.currentQuality = quality;
        TinyTube.App.currentStreamUrl = quality.url;
        player.src = quality.url;
        player.currentTime = currentTime;

        if (wasPlaying) {
            player.play().catch(e => console.log('Play after quality change failed:', e));
        }

        TinyTube.Utils.toast(`Quality: ${quality.qualityLabel || quality.height + 'p'}`);
        Quality.close();
    }
};

// Video Chapters Module
const Chapters = {
    parseChapters: (description) => {
        if (!description) return [];

        const lines = description.split('\n');
        const chapters = [];
        const timestampRegex = /(\d{1,2}:)?(\d{1,2}):(\d{2})/;

        for (const line of lines) {
            const trimmedLine = line.trim();
            const match = trimmedLine.match(timestampRegex);
            if (match) {
                const hours = match[1] ? parseInt(match[1].slice(0, -1)) : 0;
                const minutes = parseInt(match[2]);
                const seconds = parseInt(match[3]);
                let title = trimmedLine.replace(match[0], "").trim();
                title = title.replace(/^[\[\]\(\)\-–—\s]+/, "").replace(/[\[\]\(\)\-–—\s]+$/, "");
                if (!title) continue;

                const timeInSeconds = hours * 3600 + minutes * 60 + seconds;
                chapters.push({ time: timeInSeconds, title: title });
            }
        }

        // Only return if we found at least 2 chapters
        return chapters.length >= 2 ? chapters : [];
    },
    open: () => {
        if (!TinyTube.App.currentVideoData) {
            TinyTube.Utils.toast("Loading video data...");
            return;
        }
        if (!TinyTube.App.videoChapters || TinyTube.App.videoChapters.length === 0) {
            TinyTube.Utils.toast("No chapters available");
            return;
        }

        const overlay = el("chapters-overlay");
        const list = el("chapters-list");
        if (!overlay || !list) return;

        if (!overlay.classList.contains("hidden")) {
            Chapters.close();
            return;
        }

        // Close other overlays
        el("captions-overlay").classList.add("hidden");
        el("quality-overlay").classList.add("hidden");
        el("video-info-overlay").classList.add("hidden");
        if (Comments.isOpen()) Comments.close();

        list.textContent = "";
        TinyTube.App.chaptersIndex = 0;

        const player = el("native-player");
        const currentTime = player ? player.currentTime : 0;

        TinyTube.App.videoChapters.forEach((chapter, index) => {
            const item = TinyTube.Utils.create("button", "chapter-item");
            item.type = "button";

            const timeSpan = document.createElement('span');
            timeSpan.className = 'chapter-time';
            timeSpan.textContent = TinyTube.Utils.formatTime(chapter.time);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'chapter-title';
            titleSpan.textContent = chapter.title;

            item.appendChild(timeSpan);
            item.appendChild(titleSpan);

            // Mark current chapter
            if (currentTime >= chapter.time) {
                const nextChapter = TinyTube.App.videoChapters[index + 1];
                if (!nextChapter || currentTime < nextChapter.time) {
                    item.classList.add('active');
                    TinyTube.App.chaptersIndex = index;
                }
            }

            if (index === TinyTube.App.chaptersIndex) {
                item.classList.add('focused');
            }

            item.addEventListener('click', () => Chapters.select(index));
            list.appendChild(item);
        });

        overlay.classList.remove("hidden");
        TinyTube.App.activeLayer = "CHAPTERS";
    },
    close: () => {
        el("chapters-overlay").classList.add("hidden");
        TinyTube.App.activeLayer = "NONE";
    },
    move: (delta) => {
        const items = el("chapters-list").querySelectorAll('.chapter-item');
        if (!items.length) return;

        items[TinyTube.App.chaptersIndex].classList.remove('focused');
        TinyTube.App.chaptersIndex = (TinyTube.App.chaptersIndex + delta + items.length) % items.length;
        items[TinyTube.App.chaptersIndex].classList.add('focused');

        // Scroll into view
        items[TinyTube.App.chaptersIndex].scrollIntoView({ block: 'nearest', behavior: TinyTube.App.supportsSmoothScroll ? 'smooth' : 'auto' });
    },
    select: (index) => {
        if (index === undefined) index = TinyTube.App.chaptersIndex;
        const chapter = TinyTube.App.videoChapters[index];
        if (!chapter) return;

        const player = el("native-player");
        if (!player) return;

        player.currentTime = chapter.time;
        TinyTube.Utils.toast(`Jump to: ${chapter.title}`);
        Chapters.close();
    }
};

// Keyboard Shortcuts Guide Module
const Shortcuts = {
    open: () => {
        const overlay = el("shortcuts-overlay");
        if (!overlay) return;

        if (!overlay.classList.contains("hidden")) {
            Shortcuts.close();
            return;
        }

        overlay.classList.remove("hidden");
        TinyTube.App.activeLayer = "SHORTCUTS";
    },
    close: () => {
        el("shortcuts-overlay").classList.add("hidden");
        TinyTube.App.activeLayer = "NONE";
    }
};

// --- 8. PLAYER ---
const Player = {
    cacheElements: () => {
        TinyTube.App.playerElements = {
            player: el("native-player"),
            progressFill: el("progress-fill"),
            bufferFill: el("buffer-fill"),
            currTime: el("curr-time"),
            totalTime: el("total-time"),
            bufferingSpinner: el("buffering-spinner"),
            speedBadge: el("speed-badge")
        };
    },
    captionLangKey: () => `tt_caption_lang_${TinyTube.App.profileId}`,
    clearCaptions: () => {
        const p = TinyTube.App.playerElements ? TinyTube.App.playerElements.player : el("native-player");
        if (p) p.querySelectorAll("track").forEach(track => track.remove());
        TinyTube.App.captionTracks = [];
    },
    setCaptionMode: (lang, mode) => {
        TinyTube.App.captionTracks.forEach(track => {
            if (track && track.track) track.track.mode = (lang && track.srclang === lang) ? mode : "hidden";
        });
    },
    openCaptionsMenu: () => {
        const overlay = el("captions-overlay");
        const list = el("captions-list");
        if (!overlay || !list) return;
        if (!TinyTube.App.captionTracks.length) { TinyTube.Utils.toast("No captions"); return; }
        if (!overlay.classList.contains("hidden")) { Captions.close(); return; }
        if (Comments.isOpen()) Comments.close();
        el("video-info-overlay").classList.add("hidden");
        list.textContent = "";
        const currentLang = TinyTube.SafeStorage.getItem(Player.captionLangKey(), "");
        TinyTube.App.captionTracks.forEach(track => {
            if (!track) return;
            const label = track.label || track.srclang || "Captions";
            const text = track.srclang ? `${label} (${track.srclang})` : label;
            const option = TinyTube.Utils.create("button", "captions-option", text);
            option.type = "button";
            if (!track.srclang) option.disabled = true;
            else {
                if (track.srclang === currentLang) option.classList.add("active");
                option.addEventListener("click", () => {
                    TinyTube.SafeStorage.setItem(Player.captionLangKey(), track.srclang);
                    Player.setCaptionMode(track.srclang, "showing");
                    Captions.close();
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
        const storedLang = TinyTube.SafeStorage.getItem(Player.captionLangKey(), "");
        const captions = data.captions.map(c => {
            const src = c.url || c.vttUrl || c.baseUrl || c.caption_url;
            return src ? { src, srclang: c.language_code || c.srclang || "", label: c.label || c.name || "Subtitles" } : null;
        }).filter(Boolean);
        if (!captions.length) return;
        const p = TinyTube.App.playerElements.player;
        captions.forEach(c => {
            const track = document.createElement("track");
            track.kind = "subtitles";
            track.label = c.label;
            if (c.srclang) track.srclang = c.srclang;
            track.src = c.src;
            p.appendChild(track);
            TinyTube.App.captionTracks.push({track: track, srclang: c.srclang, label: c.label});
        });
        if (storedLang) Player.setCaptionMode(storedLang, "showing");
    },
    toggleCaptions: () => {
        if (!TinyTube.App.captionTracks.length) { TinyTube.Utils.toast("No captions"); return; }
        const showing = TinyTube.App.captionTracks.find(t => t.track && t.track.mode === "showing");
        if (showing) {
            TinyTube.App.captionTracks.forEach(t => { if (t.track) t.track.mode = "hidden"; });
            TinyTube.Utils.toast("Captions off");
        } else {
            let lang = TinyTube.SafeStorage.getItem(Player.captionLangKey(), "") || (TinyTube.App.captionTracks[0] && TinyTube.App.captionTracks[0].srclang) || "";
            if (lang) {
                TinyTube.SafeStorage.setItem(Player.captionLangKey(), lang);
                Player.setCaptionMode(lang, "showing");
                TinyTube.Utils.toast(`Captions: ${lang}`);
            }
        }
    },
    normalizeUpNextItem: (item) => {
        const videoId = TinyTube.Utils.getVideoId(item);
        if (!videoId || videoId === TinyTube.App.currentVideoId) return null;
        return {
            videoId,
            title: item.title || item.titleText || "Untitled",
            author: item.author || item.authorName || "",
            lengthSeconds: item.lengthSeconds || item.length || item.duration || 0,
            videoThumbnails: item.videoThumbnails || item.thumbnails || item.thumbnail || []
        };
    },
    loadUpNext: async (data, vId) => {
        let list = Array.isArray(data && data.recommendedVideos) ? data.recommendedVideos : [];
        if (!list.length && TinyTube.App.api) {
            try {
                const res = await TinyTube.Utils.fetchWithTimeout(`${TinyTube.App.api}/related/${vId}`);
                if (res.ok) {
                    const related = await res.json();
                    if (Array.isArray(related)) list = related;
                }
            } catch {}
        }
        TinyTube.App.upNext = (list || []).map(Player.normalizeUpNextItem).filter(Boolean);
        HUD.renderUpNext();
    },
    
    start: async (item, retryCount = 0) => {
        if (!item) return;

        // Disconnect lazy observer when entering player
        if (TinyTube.App.lazyObserver) {
            TinyTube.App.lazyObserver.disconnect();
        }

        // Abort any previous video load operations
        if (TinyTube.App.currentVideoAbortController) {
            TinyTube.App.currentVideoAbortController.abort();
        }
        TinyTube.App.currentVideoAbortController = new AbortController();
        const signal = TinyTube.App.currentVideoAbortController.signal;

        TinyTube.App.view = "PLAYER";
        TinyTube.EventBus.emit('player:state-change', 'loading');
        TinyTube.App.playerMode = "BYPASS";
        TinyTube.App.playbackSpeedIdx = 0;
        TinyTube.App.playerControls.active = false;
        TinyTube.App.playerControls.index = 0;
        TinyTube.App.activeLayer = "NONE";
        TinyTube.App.currentVideoData = null;
        TinyTube.App.currentStreamUrl = null;
        TinyTube.App.lastRenderSec = null;
        TinyTube.App.upNext = [];
        TinyTube.App.playerErrorRetries = 0;
        TinyTube.App.preloadedNextVideo = null;
        TinyTube.App.lastSponsorCheckTime = 0;

        el("player-layer").classList.remove("hidden");
        el("player-hud").classList.add("visible");
        ScreenSaver.disable();
        if (!TinyTube.App.playerElements) Player.cacheElements();
        const vId = TinyTube.Utils.getVideoId(item);
        if(!vId) { TinyTube.Utils.toast("Error: No ID"); return; }
        TinyTube.App.currentVideoId = vId;
        TinyTube.App.currentVideoLoadId++;

        el("player-title").textContent = item.title;
        HUD.updateSubBadge(TinyTube.DB.isSubbed(item.authorId));
        HUD.updateSpeedBadge(1);
        HUD.renderUpNext();
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        el("enforcement-container").innerHTML = ""; // Clear
        Comments.reset();
        Player.clearCaptions();
        const p = TinyTube.App.playerElements.player;
        p.pause();
        p.src = "";
        let posterUrl = "";
        if (item.videoThumbnails && item.videoThumbnails[0]) posterUrl = item.videoThumbnails[0].url;
        else if (item.thumbnail) posterUrl = item.thumbnail;
        if(posterUrl) p.poster = posterUrl;
        TinyTube.App.playerElements.bufferingSpinner.classList.remove("hidden");
        TinyTube.App.sponsorSegs = [];
        const loadId = TinyTube.App.currentVideoLoadId;

        // Fetch sponsor segments with abort signal
        fetch(`${CONFIG.SPONSOR_API}?videoID=${vId}&categories=["sponsor","selfpromo"]`, { signal })
            .then(r=>r.json()).then(s => { if(Array.isArray(s) && loadId === TinyTube.App.currentVideoLoadId) TinyTube.App.sponsorSegs=s.sort((a,b)=>a.segment[0]-b.segment[0]); })
            .catch((e)=>{ if (e.name !== 'AbortError') console.log('Sponsor fetch failed:', e.message); });

        const isCurrent = () => TinyTube.App.view === "PLAYER" && TinyTube.App.currentVideoId === vId && loadId === TinyTube.App.currentVideoLoadId;
        let streamUrl = null;
        let apiPromise = null;

        if (TinyTube.App.streamCache && TinyTube.App.streamCache.has(vId)) {
            streamUrl = TinyTube.App.streamCache.get(vId);
            console.log("Player: Cache Hit for " + vId);
            TinyTube.Utils.toast("Src: Preload");
        }

        const hydrateFromApi = async () => {
            try {
                const res = await TinyTube.Utils.fetchWithTimeout(`${TinyTube.App.api}/videos/${vId}`, { signal });
                if (!isCurrent()) return;
                if (res.ok) {
                    const data = await res.json();
                    if (!isCurrent()) return;
                    TinyTube.App.currentVideoData = data;

                    // Parse video chapters from description
                    if (data.description || data.descriptionHtml) {
                        const desc = data.description || data.descriptionHtml;
                        TinyTube.App.videoChapters = Chapters.parseChapters(desc);
                    } else {
                        TinyTube.App.videoChapters = [];
                    }

                    // Store available quality options
                    const formats = (data.formatStreams || []).filter(s => s && s.url && (s.container === "mp4" || (s.mimeType || "").indexOf("video/mp4") !== -1));
                    TinyTube.App.availableQualities = formats.sort((a, b) => (b.height || 0) - (a.height || 0));

                    await Player.loadUpNext(data, vId);
                    if (!isCurrent()) return;
                    Player.setupCaptions(data);

                    const cappedFormats = TinyTube.Utils.applyResolutionCap(formats);
                    const preferred = TinyTube.Utils.pickPreferredStream(cappedFormats);
                    if (preferred && preferred.url) {
                        if (!streamUrl) {
                            streamUrl = preferred.url;
                            TinyTube.Utils.toast("Src: API");
                        }
                        if (!TinyTube.App.currentQuality) {
                            TinyTube.App.currentQuality = preferred;
                        }
                    }

                    // Save video metadata to history for later display
                    if (data.title && data.author) {
                        TinyTube.DB.saveVideoToHistory(vId, {
                            title: data.title,
                            author: data.author,
                            authorId: data.authorId,
                            videoThumbnails: data.videoThumbnails
                        });
                    }
                }
            } catch(e) {
                if (e.name !== 'AbortError') console.log("API failed:", e.message);
            }
        };

        if (TinyTube.App.api) {
            if (streamUrl) {
                apiPromise = hydrateFromApi();
            } else {
                await hydrateFromApi();
            }
        }

        if (!streamUrl) {
            try {
                const direct = await Extractor.extractInnertube(vId, signal);
                if (!isCurrent()) return;
                if (direct && direct.url) {
                    streamUrl = direct.url;
                    TinyTube.App.currentVideoData = direct.meta;
                    if (direct.meta.captions && direct.meta.captions.length) Player.setupCaptions({captions: direct.meta.captions});
                    TinyTube.Utils.toast("Src: Direct");
                }
            } catch(e) {
                if (e.name !== 'AbortError') console.log("Innertube failed:", e.message);
            }
        }

        if (!TinyTube.App.upNext.length && !apiPromise) {
            await Player.loadUpNext(null, vId);
            if (!isCurrent()) return;
        }

        if (!isCurrent()) return;

        if (streamUrl) {
            TinyTube.App.currentStreamUrl = streamUrl;
            p.src = streamUrl;
            p.style.display = "block";
            const savedPos = TinyTube.DB.getPosition(vId);
            if (savedPos > 0) { p.currentTime = savedPos; TinyTube.Utils.toast(`Resume: ${TinyTube.Utils.formatTime(savedPos)}`); }
            p.play().catch(e => { console.log("Play failed", e); Player.enforce(vId); });
            Player.setupHUD(p);
            Player.startRenderLoop();
        } else {
            Player.enforce(vId);
        }
        TinyTube.App.playerElements.bufferingSpinner.classList.add("hidden");
    },
    
    enforce: (vId) => {
        // FIX: Add Network Check
        if (!navigator.onLine) {
             Player.showError("Network Error", "Check your internet connection.");
             return;
        }
        TinyTube.App.playerMode = "ENFORCE";
        const p = TinyTube.App.playerElements.player;
        p.style.display = "none";
        p.pause();
        Player.stopRenderLoop();

        // Clean up any existing embed listeners/timeouts
        Player.cleanupEmbedResources();

        try {
            const container = el("enforcement-container");
            container.innerHTML = `<iframe id="embed-iframe" src="https://www.youtube.com/embed/${vId}?autoplay=1&playsinline=1" width="100%" height="100%" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;

            // Add timeout to detect if embed fails to load
            TinyTube.App.embedTimeout = setTimeout(() => {
                // Check if we're still in enforce mode and if iframe hasn't loaded properly
                if (TinyTube.App.playerMode === "ENFORCE" && TinyTube.App.currentVideoId === vId) {
                    const iframe = container.querySelector('#embed-iframe');
                    if (iframe && !iframe.contentDocument) {
                        Player.showError("Embed Failed", "Unable to load embedded player. Video may be restricted.");
                    }
                }
                TinyTube.App.embedTimeout = null;
            }, 10000); // 10 second timeout

            // Listen for messages from iframe to confirm it loaded
            TinyTube.App.embedMessageHandler = (event) => {
                if (event.origin === "https://www.youtube.com") {
                    Player.cleanupEmbedResources();
                }
            };
            window.addEventListener('message', TinyTube.App.embedMessageHandler);

            TinyTube.Utils.toast("Src: Embed");
        } catch (e) {
            Player.showError("Playback Failed", "All methods failed.");
        }
    },
    cleanupEmbedResources: () => {
        if (TinyTube.App.embedTimeout) {
            clearTimeout(TinyTube.App.embedTimeout);
            TinyTube.App.embedTimeout = null;
        }
        if (TinyTube.App.embedMessageHandler) {
            window.removeEventListener('message', TinyTube.App.embedMessageHandler);
            TinyTube.App.embedMessageHandler = null;
        }
    },
    showError: (title, msg) => {
        el("enforcement-container").innerHTML = `<div class="player-error"><h3>${title}</h3><p>${msg}</p></div>`;
        if (TinyTube.App.playerElements && TinyTube.App.playerElements.bufferingSpinner) {
            TinyTube.App.playerElements.bufferingSpinner.classList.add("hidden");
        }
    },
    setupHUD: (p) => {
        const show = () => HUD.show();
        p.onplay = () => {
            if (TinyTube.App.playerElements && TinyTube.App.playerElements.bufferingSpinner) {
                TinyTube.App.playerElements.bufferingSpinner.classList.add("hidden");
            }
            show();
            TinyTube.EventBus.emit('player:state-change', 'playing');
            if (!TinyTube.App.renderTimer && !TinyTube.App.renderAnimationFrame && TinyTube.App.playerMode === "BYPASS") Player.startRenderLoop();
        };
        p.onpause = () => {
            show();
            TinyTube.EventBus.emit('player:state-change', 'paused');
            Player.stopRenderLoop();
        };
        p.onseeked = show;
        p.onwaiting = () => {
            if (TinyTube.App.playerElements && TinyTube.App.playerElements.bufferingSpinner) {
                TinyTube.App.playerElements.bufferingSpinner.classList.remove("hidden");
            }
        };
        p.onplaying = () => {
            if (TinyTube.App.playerElements && TinyTube.App.playerElements.bufferingSpinner) {
                TinyTube.App.playerElements.bufferingSpinner.classList.add("hidden");
            }
        };
        p.onerror = () => {
            TinyTube.App.playerErrorRetries++;
            if (TinyTube.App.playerErrorRetries < CONFIG.MAX_PLAYER_ERROR_RETRIES) {
                console.log(`Player error, retry ${TinyTube.App.playerErrorRetries}/${CONFIG.MAX_PLAYER_ERROR_RETRIES}`);
                if (TinyTube.App.playerMode !== "ENFORCE") {
                    Player.enforce(TinyTube.App.currentVideoId);
                }
            } else {
                console.log("Player error: max retries exceeded");
                Player.showError("Playback Failed", "Unable to play video after multiple attempts.");
            }
        };
        p.onended = () => {
            TinyTube.EventBus.emit('player:state-change', 'ended');
            if (!TinyTube.App.autoplayEnabled) return;
            const next = TinyTube.App.upNext && TinyTube.App.upNext[0];
            if (next) Player.start(next);
        };
    },
    startRenderLoop: () => {
        Player.stopRenderLoop();
        TinyTube.App.lastRenderSec = null;
        TinyTube.App.lastRenderDuration = null;
        if (window.requestAnimationFrame) {
            Player.renderLoopRAF();
        } else {
            TinyTube.App.renderTimer = setTimeout(Player.renderLoop, CONFIG.RENDER_INTERVAL_MS);
        }
    },
    stopRenderLoop: () => {
        if (TinyTube.App.renderTimer) clearTimeout(TinyTube.App.renderTimer);
        if (TinyTube.App.renderAnimationFrame) cancelAnimationFrame(TinyTube.App.renderAnimationFrame);
        TinyTube.App.renderTimer = null;
        TinyTube.App.renderAnimationFrame = null;
    },
    updateHud: (p, forceTextUpdate = false) => {
        if (!TinyTube.App.playerElements) return;

        const hud = el("player-hud");
        const isHudVisible = hud && hud.classList.contains("visible");

        // Skip expensive updates if HUD is not visible
        if (!isHudVisible && !forceTextUpdate) return;

        const currentSec = Math.floor(p.currentTime);
        const duration = p.duration;
        const pe = TinyTube.App.playerElements;
        const hasFiniteDuration = isFinite(duration) && duration > 0;

        // Update progress bar only when HUD visible (smooth animation)
        if (isHudVisible && hasFiniteDuration && pe.progressFill) {
            pe.progressFill.style.transform = `scaleX(${p.currentTime / duration})`;
        }

        // Only update text when second changes or forced
        if (forceTextUpdate || currentSec !== TinyTube.App.lastRenderSec || duration !== TinyTube.App.lastRenderDuration) {
            TinyTube.App.lastRenderSec = currentSec;
            TinyTube.App.lastRenderDuration = duration;
            if (pe.currTime) pe.currTime.textContent = TinyTube.Utils.formatTime(p.currentTime);
            if (pe.totalTime) pe.totalTime.textContent = TinyTube.Utils.formatTime(duration);
            if (hasFiniteDuration && p.buffered.length > 0 && pe.bufferFill) {
                pe.bufferFill.style.transform = `scaleX(${p.buffered.end(p.buffered.length-1) / duration})`;
            }
        }
    },
    renderLoopRAF: () => {
        if (TinyTube.App.view !== "PLAYER" || !TinyTube.App.playerElements) {
            Player.stopRenderLoop();
            return;
        }
        const p = TinyTube.App.playerElements.player;
        if (!p || TinyTube.App.playerMode === "ENFORCE" || p.paused) {
            Player.stopRenderLoop();
            return;
        }
        if (!isNaN(p.duration)) {
            Player.updateHud(p, false);

            // Throttled SponsorBlock check (every 500ms instead of every frame)
            const now = Date.now();
            if (now - TinyTube.App.lastSponsorCheckTime >= CONFIG.SPONSORBLOCK_THROTTLE_MS) {
                TinyTube.App.lastSponsorCheckTime = now;
                const s = TinyTube.Utils.findSegment(p.currentTime);
                if (s && s !== TinyTube.App.lastSkippedSeg) {
                    TinyTube.App.lastSkippedSeg = s;
                    p.currentTime = s.segment[1] + 0.1;
                    TinyTube.Utils.toast("Skipped");
                } else if (!s) TinyTube.App.lastSkippedSeg = null;
            }

            // Preload next video when 80% complete
            if (TinyTube.App.autoplayEnabled && p.duration > 0) {
                const progress = p.currentTime / p.duration;
                if (progress >= CONFIG.PRELOAD_THRESHOLD && !TinyTube.App.preloadedNextVideo) {
                    Player.preloadNextVideo();
                }
            }
        }
        TinyTube.App.renderAnimationFrame = requestAnimationFrame(Player.renderLoopRAF);
    },
    renderLoop: () => {
        if (TinyTube.App.view !== "PLAYER" || !TinyTube.App.playerElements) {
            Player.stopRenderLoop();
            return;
        }
        const p = TinyTube.App.playerElements.player;
        if (!p || TinyTube.App.playerMode === "ENFORCE" || p.paused) {
            Player.stopRenderLoop();
            return;
        }
        if (!isNaN(p.duration)) {
            Player.updateHud(p, true);

            // Throttled SponsorBlock check
            const now = Date.now();
            if (now - TinyTube.App.lastSponsorCheckTime >= CONFIG.SPONSORBLOCK_THROTTLE_MS) {
                TinyTube.App.lastSponsorCheckTime = now;
                const s = TinyTube.Utils.findSegment(p.currentTime);
                if (s && s !== TinyTube.App.lastSkippedSeg) {
                    TinyTube.App.lastSkippedSeg = s;
                    p.currentTime = s.segment[1] + 0.1;
                    TinyTube.Utils.toast("Skipped");
                } else if (!s) TinyTube.App.lastSkippedSeg = null;
            }

            // Preload next video when 80% complete
            if (TinyTube.App.autoplayEnabled && p.duration > 0) {
                const progress = p.currentTime / p.duration;
                if (progress >= CONFIG.PRELOAD_THRESHOLD && !TinyTube.App.preloadedNextVideo) {
                    Player.preloadNextVideo();
                }
            }
        }
        TinyTube.App.renderTimer = setTimeout(Player.renderLoop, CONFIG.RENDER_INTERVAL_MS);
    },
    seek: (direction, accelerated = false) => {
        if (!TinyTube.App.playerElements || !TinyTube.App.playerElements.player) return;
        const p = TinyTube.App.playerElements.player;
        if (TinyTube.App.playerMode !== "BYPASS" || isNaN(p.duration)) return;
        let amount = CONFIG.SEEK_INTERVALS[0];
        if (accelerated) {
            const held = performance.now() - TinyTube.App.seekKeyTime;
            if (held > 2000) amount = CONFIG.SEEK_INTERVALS[2];
            else if (held > CONFIG.SEEK_ACCELERATION_DELAY) amount = CONFIG.SEEK_INTERVALS[1];
        }
        const newTime = direction === 'left' ? p.currentTime - amount : p.currentTime + amount;
        p.currentTime = TinyTube.Utils.clamp(newTime, 0, p.duration);
    },
    cycleSpeed: () => {
        if (!TinyTube.App.playerElements || !TinyTube.App.playerElements.player) return;
        const p = TinyTube.App.playerElements.player;
        TinyTube.App.playbackSpeedIdx = (TinyTube.App.playbackSpeedIdx + 1) % CONFIG.SPEEDS.length;
        const s = CONFIG.SPEEDS[TinyTube.App.playbackSpeedIdx];
        p.playbackRate = s;
        HUD.updateSpeedBadge(s);
        TinyTube.Utils.toast(`Speed: ${s}x`);
    },
    preloadNextVideo: async () => {
        if (TinyTube.App.preloadedNextVideo || !TinyTube.App.upNext || TinyTube.App.upNext.length === 0) return;

        const nextVideo = TinyTube.App.upNext[0];
        if (!nextVideo || !nextVideo.videoId) return;

        TinyTube.App.preloadedNextVideo = nextVideo.videoId;

        try {
            // Preload the stream URL in the background
            if (TinyTube.App.api) {
                const vId = nextVideo.videoId;
                if (TinyTube.App.preloadAbortController) {
                    TinyTube.App.preloadAbortController.abort();
                }
                TinyTube.App.preloadAbortController = new AbortController();
                const preloadSignal = TinyTube.App.preloadAbortController.signal;
                TinyTube.Utils.fetchDedup(`${TinyTube.App.api}/videos/${vId}`, { signal: preloadSignal })
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        if (data && data.formatStreams) {
                            const formats = (data.formatStreams || []).filter(s => s && s.url && (s.container === "mp4" || (s.mimeType || "").indexOf("video/mp4") !== -1));
                            const cappedFormats = TinyTube.Utils.applyResolutionCap(formats);
                            const preferred = TinyTube.Utils.pickPreferredStream(cappedFormats);
                            if (preferred && preferred.url) {
                                TinyTube.App.streamCache.set(vId, preferred.url);
                                console.log('Preloaded next video:', vId);
                            }
                        }
                    })
                    .catch(e => {
                        if (e.name !== "AbortError") console.log('Preload failed:', e.message);
                    })
                    .finally(() => {
                        if (TinyTube.App.preloadAbortController && TinyTube.App.preloadAbortController.signal === preloadSignal) {
                            TinyTube.App.preloadAbortController = null;
                        }
                    });
            }
        } catch (e) {
            console.log('Preload error:', e.message);
        }
    },
    toggleInfo: () => {
        const overlay = el("video-info-overlay");
        if (!overlay.classList.contains("hidden")) {
            overlay.classList.add("hidden");
            TinyTube.App.activeLayer = "CONTROLS";
            PlayerControls.setActive(true);
        } else {
            if (Comments.isOpen()) Comments.close();
            el("captions-overlay").classList.add("hidden");
            const d = TinyTube.App.currentVideoData;
            if (!d) {
                TinyTube.Utils.toast("Loading video info...");
                return;
            }
            el("info-title").textContent = d.title || "";
            el("info-author").textContent = d.author || "";
            el("info-views").textContent = TinyTube.Utils.formatViews(d.viewCount);
            el("info-date").textContent = TinyTube.Utils.formatDate(d.published);
            el("info-description").textContent = d.description || "";
            overlay.classList.remove("hidden");
            TinyTube.App.activeLayer = "INFO";
        }
        HUD.refreshPinned();
    },
    scrollInfo: (direction) => {
        const overlay = el("video-info-overlay");
        if (overlay.classList.contains("hidden")) return;
        const delta = 80 * direction;
        overlay.scrollTop = TinyTube.Utils.clamp(overlay.scrollTop + delta, 0, overlay.scrollHeight);
    },
    stop: () => {
        const p = TinyTube.App.playerElements ? TinyTube.App.playerElements.player : el("native-player");
        if (TinyTube.App.currentVideoId && p.currentTime > 10) TinyTube.DB.savePosition(TinyTube.App.currentVideoId, p.currentTime, p.duration);
        p.pause(); p.src = ""; p.poster = ""; p.playbackRate = 1;
        el("enforcement-container").innerHTML = "";
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        el("quality-overlay").classList.add("hidden");
        el("chapters-overlay").classList.add("hidden");
        Comments.reset(); Comments.close();
        Player.stopRenderLoop();
        Player.cleanupEmbedResources();
        TinyTube.App.lastRenderSec = null;
        TinyTube.App.videoChapters = [];
        TinyTube.App.availableQualities = [];
        TinyTube.App.currentQuality = null;
        TinyTube.App.lastRenderDuration = null;
        TinyTube.App.currentStreamUrl = null;
        if (TinyTube.App.preloadAbortController) {
            TinyTube.App.preloadAbortController.abort();
            TinyTube.App.preloadAbortController = null;
        }
        TinyTube.App.upNext = [];
        TinyTube.App.seekKeyHeld = null;
        TinyTube.App.seekKeyTime = 0;
        HUD.renderUpNext();
        Player.clearCaptions();
        ScreenSaver.restore();
        TinyTube.EventBus.emit('player:state-change', 'stopped');
    }
};

const HUD = {
    show: () => {
        el("player-hud").classList.add("visible");
        if(TinyTube.App.hudTimer) clearTimeout(TinyTube.App.hudTimer);
        TinyTube.App.hudTimer = setTimeout(() => el("player-hud").classList.remove("visible"), CONFIG.HUD_AUTO_HIDE_MS);
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
    renderUpNext: () => {
        const container = el("up-next");
        const list = el("up-next-list");
        if (!container || !list) return;
        list.textContent = "";
        const items = TinyTube.App.upNext || [];
        if (!items.length) {
            container.classList.add("hidden");
            return;
        }
        container.classList.remove("hidden");
        items.slice(0, 5).forEach((item, idx) => {
            const row = TinyTube.Utils.create("div", "up-next-item");
            if (idx === 0) row.classList.add("is-next");
            row.appendChild(TinyTube.Utils.create("div", "up-next-title", item.title || "Untitled"));
            const metaText = [item.author, item.lengthSeconds ? TinyTube.Utils.formatTime(item.lengthSeconds) : ""]
                .filter(Boolean)
                .join(" • ");
            row.appendChild(TinyTube.Utils.create("div", "up-next-meta", metaText));
            list.appendChild(row);
        });
    },
    refreshPinned: () => {
        const overlayOpen = TinyTube.App.activeLayer !== "NONE" && TinyTube.App.activeLayer !== "CONTROLS";
        if(overlayOpen) {
            el("player-hud").classList.add("visible");
            if(TinyTube.App.hudTimer) clearTimeout(TinyTube.App.hudTimer);
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
        if(!TinyTube.App.currentVideoId || !TinyTube.App.api) return;
        if(!Comments.elements) Comments.cache();
        Comments.state.open = true;
        Comments.elements.overlay.classList.remove("hidden");
        el("video-info-overlay").classList.add("hidden");
        el("captions-overlay").classList.add("hidden");
        TinyTube.App.activeLayer = "COMMENTS";
        HUD.refreshPinned();
        if(Comments.state.videoId !== TinyTube.App.currentVideoId) {
            Comments.reset();
            Comments.state.open = true;
            Comments.elements.overlay.classList.remove("hidden");
            Comments.elements.list.textContent = "Loading...";
            Comments.state.videoId = TinyTube.App.currentVideoId;
            await Comments.loadPage();
        }
    },
    close: () => {
        if(!Comments.elements) Comments.cache();
        Comments.state.open = false;
        Comments.elements.overlay.classList.add("hidden");
        TinyTube.App.activeLayer = "CONTROLS";
        PlayerControls.setActive(true);
        HUD.refreshPinned();
    },
    toggle: () => Comments.isOpen() ? Comments.close() : Comments.open(),
    loadPage: async () => {
        if(Comments.state.loading) return;
        const requestedVideoId = TinyTube.App.currentVideoId;
        Comments.state.loading = true;
        Comments.elements.footer.classList.remove("hidden");
        try {
            const u = `${TinyTube.App.api}/comments/${requestedVideoId}${Comments.state.nextPage ? "?continuation="+Comments.state.nextPage : ""}`;
            const res = await TinyTube.Utils.fetchWithTimeout(u);
            if(!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();

            // Check if we're still on the same video
            if(Comments.state.videoId !== requestedVideoId) {
                console.log("Comments load cancelled: video changed");
                Comments.state.loading = false;
                return;
            }

            if(data.comments) {
                if(Comments.state.page===1) {
                    Comments.elements.list.textContent = "";
                    const count = data.commentCount || data.comments.length;
                    Comments.elements.count.textContent = count + " comment" + (count !== 1 ? "s" : "");
                }
                Comments.elements.page.textContent = "Page " + Comments.state.page;
                data.comments.forEach(function(c) {
                    var d = TinyTube.Utils.create("div", "comment-item");
                    var author = TinyTube.Utils.create("div", "comment-author");
                    author.textContent = c.author || "";
                    var text = TinyTube.Utils.create("div", "comment-text");
                    text.textContent = c.content || c.contentText || "";
                    d.appendChild(author);
                    d.appendChild(text);
                    Comments.elements.list.appendChild(d);
                });
            }
            Comments.state.nextPage = data.continuation;
            Comments.state.page++;
        } catch(e) {
            if(Comments.state.videoId === requestedVideoId) {
                Comments.elements.list.textContent = "Error loading comments.";
            }
        }
        Comments.state.loading = false;
        if(!Comments.state.nextPage) Comments.elements.footer.classList.add("hidden");
    },
    scroll: (dir) => {
        const l = Comments.elements.list;
        l.scrollTop = TinyTube.Utils.clamp(l.scrollTop + (140 * dir), 0, l.scrollHeight);
        if(dir>0 && l.scrollTop + l.clientHeight >= l.scrollHeight - 40) Comments.loadPage();
    }
};

const Captions = {
    index: 0, buttons: [],
    open: () => {
        TinyTube.App.activeLayer = "CAPTIONS";
        Player.openCaptionsMenu();
        Captions.buttons = Array.from(document.querySelectorAll(".captions-option"));
        Captions.index = Captions.buttons.findIndex(b => b.classList.contains("active"));
        if(Captions.index === -1) Captions.index = 0;
        Captions.updateFocus();
        HUD.refreshPinned();
    },
    close: () => {
        el("captions-overlay").classList.add("hidden");
        TinyTube.App.activeLayer = "CONTROLS";
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
                try {
                    if (TinyTube.App.supportsSmoothScroll) {
                        b.scrollIntoView({block:"center", behavior:"smooth"});
                    } else {
                        b.scrollIntoView({block:"center"});
                    }
                } catch(e) {
                    TinyTube.App.supportsSmoothScroll = false;
                    b.scrollIntoView(false);
                }
            }
            else b.classList.remove("focused");
        });
    },
    select: () => { if(Captions.buttons[Captions.index]) Captions.buttons[Captions.index].click(); Captions.close(); }
};

const PlayerControls = {
    ids: ["control-play","control-back","control-forward","control-quality","control-chapters","control-captions","control-language","control-comments","control-subscribe","control-watchlater","control-help"],
    buttons: [],
    actions: {
        "control-play": () => { const p=el("native-player"); if(TinyTube.App.playerMode==="BYPASS") p.paused?p.play():p.pause(); },
        "control-back": () => Player.seek("left"),
        "control-forward": () => Player.seek("right"),
        "control-quality": () => Quality.open(),
        "control-chapters": () => Chapters.open(),
        "control-captions": () => Player.toggleCaptions(),
        "control-language": () => Captions.open(),
        "control-comments": () => Comments.open(),
        "control-subscribe": () => { const i=TinyTube.App.currentVideoData; if(i) TinyTube.DB.toggleSub(i.authorId, i.author, TinyTube.Utils.getAuthorThumb(i)); },
        "control-watchlater": () => {
            const i=TinyTube.App.currentVideoData;
            if (!i) {
                TinyTube.Utils.toast("Loading video data...");
                return;
            }
            TinyTube.DB.addToWatchLater(i);
        },
        "control-help": () => Shortcuts.open()
    },
    init: () => {
        PlayerControls.buttons = PlayerControls.ids.map((id, idx) => {
            const btn = el(id);
            if(!btn) return null;
            btn.onclick = () => { TinyTube.App.playerControls.index=idx; PlayerControls.setActive(true); PlayerControls.runAction(id); };
            return btn;
        }).filter(Boolean);
    },
    setActive: (active) => {
        TinyTube.App.playerControls.active = active;
        TinyTube.App.activeLayer = active ? "CONTROLS" : "NONE";
        HUD.refreshPinned();
        TinyTube.UI.updateFocus();
    },
    move: (delta) => {
        const len = PlayerControls.buttons.length;
        TinyTube.App.playerControls.index = (TinyTube.App.playerControls.index + delta + len) % len;
        TinyTube.UI.updateFocus();
    },
    runAction: (id) => { if(PlayerControls.actions[id]) PlayerControls.actions[id](); },
    activateFocused: () => PlayerControls.runAction(PlayerControls.buttons[TinyTube.App.playerControls.index].id),
    updateFocus: () => {
        PlayerControls.buttons.forEach((b, i) => {
            if(TinyTube.App.playerControls.active && i === TinyTube.App.playerControls.index) b.classList.add("focused");
            else b.classList.remove("focused");
        });
    }
};

TinyTube.Quality = Quality;
TinyTube.Chapters = Chapters;
TinyTube.Shortcuts = Shortcuts;
TinyTube.Player = Player;
TinyTube.HUD = HUD;
TinyTube.ScreenSaver = ScreenSaver;
TinyTube.Comments = Comments;
TinyTube.Captions = Captions;
TinyTube.PlayerControls = PlayerControls;
})(window);
