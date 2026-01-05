<div align="center">
  <img src="default.png" alt="TinyTube Logo" width="128" height="128">
</div>

# TinyTube Pro (v11.4)

**YouTube Client for Samsung Tizen TVs (2017–2026).**

TinyTube Pro is a performance-focused YouTube client built for Samsung Tizen TVs from 2017 through 2026. It combines an Invidious-backed feed with direct YouTube playback extraction and a native embed fallback to keep older TVs usable.

![Version](https://img.shields.io/badge/version-11.4.0-blue) ![Platform](https://img.shields.io/badge/platform-Tizen%202017%E2%80%932026-green) ![License](https://img.shields.io/badge/license-MIT-orange)

---

## 🚀 Key Features

### 🛡️ Playback & Extraction
* **Innertube Direct Playback:** Uses YouTube’s `/youtubei/v1/player` endpoint with Android client parameters (v20.51.39).
* **Cipher Breaker + Engine:** Auto-downloads `player.js` to build a decipher sequence, with cached fallbacks.
* **Native Embed Fallback:** Falls back to the YouTube iframe player for edge cases or restricted videos.

### ⚡ Performance
* **Virtualized Grid:** Card pooling + virtual scroll to reduce DOM load.
* **Service Worker Caching:** Short-lived API cache for trending data.
* **Web Worker Parsing:** Large JSON responses parsed off the main thread.
* **Preload Next Video:** Autoplay prefetch at ~80% playback.

### 📺 Playback Experience
* **SponsorBlock:** Auto-skips Sponsors, Intros, Outros, and Self-Promotion.
* **DeArrow:** Replaces clickbait thumbnails and titles with community-crowdsourced accurate versions.
* **Resume Watching:** Stores playback position per profile.
* **Playback Speed:** 0.5x → 2.0x.
* **Quality Picker:** Manual stream quality selection.
* **Chapters:** Parse chapter timestamps from descriptions.
* **Captions:** VTT subtitle support pulled from YouTube.

### 🧭 Browsing & Library
* **Home / Trending / Subscriptions:** Invidious-backed feeds with trending categories.
* **Search Filters:** Sort, date, duration, and type filters.
* **Watch Later & History:** Local queues with profile separation.
* **Profiles:** Three local profiles with independent settings.

---

## 🏗️ Architecture

TinyTube Pro uses a **3-Stage Waterfall Strategy** to keep playback reliable:

1.  **Stage 1: Primary (Invidious Perditum)**
    * Connects to the high-health `inv.perditum.com` instance.
    * Fastest response time, strips tracking, delivers clean proxy URLs.
2.  **Stage 2: Secondary (Innertube Stealth)**
    * If the API fails, the app switches to **Client-Side Extraction** via `/youtubei/v1/player`.
    * Emulates the Android client and resolves stream signatures on-device.
3.  **Stage 3: Fallback (Native Embed)**
    * If all else fails (e.g., Age-Gated content), it loads the official YouTube Iframe player.

---

## 🎮 Controls

Designed for standard IR Remotes.

| Key | Action |
| :--- | :--- |
| **D-Pad** | Navigate Grid / Menu |
| **Enter / OK** | Play Video / Open Keyboard |
| **Back / Return** | Go Back / Stop Video / Exit (Double Press) |
| **Play/Pause** | Toggle Playback |
| **Left / Right** | Seek 10s (Hold for 30s/60s acceleration) |
| **Red (A)** | **Force Embed Mode** (Use if video fails) |
| **Green (B)** | *Cycle Playback Speed* |
| **Yellow (C)** | **Toggle Video Info** (Description/Metadata) |
| **Blue (D)** | **Subscribe** / Unsubscribe |
| **Info / Guide** | Toggle Captions |
| **Chan Up/Down** | Scroll Comments / Info Overlay |

---

## 🛠️ Installation

### Prerequisites
* **Tizen Studio** (with TV Extensions 4.0 or higher).
* Samsung TV (2017 model or newer) with Developer Mode enabled.

### Steps
1.  Clone this repository.
2.  Open **Tizen Studio**.
3.  File -> Import -> Tizen -> Tizen Project.
4.  Select the `TinyTube` folder.
5.  Right-click project -> **Build Signed Package**.
6.  Connect your TV via Device Manager.
7.  Right-click project -> **Run As** -> **Tizen Web Application**.

---

## ⚙️ Configuration

The app is zero-config out of the box, but you can customize it via the **Settings** tab (Gear Icon):

* **Profile Name:** Change the display name for the local user.
* **Custom API:** Override the default Invidious API base URL.
* **Max Resolution:** Set a preferred top quality for stream selection.
* **Autoplay:** Enable or disable auto-playback.
* **Switch Profile:** Toggle between 3 local profiles (separate Watch History/Subs).

---

## 📝 Credits & Acknowledgments

* **Invidious Project:** For the open-source API powering the primary feed.
* **Ajay Ramachandran:** For the SponsorBlock and DeArrow APIs.
* **Reverse Engineering Community:** For the Android Client emulation parameters.
* **The "Professor":** For pushing the architecture from simple scraping to robust emulation.

---

*Built with ❤️ (and pure Vanilla JS) for the Tizen Community.*
