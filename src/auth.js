import { createHash, randomBytes } from 'crypto';
import { read, write } from './store.js';

function hashPin(pin, salt) {
  return createHash('sha256').update(salt + pin).digest('hex');
}

export function setPin(participantId, pin) {
  const participants = read('participants.json') || [];
  const p = participants.find(x => x.id === participantId);
  if (!p) return { ok: false, error: 'Participant not found' };

  if (p.pinHash) return { ok: false, error: 'PIN already set' };

  const salt = randomBytes(16).toString('hex');
  p.pinSalt = salt;
  p.pinHash = hashPin(pin, salt);
  write('participants.json', participants);
  return { ok: true };
}

export function verifyPin(participantId, pin) {
  const participants = read('participants.json') || [];
  const p = participants.find(x => x.id === participantId);
  if (!p) return false;
  if (!p.pinHash || !p.pinSalt) return false;
  return hashPin(pin, p.pinSalt) === p.pinHash;
}

export function authenticate(participantId, pin) {
  const participants = read('participants.json') || [];
  const p = participants.find(x => x.id === participantId);
  if (!p) return { ok: false, error: 'Participant not found' };

  if (!p.pinHash) {
    const result = setPin(participantId, pin);
    if (!result.ok) return result;
    return { ok: true, firstTime: true, name: p.name };
  }

  if (verifyPin(participantId, pin)) {
    return { ok: true, firstTime: false, name: p.name };
  }

  return { ok: false, error: 'Invalid PIN' };
}
