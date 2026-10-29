import type { ApiRequest, HttpMethod } from './client.js';

/** @internal */
export const ENDPOINTS = {
  health: 'GET /health',
  execute: 'POST /v1/operations/execute',
  executionStatus: 'GET /v1/executions/{id}/status',
  executionTrace: 'GET /v1/executions/{id}',
  listCustomers: 'GET /v1/customers',
  getCustomer: 'GET /v1/customers/{externalUserId}',
  createCustomer: 'PUT /v1/customers/{externalUserId}',
  deleteCustomer: 'DELETE /v1/customers/{externalUserId}',
  updateAccount: 'PUT /v1/customers/{externalUserId}/accounts/{creditType}',
  block: 'POST /v1/customers/{externalUserId}/block',
  unblock: 'POST /v1/customers/{externalUserId}/unblock',
  topUp: 'POST /v1/customers/{externalUserId}/topup',
  charge: 'POST /v1/customers/{externalUserId}/charge',
  adjust: 'POST /v1/customers/{externalUserId}/adjust',
  entries: 'GET /v1/customers/{externalUserId}/entries',
  prices: 'GET /v1/credit-prices',
} as const satisfies Readonly<Record<string, `${HttpMethod} /${string}`>>;

/** @internal */
export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

/** @internal */
export function endpoint(operation: Endpoint): Pick<ApiRequest, 'method' | 'route'> {
  const space = operation.indexOf(' ');

  return { method: operation.slice(0, space) as HttpMethod, route: operation.slice(space + 1) };
}
