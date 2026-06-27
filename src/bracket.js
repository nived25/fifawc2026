import { read, write } from './store.js';

const KO_ROUNDS = ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'];

export function updateBracket() {
  const fixtures = read('fixtures.json') || [];
  const teams = read('teams.json') || {};

  const bracket = {};

  for (const roundName of KO_ROUNDS) {
    const roundMatches = fixtures
      .filter(f => f.round === roundName)
      .sort((a, b) => a.kickoffMs - b.kickoffMs);

    bracket[roundName] = roundMatches.map(m => ({
      id: m.id,
      kickoffMs: m.kickoffMs,
      status: m.status,
      finished: m.finished,
      home: {
        code: m.home.code,
        name: teams[m.home.code]?.name || m.home.code || 'TBD',
        goals: m.home.goals,
        logo: teams[m.home.code]?.logo || null
      },
      away: {
        code: m.away.code,
        name: teams[m.away.code]?.name || m.away.code || 'TBD',
        goals: m.away.goals,
        logo: teams[m.away.code]?.logo || null
      }
    }));
  }

  write('bracket.json', bracket);
  return bracket;
}
