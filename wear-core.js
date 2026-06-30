/*
 * wear-core.js — pure wear-time / out-budget / reminder-ladder logic.
 *
 * The single source of truth for "22". The backend, the PWA, and the unit
 * tests all import THIS module so the math can never drift between them.
 *
 * Design rules:
 *   - State is an append-only log of {type:'IN'|'OUT', at:epochMs, src, id}.
 *   - We never store "minutes worn"; everything is DERIVED from the log.
 *   - Events are stored in absolute UTC epoch ms; "which day?" is decided at
 *     read time by projecting into the device's IANA timezone. So clock /
 *     timezone / DST changes can never rewrite history.
 *
 * Universal module: works as CommonJS (Node) and as a browser/SW global
 * (window.WearCore / self.WearCore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WearCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- CONFIG --------------------------------------------------------------
  const DEFAULT_CONFIG = {
    TARGET_OUT_MIN: 120,   // 2h daily out-budget => 22h wear target
    WEAR_TARGET_H: 22,     // shown to the user
    // Reminder ladder: [minutesSinceOut, tone]. Compressed toward 0 when the
    // remaining daily budget at the moment of going OUT is small (see schedule).
    LADDER: [[20, 'gentle'], [35, 'nudge'], [50, 'firm'], [70, 'urgent']],
    MIN_COMPRESS: 0.25,    // floor on the compression scale (never collapse to 0)
    HISTORY_DAYS: 7,
  };

  const MS_PER_MIN = 60000;
  const MS_PER_HOUR = 3600000;
  const MS_PER_DAY = 86400000;

  // ---- timezone helpers ----------------------------------------------------
  // Break an instant into its local wall-clock parts in a given IANA tz.
  function localParts(epochMs, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(epochMs))) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }
    // Intl can emit hour '24' at midnight on some engines; normalise to 0.
    if (map.hour === '24') map.hour = '00';
    return {
      year: +map.year, month: +map.month, day: +map.day,
      hour: +map.hour, minute: +map.minute, second: +map.second,
    };
  }

  // Epoch ms for a wall-clock time (y, mo[1-12], d, h, mi, s) in a given tz.
  // Single-correction algorithm: accurate everywhere except inside the ~1h
  // DST "spring forward" gap — which never contains midnight, so it's safe
  // for day boundaries.
  function zonedToEpoch(y, mo, d, h, mi, s, tz) {
    const utcGuess = Date.UTC(y, mo - 1, d, h, mi, s);
    const p = localParts(utcGuess, tz);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asIfUtc - utcGuess; // local = utc + diff
    return utcGuess - diff;
  }

  // "YYYY-MM-DD" for the local day containing epochMs in tz.
  function localDayString(epochMs, tz) {
    const p = localParts(epochMs, tz);
    return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
  }

  // [startEpoch, endEpoch) for the local calendar day "YYYY-MM-DD" in tz.
  function dayBounds(dayStr, tz) {
    const [y, mo, d] = dayStr.split('-').map(Number);
    const start = zonedToEpoch(y, mo, d, 0, 0, 0, tz);
    // Next day's components (handles month/year rollover via UTC arithmetic).
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    const end = zonedToEpoch(
      next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz);
    return [start, end];
  }

  // Shift a "YYYY-MM-DD" by deltaDays (calendar-safe).
  function shiftDay(dayStr, deltaDays) {
    const [y, mo, d] = dayStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d + deltaDays));
    return dt.getUTCFullYear() + '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getUTCDate()).padStart(2, '0');
  }

  // ---- log → state ---------------------------------------------------------
  function sortLog(log) {
    // Stable sort by `at`; preserve insertion order for identical timestamps.
    return log
      .map((e, i) => [e, i])
      .sort((a, b) => (a[0].at - b[0].at) || (a[1] - b[1]))
      .map(x => x[0]);
  }

  // Current aligner state. Default IN (the resting state) when log is empty.
  function currentState(log) {
    if (!log || !log.length) return 'IN';
    const sorted = sortLog(log);
    // Walk forward applying idempotent transitions, so a stray duplicate
    // event never flips us into a wrong state.
    let state = 'IN';
    for (const e of sorted) {
      if (e.type === 'OUT' && state === 'IN') state = 'OUT';
      else if (e.type === 'IN' && state === 'OUT') state = 'IN';
    }
    return state;
  }

  // Build out-windows [{start, end, open}] by pairing OUT→next IN.
  // A still-open window is closed at nowMs and flagged open:true.
  function buildWindows(log, nowMs) {
    const sorted = sortLog(log);
    const windows = [];
    let openStart = null;
    for (const e of sorted) {
      if (e.type === 'OUT' && openStart === null) openStart = e.at;
      else if (e.type === 'IN' && openStart !== null) {
        windows.push({ start: openStart, end: e.at, open: false });
        openStart = null;
      }
      // duplicates (OUT while open, IN while closed) are ignored
    }
    if (openStart !== null) {
      windows.push({ start: openStart, end: nowMs, open: true });
    }
    return windows;
  }

  // Overlap of [s,e) with [lo,hi), in ms (never negative).
  function overlapMs(s, e, lo, hi) {
    return Math.max(0, Math.min(e, hi) - Math.max(s, lo));
  }

  // Sum of out-time (ms) falling within the local day `dayStr`, clipping each
  // window at the local midnight boundaries (so a cross-midnight window splits
  // correctly between the two days).
  function outMsInDay(windows, dayStr, tz) {
    const [lo, hi] = dayBounds(dayStr, tz);
    let total = 0;
    for (const w of windows) total += overlapMs(w.start, w.end, lo, hi);
    return total;
  }

  // ---- reminder ladder -----------------------------------------------------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // Given the moment aligners went OUT and the budget (minutes) remaining at
  // that moment, return the future notification fires for this out-window.
  // Offsets compress toward 0 as remaining budget shrinks.
  function scheduleFor(outAtMs, budgetRemainingMinAtOut, nowMs, config) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config);
    const budget = Math.max(0, budgetRemainingMinAtOut);
    const scale = clamp(budget / cfg.TARGET_OUT_MIN, cfg.MIN_COMPRESS, 1);
    const fires = cfg.LADDER.map(([m, tone]) => ({
      atMs: Math.round(outAtMs + m * scale * MS_PER_MIN),
      tone,
    }));
    // Critical fire: the instant cumulative out-time would exhaust the budget.
    fires.push({ atMs: Math.round(outAtMs + budget * MS_PER_MIN), tone: 'critical' });
    // Drop past fires, sort, dedupe identical (atMs,tone).
    const seen = new Set();
    return fires
      .filter(f => f.atMs > nowMs)
      .sort((a, b) => a.atMs - b.atMs)
      .filter(f => {
        const k = f.atMs + ':' + f.tone;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
  }

  // ---- snapshot (the one object every surface renders) ---------------------
  function deriveSnapshot(log, nowMs, tz, config) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config);
    const targetOutMs = cfg.TARGET_OUT_MIN * MS_PER_MIN;
    const state = currentState(log);
    const windows = buildWindows(log, nowMs);
    const todayStr = localDayString(nowMs, tz);
    const [d0] = dayBounds(todayStr, tz);

    const outMsToday = outMsInDay(windows, todayStr, tz);
    const budgetRemainingMs = targetOutMs - outMsToday;
    const elapsedTodayMs = Math.max(0, nowMs - d0);
    const wornMsToday = Math.max(0, elapsedTodayMs - outMsToday);

    let currentWindowStartedAt = null;
    let pendingFires = [];
    if (state === 'OUT') {
      const open = windows[windows.length - 1];
      currentWindowStartedAt = open ? open.start : null;
      // Budget remaining at the moment this window opened (exclude this
      // window's own elapsed time so the ladder is anchored to the open time).
      const thisWindowMsToday = open ? overlapMs(open.start, nowMs, d0, nowMs + MS_PER_DAY) : 0;
      const budgetAtOpenMin = (budgetRemainingMs + thisWindowMsToday) / MS_PER_MIN;
      pendingFires = scheduleFor(currentWindowStartedAt, budgetAtOpenMin, nowMs, cfg);
    }

    // History: previous days (excludes today), most-recent first.
    // We only have real data from the first event onward — days entirely
    // before tracking began are omitted rather than shown as fake "24h worn".
    const firstEventAt = windows.length ? windows[0].start : null;
    const history = [];
    for (let i = 1; i <= cfg.HISTORY_DAYS; i++) {
      const dStr = shiftDay(todayStr, -i);
      const [lo, hi] = dayBounds(dStr, tz);
      // No data at all, or this whole day precedes the first tracked event.
      if (firstEventAt === null || hi <= firstEventAt) continue;
      const outMs = outMsInDay(windows, dStr, tz);
      const wornMs = Math.max(0, (hi - lo) - outMs);
      history.push({
        date: dStr,
        outMin: Math.round(outMs / MS_PER_MIN),
        wornMin: Math.round(wornMs / MS_PER_MIN),
        hitTarget: outMs <= targetOutMs,
      });
    }

    return {
      state,
      todayDate: todayStr,
      outMinToday: Math.round(outMsToday / MS_PER_MIN),
      budgetRemainingMin: Math.round(budgetRemainingMs / MS_PER_MIN),
      budgetRemainingMs,
      overBudget: budgetRemainingMs < 0,
      wornMinToday: Math.round(wornMsToday / MS_PER_MIN),
      wornTargetH: cfg.WEAR_TARGET_H,
      targetOutMin: cfg.TARGET_OUT_MIN,
      currentWindowStartedAt,
      pendingFires,
      history,
      nowMs,
      tz,
    };
  }

  // ---- write path (idempotent append) --------------------------------------
  function makeId(at) {
    const r = Math.floor((typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint32Array(1))[0]
      : Math.random() * 0xffffffff)).toString(36);
    return 'evt_' + at + '_' + r;
  }

  // Apply an event to a log with idempotency + dedup.
  // Returns { log, applied:boolean, reason }.
  //  - dedup: same id already present -> no-op
  //  - idempotent: event.type === current state -> no-op (no second window)
  function applyEvent(log, event, nowMs) {
    const list = Array.isArray(log) ? log.slice() : [];
    const at = Number.isFinite(event.at) ? event.at : nowMs;
    const id = event.id || makeId(at);
    // Reject anything that isn't an explicit IN/OUT — a missing/garbage type
    // must NOT silently default to a state-flipping event.
    if (event.type !== 'IN' && event.type !== 'OUT') {
      return { log: list, applied: false, reason: 'invalid-type' };
    }
    if (list.some(e => e.id === id)) {
      return { log: list, applied: false, reason: 'duplicate-id' };
    }
    const type = event.type;
    if (type === currentState(list)) {
      return { log: list, applied: false, reason: 'noop-same-state' };
    }
    list.push({ type, at, src: event.src || 'unknown', id });
    return { log: list, applied: true, reason: 'appended' };
  }

  // ---- spoken summary (for the Shortcut "Speak Text" action) ---------------
  function fmtHM(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return h + (h === 1 ? ' hour ' : ' hours ') + m + (m === 1 ? ' minute' : ' minutes');
    if (h) return h + (h === 1 ? ' hour' : ' hours');
    return m + (m === 1 ? ' minute' : ' minutes');
  }

  function sayLine(snapshot) {
    if (snapshot.state === 'OUT') {
      if (snapshot.overBudget) {
        return 'Aligners out. You are over today’s out-budget by ' +
          fmtHM(-snapshot.budgetRemainingMin) + '. Put them back in soon.';
      }
      return 'Aligners out. ' + fmtHM(snapshot.budgetRemainingMin) +
        ' of out-time left today.';
    }
    return 'Aligners in. You’ve worn them ' + fmtHM(snapshot.wornMinToday) +
      ' today, with ' + fmtHM(Math.max(0, snapshot.budgetRemainingMin)) +
      ' of out-time still spare.';
  }

  return {
    DEFAULT_CONFIG,
    MS_PER_MIN, MS_PER_HOUR, MS_PER_DAY,
    localParts, zonedToEpoch, localDayString, dayBounds, shiftDay,
    sortLog, currentState, buildWindows, overlapMs, outMsInDay,
    clamp, scheduleFor, deriveSnapshot, makeId, applyEvent,
    fmtHM, sayLine,
  };
}));
