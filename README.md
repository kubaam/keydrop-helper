# KeyDrop Helper v2.1.0

A hardened, optimized helper for key-drop.com / keydrop.com.

## What's new in 2.1

- **Smooth in-place sort.** Reorders only the cards that are actually out of position (`insertBefore` diff walk), instead of re-appending the whole list — no more flicker.
- **Scoped MutationObserver.** Watches the cards container only, not the full page body. Filters to childList add/remove so unrelated DOM noise no longer triggers sorts.
- **IntersectionObserver auto-load.** "Load more" is only clicked when the button is actually visible — no silent attempts on hidden buttons.
- **Pause when hidden.** Both loops back off when the tab isn't visible; a fresh sort fires on return.
- **Throttle floor.** Min interval between sorts prevents thrash on bursty mutations.
- **Live stats.** Popup shows visible cards, unique users, top frequency, and last-sort time.
- **Action buttons.** "Sort now" and "Load once" for manual triggers.
- **Polished popup.** Animated toggle switches, status pill with pulse, smooth fade-in.

## Carried over from 2.0

- Domain-scoped permissions and content script matches (no `<all_urls>`).
- Popup detects scope and disables toggles outside KeyDrop.
- Robust message sending with runtime error handling.
- Tolerant money parsing (handles `12,345.67` and `12.345,67`).
- Selector fallbacks for username and Total Value.

## Install

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select this folder


Now supports both key-drop.com and keydrop.com (including www subdomains).
