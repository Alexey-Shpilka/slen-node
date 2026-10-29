// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start submit
const queued = await slen.operations.executeAsync(
  'summarize_report',
  { messages: [{ role: 'user', content: 'Summarize the third-quarter report.' }] },
  { idempotencyKey: 'report-2026-q3:summary' },
);

console.log(queued.status);
// docs:end

// docs:start wait
// In a queue job or a script, not in an HTTP handler: the wait keeps the handler open.
const finished = await slen.executions.wait(queued.execution_id, {
  timeoutSeconds: 60,
  onPollError: (error, failuresInARow) => {
    console.log(`Status read failed (${failuresInARow} in a row): ${error.message}`);
  },
});
// docs:end

// docs:start result
import { isCompleted, isPending, type ExecutionStatusView } from '@slen/sdk';

function report(run: ExecutionStatusView): void {
  if (isCompleted(run)) {
    console.log(run.output?.content);
    return;
  }

  if (isPending(run)) {
    console.log(`Not over yet: ${run.status}`);
    return;
  }

  console.log(`Ended as ${run.status}: ${run.error_code}`);
}

report(finished);
// docs:end
