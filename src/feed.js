import { readOr, write } from './store.js';

// ============================================================================
// The Gaffer — daily feed generator.
// Runs inside the refresh pipeline (per group via DATA_DIR scoping). Generates
// one batch of posts per IST day, at the first run at/after 12:00 IST. All
// randomness is seeded by (dateKey|groupId) so every member of a group sees
// the identical feed and re-runs are reproducible.
//
// Day-over-day state (yesterday's leaderboard snapshot + the ledger key set at
// generation time) lives INSIDE data/feed.json — the only feed file committed
// by CI — never in ledger timestamps, which don't survive fresh checkouts.
// ============================================================================

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOne = (rng, arr) => arr[Math.floor(rng() * arr.length)];

const IST_OFFSET = 5.5 * 3600 * 1000;
export const istDateKey = ms => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
export const istHour = ms => {
  const d = new Date(ms + IST_OFFSET);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};

// Members the Gaffer never mentions, per group (inactive members etc.) —
// they're dropped from the feed's whole view: no stars, no roasts, and
// aggregate counts ("X of N") exclude them too.
const FEED_EXCLUDE = { lr: ['anurag_saxena'] };

// Fixture id → KO round label (id ranges are the tournament's fixed numbering)
function koRound(id) {
  if (id >= 73 && id <= 88) return 'Round of 32';
  if (id >= 89 && id <= 96) return 'Round of 16';
  if (id >= 97 && id <= 100) return 'Quarter-final';
  if (id >= 101 && id <= 102) return 'Semi-final';
  if (id === 103) return '3rd Place playoff';
  if (id === 104) return 'the Final';
  return null;
}

// Predicted winner side for a {h,a,adv} pick: decisive scoreline wins, adv only breaks draws
function pickWinner(p) {
  if (!p) return null;
  if (p.h > p.a) return 'home';
  if (p.a > p.h) return 'away';
  return p.adv === 'a' ? 'home' : p.adv === 'b' ? 'away' : null;
}
function actualWinner(f) {
  if (!f.finished) return null;
  const hG = f.home.goals ?? f.homeGoals, aG = f.away.goals ?? f.awayGoals;
  if (hG > aG) return 'home';
  if (aG > hG) return 'away';
  if (f.penHome != null && f.penAway != null) return f.penHome > f.penAway ? 'home' : 'away';
  return null;
}

// First names, deduped with a last-initial when two members collide
function firstNames(participants) {
  const firsts = {};
  const count = {};
  for (const p of participants) {
    const f = (p.name || p.id).trim().split(/\s+/)[0];
    count[f] = (count[f] || 0) + 1;
  }
  for (const p of participants) {
    const parts = (p.name || p.id).trim().split(/\s+/);
    const f = parts[0];
    firsts[p.id] = count[f] > 1 && parts[1] ? `${f} ${parts[1][0]}.` : f;
  }
  return firsts;
}

// ---------------------------------------------------------------------------
// Post generators. Each receives ctx and returns {kind, text, card?} or null.
// Template variants use {slot} interpolation; fill() maps slots and **bolds**
// come baked into the variants.
// ---------------------------------------------------------------------------
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

function genIntro(ctx) {
  if (ctx.prevSnapshot) return null;
  const v = [
    "🎙️ The Gaffer has entered the chat. I watch every match, I read every pick, and I have OPINIONS. New edition every day at noon. Nobody is safe.",
    "🎙️ Right then. From today I'll be filing a daily report on this league — the heroes, the frauds, the lucky ones. First names will be used. You've been warned.",
    "🎙️ New signing announcement: me. The Gaffer. Daily takes on your picks, your points, and your questionable life choices, fresh every noon."
  ];
  return { kind: 'intro', text: pickOne(ctx.rng, v) };
}

function genWrap(ctx) {
  if (!ctx.windowEntries) return null;
  const n = ctx.finishedInWindow.length;
  const pts = ctx.windowEntries.reduce((s, e) => s + e.points, 0);
  if (!n) return null;
  const v = [
    "Right, team talk. **{n} {matchWord}**, **{pts} points** sprayed across the office since yesterday. Some of you dined. Some of you brought a fork to a snooker match.",
    "Damage report: **{n} {matchWord}** done, **{pts} points** on the board. The Gaffer watched every minute so you lot could pretend you did too.",
    "Morning. **{pts} points** got handed out over **{n} {matchWord}** and the gap between the sharks and the tourists is getting embarrassing.",
    "Another day, **{n} {matchWord}**, **{pts} points** in circulation. Somewhere out there a spreadsheet is crying."
  ];
  return { kind: 'wrap', text: fill(pickOne(ctx.rng, v), { n, pts, matchWord: n === 1 ? 'match' : 'matches' }) };
}

function genRestDay(ctx) {
  if (!ctx.windowEntries || ctx.finishedInWindow.length > 0) return null;
  const v = [
    "No matches, no points, no drama since yesterday. A rest day. Use it to apologise to whoever you trash-talked last week.",
    "Quiet day at the office — zero matches settled. The table is frozen, the excuses are thawing.",
    "Nothing to report. The Gaffer spent the day rewatching your worst predictions. Great stuff."
  ];
  return { kind: 'restday', text: pickOne(ctx.rng, v) };
}

