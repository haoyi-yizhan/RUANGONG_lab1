import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ensure } from './errors.mjs';

/** Store salted, memory-hard password digests; never persist raw passwords. */
export function hashSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(secret, salt, 32).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function matchesSecret(secret, stored) {
  if (typeof secret !== 'string' || secret.length > 256) {
    return false;
  }
  const [algorithm, salt, digest] = (stored || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !digest) {
    return false;
  }
  const actual = scryptSync(secret, salt, 32);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validatePassword(password) {
  ensure(typeof password === 'string' && password.length >= 10 && password.length <= 128
    && /[a-zA-Z]/u.test(password) && /[0-9]/u.test(password),
  'WEAK_PASSWORD', '密码须为 10～128 位，且包含字母和数字');
}

export function secretToken() {
  return randomBytes(32).toString('base64url');
}

export function publicUser(row) {
  return {
    id: row.id,
    phone: row.phone,
    role: row.role,
    name: row.name,
    verified: Boolean(row.id_number),
    banned: Boolean(row.banned),
  };
}
