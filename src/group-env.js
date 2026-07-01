// Imported FIRST by refresh-group.js — its side effect runs before any module (e.g.
// sync-predictions.js) loads dotenv. dotenv never overrides an already-set key, so pinning
// APPS_SCRIPT_URL here stops the repo .env (which holds LR's URL) from leaking into a group
// run. A group only ever talks to the URL its orchestrator explicitly passed; unset => ''.
process.env.APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
