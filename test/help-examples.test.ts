import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { FakeFetch, type RecordedRequest } from '../src/testing/index.js';
import { EXAMPLES as EXAMPLE_ROOT } from './paths.js';

/**
 * The examples of the console's help section — `examples/help/<id>/` — run
 * as they are written.
 *
 * An article never carries SDK code of its own: it points at a region of an
 * example, and this suite (with `tests/HelpExamplesTest.php` of the PHP SDK
 * for its files) is what makes that code true. Each `node.ts` is imported once, with
 * `globalThis.fetch` replaced by a `FakeFetch` that answers from the example's
 * `example.json`; what it put on the wire and what it printed are then held
 * against `expect.json`. One call more, one call less, another key, another
 * body — each is red.
 *
 * The checks that only read files are made here for the files of this
 * package — each `node.ts` (its regions, what a region may not show, what it
 * may not lean on) — and for the JSON of every example in the tree (layout,
 * `responses`, the estimate an execution refused by a budget keeps, the
 * framework a Python-only example runs in). The PHP and Python suites make the
 * same checks for their `php.php` and `python.py`; the checks across languages
 * (the same regions in each, `languages` = the files, one `expect.json`) are
 * `scripts/check-examples.mjs` of the SDK's source repository. With the API's
 * OpenAPI spec at hand — the file `SLEN_OPENAPI_SPEC` names — every answer an
 * example is served and every body it is expected to send is also held
 * against the schema of its operation.
 *
 * An example imports the package the way a consumer does, `from '@slen/sdk'`;
 * `vitest.config.cjs` and `tsconfig.json` both point that name at `src/`.
 *
 * The rules an example follows are in `AGENTS.md` ("Help examples").
 */

// ---------------------------------------------------------------------------
// The files. The package has no `@types/node`: the members of `node:fs` used
// here are described structurally and the module is loaded through a specifier
// the compiler does not try to resolve (as in `contract.test.ts`).

interface NodeFs {
  existsSync(path: string | URL): boolean;
  readFileSync(path: string | URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

const EXAMPLES = new URL('help/', EXAMPLE_ROOT);

/** What every example is written against, so that none of them leans on a default. */
const BASE_URL = 'https://api.slen.ai';
const KEY_VARIABLE = 'SLEN_API_KEY';
const KEY = 'sl_live_help_example';

type Language = 'node' | 'php' | 'python';

/** The file of each language an example is written in; this package runs `node.ts`. */
const FILES: Record<Language, string> = { node: 'node.ts', php: 'php.php', python: 'python.py' };

/**
 * One request the test client of a Python framework sends to the
 * application of a `framework` example, and what the application answers it
 * with — see `frameworkProblems`.
 */
interface FrameworkRequest {
  method: string;
  /** The path of the example's own application. */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  status: number;
  /** The JSON body of the application's answer, compared whole when given. */
  answer?: unknown;
}

const FRAMEWORK_KEYS: readonly string[] = ['name', 'requests'];

const FRAMEWORK_REQUEST_KEYS: readonly string[] = ['method', 'path', 'headers', 'body', 'status', 'answer'];

/**
 * What is wrong with the `framework` of an `example.json`, in words: an
 * example that is an application of a Python framework (`fastapi`, `django`)
 * names it and the requests its test client sends, in order — and only an
 * example written for Python alone does. The Python suite runs it; here only
 * its shape is held, as the canon's `check-examples.mjs` holds where it may be.
 */
function frameworkProblems(framework: unknown, languages: readonly string[]): string[] {
  if (framework === undefined) {
    return [];
  }

  const alone = languages.length === 1 && languages[0] === 'python' ? [] : ['"framework" is on an example written for Python alone'];

  if (kindOf(framework) !== 'object') {
    return [...alone, '"framework" is an object: { name, requests }'];
  }

  const held = framework as Record<string, unknown>;
  const name = held['name'];
  const requests = held['requests'];
  const found = [
    ...alone,
    ...Object.keys(held)
      .filter((key) => !FRAMEWORK_KEYS.includes(key))
      .map((key) => `"framework" carries "${key}": it is a name and the requests of the test client`),
  ];

  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    found.push('"framework" needs a "name", the framework in lower case');
  }

  if (!Array.isArray(requests) || requests.length === 0) {
    return [...found, '"framework" needs "requests", the requests its test client sends'];
  }

  return [...found, ...requests.flatMap((request, index) => frameworkRequestProblems(request, `request #${index + 1}`))];
}

function frameworkRequestProblems(request: unknown, at: string): string[] {
  if (kindOf(request) !== 'object') {
    return [`${at} is not an object`];
  }

  const held = request as Record<string, unknown>;
  const status = held['status'];
  const found = Object.keys(held)
    .filter((key) => !FRAMEWORK_REQUEST_KEYS.includes(key))
    .map((key) => `${at} carries "${key}": a request is ${FRAMEWORK_REQUEST_KEYS.join(', ')}`);

  if (typeof held['method'] !== 'string' || !/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(held['method'])) {
    found.push(`${at} needs a "method"`);
  }

  if (typeof held['path'] !== 'string' || !held['path'].startsWith('/')) {
    found.push(`${at} needs a "path" of the application, from its root`);
  }

  if (held['headers'] !== undefined && (kindOf(held['headers']) !== 'object' || Object.values(held['headers'] as object).some((value) => typeof value !== 'string'))) {
    found.push(`${at}: "headers" are names and the strings they are sent with`);
  }

  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    found.push(`${at} needs the "status" the application answers with`);
  }

  return found;
}

/** One answer of the wire: a status and a JSON body, and nothing else — see `answerProblems`. */
interface Answer {
  status: number;
  body?: unknown;
}

const ANSWER_KEYS: readonly string[] = ['status', 'body'];

/**
 * What is wrong with the `responses` of an `example.json`, in words.
 *
 * An answer is a status and a JSON object (`body`), which both suites serve.
 * The doubles could do more (`FakeFetch` answers with headers and a body paced
 * in `frames`), but neither suite passes it on, so any other key would be
 * dropped without a word. It is refused instead: an example that needs more
 * needs the format widened first (`AGENTS.md`, "Help examples"), not a way around
 * the harness.
 */
function answerProblems(answers: readonly unknown[]): string[] {
  return answers.flatMap((answer, index) => {
    const at = `answer #${index + 1}`;

    if (kindOf(answer) !== 'object') {
      return [`${at} is not an object`];
    }

    const held = answer as Record<string, unknown>;
    const status = held['status'];
    const found = Object.keys(held)
      .filter((key) => !ANSWER_KEYS.includes(key))
      .map((key) => `${at} carries "${key}": the harness serves a status and a JSON body, nothing else`);

    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
      found.push(`${at} needs a "status" the wire can answer with`);
    }

    if (kindOf(held['body']) !== 'object') {
      found.push(`${at} needs a "body" that is a JSON object, as the backend sends it`);
    }

    return found;
  });
}

/** The codes a budget refuses a hold with (`BudgetExceededException::getErrorCode` in the backend). */
const BUDGET_REFUSAL_CODES: readonly string[] = ['budget_exceeded', 'operation_limit_exceeded', 'concurrency_limit_exceeded'];

/** The budget's own message for that refusal, `Budget <id> (<type>) exceeded` (`BudgetExceededException`). */
const BUDGET_REFUSAL_MESSAGE = /^Budget \S+ \([a-z_]+\) exceeded$/;

