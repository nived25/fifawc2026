import 'dotenv/config';
import cron from 'node-cron';
import { read, write, readOr } from './store.js';
import { apiGet, getUsageStats } from './apiClient.js';
import { computeScores, getLockTime } from './scoring.js';
import { computeStandings, reconcileStandings } from './standings.js';
import { updateBracket } from './bracket.js';
import { buildAppData } from './buildAppData.js';

const LIVE_POLL_MIN = parseInt(process.env.LIVE_POLL_MIN || '15', 10);
const WARMUP_POLL_MIN = parseInt(process.env.WARMUP_POLL_MIN || '30', 10);
const WINDOW_BUFFER_MIN = parseInt(process.env.WINDOW_BUFFER_MIN || '150', 10);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getActiveWindow() {
  const fixtures = read('fixtures.json') || [];
  const today = todayStr();
  const todayStart = new Date(today).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const todayMatches = fixtures.filter(f =>
    f.kickoffMs >= todayStart && f.kickoffMs < todayEnd
  );

  if (todayMatches.length === 0) return null;

  const earliest = Math.min(...todayMatches.map(f => f.kickoffMs));
  const latest = Math.max(...todayMatches.map(f => f.kickoffMs));

  return {
    warmupStart: earliest - 30 * 60 * 1000,
    start: earliest - 5 * 60 * 1000,
    end: latest + WINDOW_BUFFER_MIN * 60 * 1000,
    matches: todayMatches
  };
}

function hasLiveMatches(fixtures) {
  const liveStatuses = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT']);
  return fixtures.some(f => liveStatuses.has(f.status));
}

function allFinished(fixtures) {
  const todayStr_ = todayStr();
  const todayStart = new Date(todayStr_).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const todayMatches = fixtures.filter(f => f.kickoffMs >= todayStart && f.kickoffMs < todayEnd);
  return todayMatches.length > 0 && todayMatches.every(f => f.finished);
}

async function pollAndUpdate() {
  const today = todayStr();
  console.log(`[scheduler] Polling fixtures for ${today}...`);

  const result = await apiGet('/fixtures', { league: 1, season: 2026, date: today });
  if (!result.ok) {
    console.error('[scheduler] Poll failed:', result.error);
    return;
  }

  const existing = read('fixtures.json') || [];
  const teams = read('teams.json') || {};
  const teamsByApiId = {};
  for (const [code, team] of Object.entries(teams)) {
    teamsByApiId[team.apiId] = code;
  }

  const updated = new Map(existing.map(f => [f.id, f]));

  for (const entry of result.data) {
    const f = entry.fixture;
    const homeTeam = entry.teams.home;
    const awayTeam = entry.teams.away;
    const homeCode = teamsByApiId[homeTeam.id] || homeTeam.name.substring(0, 3).toUpperCase();
    const awayCode = teamsByApiId[awayTeam.id] || awayTeam.name.substring(0, 3).toUpperCase();
    const status = f.status?.short || 'NS';
    const finished = ['FT', 'AET', 'PEN'].includes(status);

    updated.set(f.id, {
      id: f.id,
      round: entry.league?.round || '',
      group: entry.league?.round?.startsWith('Group') ? entry.league.round : null,
      kickoffMs: new Date(f.date).getTime(),
      status,
      home: { code: homeCode, apiId: homeTeam.id, goals: entry.goals?.home ?? null },
      away: { code: awayCode, apiId: awayTeam.id, goals: entry.goals?.away ?? null },
      finished
    });
  }

  const fixtures = [...updated.values()].sort((a, b) => a.kickoffMs - b.kickoffMs);
  write('fixtures.json', fixtures);

  computeStandings();
  updateBracket();
  computeScores();

  const lockTime = getLockTime();
  const meta = readOr('meta.json', {});
  meta.lastUpdated = Date.now();
  meta.phase = fixtures.some(f => !f.round?.startsWith('Group')) ? 'ko' : 'group';
  if (lockTime) meta.lockAtMs = lockTime;
  write('meta.json', meta);

  buildAppData();
  console.log(`[scheduler] Update complete. ${result.data.length} fixtures refreshed.`);
}

