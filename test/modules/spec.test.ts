import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SIGNATURE_HEADER } from '../../src/modules/webhooks/signature.js';
import { WEBHOOK_EVENT_TYPES } from '../../src/modules/webhooks/types.js';

/**
 * The webhooks of the SDK against `webhooks:` of the API's OpenAPI spec (the file `SLEN_OPENAPI_SPEC`
 * names; skipped without it): the names, the
 * envelope, and which events have typed `data`. The calls and the shapes of `data` are held by
 * `../contract.test.ts` (`CALLS`, `SHAPES`).
 */

interface NodeFs {
  existsSync(path: string | URL): boolean;
  readFileSync(path: string | URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

interface Schema {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  allOf?: Schema[];
}

interface Operation {
  parameters?: Array<{ $ref?: string; name?: string }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
}

interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
  webhooks?: Record<string, { post?: Operation }>;
  components: { schemas: Record<string, Schema>; parameters?: Record<string, { name?: string; in?: string }> };
}

function loadSpec(): OpenApi | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const named = env?.['SLEN_OPENAPI_SPEC'];

  if (named === undefined || named === '') {
    return null;
  }

  return fs.existsSync(named) ? (parse(fs.readFileSync(named, 'utf8')) as OpenApi) : null;
}

const SPEC = loadSpec();

const REFERENCE = '#/components/schemas/';

function component(schema: Schema | undefined): Schema {
  const name = schema?.$ref?.replace(REFERENCE, '');
  const found = name === undefined ? schema : SPEC?.components.schemas[name];

  if (found === undefined) {
    throw new Error(`The spec has no schema ${String(schema?.$ref)}.`);
  }

  return found;
}

/** The properties and the required names of an object schema, through `allOf`. */
function flatten(schema: Schema): { properties: Set<string>; required: Set<string> } {
  const resolved = component(schema);
  const parts = resolved.allOf === undefined ? [resolved] : resolved.allOf.map((part) => component(part));
  const properties = new Set<string>();
  const required = new Set<string>();

  for (const part of parts) {
    for (const name of Object.keys(part.properties ?? {})) {
      properties.add(name);
    }

    for (const name of part.required ?? []) {
      required.add(name);
    }
  }

  return { properties, required };
}

/** The events whose `data` the SDK types, and the interface it types each with. */
const TYPED_EVENTS: Record<string, string> = {
  'execution.finished': 'ExecutionFinishedEventData',
  'customer.balance_low': 'CustomerBalanceLowEventData',
  'approval.requested': 'ApprovalRequestedEventData',
  'approval.decided': 'ApprovalDecidedEventData',
};

describe.skipIf(SPEC === null)('the webhooks of the SDK against webhooks: of the spec', () => {
  const described = SPEC?.webhooks ?? {};

  it('know every event the spec describes, and no other', () => {
    expect(Object.keys(described).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
    expect([...(component({ $ref: `${REFERENCE}WebhookEventType` }).enum ?? [])].sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
  });

  it('read the envelope the spec requires', () => {
    expect(flatten({ $ref: `${REFERENCE}WebhookEnvelope` }).required).toEqual(new Set(['id', 'type', 'created_at', 'data']));
  });

  it.each(WEBHOOK_EVENT_TYPES.map((type) => [type]))('%s: its type, its signature header, and data typed exactly when the spec closes it', (type) => {
    const post = described[type]?.post;
    const schema = post?.requestBody?.content?.['application/json']?.schema;
    const [envelope, own] = schema?.allOf ?? [];
    const header = (post?.parameters ?? []).map((parameter) => SPEC?.components.parameters?.[parameter.$ref?.split('/').pop() ?? '']);

    expect(envelope?.$ref).toBe(`${REFERENCE}WebhookEnvelope`);
    expect(own?.properties?.['type']?.const).toBe(type);
    expect(own?.properties?.['data']?.$ref?.replace(REFERENCE, '')).toBe(TYPED_EVENTS[type]);
    expect(header).toEqual([{ ...header[0], name: SIGNATURE_HEADER, in: 'header' }]);
  });
});
