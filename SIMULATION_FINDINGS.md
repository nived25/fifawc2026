# FIFA WC 2026 App — Simulation Findings & Fixes

**Tested:** R16-done + QF-predictions-open state (simulated via synthetic app-data.json)
**Tester:** Nived (account used for all verification)
**Date:** 2026-06-29

---

## Bugs Found & Fixed

### Bug 1 — Knockouts tab always showed lock screen [FIXED]

**Symptom:** Leaderboard → Knockouts tab showed "Group stage is underway, check back here when knockouts begin" even after the tournament entered the KO phase.

**Root cause:** The lock message was unconditional — no check for `meta.phase`.

**Fix:** Split into two sc-if blocks:
- `koPhaseGroup` (`meta.phase !== 'ko'`) → shows the group-stage-in-progress message
- `koPhaseKO` (`meta.phase === 'ko'`) → shows a real KO leaderboard sorted by `ko + bonus` points

**Verified:** KO leaderboard appears correctly in R16 state. Nived #1 with 162 KO pts, all others 0 with "no picks scored."

---

### Bug 2 — Overall tab was completely empty [FIXED]

**Symptom:** Leaderboard → Overall tab showed nothing — just blank space.

**Root cause:** The `fantOverall` sc-if block and `overallLeaderboard` data were missing.

**Fix:** Added Overall tab content block with 3-column layout (GRP / KO / TOTAL) and corresponding `overallLeaderboard` array in `renderVals()`.

**Verified:** Shows all 12 participants with correct GRP, KO, TOTAL columns.

---

### Bug 3 — Predict tab showed "0 of 0 saved" when bracket was empty [FIXED]

**Symptom:** During the interim period after a round finishes but before the next round's bracket is populated, the Predict tab showed "Save 0 of 0 predictions" button with no matches listed.

**Root cause:** Match list rendered unconditionally; count was 0 with empty bracket.

**Fix:** Added `koHasMatches`/`koNoMatches` gates:
- `koNoMatches` → shows "Teams being decided — check back once [previous round] matches are confirmed" message
- `koHasMatches` → shows match prediction forms and submit button (unchanged)

**Verified:** QF tab in R16 state shows "Quarter-finals predictions locked" (lock time in past per sim). The `koNoMatches` state fires when lock is open but bracket is empty — correct logic confirmed in code.

---

## Bugs Fixed This Session (post-R32)

### Bug 4 — Group Stage tab showed TOTAL pts, not group-only pts [FIXED]

**Where:** Leaderboard → Group Stage tab, PTS column.

**Fix:** `buildParticipants()` now uses `breakdown.group` from `p.breakdown`. Added `this.groupForm` (group-fixtures-only W/D/L tracker) so team record badges also exclude KO-round results.

**Verified:** Nived shows 30 pts (not 34), Rushabh shows 29 pts (not 37). W/D/L counts group matches only.

---

### Bug 5 — Delta always shows "— no change"

**Where:** Leaderboard hero card (YOUR RANK section).

**Status:** NOT fixed — `delta` in `leaderboard.json` is computed from score delta (points gained today), not rank delta. After first match, shows "+4 today" correctly. Rank-delta is a separate future improvement.

---

### Bug 6 — Player detail sheet showed wrong breakdown [FIXED]

**Where:** Group Stage tab → tap any player row → detail sheet BREAKDOWN section.

**Fix:** `buildParticipants()` now returns `koPts`, `bonusPts`, `totalPts` per participant. Detail sheet HTML updated to show real KO and Bonus pts with dynamic colors (purple for KO pts > 0, gold for bonus > 0). Total now uses `detail.totalPts` instead of `detail.pts`.

**Verified:** Rushabh detail shows Group=29, KO=8 (purple), Bonus=0, Total=37. ✅

---

### Bug 7 — KO Leaderboard tab showed 0 for everyone [FIXED]

**Where:** Leaderboard → Knockouts tab.

**Fix:** `koLeaderboard` in `renderVals()` fixed to use `p.breakdown.ko` (not non-existent `p.ko`). Added `correctPicks` and `exactScores` columns from `_scoringLog`. Header shows ✓ / EXACT / PTS.

**Verified:** Rushabh: 1✓ 1exact 8pts. Nived: 1✓ 0exact 4pts. ✅

---

### Bug 8 — Profile MATCH LOG was empty [FIXED]

**Root cause:** Test was using wrong localStorage key (`wc26_session` instead of `fifa_auth`). Code was always correct.

**Verified:** With correct `fifa_auth` key set, log shows "CAN advances (R32) +4" and group match entries. ✅

---

## Simulation Setup Notes

- All fix verification used synthetic `app_data_r16.json` (R16 complete, QF active)
- Sim sets all KO round lock times to epoch 1ms (past) so all rounds show "locked" — this is a sim limitation, not an app bug
- Original `app-data.json` restored after testing
- Nived's predictions used: finalists = [BRA, FRA], champion = FRA, R32 + R16 picks locked
