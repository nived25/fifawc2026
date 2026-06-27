import { read, write } from './store.js';

const BASE = 'https://v3.football.api-sports.io';
const KEY = process.env.APISPORTS_KEY;
const BUDGET = parseInt(process.env.API_BUDGET || '80', 10);

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage() {
  const usage = read('api_usage.json');
  if (!usage || usage.date !== todayStr()) {
    return { date: todayStr(), count: 0, log: [] };
  }
  return usage;
}

function saveUsage(usage) {
  write('api_usage.json', usage);
}

export async function apiGet(path, params = {}, { critical = false } = {}) {
  if (!KEY) return { ok: false, data: null, error: 'APISPORTS_KEY not set' };

  const isStatus = path === '/status';
  const usage = getUsage();

  if (!isStatus && !critical && usage.count >= BUDGET) {
    console.warn(`[api] Budget exhausted (${usage.count}/${BUDGET}). Skipping: ${path}`);
    return { ok: false, data: null, error: `Budget exhausted: ${usage.count}/${BUDGET}` };
  }

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { 'x-apisports-key': KEY }
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          const wait = Math.min(5000, 1000 * (attempt + 1));
          console.warn(`[api] ${res.status} on ${path}, retrying in ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return { ok: false, data: null, error: `HTTP ${res.status}` };
      }

      const json = await res.json();

      if (!isStatus) {
        usage.count++;
        usage.log.push({ ts: Date.now(), endpoint: path, params });
        saveUsage(usage);
      }

      if (json.errors && Object.keys(json.errors).length > 0) {
        return { ok: false, data: null, error: JSON.stringify(json.errors) };
      }

      return { ok: true, data: json.response };
    } catch (err) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, data: null, error: err.message };
    }
  }
  return { ok: false, data: null, error: 'Unreachable' };
}

export function getUsageStats() {
  const usage = getUsage();
  return { date: usage.date, used: usage.count, budget: BUDGET, remaining: BUDGET - usage.count };
}
