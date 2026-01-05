(function(global) {
    const TinyTube = global.TinyTube = global.TinyTube || {};
    const CONFIG = TinyTube.CONFIG;
    const Utils = TinyTube.Utils;
    const SafeStorage = TinyTube.SafeStorage;
    const el = TinyTube.el;

// --- NEW: CIPHER ENGINE (Command Based) ---
const Cipher = {
    ops: {
        r: (a) => a.reverse(),
        s: (a, i) => { 
            const t = a[0]; 
            a[0] = a[i % a.length]; 
            a[i % a.length] = t; 
        },
        sl: (a, i) => a.splice(0, i)
    },
    decipher: (sig, seq) => {
        if (!sig || !seq) return sig;
        const chars = sig.split("");
        seq.split(",").forEach(inst => {
            const op = inst.match(CONFIG.REGEX_CIPHER_OP);
            if (op) {
                const func = Cipher.ops[op[1]];
                const arg = parseInt(op[2], 10);
                if (func) func(chars, isNaN(arg) ? 0 : arg);
            }
        });
        return chars.join("");
    }
};

// --- IMPROVED: ROBUST CIPHER BREAKER (v2.0) ---
const CipherBreaker = {
    cache: null,

    // Patterns to find the main decipher function (scramble function)
    // We look for the signature: split("") -> loop/operations -> join("")
    funcPatterns: [
        // Standard pattern: a=a.split("");...return a.join("")
        /\b[a-zA-Z0-9$]{2,}\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\);([a-zA-Z0-9$]+)\.[a-zA-Z0-9$]+\(a,\d+\)/,
        // Alternate pattern: a=a.split("");...a.join("") (no return)
        /\b[a-zA-Z0-9$]{2,}\s*=\s*function\(\s*a\s*\)\s*\{\s*a\s*=\s*a\.split\(\s*""\s*\);([^}]+);return\s+a\.join\(\s*""\s*\)/,
        // Fallback: Just look for the body structure
        /function\(\w+\)\{a=a\.split\(""\);([^}]+);return a\.join\(""\)\}/
    ],

    getCache: () => {
        const cached = Utils.safeParse(SafeStorage.getItem(CONFIG.CIPHER_CACHE_KEY), null);
        if (cached && cached.seq && cached.expiresAt && cached.expiresAt > Date.now()) {
            CipherBreaker.cache = cached.seq;
            return cached.seq;
        }
        return null;
    },

    setCache: (seq) => {
        CipherBreaker.cache = seq;
        SafeStorage.setItem(CONFIG.CIPHER_CACHE_KEY, JSON.stringify({
            seq,
            expiresAt: Date.now() + CONFIG.CIPHER_CACHE_TTL
        }));
    },

    proxyUrl: (target) => {
        if (!CONFIG.CIPHER_PROXY) return target;
        return CONFIG.CIPHER_PROXY.includes("{url}")
            ? CONFIG.CIPHER_PROXY.replace("{url}", encodeURIComponent(target))
            : CONFIG.CIPHER_PROXY + encodeURIComponent(target);
    },

    run: async () => {
        if (CipherBreaker.cache) return CipherBreaker.cache;
        const cached = CipherBreaker.getCache();
        if (cached) return cached;

        try {
            console.log("CipherBreaker: Fetching player.js...");

            // Use a highly reliable, unrestricted video ID to fetch the player script
            const videoId = "jNQXAC9IVRw"; // "Me at the zoo" - YouTube's first video
            const vidRes = await Utils.fetchWithTimeout(
                CipherBreaker.proxyUrl(`https://www.youtube.com/watch?v=${videoId}`)
            );
            const vidText = await vidRes.text();

            const playerUrlMatch = vidText.match(/\/s\/player\/[a-zA-Z0-9]+\/[a-zA-Z0-9_.]+\/[a-zA-Z0-9_]+\/base\.js/);
            if (!playerUrlMatch) throw new Error("No player.js url found");

            const playerRes = await Utils.fetchWithTimeout(
                CipherBreaker.proxyUrl("https://www.youtube.com" + playerUrlMatch[0])
            );
            const raw = await playerRes.text();

            let funcBody = null;
            let helperName = null;

            // 1. Find the main decipher function using multiple regex strategies
            for (const pattern of CipherBreaker.funcPatterns) {
                const match = raw.match(pattern);
                if (match) {
                    if (pattern.source.includes("return")) {
                        // Patterns with 'return' capture the function body or operations
                        funcBody = match[1] || match[0];
                        // Extract helper name from within the body (e.g., "AB.xy(a,3)")
                        const helperMatch = funcBody.match(/([a-zA-Z0-9$]+)\.[a-zA-Z0-9$]+\(a/);
                        if (helperMatch) helperName = helperMatch[1];
                    } else {
                        // First pattern captures both function and helper name directly
                        funcBody = match[0];
                        helperName = match[1];
                    }
                    if (funcBody && helperName) break;
                }
            }

            if (!funcBody || !helperName) {
                console.log("CipherBreaker: Regex failed, trying simple fallback");
                return CipherBreaker.parseManual(raw);
            }

            // 2. Extract the Helper Object Definition
            const escapedName = helperName.replace(/\$/g, "\\$");

            // Look for standard declaration: var/const/let Name = { ... };
            const helperRegex = new RegExp(`(?:var|const|let)\\s+${escapedName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
            let helperMatch = raw.match(helperRegex);

            // Fallback: Look for assignment without keyword: Name = { ... };
            if (!helperMatch) {
                const looseHelperMatch = raw.match(new RegExp(`${escapedName}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
                if (!looseHelperMatch) throw new Error("Helper object not found");
                helperMatch = looseHelperMatch;
            }

            // 3. Parse and solve
            return CipherBreaker.parseFromText(funcBody, helperMatch[1], helperName);

        } catch (e) {
            console.log("CipherBreaker fail: " + e.message);
            return CONFIG.DEFAULT_CIPHER;
        }
    },

    // Parse operations by analyzing code logic (Semantic Parsing)
    parseFromText: (funcBody, helperContent, helperName) => {
        const opsMap = {};

        // FIXED: Robust Regex for both old and modern syntax
        // Matches: "key:function(a){...}" AND "key(a){...}" (ES6 shorthand)
        const funcRegex = /(\w+)\s*(?::\s*function)?\s*\(([^)]*)\)\s*\{([^}]*)\}/g;

        let match;
        while ((match = funcRegex.exec(helperContent)) !== null) {
            const funcName = match[1];
            const body = match[3];

            if (body.includes('.reverse(')) {
                opsMap[funcName] = "r";
            } else if (body.includes('.splice') || body.includes('splice(')) {
                opsMap[funcName] = "sl";
            } else if (body.includes('%') && body.includes('.length')) {
                opsMap[funcName] = "s";
            }
        }

        // FIXED: Validate we found enough operations
        if (Object.keys(opsMap).length < 2) {
            throw new Error(`Failed to identify enough operations (found ${Object.keys(opsMap).length})`);
        }

        // Build the operation sequence from the decipher function body
        const cmds = [];
        const stmts = funcBody.split(";");
        const escapedHelper = helperName.replace(/\$/g, "\\$");

        for (const stmt of stmts) {
            // Find calls like "Helper.method(a, 123)"
            const methodMatch = stmt.match(new RegExp(`${escapedHelper}\\.([a-zA-Z0-9$]+)\\(`));

            if (methodMatch && opsMap[methodMatch[1]]) {
                const opCode = opsMap[methodMatch[1]];
                const argMatch = stmt.match(/\(a\s*,\s*(\d+)\)/);
                const arg = argMatch ? argMatch[1] : "";
                cmds.push(opCode + arg);
            }
        }

        // FIXED: Validate we extracted operations
        if (cmds.length === 0) {
            throw new Error("No operations extracted from decipher function");
        }

        const seq = cmds.join(",");
        console.log("CipherBreaker: Solved -> " + seq);
        CipherBreaker.setCache(seq);
        return seq;
    },

    // IMPROVED: Emergency manual fallback with better error handling
    parseManual: (raw) => {
        try {
            const bodies = raw.split("function");
            for (const body of bodies) {
                // Heuristic: Decipher function contains both split("") and join("")
                if (body.includes('split("")') && body.includes('join("")')) {
                    const cmds = [];
                    const lines = body.split(";");
                    for (const l of lines) {
                        if (l.includes("reverse")) cmds.push("r");
                        else if (l.includes("splice")) {
                            const arg = l.match(/(\d+)/);
                            cmds.push("sl" + (arg ? arg[1] : "0"));
                        }
                        else if (l.includes("[0]") && l.includes("%")) {
                            const arg = l.match(/(\d+)/);
                            cmds.push("s" + (arg ? arg[1] : "0"));
                        }
                    }
                    if (cmds.length > 0) {
                        const seq = cmds.join(",");
                        console.log("CipherBreaker: Manual fallback -> " + seq);
                        return seq;
                    }
                }
            }
        } catch (e) {
            console.log("CipherBreaker: Manual parse error - " + e.message);
        }
        return CONFIG.DEFAULT_CIPHER;
    }
};

