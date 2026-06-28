import { readOr, write } from './store.js';

export function resolveR32Teams(standings) {
  const r32tbd = readOr('r32_tbd.json', []);
  if (!r32tbd.length) return r32tbd;

  // Build per-group lookup: letter → [1st, 2nd, 3rd]
  const groupByLetter = {};
  for (const [grpName, teams] of Object.entries(standings)) {
    const letter = grpName.replace('Group ', '').toUpperCase();
    groupByLetter[letter] = teams;
  }

  // Rank all 3rd-place teams globally to find the 8 qualifiers
  const allThird = Object.entries(groupByLetter)
    .map(([letter, teams]) => teams[2] ? { ...teams[2], group: letter } : null)
    .filter(Boolean);
  allThird.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.code.localeCompare(b.code));
  const qualifiers = allThird.slice(0, 8);
  const qualByGroup = Object.fromEntries(qualifiers.map(q => [q.group, q]));

  // Teams already placed by the API (resolved slots) — don't reassign them
  const alreadyPlaced = new Set();
  for (const m of r32tbd) {
    if (m.home.resolved && m.home.code) alreadyPlaced.add(m.home.code);
    if (m.away.resolved && m.away.code) alreadyPlaced.add(m.away.code);
  }
  const availQualByGroup = Object.fromEntries(
    Object.entries(qualByGroup).filter(([, q]) => !alreadyPlaced.has(q.code))
  );

  // Collect TBD 3rd-place slots: { matchIdx, side, groups }
  const thirdSlots = [];
  for (let i = 0; i < r32tbd.length; i++) {
    for (const side of ['home', 'away']) {
      const entry = r32tbd[i][side];
      if (!entry.resolved) {
        const m = entry.name?.match(/^3rd Group ([A-L/]+)$/i);
        if (m) {
          const groups = new Set(m[1].split('/').map(g => g.trim().toUpperCase()));
          thirdSlots.push({ matchIdx: i, side, groups });
        }
      }
    }
  }

  // Bipartite matching: most-constrained slot first
  function match(slots, available, assignment) {
    if (!slots.length) return true;
    const sorted = [...slots].sort((a, b) => {
      const aC = [...a.groups].filter(g => available[g]).length;
      const bC = [...b.groups].filter(g => available[g]).length;
      return aC - bC;
    });
    const slot = sorted[0];
    const rest = slots.filter(s => s !== slot);
    const candidates = [...slot.groups]
      .filter(g => available[g])
      .sort((a, b) => {
        const ta = available[a], tb = available[b];
        return tb.pts - ta.pts || tb.gd - ta.gd || tb.gf - ta.gf;
      });
    for (const g of candidates) {
      const team = available[g];
      assignment[`${slot.matchIdx}:${slot.side}`] = team;
      const next = { ...available };
      delete next[g];
      if (match(rest, next, assignment)) return true;
      delete assignment[`${slot.matchIdx}:${slot.side}`];
    }
    return false;
  }

  const thirdAssignment = {};
  match(thirdSlots, availQualByGroup, thirdAssignment);

  // Apply resolutions to r32tbd
  const updated = r32tbd.map((m, i) => {
    const entry = { ...m, home: { ...m.home }, away: { ...m.away } };
    for (const side of ['home', 'away']) {
      if (entry[side].resolved) continue;
      const label = entry[side].name || '';

      // Winner / Runner-up — skip if team is already placed in another resolved slot
      let wm = label.match(/^Winner Group ([A-L])$/i);
      if (wm) {
        const team = groupByLetter[wm[1].toUpperCase()]?.[0];
        if (team && !alreadyPlaced.has(team.code)) {
          entry[side] = { code: team.code, name: team.name, resolved: true };
          alreadyPlaced.add(team.code);
          continue;
        }
      }
      let rm = label.match(/^Runner-?up Group ([A-L])$/i);
      if (rm) {
        const team = groupByLetter[rm[1].toUpperCase()]?.[1];
        if (team && !alreadyPlaced.has(team.code)) {
          entry[side] = { code: team.code, name: team.name, resolved: true };
          alreadyPlaced.add(team.code);
          continue;
        }
      }

      // 3rd place — use matched assignment
      const key = `${i}:${side}`;
      if (thirdAssignment[key]) {
        const t = thirdAssignment[key];
        entry[side] = { code: t.code, name: t.name, resolved: true };
      }
    }
    return entry;
  });

  const before = r32tbd.filter(m => !m.home.resolved || !m.away.resolved).length;
  const after = updated.filter(m => !m.home.resolved || !m.away.resolved).length;
  if (before > after) {
    write('r32_tbd.json', updated);
    console.log(`[resolveR32] Resolved ${before - after} TBD match(es) (${after} still pending)`);
  }
  return updated;
}
