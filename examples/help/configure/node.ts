// docs:start client
import { Slen } from '@slen/sdk';

// Stands in for the logger of your application: this one prints what went wrong.
const logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (event: string): void => console.log(`warn ${event}`),
  error: (event: string): void => console.log(`error ${event}`),
};

// No apiKey: the SDK reads SLEN_API_KEY.
const slen = new Slen({ timeoutMs: 120_000, retries: 3, logger });
// docs:end

// docs:start call
const run = await slen.operations.execute(
  'generate_email',
  { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] },
  { idempotencyKey: 'order-42:email' },
);

console.log(run.status);
// docs:end
