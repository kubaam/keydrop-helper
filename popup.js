(() => {
  "use strict";

  const KD_HOST_RE = /(^|\.)key-?drop\.com$/i;
  const STATS_POLL_MS = 500;

  const el = (id) => document.getElementById(id);

  function promisify(fn, ...args) {
    return new Promise((resolve) => fn(...args, resolve));
  }

  async function getActiveTab() {
    const tabs = await promisify(chrome.tabs.query, { active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  function isKeyDropUrl(url) {
    try { return KD_HOST_RE.test(new URL(url || "").hostname); }
    catch { return false; }
  }

  function setStatus(inScope) {
    const box = el("statusBox");
    const text = el("statusText");
    box.classList.remove("ok", "warn");
    if (inScope) {
      box.classList.add("ok");
      text.textContent = "Connected — KeyDrop tab in scope.";
    } else {
      box.classList.add("warn");
      text.textContent = "Open key-drop.com to enable controls.";
    }
  }

  function setControlsEnabled(enabled, controls) {
    for (const c of controls) c.disabled = !enabled;
  }

  function sendMessage(tabId, msg) {
    return new Promise((resolve) => {
      if (!tabId) return resolve({ ok: false, reason: "no_tab_id" });
      try {
        chrome.tabs.sendMessage(tabId, msg, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return resolve({ ok: false, reason: err.message || "send_failed" });
          resolve(response || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, reason: String(e) });
      }
    });
  }

  // If the content script isn't responding (e.g. the tab was loaded
  // before the extension was installed/updated), inject it on demand.
  // Returns true if the script is responsive afterward.
  let _injectAttempted = false;
  async function ensureContentScript(tabId) {
    const probe = await sendMessage(tabId, { type: "getStats" });
    if (probe && probe.ok) return true;
    if (_injectAttempted) return false; // already tried this popup session
    _injectAttempted = true;
    try {
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => {
            const err = chrome.runtime.lastError;
            if (err) reject(err);
            else resolve();
          }
        );
      });
      // Give the just-injected script a beat to register listeners.
      await new Promise((r) => setTimeout(r, 80));
      const probe2 = await sendMessage(tabId, { type: "getStats" });
      return !!(probe2 && probe2.ok);
    } catch (e) {
      console.warn("[KDH] inject failed:", e && e.message ? e.message : e);
      return false;
    }
  }

  async function sendOrInject(tabId, msg) {
    await ensureContentScript(tabId);
    return sendMessage(tabId, msg);
  }

  function fmt(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function relTime(ts) {
    if (!ts) return "never sorted";
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 1500) return "just now";
    if (diff < 60_000) return Math.round(diff / 1000) + "s ago";
    if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
    return Math.round(diff / 3_600_000) + "h ago";
  }

  const last_rendered = { cards: null, uniqueUsers: null, topUserCount: null };
  function setStat(id, value) {
    const node = el(id);
    const next = fmt(value);
    if (node.textContent === next) return;
    node.textContent = next;
    node.classList.remove("flash");
    // Force reflow so the animation restarts on rapid updates.
    void node.offsetWidth;
    node.classList.add("flash");
  }
  function renderStats(stats) {
    if (!stats) return;
    if (stats.cards !== last_rendered.cards) { setStat("statCards", stats.cards); last_rendered.cards = stats.cards; }
    if (stats.uniqueUsers !== last_rendered.uniqueUsers) { setStat("statUsers", stats.uniqueUsers); last_rendered.uniqueUsers = stats.uniqueUsers; }
    if (stats.topUserCount !== last_rendered.topUserCount) { setStat("statTopCount", stats.topUserCount); last_rendered.topUserCount = stats.topUserCount; }

    const box = el("topUserBox");
    if (stats.topUser && stats.topUserCount > 1) {
      box.style.display = "flex";
      el("topUserName").textContent = stats.topUser;
      el("topUserCount").textContent = "×" + stats.topUserCount;
    } else {
      box.style.display = "none";
    }
    el("lastSortAgo").textContent = stats.lastSortAt ? "sorted " + relTime(stats.lastSortAt) : "watching...";
  }

  let ago_timer = null;
  let stats_timer = null;
  let last_stats_ts = 0;

  let in_warn_state = false;
  let consecutive_fails = 0;
  const WARN_AFTER_FAILS = 4; // ~2s at 500ms poll — gives content script time to load
  async function refreshStats(tabId) {
    if (!tabId) return;
    const res = await sendMessage(tabId, { type: "getStats" });
    if (res && res.ok && res.stats) {
      consecutive_fails = 0;
      if (in_warn_state) {
        // Restore the "Connected" status that we previously overwrote.
        const box = el("statusBox");
        const text = el("statusText");
        box.classList.remove("warn");
        box.classList.add("ok");
        text.textContent = "Connected — KeyDrop tab in scope.";
        in_warn_state = false;
      }
      last_stats_ts = res.stats.lastSortAt || last_stats_ts;
      renderStats(res.stats);
      return;
    }
    consecutive_fails++;
    // After 2 failed polls, try injecting on demand — most users will
    // never see the warning text below.
    if (consecutive_fails === 2 && !_injectAttempted) {
      ensureContentScript(tabId).then((ready) => {
        if (ready) refreshStats(tabId);
      });
    }
    if (consecutive_fails >= WARN_AFTER_FAILS && !in_warn_state) {
      in_warn_state = true;
      const box = el("statusBox");
      const text = el("statusText");
      box.classList.remove("ok");
      box.classList.add("warn");
      text.textContent = "Reload the KeyDrop tab to activate.";
    }
  }

  function flashButton(btn) {
    btn.style.transform = "scale(0.95)";
    setTimeout(() => { btn.style.transform = ""; }, 120);
  }

  async function main() {
    const autoLoadToggle = el("autoLoadToggle");
    const autoSortToggle = el("autoSortToggle");
    const sortNowBtn = el("sortNowBtn");
    const loadOnceBtn = el("loadOnceBtn");

    const activeTab = await getActiveTab();
    const inScope = !!(activeTab && isKeyDropUrl(activeTab.url));
    setStatus(inScope);
    setControlsEnabled(inScope, [autoLoadToggle, autoSortToggle, sortNowBtn, loadOnceBtn]);

    // restore toggle state immediately from storage
    chrome.storage.local.get({ autoLoad: false, autoSort: false }, (data) => {
      autoLoadToggle.checked = !!data.autoLoad;
      autoSortToggle.checked = !!data.autoSort;
      const liveEl = el("liveBadge");
      if (liveEl) liveEl.classList.toggle("on", autoSortToggle.checked);
    });

    if (inScope && activeTab?.id != null) {
      // Auto-inject the content script if the tab was loaded before the
      // extension was installed/updated. This makes the toggles work
      // without the user having to refresh the tab manually.
      ensureContentScript(activeTab.id).then((ready) => {
        if (ready) refreshStats(activeTab.id);
      });
      stats_timer = setInterval(() => refreshStats(activeTab.id), STATS_POLL_MS);
      ago_timer = setInterval(() => {
        if (last_stats_ts) el("lastSortAgo").textContent = "sorted " + relTime(last_stats_ts);
      }, 1000);
    }

    autoLoadToggle.addEventListener("change", async () => {
      const enabled = !!autoLoadToggle.checked;
      chrome.storage.local.set({ autoLoad: enabled });
      if (inScope && activeTab?.id != null) {
        await sendOrInject(activeTab.id, { type: "toggleAutoLoad", enabled });
      }
    });

    function reflectLive() {
      const liveEl = el("liveBadge");
      if (liveEl) liveEl.classList.toggle("on", autoSortToggle.checked);
    }
    reflectLive();

    autoSortToggle.addEventListener("change", async () => {
      const enabled = !!autoSortToggle.checked;
      chrome.storage.local.set({ autoSort: enabled });
      reflectLive();
      if (inScope && activeTab?.id != null) {
        await sendOrInject(activeTab.id, { type: "toggleAutoSort", enabled });
        if (enabled) setTimeout(() => refreshStats(activeTab.id), 200);
      }
    });

    sortNowBtn.addEventListener("click", async () => {
      if (!inScope || activeTab?.id == null) return;
      flashButton(sortNowBtn);
      const res = await sendOrInject(activeTab.id, { type: "sortNow" });
      if (res && res.ok && res.stats) renderStats(res.stats);
    });

    loadOnceBtn.addEventListener("click", async () => {
      if (!inScope || activeTab?.id == null) return;
      flashButton(loadOnceBtn);
      await sendOrInject(activeTab.id, { type: "loadOnce" });
      setTimeout(() => refreshStats(activeTab.id), 600);
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "stats" && msg.stats) {
        // A push means the content script is alive — clear any "reload" warning.
        consecutive_fails = 0;
        if (in_warn_state) {
          const box = el("statusBox");
          const text = el("statusText");
          box.classList.remove("warn");
          box.classList.add("ok");
          text.textContent = "Connected — KeyDrop tab in scope.";
          in_warn_state = false;
        }
        last_stats_ts = msg.stats.lastSortAt || last_stats_ts;
        renderStats(msg.stats);
      }
    });
  }

  window.addEventListener("unload", () => {
    if (stats_timer) clearInterval(stats_timer);
    if (ago_timer) clearInterval(ago_timer);
  });

  document.addEventListener("DOMContentLoaded", () => {
    main().catch((err) => console.error("[KDH] popup init failed:", err));
  });
})();
