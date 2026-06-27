import { readFileSync } from 'fs';
import { read, write, readOr } from './store.js';

const SCORING = JSON.parse(readFileSync(new URL('../config/scoring.json', import.meta.url), 'utf8'));

const KO_ROUND_CONFIG = [
  { key: 'r32', name: 'Round of 32',   configKey: 'R32'   },
  { key: 'r16', name: 'Round of 16',   configKey: 'R16'   },
  { key: 'qf',  name: 'Quarter-finals', configKey: 'QF'   },
  { key: 'sf',  name: 'Semi-finals',   configKey: 'SF'    },
  { key: 'final', name: 'Final',       configKey: 'FINAL' }
];

function ledgerKey(participantId, matchId, rule) {
  return `${participantId}|${matchId ?? 'null'}|${rule}`;
}

function isRoundLocked(pred, roundKey) {
  if (!pred) return false;
  // Old format: pred.locked === true means r32 locked
  if (typeof pred.locked === 'boolean') return pred.locked;
  return !!(pred.locked?.[roundKey]);
}

function scoreKoRound({ roundKey, roundName, configKey, picks, matchList, fixtures, participantId, scores, ledger, seen }) {
  if (!picks) return;
  const basePts = SCORING.knockout[configKey] || 4;

  for (const [idxStr, pick] of Object.entries(picks)) {
    const idx = parseInt(idxStr);
    if (isNaN(idx) || !pick) continue;

    const matchDef = matchList[idx];
    if (!matchDef) continue;

    const homeCode = matchDef.home?.code || matchDef.home;
    const awayCode = matchDef.away?.code || matchDef.away;
    if (!homeCode || !awayCode) continue;

    const actualMatch = fixtures.find(f =>
      f.round === roundName && f.finished &&
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
    const scoreMatch = pick.h === actualMatch.home.goals && pick.a === actualMatch.away.goals;
    const pts = scoreMatch ? basePts * 2 : basePts;
    const reason = scoreMatch
      ? `${predWinCode} correct + exact score ${pick.h}-${pick.a} (2×${configKey})`
      : `${predWinCode} advances (${configKey})`;

    const key = ledgerKey(participantId, actualMatch.id, `${configKey.toLowerCase()}_match_${idx}`);
    if (!seen.has(key)) {
      seen.add(key);
      ledger.push({ key, participantId, points: pts, reason, matchId: actualMatch.id, ts: Date.now() });
    }
    scores[participantId].ko += pts;
  }
}

export function computeScores() {
  const fixtures = read('fixtures.json') || [];
  const participants = read('participants.json') || [];
  const predictions = readOr('predictions.json', {});
  const teamMap = read('team_map.json') || {};
  const prevLeaderboard = read('leaderboard.json') || [];
  const ledger = readOr('scoring_ledger.json', []);
  const seen = new Set(ledger.map(e => e.key));
  const bracket = readOr('bracket.json', {});
  const r32list = readOr('r32_tbd.json', []);

  const prevTotals = {};
  for (const row of prevLeaderboard) prevTotals[row.name] = row.total;

  const finishedGroupMatches = fixtures.filter(f => f.finished && f.round?.startsWith('Group'));

  const scores = {};
  for (const p of participants) {
    scores[p.id] = { group: 0, finalist: 0, champion: 0, ko: 0 };
  }

  // Group stage scoring
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

  // KO scoring for all rounds
  for (const p of participants) {
    const pred = predictions[p.id];
    if (!pred) continue;

    // Finalist bonus
    if (pred.finalists && (isRoundLocked(pred, 'r32') || pred.locked)) {
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

    // Champion bonus
    if (pred.champion && teamMap[pred.champion] && (isRoundLocked(pred, 'r32') || pred.locked)) {
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

    // Per-round KO scoring
    for (const { key, name, configKey } of KO_ROUND_CONFIG) {
      // Support old format (pred.ko = R32 picks) and new format (pred.r32)
      const picks = pred[key] || (key === 'r32' ? pred.ko : null);
      if (!picks) continue;
      if (!isRoundLocked(pred, key)) continue;

      const matchList = key === 'r32' ? r32list : (bracket[name] || []);

      scoreKoRound({
        roundKey: key, roundName: name, configKey,
        picks, matchList, fixtures,
        participantId: p.id, scores, ledger, seen
      });
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

export function getKoLockTimes() {
  const fixtures = read('fixtures.json') || [];
  const lockTimes = {};
  for (const { key, name } of KO_ROUND_CONFIG) {
    const matches = fixtures.filter(f => f.round === name);
    if (matches.length === 0) continue;
    lockTimes[key] = Math.min(...matches.map(f => f.kickoffMs)) - 5 * 60 * 1000;
  }
  return lockTimes;
}

export function getLockTime() {
  const times = getKoLockTimes();
  return times.r32 || null;
}

export function determineActiveRound(fixtures) {
  const KO_ORDER = KO_ROUND_CONFIG.map(c => [c.key, c.name]);
  for (const [key, name] of KO_ORDER) {
    const matches = fixtures.filter(f => f.round === name);
    if (matches.length === 0) continue;
    if (!matches.every(f => f.finished)) return key;
  }
  return 'r32'; // default: before KO starts
}
