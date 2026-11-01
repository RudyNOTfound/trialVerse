import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

/** Deterministic JSON: object keys sorted recursively, undefined dropped. Used for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Cryptographically secure numeric code (uniform; leading zeros preserved). */
export function generateNumericCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += randomInt(0, 10).toString();
  return out;
}

/** HMAC-SHA256 of the OTP, bound to the pepper and the specific OTP record. */
export function hashOtp(code: string, otpId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`${otpId}:${code}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export const randomToken = (bytes = 16) => randomBytes(bytes).toString('hex');
