import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Slen } from '../src/slen.js';
import { FakeFetch } from '../src/testing/index.js';

/**
 * The README is the first thing a caller runs, so what it shows has to be the
 * SDK as it is. Held here: every call the README makes on the client is a
 * method the client has; nothing the SDK took out is named at all; the status
 * of a run is listed whole, as `ExecutionStatus` declares it; and an input
 * written out for `operations.execute()` carries `messages` (a flow with a
 * model node reads the conversation from there, and refuses a run without it);
 * and no block of code branches with `else`: a reader copies early returns.
 *
 * The AGENTS.md of the package is held to the code by name as well: every
 * function either document names in its inline code is spelled somewhere in
 * the package.
 */

// The package has no `@types/node`; the members of `node:fs` used here are
// described structurally and loaded through a specifier the compiler does not
// try to resolve (as in `errors.test.ts`).
interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true; encoding: 'utf8' }): string[];
}

const NODE_FS: string = 'node:fs';
const { readFileSync, readdirSync } = (await import(NODE_FS)) as NodeFs;

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const AGENTS = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

/**
 * Names the SDK no longer has — a README that shows one sends its reader to a
 * call that is not there — and what it never shows: the address of the API,
 * and a key of the earlier prefix (keys are `sl_live_…`).
 */
const REMOVED: Readonly<Record<string, RegExp>> = {
  'the fixed-interval wait': /waitUntilFinished/,
  'the holds': /\bauthorizations\b|\breservations\b/,
  'the estimates': /costEstimates/,
  'the gateway calls': /\.run\(|\.stream\(|\bchat\.create|responses\.create|wrapOpenAI/,
  'the wait and the read of the old operations': /operations\.(?:wait|execution)\b/,
  "the address of the API, which is the SDK's constant": /base[_ ]?url/i,
  'a key of the earlier prefix': /\bsg_(?:live|test)_/,
};

/** The members of `ExecutionStatus` in `src/modules/executions/types.ts`, read with the compiler. */
function executionStatuses(): string[] {
  const file = ts.createSourceFile(
    'types.ts',
    readFileSync(new URL('../src/modules/executions/types.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const alias = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'ExecutionStatus',
  );

  if (alias === undefined || !ts.isUnionTypeNode(alias.type)) {
    throw new Error('src/modules/executions/types.ts declares no union `ExecutionStatus`.');
  }

  return alias.type.types.map((member) => {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      throw new Error('`ExecutionStatus` has a member that is not a string literal.');
    }

    return member.literal.text;
  });
}

describe('the README', () => {
  it('names nothing the SDK took out', () => {
    expect(Object.entries(REMOVED).filter(([, pattern]) => pattern.test(README)).map(([what]) => what)).toEqual([]);
  });

  it('calls on the client only what the client has', () => {
    const slen = new Slen({ apiKey: 'sl_live_readme', fetch: new FakeFetch().fetch }) as unknown as Record<string, unknown>;
    const calls = [...README.matchAll(/\bslen\.(\w+)(?:\.(\w+))?\(/g)];
    const missing = calls
      .filter(([, first = '', second]) => {
        const member = slen[first];

        if (second === undefined) {
          return typeof member !== 'function';
        }

        return typeof (member as Record<string, unknown> | undefined)?.[second] !== 'function';
      })
      .map(([call]) => call);

    // The README makes calls on the client throughout; finding hardly any
    // means the pattern no longer matches how it writes them.
    expect(calls.length).toBeGreaterThan(5);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('lists every status a run can have', () => {
    const line = README.match(/^run\.status;\s*\/\/\s*(.+)$/m);

    expect(line, 'the example of a run has a `run.status; // …` line').not.toBeNull();
    expect((line?.[1] ?? '').split('|').map((status) => status.trim()).sort()).toEqual(executionStatuses().sort());
  });

  it('branches in its code without else: a branch returns early', () => {
    const blocks = [...README.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map(([, code = '']) => code);

    // The README shows code throughout; finding hardly any means the pattern no longer matches its fences.
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks.flatMap((code) => code.split('\n')).filter((line) => /\belse\b/.test(line.replace(/\/\/.*$/, '')))).toEqual([]);
  });

  it('says which versions the package runs on, as package.json declares them', () => {
    const section = README.split(/^## /m).find((part) => part.startsWith('Compatibility\n')) ?? '';

    expect(section).not.toBe('');
    expect(section).toContain('20.3 and newer');
    expect(section).toContain('ESM and CommonJS');
  });

  it('tells a long-running server to share one client and put the logger of a request on a copy', () => {
    const section = README.split(/^## /m).find((part) => part.startsWith('Long-running servers')) ?? '';

    expect(section).not.toBe('');

    for (const said of ['withLogger(', 'executeAsync()', 'execution.finished', 'retries', 'One client per API key', 'FakeFetch']) {
      expect(section).toContain(said);
    }
  });

  it('runs a flow with an input that carries the conversation', () => {
    const inputs = [...README.matchAll(/operations\.execute(?:Async)?\(\s*'[^']*',\s*(\{[^}]*)/g)].map(([, input = '']) => input);

    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.filter((input) => !/\bmessages\b/.test(input))).toEqual([]);
  });
});

/** Where a function the docs of this package name has to be spelled. */
const SOURCES = ['../src/', '../test/', '../scripts/'] as const;

/** Every source file of the package, this one left out: it names no function of the docs. */
function sourceText(): string {
  return SOURCES.flatMap((directory) => {
    const base = new URL(directory, import.meta.url);

    return readdirSync(base, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.(?:ts|mts|mjs|js)$/.test(name) && !name.endsWith('readme.test.ts'))
      .map((name) => readFileSync(new URL(name, base), 'utf8'));
  }).join('\n');
}

/**
 * The functions a document names in its inline code: `name()`, `a.name(…)`.
 * A PHP name — `SlenSdk::create()`, `$slen->operations()` — is the PHP SDK's,
 * said for comparison, and is not looked for here.
 */
function functionsNamedIn(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].flatMap(([, code = '']) =>
    [...code.matchAll(/(?<![\w$]|::|->)([A-Za-z_]\w*)\s*\(/g)].map(([, name = '']) => name),
  );
}

describe('the docs of the package', () => {
  it('name no function the package does not have', () => {
    const source = sourceText();
    const named = new Set([...functionsNamedIn(AGENTS), ...functionsNamedIn(README)]);
    const missing = [...named].filter((name) => !new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(source));

    // Both documents name functions throughout; finding hardly any means the
    // pattern no longer matches how they write them.
    expect(named.size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
