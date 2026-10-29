// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start catch
import { OperationUncertainError, SlenError, SpendRefusedError } from '@slen/sdk';

const input = { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] };

function explain(error: SlenError): string {
  // The spend was refused, and the code says what refused it.
  if (error instanceof SpendRefusedError) {
    return `refused: ${error.code}`;
  }

  // A provider was called and its answer was lost: the call may have been paid for.
  if (error instanceof OperationUncertainError) {
    return `uncertain, request ${error.requestId}`;
  }

  return `${error.status} ${error.code}: ${error.message}`;
}

try {
  const run = await slen.operations.execute('generate_email', input, { idempotencyKey: 'order-42:email' });

  console.log(run.status);
} catch (error) {
  if (!(error instanceof SlenError)) {
    throw error;
  }

  console.log(explain(error));
}
// docs:end

// docs:start repeat
const again = await slen.operations.execute('generate_email', input, { idempotencyKey: 'order-42:email' });

if (again.status === 'rejected') {
  console.log(`rejected: ${again.error_code}`);
}
// docs:end
