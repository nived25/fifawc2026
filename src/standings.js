import { read, write } from './store.js';
import { apiGet } from './apiClient.js';

export function computeStandings() {
  const fixtures = read('fixtures.json') || [];
  const teams = read('teams.json') || {};
  const groups = {};

  const groupMatches = fixtures.filter(f => f.round?.startsWith('Group') && f.finished);

  for (const match of groupMatches) {
    const grp = match.group;
    if (!grp) continue;

    if (!groups[grp]) groups[grp] = {};

    for (const side of ['home', 'away']) {
      const code = match[side].code;
      if (!groups[grp][code]) {
        groups[grp][code] = { code, name: teams[code]?.name || code, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
      }
    }

    const h = groups[grp][match.home.code];
    const a = groups[grp][match.away.code];
    const hg = match.home.goals;
    const ag = match.away.goals;

    h.played++; a.played++;
    h.gf += hg; h.ga += ag; a.gf += ag; a.ga += hg;
    h.gd = h.gf - h.ga; a.gd = a.gf - a.ga;

    if (hg > ag) { h.won++; h.pts += 3; a.lost++; }
    else if (hg < ag) { a.won++; a.pts += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.pts += 1; a.pts += 1; }
  }

  // Also add teams from unfinished group matches
  const allGroupMatches = fixtures.filter(f => f.round?.startsWith('Group'));
  for (const match of allGroupMatches) {
    const grp = match.group;
    if (!grp) continue;
    if (!groups[grp]) groups[grp] = {};
    for (const side of ['home', 'away']) {
      const code = match[side].code;
      if (!groups[grp][code]) {
        groups[grp][code] = { code, name: teams[code]?.name || code, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
      }
    }
  }

  const standings = {};
  for (const [grp, table] of Object.entries(groups)) {
    standings[grp] = Object.values(table).sort((a, b) =>
      b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name)
    );
  }

  write('standings.json', standings);
  return standings;
}

export async function reconcileStandings() {
  const result = await apiGet('/standings', { league: 1, season: 2026 });
  if (!result.ok) {
    console.warn('[standings] Reconcile fetch failed:', result.error);
    return;
  }

  const local = read('standings.json') || {};
  const remote = result.data;

  if (!remote || remote.length === 0) return;

  let diffs = 0;
  for (const league of remote) {
    if (!league.league || !league.league.standings) continue;
    for (const group of league.league.standings) {
      for (const team of group) {
        const grpName = team.group;
        const localGrp = local[grpName];
        if (!localGrp) continue;
        const localTeam = localGrp.find(t => t.name === team.team?.name);
        if (localTeam && localTeam.pts !== team.points) {
          diffs++;
          console.warn(`[standings] Mismatch: ${team.team.name} in ${grpName} — local ${localTeam.pts}pts vs API ${team.points}pts`);
        }
      }
    }
  }

  if (diffs > 0) console.warn(`[standings] ${diffs} mismatches found — check scoring`);
  else console.log('[standings] Reconcile OK — no mismatches');
}
