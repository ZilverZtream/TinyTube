# TinyTube Pro (Tizen Edition)

![Platform](https://img.shields.io/badge/Platform-Samsung_Tizen-blue)
![Architecture](https://img.shields.io/badge/Architecture-Distributed_Client_State-orange)
![License](https://img.shields.io/badge/License-MIT-green)

**TinyTube Pro** is a privacy-first, serverless YouTube client designed for Samsung Tizen Smart TVs.

Unlike traditional clients that rely on Google's central authentication servers, TinyTube Pro implements a **Distributed Client-Side State Engine**. It aggregates content from a mesh of public APIs directly on the TV hardware, creating a personalized "Virtual Feed" without ever requiring a Google Login or tracking cookies.

---

## 🏆 Engineering Highlights

This project demonstrates **Resilient Frontend Architecture** in a constrained TV environment:

### 1. Client-Side "Virtual Database"
Instead of syncing with a remote server, the app manages user state (Subscriptions, Profiles, History) entirely in the TV's secure local storage (`localStorage`).
* **Privacy**: Zero data is sent to Google.
* **Speed**: O(1) profile switching with no network handshake.

### 2. Parallel Feed Aggregation (Map-Reduce)
The "Home" feed is not a single API endpoint. The **Feed Engine**:
1.  Reads the local subscription list.
2.  Fires $O(n)$ parallel asynchronous requests to the API mesh.
3.  Merges, sorts by date, and deduplicates results client-side.
* **Result**: A generated "Subscribed Feed" that feels native but exists only on the device.

### 3. Network Resilience & Latency Arbitration
On boot, the `Network.connect()` module performs a race-condition latency check against a hardcoded list of high-uptime Invidious/Piped instances (Nadeko, Yewtu, etc.). It automatically routes traffic through the fastest, healthiest node.

### 4. Dual-Mode Playback Engine
* **Bypass Mode (Default)**: Plays raw `.mp4` streams directly via HTML5. Ad-injection scripts are physically impossible to execute.
* **Enforcement Mode (Fallback)**: A sandboxed IFrame implementation of the official player, used as a failover if public APIs go dark.

---

## ✨ Key Features

* **🚫 Ad-Block & SponsorBlock**: Auto-skips in-video sponsor segments, intros, and reminders.
* **🛑 DeArrow Integration**: Replaces clickbait thumbnails and sensationalized titles with community-sourced, factual alternatives in real-time.
* **👤 Multi-Profile Support**: Switch between local user profiles (e.g., "Dad", "Kid") with separate subscription lists.
* **📺 Leanback UI**: A fully native "10-foot UI" experience optimized for TV remotes using Spatial Navigation logic.
* **🔍 Universal Search**: Search for both Videos and Channels to subscribe.

---

## 🛠️ Installation Guide

TinyTube Pro is a standard Tizen Web Widget (`.wgt`). No "Developer Mode" root hacks are required if using Tizen Studio.

### Prerequisites
* **Samsung TV** (Tizen 4.0 or higher recommended)
* **Tizen Studio** (installed on PC/Mac)

### Build & Deploy
1.  **Create Project**: Open Tizen Studio -> `File` -> `New` -> `Tizen Project` -> `Template` -> `TV` -> `Web Application`.
2.  **Import Files**: Delete the default template files. Copy `config.xml`, `index.html`, `style.css`, `main.js`, and `icon.png` into the project root.
3.  **Connect TV**: Use "Remote Device Manager" to connect your TV (Ensure TV and PC are on the same Wi-Fi).
4.  **Run**: Right-click the project -> `Run As` -> `Tizen Web Application`.

---

## 🎮 Controls

| Remote Key | Action |
| :--- | :--- |
| **Arrows** | Navigate Grid / Menu |
| **Enter / OK** | Play Video / Open Menu / Keyboard |
| **Back / Return** | Close Player / Exit App |
| **Blue Button (D)** | **Subscribe** / Unsubscribe to focused channel |
| **Red Button (A)** | **Toggle Enforcement Mode** (Live Compare) |
| **Play/Pause** | Media Controls |

---

## ⚙️ Configuration

### Switching Profiles
1.  Navigate to **Settings** in the sidebar.
2.  Click **"Switch Profile"**.
3.  The app reloads with the new user's local database.

### Custom API (Power Users)
If the public mesh network is slow, you can host your own Invidious instance (or use a private one).
1.  Go to **Settings**.
2.  Enter your URL in **Custom API** (e.g., `http://192.168.1.50:3000/api/v1`).
3.  Click **Save & Reboot**.

---

## ⚠️ Comparison Demo (For Class)

For the engineering demonstration, use the **Red Button** during playback to toggle the renderer:

1.  **Bypass Mode (Green Badge)**:
    * *Networking*: Fetching raw `.mp4` from proxy.
    * *Ads*: None.
    * *Privacy*: High.
2.  **Enforcement Mode (Red Toast)**:
    * *Networking*: Loads Google's heavy JS player.
    * *Ads*: Server-side injected (Unskippable).
    * *Privacy*: Low (Google tracking active).

---

## 📄 License

This project is for educational and research purposes.
MIT License.