function genMovement(ctx) {
  if (!ctx.prevSnapshot) return [];
  const prevRank = Object.fromEntries(ctx.prevSnapshot.map(r => [r.id, r.rank]));
  let climber = null, faller = null;
  for (const r of ctx.lb) {
    const was = prevRank[r.id];
    if (was == null) continue;
    const move = was - r.rank; // + = climbed
    if (move > 0 && (!climber || move > climber.move)) climber = { r, move, was };
    if (move < 0 && (!faller || move < faller.move)) faller = { r, move, was };
  }
  const posts = [];
  if (climber) {
    const v = [
      "Sound the sirens — **{first}** just climbed **{d} {spotWord}** to **#{to}**. Somebody's been doing homework instead of vibes.",
      "**{first}** went **#{from} → #{to}** overnight. That's not luck, that's a heist in broad daylight.",
      "Ladder update: **{first}** up **{d}**. The rest of you are the ladder.",
      "**{first}** is climbing like the office AC bill in May — **#{from} → #{to}**. Respect."
    ];
    posts.push({
      kind: 'climber',
      text: fill(pickOne(ctx.rng, v), { first: ctx.first[climber.r.id], d: climber.move, from: climber.was, to: climber.r.rank, spotWord: climber.move === 1 ? 'spot' : 'spots' }),
      card: { type: 'movement', name: climber.r.name, first: ctx.first[climber.r.id], delta: climber.move, fromRank: climber.was, toRank: climber.r.rank }
    });
  }
  if (faller) {
    const d = -faller.move;
    const v = [
      "Thoughts and prayers: **{first}** slid **{d} {spotWord}** to **#{to}**. The table giveth, the table absolutely taketh.",
      "**{first}** dropped to **#{to}**. Blink twice if your bracket needs rescuing, mate.",
      "Gravity check: **{first}**, **#{from} → #{to}**. Even the office plant saw that scoreline coming.",
      "**{first}** falling **{d} {spotWord}** — smooth, controlled, absolutely avoidable."
    ];
    posts.push({
      kind: 'faller',
      text: fill(pickOne(ctx.rng, v), { first: ctx.first[faller.r.id], d, from: faller.was, to: faller.r.rank, spotWord: d === 1 ? 'spot' : 'spots' }),
      card: { type: 'movement', name: faller.r.name, first: ctx.first[faller.r.id], delta: faller.move, fromRank: faller.was, toRank: faller.r.rank }
    });
  }
  return posts;
}

function genHaul(ctx) {
  if (!ctx.windowEntries || !ctx.windowEntries.length) return null;
  const gain = {};
  for (const e of ctx.windowEntries) gain[e.participantId] = (gain[e.participantId] || 0) + e.points;
  const [pid, pts] = Object.entries(gain).sort((a, b) => b[1] - a[1])[0] || [];
  if (!pid || pts <= 0) return null;
  const who = ctx.byId[pid];
  if (!who) return null;
  const v = [
    "Overnight cash-out: **{first}** banked **+{pts}**, top earner in the building. Everyone say thank you and also watch your back.",
    "**+{pts}** for **{first}** while you were asleep. Some people predict football; this one apparently writes the script.",
    "Biggest bag of the day: **{first}**, **+{pts}**. The Gaffer respects it. The Gaffer is also suspicious.",
    "**{first}** just vacuumed up **+{pts}**. Leave some points for the rest of the class, yeah?"
  ];
  return {
    kind: 'haul',
    text: fill(pickOne(ctx.rng, v), { first: ctx.first[pid], pts }),
    card: { type: 'statline', value: '+' + pts, label: 'pts since yesterday', name: who.name }
  };
}

function genSniper(ctx) {
  if (!ctx.windowEntries) return null;
  const exacts = ctx.windowEntries.filter(e => /exact score/i.test(e.reason || ''));
  if (!exacts.length) return null;
  const byPid = {};
  for (const e of exacts) (byPid[e.participantId] = byPid[e.participantId] || []).push(e);
  const [pid, list] = Object.entries(byPid).sort((a, b) => b[1].length - a[1].length)[0];
  const m = (list[0].reason || '').match(/exact score (\d+-\d+)/i);
  const score = m ? m[1] : 'the exact score';
  const vars = { first: ctx.first[pid], score, n: list.length };
  const v = list.length > 1 ? [
    "**{first}** hit **{n} exact scores** in one day. Someone check their browser history for a time machine.",
    "**{n} exact scores** for **{first}**. That's not analysis, that's espionage."
  ] : [
    "EXACT. SCORE. **{first}** called **{score}** on the nose. Put the laptop down, you're scaring the others.",
    "**{first}** sniped **{score}** — bang on. That's dartboard-blindfolded stuff, that is.",
    "One of you saw **{score}** coming before the players did. Take a bow, **{first}**, and maybe a drug test."
  ];
  return { kind: 'sniper', text: fill(pickOne(ctx.rng, v), vars) };
}

