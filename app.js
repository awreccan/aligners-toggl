/*
 * app.js — the "22" PWA controller (Toggl edition).
 *
 * Data source: a Toggl Track account, reached through an Apps Script Web App
 * `/exec` proxy (toggl-store.js) because Toggl's API isn't CORS-enabled. The
 * wear math lives in WearCore. Toggl is the source of truth — there's no local
 * log to reconcile; we tell the proxy to start/stop an entry and render the
 * event log it returns.
 *
 * Flow:
 *   - First run: setup screen collects the Apps Script `/exec` URL.
 *   - Toggle: optimistic UI flip, then goOut()/goIn() -> render server log.
 *   - Load/refresh/visibility/interval: readState() -> derive -> render.
 *     Offline: render the last cached snapshot; the toggle is disabled.
 */
(function () {
  'use strict';
  const Core = window.WearCore;
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
  const RING_R = 108, RING_CIRC = 2 * Math.PI * RING_R;
  const RESYNC_MS = 10000;
  const WARN_MS = 30 * 60000;

  // DEV-SET, once: the generic stateless Toggl relay this app talks to. It holds
  // NO tokens — the user's Toggl token is sent per request. The dev deploys the
  // relay once and hardcodes its /exec URL here so users never see Apps Script.
  // (Empty by default; falls back to a user-pasted proxy URL via the dev box.)
  const DEFAULT_PROXY_URL = 'https://script.google.com/macros/s/AKfycbxwZZRPd0toLBRM2Qhxt16VqObC8-7a8ABPHV--9pnMaNg7y1JWMPa3jMhuwvIpHRTksw/exec';

  // ---- persistent settings + offline cache --------------------------------
  const LS = {
    token: 'aligners.toggl.token',      // the user's OWN Toggl API token
    proxy: 'aligners.toggl.proxyUrl',   // dev relay URL (usually DEFAULT_PROXY_URL)
    log: 'aligners.toggl.log.v1',
  };
  const get = (k) => localStorage.getItem(k);
  const set = (k, v) => localStorage.setItem(k, v);
  const loadLocalLog = () => { try { return JSON.parse(get(LS.log)) || []; } catch (_) { return []; } };
  const saveLocalLog = (log) => set(LS.log, JSON.stringify(log || []));
  const proxyUrl = () => (get(LS.proxy) || DEFAULT_PROXY_URL || '').trim();

  let store = TogglStore.makeStore({ execUrl: proxyUrl(), token: get(LS.token), tz: TZ });
  let online = true, snap = null, tickTimer = null, busy = false;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app'), setupEl = $('setup');
  const els = {};
  ['toggle','ringFill','stateLabel','bigValue','bigCaption','actionHint','wornToday','outToday',
   'targetLabel','historyStrip','conn','lastSync','settingsBtn','syncBtn',
   'setupToken','setupProxy','setupConnect','setupStatus','setupClose',
   'siriHelp','siriModal','siriClose','siriNeedsSetup'
  ].forEach(id => els[id] = $(id));

  // ---- formatting ----
  const fmtHM = (min) => { min = Math.max(0, Math.round(min)); const h = Math.floor(min/60), m = min%60;
    return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`; };
  const fmtMs = (ms) => fmtHM(ms/60000);

  // ---- screen routing ------------------------------------------------------
  function showSetup() {
    setupEl.hidden = false; appEl.hidden = true;
    // Offer an X to leave settings ONLY when a backend is already configured —
    // on true first-run there's nothing to return to, so no dead-end close.
    if (els.setupClose) els.setupClose.hidden = !store.isConfigured();
  }
  function showApp() { setupEl.hidden = true; appEl.hidden = false; }

  // ---- setup flow ----------------------------------------------------------
  async function doConnect() {
    const token = (els.setupToken.value || '').trim();
    // Dev-box proxy override is optional; default is the built-in relay URL.
    const proxyOverride = (els.setupProxy && els.setupProxy.value || '').trim();
    const proxy = proxyOverride || proxyUrl();
    if (!token) { setupMsg('Paste your Toggl API token first.', true); return; }
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(proxy)) {
      setupMsg('No relay URL configured. Open “Dev setup” and paste the /exec URL (one-time, done by the dev).', true);
      return;
    }
    setupMsg('Connecting to your Toggl…');
    const s = TogglStore.makeStore({ execUrl: proxy, token: token, tz: TZ });
    try {
      const state = await s.readState();   // verifies the relay + the user's token work
      set(LS.token, token);
      if (proxyOverride) set(LS.proxy, proxyOverride);
      saveLocalLog(state.log);
      store = s;
      setupMsg('Connected! Starting…');
      await enterApp();
    } catch (e) {
      setupMsg('Couldn’t reach your Toggl: ' + e.message, true);
    }
  }

  function setupMsg(t, isErr) {
    els.setupStatus.textContent = t;
    els.setupStatus.style.color = isErr ? 'var(--red)' : 'var(--muted)';
  }

  async function enterApp() {
    showApp();
    render(localSnapshot());
    await refresh();
    startTick();
  }

  // ---- snapshot from whatever log we have ----------------------------------
  function localSnapshot() { return Core.deriveSnapshot(loadLocalLog(), Date.now(), TZ, {}); }
  function setOnline(v) { online = v; els.conn.classList.toggle('off', !v); els.conn.title = v ? 'Synced with Toggl' : 'Offline (showing last sync)'; }

  // ---- the toggle ----------------------------------------------------------
  // Toggl is authoritative: flip the UI optimistically for responsiveness,
  // then call the proxy and render the event log it returns. On failure, fall
  // back to the cached snapshot and mark offline.
  async function toggle() {
    if (busy || !store.isConfigured()) return;
    const cur = snap ? snap.state : Core.currentState(loadLocalLog());
    const goingOut = cur === 'IN';
    busy = true;
    if (navigator.vibrate) navigator.vibrate(goingOut ? 20 : [15, 40, 15]);
    // optimistic local flip so the ring reacts instantly
    const optimistic = Core.applyEvent(loadLocalLog(),
      { type: goingOut ? 'OUT' : 'IN', at: Date.now(), src: 'tap', id: Core.makeId(Date.now()) }, Date.now());
    if (optimistic.applied) render(Core.deriveSnapshot(optimistic.log, Date.now(), TZ, {}));
    try {
      const state = goingOut ? await store.goOut() : await store.goIn();
      saveLocalLog(state.log);
      setOnline(true);
      render(Core.deriveSnapshot(state.log, Date.now(), TZ, {}));
    } catch (e) {
      setOnline(false);
      render(localSnapshot());   // revert to whatever the last real sync said
    } finally { busy = false; }
  }

  // ---- refresh from Toggl (via proxy) --------------------------------------
  // Spin the sync button for the duration of ANY sync — manual tap or auto
  // (visibilitychange/focus/pageshow/poll) — so background refreshes are visible.
  // Ref-counted + min-duration so rapid/overlapping syncs still show a clear pulse.
  let syncDepth = 0, syncClearTimer = null;
  function syncStart() {
    syncDepth++;
    if (syncClearTimer) { clearTimeout(syncClearTimer); syncClearTimer = null; }
    if (els.syncBtn) els.syncBtn.classList.add('syncing');
  }
  function syncEnd() {
    syncDepth = Math.max(0, syncDepth - 1);
    if (syncDepth === 0 && els.syncBtn) {
      // keep the spin visible at least briefly even if the fetch was instant
      syncClearTimer = setTimeout(() => { els.syncBtn.classList.remove('syncing'); syncClearTimer = null; }, 500);
    }
  }

  async function refresh() {
    if (!store.isConfigured()) { showSetup(); return; }
    syncStart();
    try {
      const state = await store.readState();
      saveLocalLog(state.log);
      setOnline(true);
      render(Core.deriveSnapshot(state.log, Date.now(), TZ, {}));
    } catch (e) {
      setOnline(false);
      render(localSnapshot());
    } finally {
      syncEnd();
    }
  }

  // ---- render --------------------------------------------------------------
  function render(s) {
    if (!s) return;
    snap = s;
    const out = s.state === 'OUT';
    const warn = out && (s.budgetRemainingMs <= WARN_MS);
    appEl.classList.toggle('is-out', out);
    appEl.classList.toggle('is-warn', warn);
    els.stateLabel.textContent = s.state;
    els.targetLabel.textContent = (s.wornTargetH || 22) + 'h';
    els.wornToday.textContent = fmtHM(s.wornMinToday);
    els.outToday.textContent = fmtHM(s.outMinToday);

    if (out) {
      const leftMs = s.budgetRemainingMs;
      if (s.overBudget) {
        els.bigValue.textContent = '+' + fmtMs(-leftMs);
        els.bigCaption.textContent = 'over budget';
        els.actionHint.textContent = 'Put them back in now 🚨';
      } else {
        els.bigValue.textContent = fmtMs(leftMs);
        els.bigCaption.textContent = 'out-budget left';
        els.actionHint.textContent = 'Tap when you put them back in';
      }
    } else {
      els.bigValue.textContent = fmtHM(Math.max(0, s.budgetRemainingMin));
      els.bigCaption.textContent = 'out-budget left';
      els.actionHint.textContent = 'Tap when you take them out';
    }

    const frac = Core.clamp(s.budgetRemainingMs / (s.targetOutMin * 60000), 0, 1);
    els.ringFill.style.strokeDasharray = RING_CIRC.toFixed(1);
    els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - frac)).toFixed(1);

    renderHistory(s.history || []);
    els.lastSync.textContent = (online ? 'synced ' : 'offline ') + new Date(s.nowMs || Date.now()).toLocaleTimeString();
  }

  function renderHistory(history) {
    const days = history.slice().reverse();
    const maxWorn = Math.max(22 * 60, ...days.map(d => d.wornMin || 0), 1);
    els.historyStrip.innerHTML = '';
    if (!days.length) { els.historyStrip.innerHTML = '<p style="color:var(--muted);font-size:13px;margin:0">No history yet.</p>'; return; }
    for (const d of days) {
      const pct = Math.max(6, Math.round((d.wornMin / maxWorn) * 100));
      const wd = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })[0];
      const div = document.createElement('div');
      div.className = 'hbar' + (d.hitTarget ? '' : ' miss');
      div.innerHTML = `<div class="hrs">${Math.floor(d.wornMin/60)}h</div><div class="bar" style="height:${pct}px"></div><div class="day">${wd}</div>`;
      div.title = `${d.date}: worn ${fmtHM(d.wornMin)}, out ${fmtHM(d.outMin)}`;
      els.historyStrip.appendChild(div);
    }
  }

  // ---- live countdown tick (visual only) ----------------------------------
  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (!snap || snap.state !== 'OUT' || !snap.currentWindowStartedAt) return;
      const elapsedSinceSnap = Math.max(0, Date.now() - (snap.nowMs || Date.now()));
      const cap = snap.targetOutMin * 60000;
      const leftMs = Math.min(cap, snap.budgetRemainingMs - elapsedSinceSnap);
      const over = leftMs < 0;
      els.bigValue.textContent = (over ? '+' : '') + fmtMs(Math.abs(leftMs));
      els.bigCaption.textContent = over ? 'over budget' : 'out-budget left';
      appEl.classList.toggle('is-warn', leftMs <= WARN_MS);
      els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - Core.clamp(leftMs / cap, 0, 1))).toFixed(1);
    }, 1000);
  }
  function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  // ---- Siri setup helper ---------------------------------------------------
  // Builds the exact copy-paste backend URLs from the credential in localStorage,
  // so the user never hand-figures the action. Toggl needs ONE Get-Contents-of-URL
  // (GET) per shortcut: proxy + action=out|in + the user's own Toggl token.
  function siriUrls() {
    const token = (get(LS.token) || '').trim();
    const base = proxyUrl();
    if (!token || !base) return null;
    const sep = base.indexOf('?') === -1 ? '?' : '&';
    return {
      out: base + sep + 'action=out&toggl_token=' + encodeURIComponent(token),
      in: base + sep + 'action=in&toggl_token=' + encodeURIComponent(token),
    };
  }
  function openSiri() {
    const urls = siriUrls();
    const ok = !!urls;
    if (els.siriNeedsSetup) els.siriNeedsSetup.hidden = ok;
    document.querySelectorAll('#siriModal [data-fill]').forEach(el => {
      const key = el.getAttribute('data-fill');
      el.textContent = ok ? (key === 'out-url' ? urls.out : urls.in) : '(connect the app first)';
    });
    if (els.siriModal) els.siriModal.hidden = false;
  }
  function closeSiri() { if (els.siriModal) els.siriModal.hidden = true; }
  function wireCopyButtons() {
    document.querySelectorAll('#siriModal .copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const urls = siriUrls();
        if (!urls) return;
        const key = btn.getAttribute('data-copy');
        const val = key === 'out-url' ? urls.out : urls.in;
        try { await navigator.clipboard.writeText(val); } catch (_) {}
        const orig = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
      });
    });
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    els.setupConnect.addEventListener('click', doConnect);
    els.setupToken.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });

    els.toggle.addEventListener('click', toggle);
    if (els.syncBtn) els.syncBtn.addEventListener('click', () => { if (store.isConfigured()) refresh(); });
    // X on the setup card: return to the app (only meaningful when configured).
    if (els.setupClose) els.setupClose.addEventListener('click', () => { if (store.isConfigured()) enterApp(); });
    if (els.siriHelp) els.siriHelp.addEventListener('click', openSiri);
    if (els.siriClose) els.siriClose.addEventListener('click', closeSiri);
    if (els.siriModal) els.siriModal.addEventListener('click', (e) => { if (e.target === els.siriModal) closeSiri(); });
    wireCopyButtons();
    els.settingsBtn.addEventListener('click', () => {
      els.setupStatus.textContent = '';
      els.setupToken.value = get(LS.token) || '';
      if (els.setupProxy) els.setupProxy.value = get(LS.proxy) || '';
      showSetup();
    });

    window.addEventListener('online', () => { setOnline(true); refresh(); });
    window.addEventListener('offline', () => setOnline(false));
    // Refresh on EVERY wake signal, not just visibilitychange — so a Siri-logged
    // event (Shortcut wrote to the backend) shows on the ring the moment Jason
    // comes back to the app. The Siri overlay's effect on the foreground Safari
    // tab varies by iOS version (it may or may not fire visibilitychange), so we
    // listen to focus + pageshow too; whichever fires wins, and refresh() is safe
    // to call redundantly.
    const wake = () => { if (!document.hidden && store.isConfigured()) refresh(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});

    if (store.isConfigured()) { enterApp(); }
    else { showSetup(); }

    // Periodic resync (picks up Toggl edits, Siri-logged events while the app is
    // foreground, and the midnight reset); only while the app screen is showing
    // and the tab is visible. Short interval bounds the worst-case staleness if
    // no wake event fires.
    setInterval(() => {
      if (!document.hidden && store.isConfigured() && setupEl.hidden) refresh();
    }, RESYNC_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
