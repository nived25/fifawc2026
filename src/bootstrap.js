import 'dotenv/config';
import { read, write } from './store.js';

const API_BASE = 'https://worldcup26.ir';

// Venue local UTC offsets during tournament (June-July 2026, summer DST)
// Mexico venues: CST = UTC-6 (no DST observed)
// US Central:    CDT = UTC-5
// US/CA Eastern: EDT = UTC-4
// US/CA Pacific: PDT = UTC-7
const STADIUM_UTC_OFFSET = {
  '1': -6, '2': -6, '3': -6,              // Mexico City, Guadalajara, Monterrey
  '4': -5, '5': -5, '6': -5,              // Dallas, Houston, Kansas City
  '7': -4, '8': -4, '9': -4,              // Atlanta, Miami, Boston
  '10': -4, '11': -4, '12': -4,           // Philadelphia, New York, Toronto
  '13': -7, '14': -7, '15': -7, '16': -7  // Vancouver, Seattle, San Francisco, Los Angeles
};

const ROUND_NAMES = {
  group: 'Group Stage',
  r32: 'Round of 32',
  r16: 'Round of 16',
  qf: 'Quarter-finals',
  sf: 'Semi-finals',
  third: '3rd Place',
  final: 'Final'
};

function localToUtcMs(localDate, stadiumId) {
  // localDate format: "MM/DD/YYYY HH:MM" in venue-local time
  const [datePart, timePart] = localDate.split(' ');
  const [month, day, year] = datePart.split('/');
  const [hour, min] = timePart.split(':');
  const offsetH = STADIUM_UTC_OFFSET[String(stadiumId)] ?? -5;
  // UTC = local - offsetH  (e.g. 12:00 PDT, offset=-7 → UTC = 12-(-7) = 19)
  return Date.UTC(+year, +month - 1, +day, +hour - offsetH, +min);
}

// Final / 3rd-place pairings: upstream keeps team ids "0" on those two games
// until it fills them, which would drop the fixtures entirely. Once both
// semi-finals are finished the pairings are fully determined — derive them.
// Returns { final:{home,away}, third:{home,away} } (codes) or {}.
function deriveLatePairings(gameList, codeOf) {
  const sfs = gameList
    .filter(g => g.type === 'sf' && g.finished === 'TRUE')
    .sort((a, b) => a.local_date.localeCompare(b.local_date));
  if (sfs.length !== 2) return {};
  const wl = sfs.map(g => {
    const h = parseInt(g.home_score), a = parseInt(g.away_score);
    const ph = parseInt(g.home_penalty_score || '0'), pa = parseInt(g.away_penalty_score || '0');
    const homeWins = h > a || (h === a && ph > pa);
    const home = codeOf(g.home_team_id), away = codeOf(g.away_team_id);
    return homeWins ? { w: home, l: away } : { w: away, l: home };
  });
  if (wl.some(x => !x.w || !x.l)) return {};
  return {
    final: { home: wl[0].w, away: wl[1].w },
    third: { home: wl[0].l, away: wl[1].l }
  };
}

