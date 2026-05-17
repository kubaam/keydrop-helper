# KeyDrop Helper — Depositor Giveaways Sorter

> **GUI Chrome extension** for **key-drop.com** and **keydrop.com** that sorts **depositor giveaways** (the user-created giveaways requiring a minimum deposit), auto-clicks "Load more", and shows live stats — all in a clean popup UI.

<p align="center">
  <img src="gui.png" alt="KeyDrop Helper popup — Connected status, auto Load more toggle, Sort by frequency + value with LIVE badge, live stats showing 1.5k cards, 214 users, top frequency 80 (@cachorro1337), and Load once / Sort now action buttons" width="360">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-UNOFFICIAL-red" alt="Unofficial">
  <img src="https://img.shields.io/badge/use-AT%20YOUR%20OWN%20RISK-orange" alt="Use at your own risk">
  <img src="https://img.shields.io/badge/version-2.4.0-6366f1" alt="Version 2.4.0">
  <img src="https://img.shields.io/badge/Chrome-MV3-22c55e" alt="Chrome Manifest V3">
  <img src="https://img.shields.io/badge/site-key--drop.com-FFCB77" alt="Works on key-drop.com">
  <img src="https://img.shields.io/badge/site-keydrop.com-FFCB77" alt="Works on keydrop.com">
</p>

> [!WARNING]
> **This is an unofficial, fan-made extension. Use at your own risk.**
> Not affiliated with, endorsed by, or supported by Key-Drop, KeyDrop, Valve, or Steam. The author provides no warranty and assumes no liability for any account action, data loss, or other consequence resulting from its use. **18+ only. Play responsibly.**

---

## What it does

KeyDrop Helper is a **GUI browser extension** (Chrome / Edge / Brave) built for the CS2 (CS:GO) skin giveaway platform **Key-Drop** — specifically for the **depositor giveaways** page, where every card is a giveaway from a creator/user that requires a minimum deposit to enter. The page can contain thousands of these cards, and the same creator often posts dozens of giveaways back-to-back. This extension makes that browsable.

It automates two things that are tedious to do by hand:

1. **Auto Load more** — continuously clicks the "Load more" button at the bottom of the depositor giveaways feed so every active giveaway loads without endless scrolling and clicking.
2. **Sort depositor giveaways** — visually groups the cards by **username frequency**, then by **Total Value** inside each group, so you can spot which depositors are spamming the most giveaways at a glance and which of their drops are the most valuable.

A small popup gives you a live count of visible cards, unique depositors, and the top user's posting frequency.

## Features

- **Auto "Load more"** with a hard **1-second delay between clicks** so the site doesn't rate-limit you with the "Something went wrong" error overlay.
- **Smooth in-place sort** — only the cards that are actually out of position are moved (`insertBefore` diff walk). No flicker, no re-render of the whole list.
- **Live stats**: visible cards, unique usernames, top frequency, and the name of the top user. Numbers flash purple when they change.
- **LIVE badge** with a pulsing green dot when auto-sort is active.
- **iOS-style toggle switches**, smooth fade-in animations, modern gradient background.
- **Sort now** / **Load once** action buttons for manual triggers.
- **Site error detection** — when KeyDrop shows "Something went wrong / An unexpected error has occurred / Try again", the extension pauses auto-load for 5 seconds and clicks the page's own "Try again" button to recover.
- **Self-healing** — re-binds the card list when KeyDrop swaps it (SPA navigation, skeleton-fill load-more), pauses both loops when the tab is hidden, and pushes live stats to the popup roughly twice per second.
- **Auto-injects** the content script if the tab was loaded before the extension was installed, so you don't have to manually refresh the KeyDrop tab.
- **No telemetry, no tracking, no external requests.** Everything runs locally in your browser.
- **Domain-scoped** — only runs on `key-drop.com` and `keydrop.com` subdomains.

## Install (unpacked)

