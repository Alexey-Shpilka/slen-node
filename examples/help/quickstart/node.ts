// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start send
const run = await slen.operations.execute(
  'generate_email',
  { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] },
  { idempotencyKey: 'order-42:email' },
);
// docs:end

// docs:start result
if (run.status === 'completed') {
  console.log(run.output?.content);
}
// docs:end