function genBlanked(ctx) {
  if (!ctx.windowEntries || !ctx.windowEntries.length || !ctx.finishedInWindow.length) return null;
  const scored = new Set(ctx.windowEntries.map(e => e.participantId));
  // Only roast members who actually had skin in the game: a pick on a finished window match
  const blanked = ctx.lb.filter(r => {
    if (scored.has(r.id)) return false;
    const pr = ctx.predictions[r.id];
    if (!pr) return false;
    return ctx.finishedInWindow.some(f => {
      const rk = { 'Round of 32': 'r32', 'Round of 16': 'r16', 'Quarter-final': 'qf', 'Semi-final': 'sf', '3rd Place playoff': 'third', 'the Final': 'final' }[koRound(f.id)];
      if (!rk) return false;
      if (rk === 'r32') {
        const idx = ctx.r32tbd.findIndex(t => t.apiId === f.id);
        return idx >= 0 && pr.r32 && pr.r32[idx];
      }
      return pr[rk] && pr[rk][f.id];
    });
  });
  if (!blanked.length) return null;
  if (ctx.lb.length <= 8 && blanked.length < 2) return null; // small group: never single anyone out
  const names = blanked.slice(0, 2).map(r => '**' + ctx.first[r.id] + '**');
  const joined = names.join(' and ');
  const extra = blanked.length > 2 ? ` (plus ${blanked.length - 2} more, you know who you are)` : '';
  const v = [
    `Meanwhile ${joined} posted a combined **0** since yesterday${extra}. Participation is also a strategy, technically.`,
    `${joined} came away with **nothing** from yesterday's matches${extra}. The Gaffer isn't angry, just disappointed.`,
    `Quiet day for ${joined} — **0 points**${extra}. The good news: it can't get worse. Probably.`
  ];
  return { kind: 'blanked', text: pickOne(ctx.rng, v) };
}

function genGap(ctx) {
  if (ctx.lb.length < 2) return null;
  const [a, b] = ctx.lb;
  const gap = a.total - b.total;
  const vars = { first: ctx.first[a.id], second: ctx.first[b.id], gap, ptsWord: gap === 1 ? 'point' : 'points' };
  const v = gap === 0 ? [
    "DEAD. HEAT. **{first}** and **{second}** are level on points at the top. Somebody's going to blink and the Gaffer will be watching when they do.",
    "**{first}** and **{second}** tied at the summit. This is the content I signed up for."
  ] : gap <= 5 ? [
    "**{first}** leads **{second}** by a nervous little **{gap}**. That's not a lead, that's a rumour of a lead.",
    "Top of the table: **{first}**, clinging on by **{gap}**. **{second}** can smell it from here.",
    "**{gap} {ptsWord}** between **{first}** and **{second}**. One good night flips this league on its head."
  ] : [
    "**{first}** sits **{gap} clear** at the top. Comfortable. Smug, even. The chasing pack has some thinking to do.",
    "The gap is **{gap}**. **{first}** is playing chess, most of you are playing musical chairs.",
    "**{first}** leading by **{gap}**. At this point the trophy engraver is just waiting for confirmation."
  ];
  return { kind: 'gap', text: fill(pickOne(ctx.rng, v), vars) };
}

function genUpset(ctx) {
  if (!ctx.windowEntries) return null;
  for (const f of ctx.finishedInWindow) {
    const round = koRound(f.id);
    if (!round) continue;
    const win = actualWinner(f);
    if (!win) continue;
    // collect each member's predicted side for this match
    const backers = { home: [], away: [] };
    for (const r of ctx.lb) {
      const pr = ctx.predictions[r.id];
      if (!pr) continue;
      let p = null;
      if (round === 'Round of 32') {
        const idx = ctx.r32tbd.findIndex(t => t.apiId === f.id);
        p = idx >= 0 && pr.r32 ? pr.r32[idx] : null;
      } else {
        const rk = { 'Round of 16': 'r16', 'Quarter-final': 'qf', 'Semi-final': 'sf', '3rd Place playoff': 'third', 'the Final': 'final' }[round];
        p = rk && pr[rk] ? pr[rk][f.id] : null;
      }
      const side = pickWinner(p);
      if (side) backers[side].push(r.id);
    }
    const total = backers.home.length + backers.away.length;
    if (total < 3) continue;
    const lost = win === 'home' ? 'away' : 'home';
    const wrong = backers[lost].length, right = backers[win].length;
    if (wrong / total < 0.7) continue;
    const winName = win === 'home' ? (f.home.name || f.home.code) : (f.away.name || f.away.code);
    const loseName = lost === 'home' ? (f.home.name || f.home.code) : (f.away.name || f.away.code);
    const vars = { wrong, total, winTeam: winName, loseTeam: loseName, first: right ? ctx.first[backers[win][0]] : null };
    const v = right ? [
      "**{wrong} of {total}** backed **{loseTeam}**. **{first}** said no. **{first}** was right. The rest of you owe the group chat an apology.",
      "The crowd went **{loseTeam}**, the football went **{winTeam}**, and **{first}** is the only one allowed to talk today.",
      "**{winTeam}** just made **{wrong}** brackets cry. **{first}** alone stays dry. Iconic behaviour."
    ] : [
      "ALL **{total}** of you backed **{loseTeam}**. **{winTeam}** did not care. A collective faceplant — beautiful, in its own way.",
      "Unanimous verdict: **{loseTeam}**. Actual result: **{winTeam}**. The Gaffer has never been prouder to know none of you."
    ];
    return { kind: 'upset', text: fill(pickOne(ctx.rng, v), vars) };
  }
  return null;
}