/**
 * What is wrong with an execution the `responses` of an `example.json` show
 * refused by a budget, in words. The spec holds the shape of an answer and not
 * its values, so this one value is held by its rule instead: an execution a
 * budget refused on the hold of a model call keeps the estimate of the refused
 * call in `cost.estimated` — the backend refuses with it and closes the
 * execution with it. An example once showed `null` there, and both suites
 * were green.
 *
 * Such a refusal is told by its code and by the budget's own message: a
 * `reject` node may end an execution with the same code and a message of its
 * own, and that execution has no estimate. An execution is read from `data`
 * of the body, or from each item of `data` when it is a list; its code and
 * message from `error_code` / `error_message`, else from `error`.
 */
function refusalProblems(answers: readonly unknown[]): string[] {
  return answers.flatMap((answer, index) => {
    const body = kindOf(answer) === 'object' ? (answer as Record<string, unknown>)['body'] : undefined;
    const data = kindOf(body) === 'object' ? (body as Record<string, unknown>)['data'] : undefined;
    const listed = Array.isArray(data);

    return (listed ? data : [data]).flatMap((execution: unknown, item: number) => {
      if (kindOf(execution) !== 'object') {
        return [];
      }

      const held = execution as Record<string, unknown>;
      const error = kindOf(held['error']) === 'object' ? (held['error'] as Record<string, unknown>) : {};
      const cost = kindOf(held['cost']) === 'object' ? (held['cost'] as Record<string, unknown>) : {};
      const code = held['error_code'] ?? error['code'];
      const message = held['error_message'] ?? error['message'];
      const estimated = cost['estimated'];
      const refusedByABudget =
        held['status'] === 'rejected' &&
        typeof code === 'string' &&
        BUDGET_REFUSAL_CODES.includes(code) &&
        typeof message === 'string' &&
        BUDGET_REFUSAL_MESSAGE.test(message);

      if (!refusedByABudget || (typeof estimated === 'string' && estimated !== '')) {
        return [];
      }

      const at = listed ? `answer #${index + 1}, item #${item + 1},` : `answer #${index + 1}`;
      const found = estimated === undefined ? 'missing' : JSON.stringify(estimated);

      return [
        `${at} is an execution a budget refused (${code as string}), and its cost.estimated is ${found}: it keeps the estimate of the refused call`,
      ];
    });
  });
}

/** `example.json` — what the example is, and what the wire answers it with. */
interface Example {
  id: string;
  status: 'ready' | 'draft';
  summary: string;
  languages: Language[];
  /**
   * Runs inside a Laravel application (the PHP SDK's `HelpExamplesTest`): the
   * SDK comes from the container or the `Slen` facade. PHP alone — Node.js has
   * no such thing.
   */
  laravel?: boolean;
  /**
   * An application of a Python framework (the Python SDK's
   * `test_help_examples.py`): its test client sends `requests`, the SDK inside
   * answers from `responses`. Python alone.
   */
  framework?: { name: string; requests: FrameworkRequest[] };
  regions: string[];
  responses: Answer[];
}

interface ExpectedCall {
  method: string;
  /** As the spec writes it, without the `/api` the backend mounts everything under. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** `expect.json` — what running the example has to amount to, in either language. */
interface Expectations {
  calls: ExpectedCall[];
  prints: string[];
}

function environment(): Record<string, string | undefined> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

  if (env === undefined) {
    throw new Error('The examples are run on Node: there is no process.env here.');
  }

  return env;
}

function ids(): string[] {
  try {
    return fs
      .readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new Error('examples/help could not be read where test/paths.ts says it is.', {
      cause,
    });
  }
}

function fileOf(id: string, name: string): URL {
  return new URL(`${id}/${name}`, EXAMPLES);
}

