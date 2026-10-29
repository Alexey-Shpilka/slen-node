import type { WebhookSignatureReason } from '../../errors.js';

/** @internal */
export const SIGNATURE_HEADER = 'Slen-Signature';

/** @internal */
export interface SignatureRule {
  readonly secret: string;
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
}

/** @internal */
export type SignatureCheck =
  | { readonly accepted: true; readonly ageSeconds: number }
  | { readonly accepted: false; readonly reason: WebhookSignatureReason; readonly ageSeconds: number | null };

// HMAC-SHA256 in lower-case hex: anything else cannot be the signature, whatever bytes it spells.
const SIGNATURE = /^[0-9a-f]{64}$/;
const DIGITS = /^\d+$/;

const encoder = new TextEncoder();

/** @internal */
export async function checkSignature(body: Uint8Array, header: string | null | undefined, rule: SignatureRule): Promise<SignatureCheck> {
  if (header === null || header === undefined || header.trim() === '') {
    return { accepted: false, reason: 'missing_header', ageSeconds: null };
  }

  const parsed = parseHeader(header);

  if (parsed === null) {
    return { accepted: false, reason: 'malformed_header', ageSeconds: null };
  }

  const ageSeconds = rule.nowSeconds - parsed.timestamp;

  if (Math.abs(ageSeconds) > rule.toleranceSeconds) {
    return { accepted: false, reason: 'outside_tolerance', ageSeconds };
  }

  const subtle = webCryptoSubtle();
  const key = await subtle.importKey('raw', encoder.encode(rule.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signed = concat(encoder.encode(`${parsed.timestamp}.`), body);

  for (const candidate of parsed.signatures) {
    if (SIGNATURE.test(candidate) && (await subtle.verify('HMAC', key, bytesOf(candidate), signed))) {
      return { accepted: true, ageSeconds };
    }
  }

  return { accepted: false, reason: 'no_matching_signature', ageSeconds };
}

function parseHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  let timestamps = 0;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const pair = part.trim();
    const equals = pair.indexOf('=');

    if (equals < 0) {
      continue;
    }

    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);

    if (name === 't') {
      timestamps += 1;
      timestamp = DIGITS.test(value) ? Number(value) : null;

      continue;
    }

    if (name === 'v1') {
      signatures.push(value);
    }
  }

  return timestamp === null || timestamps !== 1 || signatures.length === 0 ? null : { timestamp, signatures };
}

// Typed by inference: a fresh array is backed by an `ArrayBuffer`, which Web Crypto asks for.
function bytesOf(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

function concat(head: Uint8Array, tail: Uint8Array) {
  const joined = new Uint8Array(head.length + tail.length);

  joined.set(head, 0);
  joined.set(tail, head.length);

  return joined;
}

function webCryptoSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;

  if (subtle === undefined || subtle === null) {
    throw new Error('Slen: this runtime has no Web Crypto (`globalThis.crypto.subtle`), which webhook signatures are checked with.');
  }

  return subtle;
}
