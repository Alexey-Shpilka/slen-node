// Harness: the package is compiled without @types/node, so the one Node global
// this example reads is described here. Not part of any region.
declare const process: { env: Record<string, string | undefined> };

// docs:start client
import { Slen } from '@slen/sdk';

const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? '' });
// docs:end

// docs:start create
// The external user id is your own opaque id of the customer — not an email address or a name.
const customer = await slen.customers.create('user_8421');

console.log(customer.external_user_id, customer.status);
// docs:end

// docs:start top-up
const account = await slen.customers.topUp('user_8421', '100.0000', { note: 'Invoice 7781', idempotencyKey: 'invoice-7781:topup' });

console.log(account.balance);
// docs:end

// docs:start read
const read = await slen.customers.get('user_8421');

for (const held of read.accounts) {
  console.log(held.credit_type, held.available);
}
// docs:end

// docs:start charge
// A service of your own application, paid for in the customer's credits.
const charged = await slen.customers.charge('user_8421', '5.0000', { note: 'PDF export', idempotencyKey: 'export-991:charge' });

console.log(charged.balance);
// docs:end

// docs:start statement
const statement = await slen.customers.entries('user_8421', { limit: 2 });

for (const entry of statement.data) {
  console.log(entry.entry_type, entry.credits, entry.note);
}
// docs:end

// docs:start refused
import { InsufficientCreditsError } from '@slen/sdk';

try {
  await slen.operations.execute(
    'generate_email',
    { messages: [{ role: 'user', content: 'Write a short follow-up email.' }] },
    { customer: 'user_9310', idempotencyKey: 'order-45:email' },
  );
} catch (error) {
  if (!(error instanceof InsufficientCreditsError)) {
    throw error;
  }

  // The customer's account cannot pay for the run: nothing ran, nothing was held.
  console.log(error.code);
}
// docs:end

// docs:start block
// New runs for the customer are refused from now on; the balance can still be settled.
const blocked = await slen.customers.block('user_8421', { reason: 'chargeback' });

console.log(blocked.status, blocked.block_reason);
// docs:end
