import 'dotenv/config';
import { readFileSync } from 'fs';
import { read, write, readOr } from './store.js';
import { computeScores, getLockTime, getKoLockTimes, determineActiveRound } from './scoring.js';
import { computeStandings } from './standings.js';
import { updateBracket } from './bracket.js';
import { buildAppData } from './buildAppData.js';
import { syncPredictions } from './sync-predictions.js';
import { resolveR32Teams } from './resolveR32.js';
import { generateFeed } from './feed.js';

const API_BASE = 'https://worldcup26.ir';

const STADIUM_UTC_OFFSET = {
  '1': -6, '2': -6, '3': -6,
  '4': -5, '5': -5, '6': -5,
  '7': -4, '8': -4, '9': -4,
  '10': -4, '11': -4, '12': -4,
  '13': -7, '14': -7, '15': -7, '16': -7
};

const ROUND_NAMES = {
  group: 'Group Stage', r32: 'Round of 32', r16: 'Round of 16',
  qf: 'Quarter-finals', sf: 'Semi-finals', third: '3rd Place', final: 'Final'
};

function localToUtcMs(localDate, stadiumId) {
  const [datePart, timePart] = localDate.split(' ');
  const [month, day, year] = datePart.split('/');
  const [hour, min] = timePart.split(':');
  const offsetH = STADIUM_UTC_OFFSET[String(stadiumId)] ?? -5;
  return Date.UTC(+year, +month - 1, +day, +hour - offsetH, +min);
}

