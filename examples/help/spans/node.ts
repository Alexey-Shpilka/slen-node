// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start recorder
import { LoggerSpanRecorder } from '@slen/sdk';

// Stands in for the logger of your application: it prints the fields this page talks about.
const logger = {
  info(message: string, attributes: Record<string, unknown>): void {
    const { operation, outcome, status, operation_code, execution_id, estimated } = attributes;

    console.log(
      `${message}: ${String(operation)} ${String(outcome)} ${String(status)} ${String(operation_code)} ${String(execution_id)} ${String(estimated)}`,
    );
  },
};

const recorder = new LoggerSpanRecorder(logger);
// docs:end

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '', spanRecorder: recorder });
// docs:end

// docs:start send
await slen.operations.execute(
  'generate_email',
  { messages: [{ role: 'user', content: 'Write a short follow-up email to Ada.' }] },
  { idempotencyKey: 'order-61:email' },
);
// docs:end
