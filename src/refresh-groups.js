import 'dotenv/config';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Orchestrates a per-group refresh: one child process per group in config/groups.json,
// each with its own DATA_DIR / OUTPUT_SUBDIR / APPS_SCRIPT_URL. A child process is required
// because store.js / buildAppData.js / sync-predictions.js bind those env vars at module load.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const groups = JSON.parse(readFileSync(join(ROOT, 'config', 'groups.json'), 'utf8'));

let failed = 0;
for (const g of groups) {
  const env = {
    ...process.env,
    GROUP_ID: g.id,
    GROUP_TITLE: g.title || g.name || '',
    GROUP_SUBTITLE: g.subtitle || '',
    DATA_DIR: `data/groups/${g.id}`,
    OUTPUT_SUBDIR: g.id,
    // Group's OWN Apps Script only. Explicit override (even to '') stops LR's URL leaking in
    // via inherited process.env — an unset URL just means offline mode for that group.
    APPS_SCRIPT_URL: (g.appsScriptUrlEnv && process.env[g.appsScriptUrlEnv]) || ''
  };
  const r = spawnSync('node', ['src/refresh-group.js'], { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`[refresh-groups] ${g.id} exited ${r.status}`); }
}

if (failed) { console.error(`[refresh-groups] ${failed} group(s) failed`); process.exit(1); }
console.log(`[refresh-groups] ${groups.length} group(s) refreshed`);
