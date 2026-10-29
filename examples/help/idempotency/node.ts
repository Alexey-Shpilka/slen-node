// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start key
import { idempotencyKeyForJob } from '@slen/sdk';

// The id of the job of your own queue that sends this request.
const jobId = 'a1f7c2e9';
const key = idempotencyKeyForJob(jobId, 'generate_email');
// docs:end

// docs:start send
const input = { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] };

const run = await slen.operations.execute('generate_email', input, { idempotencyKey: key });

console.log(run.status);
// docs:end

// docs:start repeat
// The queue runs the same job again, so the key is the same.
const again = await slen.operations.execute('generate_email', input, { idempotencyKey: key });

if (again.replayed) {
  console.log(`Execution ${again.execution_id} ran once. This answer is a replay.`);
}
// docs:end

// docs:start conflict
import { IdempotencyConflictError } from '@slen/sdk';

try {
  await slen.operations.execute(
    'generate_email',
    { messages: [{ role: 'user', content: 'Write a short thank-you email.' }] },
    { idempotencyKey: key },
  );
} catch (error) {
  if (!(error instanceof IdempotencyConflictError)) {
    throw error;
  }

  console.log(`Refused: ${error.code}`);
}
// docs:end
