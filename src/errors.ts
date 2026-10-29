
/** The local code of a call refused before anything was sent. */
export const INVALID_REQUEST = 'invalid_request';

/** The local code of a 2xx whose body cannot be read. */
export const INVALID_RESPONSE = 'invalid_response';

/** The local code of a webhook whose `Slen-Signature` was not accepted. */
export const WEBHOOK_SIGNATURE_INVALID = 'webhook_signature_invalid';

/** The local code of a webhook with a good signature whose body is not an event. */
export const WEBHOOK_PAYLOAD_INVALID = 'webhook_payload_invalid';

/** Why a webhook's signature was not accepted. */
export type WebhookSignatureReason = 'missing_header' | 'malformed_header' | 'outside_tolerance' | 'no_matching_signature';

export interface SlenErrorInit {
  readonly code: string | null;
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
}

/** The root of every error the SDK raises. */
export class SlenError extends Error {
  /** The wire code (`ErrorCode` of the spec) or a local one; null when there was no answer. */
  readonly code: string | null;
  /** The HTTP status; null when there was no answer. */
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  /** `X-Request-Id` of the answer: what support finds the request by. */
  readonly requestId: string | null;
  /** How long the answer asked to wait (`Retry-After` of a 429 or 503), in seconds; null when it did not say. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, init: Partial<SlenErrorInit> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = init.code ?? null;
    this.status = init.status ?? null;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** 401 or 403: the key, its scope or the tenant. */
export class AuthenticationError extends SlenError {}

/** The request was refused for its shape: 422, an unknown code of a 4xx, or a local check. */
export class InvalidRequestError extends SlenError {}

/** Money said no (402). Each ceiling has a subtype. */
export class SpendRefusedError extends SlenError {}

/** The project's or the organization's budget. */
export class BudgetExceededError extends SpendRefusedError {}

/** The end customer is out of credits. */
export class InsufficientCreditsError extends SpendRefusedError {}

export class OverrunStoppedError extends SpendRefusedError {}

export class OverrunApprovalRequiredError extends SpendRefusedError {}

/** One operation would cost more than a `per_operation` budget allows. */
export class OperationLimitExceededError extends SpendRefusedError {}

/** A `concurrency` budget has every slot taken; passes when one is freed. */
export class ConcurrencyLimitError extends SpendRefusedError {}

export class CustomerNotFoundError extends SlenError {}

/** 429: the key sent more requests than its rate limit allows. */
export class RateLimitError extends SlenError {}

export class PolicyDeniedError extends SlenError {}

/** 403 `customer_blocked`: the end customer of the run is blocked, so its new runs are refused. Nothing ran. */
export class CustomerBlockedError extends PolicyDeniedError {}

export class IdempotencyConflictError extends SlenError {}

/** A model provider failed or could not be called; any 5xx without a known code lands here too — read `code`. */
export class ProviderError extends SlenError {}

/** No answer in time (no code), or a run that ran out of time on the server. */
export class TimeoutError extends SlenError {}

/** A provider was called and nobody knows what became of the call: the money may be spent. */
export class OperationUncertainError extends SlenError {}

/** 503 from Slen itself: nothing was done, the request may be sent again. */
export class ServiceUnavailableError extends SlenError {}

/** The flow broke while it was walked; the model calls before the break were paid for. */
export class FlowRuntimeError extends SlenError {}

/** Slen could not be reached, or the connection broke before the answer was read. No code, no status. */
export class ConnectionError extends SlenError {}

/** A 2xx whose body cannot be read as the answer (`invalid_response`); the call may have gone through. */
export class InvalidResponseError extends SlenError {}

/** A webhook whose `Slen-Signature` was not accepted: do not act on its body. `reason` says why. */
export class WebhookSignatureError extends SlenError {
  readonly reason: WebhookSignatureReason;

  constructor(message: string, init: Partial<SlenErrorInit> & { readonly reason: WebhookSignatureReason }) {
    super(message, { code: WEBHOOK_SIGNATURE_INVALID, ...init });
    this.reason = init.reason;
  }
}