function parseScorers(raw, teamCode) {
  if (!raw || raw === 'null') return [];
  // PostgreSQL array literal: {"Name Minute'","Name2 Minute'"}
  const inner = raw.replace(/^\{/, '').replace(/\}$/, '');
  if (!inner) return [];
  const entries = inner.match(/"[^"]*"/g) || [];
  return entries.map(e => {
    const s = e.replace(/^"|"$/g, '').trim();
    const m = s.match(/^(.+?)\s+(\d+(?:\+\d+)?)'?$/);
    return { name: m ? m[1].trim() : s, minute: m ? parseInt(m[2]) : null, team: teamCode };
  });
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

async function run() {
  console.log('=== FIFA Fantasy Bootstrap (worldcup26.ir) ===');

  // 1. Teams
  console.log('[bootstrap] Fetching teams...');
  const teamsRaw = await fetchJson('/get/teams');
  const teamList = Array.isArray(teamsRaw) ? teamsRaw : (teamsRaw.teams || []);

  const teamById = {};
  const teams = {};
  const teamMap = {};
  for (const t of teamList) {
    const code = t.fifa_code;
    teamById[t.id] = { code, name: t.name_en, flag: t.flag };
    teams[code] = { name: t.name_en, flag: t.flag, logo: t.flag };
    teamMap[code] = { name: t.name_en };
  }
  // team_id_map: { "apiId": "FIFA_CODE" } — used by once.js for incremental updates
  const teamIdMap = {};
  for (const t of teamList) teamIdMap[String(t.id)] = t.fifa_code;

  write('teams.json', teams);
  write('team_map.json', teamMap);
  write('team_id_map.json', teamIdMap);
  console.log(`[bootstrap] ${Object.keys(teams).length} teams saved`);

  // 2. Stadiums (city names for venue display)
  console.log('[bootstrap] Fetching stadiums...');
  const stadiumsRaw = await fetchJson('/get/stadiums');
  const stadiumList = Array.isArray(stadiumsRaw) ? stadiumsRaw : (stadiumsRaw.stadiums || []);
  const stadiumById = {};
  for (const s of stadiumList) {
    stadiumById[String(s.id)] = s.city_en || s.name_en;
  }
  write('stadium_id_map.json', stadiumById);

  // 3. Games
  console.log('[bootstrap] Fetching games...');
  const gamesRaw = await fetchJson('/get/games');
  const gameList = Array.isArray(gamesRaw) ? gamesRaw : (gamesRaw.games || []);
  console.log(`[bootstrap] ${gameList.length} games received`);

  gameList.sort((a, b) => a.local_date.localeCompare(b.local_date));

  const late = deriveLatePairings(gameList, id => teamById[id]?.code || null);

  const fixtures = [];
  const r32tbd = [];

  for (const g of gameList) {
    const round = ROUND_NAMES[g.type] || g.type;
    const kickoffMs = localToUtcMs(g.local_date, g.stadium_id);
    const isGroup = g.type === 'group';
    const homeResolved = g.home_team_id && g.home_team_id !== '0';
    const awayResolved = g.away_team_id && g.away_team_id !== '0';
    const finished = g.finished === 'TRUE';
    let homeCode = homeResolved ? (teamById[g.home_team_id]?.code || null) : null;
    let awayCode = awayResolved ? (teamById[g.away_team_id]?.code || null) : null;
    let homeName = homeResolved
      ? (teamById[g.home_team_id]?.name || g.home_team_name_en || homeCode)
      : (g.home_team_label || 'TBD');
    let awayName = awayResolved
      ? (teamById[g.away_team_id]?.name || g.away_team_name_en || awayCode)
      : (g.away_team_label || 'TBD');
    // fill Final/3rd-place from derived SF results while upstream ids are "0"
    if ((g.type === 'final' || g.type === 'third') && (!homeCode || !awayCode) && late[g.type]) {
      homeCode = homeCode || late[g.type].home;
      awayCode = awayCode || late[g.type].away;
      homeName = teams[homeCode]?.name || homeCode;
      awayName = teams[awayCode]?.name || awayCode;
    }
    const homeGoals = finished ? parseInt(g.home_score) : null;
    const awayGoals = finished ? parseInt(g.away_score) : null;
    const venue = stadiumById[g.stadium_id] || null;
    const group = isGroup ? `Group ${g.group}` : null;

    // Include in fixtures.json when both teams have codes (for scoring + bracket)
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

    // R32 display list — all 16 matches with real times + labels for unresolved
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

  r32tbd.sort((a, b) => a.kickoffMs - b.kickoffMs);
  fixtures.sort((a, b) => a.kickoffMs - b.kickoffMs);

  write('fixtures.json', fixtures);
  write('r32_tbd.json', r32tbd);
  console.log(`[bootstrap] ${fixtures.length} fixtures saved (${fixtures.filter(f => f.finished).length} finished)`);
  console.log(`[bootstrap] ${r32tbd.length} R32 entries saved`);

  // Sanity check participant picks
  const participants = read('participants.json') || [];
  const unresolved = [];
  for (const p of participants) {
    for (const pick of (p.picks || [])) {
      if (!teams[pick]) unresolved.push(`${p.name}: ${pick}`);
    }
  }
  if (unresolved.length) {
    console.warn('[bootstrap] Unresolved participant picks:', unresolved.join(', '));
  }

  console.log('[bootstrap] Done!');
}

run().catch(err => { console.error(err); process.exit(1); });
