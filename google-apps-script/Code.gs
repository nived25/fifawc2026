// FIFA Fantasy 2026 — Google Apps Script Backend
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web app
// Execute as: Me | Who has access: Anyone
// After deploy, copy the Web App URL to .env as APPS_SCRIPT_URL

const STATIC_PIN = '5555';
const PREDICTIONS_SHEET = 'Predictions';
const CODE_VERSION = '2026-07-06-merge-nondestructive';  // ?action=version proves what's live

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'auth') return jsonResponse(handleAuth(data));
    if (data.action === 'save') return jsonResponse(handleSave(data));
    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'version') return jsonResponse({ ok: true, version: CODE_VERSION });
    if (action === 'raw') {
      if (String(e.parameter.pin) !== STATIC_PIN) return jsonResponse({ ok: false, error: 'Invalid PIN' });
      return jsonResponse(handleRaw());
    }
    if (action === 'load') return jsonResponse(handleLoad(e.parameter));
    if (action === 'export') return jsonResponse(handleExport());
    if (action === 'clear') {
      if (String(e.parameter.pin) !== STATIC_PIN) return jsonResponse({ ok: false, error: 'Invalid PIN' });
      return jsonResponse(handleClear(e.parameter));
    }
    if (action === 'dedupe') {  // one-time cleanup, PIN-gated, run ONLY after recovery is done
      if (String(e.parameter.pin) !== STATIC_PIN) return jsonResponse({ ok: false, error: 'Invalid PIN' });
      return jsonResponse({ ok: true, deleted: dedupeSheet(getOrCreatePredSheet()) });
    }
    return jsonResponse({ ok: false, error: 'Use action=load, export, raw&pin=, version, clear&participantId=&pin=' });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreatePredSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PREDICTIONS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PREDICTIONS_SHEET);
    sheet.getRange(1, 1, 1, 6).setValues([
      ['participantId', 'round', 'picksJSON', 'finalistsJSON', 'champion', 'submittedAtMs']
    ]);
  }
  return sheet;
}

// Newest row (max submittedAtMs) per (pid,round). NON-DESTRUCTIVE — never deletes, so every
// historical/duplicate row is preserved for audit + recovery. Reads pick the newest; that is
// also the row saves update, so the value returned is always the member's latest.
function newestRowMap(data) {
  const best = {};                 // key -> { rowNum, ts }
  for (let i = 1; i < data.length; i++) {
    const pid = String(data[i][0]); if (!pid) continue;
    const key = pid + '|' + String(data[i][1]);
    const ts = Number(data[i][5]) || 0;
    if (!best[key] || ts >= best[key].ts) best[key] = { rowNum: i + 1, ts };
  }
  return best;
}

function findParticipantByEmail(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const target = email.toLowerCase().trim();
  for (const sheet of sheets) {
    if (sheet.getName() === PREDICTIONS_SHEET) continue;
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) continue;
    const headers = data[0].map(h => String(h).toLowerCase().trim());
    const emailCol = headers.findIndex(h => h.includes('email'));
    const nameCol = headers.findIndex(h => h === 'name' || h === 'player' || h === 'participant' || h.includes('name'));
    const idCol = headers.findIndex(h => h === 'id');
    if (emailCol < 0) continue;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][emailCol]).toLowerCase().trim() === target) {
        const rawName = nameCol >= 0 ? String(data[i][nameCol]) : email;
        const explicitId = idCol >= 0 ? String(data[i][idCol]).trim() : '';
        const id = explicitId || rawName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '');
        return { id, name: rawName, email: String(data[i][emailCol]).toLowerCase().trim() };
      }
    }
  }
  return null;
}

function handleAuth(data) {
  const { email, pin } = data;
  if (!email || !pin) return { ok: false, error: 'Missing email or pin' };
  if (String(pin) !== STATIC_PIN) return { ok: false, error: 'Invalid PIN. Use 5555.' };
  const p = findParticipantByEmail(email);
  if (!p) return { ok: false, error: 'Email not found. Check with Nived.' };
  return { ok: true, participantId: p.id, name: p.name };
}

