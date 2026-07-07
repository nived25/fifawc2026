import { read, readOr } from './store.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// OUTPUT_SUBDIR scopes the output to a per-group folder (e.g. 'g2' -> public/g2/app-data.json).
// Empty (default) writes public/app-data.json — the LR root behaviour, unchanged.
const OUT_SUBDIR = process.env.OUTPUT_SUBDIR || '';
const PUBLIC_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'public', OUT_SUBDIR);

export function buildAppData() {
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

  const leaderboard = readOr('leaderboard.json', []);
  const fixtures = readOr('fixtures.json', []);
  const standings = readOr('standings.json', {});
  const bracket = readOr('bracket.json', {});
  const predictions = readOr('predictions.json', {});
  const meta = readOr('meta.json', { phase: 'group', lastUpdated: Date.now() });
  const teams = readOr('teams.json', {});
  const participants = readOr('participants.json', []);
  const r32tbd = readOr('r32_tbd.json', []);
  const scoringLedger = readOr('scoring_ledger.json', []);
  const feedRaw = readOr('feed.json', { days: [] });

  const KO_ROUNDS = ['r32', 'r16', 'qf', 'sf', 'final'];

  // Match-level locking (r16 onward): a pick becomes public once its match is within
  // matchLockMins of kickoff. Locks are derived from time, never stored.
  const MATCH_LOCK_MINS = Number(process.env.MATCH_LOCK_MINS || meta.matchLockMins || 30);
  const kickoffById = {};
  for (const f of fixtures) kickoffById[f.id] = f.kickoffMs;
  const matchLocked = (id) => {
    const k = kickoffById[+id];
    return !!k && Date.now() >= k - MATCH_LOCK_MINS * 60000;
  };

  const publicPredictions = {};
  for (const [pid, pred] of Object.entries(predictions)) {
    const locked = typeof pred.locked === 'boolean'
      ? { r32: pred.locked }  // backwards compat
      : (pred.locked || {});

    const entry = { locked, submittedAtMs: pred.submittedAtMs || {} };

    // r32: legacy round-level exposure. r16+: expose per match once time-locked (id-keyed picks).
    for (const rk of KO_ROUNDS) {
      if (rk === 'r32') {
        if (locked.r32) {
          const picks = pred.r32 || pred.ko;
          if (picks) entry.r32 = picks;
        }
        continue;
      }
      const picks = pred[rk];
      if (!picks) continue;
      const pub = {};
      for (const [mid, pick] of Object.entries(picks)) {
        if (matchLocked(mid)) pub[mid] = pick;
      }
      if (Object.keys(pub).length) entry[rk] = pub;
      // participation only (ids, never scores): lets the UI show "8 of 10 predicted"
      // and who's in, while actual picks stay hidden until each match locks
      entry[rk + 'Ids'] = Object.keys(picks);
    }
    // Expose bonus picks after r32 locks
    if (locked.r32 || locked.r16) {
      if (pred.finalists) entry.finalists = pred.finalists;
      if (pred.champion) entry.champion = pred.champion;
    }

    publicPredictions[pid] = entry;
  }

  const appData = {
    meta: {
      ...meta,
      matchLockMins: MATCH_LOCK_MINS,
      generatedAt: Date.now()
    },
    leaderboard,
    fixtures: fixtures.map(f => ({
      id: f.id,
      round: f.round,
      group: f.group,
      kickoffMs: f.kickoffMs,
      status: f.status,
      home: { code: f.home.code, goals: f.home.goals },
      away: { code: f.away.code, goals: f.away.goals },
      finished: f.finished,
      venue: f.venue,
      scorers: f.scorers || []
    })),
    topScorers: (() => {
      const map = {};
      for (const f of fixtures) {
        if (!f.finished || !f.scorers) continue;
        for (const s of f.scorers) {
          // Normalize abbreviated names ("K. Mbappé") with full names ("Kylian Mbappé")
          // by keying on last word (surname) + team
          const lastName = s.name.split(' ').pop();
          const key = lastName + '|' + s.team;
          if (!map[key]) {
            map[key] = { name: s.name, team: s.team, goals: 0 };
          } else if (s.name.length > map[key].name.length) {
            map[key].name = s.name; // prefer the fuller name for display
          }
          map[key].goals++;
        }
      }
      return Object.values(map).sort((a, b) => b.goals - a.goals).slice(0, 10);
    })(),
    standings,
    bracket,
    _r32tbd: r32tbd,
    predictions: publicPredictions,
    // Daily Gaffer feed — snapshot/keysAtGen are generator-internal diff state, never shipped
    feed: { days: (feedRaw.days || []).map(d => ({ dateKey: d.dateKey, generatedAtMs: d.generatedAtMs, posts: d.posts })) },
    teams: Object.fromEntries(
      Object.entries(teams).map(([code, t]) => [code, { name: t.name, flag: t.flag, logo: t.logo }])
    ),
    participants: participants.map(p => ({
      id: p.id,
      name: p.name,
      picks: p.picks,
      email: p.email   // needed for login matching in frontend
    })),
    _scoringLog: (() => {
      const byParticipant = {};
      for (const entry of scoringLedger) {
        if (!byParticipant[entry.participantId]) byParticipant[entry.participantId] = [];
        byParticipant[entry.participantId].push({
          points: entry.points,
          reason: entry.reason,
          matchId: entry.matchId,
          ts: entry.ts
        });
      }
      return byParticipant;
    })()
  };

  const outPath = join(PUBLIC_DIR, 'app-data.json');
  writeFileSync(outPath, JSON.stringify(appData));
  console.log(`[build] app-data.json written (${(JSON.stringify(appData).length / 1024).toFixed(1)} KB)`);
  return appData;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  import('dotenv/config').then(() => {
    buildAppData();
  });
}
