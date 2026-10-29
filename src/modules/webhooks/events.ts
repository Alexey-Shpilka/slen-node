import type { WebhookEvent } from './types.js';

type Kind = 'string' | 'string?';

// The fields each typed event's `data` must have: `string?` may also be null.
const TYPED_DATA: Readonly<Record<string, Readonly<Record<string, Kind>>>> = Object.freeze({
  'execution.finished': { execution_id: 'string', flow_id: 'string', operation: 'string', status: 'string', error_code: 'string?' },
  'customer.balance_low': {
    customer_account_id: 'string',
    project_id: 'string',
    external_user_id: 'string',
    credit_type: 'string',
    balance: 'string',
    reserved: 'string',
    available: 'string',
    threshold: 'string',
  },
  'approval.requested': {
    approval_id: 'string',
    execution_id: 'string',
    flow_id: 'string',
    node_key: 'string',
    operation_code: 'string',
    note: 'string?',
    expires_at: 'string',
  },
  'approval.decided': {
    approval_id: 'string',
    execution_id: 'string',
    flow_id: 'string',
    node_key: 'string',
    operation_code: 'string',
    status: 'string',
    reason: 'string?',
    decided_by: 'string?',
    decided_by_user_id: 'string?',
    decided_at: 'string?',
  },
});

/** @internal */
export function eventOf(text: string): WebhookEvent | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isObject(parsed)) {
    return null;
  }

  const { id, type, created_at: createdAt } = parsed;
  const data = dataOf(parsed['data']);

  if (!isText(id) || !isText(type) || typeof createdAt !== 'string' || data === null) {
    return null;
  }

  const fields = Object.hasOwn(TYPED_DATA, type) ? TYPED_DATA[type] : undefined;

  if (fields !== undefined && !Object.entries(fields).every(([name, kind]) => fits(data[name], kind))) {
    return null;
  }

  return { id, type, created_at: createdAt, data } as WebhookEvent;
}

// The backend encodes an empty `data` as `[]`: that is an empty object, a list with items is not.
function dataOf(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return value.length === 0 ? {} : null;
  }

  return isObject(value) ? value : null;
}

function fits(value: unknown, kind: Kind): boolean {
  return typeof value === 'string' || (kind === 'string?' && value === null);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