function genBoot(ctx) {
  const map = {};
  for (const f of ctx.fixtures) {
    if (!f.finished || !f.scorers) continue;
    for (const s of f.scorers) {
      const last = s.name.split(' ').pop();
      const key = last + '|' + s.team;
      if (!map[key]) map[key] = { name: s.name, team: s.team, goals: 0 };
      else if (s.name.length > map[key].name.length) map[key].name = s.name;
      map[key].goals++;
    }
  }
  const top = Object.values(map).sort((a, b) => b.goals - a.goals).slice(0, 3);
  if (!top.length) return null;
  const vars = { player: top[0].name, goals: top[0].goals, team: top[0].team };
  const v = [
    "Golden Boot check: **{player}** on **{goals}**. If he keeps this up, buy him something nice.",
    "**{player}** leads the Boot with **{goals}**. The man is a cheat code with shin pads.",
    "Boot watch: **{player}** ({team}), **{goals} goals**. Casual."
  ];
  return { kind: 'boot', text: fill(pickOne(ctx.rng, v), vars), card: { type: 'boot', items: top } };
}

function genFixtures(ctx) {
  const upcoming = ctx.fixtures
    .filter(f => !f.finished && f.kickoffMs > ctx.now && f.kickoffMs < ctx.now + 26 * 3600 * 1000)
    .sort((a, b) => a.kickoffMs - b.kickoffMs)
    .slice(0, 4);
  if (!upcoming.length) return null;
  const lockMins = Number(ctx.meta.matchLockMins || 30);
  const vars = { n: upcoming.length, lockMins, matchWord: upcoming.length === 1 ? 'match' : 'matches' };
  const v = [
    "Coming up: **{n} {matchWord}** in the next 24 hours. Predictions lock **{lockMins} minutes** before kickoff — don't come crying to me after.",
    "**{n} {matchWord}** on the slate. Get your picks in before the **{lockMins}-minute** lock or enjoy explaining yourself tomorrow.",
    "Tonight's menu: **{n} {matchWord}**. The lock waits for no one — **{lockMins} minutes** before kickoff, sharp."
  ];
  return {
    kind: 'fixtures',
    text: fill(pickOne(ctx.rng, v), vars),
    card: { type: 'fixtures', items: upcoming.map(f => ({ home: f.home.code, away: f.away.code, round: koRound(f.id) || f.round || '', kickoffMs: f.kickoffMs })) }
  };
}

function genFunFact(ctx) {
  const facts = [];
  // (a) efficiency king: total pts per ledger entry (min 5 entries)
  const cnt = {};
  for (const e of ctx.ledger) cnt[e.participantId] = (cnt[e.participantId] || 0) + 1;
  const eff = ctx.lb.filter(r => (cnt[r.id] || 0) >= 5)
    .map(r => ({ r, v: r.total / cnt[r.id] }))
    .sort((a, b) => b.v - a.v)[0];
  if (eff) facts.push({
    text: fill(pickOne(ctx.rng, [
      "Stat of the day: **{first}** averages **{v} points** every time they score at all — the most ruthless conversion rate in the league.",
      "Efficiency king: **{first}**, **{v} pts** per scoring event. Minimum effort, maximum damage. The dream."
    ]), { first: ctx.first[eff.r.id], v: eff.v.toFixed(1) })
  });
  // (b) most common predicted KO scoreline
  const scoreCnt = {};
  for (const pid of Object.keys(ctx.predictions)) {
    const pr = ctx.predictions[pid];
    for (const rk of ['r16', 'qf', 'sf', 'final']) {
      for (const p of Object.values(pr?.[rk] || {})) scoreCnt[p.h + '-' + p.a] = (scoreCnt[p.h + '-' + p.a] || 0) + 1;
    }
  }
  const fav = Object.entries(scoreCnt).sort((a, b) => b[1] - a[1])[0];
  if (fav && fav[1] >= 5) facts.push({
    text: fill(pickOne(ctx.rng, [
      "This league has predicted **{score}** a combined **{n} times**. Imagination is dead and you lot killed it.",
      "Group obsession alert: **{score}**, picked **{n} times**. Somebody try a different number, I'm begging."
    ]), { score: fav[0], n: fav[1] })
  });
  // (c) most-picked fantasy team
  const teamCnt = {};
  for (const r of ctx.lb) for (const t of r.picks || []) teamCnt[t] = (teamCnt[t] || 0) + 1;
  const top = Object.entries(teamCnt).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3) facts.push({
    text: fill(pickOne(ctx.rng, [
      "**{n} of {total}** of you have **{team}** in your fantasy squad. Original thinkers, every one of you.",
      "**{team}** appears in **{n}** squads out of **{total}**. When they lose, this office goes silent. The Gaffer lives for it."
    ]), { team: top[0], n: top[1], total: ctx.lb.length })
  });
  if (!facts.length) return null;
  return { kind: 'funfact', text: facts[Math.floor(ctx.rng() * facts.length)].text };
}

