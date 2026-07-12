# Data refresh trigger

## Why an external cron

The `Refresh FIFA Data` workflow (`.github/workflows/refresh.yml`) rebuilds `public/app-data.json` — which is what reveals KO picks (30 min before each kickoff), publishes the noon Gaffer feed, and updates live stats.

GitHub's `schedule:` trigger (`*/10`) is **best-effort and heavily throttled** — in practice it fires every ~100 min (measured range 51–223 min), silently dropping ~90% of ticks. That made picks/feed/stats appear 1–3 hours late.

`workflow_dispatch` events are **not** throttled — they start within seconds. So a reliable external heartbeat calls the workflow via the dispatch API, and GitHub runs it promptly.

## The external heartbeat (cron-job.org)

- Schedule: **every 10 minutes**
- Method: `POST`
- URL: `https://api.github.com/repos/nived25/fifawc2026/actions/workflows/refresh.yml/dispatches`
- Headers:
  - `Authorization: Bearer <FINE_GRAINED_PAT>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
- Body: `{"ref":"main"}`
- Success response: `204 No Content`

## The token

Fine-grained GitHub PAT, scoped to **only** `nived25/fifawc2026`, permission **Actions: Read and write** (nothing else). Stored in cron-job.org, never in this repo.

**Rotation:** set to expire yearly. Next rotation due: **2027-07** (update when rotated).

## Notes

- The GitHub `schedule:` trigger is left enabled as a free fallback if the external service ever lapses.
- Original intended cadence was 10 min (144 runs/day), so worldcup26.ir API volume is unchanged from the original design.
- If API-quota errors ever appear in run logs, widen the cron to 15 min, or split a lightweight `node src/buildAppData.js`-only reveal job from the full fetch pipeline (see plan history).