function readJson<T>(id: string, name: string): T {
  return JSON.parse(fs.readFileSync(fileOf(id, name), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Regions: the pieces of an example an article shows.

const REGION_START = /^\s*\/\/ docs:start ([a-z][a-z0-9-]*)$/;
const REGION_END = /^\s*\/\/ docs:end$/;
const REGION_MARKER = /docs:(?:start|end)/;

/**
 * The regions of a source file, in the order they appear: the lines between
 * `// docs:start <name>` and `// docs:end`. Throws on anything a reader of the
 * markers could take two ways — a marker that is not a line of its own, a
 * region opened inside another, one that is never closed, a name used twice,
 * a region with nothing in it.
 */
function regionsOf(source: string): Map<string, string> {
  return partsOf(source).regions;
}

/** A source file taken apart: its regions, and every line that is in none of them (the markers left out). */
interface Parts {
  regions: Map<string, string>;
  outside: string[];
}

function partsOf(source: string): Parts {
  const found = new Map<string, string>();
  const outside: string[] = [];
  let open: { name: string; lines: string[] } | null = null;

  for (const [index, line] of source.split('\n').entries()) {
    const at = `line ${index + 1}`;
    const started = REGION_START.exec(line)?.[1];

    if (started !== undefined) {
      if (open !== null) {
        throw new Error(`${at}: region "${started}" starts inside region "${open.name}".`);
      }

      if (found.has(started)) {
        throw new Error(`${at}: region "${started}" is there twice.`);
      }

      open = { name: started, lines: [] };
    } else if (REGION_END.test(line)) {
      if (open === null) {
        throw new Error(`${at}: a region ends that never started.`);
      }

      if (open.lines.every((kept) => kept.trim() === '')) {
        throw new Error(`${at}: region "${open.name}" is empty.`);
      }

      found.set(open.name, open.lines.join('\n'));
      open = null;
    } else if (REGION_MARKER.test(line)) {
      throw new Error(`${at}: not a region marker — write "// docs:start <name>" or "// docs:end" on a line of its own.`);
    } else if (open !== null) {
      open.lines.push(line);
    } else {
      outside.push(line);
    }
  }

  if (open !== null) {
    throw new Error(`Region "${open.name}" is never closed.`);
  }

  return { regions: found, outside };
}

/**
 * What no region may show. Two kinds of thing. Names that are on their way out
 * of the SDKs or were never in them: an article that printed one would teach
 * it. (The same list for prose is the console's `retired-terms.yaml`.) And the
 * lines of the harness, which exist for the run and mean nothing to a reader:
 * a region is copied into an article as text, so one of them inside a region
 * is one of them on the page.
 */
const NOT_SHOWN: ReadonlyArray<[RegExp, string]> = [
  [/waitUntilFinished/, '`waitUntilFinished` is the pre-v7 wait — show `wait()`'],
  [/\bisAllowed\b/, '`isAllowed()` goes away with the `denied` status'],
  [/['"]denied['"]/, 'the `denied` status of a hold goes away'],
  [/sg_test_/, 'the test mode is not documented'],
  [/dry_run/, 'the test mode is not documented'],
  [/SlenClient/, 'there is no `SlenClient` in either SDK'],
  [/L[I]MLY_|SP[E]NDGUARD_/, 'the pre-rename environment names'],
  [/X-L[i]mly-|X-Sp[e]ndGuard-/i, 'the pre-rename header names'],
  [/first-request-1/, 'an idempotency key is derived from the unit of work, never a constant'],
  [/localhost/, 'an example names the production host, not the default of a development setup'],
  [/\$offline\b/, 'the `$offline` hand-over is a line of the harness — it stays outside every region'],
  [/\bHarness:/, 'a `// Harness:` comment marks a line the reader is not shown — it stays outside every region'],
  [
    /\bdeclare\s+(?:const|let|var|function|global|module|namespace)\b/,
    'an ambient `declare` is there for the compiler of this package — it stays outside every region',
  ],
  [/\$recorded\b|\bexport\b.*\brecorded\b/, '`recorded` is what an example hands to the harness — it stays outside every region'],
];

function notShown(region: string): string[] {
  return NOT_SHOWN.filter(([pattern]) => pattern.test(region)).map(([, why]) => why);
}

const HOLDS = 'the holds left the SDK: a flow holds and settles the money of its model calls';
const GATEWAY = 'the gateway is called from inside a flow only: run the operation with `operations.execute`';
const PHP_ENTRY = 'the PHP SDK is built with `SlenSdk::create(new SlenConfig(…))`';

/** What the SDK no longer has. */
const RETIRED: ReadonlyArray<[RegExp, string]> = [
  [/\bauthorizations\b/, HOLDS],
  [/reservations\(/, HOLDS],
  [/AuthorizeAiOperation/, HOLDS],
  [/costEstimates/, 'the estimates left the SDK'],
  [/\bchat\.|\bchat\(\)/, GATEWAY],
  [/\.run\(|\.stream\(/, GATEWAY],
  [/responses\.create/, GATEWAY],
  [/wrapOpenAI/, GATEWAY],
  [/\boperations\.wait\b|\boperations\.execution\b|operations\(\)->get\(/, 'a run is read through `executions`: `get`, `wait`, `trace`'],
  [/new Client\(|new Config\(/, PHP_ENTRY],
  [/defaultOperation/, 'the SDK has no default operation: every run names its own'],
  [/setLogger\(/, 'a logger of its own is a copy of the client: `withLogger()`'],
  [/Slen\\Sdk\\Shared\\/, 'the public PHP classes are not under `Shared`: `Slen\\Sdk\\SlenSdk`, `Slen\\Sdk\\Exceptions\\…`'],
  [
    /\b(?:CustomerListFilters|AccountSettings|EntryFilters|PriceFilters)\b/,
    'the options are named as the PHP classes: `CustomerListOptions`, `AccountOptions`, `EntryListOptions`, `PriceListOptions`',
  ],
];

function retired(region: string): string[] {
  return RETIRED.filter(([pattern]) => pattern.test(region)).map(([, why]) => why);
}

/**
 * What no file of an example names, in a region or out of one. The address of
 * the API is a constant of the SDK, settable for tests and a local stack only:
 * an example does not pass it, and does not say it leaves it out either. A key
 * is shown as `sl_live_…`; an earlier `sg_live_…` key still works, and is not
 * what a reader is taught.
 */
const NAMED_NOWHERE: ReadonlyArray<[RegExp, string]> = [
  [/base[_ ]?url/i, "the address of the API is the SDK's constant: no example passes it or mentions it"],
  [/\bsg_(?:live|test)_/, 'a key is shown as `sl_live_…`'],
];

function namedNowhere(text: string): string[] {
  return NAMED_NOWHERE.filter(([pattern]) => pattern.test(text)).map(([, why]) => why);
}

/**
 * The names one line brings in: a variable, a function, a class, what an
 * `import` names. One-line forms only, which is what a line of the harness is
 * — a destructuring or an import spread over several lines is not looked
 * into. An ambient `declare` brings in nothing: it describes what the
 * reader's runtime gives them anyway (`process`).
 */
function namesBroughtIn(line: string): string[] {
  if (/^\s*declare\b/.test(line)) {
    return [];
  }

  const imported = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s/.exec(line)?.[1] ?? '';
  const names: Array<string | undefined> = [
    /^\s*(?:export\s+)?(?:const|let|var|(?:async\s+)?function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1],
    ...imported
      .replace(/[{}]/g, '')
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).at(-1)),
  ];

  return names.filter((name): name is string => name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name));
}

/** Whether the text reads a name — as a name of its own, not as a part of a longer one or a member of something else. */
function reads(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(text);
}

/**
 * Where a region leans on a line the reader is not shown: it reads a name
 * that only a line outside every region brings in. An article shows regions
 * and nothing else, so such a region arrives on the page with a variable from
 * nowhere — or, when the hidden line is an SDK call, with a request the reader
 * never saw being made.
 *
 * A name a region brings in itself is the reader's, whatever a line of the
 * harness does to it afterwards.
 */
function hiddenReads(source: string): string[] {
  const { regions, outside } = partsOf(source);
  const broughtIn = (lines: readonly string[]): string[] => lines.flatMap((line) => namesBroughtIn(line));
  const shown = new Set(broughtIn([...regions.values()].flatMap((text) => text.split('\n'))));
  const hidden = [...new Set(broughtIn(outside))].filter((name) => !shown.has(name));

  return [...regions].flatMap(([region, text]) =>
    hidden
      .filter((name) => reads(text, name))
      .map((name) => `region "${region}" reads ${name}, which only a line outside the regions brings in`),
  );
}

// ---------------------------------------------------------------------------
// What was sent, against what was expected.

/** Stable text of a JSON value: the keys of every object in one order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).sort(([left], [right]) => (left < right ? -1 : 1)))
      : held,
  );
}

function wire(request: RecordedRequest): string {
  return `${request.method} ${request.url}`;
}

/**
 * Every way the requests differ from the expected calls, in words; empty when
 * they are the same. `authorization` is what every request has to carry — the
 * key the harness put in the environment — or null when the example was not
 * given one (it brought a double and a key of its own).
 *
 * The `Idempotency-Key` is compared both ways: a call that is expected to
 * carry one has to carry exactly that, and a call that is not may carry none.
 * A key the SDK generated is random, so it can be neither — which is the
 * point: an example shows its own key.
 */
function differences(
  expected: readonly ExpectedCall[],
  requests: readonly RecordedRequest[],
  authorization: string | null,
): string[] {
  const found: string[] = [];

  for (let index = 0; index < Math.max(expected.length, requests.length); index += 1) {
    const call = expected[index];
    const request = requests[index];
    const at = `call #${index + 1}`;

    if (call === undefined && request !== undefined) {
      found.push(`${at} was not expected: ${wire(request)}`);
    } else if (call !== undefined && request === undefined) {
      found.push(`${at} was never made: ${call.method} ${call.path}`);
    } else if (call !== undefined && request !== undefined) {
      found.push(...differencesOfOne(call, request, authorization).map((difference) => `${at} ${difference}`));
    }
  }

  return found;
}

function differencesOfOne(call: ExpectedCall, request: RecordedRequest, authorization: string | null): string[] {
  const found: string[] = [];
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  const headers: Record<string, string> = { ...(call.headers ?? {}) };

  url.searchParams.forEach((value, name) => {
    query[name] = value;
  });

  if (authorization !== null) {
    headers['Authorization'] ??= authorization;
  }

  if (request.method !== call.method || `${url.origin}${url.pathname}` !== `${BASE_URL}/api${call.path}`) {
    found.push(`is ${request.method} ${url.origin}${url.pathname}, expected ${call.method} ${BASE_URL}/api${call.path}`);
  }

  if (canonical(query) !== canonical(call.query ?? {})) {
    found.push(`has the query ${canonical(query)}, expected ${canonical(call.query ?? {})}`);
  }

  for (const [name, value] of Object.entries(headers)) {
    const sent = request.headers[name.toLowerCase()];

    if (sent !== value) {
      found.push(`sends ${name}: ${sent ?? '(nothing)'}, expected ${value}`);
    }
  }

  const expectsKey = Object.keys(headers).some((name) => name.toLowerCase() === 'idempotency-key');

  if (!expectsKey && request.headers['idempotency-key'] !== undefined) {
    found.push(`sends Idempotency-Key: ${request.headers['idempotency-key']}, and none was expected`);
  }

  if (canonical(request.body) !== canonical(call.body ?? null)) {
    found.push(`sends the body ${canonical(request.body)}, expected ${canonical(call.body ?? null)}`);
  }

  return found;
}

// ---------------------------------------------------------------------------
// Running one.

interface Outcome {
  /** What the harness's own `fetch` was asked for. */
  wire: RecordedRequest[];
  /** What the example's own double recorded, when it brought one and handed it over as `recorded`. */
  handed: RecordedRequest[] | null;
  /** Every line the example wrote with `console.log`. */
  printed: string[];
}

const realSetTimeout = globalThis.setTimeout;

/** When an example is given up on. */
interface Limits {
  /** How far its own clock may run. */
  clockMs: number;
  /** How long the run may take for real. */
  realMs: number;
}

/**
 * The real limit is generous on purpose. Nothing an example does takes real
 * time — its pauses are on the moved clock — so what the limit measures is the
 * machine: the first import of `src/` alone is about half a second on an idle
 * one. Reaching it has to mean "stuck", not "busy".
 */
const LIMITS: Limits = { clockMs: 600_000, realMs: 20_000 };
/** Vitest's own limit for a test that runs an example: above the real one, so the words below are what is reported. */
const RUN_TIMEOUT_MS = LIMITS.realMs + 10_000;
/**
 * One step of the example's clock. Small on purpose: the transport's own
 * timer for an attempt (30 s by default) runs on the same clock. An answer
 * from the double is read within a few turns of the event loop, and it would
 * take 120 steps of this size, one per turn, to reach that timer.
 */
const STEP_MS = 250;

/**
 * Waits for the example while moving its clock: a `wait()` that would sleep
 * for a second sleeps for none. Time is moved one step per turn of the event
 * loop, and only while a timer is pending.
 *
 * Gives up in two ways and says which. An example whose own clock ran out
 * keeps sleeping: a wait or a retry its answers never end. One that used up
 * the real time either awaits something nobody answers or was run on a
 * machine too busy for it; the two cannot be told apart from here, so the
 * message says both and carries the facts that help — how far the clock got,
 * and whatever `seen` reports of the run so far.
 */
async function untilOver<T>(running: Promise<T>, limits: Limits = LIMITS, seen: () => string[] = () => []): Promise<T> {
  let over = false;
  const done = (): void => {
    over = true;
  };

  running.then(done, done);

  const started = performance.now();
  let moved = 0;

  while (!over) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 0);
    });

    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersByTimeAsync(STEP_MS);
      moved += STEP_MS;
    }

    if (moved > limits.clockMs) {
      throw new Error(
        `The example was not over after ${limits.clockMs / 1000} s of its own clock: it keeps sleeping — ` +
          'a wait or a retry that the answers of example.json never bring to an end.',
      );
    }

    if (performance.now() - started > limits.realMs) {
      const facts = [`its own clock moved ${moved} ms`, `${vi.getTimerCount()} of its timers pending`, ...seen()];

      throw new Error(
        `The example was not over after ${limits.realMs} ms of real time (${facts.join(', ')}). ` +
          'Nothing an example does takes real time, so either it awaits something the harness does not answer, ' +
          'or the machine was too busy to load and run it — run the suite again before changing the example.',
      );
    }
  }

  return running;
}

/**
 * Runs `node.ts` of one example. Once per example and no more: a module is
 * evaluated the first time it is imported, and a second import would answer
 * with the first run's exports and send nothing.
 */
async function run(id: string, answers: readonly Answer[]): Promise<Outcome> {
  const http = new FakeFetch();
  const printed: string[] = [];

  for (const answer of answers) {
    http.push({ status: answer.status, body: answer.body });
  }

  return inTheEnvironmentOfAnExample(async () => {
    vi.stubGlobal('fetch', http.fetch);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      printed.push(...parts.map(String).join(' ').split('\n'));
    });

    try {
      const seen = (): string[] => [`${http.requests.length} request(s) made`, `${printed.length} line(s) printed`];
      const loaded = (await untilOver(import(/* @vite-ignore */ fileOf(id, FILES.node).href), LIMITS, seen)) as {
        recorded?: unknown;
      };
      const handed = loaded.recorded;

      if (handed !== undefined && !Array.isArray(handed)) {
        throw new Error('`recorded` is what the example hands over of its own double: the list of its requests.');
      }

      return { wire: [...http.requests], handed: handed === undefined ? null : (handed as RecordedRequest[]), printed };
    } finally {
      log.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
}

/**
 * Runs something in the environment an example is given, and puts back what
 * was there: the harness's key in `SLEN_API_KEY`, where the client reads it
 * when it is given none. An example may not lean on a key the machine has set.
 */
async function inTheEnvironmentOfAnExample<T>(running: () => Promise<T>): Promise<T> {
  const env = environment();
  const given: Record<string, string | undefined> = { [KEY_VARIABLE]: KEY };
  const before = Object.fromEntries(Object.keys(given).map((name) => [name, env[name]]));
  const put = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  };

  put(given);

  try {
    return await running();
  } finally {
    put(before);
  }
}

// ---------------------------------------------------------------------------
// The spec, when there is one: the file `SLEN_OPENAPI_SPEC` names, as for `contract.test.ts`.

const SPEC_VARIABLE = 'SLEN_OPENAPI_SPEC';

interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
}

interface Content {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
}

interface Operation {
  requestBody?: Content;
  responses?: Record<string, Content>;
}

interface OpenApi {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema>; responses?: Record<string, Content> };
}

function locateSpec(): string | null {
  const named = environment()[SPEC_VARIABLE];

  if (named !== undefined && named !== '') {
    if (!fs.existsSync(named)) {
      throw new Error(`${SPEC_VARIABLE} names a file that is not there: ${named}`);
    }

    return named;
  }

  return null;
}

const SPEC_FILE = locateSpec();
const SPEC = SPEC_FILE === null ? null : (parse(fs.readFileSync(SPEC_FILE, 'utf8')) as OpenApi);

const SCHEMA_REFERENCE = '#/components/schemas/';
const RESPONSE_REFERENCE = '#/components/responses/';

/** The status any operation behind an API key can answer, whatever it declares: the key's rate limit. */
const RATE_LIMITED = 429;
const RATE_LIMITED_RESPONSE = 'TooManyRequests';

function resolved(spec: OpenApi, schema: Schema): Schema {
  if (schema.$ref === undefined) {
    return schema;
  }

  const target = schema.$ref.startsWith(SCHEMA_REFERENCE)
    ? spec.components.schemas[schema.$ref.slice(SCHEMA_REFERENCE.length)]
    : undefined;

  if (target === undefined) {
    throw new Error(`The spec refers to ${schema.$ref}, which it does not define.`);
  }

  // What is written beside a `$ref` (a description, mostly) says nothing about the shape.
  return resolved(spec, target);
}

function kindOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }

  return typeof value;
}