// --- history / psychology generators ---------------------------------------

// All KO scoreline picks a member has made, across every round
function allKoPicks(pr) {
  const out = [];
  for (const rk of ['r32', 'r16', 'qf', 'sf', 'third', 'final']) {
    for (const p of Object.values(pr?.[rk] || {})) if (p && p.h != null) out.push(p);
  }
  return out;
}

// Adjacent-rank rivalry anywhere below the top two — mid-table gets airtime
function genRivalry(ctx) {
  if (ctx.lb.length < 5) return null;
  let best = null;
  for (let i = 1; i < ctx.lb.length - 1; i++) {
    const d = ctx.lb[i].total - ctx.lb[i + 1].total;
    if (best == null || d < best.d) best = { d, i };
  }
  if (!best || best.d > 3) return null;
  const a = ctx.lb[best.i], b = ctx.lb[best.i + 1];
  const vars = { a: ctx.first[a.id], b: ctx.first[b.id], ra: a.rank, rb: b.rank, d: best.d, ptsWord: best.d === 1 ? 'point' : 'points' };
  const v = best.d === 0 ? [
    "Mid-table derby alert: **{a}** and **{b}** are LEVEL at **#{ra}/#{rb}**. Two desks, one destiny, zero chill.",
    "**{a}** and **{b}** tied in the middle of the table. The Gaffer suggests settling it over chai. Or arm wrestling."
  ] : [
    "Forget the title race — the real blood feud is **{a}** vs **{b}**, **{d} {ptsWord}** apart at **#{ra}/#{rb}**. Winner gets bragging rights, loser gets the printer duty.",
    "**{a}** holds **#{ra}** by just **{d}** over **{b}**. That's one exact score from a power shift nobody upstairs is watching.",
    "Quietly, at **#{ra} and #{rb}**, **{a}** and **{b}** are having the pettiest title race of all. The Gaffer sees you both."
  ];
  return { kind: 'rivalry', text: fill(pickOne(ctx.rng, v), vars) };
}

// Wooden-spoon watch — the bottom deserves content too
function genBottomWatch(ctx) {
  if (ctx.lb.length < 6) return null;
  const last = ctx.lb[ctx.lb.length - 1], above = ctx.lb[ctx.lb.length - 2];
  const d = above.total - last.total;
  const vars = { last: ctx.first[last.id], above: ctx.first[above.id], d, rank: last.rank };
  const v = d >= 25 ? [
    "Wooden spoon watch: **{last}** trails even **{above}** by **{d}**. At this point it's not a slump, it's a residency.",
    "**{last}** has turned last place into a personal brand — **{d} points** behind the next human. Commitment, of a kind."
  ] : [
    "Basement battle: **{last}** is only **{d}** behind **{above}**. One good night and the spoon changes hands. The Gaffer has popcorn.",
    "Down at **#{rank}**, **{last}** can smell escape — just **{d}** to catch **{above}**. The most honest football in this league is played down here."
  ];
  return { kind: 'bottomwatch', text: fill(pickOne(ctx.rng, v), vars) };
}

// Overnight overtake: X walked past Y on the stairs
function genSwap(ctx) {
  if (!ctx.prevSnapshot) return null;
  const prevRank = Object.fromEntries(ctx.prevSnapshot.map(r => [r.id, r.rank]));
  for (let i = 0; i < ctx.lb.length - 1; i++) {
    const x = ctx.lb[i], y = ctx.lb[i + 1];
    if (prevRank[x.id] != null && prevRank[y.id] != null && prevRank[x.id] > prevRank[y.id]) {
      const vars = { x: ctx.first[x.id], y: ctx.first[y.id], rx: x.rank };
      const v = [
        "**{x}** just walked past **{y}** on the stairs and didn't even say hi. **#{rx}** now. Cold.",
        "Overnight overtake: **{x}** slides ahead of **{y}** into **#{rx}**. The Gaffer recommends **{y}** avoids the kitchen till lunch.",
        "**{y}** woke up to find **{x}** sitting in their chair at **#{rx}**. Office politics, table edition."
      ];
      return { kind: 'swap', text: fill(pickOne(ctx.rng, v), vars) };
    }
  }
  return null;
}