function parseScorers(raw, teamCode) {
  if (!raw || raw === 'null') return [];
  const inner = raw.replace(/^\{/, '').replace(/\}$/, '');
  if (!inner) return [];
  const entries = inner.match(/"[^"]*"/g) || [];
  return entries.map(e => {
    const s = e.replace(/^"|"$/g, '').trim();
    const m = s.match(/^(.+?)\s+(\d+(?:\+\d+)?)'?$/);
    return { name: m ? m[1].trim() : s, minute: m ? parseInt(m[2]) : null, team: teamCode };
  });
}

async function pollFixtures() {
  console.log('[once] Fetching latest games from worldcup26.ir...');
  try {
    const res = await fetch(`${API_BASE}/get/games`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gamesRaw = await res.json();
    const gameList = Array.isArray(gamesRaw) ? gamesRaw : (gamesRaw.games || []);

    const teamIdMap = readOr('team_id_map.json', {});
    const stadiumIdMap = readOr('stadium_id_map.json', {});

    const fixtures = [];
    const r32tbd = [];

    for (const g of gameList) {
      const round = ROUND_NAMES[g.type] || g.type;
      const kickoffMs = localToUtcMs(g.local_date, g.stadium_id);
      const isGroup = g.type === 'group';
      const homeResolved = g.home_team_id && g.home_team_id !== '0';
      const awayResolved = g.away_team_id && g.away_team_id !== '0';
      const finished = g.finished === 'TRUE';
      const homeCode = homeResolved ? (teamIdMap[String(g.home_team_id)] || null) : null;
      const awayCode = awayResolved ? (teamIdMap[String(g.away_team_id)] || null) : null;
      const homeName = homeResolved
        ? (g.home_team_name_en || homeCode)
        : (g.home_team_label || 'TBD');
      const awayName = awayResolved
        ? (g.away_team_name_en || awayCode)
        : (g.away_team_label || 'TBD');
      const homeGoals = finished ? parseInt(g.home_score) : null;
      const awayGoals = finished ? parseInt(g.away_score) : null;
      const venue = stadiumIdMap[String(g.stadium_id)] || null;
      const group = isGroup ? `Group ${g.group}` : null;

      if (homeCode && awayCode) {
        const penHome = g.home_penalty_score != null && g.home_penalty_score !== '' ? parseInt(g.home_penalty_score) : null;
        const penAway = g.away_penalty_score != null && g.away_penalty_score !== '' ? parseInt(g.away_penalty_score) : null;
        fixtures.push({
          id: parseInt(g.id),
          apiId: parseInt(g.id),
          round,
          group,
          kickoffMs,
          status: finished ? 'FT' : (g.time_elapsed === 'live' ? 'LIVE' : 'NS'),
          home: { code: homeCode, name: homeName, goals: homeGoals },
          away: { code: awayCode, name: awayName, goals: awayGoals },
          finished,
          penHome,
          penAway,
          venue,
          scorers: [
            ...parseScorers(g.home_scorers, homeCode),
            ...parseScorers(g.away_scorers, awayCode)
          ].sort((a, b) => (a.minute || 0) - (b.minute || 0))
        });
      }

      if (g.type === 'r32') {
        r32tbd.push({
          apiId: parseInt(g.id),
          home: { code: homeCode, name: homeName, resolved: !!homeResolved },
          away: { code: awayCode, name: awayName, resolved: !!awayResolved },
          kickoffMs,
          venue,
          finished,
          homeGoals,
          awayGoals,
          penHome: g.home_penalty_score != null && g.home_penalty_score !== '' ? parseInt(g.home_penalty_score) : null,
          penAway: g.away_penalty_score != null && g.away_penalty_score !== '' ? parseInt(g.away_penalty_score) : null
        });
      }
    }

    fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);
    r32tbd.sort((a, b) => a.kickoffMs - b.kickoffMs);

    write('fixtures.json', fixtures);
    write('r32_tbd.json', r32tbd);
    console.log(`[once] ${fixtures.length} fixtures updated (${fixtures.filter(f => f.finished).length} finished), ${r32tbd.length} R32`);
    return true;
  } catch (err) {
    console.error('[once] Poll error:', err.message);
    return false;
  }
}

async function run() {
  console.log('=== FIFA Fantasy — Poll + Score + Build ===\n');

  await pollFixtures();

  // Sync predictions from Google Apps Script (if configured)
  await syncPredictions();

  const standings = computeStandings();
  console.log(`[once] Standings for ${Object.keys(standings).length} groups`);

  resolveR32Teams(standings);

  const bracket = updateBracket();
  const koRounds = Object.keys(bracket).filter(k => bracket[k].length > 0);
  console.log(`[once] Bracket (${koRounds.length} rounds)`);

  const fixtures = read('fixtures.json') || [];
  const koLockTimes = getKoLockTimes();
  const activeRound = determineActiveRound(fixtures);

  // Auto-lock predictions per round
  const predictions = readOr('predictions.json', {});
  let locked = 0;
  for (const [roundKey, lockMs] of Object.entries(koLockTimes)) {
    if (roundKey !== 'r32') continue; // r16+ uses match-level time locks, no stored flags
    if (!lockMs || Date.now() < lockMs) continue;
    for (const [, pred] of Object.entries(predictions)) {
      // Support both old (pred.locked=bool) and new (pred.locked={r32:true}) format
      const alreadyLocked = typeof pred.locked === 'boolean'
        ? pred.locked
        : !!(pred.locked?.[roundKey]);
      if (!alreadyLocked && (pred[roundKey] || (roundKey === 'r32' && pred.ko))) {
        if (typeof pred.locked !== 'object' || pred.locked === null) pred.locked = {};
        pred.locked[roundKey] = true;
        locked++;
      }
    }
  }
  if (locked > 0) {
    write('predictions.json', predictions);
    console.log(`[once] Auto-locked ${locked} prediction(s)`);
  }

  const meta = readOr('meta.json', {});
  meta.lastUpdated = Date.now();
  meta.phase = koRounds.length > 0 ? 'ko' : 'group';
  meta.activeRound = activeRound;
  meta.koLockTimes = koLockTimes;
  // Keep legacy lockAtMs for backwards compat
  const r32LockMs = koLockTimes.r32;
  if (r32LockMs) meta.lockAtMs = r32LockMs;
  if (process.env.APPS_SCRIPT_URL) meta.appsScriptUrl = process.env.APPS_SCRIPT_URL;
  // Per-user reopen window (tracked in config/reopen.json so it survives Vercel rebuilds,
  // unlike data/meta.json which is gitignored/regenerated). Frontend enforces the deadline.
  try {
    const reopen = JSON.parse(readFileSync(new URL('../config/reopen.json', import.meta.url), 'utf8'));
    if (reopen?.r32) meta.r32Reopen = reopen.r32; else delete meta.r32Reopen;
  } catch { delete meta.r32Reopen; }
  write('meta.json', meta);

  const leaderboard = computeScores();
  console.log('\n--- Leaderboard ---');
  for (const row of leaderboard) {
    const delta = row.delta > 0 ? `+${row.delta}` : String(row.delta);
    console.log(`  ${row.rank}. ${row.name.padEnd(18)} ${String(row.total).padStart(3)} pts  (${delta})`);
  }

  generateFeed({ groupId: 'lr' });

  buildAppData();
}

run().catch(err => { console.error(err); process.exit(1); });
