/** @internal */
export function webCrypto(): Crypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;

  if (crypto === undefined || crypto === null || typeof crypto.getRandomValues !== 'function') {
    throw new Error(
      'Slen: this runtime has no Web Crypto (`globalThis.crypto`), which idempotency keys and span ids are made from. ' +
        '@slen/sdk needs Node 20.3 or later — or any runtime that has Web Crypto: Deno, Bun, workers, browsers.',
    );
  }

  return crypto;
}

/** A v4 UUID from the platform CSPRNG: the key the SDK sends when a call names none. */
export function generateIdempotencyKey(): string {
  const crypto = webCrypto();

  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** The key of a background job's call, `job:{jobId}:{operation}`, the same on every retry. @throws TypeError for an empty part */
export function idempotencyKeyForJob(jobId: string, operation: string): string {
  if (jobId.trim() === '' || operation.trim() === '') {
    throw new TypeError('Slen: the key of a job needs the id of the job and the operation.');
  }

  return `job:${jobId}:${operation}`;
}
