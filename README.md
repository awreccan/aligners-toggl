# 22 — Aligner Wear Tracker (Toggl edition)

A voice-friendly iPhone PWA that helps Jason keep his clear aligners in
**22 hours a day**, by reframing the goal as a **2-hour daily out-budget** and
reminding him to reinsert before it runs out — with **Toggl Track** as the
time backend.

Every time the aligners come out, the app starts a **Toggl time entry**
("Aligners OUT"); putting them back in stops it. So each out-window is a real
Toggl entry, the day's out-time is the sum of today's entries, and the
out-budget is `120 min − that`. Toggl is the source of truth — edit an entry in
Toggl and the app reflects it on the next refresh.

This is **v2** of "22". v1 (`../aligners/`) uses a GitHub Gist as its backend;
this variant swaps the backend for Toggl. The pure wear-time logic
(`app/wear-core.js`) is **shared verbatim** between the two.

## Architecture — why a proxy

The **Toggl API is not CORS-enabled**, so a browser can't call it directly. The
PWA instead calls a **Google Apps Script Web App** you own (CORS-open via
`ContentService`), and that script calls Toggl server-side with your API token
(`UrlFetchApp`, no CORS). The browser stores only the unguessable `/exec` URL —
**never the Toggl token**.

```
browser (PWA)  ──CORS-open──>  your Apps Script /exec  ──server-to-server──>  Toggl
```

| Piece | What | Where |
|---|---|---|
| **Screen** | The PWA (ring, toggle, history, setup) | static host (e.g. GitHub Pages) |
| **Proxy** | CORS bridge + Toggl token holder | a **Google Apps Script Web App** you deploy |
| **Database** | Out-windows as time entries | your **Toggl Track** account |

## Files

```
app/
  index.html        UI + first-run setup screen (collects the /exec URL)
  styles.css        light/dark, mobile-first
  wear-core.js      PURE wear-time / out-budget / reminder-ladder logic (tz-aware) — shared verbatim with v1
  toggl-store.js    data layer: talks to the /exec proxy; pure Toggl-entry → event-log transform
  app.js            controller (toggle, live ring, offline cache, sync)
  service-worker.js network-first offline shell
  manifest.json     installable PWA
  icons/            22-branded icons (any + maskable) — shared with v1
backend/
  Code.gs           Apps Script proxy: actions state / out / in; holds Toggl token in Script Properties
  DEPLOY.md         one-time deploy recipe (paste token, deploy "Execute as Me / Anyone")
tests/
  unit/             wear-core.test.js (shared core) + toggl-map.test.js (the Toggl→log transform)
```

## The Toggl request shapes

| Aligner action | Toggl call |
|---|---|
| **OUT** | `POST /api/v9/workspaces/{wid}/time_entries` body `{"description":"Aligners OUT","start":"<ISO8601>","duration":-1,"created_with":"22","wid":<wid>,"workspace_id":<wid>}` |
| **IN** | `PATCH /api/v9/workspaces/{wid}/time_entries/{id}/stop` |
| current | `GET /api/v9/me/time_entries/current` |
| today | `GET /api/v9/me/time_entries?start_date=…&end_date=…` |

Auth (server-side only): `Authorization: Basic base64("<API_TOKEN>:api_token")`.

## Develop / test

```bash
npm test     # unit tests (wear-core + toggl-map)
npm run check  # node --check every .js file (syntax)
```

## Deploy

1. Deploy `backend/Code.gs` as an Apps Script Web App — see **backend/DEPLOY.md**.
2. Host `app/` on any static host and open it; paste your `/exec` URL on the
   setup screen.

### Setting it up for Jason

Jason deploys his **own** copy of `backend/Code.gs` under his Google account with
**his** Toggl token in Script Properties, then pastes **his** `/exec` URL into the
app's setup screen (Settings ⚙ re-opens it anytime). His Toggl token never touches
the app — only his proxy URL does.
