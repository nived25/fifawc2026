# FIFA Fantasy League 2026 — Claude Instructions

## What this project is

A single-page fantasy league app for 12 office participants during FIFA World Cup 2026. Participants pick 4 national teams at the start of the tournament and score points based on those teams' group-stage results. They also submit knockout-round score predictions (R32 → R16 → QF → SF → Final) for bonus points, and pick 2 finalists + 1 champion.

The app is a single HTML file served as a static site on Vercel. Live match data is fetched from `worldcup26.ir` every 10 minutes via a GitHub Actions cron job. There is no database — all state lives in flat JSON files committed to the repo.

## Architecture

```
GitHub Actions (cron 10 min)
  └── npm run refresh (bootstrap.js + once.js)
        ├── Fetches live data → data/*.json
        ├── Scores predictions → data/leaderboard.json
        └── Builds public/app-data.json → git commit → push

Vercel (static site)
  └── serves public/
        ├── index.dc.html  ← the entire app (1700+ lines)
        └── app-data.json  ← all data the frontend needs
```

The frontend fetches `./app-data.json` on load and re-fetches every 60 seconds. No server-side rendering. No API routes.

## Key files

| File | Purpose |
|------|---------|
| `public/index.dc.html` | The entire app — HTML, CSS, and JS in one file using DC Logic framework |
| `public/app-data.json` | Generated data bundle served to the browser |
| `src/bootstrap.js` | Fetches live fixtures, teams, standings from worldcup26.ir |
| `src/once.js` | Orchestrates: fetch → score → build app-data.json |
| `src/scoring.js` | Calculates group-stage points and KO prediction scores |
| `src/buildAppData.js` | Assembles public/app-data.json from all data/*.json files |
| `src/sync-predictions.js` | Pulls KO predictions from Google Apps Script into data/predictions.json |
| `src/store.js` | `read(file)` / `readOr(file, default)` helpers for data/*.json |
| `data/participants.json` | 12 participants: id, name, picks (4 team codes), email |
| `data/predictions.json` | KO predictions per participant (keyed by participantId) |
| `data/leaderboard.json` | Scored + ranked leaderboard, rebuilt on every refresh |
| `config/scoring.json` | Point values (group win=3, finalist=25, champion=50, KO by round) |
| `google-apps-script/Code.gs` | Apps Script backend for auth + prediction storage |
| `vercel.json` | `framework:null`, outputDirectory:public, buildCommand |
| `.github/workflows/refresh.yml` | 10-min cron, commits updated app-data.json with `[skip vercel]` |

## Frontend framework: DC Logic

`index.dc.html` uses a lightweight reactive framework called DC Logic. Key patterns:

- `{{ expression }}` — template binding, re-evaluated on every `setState` call
- `<sc-if value="{{ condition }}" hint-placeholder-val="{{ initialValue }}">` — conditional rendering
- `<sc-for list="{{ array }}" as="item" hint-placeholder-count="N">` — list rendering
- `renderVals()` — returns a flat object of all template values; called on every state change
- `setState(newState)` — merges state and triggers re-render
- `deepFlags(obj)` — recursively adds `fu` (flag URL) alongside any property named `f`, `flag`, or `of`
- `hint-placeholder-val` — the value used before `renderVals` first runs (avoids flash)

The component class extends DCLogic and lives inside a `<script>` tag at the bottom of the HTML. Constructor → `componentDidMount` → `fetchLiveData` → `applyLiveData` is the startup sequence.

## Scoring rules

**Group stage** (automatic, based on team picks):
- Win: 3 pts, Draw: 1 pt, Loss: 0 pts

**Knockout predictions** (manual, entered in the Predict tab):
- Correct winner: base pts per round (R32=4, R16=5, QF=10, SF=15, Final=20)
- Exact score: 2× the base pts

**Bonus predictions** (entered before R32 locks):
- Correct finalist: 25 pts each
- Correct champion: 50 pts

## Login system

- Email + 4-digit PIN (PIN is always `5555` for all participants)
- **With APPS_SCRIPT_URL set**: authenticates against Google Sheet via Apps Script
- **Without APPS_SCRIPT_URL** (offline fallback): matches email against `data/participants.json`
- Session stored in `localStorage` as `{ participantId, name, email }`
- Sign out via profile sheet (tap avatar top-right)

Participant emails follow `[firstname].[lastname]@loylty.com`.

## Data flow for KO predictions

1. User enters scores in Predict tab → state stored locally in component state
2. User taps "Save predictions" → saved to `localStorage` (always) + POST to Apps Script (if URL set)
3. On page load, predictions are loaded from 3 tiers in priority order:
   - **Tier 1**: `app-data.json` (locked/scored rounds, always wins)
   - **Tier 2**: Apps Script `?action=load` (live unlocked picks)
   - **Tier 3**: `localStorage` (device fallback — fills any remaining blanks)
4. GitHub Actions runs `sync-predictions.js` → pulls from Apps Script → writes `data/predictions.json`
5. `once.js` scores predictions against real results → `data/leaderboard.json`
6. `buildAppData.js` bundles into `public/app-data.json`
7. Git commits + pushes with `[skip vercel]` (data-only, no redeploy)
8. Browser re-fetches `app-data.json` every 60 seconds

The `submitted` flag is restored when predictions are loaded from any tier, so the CTA button correctly shows saved state on page refresh.

## Environment variables

| Variable | Where needed | Purpose |
|----------|-------------|---------|
| `APISPORTS_KEY` | local `.env` only | worldcup26.ir API key for fetching match data |
| `APPS_SCRIPT_URL` | `.env` + Vercel env + GitHub Secret | Google Apps Script web app URL for auth/predictions |
| `DATA_DIR` | GitHub Actions | Path to data directory (set to `./data`) |

Never hardcode or log either key. `.env` is gitignored.

## Deployment

- **Production URL:** https://fifawc2026-phi.vercel.app
- **GitHub repo:** https://github.com/nived25/fifawc2026
- **Vercel project:** nived-lals-projects/fifawc2026

Every push to `main` auto-deploys to Vercel (Vercel is connected to the GitHub repo). GitHub Actions commits use `[skip vercel]` in the message to avoid triggering redeploys for data-only changes.

To deploy manually:
```bash
vercel --yes --prod
```

## Local development

```bash
cp .env.example .env          # add APISPORTS_KEY
npm ci
npm run refresh               # fetch live data + score + build app-data.json
node src/server.js            # serves public/ at localhost:3000
```

The local server at `localhost:3000` serves `public/index.dc.html` directly. All edits to `index.dc.html` are reflected immediately on page refresh (no build step for the frontend).

## Active KO round logic

`data/meta.json` contains `activeRound` (one of `r32`, `r16`, `qf`, `sf`, `final`) and `koLockTimes` (ms timestamps per round). `once.js` computes these from the fixture schedule. The frontend reads `meta.activeRound` to know which round to show in the Predict tab, and locks submissions 5 minutes before the first match of that round.

## Predict tab behavior

- **CTA label is progress-aware**: "Save K of N predictions" (not yet saved), "✓ K of N saved · keep going" (partial, amber), "✓ All N predictions saved" (complete, green)
- **`submitted` flag**: In-memory only; restored from any loading tier so the button correctly reflects saved state on page refresh
- **Pre-Knockout Bonus section**:
  - Shown as editable UI (finalist picker, champion picker) until R32 lock time
  - After R32 starts (`isBonusLocked = activeKey !== 'r32' || isKoLocked`), becomes a read-only locked summary showing the user's finalist and champion picks persistently
  - The countdown-to-lock banner is also hidden once `isBonusLocked` is true
  - The finalist picker shows **all R32 teams** from live data (`_r32tbd` in app-data.json), sorted alphabetically — not a hardcoded list
- **Apps Script POST**: Google redirects POST → GET before responding; this works in the browser and Node.js `fetch` but fails in `curl -L`. Use `npm run refresh` to verify sheet sync, not curl POST.

## Do not

- Do not call `/players` or per-match detail endpoints on worldcup26.ir (quota cost)
- Do not hardcode or log `APISPORTS_KEY` or `APPS_SCRIPT_URL`
- Do not add backend routes to `src/server.js` — the app is intentionally static
- Do not use `app-data.json` as a source of truth for edits — always edit the source files in `data/` and regenerate
