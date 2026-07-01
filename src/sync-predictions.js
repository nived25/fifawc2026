import 'dotenv/config';
import { write, readOr } from './store.js';

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

export async function syncPredictions() {
  if (!APPS_SCRIPT_URL) {
    console.log('[sync-predictions] APPS_SCRIPT_URL not set, skipping');
    return false;
  }

  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=export`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Export failed');

    const existing = readOr('predictions.json', {});

    const merged = {};
    for (const [pid, pred] of Object.entries(data.predictions || {})) {
      const prev = existing[pid] || {};
      merged[pid] = {
        ...prev,   // keep locally-seeded rounds (e.g. groups' imported R32) absent from the sheet
        ...pred,   // sheet values win for the rounds it does contain
        submittedAtMs: { ...(prev.submittedAtMs || {}), ...(pred.submittedAtMs || {}) },
        // Preserve server-side locked flags; auto-lock runs in once.js
        locked: prev.locked || {}
      };
    }

    // Preserve any entries that only exist locally (e.g. from manual seeding)
    for (const [pid, pred] of Object.entries(existing)) {
      if (!merged[pid]) merged[pid] = pred;
    }

    write('predictions.json', merged);
    console.log(`[sync-predictions] Synced ${Object.keys(merged).length} participants from Apps Script`);
    return true;
  } catch(err) {
    console.error('[sync-predictions] Error:', err.message);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPredictions().then(ok => process.exit(ok ? 0 : 1));
}
