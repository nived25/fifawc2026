import { readFileSync } from 'fs';
import { read, write, readOr } from './store.js';

const SCORING = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));

function ledgerKey(participantId, matchId, rule) {
  return `${participantId}|${matchId ?? 'null'}|${rule}`;
}

export function computeScores() {
  const fixtures = read('fixtures.json') || [];
  const participants = read('participants.json') || [];
  const predictions = readOr('predictions.json', {});
  const teamMap = read('team_map.json') || {};
  const prevLeaderboard = read('leaderboard.json') || [];
  const ledger = readOr('scoring_ledger.json', []);
  const seen = new Set(ledger.map(e => e.key));

  const prevTotals = {};
  for (const row of prevLeaderboard) prevTotals[row.name] = row.total;

  const finishedGroupMatches = fixtures.filter(f => f.finished && f.round?.startsWith('Group'));

  const scores = {};
  for (const p of participants) {
    scores[p.id] = { group: 0, finalist: 0, champion: 0, ko: 0 };
  }

  for (const p of participants) {
    for (const pickCode of p.picks) {
      if (!teamMap[pickCode]) continue;

      for (const match of finishedGroupMatches) {
        const isHome = match.home.code === pickCode;
        const isAway = match.away.code === pickCode;
        if (!isHome && !isAway) continue;

        const myGoals = isHome ? match.home.goals : match.away.goals;
        const theirGoals = isHome ? match.away.goals : match.home.goals;

        let pts = SCORING.group.loss;
        let reason = 'loss';
        if (myGoals > theirGoals) { pts = SCORING.group.win; reason = 'win'; }
        else if (myGoals === theirGoals) { pts = SCORING.group.draw; reason = 'draw'; }

        if (pts > 0) {
          const key = ledgerKey(p.id, match.id, `group_${reason}_${pickCode}`);
          if (!seen.has(key)) {
            seen.add(key);
            ledger.push({ key, participantId: p.id, points: pts, reason: `${pickCode} ${reason} (${myGoals}-${theirGoals})`, matchId: match.id, ts: Date.now() });
          }
          scores[p.id].group += pts;
        }
      }
    }
  }

  const koRounds = ['Round of 32', 'Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'];
  const koRoundKeys = ['R32', 'R16', 'QF', 'SF', 'FINAL'];
  const finishedKoMatches = fixtures.filter(f => f.finished && !f.round?.startsWith('Group'));

  for (const p of participants) {
    const pred = predictions[p.id];
    if (!pred || !pred.locked) continue;

    if (pred.finalists) {
      for (const fCode of pred.finalists) {
        const finalMatches = fixtures.filter(f => f.round === 'Final');
        const inFinal = finalMatches.some(f =>
          f.home.code === fCode || f.away.code === fCode
        );
        if (inFinal) {
          const key = ledgerKey(p.id, null, `finalist_${fCode}`);
          if (!seen.has(key)) {
            seen.add(key);
            ledger.push({ key, participantId: p.id, points: SCORING.prediction.correctFinalist, reason: `Correct finalist: ${fCode}`, matchId: null, ts: Date.now() });
          }
          scores[p.id].finalist += SCORING.prediction.correctFinalist;
        }
      }
    }

    if (pred.champion) {
      if (teamMap[pred.champion]) {
        const finalMatches = fixtures.filter(f => f.round === 'Final' && f.finished);
        for (const fm of finalMatches) {
          const winnerCode = fm.home.goals > fm.away.goals ? fm.home.code :
                             fm.away.goals > fm.home.goals ? fm.away.code : null;
          if (winnerCode === pred.champion) {
            const key = ledgerKey(p.id, null, `champion_${pred.champion}`);
            if (!seen.has(key)) {
              seen.add(key);
              ledger.push({ key, participantId: p.id, points: SCORING.prediction.correctChampion, reason: `Correct champion: ${pred.champion}`, matchId: null, ts: Date.now() });
            }
            scores[p.id].champion += SCORING.prediction.correctChampion;
          }
        }
      }
    }

    if (pred.ko) {
      const r32list = readOr('r32_tbd.json', []);

      for (const [idxStr, pick] of Object.entries(pred.ko)) {
        const idx = parseInt(idxStr);
        if (isNaN(idx) || !pick) continue;

        const r32match = r32list[idx];
        if (!r32match) continue;

        const homeCode = r32match.home?.code || r32match.home;
        const awayCode = r32match.away?.code || r32match.away;
        if (!homeCode || !awayCode) continue;

        const actualMatch = fixtures.find(f =>
          f.round === 'Round of 32' && f.finished &&
          f.home.code === homeCode && f.away.code === awayCode
        );
        if (!actualMatch) continue;

        const actualAdv = actualMatch.home.goals > actualMatch.away.goals ? 'a'
          : actualMatch.away.goals > actualMatch.home.goals ? 'b'
          : (actualMatch.penHome != null ? (actualMatch.penHome > actualMatch.penAway ? 'a' : 'b') : null);
        if (!actualAdv) continue;

        const predAdv = pick.adv || (pick.h > pick.a ? 'a' : (pick.a > pick.h ? 'b' : null));
        if (!predAdv || predAdv !== actualAdv) continue;

        const predWinCode = predAdv === 'a' ? homeCode : awayCode;
        const basePts = SCORING.knockout.R32 || 4;
        const scoreMatch = pick.h === actualMatch.home.goals && pick.a === actualMatch.away.goals;
        const pts = scoreMatch ? basePts * 2 : basePts;
        const reason = scoreMatch
          ? `${predWinCode} correct + exact score ${pick.h}-${pick.a} (2×R32)`
          : `${predWinCode} advances (R32)`;

        const key = ledgerKey(p.id, actualMatch.id, `r32_match_${idx}`);
        if (!seen.has(key)) {
          seen.add(key);
          ledger.push({ key, participantId: p.id, points: pts, reason, matchId: actualMatch.id, ts: Date.now() });
        }
        scores[p.id].ko += pts;
      }
    }
  }


  write('scoring_ledger.json', ledger);

  const leaderboard = participants.map(p => {
    const s = scores[p.id];
    const total = s.group + s.finalist + s.champion + s.ko;
    const prev = prevTotals[p.name] ?? 0;
    return {
      rank: 0,
      name: p.name,
      id: p.id,
      picks: p.picks,
      total,
      delta: total - prev,
      breakdown: s
    };
  });

  leaderboard.sort((a, b) => b.total - a.total);
  leaderboard.forEach((row, i) => { row.rank = i + 1; });

  write('leaderboard.json', leaderboard);
  return leaderboard;
}

export function getLockTime() {
  const fixtures = read('fixtures.json') || [];
  const r32Matches = fixtures.filter(f => f.round === 'Round of 32');
  if (r32Matches.length === 0) return null;
  const earliest = Math.min(...r32Matches.map(f => f.kickoffMs));
  return earliest - 5 * 60 * 1000;
}
