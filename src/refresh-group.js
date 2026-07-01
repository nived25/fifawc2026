import './group-env.js';   // MUST be first: pins APPS_SCRIPT_URL before any dotenv load
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// NOTE: store.js, buildAppData.js and sync-predictions.js read DATA_DIR / OUTPUT_SUBDIR /
// APPS_SCRIPT_URL at module-load time. This script is therefore meant to be launched as its
// OWN process with those env vars already set (see `npm run refresh:groups`). Importing the
// modules here binds them to the group's env — never mutate env after import.
import { write, readOr } from './store.js';
import { computeScores } from './scoring.js';
import { buildAppData } from './buildAppData.js';
import { syncPredictions } from './sync-predictions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const GROUP_ID = process.env.GROUP_ID;
const DATA_DIR = process.env.DATA_DIR;          // e.g. data/groups/g2 (cwd-relative, matches store.js)
const OUT_SUBDIR = process.env.OUTPUT_SUBDIR;   // e.g. g2
const SHARED_DIR = process.env.SHARED_DIR || './data';  // LR/shared world-cup data source

if (!GROUP_ID || !DATA_DIR || !OUT_SUBDIR) {
  console.error('[refresh-group] GROUP_ID, DATA_DIR and OUTPUT_SUBDIR env vars are required');
  process.exit(1);
}

// World-cup-global data, identical for every group and produced by the LR run.
// participants.json / predictions.json are group-owned and deliberately NOT copied.
const SHARED_FILES = [
  'fixtures.json', 'standings.json', 'bracket.json', 'r32_tbd.json',
  'teams.json', 'team_map.json', 'team_id_map.json', 'stadium_id_map.json'
];

function copyShared() {
  for (const f of SHARED_FILES) {
    const src = join(SHARED_DIR, f);
    if (existsSync(src)) copyFileSync(src, join(DATA_DIR, f));
    else console.warn(`[refresh-group] shared file missing, skipped: ${f}`);
  }
}

// Build the group's meta from shared tournament state, but keep its OWN Apps Script URL.
// Critical: never inherit LR's appsScriptUrl — that would auth this group against LR's sheet.
function buildGroupMeta() {
  const sharedMeta = existsSync(join(SHARED_DIR, 'meta.json'))
    ? JSON.parse(readFileSync(join(SHARED_DIR, 'meta.json'), 'utf8'))
    : {};
  const meta = readOr('meta.json', {});
  meta.phase = sharedMeta.phase;
  meta.activeRound = sharedMeta.activeRound;
  meta.koLockTimes = sharedMeta.koLockTimes || {};
  if (sharedMeta.lockAtMs) meta.lockAtMs = sharedMeta.lockAtMs;
  // r32Reopen is an LR-only late-entrant window keyed by LR participant ids — never applies to groups.
  delete meta.r32Reopen;
  meta.lastUpdated = Date.now();
  if (process.env.APPS_SCRIPT_URL) meta.appsScriptUrl = process.env.APPS_SCRIPT_URL;
  else delete meta.appsScriptUrl;
  if (process.env.GROUP_PIN) meta.loginPin = process.env.GROUP_PIN;
  else delete meta.loginPin;
  write('meta.json', meta);
  return meta;
}

// Auto-lock predictions once a round's lock time has passed (mirrors once.js).
function autoLock(koLockTimes) {
  const predictions = readOr('predictions.json', {});
  let locked = 0;
  for (const [rk, lockMs] of Object.entries(koLockTimes || {})) {
    if (!lockMs || Date.now() < lockMs) continue;
    for (const [, pred] of Object.entries(predictions)) {
      const already = typeof pred.locked === 'boolean' ? pred.locked : !!(pred.locked?.[rk]);
      if (!already && (pred[rk] || (rk === 'r32' && pred.ko))) {
        if (typeof pred.locked !== 'object' || pred.locked === null) pred.locked = {};
        pred.locked[rk] = true;
        locked++;
      }
    }
  }
  if (locked > 0) write('predictions.json', predictions);
  return locked;
}

// Emit the group's frontend: a copy of the single-source HTML whose data fetch is repointed
// at the group's own absolute path, so /<id>/ loads only /<id>/app-data.json.
function generateHtml() {
  const outDir = join(ROOT, 'public', OUT_SUBDIR);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  let html = readFileSync(join(ROOT, 'public', 'index.dc.html'), 'utf8');
  // Point the data fetch at this group's own file...
  html = html.split("fetch('./app-data.json").join(`fetch('/${OUT_SUBDIR}/app-data.json`);
  // ...but shared assets (support.js runtime, etc.) live only at the root, so absolutize any
  // relative src/href — otherwise "./support.js" resolves to /<id>/support.js and 404s,
  // leaving the framework unloaded and the page stuck on raw {{ }} templates.
  html = html.split('src="./').join('src="/');
  html = html.split('href="./').join('href="/');
  // Per-group branding: swap the hardcoded "LR World Cup" title (header, login, splash).
  if (process.env.GROUP_TITLE) html = html.split('LR World Cup').join(process.env.GROUP_TITLE);
  if (process.env.GROUP_SUBTITLE) html = html.split('Office World Cup League').join(process.env.GROUP_SUBTITLE);
  writeFileSync(join(outDir, 'index.html'), html);
}

async function run() {
  console.log(`=== Refresh group: ${GROUP_ID} (DATA_DIR=${DATA_DIR}, out=public/${OUT_SUBDIR}) ===`);
  copyShared();
  await syncPredictions();            // pulls from this group's Apps Script, or skips if URL unset
  const meta = buildGroupMeta();
  const n = autoLock(meta.koLockTimes);
  if (n) console.log(`[refresh-group] ${GROUP_ID}: auto-locked ${n} prediction(s)`);
  const lb = computeScores();
  console.log(`[refresh-group] ${GROUP_ID}: scored ${lb.length} participant(s)`);
  buildAppData();
  generateHtml();
  console.log(`[refresh-group] ${GROUP_ID}: public/${OUT_SUBDIR}/ ready`);
}

run().catch(err => { console.error(err); process.exit(1); });