// Weekly trajectory from the feed's own snapshots — psychology by trendline
function genTrend(ctx) {
  if (!ctx.history || ctx.history.length < 3) return null;
  // series per member: chronological ranks [oldest … today]
  const series = {};
  const snaps = [...ctx.history].reverse().concat([ctx.lb.map(r => ({ id: r.id, rank: r.rank }))]);
  for (const snap of snaps) for (const r of snap) (series[r.id] = series[r.id] || []).push(r.rank);
  const days = snaps.length;
  let ascent = null, slide = null, cement = null, yoyo = null;
  for (const [pid, s] of Object.entries(series)) {
    if (s.length < Math.min(4, days)) continue;
    const net = s[0] - s[s.length - 1]; // + = climbed
    const monoUp = s.every((v, i) => i === 0 || v <= s[i - 1]);
    const monoDown = s.every((v, i) => i === 0 || v >= s[i - 1]);
    const distinct = new Set(s).size;
    if (monoUp && net >= 3 && (!ascent || net > ascent.net)) ascent = { pid, net, s };
    if (monoDown && -net >= 3 && (!slide || -net > -slide.net)) slide = { pid, net, s };
    if (distinct === 1 && s.length >= 5 && !cement) cement = { pid, rank: s[0], n: s.length };
    if (distinct >= 4 && (!yoyo || distinct > yoyo.distinct)) yoyo = { pid, distinct };
  }
  if (ascent) {
    const v = [
      "Trend department: **{first}** has climbed **every single day this week** — **#{from} → #{to}**. That's not form, that's a personality type.",
      "**{first}** hasn't dropped a rank all week. **#{from} → #{to}** and climbing like rent. Someone stop them."
    ];
    return { kind: 'trend', text: fill(pickOne(ctx.rng, v), { first: ctx.first[ascent.pid], from: ascent.s[0], to: ascent.s[ascent.s.length - 1] }) };
  }
  if (slide) {
    const v = [
      "The Gaffer's charts show **{first}** descending **daily** — **#{from} → #{to}** in a week. Textbook slow-motion faceplant. Majestic.",
      "**{first}** has lost ground every day this week (**#{from} → #{to}**). This is no longer variance, this is a lifestyle choice."
    ];
    return { kind: 'trend', text: fill(pickOne(ctx.rng, v), { first: ctx.first[slide.pid], from: slide.s[0], to: slide.s[slide.s.length - 1] }) };
  }
  if (yoyo) {
    const v = [
      "**{first}** has held **{n} different ranks** this week. A human yo-yo. The Gaffer's neck hurts from watching.",
      "Volatility award: **{first}** — **{n} ranks** in a week. Somewhere a risk manager is having a nightmare about you."
    ];
    return { kind: 'trend', text: fill(pickOne(ctx.rng, v), { first: ctx.first[yoyo.pid], n: yoyo.distinct }) };
  }
  if (cement) {
    const v = [
      "**{first}** has now spent **{n} straight days** at **#{rank}**. The consistency of a metronome, the ambition of a houseplant.",
      "Rank **#{rank}** has legally changed its name to **{first}** — **{n} days** and counting. Set down roots, why don't you."
    ];
    return { kind: 'trend', text: fill(pickOne(ctx.rng, v), { first: ctx.first[cement.pid], rank: cement.rank, n: cement.n }) };
  }
  return null;
}

// Prediction psychology: scoreline habits mined from every pick they've made
function genQuirk(ctx) {
  let best = null;
  for (const r of ctx.lb) {
    const picks = allKoPicks(ctx.predictions[r.id]);
    if (picks.length < 8) continue;
    const cnt = {}; let draws = 0, goals = 0;
    for (const p of picks) {
      const k = p.h + '-' + p.a;
      cnt[k] = (cnt[k] || 0) + 1;
      if (p.h === p.a) draws++;
      goals += p.h + p.a;
    }
    const [modeScore, modeN] = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    const modeShare = modeN / picks.length, drawShare = draws / picks.length, avg = goals / picks.length;
    const cands = [];
    if (modeShare >= 0.45) cands.push({ w: modeShare + 0.2, type: 'mode', score: modeScore, n: modeN, total: picks.length });
    if (drawShare >= 0.3) cands.push({ w: drawShare + 0.1, type: 'draws', n: draws, total: picks.length });
    if (avg >= 3.4) cands.push({ w: (avg - 2.6) / 2, type: 'goals', avg });
    if (avg <= 1.7) cands.push({ w: (2.2 - avg) / 2, type: 'nil', avg });
    for (const c of cands) if (!best || c.w > best.w) best = { ...c, pid: r.id };
  }
  if (!best) return null;
  const first = ctx.first[best.pid];
  const V = {
    mode: [
      "Psychological profile: **{first}** has predicted **{score}** in **{n} of {total}** picks. One hammer, and every match looks like a nail.",
      "**{first}** and the scoreline **{score}**: name a more devoted couple. **{n} times** and counting. Seek help, or a second scoreline."
    ],
    draws: [
      "**{first}** has sent **{n} of {total}** predictions to penalties. A chaos merchant. An agent of entropy. The Gaffer respects the bit.",
      "Diagnosis: **{first}** predicts draws like it's a personality — **{n}** so far. Somewhere a shootout is being manifested."
    ],
    goals: [
      "**{first}** averages **{avg} goals** per predicted match. Basketball scores. This is football, mate, occasionally people defend.",
      "Every **{first}** prediction is a fireworks display — **{avg} goals** a game on average. Gloriously unhinged."
    ],
    nil: [
      "**{first}** averages just **{avg} goals** per prediction. Watched one Mourinho documentary and never recovered.",
      "The Gaffer's file on **{first}**: predicts football like it's chess. **{avg} goals** a game. Blink, you'll miss the excitement."
    ]
  };
  const vars = { first, score: best.score, n: best.n, total: best.total, avg: best.avg ? best.avg.toFixed(1) : '' };
  return { kind: 'quirk', text: fill(pickOne(ctx.rng, V[best.type]), vars) };
}

