import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { read, write, readOr } from './store.js';
import { authenticate } from './auth.js';
import { getLockTime } from './scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json());

const publicDir = join(__dirname, '..', 'public');
app.get('/', (_req, res) => {
  res.sendFile(join(publicDir, 'index.dc.html'));
});
app.use(express.static(publicDir));

app.post('/api/auth', (req, res) => {
  const { participantId, pin } = req.body;
  if (!participantId || !pin) return res.status(400).json({ error: 'Missing participantId or pin' });
  const result = authenticate(participantId, String(pin));
  res.json(result);
});

app.post('/api/predictions', (req, res) => {
  const { participantId, pin, finalists, champion, ko } = req.body;
  if (!participantId || !pin) return res.status(400).json({ error: 'Missing auth' });

  const auth = authenticate(participantId, String(pin));
  if (!auth.ok) return res.status(401).json(auth);

  const lockTime = getLockTime();
  if (lockTime && Date.now() >= lockTime) {
    return res.status(403).json({ error: 'Predictions are locked' });
  }

  const predictions = readOr('predictions.json', {});
  if (predictions[participantId]?.locked) {
    return res.status(403).json({ error: 'Your predictions are already locked' });
  }

  predictions[participantId] = {
    finalists: finalists || [],
    champion: champion || null,
    ko: ko || {},
    submittedAtMs: Date.now(),
    locked: false
  };

  write('predictions.json', predictions);
  res.json({ ok: true, saved: true });
});

app.get('/api/status', (_req, res) => {
  const meta = readOr('meta.json', {});
  const usage = readOr('api_usage.json', { date: '', count: 0 });
  res.json({
    phase: meta.phase || 'group',
    lastUpdated: meta.lastUpdated,
    lockAtMs: meta.lockAtMs,
    apiUsage: { date: usage.date, count: usage.count }
  });
});

app.listen(PORT, () => {
  console.log(`[server] FIFA Fantasy running on http://localhost:${PORT}`);
  console.log(`[server] Serving frontend from /public`);
  console.log(`[server] API endpoints: /api/auth, /api/predictions, /api/status`);
});
