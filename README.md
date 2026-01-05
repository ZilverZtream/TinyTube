<div align="center">
  <img src="icon.png" alt="TinyTube Logo" width="128" height="128">
</div>

# TinyTube Pro (v11.1)

**YouTube Client for Legacy Tizen TVs (2017+).**

TinyTube Pro is a high-performance, ad-free YouTube client engineered specifically for Tizen 4.0 (Chromium 56) environments. It bridges the gap between ancient hardware and modern YouTube anti-bot defenses using advanced client-side extraction and stealth emulation.

![Version](https://img.shields.io/badge/version-11.1.0-blue) ![Platform](https://img.shields.io/badge/platform-Tizen%204.0%2B-green) ![License](https://img.shields.io/badge/license-MIT-orange)

---

## 🚀 Key Features

### 🛡️ "Stealth Mode" Engine (New in v10+)
* **Android Client Emulation:** Impersonates the official YouTube Android App (v20.51.39) to bypass Google's "Sign in to confirm you're not a bot" checks.
* **Direct 1080p Streaming:** Fetches unthrottled MP4/DASH streams directly from Google servers using the internal Protobuf-JSON API (`/youtubei/v1`).
* **No API Keys Required:** Uses the "Stealth" method (no public key in URL) to remain undetected.

### ⚡ Performance
* **60 FPS UI Loop:** Render loop decoupled from network activity using `requestAnimationFrame`.
* **O(1) LRU Caching:** Custom Double-Linked List memory management for instant navigation.
* **Binary Search Skipping:** Instant SponsorBlock segment processing (O(log n)).
* **Request Deduplication:** Prevents network congestion when mashing remote buttons.

### 📺 Playback Experience
* **Ad-Free:** Native blocking of all video ads and tracking pixels.
* **SponsorBlock:** Auto-skips Sponsors, Intros, Outros, and Self-Promotion.
* **DeArrow:** Replaces clickbait thumbnails and titles with community-crowdsourced accurate versions.
* **Resume Watching:** Locally saves playback position for the last 50 videos.
* **Playback Speed:** Toggle between 0.5x, 1.0x, 1.25x, 1.5x, and 2.0x.
* **Captions:** Full subtitle support (direct from Google).

---

## 🏗️ Architecture: "The 2026 Standard"

TinyTube Pro uses a **3-Stage Waterfall Strategy** to guarantee playback resilience:

1.  **Stage 1: Primary (Invidious Perditum)**
    * Connects to the high-health `inv.perditum.com` instance.
    * Fastest response time, strips tracking, delivers clean proxy URLs.
2.  **Stage 2: Secondary (Innertube Stealth)**
    * If the API fails, the app switches to **Client-Side Extraction**.
    * It emulates an Android device to negotiate directly with YouTube's private API.
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
* **Custom API:** Override the internal fallback list with your own Invidious instance URL.
* **Switch Profile:** Toggle between 3 local profiles (separate Watch History/Subs).

---

## 📝 Credits & Acknowledgments

* **Invidious Project:** For the open-source API powering the primary feed.
* **Ajay Ramachandran:** For the SponsorBlock and DeArrow APIs.
* **Reverse Engineering Community:** For the Android Client emulation parameters.
* **The "Professor":** For pushing the architecture from simple scraping to robust emulation.

---

*Built with ❤️ (and pure Vanilla JS) for the Tizen Community.*
