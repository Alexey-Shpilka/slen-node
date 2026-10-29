import {
  AuthenticationError,
  BudgetExceededError,
  ConcurrencyLimitError,
  CustomerBlockedError,
  CustomerNotFoundError,
  FlowRuntimeError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  InvalidRequestError,
  OperationLimitExceededError,
  OperationUncertainError,
  OverrunApprovalRequiredError,
  OverrunStoppedError,
  PolicyDeniedError,
  ProviderError,
  RateLimitError,
  ServiceUnavailableError,
  SlenError,
  type SlenErrorInit,
  SpendRefusedError,
  TimeoutError,
} from '../errors.js';
import type { HttpAnswer } from './client.js';
import { retryAfterMs } from './retry.js';

/** @internal */
export type SlenErrorType = new (message: string, init?: Partial<SlenErrorInit>) => SlenError;

const BY_CODE: Readonly<Record<string, SlenErrorType>> = Object.freeze({
  invalid_api_key: AuthenticationError,
  insufficient_scope: AuthenticationError,
  not_authenticated: AuthenticationError,
  not_a_member: AuthenticationError,
  account_suspended: AuthenticationError,
  budget_exceeded: BudgetExceededError,
  insufficient_credits: InsufficientCreditsError,
  overrun_stopped: OverrunStoppedError,
  overrun_approval_required: OverrunApprovalRequiredError,
  customer_not_found: CustomerNotFoundError,
  operation_limit_exceeded: OperationLimitExceededError,
  concurrency_limit_exceeded: ConcurrencyLimitError,
  rate_limit_exceeded: RateLimitError,
  policy_denied: PolicyDeniedError,
  model_not_allowed: PolicyDeniedError,
  customer_blocked: CustomerBlockedError,
  idempotency_conflict: IdempotencyConflictError,
  idempotency_in_progress: IdempotencyConflictError,
  execution_timeout: TimeoutError,
  background_hold_expired: TimeoutError,
  // The provider could not be reached at all, whatever the name says.
  provider_timeout: ProviderError,
  provider_unavailable: ProviderError,
  provider_rate_limit: ProviderError,
  provider_error: ProviderError,
  provider_not_configured: ProviderError,
  pool_exhausted: ProviderError,
  cost_calculation_failed: InvalidRequestError,
  // Not a ProviderError: the one answer that must not be caught as a safe one.
  operation_uncertain: OperationUncertainError,
  ledger_unavailable: ServiceUnavailableError,
  service_unavailable: ServiceUnavailableError,
  flow_runtime_error: FlowRuntimeError,
  step_limit_exceeded: FlowRuntimeError,
  unrouted_port: FlowRuntimeError,
  unknown_node: FlowRuntimeError,
  node_type_not_supported: FlowRuntimeError,
  execution_conflict: FlowRuntimeError,
  http_request_failed: FlowRuntimeError,
});

/** @internal */
export const MAPPED_ERROR_CODES: readonly string[] = Object.freeze(Object.keys(BY_CODE));

/** @internal */
export function errorTypeForCode(code: string): SlenErrorType | undefined {
  // An own property only: a code off the wire may be `constructor`.
  return Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : undefined;
}

function fallbackFor(status: number): SlenErrorType {
  if (status === 401 || status === 403) {
    return AuthenticationError;
  }

  if (status === 402) {
    return SpendRefusedError;
  }

  if (status === 429) {
    return RateLimitError;
  }

  return status >= 500 ? ProviderError : InvalidRequestError;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A non-2xx answer as its typed error: the code decides the type, the status only a code this version does not know. */
export function errorFromResponse(status: number, body: unknown, requestId: string | null): SlenError {
  return errorOf({ status, body, requestId }, {});
}

/** @internal */
export function errorFromAnswer(answer: Pick<HttpAnswer, 'status' | 'headers' | 'body' | 'requestId'>): SlenError {
  const asked = retryAfterMs(answer.headers.get('retry-after'));

  return errorOf(answer, { retryAfterSeconds: asked === null ? null : Math.ceil(asked / 1_000) });
}

function errorOf(answer: Pick<HttpAnswer, 'status' | 'body' | 'requestId'>, more: Partial<Pick<SlenErrorInit, 'retryAfterSeconds'>>): SlenError {
  const { status, requestId } = answer;
  const parsed = asObject(answer.body) ?? {};
  const envelope = asObject(parsed['error']);
  const code = asString(envelope?.['code']);
  const errors = parsed['errors'];
  const details = asObject(envelope?.['details']) ?? (typeof errors === 'object' && errors !== null ? { errors } : {});
  const message =
    asString(envelope?.['message']) ?? asString(parsed['message']) ?? `Slen request failed with status ${status}`;
  const Type = (code === null ? undefined : errorTypeForCode(code)) ?? fallbackFor(status);

  return new Type(message, {
    code,
    status,
    details,
    requestId: asString(envelope?.['request_id']) ?? requestId,
    ...more,
  });
}
