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
  { messages: [{ role: 'user', content: 'Write a short follow-up email to Ada.' }] },
  {
    customer: 'user_8421',
    context: { plan: 'pro' },
    idempotencyKey: 'order-57:email',
  },
);
// docs:end

// docs:start result
import { isCompleted, isPending, isRejected, type ExecutionResult } from '@slen/sdk';

function report(run: ExecutionResult): void {
  if (isCompleted(run)) {
    console.log(run.output?.content);
    return;
  }

  if (isRejected(run)) {
    console.log(`Refused: ${run.error_code} — ${run.error_message}`);
    return;
  }

  if (isPending(run)) {
    console.log(`Not over yet: ${run.status}. Read it again in ${run.retry_after_seconds} s.`);
    return;
  }

  console.log(`Did not complete: ${run.status}, ${run.error_code}`);
}

report(run);
// docs:end