/** The keys a schema lists for its object: its own `properties` and those of every part of its `allOf`. */
function listed(spec: OpenApi, given: Schema): string[] {
  const schema = resolved(spec, given);

  return [...Object.keys(schema.properties ?? {}), ...(schema.allOf ?? []).flatMap((part) => listed(spec, part))];
}

/**
 * Where a JSON value is not what a schema of the spec describes, in words.
 * Covers what the spec uses to describe the answers and bodies of the calls
 * the SDKs make. Stricter than JSON Schema in one place, on purpose: a key the
 * schema does not list is reported unless the schema says its object is open
 * (`additionalProperties`) — an example that shows a field the contract does
 * not have is the mistake this is here to catch. An object written as `allOf`
 * is all of its parts together: a key one part lists is described for the
 * others too (`described`), and each part still holds what it says itself —
 * its required keys, the shape of its own properties.
 */
function violations(
  spec: OpenApi,
  value: unknown,
  given: Schema,
  at: string,
  described: ReadonlySet<string> = new Set(),
): string[] {
  const schema = resolved(spec, given);
  const found: string[] = [];
  const known = new Set([...described, ...listed(spec, schema)]);

  for (const part of schema.allOf ?? []) {
    // A key no part lists is unknown to each of them: said once.
    found.push(...violations(spec, value, part, at, known).filter((problem) => !found.includes(problem)));
  }

  const alternatives = schema.oneOf ?? schema.anyOf;

  if (alternatives !== undefined && !alternatives.some((option) => violations(spec, value, option, at).length === 0)) {
    found.push(`${at}: matches none of the alternatives the spec allows`);
  }

  const kind = kindOf(value);
  const allowed = schema.type === undefined ? null : [schema.type].flat();

  if (allowed !== null && !allowed.includes(kind) && !(kind === 'integer' && allowed.includes('number'))) {
    return [...found, `${at}: is ${kind}, the spec says ${allowed.join(' or ')}`];
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    found.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (schema.const !== undefined && schema.const !== value) {
    found.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    found.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    found.push(`${at}: ${value} is below the minimum of ${schema.minimum}`);
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      found.push(...violations(spec, item, schema.items, `${at}[${index}]`));
    }
  }

  if (kind === 'object') {
    const held = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const open = schema.additionalProperties !== undefined && schema.additionalProperties !== false;

    for (const name of schema.required ?? []) {
      if (!(name in held)) {
        found.push(`${at}.${name}: is required by the spec and missing`);
      }
    }

    for (const [name, item] of Object.entries(held)) {
      const property = properties[name];

      if (property !== undefined) {
        found.push(...violations(spec, item, property, `${at}.${name}`));
      } else if (typeof schema.additionalProperties === 'object') {
        found.push(...violations(spec, item, schema.additionalProperties, `${at}.${name}`));
      } else if (!open && schema.properties !== undefined && !known.has(name)) {
        found.push(`${at}.${name}: is not a field the spec describes`);
      }
    }
  }

  return found;
}