let lastPollMs = 0;
let confirmationDone = false;
let reconcileDone = false;

async function tick() {
  const now = Date.now();
  const window = getActiveWindow();

  if (!window) return;

  const { warmupStart, start, end } = window;

  if (now < warmupStart || now > end) return;

  const fixtures = read('fixtures.json') || [];
  const live = hasLiveMatches(fixtures);
  const finished = allFinished(fixtures);

  let interval;
  if (live) {
    interval = LIVE_POLL_MIN * 60 * 1000;
  } else if (now < start) {
    interval = WARMUP_POLL_MIN * 60 * 1000;
  } else if (finished && !confirmationDone) {
    interval = 10 * 60 * 1000;
  } else if (finished) {
    if (!reconcileDone) {
      console.log('[scheduler] All matches FT. Running reconcile...');
      await reconcileStandings();
      reconcileDone = true;
      buildAppData();
    }
    return;
  } else {
    interval = LIVE_POLL_MIN * 60 * 1000;
  }

  if (now - lastPollMs < interval) return;

  lastPollMs = now;
  await pollAndUpdate();

  if (finished && !confirmationDone) {
    confirmationDone = true;
    console.log('[scheduler] Confirmation poll done. Will reconcile standings next.');
  }
}

function printStartup() {
  const stats = getUsageStats();
  const meta = readOr('meta.json', {});
  const window = getActiveWindow();

  console.log('\n=== FIFA Fantasy Scheduler ===');
  console.log(`Phase: ${meta.phase || 'group'}`);
  console.log(`Lock time: ${meta.lockAtMs ? new Date(meta.lockAtMs).toISOString() : 'TBD'}`);
  console.log(`API calls today: ${stats.used}/${stats.budget}`);

  if (window) {
    console.log(`Active window: ${new Date(window.start).toLocaleTimeString()} - ${new Date(window.end).toLocaleTimeString()}`);
    console.log(`Matches today: ${window.matches.length}`);
  } else {
    console.log('No matches today — scheduler will idle.');
  }
  console.log('');
}

printStartup();

cron.schedule('* * * * *', tick);

cron.schedule('0 * * * *', async () => {
  const result = await apiGet('/status');
  if (result.ok) {
    console.log('[scheduler] Health check OK');
  }
});

cron.schedule('0 4 * * 1', async () => {
  console.log('[scheduler] Weekly fixture refresh...');
  const result = await apiGet('/fixtures', { league: 1, season: 2026 });
  if (result.ok) {
    const teams = read('teams.json') || {};
    const teamsByApiId = {};
    for (const [code, team] of Object.entries(teams)) {
      teamsByApiId[team.apiId] = code;
    }

    const fixtures = result.data.map(entry => {
      const f = entry.fixture;
      const homeCode = teamsByApiId[entry.teams.home.id] || entry.teams.home.name.substring(0, 3).toUpperCase();
      const awayCode = teamsByApiId[entry.teams.away.id] || entry.teams.away.name.substring(0, 3).toUpperCase();
      const status = f.status?.short || 'NS';

      return {
        id: f.id,
        round: entry.league?.round || '',
        group: entry.league?.round?.startsWith('Group') ? entry.league.round : null,
        kickoffMs: new Date(f.date).getTime(),
        status,
        home: { code: homeCode, apiId: entry.teams.home.id, goals: entry.goals?.home ?? null },
        away: { code: awayCode, apiId: entry.teams.away.id, goals: entry.goals?.away ?? null },
        finished: ['FT', 'AET', 'PEN'].includes(status)
      };
    }).sort((a, b) => a.kickoffMs - b.kickoffMs);

    write('fixtures.json', fixtures);
    console.log(`[scheduler] Refreshed ${fixtures.length} fixtures`);
  }
});

const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
midnight.setDate(midnight.getDate() + 1);
setTimeout(() => {
  confirmationDone = false;
  reconcileDone = false;
}, midnight.getTime() - Date.now());
