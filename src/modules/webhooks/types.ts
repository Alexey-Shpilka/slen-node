import type { Credits, Id } from '../../wire.js';
import type { ExecutionStatus } from '../executions/types.js';

/** Every event an endpoint can subscribe to, as the backend names them. */
export const WEBHOOK_EVENT_TYPES = [
  'reservation.created',
  'reservation.captured',
  'reservation.released',
  'reservation.expired',
  'reservation.overrun',
  'budget.threshold_reached',
  'budget.exceeded',
  'operation.authorized',
  'operation.denied',
  'operation.started',
  'operation.completed',
  'operation.failed',
  'operation.uncertain',
  'flow.published',
  'flow.rolled_back',
  'connection.cooldown_started',
  'connection.health_changed',
  'approval.requested',
  'approval.decided',
  'execution.finished',
  'alert.opened',
  'alert.resolved',
  'overrun.decided',
  'customer.balance_low',
  'ledger.degraded',
  'ledger.restored',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** A flow run reached its final status. Sent once per run; a repeated delivery has the same envelope `id`. */
export interface ExecutionFinishedEventData {
  execution_id: Id;
  flow_id: Id;
  /** The operation the run was for. */
  operation: string;
  status: ExecutionStatus;
  /** Why it did not complete; null for a completed run. */
  error_code: string | null;
}

/** A movement took a customer's account below its `low_balance_threshold`. */
export interface CustomerBalanceLowEventData {
  customer_account_id: Id;
  project_id: Id;
  external_user_id: string;
  credit_type: string;
  balance: Credits;
  reserved: Credits;
  /** `balance - reserved` after the movement that crossed the threshold. */
  available: Credits;
  threshold: Credits;
}

/** A run parked at an approval node until somebody decides or the request expires. */
export interface ApprovalRequestedEventData {
  approval_id: Id;
  execution_id: Id;
  flow_id: Id;
  node_key: string;
  operation_code: string;
  note: string | null;
  expires_at: string;
}

/** An approval got its verdict; `expired` when nobody decided in time. */
export interface ApprovalDecidedEventData {
  approval_id: Id;
  execution_id: Id;
  flow_id: Id;
  node_key: string;
  operation_code: string;
  status: 'approved' | 'rejected' | 'expired';
  reason: string | null;
  /** The API key that decided; null for a person or an expiry. */
  decided_by: string | null;
  /** The person who decided; null for a key or an expiry. */
  decided_by_user_id: string | null;
  decided_at: string | null;
}

/** One delivery. `id` is the event's, the same on every delivery of it: deduplicate by it. */
export interface WebhookEventEnvelope<Type extends string, Data> {
  id: Id;
  type: Type;
  created_at: string;
  data: Data;
}

export type ExecutionFinishedEvent = WebhookEventEnvelope<'execution.finished', ExecutionFinishedEventData>;
export type CustomerBalanceLowEvent = WebhookEventEnvelope<'customer.balance_low', CustomerBalanceLowEventData>;
export type ApprovalRequestedEvent = WebhookEventEnvelope<'approval.requested', ApprovalRequestedEventData>;
export type ApprovalDecidedEvent = WebhookEventEnvelope<'approval.decided', ApprovalDecidedEventData>;

/** The events whose `data` the SDK types. */
export type TypedWebhookEventType = 'execution.finished' | 'customer.balance_low' | 'approval.requested' | 'approval.decided';

/** Any other event, with `data` as it came; an event added after this release arrives as one too. */
export type UnknownWebhookEvent = WebhookEventEnvelope<Exclude<WebhookEventType, TypedWebhookEventType>, Readonly<Record<string, unknown>>>;

/** A verified event; `event.type === 'execution.finished'` narrows `event.data`. */
export type WebhookEvent = ExecutionFinishedEvent | CustomerBalanceLowEvent | ApprovalRequestedEvent | ApprovalDecidedEvent | UnknownWebhookEvent;
