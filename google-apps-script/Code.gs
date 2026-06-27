// FIFA Fantasy 2026 — Google Apps Script Backend
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web app
// Execute as: Me | Who has access: Anyone
// After deploy, copy the Web App URL to .env as APPS_SCRIPT_URL

const STATIC_PIN = '5555';
const PREDICTIONS_SHEET = 'Predictions';

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
    if (action === 'load') return jsonResponse(handleLoad(e.parameter));
    if (action === 'export') return jsonResponse(handleExport());
    return jsonResponse({ ok: false, error: 'Use action=load or action=export' });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
    const nameCol = headers.findIndex(h =>
      h === 'name' || h === 'player' || h === 'participant' || h.includes('name')
    );
    if (emailCol < 0) continue;

    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][emailCol]).toLowerCase().trim();
      if (rowEmail === target) {
        const rawName = nameCol >= 0 ? String(data[i][nameCol]) : email;
        const id = rawName.toLowerCase()
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/, '');
        return { id, name: rawName, email: rowEmail };
      }
    }
  }
  return null;
}

function handleAuth(data) {
  const { email, pin } = data;
  if (!email || !pin) return { ok: false, error: 'Missing email or pin' };
  if (String(pin) !== STATIC_PIN) return { ok: false, error: 'Invalid PIN. Use 5555.' };
  const participant = findParticipantByEmail(email);
  if (!participant) return { ok: false, error: 'Email not found. Check with Nived.' };
  return { ok: true, participantId: participant.id, name: participant.name };
}

function handleSave(data) {
  const { email, pin, participantId, round, picks, finalists, champion } = data;
  if (String(pin) !== STATIC_PIN) return { ok: false, error: 'Invalid PIN' };

  let pid = participantId;
  if (!pid && email) {
    const p = findParticipantByEmail(email);
    if (!p) return { ok: false, error: 'Not authenticated' };
    pid = p.id;
  }
  if (!pid) return { ok: false, error: 'Missing participantId' };
  if (!round) return { ok: false, error: 'Missing round' };

  const sheet = getOrCreatePredSheet();
  const allData = sheet.getDataRange().getValues();

  function upsertRow(roundKey, picksObj, fins, champ) {
    let targetRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (String(allData[i][0]) === pid && String(allData[i][1]) === roundKey) {
        targetRow = i + 1;
        break;
      }
    }
    const rowData = [pid, roundKey, JSON.stringify(picksObj || {}),
      JSON.stringify(fins || []), champ || '', Date.now()];
    if (targetRow >= 1) {
      sheet.getRange(targetRow, 1, 1, 6).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
      allData.push(rowData); // keep local copy in sync
    }
  }

  upsertRow(round, picks, finalists, champion);
  // Always persist bonus picks (finalists + champion) independently
  if (finalists !== undefined || champion !== undefined) {
    upsertRow('bonus', {}, finalists, champion);
  }

  return { ok: true, saved: true };
}

function handleLoad(params) {
  const { participantId } = params;
  if (!participantId) return { ok: false, error: 'Missing participantId' };

  const sheet = getOrCreatePredSheet();
  const allData = sheet.getDataRange().getValues();
  const result = {};

  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]) !== participantId) continue;
    const round = String(allData[i][1]);
    try {
      const picks = JSON.parse(allData[i][2] || '{}');
      const fins = JSON.parse(allData[i][3] || '[]');
      const champ = String(allData[i][4]);
      if (round === 'bonus') {
        if (fins.length) result.finalists = fins;
        if (champ) result.champion = champ;
      } else {
        result[round] = picks;
      }
    } catch(e) {}
  }

  return { ok: true, predictions: result };
}

function handleExport() {
  const sheet = getOrCreatePredSheet();
  const allData = sheet.getDataRange().getValues();
  if (allData.length < 2) return { ok: true, predictions: {} };

  const byParticipant = {};
  for (let i = 1; i < allData.length; i++) {
    const pid = String(allData[i][0]);
    const round = String(allData[i][1]);
    if (!pid) continue;
    try {
      const picks = JSON.parse(allData[i][2] || '{}');
      const fins = JSON.parse(allData[i][3] || '[]');
      const champ = String(allData[i][4]);
      const ts = Number(allData[i][5]);
      if (!byParticipant[pid]) byParticipant[pid] = { submittedAtMs: {} };
      if (round === 'bonus') {
        if (fins.length) byParticipant[pid].finalists = fins;
        if (champ) byParticipant[pid].champion = champ;
      } else {
        byParticipant[pid][round] = picks;
        byParticipant[pid].submittedAtMs[round] = ts;
      }
    } catch(e) {}
  }

  return { ok: true, predictions: byParticipant };
}
