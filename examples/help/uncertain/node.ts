// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start call
import { OperationUncertainError } from '@slen/sdk';

const input = { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] };
const key = 'order-42:email';

try {
  const run = await slen.operations.execute('generate_email', input, { idempotencyKey: key });

  console.log(run.status);
} catch (error) {
  if (!(error instanceof OperationUncertainError)) {
    throw error;
  }

  // A provider was called and its answer was lost: the call may have been paid for.
  // Keep the key. Under a new one the same request may pay for the call a second time.
  console.log(`outcome unknown: ${error.code}`);
}
// docs:end

// docs:start repeat
// The same request under the same key runs nothing: it reads the execution the first one opened.
const again = await slen.operations.execute('generate_email', input, { idempotencyKey: key });

if (again.status === 'uncertain') {
  console.log(`${again.status}: ${again.error_code}`);
}
// docs:end
