import 'dotenv/config';
import { write, read } from './store.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TDXNJiHpuJySwsp6KXx1u19ZrZZWsYaNztWd39VVD0I';
const SHEET_GID = process.env.GOOGLE_SHEET_GID || '0';

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());

  return lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { values.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

const PICK_NORMALIZE = {
  'ARGENTINA': 'ARG', 'GERMANY': 'GER', 'NETHERLANDS': 'NED', 'FRANCE': 'FRA',
  'BRAZIL': 'BRA', 'PORTUGAL': 'POR', 'PORTAL': 'POR', 'SPAIN': 'ESP',
  'ENGLAND': 'ENG', 'BELGIUM': 'BEL', 'ITALY': 'ITA', 'CROATIA': 'CRO',
  'URUGUAY': 'URU', 'COLOMBIA': 'COL', 'MEXICO': 'MEX', 'USA': 'USA',
  'JAPAN': 'JPN', 'SOUTH KOREA': 'KOR', 'AUSTRALIA': 'AUS', 'CANADA': 'CAN',
  'MOROCCO': 'MAR', 'SENEGAL': 'SEN', 'GHANA': 'GHA', 'CAMEROON': 'CMR',
  'NIGERIA': 'NGA', 'TUNISIA': 'TUN', 'SAUDI ARABIA': 'KSA', 'IRAN': 'IRN',
  'QATAR': 'QAT', 'ECUADOR': 'ECU', 'CHILE': 'CHI', 'PERU': 'PER',
  'SERBIA': 'SRB', 'SWITZERLAND': 'SUI', 'DENMARK': 'DEN', 'SWEDEN': 'SWE',
  'NORWAY': 'NOR', 'POLAND': 'POL', 'AUSTRIA': 'AUT', 'WALES': 'WAL',
  'SCOTLAND': 'SCO', 'UKRAINE': 'UKR', 'TURKEY': 'TUR', 'EGYPT': 'EGY',
  'INDIA': 'IND', 'UNITED STATES': 'USA'
};

function normalizePick(raw) {
  const upper = raw.toUpperCase().trim();
  if (upper.length === 3 && /^[A-Z]{3}$/.test(upper)) return upper;
  return PICK_NORMALIZE[upper] || upper.substring(0, 3);
}

function toId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

async function sync() {
  console.log('[sync] Fetching participant data from Google Sheet...');

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('[sync] Failed to fetch sheet:', res.status, res.statusText);
    process.exit(1);
  }

  const csv = await res.text();
  const rows = parseCSV(csv);
  console.log(`[sync] Parsed ${rows.length} rows from sheet`);

  const nameCol = Object.keys(rows[0] || {}).find(k => k.includes('name') || k === 'player' || k === 'participant');
  const pickCols = Object.keys(rows[0] || {}).filter(k => k.includes('pick') || k.includes('team') || k.match(/^(pick|team|choice)\s*\d/i));
  const emailCol = Object.keys(rows[0] || {}).find(k => k.includes('email'));

  if (!nameCol && !pickCols.length) {
    console.log('[sync] Could not auto-detect columns. Headers found:', Object.keys(rows[0] || {}));
    console.log('[sync] Falling back to hardcoded participant list from frontend...');
    useFallback();
    return;
  }

  const existing = read('participants.json') || [];
  const existingMap = {};
  for (const p of existing) existingMap[p.id] = p;

  const participants = rows.map(row => {
    const name = row[nameCol] || '';
    if (!name) return null;
    const id = toId(name);
    const picks = pickCols.map(c => normalizePick(row[c] || '')).filter(Boolean);
    const email = emailCol ? row[emailCol] : undefined;

    const prev = existingMap[id];
    return {
      id,
      name,
      picks: picks.length ? picks : (prev?.picks || []),
      email: email || prev?.email,
      ...(prev?.pinHash ? { pinHash: prev.pinHash, pinSalt: prev.pinSalt } : {})
    };
  }).filter(Boolean);

  write('participants.json', participants);
  console.log(`[sync] Saved ${participants.length} participants`);
  participants.forEach(p => console.log(`  ${p.name}: [${p.picks.join(', ')}]`));
}

function useFallback() {
  const hardcoded = [
    ['Neerav Tipnis', ['GER', 'NED', 'FRA', 'ARG']],
    ['Sagar Vatkar', ['GER', 'BRA', 'POR', 'ARG']],
    ['Dhruv Shah', ['ARG', 'GER', 'BRA', 'ESP']],
    ['Praveen Kumar', ['GER', 'FRA', 'POR', 'ARG']],
    ['Rushabh Jha', ['ESP', 'GER', 'ENG', 'ARG']],
    ['Renu Verma', ['ESP', 'FRA', 'ARG', 'BRA']],
    ['Avdhut Pure', ['ARG', 'BRA', 'POR', 'ESP']],
    ['Anurag Saxena', ['POR', 'BRA', 'ARG', 'ESP']],
    ['Neelkanth Vyas', ['ESP', 'FRA', 'BRA', 'POR']],
    ['Nived', ['FRA', 'ARG', 'ESP', 'POR']],
    ['Fananio', ['ARG', 'ESP', 'FRA', 'POR']],
    ['Ranjit Nambiar', ['ESP', 'ARG', 'POR', 'BEL']]
  ];

  const existing = read('participants.json') || [];
  const existingMap = {};
  for (const p of existing) existingMap[p.id] = p;

  const participants = hardcoded.map(([name, picks]) => {
    const id = toId(name);
    const prev = existingMap[id];
    return {
      id, name, picks,
      ...(prev?.pinHash ? { pinHash: prev.pinHash, pinSalt: prev.pinSalt } : {}),
      ...(prev?.email ? { email: prev.email } : {})
    };
  });

  write('participants.json', participants);
  console.log(`[sync] Saved ${participants.length} participants (from hardcoded fallback)`);
}

sync().catch(err => { console.error(err); process.exit(1); });
