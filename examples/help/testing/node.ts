// docs:start double
import { FakeFetch, Slen, type ExecutionResult } from '@slen/sdk';

const answer: ExecutionResult = {
  execution_id: '74438200973594700',
  status: 'completed',
  operation: 'generate_email',
  output: { content: 'Hi Ada, just checking in on the proposal I sent last week.' },
  error: null,
  error_code: null,
  error_message: null,
  cost: { estimated: '0.00412500', actual: null },
  cache: { hit: false, cached_at: null },
  replayed: false,
  waiting_on: null,
  trace_url: '/v1/executions/74438200973594700',
};

const http = new FakeFetch();
http.push({ status: 200, body: { data: answer } });
// docs:end

// docs:start client
const slen = new Slen({ apiKey: 'key-for-tests', fetch: http.fetch });
// docs:end

// docs:start call
const run = await slen.operations.execute(
  'generate_email',
  { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] },
  { idempotencyKey: 'order-42:email' },
);
// docs:end

// docs:start inspect
const sent = http.last();

console.log(run.status);
console.log(sent?.method, sent?.url);
console.log(sent?.headers['idempotency-key']);
console.log(sent?.body?.operation);
// docs:end

// Harness: what the example's own double recorded, for the test that runs this
// file. Not part of any region.
export const recorded = http.requests;
