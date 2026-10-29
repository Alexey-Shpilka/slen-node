export { Slen, type Health } from './slen.js';
export { apiBase, DEFAULT_BASE_URL, resolveConfig, type SlenConfig, type SlenOptions } from './config.js';
export { generateIdempotencyKey, idempotencyKeyForJob } from './idempotency.js';
export { LOG_EVENTS, NOOP_LOGGER, type LogEvent, type SlenLogger } from './logger.js';
export { errorFromResponse } from './http/error-mapper.js';
export type { CallOptions, RequestOptions } from './http/client.js';

export {
  AuthenticationError,
  BudgetExceededError,
  ConcurrencyLimitError,
  ConnectionError,
  CustomerBlockedError,
  CustomerNotFoundError,
  FlowRuntimeError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  INVALID_REQUEST,
  INVALID_RESPONSE,
  InvalidRequestError,
  InvalidResponseError,
  OperationLimitExceededError,
  OperationUncertainError,
  OverrunApprovalRequiredError,
  OverrunStoppedError,
  PolicyDeniedError,
  ProviderError,
  RateLimitError,
  ServiceUnavailableError,
  SlenError,
  SpendRefusedError,
  TimeoutError,
  WEBHOOK_PAYLOAD_INVALID,
  WEBHOOK_SIGNATURE_INVALID,
  WebhookSignatureError,
  type SlenErrorInit,
  type WebhookSignatureReason,
} from './errors.js';

export { OperationsModule, type ContextValue, type ExecuteOptions } from './modules/operations/operations.js';
export { ExecutionsModule } from './modules/executions/executions.js';
export { isCompleted, isFinished, isPending, isRejected, type PollErrorListener, type WaitOptions } from './modules/executions/wait.js';
export {
  CustomersModule,
  type AccountOptions,
  type BlockOptions,
  type CustomerListOptions,
  type EntryListOptions,
  type MovementOptions,
  type PriceListOptions,
} from './modules/customers/customers.js';
export { webhooks, WebhooksModule, type VerifyOptions, type WebhookPayload, type WebhooksOptions } from './modules/webhooks/webhooks.js';
export { WEBHOOK_EVENT_TYPES } from './modules/webhooks/types.js';

export type * from './wire.js';
export type * from './modules/operations/types.js';
export type * from './modules/executions/types.js';
export type * from './modules/customers/types.js';
export type * from './modules/webhooks/types.js';

export {
  SPAN_ATTRIBUTE_NAMES,
  SPAN_FIELDS,
  SPAN_OPERATIONS,
  spanAttributes,
  type SlenSpan,
  type SpanAttributes,
  type SpanField,
  type SpanOperation,
  type SpanOutcome,
} from './observability/span.js';
export {
  LoggerSpanRecorder,
  MemorySpanRecorder,
  MultiSpanRecorder,
  NullSpanRecorder,
  type SpanLogger,
  type SpanRecorder,
} from './observability/recorder.js';
export { OtlpSpanRecorder, type OtlpExporterOptions } from './observability/otlp.js';
export { OtelSpanRecorder, otelSpanRecorder, type OtelSpanLike, type OtelTracerLike } from './observability/otel.js';

export { FakeFetch, type QueuedFrame, type QueuedResponse, type RecordedRequest } from './testing/index.js';