1. **Download** this repo as a ZIP (green "Code" button at the top right → "Download ZIP") and extract it, or clone it:
   ```
   git clone https://github.com/kubaam/keydrop-helper.git
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked** and select the `keydrop-helper` folder.
5. The KeyDrop Helper icon appears in your toolbar. Pin it for easy access.

## Usage

1. Visit [key-drop.com/giveaways](https://key-drop.com/en/giveaways/list) (or `keydrop.com` — both work).
2. Click the KeyDrop Helper toolbar icon to open the popup.
3. Toggle **Auto "Load more"** to start loading every active giveaway.
4. Toggle **Sort by frequency + value** to group cards by the user posting them.
5. Watch the LIVE stats update in real time.
6. Use **Load once** for a single Load More click, or **Sort now** to force a re-sort immediately.

Both toggles persist across browser restarts (stored via `chrome.storage.local`).

## Sort logic

Cards are grouped by **lowercased username** as the primary key.

1. Inside each group, items are sorted by **Total Value descending**.
2. Groups themselves are sorted by:
   - **Frequency descending** (most posts first), then
   - **Highest Total Value in group descending** (ties broken by biggest single giveaway), then
   - **Username ascending** (numeric-aware, locale-aware).

The final flat order is applied to the live DOM with a minimum-move algorithm — only nodes that are not already in their target position get moved.

## How it stays fast

- **Scoped MutationObserver** on the giveaway list (`[data-testid="div-user-giveaways-list-section"]`), not the whole page body.
- **Filtered mutations** — only `<a>` and `<li>` additions/removals trigger a sort; image loads, hover state changes, and other noise are ignored.
- **Body observer** kept alive as a self-healer for SPA re-renders, throttled to 300 ms callbacks and cheap when the list is still mounted.
- **IntersectionObserver** on the Load More button — clicks only fire when the button is actually visible on screen.
- **Page Visibility API** — when the tab is hidden, both loops pause; resume on return.
- **Throttle floor** of 150 ms between consecutive sorts to prevent thrash on bursty mutations.
- **Stats pusher** runs every 700 ms regardless of toggle state, so the popup is always live.

## Compatibility

- **Browsers**: Chrome, Microsoft Edge, Brave, Opera, Vivaldi, Arc — anything Chromium-based that supports **Manifest V3**.
- **Sites**: `key-drop.com`, `keydrop.com`, including all subdomains (`www`, `eu`, etc.).
- **OS**: Windows, macOS, Linux (extension runs in the browser, OS doesn't matter).

## Tech

- **Manifest V3** Chrome extension — no background service worker, content script + popup only.
- **Vanilla JavaScript**, no frameworks, no build step, no dependencies.
- **Permissions**: `storage`, `activeTab`, `tabs`, `scripting`. Host permissions limited to KeyDrop domains.
- **Tested** on Chrome 120+ and Edge 120+ on Windows.

## Project structure

```
keydrop-helper/
├── manifest.json     # MV3 manifest, host_permissions, content_scripts
├── content.js        # Sort engine, observers, auto-load loop, site error detection
├── popup.html        # Popup UI (toggles, stats, action buttons)
├── popup.js          # Popup logic, polling, auto-inject fallback
├── gui.png           # Screenshot for README
└── README.md
```

## Changelog (highlights)

- **v2.4.0** — Popup auto-injects the content script via `chrome.scripting` if the tab predates the extension install. No more "Reload the KeyDrop tab" friction.
- **v2.3.0** — Targets `<ul data-testid="div-user-giveaways-list-section">` directly. List observer upgraded to `subtree: true` with `<a>`/`<li>` filter to catch KeyDrop's skeleton-fill load-more pattern. Renamed busy attribute to `data-kdh-busy` to avoid collision with the site's own attribute.
- **v2.2.0** — Manifest wildcards for all subdomains. Site error overlay detection with auto "Try again" click. 1-second mandatory delay after each Load More click.
- **v2.1.0** — Smooth in-place reorder (no flicker), scoped MutationObserver, IntersectionObserver for Load More, page-visibility pause, live stats in popup, modern UI with toggle switches and LIVE badge.
- **v2.0.0** — Domain-scoped permissions, popup tab-scope detection, robust money parsing, fallback selectors, mutation observer + debounced sort.

## Privacy

KeyDrop Helper makes **zero network requests**. It only reads and rearranges the DOM of pages you visit on the KeyDrop domains. Your toggle preferences are stored in `chrome.storage.local`, which never leaves your machine. No analytics, no tracking pixels, no external scripts.

## Disclaimer — Unofficial, Use at Your Own Risk

This is an **unofficial, fan-made, third-party** browser extension. It is **not affiliated with, endorsed by, sponsored by, or supported by** Key-Drop, KeyDrop, KeyDrop.com, Valve, Steam, or any related entity.

**Use at your own risk.** The extension:

- Is provided **as-is**, with **no warranty** of any kind, express or implied.
- Comes with **no guarantee of fitness for any particular purpose**, no guarantee of compatibility with future versions of the KeyDrop website, and no guarantee that it won't break unexpectedly.
- May trigger anti-automation measures, rate limiting, account flags, or other actions from the KeyDrop website — **the author assumes no responsibility** for any account suspension, ban, loss of items, loss of balance, or any other consequence arising from its use.
- Only automates clicks and reorders DOM elements that are already visible to the user. It does **not** bypass any security, payment, or anti-cheat system. Even so, automation may violate the KeyDrop Terms of Service — **review their ToS before using this extension** and stop using it if it conflicts with their rules.
- Is intended for **personal, non-commercial use** only.

**18+ only. Play responsibly.** Skin gambling can be addictive — if it stops being fun, stop playing. Helplines and resources are available in most countries.

## License

This project does not yet ship with a license file. All rights reserved by the author until a license is added.

---

**Keywords:** KeyDrop depositor giveaways sorter, KeyDrop depositors giveaways, depositor giveaways sort, depositors giveaways extension, KeyDrop giveaways sorter, key-drop depositor sort, KeyDrop GUI extension, KeyDrop user giveaways, KeyDrop creator giveaways, KeyDrop minimum deposit, sort by deposit, key-drop, keydrop, key-drop.com, keydrop.com, KeyDrop extension, KeyDrop helper, KeyDrop auto load more, KeyDrop sort, KeyDrop giveaways, KeyDrop tools, CS2 skins, CS:GO skins, CSGO skins, Counter-Strike skins, Steam skins, giveaway sorter, browser extension, Chrome extension, Edge extension, Brave extension, Manifest V3, MV3, auto-clicker, giveaway helper, skin gambling helper, CS2 giveaways, free CS2 skins, KeyDrop bot (not a bot — automation helper), KeyDrop Plus alternative.