// --- 2. EXTRACTOR (Modified to use Cipher Engine) ---
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
    resolveFormatUrl: (format) => {
        if (!format) return "";
        if (format.url) return format.url;
        if (format.signatureCipher) {
            const parsed = Extractor.parseCipher(format.signatureCipher);
            if (!parsed || !parsed.url) return "";
            if (parsed.sig) return `${parsed.url}&${parsed.sp}=${parsed.sig}`;
            if (parsed.s) {
                // UPDATE: Use the Cipher Engine with cache-first strategy
                const sequence = CipherBreaker.cache || CONFIG.CIPHER_SEQUENCE;
                const deciphered = Cipher.decipher(parsed.s, sequence);
                return `${parsed.url}&${parsed.sp}=${deciphered}`;
            }
        }
        return "";
    },
    extractInnertube: async (videoId, signal = null) => {
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
            const fetchOptions = {
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
            };
            if (signal) fetchOptions.signal = signal;
            const res = await Utils.fetchWithTimeout("https://www.youtube.com/youtubei/v1/player", fetchOptions, 12000);
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

const Network = {
    connect: async () => {
        const custom = SafeStorage.getItem("customBase");
        if (custom && Utils.isValidUrl(custom)) {
            TinyTube.App.api = custom;
            el("backend-status").textContent = "API: Custom";
        } else {
            TinyTube.App.api = CONFIG.PRIMARY_API;
            el("backend-status").textContent = "API: Perditum";
        }
        TinyTube.Feed.loadHome();
    }
};

TinyTube.Cipher = Cipher;
TinyTube.CipherBreaker = CipherBreaker;
TinyTube.Extractor = Extractor;
TinyTube.Network = Network;
})(window);
