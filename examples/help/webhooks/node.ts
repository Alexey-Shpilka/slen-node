// docs:start request
// Stands in for the request Slen sends to your endpoint: its raw body and its
// Slen-Signature header, signed here with the secret of the example's endpoint.
const secret = 'whsec_example_endpoint';
const payload =
  '{"id":"74438200973594801","type":"execution.finished","created_at":"2026-10-17T12:00:00+00:00",' +
  '"data":{"execution_id":"74438200973594700","flow_id":"74438200973590001","operation":"generate_email","status":"completed","error_code":null}}';

async function hmacSha256(key: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmac, encoder.encode(text));

  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const timestamp = Math.floor(Date.now() / 1000);
const signature = `t=${timestamp},v1=${await hmacSha256(secret, `${timestamp}.${payload}`)}`;
// docs:end

// docs:start receive
import { webhooks } from '@slen/sdk';

// A receiver needs the secret of the endpoint, not an API key. Pass the body as it arrived.
const event = await webhooks.constructEvent(payload, signature, { secret });

if (event.type === 'execution.finished') {
  console.log(`${event.type}: ${event.data.execution_id} ${event.data.status}`);
}

if (event.type === 'customer.balance_low') {
  console.log(`${event.type}: ${event.data.external_user_id}`);
}
// docs:end

// docs:start refused
import { WebhookSignatureError } from '@slen/sdk';

try {
  await webhooks.constructEvent(payload.replace('completed', 'failed'), signature, { secret });
} catch (error) {
  if (!(error instanceof WebhookSignatureError)) {
    throw error;
  }

  // Not the body Slen signed: answer 400 and do nothing with it.
  console.log(`refused: ${error.reason}`);
}
// docs:end