/** The operation a call is, by its method and path: the template with the fewest parameters that fits. */
function operationOf(spec: OpenApi, call: ExpectedCall): Operation {
  const fitting = Object.keys(spec.paths)
    .filter((template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(call.path))
    .sort((left, right) => left.split('{').length - right.split('{').length);
  const operation = fitting[0] === undefined ? undefined : spec.paths[fitting[0]]?.[call.method.toLowerCase()];

  if (operation === undefined) {
    throw new Error(`${call.method} ${call.path} is not an operation of the spec.`);
  }

  return operation as Operation;
}

function schemaOf(spec: OpenApi, content: Content | undefined): Schema | undefined {
  const followed =
    content?.$ref !== undefined && content.$ref.startsWith(RESPONSE_REFERENCE)
      ? spec.components.responses?.[content.$ref.slice(RESPONSE_REFERENCE.length)]
      : content;

  return followed?.content?.['application/json']?.schema;
}

/** The schema an operation answers a status with — or any operation, for the key's rate limit. */
function answerSchema(spec: OpenApi, operation: Operation, status: number): Schema | undefined {
  const declared = schemaOf(spec, operation.responses?.[String(status)]);

  if (declared !== undefined || status !== RATE_LIMITED) {
    return declared;
  }

  return schemaOf(spec, spec.components.responses?.[RATE_LIMITED_RESPONSE]);
}

// ---------------------------------------------------------------------------

describe('the help-example harness', () => {
  const call: ExpectedCall = {
    method: 'POST',
    path: '/v1/operations/execute',
    headers: { 'Idempotency-Key': 'order-42:email' },
    body: { operation: 'generate_email', input: { messages: [] } },
  };
  const request: RecordedRequest = {
    method: 'POST',
    url: `${BASE_URL}/api/v1/operations/execute`,
    headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'order-42:email' },
    body: { input: { messages: [] }, operation: 'generate_email' },
  };
  const read: RecordedRequest = {
    method: 'GET',
    url: `${BASE_URL}/api/v1/executions/7/status`,
    headers: { authorization: `Bearer ${KEY}` },
    body: null,
  };
  const bearer = `Bearer ${KEY}`;

  it('finds nothing to say about the calls that were expected', () => {
    expect(differences([call, { method: 'GET', path: '/v1/executions/7/status' }], [request, read], bearer)).toEqual([]);
  });

  it('reports a call more than expected', () => {
    expect(differences([call], [request, read], bearer)).toEqual([
      `call #2 was not expected: GET ${BASE_URL}/api/v1/executions/7/status`,
    ]);
  });

  it('reports a call less than expected', () => {
    expect(differences([call, { method: 'GET', path: '/v1/executions/7/status' }], [request], bearer)).toEqual([
      'call #2 was never made: GET /v1/executions/7/status',
    ]);
  });

  it('reports another method, host or path', () => {
    expect(differences([call], [{ ...request, url: 'http://localhost:8080/api/v1/operations/execute' }], bearer)).toEqual([
      `call #1 is POST http://localhost:8080/api/v1/operations/execute, expected POST ${BASE_URL}/api/v1/operations/execute`,
    ]);
    expect(differences([{ ...call, method: 'PUT' }], [request], bearer)).toHaveLength(1);
  });

  it('reports a key that is not the one the example shows — a generated one included', () => {
    const generated = { ...request, headers: { ...request.headers, 'idempotency-key': '0b0e6d5e-7d0b-4f8e-9d43-0a1f0c5f2f11' } };

    expect(differences([call], [generated], bearer)).toEqual([
      'call #1 sends Idempotency-Key: 0b0e6d5e-7d0b-4f8e-9d43-0a1f0c5f2f11, expected order-42:email',
    ]);
  });

  it('reports a key on a call that was expected to carry none', () => {
    expect(differences([{ method: call.method, path: call.path, body: call.body }], [request], bearer)).toEqual([
      'call #1 sends Idempotency-Key: order-42:email, and none was expected',
    ]);
  });

  it('reports a request that does not carry the key the example was given', () => {
    const other = { ...request, headers: { ...request.headers, authorization: 'Bearer ' } };

    expect(differences([call], [other], bearer)).toEqual([`call #1 sends Authorization: Bearer , expected ${bearer}`]);
    // An example that brought its own double chose its own key.
    expect(differences([call], [other], null)).toEqual([]);
  });

  it('reports another body, and a body where none was expected', () => {
    const more = { ...request, body: { ...request.body, context: { plan: 'premium' } } };

    expect(differences([call], [more], bearer)).toHaveLength(1);
    expect(differences([{ method: 'GET', path: '/v1/executions/7/status' }], [{ ...read, body: {} }], bearer)).toEqual([
      'call #1 sends the body {}, expected null',
    ]);
  });

  it('reports another query', () => {
    const listed = { ...read, url: `${BASE_URL}/api/v1/customers?limit=2` };

    expect(differences([{ method: 'GET', path: '/v1/customers', query: { limit: '2' } }], [listed], bearer)).toEqual([]);
    expect(differences([{ method: 'GET', path: '/v1/customers' }], [listed], bearer)).toEqual([
      'call #1 has the query {"limit":"2"}, expected {}',
    ]);
  });

  it('reads the regions of a file in order', () => {
    const source = ['hidden();', '// docs:start client', 'const a = 1;', '// docs:end', '    // docs:start send', '    go();', '    // docs:end'];

    expect([...regionsOf(source.join('\n'))]).toEqual([
      ['client', 'const a = 1;'],
      ['send', '    go();'],
    ]);
  });

  it.each([
    ['// docs:start a\n// docs:start b\nx\n// docs:end', 'starts inside'],
    ['// docs:start a\nx\n// docs:end\n// docs:start a\ny\n// docs:end', 'twice'],
    ['x\n// docs:end', 'never started'],
    ['// docs:start a\nx', 'never closed'],
    ['// docs:start a\n\n// docs:end', 'is empty'],
    ['// docs:start Client\nx\n// docs:end', 'not a region marker'],
    ['go(); // docs:end', 'not a region marker'],
  ])('refuses markers that can be read two ways: %j', (source, problem) => {
    expect(() => regionsOf(source)).toThrow(problem);
  });

  it('knows the names a region may not show', () => {
    expect(notShown("if ($authorization->status === 'denied') {")).toHaveLength(1);
    expect(notShown('await slen.operations.waitUntilFinished(id);')).toHaveLength(1);
    expect(notShown('} catch (error) { if (error instanceof PolicyDeniedError) {')).toEqual([]);
  });

  it.each([
    ['await slen.authorizations.create({ model });'],
    ['$client->reservations()->get($id);'],
    ['await slen.costEstimates.create(params);'],
    ['await slen.chat.create(params);'],
    ['$client->chat()->create($params);'],
    ['const stream = await slen.stream(params);'],
    ['await slen.responses.create(params);'],
    ['const openai = slen.wrapOpenAI(new OpenAI());'],
    ['await slen.operations.wait(id);'],
    ['$client->operations()->get($id);'],
    ['$client = new Client(new Config(apiKey: $key));'],
    ["const slen = new Slen({ apiKey, defaultOperation: 'x' });"],
    ['$slen->setLogger($logger);'],
    ['use Slen\\Sdk\\Shared\\SlenSdk;'],
    ['const filters: CustomerListFilters = { limit: 10 };'],
    ["await slen.customers.updateAccount(id, 'default', settings as AccountSettings);"],
    ["import type { EntryFilters, PriceFilters } from '@slen/sdk';"],
  ])('knows what the old SDK showed and the new one does not: %j', (line) => {
    expect(retired(line)).toHaveLength(1);
  });

  it('lets a region show the new SDK', () => {
    expect(retired('const finished = await slen.executions.wait(queued.execution_id);')).toEqual([]);
    expect(retired('$slen = SlenSdk::create(new SlenConfig(apiKey: $key));')).toEqual([]);
    expect(retired("await slen.operations.executeAsync('summarize_report', input);")).toEqual([]);
    expect(retired('$sdkOfThisRequest = $slen->withLogger($requestLogger);')).toEqual([]);
    expect(retired('use Slen\\Sdk\\Modules\\Customers\\Options\\MovementOptions;')).toEqual([]);
    expect(retired('const options: CustomerListOptions = { limit: 10 };')).toEqual([]);
  });

  it.each([
    ["const slen = new Slen({ apiKey, baseUrl: 'https://api.slen.ai' });"],
    ["$slen = SlenSdk::create(new SlenConfig(apiKey: $key, baseUrl: 'https://api.test'));"],
    ['// Without baseUrl the SDK calls the hosted API.'],
    ["config(['slen-sdk.base_url' => null]);"],
    ['SLEN_BASE_URL=https://api.test'],
    ['"summary": "A client with a base URL of its own."'],
    ["const slen = new Slen({ apiKey: 'sg_live_9f2c' });"],
    ['Authorization: Bearer sg_test_9f2c'],
  ])('knows what no file of an example names: %j', (line) => {
    expect(namedNowhere(line)).toHaveLength(1);
  });

  it('lets an example show a key of today and the URL a request went to', () => {
    expect(namedNowhere("const slen = new Slen({ apiKey: 'sl_live_9f2c' });")).toEqual([]);
    expect(namedNowhere('"POST https://api.slen.ai/api/v1/operations/execute"')).toEqual([]);
    expect(namedNowhere("'trace_url' => '/v1/executions/74438200973594700',")).toEqual([]);
  });

  it.each([
    ['// Harness: from here on the client answers from the test double.'],
    ['$client = $offline($client);'],
    ['declare const process: { env: Record<string, string | undefined> };'],
    ['export const recorded = http.requests;'],
    ['$recorded = $http->requests;'],
  ])('keeps a line of the harness out of a region: %j', (line) => {
    expect(notShown(`const before = 1;\n${line}\nconst after = 2;`)).toHaveLength(1);
  });

  it('lets a region show what only looks like a line of the harness', () => {
    // PHP's own `declare`, a double the example brought, a word of a comment.
    expect(notShown('declare(strict_types=1);')).toEqual([]);
    expect(notShown('$sent = $http->lastRequest();\nconsole.log(http.requests.length);')).toEqual([]);
    expect(notShown('// What the double recorded, offline.')).toEqual([]);
  });

  it('reports a region that reads what only a line outside the regions brings in', () => {
    const node = [
      'declare const process: { env: Record<string, string | undefined> };',
      "import { helper } from './helper.js';",
      '// docs:start reserve',
      "import { Slen } from '@slen/sdk';",
      'const slen = new Slen({ apiKey: process.env.SLEN_API_KEY ?? "" });',
      'const hold = await slen.authorizations.create({ model: "gpt-4o" });',
      '// docs:end',
      'const usage = { inputTokens: 1180 };',
      'const abandoned = await slen.authorizations.create({ model: "gpt-4o" });',
      '// docs:start capture',
      'await slen.authorizations.capture(hold.reservation_id, { inputTokens: usage.inputTokens });',
      '// docs:end',
      '// docs:start release',
      'helper(await slen.authorizations.release(abandoned.reservation_id));',
      '// docs:end',
    ];

    expect(hiddenReads(node.join('\n'))).toEqual([
      'region "capture" reads usage, which only a line outside the regions brings in',
      'region "release" reads helper, which only a line outside the regions brings in',
      'region "release" reads abandoned, which only a line outside the regions brings in',
    ]);
  });

  it('lets a region read what a region brings in, what the runtime gives, and a member that shares a hidden name', () => {
    const node = [
      'declare const process: { env: Record<string, string | undefined> };',
      'const usage = 1;',
      '// docs:start client',
      'const key = process.env.SLEN_API_KEY;',
      'console.log(key, run.usage, run.usageTotal);',
      '// docs:end',
      'export const recorded = [usage];',
    ];

    expect(hiddenReads(node.join('\n'))).toEqual([]);
  });

  it('serves a status and a JSON body, and refuses an answer that asks for more', () => {
    expect(answerProblems([{ status: 200, body: { data: {} } }, { status: 429, body: { error: {} } }])).toEqual([]);
    expect(answerProblems([{ status: 200, body: { data: {} }, headers: { 'Retry-After': '2' } }])).toEqual([
      'answer #1 carries "headers": the harness serves a status and a JSON body, nothing else',
    ]);
    expect(answerProblems([{ status: 200, text: 'data: [DONE]\n\n' }])).toEqual([
      'answer #1 carries "text": the harness serves a status and a JSON body, nothing else',
      'answer #1 needs a "body" that is a JSON object, as the backend sends it',
    ]);
    expect(answerProblems([{ body: [] }, 'ok'])).toEqual([
      'answer #1 needs a "status" the wire can answer with',
      'answer #1 needs a "body" that is a JSON object, as the backend sends it',
      'answer #2 is not an object',
    ]);
  });

  it('takes a framework only on an example written for Python alone, and only a name and the requests of its test client', () => {
    const asked = { method: 'POST', path: '/orders/42/email', headers: { 'X-Request-Id': 'req-1' }, status: 202, answer: { status: 'queued' } };

    expect(frameworkProblems(undefined, ['node', 'php', 'python'])).toEqual([]);
    expect(frameworkProblems({ name: 'fastapi', requests: [asked, { method: 'GET', path: '/runs/7', status: 200 }] }, ['python'])).toEqual([]);
    expect(frameworkProblems({ name: 'fastapi', requests: [asked] }, ['node', 'python'])).toEqual([
      '"framework" is on an example written for Python alone',
    ]);
    expect(frameworkProblems({ name: 'FastAPI', requests: [], app: 'main:app' }, ['python'])).toEqual([
      '"framework" carries "app": it is a name and the requests of the test client',
      '"framework" needs a "name", the framework in lower case',
      '"framework" needs "requests", the requests its test client sends',
    ]);
    expect(frameworkProblems({ name: 'django', requests: [{ method: 'FETCH', path: 'orders', headers: { 'X-Count': 1 }, status: 2020, json: {} }, 'GET /'] }, ['python'])).toEqual([
      'request #1 carries "json": a request is method, path, headers, body, status, answer',
      'request #1 needs a "method"',
      'request #1 needs a "path" of the application, from its root',
      'request #1: "headers" are names and the strings they are sent with',
      'request #1 needs the "status" the application answers with',
      'request #2 is not an object',
    ]);
    expect(frameworkProblems('fastapi', ['python'])).toEqual(['"framework" is an object: { name, requests }']);
  });

  it('holds the estimate of a call a budget refused by its rule, not by its value', () => {
    const refusal = { code: 'budget_exceeded', message: 'Budget 74438200973595137 (monthly) exceeded' };
    const rejected = (estimated: unknown, more: Record<string, unknown> = {}): Record<string, unknown> => ({
      execution_id: '74438200973594900',
      status: 'rejected',
      error: refusal,
      error_code: refusal.code,
      error_message: refusal.message,
      cost: { estimated, actual: null },
      ...more,
    });
    const said = (at: string, code: string, found: string): string =>
      `${at} is an execution a budget refused (${code}), and its cost.estimated is ${found}: it keeps the estimate of the refused call`;

    // The two forms of the example `errors`: the error, then the execution a repeat reads.
    expect(refusalProblems([{ status: 402, body: { error: refusal } }, { status: 200, body: { data: rejected('0.00061560') } }])).toEqual([]);
    expect(refusalProblems([{ status: 402, body: { error: refusal } }, { status: 200, body: { data: rejected(null) } }])).toEqual([
      said('answer #2', 'budget_exceeded', 'null'),
    ]);
    // Every code a budget refuses with, and a status read that names it without `error`.
    expect(
      refusalProblems([
        { status: 200, body: { data: { status: 'rejected', error_code: 'concurrency_limit_exceeded', error_message: 'Budget 7 (concurrency) exceeded', cost: { estimated: '' } } } },
        { status: 200, body: { data: rejected(undefined, { error_code: 'operation_limit_exceeded', error_message: 'Budget 7 (per_operation) exceeded', cost: {} }) } },
      ]),
    ).toEqual([said('answer #1', 'concurrency_limit_exceeded', '""'), said('answer #2', 'operation_limit_exceeded', 'missing')]);
    // A list is read item by item.
    expect(refusalProblems([{ status: 200, body: { data: [rejected('0.00061560'), rejected(null)] } }])).toEqual([
      said('answer #1, item #2,', 'budget_exceeded', 'null'),
    ]);
    // Not a budget's refusal: a `reject` node set up with the same code and a message of its own, a customer out of
    // credits, an execution that completed.
    const ownMessage = { code: 'budget_exceeded', message: 'The plan of this customer is used up' };
    expect(
      refusalProblems([
        { status: 200, body: { data: rejected(null, { error: ownMessage, error_message: ownMessage.message }) } },
        { status: 200, body: { data: rejected(null, { error: null, error_code: 'insufficient_credits', error_message: 'Insufficient credits' }) } },
        { status: 200, body: { data: { status: 'completed', error: null, error_code: null, cost: { estimated: null } } } },
      ]),
    ).toEqual([]);
  });

  it('says whether an example that is not over ran out of its own clock or of real time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    try {
      const sleeping = (async (): Promise<never> => {
        for (;;) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
      })();

      await expect(untilOver(sleeping, { clockMs: 3_000, realMs: 20_000 })).rejects.toThrow(
        'was not over after 3 s of its own clock',
      );

      // The sleeper's last timer goes with the clock; what is left awaits nothing that will come.
      vi.clearAllTimers();

      await expect(
        untilOver(new Promise<never>(() => {}), { clockMs: 3_000, realMs: 50 }, () => ['0 request(s) made']),
      ).rejects.toThrow('was not over after 50 ms of real time (its own clock moved 0 ms, 0 of its timers pending, 0 request(s) made)');
    } finally {
      vi.useRealTimers();
    }
  });

  // An example finds the harness's key where the client looks for one, whatever the shell has set; it is put
  // back afterwards.
  it('runs an example in an environment of its own and leaves none behind', async () => {
    const env = environment();
    const found = env[KEY_VARIABLE];
    const read = (): string | undefined => env[KEY_VARIABLE];

    env[KEY_VARIABLE] = 'sl_live_of_the_machine';

    try {
      expect(await inTheEnvironmentOfAnExample(async () => read())).toBe(KEY);
      expect(read()).toBe('sl_live_of_the_machine');
    } finally {
      if (found === undefined) {
        delete env[KEY_VARIABLE];
      } else {
        env[KEY_VARIABLE] = found;
      }
    }
  });

  it('holds a value against a schema of the spec', () => {
    const spec: OpenApi = {
      paths: {},
      components: {
        schemas: {
          Money: { type: 'string', pattern: '^\\d+\\.\\d{8}$' },
          Run: {
            type: 'object',
            required: ['id', 'cost', 'output'],
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['queued', 'completed'] },
              cost: { oneOf: [{ $ref: '#/components/schemas/Money' }, { type: 'null' }] },
              output: { type: ['object', 'null'], additionalProperties: true },
              retry_after_seconds: { type: 'integer', minimum: 1 },
              cache: { type: 'object', required: ['hit'], properties: { hit: { type: 'boolean' } } },
            },
          },
          Submitted: {
            allOf: [
              { $ref: '#/components/schemas/Run' },
              { type: 'object', required: ['replayed'], properties: { replayed: { type: 'boolean' } } },
            ],
          },
          Noted: {
            allOf: [
              { $ref: '#/components/schemas/Submitted' },
              { type: 'object', properties: { note: { type: 'string' } } },
            ],
          },
        },
      },
    };
    const schema: Schema = { $ref: '#/components/schemas/Run' };
    const together: Schema = { $ref: '#/components/schemas/Submitted' };
    const twice: Schema = { $ref: '#/components/schemas/Noted' };

    // An `allOf` is one object: what one part lists the other does not call unknown, and each part holds its own.
    expect(violations(spec, { id: '7', cost: null, output: null, replayed: false }, together, 'data')).toEqual([]);
    expect(violations(spec, { id: '7', cost: null, replayed: 'no', extra: true }, together, 'data')).toEqual([
      'data.output: is required by the spec and missing',
      'data.extra: is not a field the spec describes',
      'data.replayed: is string, the spec says boolean',
    ]);
    expect(violations(spec, { id: '7', cost: null, output: null }, together, 'data')).toEqual([
      'data.replayed: is required by the spec and missing',
    ]);

    // What reading an `allOf` as one object must not loosen. The keys the parts list are known
    // at their own level only: an object inside is held to its own schema, whatever its parent lists.
    expect(
      violations(
        spec,
        { id: '7', cost: null, output: null, replayed: false, cache: { hit: false, replayed: false, id: '7' } },
        together,
        'data',
      ),
    ).toEqual(['data.cache.replayed: is not a field the spec describes', 'data.cache.id: is not a field the spec describes']);
    // An `allOf` inside an `allOf`: every level adds what it lists, each part still holds its own, and a key no
    // level lists is said once — not once for every part that does not know it.
    expect(violations(spec, { id: '7', cost: null, output: null, replayed: false, note: 'kept' }, twice, 'data')).toEqual([]);
    expect(violations(spec, { id: '7', cost: null, output: null, note: 7, extra: true }, twice, 'data')).toEqual([
      'data.extra: is not a field the spec describes',
      'data.replayed: is required by the spec and missing',
      'data.note: is integer, the spec says string',
    ]);

    expect(violations(spec, { id: '7', status: 'queued', cost: null, output: { anything: 1 } }, schema, 'data')).toEqual([]);
    expect(violations(spec, { id: 7, status: 'done', cost: '1.5', retry_after_seconds: 0, extra: true }, schema, 'data')).toEqual([
      'data.output: is required by the spec and missing',
      'data.id: is integer, the spec says string',
      'data.status: "done" is not one of ["queued","completed"]',
      'data.cost: matches none of the alternatives the spec allows',
      'data.retry_after_seconds: 0 is below the minimum of 1',
      'data.extra: is not a field the spec describes',
    ]);
  });
});

