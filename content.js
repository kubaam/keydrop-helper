(() => {
  "use strict";

  // Sentinel: prevent double initialization. The popup may inject this
  // script via chrome.scripting.executeScript even when the manifest
  // content_scripts entry already ran it — without this guard we'd end
  // up with two sets of message listeners and observers.
  if (window.__kdhLoaded) return;
  window.__kdhLoaded = true;

  const DOMAIN_OK = /(^|\.)key-?drop\.com$/i.test(location.hostname);
  if (!DOMAIN_OK) return;

  const CONFIG = {
    loadTickMs: 700,            // poll interval when nothing was clicked
    loadAfterClickMs: 1000,     // 1 sec mandatory delay after a successful click
    loadErrorBackoffMs: 5000,   // pause this long after detecting a site error
    sortFallbackMs: 1500,
    minSortIntervalMs: 150,
    loadButtonCooldownMs: 950,
    hiddenTabPauseMs: 250,
    bodyObsThrottleMs: 300,
    statsPushMs: 700
  };

  const state = {
    autoLoad: false,
    autoSort: false,
    loadTimer: null,
    sortFallbackTimer: null,
    statsPushTimer: null,
    sortScheduled: false,
    sortInFlight: false,
    lastSortAt: 0,
    lastSortSignature: "",
    listObserver: null,
    bodyObserver: null,
    listEl: null,
    loadBtnVisible: false,
    loadBtnObserver: null,
    loadBtnEl: null,
    errorBackoffUntil: 0,
    stats: { cards: 0, uniqueUsers: 0, topUser: "", topUserCount: 0, lastSortAt: 0 },
    debug: false
  };

  const log = (...args) => state.debug && console.log("[KDH]", ...args);
  const warn = (...args) => console.warn("[KDH]", ...args);

  function normalizeUsername(s) {
    return (s || "").trim().replace(/\s+/g, " ");
  }

  function parseMoney(raw) {
    if (!raw) return 0;
    const text = String(raw).trim();
    const candidates = text.match(/[-+]?\d[\d.,]*/g);
    if (!candidates || !candidates.length) return 0;
    let num = candidates[candidates.length - 1];

    const lastComma = num.lastIndexOf(",");
    const lastDot = num.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) {
        num = num.replace(/\./g, "").replace(",", ".");
      } else {
        num = num.replace(/,/g, "");
      }
    } else if (lastComma >= 0) {
      const right = num.slice(lastComma + 1);
      if (/^\d{1,2}$/.test(right)) num = num.replace(",", ".");
      else num = num.replace(/,/g, "");
    } else {
      num = num.replace(/,/g, "");
    }

    const v = Number.parseFloat(num);
    return Number.isFinite(v) ? v : 0;
  }

  function getCards() {
    // Prefer the stable data-testid selector for the user-giveaways list.
    // Falls back to class-based selectors for older markup.
    const ul = document.querySelector('[data-testid="div-user-giveaways-list-section"]');
    if (ul) {
      const cards = [];
      const lis = ul.children;
      for (let i = 0; i < lis.length; i++) {
        const li = lis[i];
        if (li.tagName === "LI" && li.querySelector("a[href]")) cards.push(li);
      }
      if (cards.length) return cards;
    }

    let anchors = document.querySelectorAll(
      "li > a.group.relative.flex.cursor-pointer.flex-col"
    );
    if (!anchors.length) {
      anchors = document.querySelectorAll("li > a.group.relative");
    }
    const cards = [];
    for (let i = 0; i < anchors.length; i++) {
      const li = anchors[i].closest("li");
      if (li instanceof HTMLElement) cards.push(li);
    }
    return cards;
  }

  function getUsername(li) {
    const strong = li.querySelector("p.truncate.text-xs.font-semibold.text-white");
    if (strong) return normalizeUsername(strong.textContent);
    const p = li.querySelector("p.truncate, p.text-xs, p.font-semibold");
    return p ? normalizeUsername(p.textContent) : "";
  }

  function getTotalValue(li) {
    try {
      const ps = li.querySelectorAll("p");
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (/total\s*value/i.test((p.textContent || "").trim())) {
          const scope = p.parentElement || li;
          const nodes = scope.querySelectorAll("span, p, div");
          for (let j = 0; j < nodes.length; j++) {
            const txt = (nodes[j].textContent || "").trim();
            if (/[$€£]\s*[-+]?\d/.test(txt) || /\b\d[\d.,]*\b/.test(txt)) {
              const money = parseMoney(txt);
              if (money > 0) return money;
            }
          }
        }
      }
      const nodes = li.querySelectorAll("span, p, div");
      let max = 0;
      for (let i = 0; i < nodes.length; i++) {
        const t = (nodes[i].textContent || "").trim();
        if (!t) continue;
        if (/[$€£]\s*[-+]?\d/.test(t) || /\b\d[\d.,]*\b/.test(t)) {
          const v = parseMoney(t);
          if (v > max) max = v;
        }
      }
      return max;
    } catch (e) {
      warn("getTotalValue error:", e);
      return 0;
    }
  }

  function resolveListEl(cards) {
    if (state.listEl && state.listEl.isConnected && cards.length && cards[0].parentElement === state.listEl) {
      return state.listEl;
    }
    if (!cards.length) return null;
    state.listEl = cards[0].parentElement || null;
    if (state.listEl) attachListObserver(state.listEl);
    return state.listEl;
  }

  function computeSignature(rows) {
    const len = rows.length;
    if (!len) return "0|";
    let head = "";
    const sample = Math.min(80, len);
    for (let i = 0; i < sample; i++) {
      const r = rows[i];
      head += r.userKey + ":" + Math.round(r.totalValue * 100) + ";";
    }
    return len + "|" + head;
  }

  // Move only nodes that are out of position. Walking from the end and
  // checking nextSibling against expected = O(n) work, near-zero DOM
  // mutations when most cards are already in place. Avoids the flicker
  // of fragment-append where every card reflows.
  function reorderInPlace(parent, target) {
    for (let i = target.length - 1; i >= 0; i--) {
      const node = target[i];
      const expectedNext = target[i + 1] || null;
      if (node.parentNode !== parent || node.nextSibling !== expectedNext) {
        parent.insertBefore(node, expectedNext);
      }
    }
  }

  function updateStats(rows, groups) {
    let topUser = "";
    let topUserCount = 0;
    for (const g of groups) {
      if (g.count > topUserCount) {
        topUserCount = g.count;
        topUser = g.username;
      }
    }
    state.stats.cards = rows.length;
    state.stats.uniqueUsers = groups.length;
    state.stats.topUser = topUser;
    state.stats.topUserCount = topUserCount;
    state.stats.lastSortAt = Date.now();
  }

  function runSortByFrequency() {
    if (state.sortInFlight) return;
    state.sortInFlight = true;
    try {
      const cards = getCards();
      if (!cards.length) return;

      const parent = resolveListEl(cards);
      if (!parent) return;

      const rows = new Array(cards.length);
      for (let i = 0; i < cards.length; i++) {
        const li = cards[i];
        const username = getUsername(li);
        rows[i] = {
          li,
          username,
          userKey: username.toLowerCase(),
          totalValue: getTotalValue(li)
        };
      }

      const nextSig = computeSignature(rows);
      if (nextSig === state.lastSortSignature) return;

      const groupMap = new Map();
      for (const row of rows) {
        let g = groupMap.get(row.userKey);
        if (!g) {
          g = { userKey: row.userKey, username: row.username, count: 0, maxTotalValue: 0, items: [] };
          groupMap.set(row.userKey, g);
        }
        g.count++;
        g.items.push(row);
        if (row.totalValue > g.maxTotalValue) g.maxTotalValue = row.totalValue;
      }

      const groupArr = Array.from(groupMap.values());
      for (const g of groupArr) {
        g.items.sort((a, b) => b.totalValue - a.totalValue);
      }
      groupArr.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (b.maxTotalValue !== a.maxTotalValue) return b.maxTotalValue - a.maxTotalValue;
        return a.userKey.localeCompare(b.userKey, undefined, { numeric: true, sensitivity: "base" });
      });

      const ordered = [];
      for (const g of groupArr) for (const it of g.items) ordered.push(it.li);

      // Pause the list observer during reorder so our own writes don't reschedule us.
      const obs = state.listObserver;
      if (obs) obs.disconnect();
      reorderInPlace(parent, ordered);
      if (obs && state.autoSort) obs.observe(parent, { childList: true });

      state.lastSortSignature = nextSig;
      state.lastSortAt = Date.now();
      updateStats(rows, groupArr);
      broadcastStats();
      log("sorted", rows.length, "cards in", groupArr.length, "groups");
    } catch (e) {
      warn("sort error:", e);
    } finally {
      state.sortInFlight = false;
    }
  }

  function scheduleSort(reason) {
    if (!state.autoSort) return;
    if (document.hidden) return;

    // Self-heal: if our list got unmounted, drop the dead observer and
    // let the body observer / next call rediscover the new list.
    if (state.listEl && !state.listEl.isConnected) {
      if (state.listObserver) { state.listObserver.disconnect(); state.listObserver = null; }
      state.listEl = null;
    }

    if (state.sortScheduled) return;

    const since = Date.now() - state.lastSortAt;
    const wait = since < CONFIG.minSortIntervalMs ? CONFIG.minSortIntervalMs - since : 0;
    state.sortScheduled = true;

    const fire = () => {
      state.sortScheduled = false;
      if (!state.autoSort || document.hidden) return;
      runSortByFrequency();
    };

    if (wait > 0) setTimeout(() => requestAnimationFrame(fire), wait);
    else requestAnimationFrame(fire);

    if (reason) log("sort scheduled:", reason);
  }

  // Scope observer to the card list. Uses subtree so we catch skeleton
  // <li>s being filled with content (KeyDrop's load-more pattern), but
  // filters to only react when the added/removed node is an <a> or <li>
  // — image loads and hover states don't trigger us.
  function attachListObserver(parent) {
    if (state.listObserver) state.listObserver.disconnect();
    state.listObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        if (mutationTouchesCard(m.addedNodes) || mutationTouchesCard(m.removedNodes)) {
          scheduleSort("list-mut");
          return;
        }
      }
    });
    state.listObserver.observe(parent, { childList: true, subtree: true });
  }
  function mutationTouchesCard(nodeList) {
    for (let i = 0; i < nodeList.length; i++) {
      const n = nodeList[i];
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === "LI" || tag === "A") return true;
    }
    return false;
  }

  // Body observer stays alive as a self-healer. SPA re-renders that swap
  // the entire list element would otherwise leave us watching a detached
  // node. Callback is throttled and cheap when listEl is still good.
  let _bodyObsLast = 0;
  function attachBodyObserver() {
    if (state.bodyObserver) return;
    state.bodyObserver = new MutationObserver(() => {
      const now = Date.now();
      if (now - _bodyObsLast < CONFIG.bodyObsThrottleMs) return;
      _bodyObsLast = now;

      // Cheap path: listEl still mounted, nothing to do.
      if (state.listEl && state.listEl.isConnected) return;

      // List was swapped or never bound — re-resolve.
      const cards = getCards();
      if (!cards.length) return;
      if (state.listObserver) { state.listObserver.disconnect(); state.listObserver = null; }
      state.listEl = null;
      resolveListEl(cards);
      if (state.autoSort) scheduleSort("body-rebind");
    });
    state.bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function detachBodyObserver() {
    if (state.bodyObserver) {
      state.bodyObserver.disconnect();
      state.bodyObserver = null;
    }
  }

  // ---------- auto-load ----------

  function findLoadMoreButton() {
    if (state.loadBtnEl && state.loadBtnEl.isConnected) {
      const txt = (state.loadBtnEl.innerText || state.loadBtnEl.textContent || "").trim();
      if (/load\s*more/i.test(txt) && !state.loadBtnEl.disabled) return state.loadBtnEl;
    }
    const buttons = document.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const txt = (b.innerText || b.textContent || "").trim();
      if (/load\s*more/i.test(txt) && !b.disabled) {
        state.loadBtnEl = b;
        attachLoadBtnObserver(b);
        return b;
      }
    }
    return null;
  }

  function attachLoadBtnObserver(btn) {
    if (state.loadBtnObserver) state.loadBtnObserver.disconnect();
    state.loadBtnVisible = false;
    state.loadBtnObserver = new IntersectionObserver((entries) => {
      for (const e of entries) state.loadBtnVisible = e.isIntersecting;
    }, { threshold: 0.01 });
    state.loadBtnObserver.observe(btn);
  }

  function detachLoadBtnObserver() {
    if (state.loadBtnObserver) {
      state.loadBtnObserver.disconnect();
      state.loadBtnObserver = null;
    }
    state.loadBtnEl = null;
    state.loadBtnVisible = false;
  }

  // Detect the site's own error overlay ("Something went wrong / An
  // unexpected error has occurred / Try again"). When this is visible,
  // we must NOT keep clicking — that's what triggered the rate-limit/
  // error in the first place. Returns the "Try again" button if found.
  function findSiteErrorTryAgainBtn() {
    const buttons = document.querySelectorAll("button, a");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (b.offsetParent === null) continue;
      const t = (b.innerText || b.textContent || "").trim();
      if (/^\s*try\s*again\s*$/i.test(t)) return b;
    }
    return null;
  }
  function isSiteErrorVisible() {
    // Look in containers most likely to hold an error overlay. Cheap and
    // avoids the layout cost of body-wide innerText.
    const probes = document.querySelectorAll(
      'h1, h2, [role="alert"], [class*="error"], [class*="Error"]'
    );
    for (let i = 0; i < probes.length; i++) {
      const n = probes[i];
      if (n.offsetParent === null) continue;
      const t = (n.textContent || "").trim();
      if (!t || t.length > 400) continue;
      if (/something\s+went\s+wrong/i.test(t)) return true;
      if (/unexpected\s+error\s+has\s+occurred/i.test(t)) return true;
    }
    return false;
  }

  function clickLoadMoreButton() {
    try {
      // Respect any active back-off after a site error.
      if (Date.now() < state.errorBackoffUntil) return false;

      // Detect the site error overlay. If visible, back off — and try
      // to recover by clicking the page's own "Try again" once.
      if (isSiteErrorVisible()) {
        const tryAgain = findSiteErrorTryAgainBtn();
        if (tryAgain && !tryAgain.dataset.kdhBusy) {
          tryAgain.dataset.kdhBusy = "1";
          tryAgain.click();
          setTimeout(() => { delete tryAgain.dataset.kdhBusy; }, CONFIG.loadErrorBackoffMs);
          log("clicked site Try again");
        }
        state.errorBackoffUntil = Date.now() + CONFIG.loadErrorBackoffMs;
        return false;
      }

      const btn = findLoadMoreButton();
      if (!btn) return false;
      // Only click if it's actually visible — saves silent click attempts
      // on hidden buttons and prevents fighting the page's own scroll-loaders.
      if (!state.loadBtnVisible && btn.offsetParent === null) return false;
      if (btn.getAttribute("aria-busy") === "true" || btn.dataset.kdhBusy === "1") return false;

      btn.dataset.kdhBusy = "1";
      btn.click();
      setTimeout(() => {
        delete btn.dataset.kdhBusy;
        // KeyDrop fills empty <li> skeletons with content rather than
        // appending new <li> to the <ul>, so our childList observer
        // doesn't see the change. Force a sort + stats refresh now.
        if (state.autoSort) {
          state.lastSortSignature = ""; // bust the dedup so sort actually runs
          scheduleSort("after-load");
        }
        try {
          const s = getCurrentStats();
          state.stats.cards = s.cards;
          state.stats.uniqueUsers = s.uniqueUsers;
          if (s.topUserCount > 0) {
            state.stats.topUser = s.topUser;
            state.stats.topUserCount = s.topUserCount;
          }
          broadcastStats();
        } catch { /* noop */ }
      }, CONFIG.loadButtonCooldownMs);
      log("clicked Load more");
      return true;
    } catch (e) {
      warn("autoLoad error:", e);
      return false;
    }
  }

  function autoLoadLoop() {
    if (!state.autoLoad) return;

    let clicked = false;
    if (!document.hidden) clicked = clickLoadMoreButton();

    let next;
    if (document.hidden) {
      next = CONFIG.hiddenTabPauseMs * 4;
    } else if (Date.now() < state.errorBackoffUntil) {
      // Site error active — wait it out before checking again.
      next = Math.max(500, state.errorBackoffUntil - Date.now());
    } else if (clicked) {
      // Hard 1-second wait after every successful click.
      next = CONFIG.loadAfterClickMs;
    } else {
      // Button missing/busy — poll faster so we react when it appears.
      next = CONFIG.loadTickMs;
    }

    state.loadTimer = window.setTimeout(autoLoadLoop, next);
  }

  function startAutoLoad() {
    if (state.autoLoad) return;
    state.autoLoad = true;
    if (state.loadTimer) clearTimeout(state.loadTimer);
    autoLoadLoop();
    log("autoLoad ENABLED");
  }

  function stopAutoLoad() {
    state.autoLoad = false;
    if (state.loadTimer) { clearTimeout(state.loadTimer); state.loadTimer = null; }
    detachLoadBtnObserver();
    log("autoLoad DISABLED");
  }

  // ---------- auto-sort lifecycle ----------

  function startAutoSort() {
    if (state.autoSort) return;
    state.autoSort = true;
    state.lastSortSignature = "";

    const cards = getCards();
    if (cards.length) resolveListEl(cards);
    attachBodyObserver(); // always-on safety net for SPA re-renders

    if (state.sortFallbackTimer) clearInterval(state.sortFallbackTimer);
    state.sortFallbackTimer = window.setInterval(() => scheduleSort("fallback"), CONFIG.sortFallbackMs);

    scheduleSort("start");
    log("autoSort ENABLED");
  }

  function stopAutoSort() {
    state.autoSort = false;
    if (state.sortFallbackTimer) { clearInterval(state.sortFallbackTimer); state.sortFallbackTimer = null; }
    if (state.listObserver) { state.listObserver.disconnect(); state.listObserver = null; }
    detachBodyObserver();
    log("autoSort DISABLED");
  }

  function setAutoLoad(enabled) { enabled ? startAutoLoad() : stopAutoLoad(); }
  function setAutoSort(enabled) { enabled ? startAutoSort() : stopAutoSort(); }

  // ---------- popup messaging ----------

  function broadcastStats() {
    try {
      chrome.runtime.sendMessage({ type: "stats", stats: state.stats }, () => void chrome.runtime.lastError);
    } catch { /* popup not open */ }
  }

  // Continuous push: even when nothing sorted/loaded, send fresh live
  // stats so an open popup always shows current numbers.
  function startStatsPusher() {
    if (state.statsPushTimer) return;
    state.statsPushTimer = window.setInterval(() => {
      if (document.hidden) return;
      try {
        const s = getCurrentStats();
        state.stats.cards = s.cards;
        state.stats.uniqueUsers = s.uniqueUsers;
        if (s.topUserCount > 0) {
          state.stats.topUser = s.topUser;
          state.stats.topUserCount = s.topUserCount;
        }
        broadcastStats();
      } catch { /* noop */ }
    }, CONFIG.statsPushMs);
  }

  function stopStatsPusher() {
    if (state.statsPushTimer) { clearInterval(state.statsPushTimer); state.statsPushTimer = null; }
  }

  // Always compute live from the current DOM. Cheaper than a full sort
  // (no Total Value parsing) and works regardless of autoSort state.
  function getCurrentStats() {
    const cards = getCards();
    const groupMap = new Map();
    for (let i = 0; i < cards.length; i++) {
      const username = getUsername(cards[i]);
      const key = username.toLowerCase();
      const g = groupMap.get(key);
      if (g) g.count++;
      else groupMap.set(key, { username, count: 1 });
    }
    let topUser = "";
    let topUserCount = 0;
    for (const g of groupMap.values()) {
      if (g.count > topUserCount) { topUserCount = g.count; topUser = g.username; }
    }
    return {
      cards: cards.length,
      uniqueUsers: groupMap.size,
      topUser,
      topUserCount,
      lastSortAt: state.stats.lastSortAt
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (!msg || typeof msg !== "object") return;

      switch (msg.type) {
        case "toggleAutoLoad":
          setAutoLoad(!!msg.enabled);
          sendResponse({ ok: true, autoLoad: state.autoLoad });
          break;
        case "toggleAutoSort":
          setAutoSort(!!msg.enabled);
          sendResponse({ ok: true, autoSort: state.autoSort });
          break;
        case "sortNow":
          runSortByFrequency();
          sendResponse({ ok: true, stats: state.stats });
          break;
        case "loadOnce":
          sendResponse({ ok: true, clicked: clickLoadMoreButton() });
          break;
        case "getStats":
          sendResponse({ ok: true, stats: getCurrentStats(), autoLoad: state.autoLoad, autoSort: state.autoSort });
          break;
        case "setDebug":
          state.debug = !!msg.enabled;
          sendResponse({ ok: true });
          break;
      }
    } catch (e) {
      warn("message error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.prototype.hasOwnProperty.call(changes, "autoLoad")) setAutoLoad(!!changes.autoLoad.newValue);
    if (Object.prototype.hasOwnProperty.call(changes, "autoSort")) setAutoSort(!!changes.autoSort.newValue);
    if (Object.prototype.hasOwnProperty.call(changes, "debug")) state.debug = !!changes.debug.newValue;
  });

  // Pause everything when tab is hidden — saves CPU and avoids fighting
  // background reflows. Resume kicks a sort to catch up.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.autoSort) scheduleSort("visible");
  });

  function bootstrap() {
    chrome.storage.local.get({ autoLoad: false, autoSort: false, debug: false }, (data) => {
      state.debug = !!data.debug;
      setAutoLoad(!!data.autoLoad);
      setAutoSort(!!data.autoSort);
      // Always run the stats pusher so the popup gets live numbers
      // regardless of toggles. Cheap: one querySelectorAll + Map every 700ms.
      startStatsPusher();
    });
  }

  bootstrap();
})();