// Champion-pick life support — who's dream is still breathing
function genChampWatch(ctx) {
  const fin = ctx.fixtures.find(f => f.id === 104);
  if (!fin || !fin.home?.code || !fin.away?.code) return null;
  const aliveCodes = fin.finished
    ? [actualWinner(fin) === 'home' ? fin.home.code : fin.away.code]
    : [fin.home.code, fin.away.code];
  const holders = [], dead = [];
  for (const r of ctx.lb) {
    const champ = ctx.predictions[r.id]?.champion;
    if (!champ) continue;
    (aliveCodes.includes(champ) ? holders : dead).push(r.id);
  }
  if (!holders.length && !dead.length) return null;
  const total = holders.length + dead.length;
  if (!holders.length) {
    const v = [
      "Champion-pick check: **all {total}** of your chosen winners are already home watching on TV. A clean sweep of wrongness. Historic.",
      "**{total} champion picks**, zero survivors. The Gaffer has never seen a graveyard this well attended."
    ];
    return { kind: 'champwatch', text: fill(pickOne(ctx.rng, v), { total }) };
  }
  const names = holders.slice(0, 3).map(pid => '**' + ctx.first[pid] + '**').join(', ');
  const vars = { names, alive: holders.length, deadN: dead.length, total };
  const v = holders.length === 1 ? [
    `Champion-pick life support: **{deadN} of {total}** dreams are dead. ${names} alone still has a winner breathing. The smuggest seat in the office.`,
    `${names} is the last member with a living champion pick. The other **{deadN}** are just here for the vibes now.`
  ] : [
    `Champion picks still alive: {alive} of {total} — ${names}. Everyone else is emotionally invested in nothing. Beautiful.`,
    `**{deadN} of {total}** champion picks have perished. ${names} still dare to dream. The rest of you, form an orderly queue at the therapy desk.`
  ];
  return { kind: 'champwatch', text: fill(pickOne(ctx.rng, v), vars) };
}

// Hot/cold scoring streaks across consecutive KO matches they actually picked
function genStreak(ctx) {
  const RK = { 'Round of 16': 'r16', 'Quarter-final': 'qf', 'Semi-final': 'sf', '3rd Place playoff': 'third', 'the Final': 'final' };
  const finishedKo = ctx.fixtures.filter(f => f.finished && f.id >= 89).sort((a, b) => a.kickoffMs - b.kickoffMs);
  if (finishedKo.length < 5) return null;
  let hot = null, cold = null;
  for (const r of ctx.lb) {
    const pr = ctx.predictions[r.id];
    if (!pr) continue;
    const seq = [];
    for (const f of finishedKo) {
      const rk = RK[koRound(f.id)];
      if (!rk || !pr[rk] || !pr[rk][f.id]) continue;
      seq.push(ctx.ledger.some(e => e.participantId === r.id && e.matchId === f.id));
    }
    if (seq.length < 5) continue;
    let run = 1;
    for (let i = seq.length - 2; i >= 0 && seq[i] === seq[seq.length - 1]; i--) run++;
    if (seq[seq.length - 1] && run >= 4 && (!hot || run > hot.run)) hot = { pid: r.id, run };
    if (!seq[seq.length - 1] && run >= 4 && (!cold || run > cold.run)) cold = { pid: r.id, run };
  }
  const pickBest = cold && (!hot || cold.run >= hot.run) ? { ...cold, mood: 'cold' } : hot ? { ...hot, mood: 'hot' } : null;
  if (!pickBest) return null;
  const vars = { first: ctx.first[pickBest.pid], run: pickBest.run };
  const v = pickBest.mood === 'hot' ? [
    "**{first}** has scored in **{run} straight matches** they picked. The hottest hand in the building — approach with oven mitts.",
    "Streak alert: **{run} matches**, **{run} paydays** for **{first}**. At some point it stops being luck and starts being annoying."
  ] : [
    "**{first}** is on a **{run}-match** blank streak. That's not a cold spell, that's an ice age with a lanyard.",
    "The drought files: **{first}**, **{run} matches** without a single point. Scientists are baffled. The Gaffer is entertained."
  ];
  return { kind: 'streak', text: fill(pickOne(ctx.rng, v), vars) };
}

