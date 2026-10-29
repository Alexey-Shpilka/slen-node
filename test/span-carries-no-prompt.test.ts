import { describe, expect, it } from 'vitest';
import { MemorySpanRecorder } from '../src/observability/recorder.js';
import { SpanScope } from '../src/observability/scope.js';
import {
  SPAN_ATTRIBUTE_NAMES,
  SPAN_FIELDS,
  SPAN_OPERATIONS,
  spanAttributes,
  type SlenSpan,
} from '../src/observability/span.js';
import { CONTRACT as CONTRACT_DIRECTORY } from './paths.js';

/**
 * The guarantee: a span carries money, ids and a verdict — never a prompt. It is the shape of the
 * type, not a filter, and these tests fail the moment the type grows a field that could hold what
 * was said to a model.
 *
 * The table is `contract/span-attributes.json`, the copy of the contract the PHP SDK reads
 * too: a change of the contract comes with both span types.
 */
interface SpanContract {
  fields: Array<{ field: string; attribute: string; nullable: boolean }>;
  outcomes: Record<string, string>;
  operations: Record<string, { sdks: string[] }>;
}

interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const { readFileSync } = (await import(NODE_FS)) as NodeFs;

const FILE = readJson(new URL('span-attributes.json', CONTRACT_DIRECTORY));
const CONTRACT = {
  fields: FILE.fields,
  outcomes: Object.keys(FILE.outcomes),
  operations: Object.entries(FILE.operations)
    .filter(([, entry]) => entry.sdks.includes('typescript'))
    .map(([name]) => name),
};

function readJson(file: URL): SpanContract & Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SpanContract & Record<string, unknown>;
  } catch (cause) {
    throw new Error('contract/span-attributes.json could not be read where test/paths.ts says it is.', { cause });
  }
}

const SECRET_PROMPT = 'my secret system prompt: the launch is on the 14th';

// Anything that could name a place to stash message content.
const FORBIDDEN = /prompt|message|content|completion|text|input|output|body|payload|argument|choice|instruction|answer/i;

function span(fields: Partial<SlenSpan> = {}): SlenSpan {
  return {
    operation: 'operations.execute',
    outcome: 'ok',
    status: 'completed',
    durationMs: 12,
    executionId: '74438200973594700',
    operationCode: 'support.reply',
    estimated: '0.02700000',
    actual: null,
    errorCode: null,
    cacheHit: false,
    ...fields,
  };
}

describe('a span cannot carry a prompt', () => {
  it('has exactly the ten fields of the contract, in its order', () => {
    expect([...SPAN_FIELDS]).toEqual(CONTRACT.fields.map((entry) => entry.field));
    expect(SPAN_FIELDS).toHaveLength(10);
  });

  it('names every attribute as the contract names it', () => {
    expect({ ...SPAN_ATTRIBUTE_NAMES }).toEqual(Object.fromEntries(CONTRACT.fields.map((entry) => [entry.field, entry.attribute])));
  });

  it('types as nullable exactly the fields the contract lets be empty', () => {
    const empty: SlenSpan = {
      operation: 'executions.wait',
      outcome: 'error',
      status: null,
      durationMs: 0,
      executionId: null,
      operationCode: null,
      estimated: null,
      actual: null,
      errorCode: null,
      cacheHit: null,
    };
    const nullable = Object.entries(empty)
      .filter(([, value]) => value === null)
      .map(([field]) => field);

    expect(nullable).toEqual(CONTRACT.fields.filter((entry) => entry.nullable).map((entry) => entry.field));
  });

  it('has no field whose name could hold model input or output', () => {
    for (const field of SPAN_FIELDS) {
      expect(field, `span field "${field}"`).not.toMatch(FORBIDDEN);
      expect(SPAN_ATTRIBUTE_NAMES[field], `attribute "${SPAN_ATTRIBUTE_NAMES[field]}"`).not.toMatch(FORBIDDEN);
    }
  });

  it('writes no outcome outside the vocabulary of the contract', () => {
    const outcomes: Record<SlenSpan['outcome'], true> = { ok: true, refused: true, error: true };

    expect(Object.keys(outcomes)).toEqual([...CONTRACT.outcomes]);
  });

  it('is written under the three names of the contract and no other', () => {
    expect([...SPAN_OPERATIONS]).toEqual([...CONTRACT.operations]);
  });

  it('reads a contract with nothing of the gateway left in it', () => {
    expect(Object.keys(FILE).sort()).toEqual(['description', 'fields', 'operations', 'outcomes']);
    expect(Object.keys(FILE.operations).sort()).toEqual([...SPAN_OPERATIONS].sort());
  });

  it('does not type-check with a field that holds messages', () => {
    const leaky: SlenSpan = {
      ...span(),
      // @ts-expect-error — the assertion is the test: widen SlenSpan and this line stops being an error.
      messages: [{ role: 'user', content: SECRET_PROMPT }],
    };

    expect(Object.keys(leaky)).toContain('operation');
  });

  it('leaks nothing from a run whose output is the answer to the prompt', () => {
    const recorder = new MemorySpanRecorder();
    const run = {
      execution_id: '74438200973594700',
      status: 'completed',
      operation: 'support.reply',
      output: { content: `You asked: ${SECRET_PROMPT}` },
      error: null,
      error_code: null,
      error_message: SECRET_PROMPT,
      cost: { estimated: '0.00412500', actual: null },
      cache: { hit: false, cached_at: null },
    };

    new SpanScope(recorder, { operation: 'operations.execute', operationCode: 'support.reply' }).execution(run);

    expect(Object.keys(recorder.last() as object)).toEqual([...SPAN_FIELDS]);
    expect(JSON.stringify(recorder.spans)).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(spanAttributes(recorder.last() as SlenSpan))).not.toContain(SECRET_PROMPT);
  });

  it('drops nulls from the attributes and keeps every value it carries, false included', () => {
    expect(spanAttributes(span({ status: null, executionId: null, cacheHit: null }))).toEqual({
      operation: 'operations.execute',
      outcome: 'ok',
      duration_ms: 12,
      operation_code: 'support.reply',
      estimated: '0.02700000',
    });
    expect(spanAttributes(span())).toMatchObject({ status: 'completed', execution_id: '74438200973594700', cache_hit: false });
  });
});
