import { InvalidResponseError, WEBHOOK_PAYLOAD_INVALID, WebhookSignatureError } from '../../errors.js';
import { LOG_EVENTS, NOOP_LOGGER, type SlenLogger, writeLog } from '../../logger.js';
import { eventOf } from './events.js';
import { checkSignature } from './signature.js';
import type { WebhookEvent } from './types.js';

export interface WebhooksOptions {
  /** The signing secret of your endpoint, for the calls that name none. */
  secret?: string | null;
  /** How old a signature may be, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Where refusals are written (`slen.webhook.rejected`). Default: nowhere. */
  logger?: SlenLogger;
}

export interface VerifyOptions {
  /** The signing secret of the endpoint the delivery came to; the module's own when absent. */
  secret?: string;
  /** Replaces the tolerance for this call, in seconds. */
  toleranceSeconds?: number;
  /** The moment the signature is held to. Default: now. */
  now?: Date;
}

/** The raw body as it arrived: the bytes, or the text they decode to. */
export type WebhookPayload = string | Uint8Array;

const DEFAULT_TOLERANCE_SECONDS = 300;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Checks `Slen-Signature` of a delivery and reads its event, from the raw body as it arrived; needs no API key. */
export class WebhooksModule {
  readonly #secret: string | null;
  readonly #toleranceSeconds: number;
  readonly #logger: SlenLogger;

  /** @throws RangeError for a tolerance that is not a whole number of at least 1 */
  constructor(options: WebhooksOptions = {}) {
    this.#secret = secretOf(options.secret ?? null);
    this.#toleranceSeconds = toleranceOf(options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS);
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  /** True when the header signs this body with the secret within the tolerance. @throws TypeError without a secret */
  async verify(payload: WebhookPayload, signatureHeader: string | null | undefined, options: VerifyOptions = {}): Promise<boolean> {
    const check = await this.#check(payload, signatureHeader, options);

    return check.accepted;
  }

  /** The event of an accepted delivery, narrowed by `type`. @throws WebhookSignatureError @throws InvalidResponseError @throws TypeError */
  async constructEvent(payload: WebhookPayload, signatureHeader: string | null | undefined, options: VerifyOptions = {}): Promise<WebhookEvent> {
    const check = await this.#check(payload, signatureHeader, options);

    if (!check.accepted) {
      throw new WebhookSignatureError(`Slen: the webhook signature was not accepted (${check.reason}); do not act on this body.`, {
        reason: check.reason,
      });
    }

    const text = textOf(payload);
    const event = text === null ? null : eventOf(text);

    if (event === null) {
      this.#rejected('invalid_payload', check.ageSeconds);

      throw new InvalidResponseError('Slen: the webhook is signed, but its body is not an event: JSON with id, type, created_at and data.', {
        code: WEBHOOK_PAYLOAD_INVALID,
      });
    }

    return event;
  }

  async #check(payload: WebhookPayload, header: string | null | undefined, options: VerifyOptions) {
    const key = options.secret === undefined ? this.#secret : secretOf(options.secret);

    if (key === null) {
      throw new TypeError('Slen: verifying a webhook needs the signing secret of its endpoint (pass `secret`, or set `webhookSecret`).');
    }

    const check = await checkSignature(bytesOf(payload), header, {
      secret: key,
      toleranceSeconds: options.toleranceSeconds === undefined ? this.#toleranceSeconds : toleranceOf(options.toleranceSeconds),
      nowSeconds: secondsOf(options.now),
    });

    if (!check.accepted) {
      this.#rejected(check.reason, check.ageSeconds);
    }

    return check;
  }

  // The body, the secret and the header are never written: they are the delivery itself.
  #rejected(reason: string, ageSeconds: number | null): void {
    writeLog(this.#logger, LOG_EVENTS.webhookRejected, { reason, age_seconds: ageSeconds });
  }
}

/** Webhooks without a client, for a receiver that has no API key. */
export const webhooks: WebhooksModule = new WebhooksModule();

// An empty or blank secret is a variable that was not set, not a secret.
function secretOf(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

function toleranceOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Slen: the webhook tolerance must be an integer of at least 1 second, got ${String(value)}.`);
  }

  return value;
}

function secondsOf(now: Date | undefined): number {
  const ms = now === undefined ? Date.now() : now.getTime();

  if (!Number.isFinite(ms)) {
    throw new TypeError('Slen: `now` of a webhook check is not a valid date.');
  }

  return Math.floor(ms / 1_000);
}

function bytesOf(payload: WebhookPayload): Uint8Array {
  if (typeof payload === 'string') {
    return new TextEncoder().encode(payload);
  }

  if (payload instanceof Uint8Array) {
    return payload;
  }

  throw new TypeError('Slen: the webhook body is the raw body, as a string or a Uint8Array.');
}

function textOf(payload: WebhookPayload): string | null {
  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return decoder.decode(payload);
  } catch {
    return null;
  }
}
