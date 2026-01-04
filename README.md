TinyTube Pro (Tizen Edition)
TinyTube Pro is a lightweight, privacy-focused YouTube client designed for Samsung Tizen Smart TVs.

Unlike traditional clients that rely on Google's central servers or complex self-hosted middleware (like Docker containers), TinyTube Pro implements a Distributed Client-Side State Engine. It aggregates content from decentralized public APIs directly on the TV hardware, rendering a personalized, ad-free experience without ever requiring a Google Login.

🏆 Engineering Highlights (Class Project 2026)
This project demonstrates Resilient Frontend Architecture in a constrained TV environment:

Client-Side "Virtual Database":

The app manages user state (Subscriptions, History, Profiles) entirely in the TV's secure local storage.

Benefit: 100% Privacy. Google cannot track viewing habits; no OAuth tokens are ever exchanged.

Parallel Feed Aggregation (Map-Reduce):

Instead of querying a single "Feed" endpoint, the Feed Engine fires O(n) parallel async requests to multiple content sources for subscribed channels.

It merges, sorts, and deduplicates the results client-side in milliseconds using Promise.all.

Network Resilience & Latency Arbitration:

On boot, the Network.connect() module performs a race-condition latency check against a mesh of public Invidious instances (Nadeko, Yewtu, etc.).

The app automatically routes traffic through the fastest, healthiest node, bypassing regional blocks or API outages.

Dual-Mode Playback Engine:

Bypass Mode (Default): Plays raw MP4 streams directly. Ad-injection scripts are physically impossible to execute.

Enforcement Mode (Fallback): A sandboxed IFrame implementation of the official player, used as a failover if public APIs go dark.

✨ Features
🚫 Ad-Block & SponsorBlock: Auto-skips in-video sponsor segments, intros, and reminders.

🛑 DeArrow Integration: Replaces clickbait thumbnails and sensationalized titles with community-sourced, factual alternatives in real-time.

👤 Multi-Profile Support: Switch between local user profiles (e.g., "Dad", "Kid") with separate subscription lists.

📺 Leanback UI: A fully native "10-foot UI" experience optimized for TV remotes.

🕵️‍♂️ Anonymous Subscription: Subscribe to channels without a Google Account.

🔍 Universal Search: Search for both Videos and Channels.

🛠️ Installation Guide
TinyTube Pro is a standard Tizen Web Widget (.wgt). You do not need "Developer Mode" hacks if you have Tizen Studio.

Prerequisites

Samsung TV (Tizen 4.0 or higher recommended)

Tizen Studio (installed on PC/Mac)

Build & Deploy

Clone the Repo or download the source files.

Open Tizen Studio.

Go to File -> New -> Tizen Project -> Template -> TV -> Web Application.

Select "Basic Project" and name it TinyTubePro.

Replace Files: Delete the default files in the new project and paste in the files from this repo:

config.xml

index.html

style.css

main.js

icon.png (Ensure you have a 128x128 png)

Connect TV: Ensure your TV and PC are on the same Wi-Fi. Use "Remote Device Manager" in Tizen Studio to connect.

Run: Right-click the project -> Run As -> Tizen Web Application.

🎮 Controls
Remote Key	Action
Arrows	Navigate Grid / Menu
Enter / OK	Play Video / Open Menu
Back / Return	Close Player / Exit App
Blue Button (D)	Subscribe / Unsubscribe to current channel
Red Button (A)	Toggle Enforcement Mode (Live Compare)
Play/Pause	Media Controls
⚙️ Configuration
Switching Profiles

Navigate to Settings in the sidebar.

Click "Switch Profile".

The app reloads with the new user's local database.

Custom API (Power Users)

If the public mesh network is slow, you can host your own Invidious instance (or use a private one).

Go to Settings.

Enter your URL in Custom API (e.g., http://192.168.1.50:3000/api/v1).

Click Save & Reboot.

⚠️ Comparison: Bypass vs. Enforcement
For the class demonstration, use the Red Button during playback.

Bypass Mode (Green Badge):

Networking: Fetching raw .mp4 from proxy.

Ads: None.

Privacy: High.

Enforcement Mode (Red Toast):

Networking: Loads Google's heavy JS player.

Ads: Server-side injected (Unskippable).

Privacy: Low (Google tracking active).

📄 License
This project is for educational and research purposes. MIT License.