function handleSave(data) {
  const { email, pin, participantId, round, picks, finalists, champion } = data;
  if (String(pin) !== STATIC_PIN) return { ok: false, error: 'Invalid PIN' };
  let pid = participantId;
  if (!pid && email) { const p = findParticipantByEmail(email); if (!p) return { ok: false, error: 'Not authenticated' }; pid = p.id; }
  if (!pid) return { ok: false, error: 'Missing participantId' };
  if (!round) return { ok: false, error: 'Missing round' };

  const sheet = getOrCreatePredSheet();
  const data2 = sheet.getDataRange().getValues();
  const best = newestRowMap(data2);
  // r16 onward = match-level: MERGE incoming picks into the newest row per match id, so a
  // save that only edited open matches never clobbers a locked match's stored value.
  const MERGE = { r16: 1, qf: 1, sf: 1, final: 1 };

  function upsert(roundKey, picksObj, fins, champ) {
    const hit = best[pid + '|' + roundKey];
    let finalPicks = picksObj || {};
    if (MERGE[roundKey] && hit) {
      let existing = {};
      try { existing = JSON.parse(data2[hit.rowNum - 1][2] || '{}'); } catch (e) {}
      finalPicks = existing;
      for (const k in (picksObj || {})) finalPicks[k] = picksObj[k];
    }
    const rowData = [pid, roundKey, JSON.stringify(finalPicks), JSON.stringify(fins || []), champ || '', Date.now()];
    if (hit) sheet.getRange(hit.rowNum, 1, 1, 6).setValues([rowData]);
    else sheet.appendRow(rowData);
  }

  upsert(round, picks, finalists, champion);
  if (finalists !== undefined || champion !== undefined) upsert('bonus', {}, finalists, champion);
  return { ok: true, saved: true };
}

function handleLoad(params) {
  const { participantId } = params;
  if (!participantId) return { ok: false, error: 'Missing participantId' };
  const data = getOrCreatePredSheet().getDataRange().getValues();
  const best = newestRowMap(data);
  const result = {};
  for (const key in best) {
    const [pid, round] = key.split('|');
    if (pid !== participantId) continue;
    const row = data[best[key].rowNum - 1];
    try {
      const picks = JSON.parse(row[2] || '{}'), fins = JSON.parse(row[3] || '[]'), champ = String(row[4]);
      if (round === 'bonus') { if (fins.length) result.finalists = fins; if (champ) result.champion = champ; }
      else result[round] = picks;
    } catch (e) {}
  }
  return { ok: true, predictions: result };
}

function handleExport() {
  const data = getOrCreatePredSheet().getDataRange().getValues();
  if (data.length < 2) return { ok: true, predictions: {} };
  const best = newestRowMap(data);
  const byP = {};
  for (const key in best) {
    const [pid, round] = key.split('|');
    const row = data[best[key].rowNum - 1];
    try {
      const picks = JSON.parse(row[2] || '{}'), fins = JSON.parse(row[3] || '[]'), champ = String(row[4]), ts = Number(row[5]);
      if (!byP[pid]) byP[pid] = { submittedAtMs: {} };
      if (round === 'bonus') { if (fins.length) byP[pid].finalists = fins; if (champ) byP[pid].champion = champ; }
      else { byP[pid][round] = picks; byP[pid].submittedAtMs[round] = ts; }
    } catch (e) {}
  }
  return { ok: true, predictions: byP };
}

// Audit: every raw row (no dedupe) with timestamps — reveals all duplicate/shadowed edits.
function handleRaw() {
  const data = getOrCreatePredSheet().getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (!String(data[i][0])) continue;
    rows.push({
      rowNum: i + 1, participantId: String(data[i][0]), round: String(data[i][1]),
      picks: String(data[i][2] || ''), finalists: String(data[i][3] || ''),
      champion: String(data[i][4] || ''), submittedAtMs: Number(data[i][5]) || 0
    });
  }
  return { ok: true, version: CODE_VERSION, count: rows.length, rows };
}

// One-time destructive cleanup (keep newest per key, delete rest). Run ONLY after recovery.
function dedupeSheet(sheet) {
  const data = sheet.getDataRange().getValues();
  const best = newestRowMap(data);
  const keep = {}; for (const k in best) keep[best[k].rowNum] = 1;
  const dead = [];
  for (let i = 1; i < data.length; i++) { if (String(data[i][0]) && !keep[i + 1]) dead.push(i + 1); }
  dead.sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
  return dead.length;
}

function handleClear(params) {
  const { participantId } = params;
  if (!participantId) return { ok: false, error: 'Missing participantId — wiping all rows is not allowed' };
  const sheet = getOrCreatePredSheet();
  const data = sheet.getDataRange().getValues();
  const del = [];
  for (let i = data.length - 1; i >= 1; i--) if (String(data[i][0]) === participantId) del.push(i + 1);
  del.forEach(r => sheet.deleteRow(r));
  return { ok: true, deleted: del.length, participantId };
}
