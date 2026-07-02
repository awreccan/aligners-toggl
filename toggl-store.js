/*
 * toggl-store.js — data layer for "22" (Toggl edition).
 *
 * Toggl's API (api.track.toggl.com) is NOT CORS-enabled, so the browser can't
 * call it directly. Instead the PWA talks to an Apps Script Web App `/exec`
 * URL (CORS-open via ContentService); the Apps Script server-side calls Toggl
 * with the user's API token (server-to-server, no CORS). See backend/Code.gs.
 *
 * The browser therefore stores ONLY the unguessable `/exec` URL — never the
 * Toggl token. This module is the analogue of v1's gist-store.js:
 *   - readState() : the OUT/IN event log derived from today's Toggl entries
 *   - goOut()     : start a Toggl "Aligners OUT" entry
 *   - goIn()      : stop the running entry
 *
 * It also exposes a PURE togglEntriesToLog() that converts raw Toggl
 * time-entries → a WearCore event log; both the server (Code.gs) and these
 * tests rely on the identical transform.
 *
 * Universal module: CommonJS (Node/tests) + browser global (window.TogglStore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TogglStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ENTRY_DESCRIPTION = 'Aligners OUT';

  // ---- pure transform: Toggl time-entries → WearCore OUT/IN event log ------
  // A closed entry → an OUT (at `start`) and an IN (at `stop`).
  // A running entry (duration < 0, or no `stop`) → just an OUT.
  // Only entries whose description matches ENTRY_DESCRIPTION are mapped, so
  // unrelated Toggl tracking in the same workspace is ignored. Returns a
  // time-sorted, id-deduped log (the same shape WearCore.applyEvent appends).
  function togglEntriesToLog(entries, opts) {
    opts = opts || {};
    // An explicit `description: null` disables the filter (maps every entry);
    // omitting it defaults to "Aligners OUT". `undefined` -> default.
    const desc = ('description' in opts) ? opts.description : ENTRY_DESCRIPTION;
    const byId = new Map();
    for (const te of (entries || [])) {
      if (!te || (desc !== null && te.description !== desc)) continue;
      for (const ev of entryToEvents(te)) {
        if (ev && ev.id) byId.set(ev.id, ev);
      }
    }
    return [...byId.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
  }

  // One Toggl entry → [{type,at,src,id}]. Pure; mirrors Code.gs exactly.
  function entryToEvents(entry) {
    if (!entry || !entry.start) return [];
    const startMs = Date.parse(entry.start);
    if (!isFinite(startMs)) return [];
    const id = String(entry.id != null ? entry.id : 'te_' + startMs);
    const events = [{ type: 'OUT', at: startMs, src: 'toggl', id: 'out_' + id }];
    const running = (entry.duration != null && entry.duration < 0) || !entry.stop;
    if (!running && entry.stop) {
      const stopMs = Date.parse(entry.stop);
      if (isFinite(stopMs)) events.push({ type: 'IN', at: stopMs, src: 'toggl', id: 'in_' + id });
    }
    return events;
  }

  // ---- the store -----------------------------------------------------------
  function makeStore(opts) {
    opts = opts || {};
    const _fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const cacheBuster = opts.cacheBuster ||
      (() => String(Date.now()) + '-' + Math.round((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0));
    if (!_fetch) throw new Error('toggl-store: no fetch available');

    let execUrl = opts.execUrl || null;
    // The USER's own Toggl API token — sent to the stateless relay per request,
    // so wear entries land in THAT user's Toggl. The relay stores no tokens.
    // Copy/paste smuggles invisible junk (curly quotes, nbsp, zero-width, stray
    // whitespace/newlines) into the token; any of it corrupts the request and
    // Toggl rejects it (402/403). Toggl tokens are pure hex/ASCII, so strip
    // everything that isn't a token character. (Root cause of a real 402 report.)
    function cleanToken(t) {
      return t == null ? null : (String(t).match(/[A-Za-z0-9_]+/g) || []).join('') || null;
    }
    let token = cleanToken(opts.token);
    // Device timezone so the proxy resolves "today" the same way the phone does.
    const tz = opts.tz ||
      ((typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC');

    function setExecUrl(u) { execUrl = u; }
    function setToken(t) { token = cleanToken(t); }
    // Configured = we have both the relay URL AND the user's token.
    function isConfigured() { return !!execUrl && !!token; }

    // Build the GET URL with action + tz + token + cache-buster. Sent as query
    // params (not headers) so the request stays "simple" — Apps Script web apps
    // can't answer a CORS preflight. HTTPS encrypts the query string in transit.
    function urlFor(action) {
      if (!execUrl) throw new Error('toggl-store: not configured (no relay URL)');
      if (!token) throw new Error('toggl-store: not configured (no Toggl token)');
      const sep = execUrl.indexOf('?') === -1 ? '?' : '&';
      return execUrl + sep +
        'action=' + encodeURIComponent(action) +
        '&tz=' + encodeURIComponent(tz) +
        '&toggl_token=' + encodeURIComponent(token) +
        '&cb=' + encodeURIComponent(cacheBuster());
    }

    // All three actions are GETs to the proxy — Apps Script doGet handles them
    // and they avoid a CORS preflight (simple request, no custom headers).
    async function call(action) {
      const res = await _fetch(urlFor(action), { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('proxy ' + action + ' failed: HTTP ' + res.status);
      const data = await res.json();
      if (data && data.error) throw new Error('proxy ' + action + ': ' + data.error + (data.detail ? ' — ' + data.detail : ''));
      return data;
    }

    // Returns { log, running, today, tz, serverNow } — log is ready for
    // WearCore.deriveSnapshot.
    async function readState() {
      const data = await call('state');
      return {
        log: Array.isArray(data.log) ? data.log : [],
        running: data.running || null,
        today: data.today || null,
        tz: data.tz || tz,
        serverNow: data.serverNow || Date.now(),
      };
    }

    async function goOut() { return normalize(await call('out')); }
    async function goIn() { return normalize(await call('in')); }

    function normalize(data) {
      return {
        log: Array.isArray(data.log) ? data.log : [],
        running: data.running || null,
        today: data.today || null,
        tz: data.tz || tz,
        serverNow: data.serverNow || Date.now(),
      };
    }

    return {
      ENTRY_DESCRIPTION, tz,
      setExecUrl, setToken, isConfigured, readState, goOut, goIn,
      get execUrl() { return execUrl; },
    };
  }

  return { makeStore, togglEntriesToLog, entryToEvents, ENTRY_DESCRIPTION };
}));