// ---------------------------------------------------------------------------
export function generateFeed({ groupId = 'lr', now, force } = {}) {
  now = now ?? (Number(process.env.FEED_NOW_MS) || Date.now());
  force = force ?? (process.env.FORCE_FEED === '1');

  const feed = readOr('feed.json', { days: [] });
  const today = istDateKey(now);

  const already = feed.days[0]?.dateKey === today;
  if (!force && (already || istHour(now) < 12)) return feed; // not time yet, or done for today

  // Baseline = the previous day's record. Under force on an already-generated
  // day, days[0] is today's own record — diff against days[1] instead.
  const prevDay = already ? feed.days[1] : feed.days[0];
  const baselineKeys = prevDay ? new Set(prevDay.keysAtGen || []) : null;
  const prevSnapshot = prevDay?.snapshot || null;

  const excluded = new Set(FEED_EXCLUDE[groupId] || []);
  const ledger = readOr('scoring_ledger.json', []).filter(e => !excluded.has(e.participantId));
  const lb = readOr('leaderboard.json', []).filter(r => !excluded.has(r.id));
  const fixtures = readOr('fixtures.json', []);
  const predictions = Object.fromEntries(Object.entries(readOr('predictions.json', {})).filter(([pid]) => !excluded.has(pid)));
  const participants = readOr('participants.json', []).filter(p => !excluded.has(p.id));
  const meta = readOr('meta.json', {});
  const r32tbd = readOr('r32_tbd.json', []);

  const windowEntries = baselineKeys ? ledger.filter(e => !baselineKeys.has(e.key)) : null;
  const windowMatchIds = new Set((windowEntries || []).map(e => e.matchId).filter(id => id != null));
  const finishedInWindow = fixtures.filter(f => f.finished && windowMatchIds.has(f.id));

  // Rank-snapshot history for trend mining (up to 7 previous days live in feed.json)
  const history = (already ? feed.days.slice(1) : feed.days).map(d => d.snapshot).filter(Boolean);

  const ctx = {
    rng: mulberry32(hashStr(today + '|' + groupId)),
    first: firstNames(participants.length ? participants : lb),
    byId: Object.fromEntries(lb.map(r => [r.id, r])),
    lb, ledger, fixtures, predictions, meta, r32tbd,
    windowEntries, finishedInWindow, prevSnapshot, history, now
  };

  const built = [];
  const push = p => { if (p) Array.isArray(p) ? built.push(...p.filter(Boolean)) : built.push(p); };

  // Anchors: always lead with the day's headline (or rest-day note)
  push(genIntro(ctx));
  push(genWrap(ctx));
  push(genRestDay(ctx));

  // Rotating pool: seeded shuffle means each day gets a different mix and
  // order of segments — kills the identical-edition rhythm, and the
  // history/psychology generators pull mid- and bottom-table members into
  // the banter instead of the same top-two every day.
  const pool = [genMovement, genHaul, genSniper, genBlanked, genUpset, genGap, genBoot,
                genFunFact, genRivalry, genBottomWatch, genSwap, genTrend, genQuirk,
                genChampWatch, genStreak];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const CAP = 8; // anchors + up to this many pool segments
  const seenFirsts = new Set(); // one starring role per member per day where possible
  for (const gen of pool) {
    if (built.length >= CAP) break;
    const p = gen(ctx);
    if (!p) continue;
    const items = Array.isArray(p) ? p.filter(Boolean) : [p];
    for (const it of items) {
      if (built.length >= CAP) break;
      // soft dedupe: skip a segment whose starring MEMBER already headlined today
      // (first bolded token that is actually a first name — bolds are often numbers)
      const nameSet = new Set(Object.values(ctx.first));
      const star = [...it.text.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1]).find(t => nameSet.has(t));
      if (star && seenFirsts.has(star) && !['upset', 'champwatch'].includes(it.kind)) continue;
      if (star) seenFirsts.add(star);
      built.push(it);
    }
  }

  push(genFixtures(ctx));

  // Newest-first in the feed; fake staggered publish times walking back from generation
  let ts = now;
  const posts = built.map(p => {
    const post = { id: today + '-' + p.kind, kind: p.kind, ts, text: p.text };
    if (p.card) post.card = p.card;
    ts -= Math.floor(3 + ctx.rng() * 6) * 60000;
    return post;
  });

  const day = {
    dateKey: today,
    generatedAtMs: now,
    snapshot: lb.map(r => ({ id: r.id, name: r.name, rank: r.rank, total: r.total })),
    keysAtGen: ledger.map(e => e.key),
    posts
  };
  feed.days = [day, ...feed.days.filter(d => d.dateKey !== today)].slice(0, 7);
  // Only days[0] and days[1] are ever used as a diff baseline — drop the bulky key sets beyond that
  feed.days.forEach((d, i) => { if (i > 1) delete d.keysAtGen; });

  write('feed.json', feed);
  console.log(`[feed] ${groupId}: generated ${posts.length} post(s) for ${today}`);
  return feed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  import('dotenv/config').then(() => {
    generateFeed({ groupId: process.env.GROUP_ID || 'lr' });
  });
}