describe.each(ids())('help example %s', (id) => {
  const example = readJson<Example>(id, 'example.json');
  const expectations = readJson<Expectations>(id, 'expect.json');

  it('says what it is', () => {
    expect(example.id).toBe(id);
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(['ready', 'draft']).toContain(example.status);
    expect(example.summary.trim()).not.toBe('');
    expect(example.languages.length).toBeGreaterThan(0);
    expect([...new Set(example.languages)]).toEqual(example.languages);
    expect(example.languages.filter((language) => !(language in FILES))).toEqual([]);
    expect(example.regions.length).toBeGreaterThan(0);
    expect(Array.isArray(expectations.prints)).toBe(true);
    // A webhook is received, not requested: such an example calls nothing and prints what it read.
    expect(expectations.calls.length + expectations.prints.length, 'an example that calls nothing and prints nothing shows nothing').toBeGreaterThan(0);
    expect(answerProblems(example.responses)).toEqual([]);
    expect([undefined, true], '"laravel" is true or absent').toContain(example.laravel);
    expect(example.laravel === true && example.languages.join() !== 'php', 'a Laravel example is written for PHP alone').toBe(false);
    expect(frameworkProblems(example.framework, example.languages)).toEqual([]);
  });

  it('keeps the estimate of the call in an execution it shows refused by a budget', () => {
    expect(refusalProblems(example.responses)).toEqual([]);
  });

  it('has a node.ts exactly when it names node', () => {
    expect(fs.existsSync(fileOf(id, FILES.node))).toBe(example.languages.includes('node'));
  });

  it('names neither the address of the API nor an earlier key in any of its files of this package', () => {
    const files = ['example.json', 'expect.json', ...(example.languages.includes('node') ? [FILES.node] : [])];

    expect(files.flatMap((name) => namedNowhere(fs.readFileSync(fileOf(id, name), 'utf8')).map((why) => `${name}: ${why}`))).toEqual([]);
  });

  it.runIf(example.languages.includes('node'))('carries its regions in node.ts, and nothing a region may not show or lean on', () => {
    const source = fs.readFileSync(fileOf(id, FILES.node), 'utf8');
    const regions = regionsOf(source);

    expect([...regions.keys()]).toEqual(example.regions);
    expect(hiddenReads(source)).toEqual([]);

    for (const [name, text] of regions) {
      expect(notShown(text), `region "${name}"`).toEqual([]);
      expect(retired(text), `region "${name}"`).toEqual([]);
    }
  });

  it.runIf(example.languages.includes('node'))('makes the calls it is expected to make, and prints what it is expected to print', async () => {
    const outcome = await run(id, example.responses);

    if (outcome.handed === null) {
      expect(expectations.calls.length, 'one answer in example.json for each call of expect.json').toBe(example.responses.length);
      expect(differences(expectations.calls, outcome.wire, `Bearer ${KEY}`)).toEqual([]);
    } else {
      // The example brought its own double: nothing may have reached the wire,
      // and what the double recorded is what the expectations describe.
      expect(example.responses, 'an example with its own double is served nothing by the harness').toEqual([]);
      expect(outcome.wire.map(wire)).toEqual([]);
      expect(differences(expectations.calls, outcome.handed, null)).toEqual([]);
    }

    expect(outcome.printed).toEqual(expectations.prints);
  }, RUN_TIMEOUT_MS);

  // Every example of the tree, whatever its languages: the JSON is one for both, and a PHP-only example
  // (`laravel`) is held here as well.
  describe.skipIf(SPEC === null)('against the OpenAPI spec', () => {
    const spec = SPEC as OpenApi;

    it('is expected to send what its operations take', () => {
      const problems = expectations.calls.flatMap((call, index) => {
        const schema = schemaOf(spec, operationOf(spec, call).requestBody);

        return schema === undefined || call.body === undefined
          ? []
          : violations(spec, call.body, schema, `call #${index + 1} body`);
      });

      expect(problems).toEqual([]);
    });

    it('is answered with what its operations answer', () => {
      const problems = example.responses.flatMap((answer, index) => {
        const call = expectations.calls[index];

        if (call === undefined) {
          return [`answer #${index + 1} is for a call the expectations do not have`];
        }

        const schema = answerSchema(spec, operationOf(spec, call), answer.status);

        return schema === undefined
          ? [`answer #${index + 1}: ${call.method} ${call.path} does not answer ${answer.status}`]
          : violations(spec, answer.body, schema, `answer #${index + 1}`);
      });

      expect(problems).toEqual([]);
    });
  });
});
