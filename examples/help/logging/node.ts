// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start logger
import type { SlenLogger } from '@slen/sdk';

// Stands in for the logger of your application (`console` fits as it is): it
// prints each event with the route and, for an answer, its status.
function writer(level: string) {
  return (event: string, context: Record<string, unknown> = {}): void => {
    const status = context['status'] === undefined ? '' : ` ${String(context['status'])}`;

    console.log(`${level} ${event} ${String(context['method'])} ${String(context['route'])}${status}`);
  };
}

const logger: SlenLogger = { debug: writer('debug'), info: writer('info'), warn: writer('warn'), error: writer('error') };
// docs:end

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '', logger });
// docs:end

// docs:start send
await slen.operations.execute(
  'generate_email',
  { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] },
  { idempotencyKey: 'order-77:email' },
);
// docs:end
