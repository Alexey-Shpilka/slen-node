import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { apiBase, resolveConfig } from '../src/config.js';
import { BudgetExceededError, InvalidRequestError } from '../src/errors.js';
import { ENDPOINTS } from '../src/http/endpoints.js';
import { errorFromResponse, MAPPED_ERROR_CODES } from '../src/http/error-mapper.js';
import { Slen } from '../src/slen.js';
import { FakeFetch, type QueuedResponse, type RecordedRequest } from '../src/testing/index.js';
import { execution, statusView, trace } from './fixtures.js';
import { account, customer, entry, price } from './modules/harness.js';
import { CONTRACT } from './paths.js';

/**
 * The SDK held against the wire contract itself — the API's OpenAPI spec.
 *
 * Six things are checked: every call the SDK makes is an operation of the
 * spec; what it sends — the keys of its body, the names of its query — is
 * what that operation describes; what it answers with is the schema that
 * operation answers with, in the envelope it uses; a call sends the
 * `Idempotency-Key` header where, and only where, the spec declares it; the
 * error table (`contract/error-codes.json`) and `ErrorCode` agree in both
 * directions — a code of the spec is either in the table or listed, with the
 * reason, in `contract/unmapped-error-codes.json`; and the wire types of
 * the modules (`TYPE_FILES`) say what the schemas say, field by field and down
 * into nested objects and the items of arrays, except where
 * `KNOWN_DIVERGENCES` below says why not.
 *
 * And three things every call rests on, which a change of the spec would break
 * all at once: a refusal of every call is a body the error
 * factory reads, and the fields it reads are the ones the error schemas have
 * (`REFUSALS`); every path is served under the prefix the SDK puts before it
 * (`servers`); and the credential the operations ask for is the bearer token
 * the transport sends.
 *
 * Where the spec comes from: the file `SLEN_OPENAPI_SPEC` names. Without the
 * variable, the checks that need it are skipped — the package is tested on
 * its own in most runs. A variable that names a file that is not there fails
 * the file instead: whoever set it meant the check to run.
 *
 * The PHP SDK holds the first five, and the three, in its
 * `tests/Unit/ContractTest.php` — the third as the keys its DTOs read,
 * since they declare no wire types to compare.
 */

// ---------------------------------------------------------------------------
// The files. The package has no `@types/node`, so the few members of `node:fs`
// used here are described structurally and the module is loaded through a
// specifier the compiler does not try to resolve (as in `errors.test.ts`).

interface NodeFs {
  existsSync(path: string | URL): boolean;
  readFileSync(path: string | URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}

const NODE_FS: string = 'node:fs';
const fs = (await import(NODE_FS)) as NodeFs;

const SPEC_VARIABLE = 'SLEN_OPENAPI_SPEC';

interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
}

interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
}

/** An answer of an operation, written in place or as a `$ref` into `components.responses`. */
interface SpecResponse {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
  headers?: Record<string, unknown>;
}

/** Scheme name → scopes. An operation's `security: []` asks for no credential. */
type SecurityRequirement = Record<string, string[]>;

interface Operation {
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, SpecResponse>;
  security?: SecurityRequirement[];
}

interface OpenApi {
  /** A path item holds its operations by HTTP method, and under `parameters` the ones all of them share. */
  paths: Record<string, Record<string, unknown>>;
  servers?: Array<{ url: string }>;
  security?: SecurityRequirement[];
  components: {
    schemas: Record<string, Schema>;
    parameters?: Record<string, Parameter>;
    responses?: Record<string, SpecResponse>;
    securitySchemes?: Record<string, { type?: string; scheme?: string }>;
  };
}

function locateSpec(): string | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const named = env?.[SPEC_VARIABLE];

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

function spec(): OpenApi {
  if (SPEC === null) {
    throw new Error('No OpenAPI spec was loaded.');
  }

  return SPEC;
}

/** A file of `contract/`, where `test/paths.ts` says it is. */
function readJson<T>(name: string): T {
  try {
    return JSON.parse(fs.readFileSync(new URL(name, CONTRACT), 'utf8')) as T;
  } catch (cause) {
    throw new Error(`contract/${name} could not be read: the suite reads it where test/paths.ts says.`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// The calls.

const ID = '74438200973594624';
const CUSTOMER_ID = 'user 42';
const INPUT = { question: 'hello' };
const EXECUTE = { customer: CUSTOMER_ID, creditType: 'enrichment', context: { tenant: 'acme' }, idempotencyKey: 'ticket-42:answer' };
const MOVE = { creditType: 'enrichment', note: 'invoice 7781', idempotencyKey: 'invoice-7781' };

/** The client as a caller builds it, on a `FakeFetch`; one attempt, so a row is one request. */
function harness(): { client: Slen; http: FakeFetch } {
  const http = new FakeFetch();

  return { client: new Slen({ apiKey: 'sl_live_key', baseUrl: 'https://sdk.example', fetch: http.fetch, retries: 0 }), http };
}

/**
 * What a call answers with, in the wire types of the modules: the body itself
 * (`body`), or the fields of the envelope around it (`data`, and `meta` on a
 * page). `Type[]` is a list of them.
 */
type Returns = { body: string } | { data: string; meta?: string };

interface Call {
  /**
   * The operation of the spec this call is meant to be, as `METHOD /path` —
   * read from `contract/calls.json`, not written in the row.
   */
  operation: string;
  run: (client: Slen) => Promise<unknown>;
  /**
   * The same call with nothing optional passed — the least a caller may write.
   * `run` shows every key the call can send; this shows which ones it always
   * sends, and those have to cover what the request schema requires. A row
   * whose `run` sends nothing but required keys needs none.
   */
  bare?: (client: Slen) => Promise<unknown>;
  answer: QueuedResponse;
  /**
   * The type the call's answer is read as, and where in the body it sits. Null
   * when nothing typed is read off a JSON body (a 204). Held against the
   * method's own return type (no spec needed) and against the schema the
   * operation answers with.
   */
  returns: Returns | null;
}

const DATA = (data: unknown): QueuedResponse => ({ body: { data } });
const STATUS: Returns = { data: 'ExecutionStatusView' };
const CUSTOMER: Returns = { data: 'Customer' };
const ACCOUNT: Returns = { data: 'CustomerAccount' };

/** A row as it is written below: everything but the operation, which is the shared table's. */
type Row = Omit<Call, 'operation'>;

/**
 * Every wire call of the public surface, with an answer the SDK can read. The
 * key is the call as a caller writes it after `slen.`: `operations.execute`,
 * `customers.topUp`, `health`. A public call is a row, or a line of
 * `NOT_CALLS` below.
 *
 * **Which operation a call makes is not written here**: it is the line of the
 * call in `contract/calls.json`, the table both SDKs and the console's Help &
 * Docs read. A row and a line of that table that names
 * `typescript` go together — `the call table of the contract test` below holds
 * it both ways, and drives every call to the method and the path of its line,
 * with no spec.
 *
 * Each body here is one the server would take — and the fullest one the call
 * can make: every option it can put in the body or the query is passed,
 * because the check of what a call sends looks at the keys that were sent, not
 * at the ones that could have been. A call that learns a new field gets it here.
 */
const ROWS: Record<string, Row> = {
  'operations.execute': {
    run: (client) => client.operations.execute('support.answer', INPUT, EXECUTE),
    bare: (client) => client.operations.execute('support.answer', INPUT),
    answer: DATA(execution()),
    returns: { data: 'ExecutionResult' },
  },
  'operations.executeAsync': {
    run: (client) => client.operations.executeAsync('support.answer', INPUT, EXECUTE),
    bare: (client) => client.operations.executeAsync('support.answer', INPUT),
    answer: { status: 202, body: { data: execution({ status: 'queued', output: null }) } },
    returns: { data: 'ExecutionResult' },
  },
  'executions.get': {
    run: (client) => client.executions.get(ID),
    answer: DATA(statusView()),
    returns: STATUS,
  },
  // The wait reads the status until the run is over; the answer here says it
  // already is, so it makes one request and does not sleep.
  'executions.wait': {
    run: (client) => client.executions.wait(ID, { timeoutSeconds: 5 }),
    answer: DATA(statusView()),
    returns: STATUS,
  },
  'executions.trace': {
    run: (client) => client.executions.trace(ID),
    answer: DATA(trace()),
    returns: { data: 'ExecutionTrace' },
  },
  'customers.list': {
    run: (client) =>
      client.customers.list({ cursor: 'eyJpZCI6MX0', limit: 30, search: 'user', status: 'active', creditType: 'enrichment', lowBalance: '10' }),
    answer: { body: { data: [customer()], meta: { limit: 30, next_cursor: null } } },
    returns: { data: 'Customer[]', meta: 'CursorMeta' },
  },
  'customers.get': {
    run: (client) => client.customers.get(CUSTOMER_ID),
    answer: DATA(customer()),
    returns: CUSTOMER,
  },
  'customers.create': {
    run: (client) => client.customers.create(CUSTOMER_ID),
    answer: { status: 201, body: { data: customer({ accounts: [] }) } },
    returns: CUSTOMER,
  },
  'customers.updateAccount': {
    run: (client) => client.customers.updateAccount(CUSTOMER_ID, 'enrichment', { allowNegative: true, lowBalanceThreshold: '10.0000' }),
    answer: DATA(account()),
    returns: ACCOUNT,
  },
  'customers.block': {
    run: (client) => client.customers.block(CUSTOMER_ID, { reason: 'Chargeback' }),
    bare: (client) => client.customers.block(CUSTOMER_ID),
    answer: DATA(customer({ status: 'blocked' })),
    returns: CUSTOMER,
  },
  'customers.unblock': {
    run: (client) => client.customers.unblock(CUSTOMER_ID),
    answer: DATA(customer()),
    returns: CUSTOMER,
  },
  'customers.delete': {
    run: (client) => client.customers.delete(CUSTOMER_ID),
    answer: { status: 204 },
    returns: null,
  },
  'customers.topUp': {
    run: (client) => client.customers.topUp(CUSTOMER_ID, '100.0000', MOVE),
    bare: (client) => client.customers.topUp(CUSTOMER_ID, '100.0000'),
    answer: DATA(account()),
    returns: ACCOUNT,
  },
  'customers.charge': {
    run: (client) => client.customers.charge(CUSTOMER_ID, '5.0000', MOVE),
    bare: (client) => client.customers.charge(CUSTOMER_ID, '5.0000'),
    answer: DATA(account()),
    returns: ACCOUNT,
  },
  'customers.adjust': {
    run: (client) => client.customers.adjust(CUSTOMER_ID, '-5.0000', MOVE),
    bare: (client) => client.customers.adjust(CUSTOMER_ID, '-5.0000'),
    answer: DATA(account()),
    returns: ACCOUNT,
  },
  'customers.entries': {
    run: (client) => client.customers.entries(CUSTOMER_ID, { cursor: 'eyJpZCI6MX0', limit: 30, creditType: 'enrichment', entryType: 'charge' }),
    answer: { body: { data: [entry()], meta: { limit: 30, next_cursor: null } } },
    returns: { data: 'CreditEntry[]', meta: 'CursorMeta' },
  },
  'customers.prices': {
    run: (client) => client.customers.prices({ operationCode: 'support.answer', creditType: 'enrichment' }),
    answer: DATA([price()]),
    returns: { data: 'CreditPrice[]' },
  },
  health: {
    run: (client) => client.health(),
    answer: {
      body: {
        app: 'slen',
        release: null,
        server: 'octane',
        mysql: 'ok',
        redis: 'ok',
        queue: null,
        broadcast: null,
        opcache_preloaded_files: null,
        opcache_cached_scripts: null,
      },
    },
    returns: { body: 'Health' },
  },
};

/** A line of `contract/calls.json`: the operation a call makes, and the SDKs that offer the call. */
interface CallLine {
  operation: string;
  sdks: string[];
}

/** This SDK's name in `contract/*.json`. */
const SDK = 'typescript';

/** `contract/calls.json` — the call table both SDKs read. */
const CALL_TABLE = readJson<{ calls: Record<string, CallLine> }>('calls.json').calls;

/** The lines of the call table that name this SDK. */
const LINES: Record<string, CallLine> = Object.fromEntries(
  Object.entries(CALL_TABLE).filter(([, line]) => Array.isArray(line.sdks) && line.sdks.includes(SDK)),
);

/**
 * The rows with the operation their line names. A row without a line gets no
 * operation (`''`) and is named by `the call table of the contract test`; the
 * checks that need the operation then fail on it too.
 */
const CALLS: Record<string, Call> = Object.fromEntries(
  Object.entries(ROWS).map(([name, row]) => [name, { ...row, operation: LINES[name]?.operation ?? '' }]),
);

/**
 * A refusal in the two bodies the API answers one with — the envelope (the
 * spec's `Error`) and a field validation of the framework (`ValidationError`)
 * — each with a value in every field `errorFromResponse()` reads, and the
 * fields it reads, as paths. The factory is held to these
 * bodies with no spec; with one, every path has to be a property of the schema
 * the body is named after. So a field renamed in the spec, or read under
 * another name by the factory, is red — before, both SDKs read `error.code`
 * from the body of every refusal and nothing held the name.
 */
const REFUSALS = {
  Error: {
    body: {
      error: {
        code: 'budget_exceeded',
        message: 'The budget of the project is spent.',
        details: { budget_id: '74438200973594000' },
        request_id: 'req_contract',
      },
    },
    reads: ['error', 'error.code', 'error.message', 'error.details', 'error.request_id'],
  },
  ValidationError: {
    body: {
      message: 'The model field is required.',
      errors: { model: ['The model field is required.'] },
    },
    reads: ['message', 'errors'],
  },
} as const;

/** The value at a dotted path of a JSON body; `undefined` when there is none. */
function valueAt(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), body);
}

interface Sent {
  method: string;
  /** The path under `/api`, as the spec spells its paths. */
  path: string;
  /** The names in the query string. */
  query: string[];
  headers: RecordedRequest['headers'];
  /** The keys of the JSON body; none when no body was sent. */
  body: string[];
}

const SENT: Record<string, Sent> = {};

/** What the `bare` form of a row sent, for the rows that have one. */
const BARE: Record<string, Sent> = {};

async function send(name: string, run: Call['run'], answer: QueuedResponse): Promise<Sent> {
  const { client, http } = harness();
  http.push(answer);

  await run(client);

  if (http.requests.length !== 1) {
    throw new Error(`${name} made ${http.requests.length} requests; a row of the call table is one request.`);
  }

  const request = http.requests[0] as RecordedRequest;
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) {
    throw new Error(`${name} called ${path}, outside the /api prefix every path of the spec is served under.`);
  }

  // `forEach`, not `keys()`: the package compiles without `DOM.Iterable`.
  const query = new Set<string>();
  url.searchParams.forEach((_value, key) => query.add(key));

  return {
    method: request.method,
    path: path.slice('/api'.length),
    query: [...query],
    headers: request.headers,
    body: Object.keys(request.body ?? {}),
  };
}

/**
 * An operation as it is on the wire: `METHOD /path` with every path parameter
 * as `{}`. What a parameter is called is the spec's own business — `{id}`
 * renamed to `{reservationId}` changes no request — so both the operations of
 * the spec and the rows of the table are keyed without it.
 */
function wire(operation: string): string {
  return operation.replace(/\{[^/}]*\}/g, '{}');
}

/** `/v1/authorizations/{id}/capture` as a pattern over a real path: a parameter is one segment. */
function pathPattern(template: string): RegExp {
  const literal = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

  return new RegExp(`^${literal.replace(/\{[^/}]*\}/g, '[^/]+')}$`);
}

// ---------------------------------------------------------------------------
// The source, read with the compiler the package is built with.

function sourceFile(url: URL): ts.SourceFile {
  return ts.createSourceFile(url.pathname, fs.readFileSync(url, 'utf8'), ts.ScriptTarget.ES2022, true);
}

/** What a literal in the source spells, with every `${…}` of a template as `{}`. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `{}${span.literal.text}`).join('');
  }

  return null;
}

/** Literals of `src/` that look like a path of ours and are not, each with what it is. */
const FOREIGN_PATHS: Record<string, string> = {
  '/v1/traces': 'The OTLP/HTTP path of a trace collector (`observability/otlp.ts`) — another server, another contract.',
};

/** The one file of `src/` that spells the operations of the API (`ENDPOINTS`). */
const ENDPOINTS_FILE = 'http/endpoints.ts';

/** Whether a literal spells a path of ours (`/v1/…`, `/health`) or an operation (`GET /v1/…`). */
function spellsAnOperation(text: string): boolean {
  const path = text.replace(/^(?:GET|POST|PUT|PATCH|DELETE) /, '');

  return (path.startsWith('/v1/') || path === '/health') && !Object.hasOwn(FOREIGN_PATHS, path);
}

/**
 * Every literal of `src/` outside `ENDPOINTS_FILE` that spells a path or an
 * operation of ours, as `file: literal`. Comments are not literals.
 */
function operationsOutsideTheTable(): string[] {
  const root = new URL('../src/', import.meta.url);
  const found = new Set<string>();

  for (const name of fs.readdirSync(root, { recursive: true })) {
    const file = name.replaceAll('\\', '/');
    const visit = (node: ts.Node): void => {
      const text = literalText(node);

      if (text !== null && spellsAnOperation(text)) {
        found.add(`${file}: ${text}`);
      }

      ts.forEachChild(node, visit);
    };

    if (file.endsWith('.ts') && file !== ENDPOINTS_FILE) {
      visit(sourceFile(new URL(file, root)));
    }
  }

  return [...found].sort();
}

/**
 * Public members of the client that are not a wire call, each with why it has
 * no row in `CALLS`.
 */
const NOT_CALLS: Record<string, string> = {
  'webhooks.verify':
    'Checks `Slen-Signature` over the body a webhook delivery brought: no request of the API. `test/modules/webhooks.test.ts` runs it over every case of `contract/webhook-vectors.json`.',
  'webhooks.constructEvent':
    'The same check, then the body read as an event: no request of the API. `test/modules/spec.test.ts` holds the events to `webhooks:` of the spec.',
  flush: 'Flushes the span recorders: telemetry, sent to a collector and not to the API (`FOREIGN_PATHS`).',
};

const isPublic = (member: ts.ClassElement): boolean =>
  !ts.isPrivateIdentifier(member.name ?? ts.factory.createIdentifier('constructor')) &&
  !(ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));

function answersAClient(method: ts.MethodDeclaration): boolean {
  return method.type !== undefined && ts.isTypeReferenceNode(method.type) && ts.isIdentifier(method.type.typeName) && method.type.typeName.text === 'Slen';
}

function classOf(file: ts.SourceFile, name: string): ts.ClassDeclaration {
  const found = file.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === name,
  );

  if (found === undefined) {
    throw new Error(`${file.fileName} declares no class ${name}.`);
  }

  return found;
}

/**
 * Every call the client offers, as a caller writes it after `client.`, with the
 * type the source says it answers with. Read off `src/slen.ts` with the
 * compiler, the way `ReflectionClass` reads `Client` in the PHP suite:
 *
 * - a public property whose type is a class imported from another module is a
 *   resource, and each of its public methods is a call (`authorizations.create`);
 * - a public getter whose type is written out as `{ method(): … }` is a resource
 *   declared in place (there is none today);
 * - a public method of the client is a call (`health`, `run`); any other public
 *   getter is listed under its own name, to be explained in `NOT_CALLS`;
 * - a public method of the client that answers a client (`withLogger`) builds
 *   another one and is not a call, as `SlenSdk::withLogger()` is none in PHP.
 *
 * Anything else public — a member this cannot classify — is an error rather
 * than a call nobody checks.
 */
function publicCallsOfTheClient(): Map<string, ts.TypeNode | undefined> {
  const location = new URL('../src/slen.ts', import.meta.url);
  const file = sourceFile(location);
  const modules = new Map<string, string>();
  const calls = new Map<string, ts.TypeNode | undefined>();

  for (const statement of file.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;

    if (ts.isImportDeclaration(statement) && bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        modules.set(element.name.text, (statement.moduleSpecifier as ts.StringLiteral).text);
      }
    }
  }

  const unreadable = (owner: string, member: ts.Node): Error =>
    new Error(`The contract test cannot tell what this public member of ${owner} is: ${member.getText(file).slice(0, 80)}`);

  for (const member of classOf(file, 'Slen').members) {
    if (ts.isConstructorDeclaration(member) || !isPublic(member)) {
      continue;
    }

    if (member.name === undefined || !ts.isIdentifier(member.name)) {
      throw unreadable('Slen', member);
    }

    const name = member.name.text;

    if (ts.isMethodDeclaration(member) && answersAClient(member)) {
      continue;
    }

    if (ts.isMethodDeclaration(member)) {
      calls.set(name, member.type);
    } else if (ts.isGetAccessorDeclaration(member) && member.type !== undefined && ts.isTypeLiteralNode(member.type)) {
      for (const signature of member.type.members) {
        if (!ts.isMethodSignature(signature) || !ts.isIdentifier(signature.name)) {
          throw unreadable(`Slen.${name}`, signature);
        }

        calls.set(`${name}.${signature.name.text}`, signature.type);
      }
    } else if (ts.isGetAccessorDeclaration(member)) {
      calls.set(name, member.type);
    } else if (
      ts.isPropertyDeclaration(member) &&
      member.type !== undefined &&
      ts.isTypeReferenceNode(member.type) &&
      ts.isIdentifier(member.type.typeName) &&
      modules.has(member.type.typeName.text)
    ) {
      const className = member.type.typeName.text;
      const module = new URL((modules.get(className) as string).replace(/\.js$/, '.ts'), location);
      const source = sourceFile(module);

      for (const method of classOf(source, className).members) {
        if (ts.isConstructorDeclaration(method) || !isPublic(method)) {
          continue;
        }

        if (!ts.isMethodDeclaration(method) || !ts.isIdentifier(method.name)) {
          throw new Error(
            `The contract test cannot tell what this public member of ${className} is: ${method.getText(source).slice(0, 80)}`,
          );
        }

        calls.set(`${name}.${method.name.text}`, method.type);
      }
    } else {
      throw unreadable('Slen', member);
    }
  }

  return calls;
}

// ---------------------------------------------------------------------------
// The shapes.

/** What a type says about a value, in terms both a TypeScript type and a JSON schema can be put in. */
interface Facts {
  /** `string`, `number`, `boolean`, `array`, `object` — or `unknown`, which is compared with nothing. */
  kinds: Set<string>;
  nullable: boolean;
  /** The values of a closed list (strings, or `true` / `false`); null when any value of the kind is taken. */
  literals: string[] | null;
}

/**
 * The files that declare wire shapes: the values of `wire.ts`, the types of each module, and
 * `Health` beside the client. A name is declared in one of them only.
 */
const TYPE_FILES = [
  '../src/slen.ts',
  '../src/wire.ts',
  '../src/modules/customers/types.ts',
  '../src/modules/executions/types.ts',
  '../src/modules/operations/types.ts',
  '../src/modules/webhooks/types.ts',
];
const INTERFACES = new Map<string, ts.InterfaceDeclaration>();
const ALIASES = new Map<string, ts.TypeNode>();

for (const file of TYPE_FILES) {
  for (const statement of sourceFile(new URL(file, import.meta.url)).statements) {
    const name = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? statement.name.text : null;

    if (name !== null && (INTERFACES.has(name) || ALIASES.has(name))) {
      throw new Error(`${name} is declared twice among the type files of the contract test (${file}).`);
    }

    if (ts.isInterfaceDeclaration(statement)) {
      INTERFACES.set(statement.name.text, statement);
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      ALIASES.set(statement.name.text, statement.type);
    }
  }
}

function factsOfType(node: ts.TypeNode): Facts {
  const facts: Facts = { kinds: new Set(), nullable: false, literals: [] };

  const open = (): void => {
    facts.kinds.add('string');
    facts.literals = null;
  };

  const take = (member: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(member)) {
      member.types.forEach(take);
    } else if (ts.isParenthesizedTypeNode(member)) {
      take(member.type);
    } else if (ts.isLiteralTypeNode(member)) {
      if (member.literal.kind === ts.SyntaxKind.NullKeyword) {
        facts.nullable = true;
      } else if (ts.isStringLiteral(member.literal)) {
        facts.kinds.add('string');
        facts.literals?.push(member.literal.text);
      } else if (
        member.literal.kind === ts.SyntaxKind.TrueKeyword ||
        member.literal.kind === ts.SyntaxKind.FalseKeyword
      ) {
        // `false` alone is a closed list of one, as `const: false` is in a schema.
        facts.kinds.add('boolean');
        facts.literals?.push(member.literal.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false');
      } else {
        facts.kinds.add('unknown');
      }
    } else if (member.kind === ts.SyntaxKind.StringKeyword) {
      open();
    } else if (member.kind === ts.SyntaxKind.NumberKeyword) {
      facts.kinds.add('number');
    } else if (member.kind === ts.SyntaxKind.BooleanKeyword) {
      facts.kinds.add('boolean');
      facts.literals = null;
    } else if (ts.isArrayTypeNode(member)) {
      facts.kinds.add('array');
    } else if (ts.isTypeLiteralNode(member)) {
      facts.kinds.add('object');
    } else if (ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)) {
      const name = member.typeName.text;
      const alias = ALIASES.get(name);

      if (alias !== undefined) {
        take(alias);
      } else if (name === 'Array') {
        facts.kinds.add('array');
      } else {
        facts.kinds.add(name === 'Record' || INTERFACES.has(name) ? 'object' : 'unknown');
      }
    } else {
      facts.kinds.add('unknown');
    }
  };

  take(node);

  if (facts.literals?.length === 0) {
    facts.literals = null;
  }

  return facts;
}

function resolve(schema: Schema): Schema {
  if (schema.$ref === undefined) {
    return schema;
  }

  const name = schema.$ref.replace(SCHEMA_REFERENCE, '');
  const target = spec().components.schemas[name];

  if (target === undefined) {
    throw new Error(`The spec has no schema ${schema.$ref}.`);
  }

  return resolve(target);
}

const KIND_OF_JSON_TYPE: Record<string, string> = {
  string: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
};

function factsOfSchema(given: Schema): Facts {
  const facts: Facts = { kinds: new Set(), nullable: false, literals: null };

  const take = (member: Schema): void => {
    const schema = resolve(member);

    if (schema.oneOf !== undefined) {
      schema.oneOf.forEach(take);

      return;
    }

    const types = schema.type === undefined ? [] : [schema.type].flat();

    for (const type of types) {
      if (type === 'null') {
        facts.nullable = true;
      } else {
        facts.kinds.add(KIND_OF_JSON_TYPE[type] ?? 'unknown');
      }
    }

    if (types.length === 0) {
      facts.kinds.add(schema.properties !== undefined || schema.allOf !== undefined ? 'object' : 'unknown');
    }

    const closed = schema.enum ?? (schema.const === undefined ? undefined : [schema.const]);

    if (closed !== undefined) {
      facts.literals = [...(facts.literals ?? []), ...closed.map(String)];
    }
  };

  take(given);

  return facts;
}

/** The properties and the required list of an object schema, `allOf` merged. */
function objectOf(given: Schema): { properties: Record<string, Schema>; required: Set<string> } {
  const schema = resolve(given);
  const merged = { properties: { ...schema.properties }, required: new Set(schema.required ?? []) };

  for (const part of schema.allOf ?? []) {
    const inner = objectOf(part);

    Object.assign(merged.properties, inner.properties);
    inner.required.forEach((name) => merged.required.add(name));
  }

  return merged;
}

const list = (values: Iterable<string>): string => [...values].sort().join(', ');

function divergencesOfField(where: string, sdk: Facts, wire: Facts): string[] {
  const found: string[] = [];
  const comparable = !sdk.kinds.has('unknown') && !wire.kinds.has('unknown');

  if (comparable && list(sdk.kinds) !== list(wire.kinds)) {
    found.push(`${where}: ${list(sdk.kinds)} in the SDK, ${list(wire.kinds)} in the spec`);
  }

  if (sdk.nullable !== wire.nullable) {
    found.push(`${where}: ${sdk.nullable ? 'nullable in the SDK, not in the spec' : 'nullable in the spec, not in the SDK'}`);
  }

  if (sdk.literals === null && wire.literals !== null) {
    found.push(`${where}: any string in the SDK, a closed list in the spec`);
  } else if (sdk.literals !== null && wire.literals === null) {
    found.push(`${where}: a closed list in the SDK, any string in the spec`);
  } else if (sdk.literals !== null && wire.literals !== null && list(sdk.literals) !== list(wire.literals)) {
    found.push(`${where}: the SDK lists ${list(sdk.literals)}; the spec lists ${list(wire.literals)}`);
  }

  return found;
}

/**
 * The schema an address of `SHAPES` leads to: the name of a component, then any
 * number of steps into it — `.property`, and `[]` for the items of an array.
 * `ChatCompletionRequest.messages[]` is one message of a chat request.
 */
function schemaAt(address: string): Schema {
  const [name = '', ...steps] = address.split(/(?=\[\])|\./);
  let schema: Schema = { $ref: `${SCHEMA_REFERENCE}${name}` };

  for (const step of steps) {
    const next = step === '[]' ? resolve(schema).items : objectOf(schema).properties[step];

    if (next === undefined) {
      throw new Error(`The spec has nothing at ${address}: no ${step === '[]' ? 'items' : step} there.`);
    }

    schema = next;
  }

  return schema;
}

const SCHEMA_REFERENCE = '#/components/schemas/';

/** The one thing a type is besides `null`; null for a union of several. */
function soleType(node: ts.TypeNode): ts.TypeNode | null {
  if (ts.isParenthesizedTypeNode(node)) {
    return soleType(node.type);
  }

  if (!ts.isUnionTypeNode(node)) {
    return node;
  }

  const rest = node.types.filter(
    (member) => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
  );

  return rest.length === 1 ? soleType(rest[0] as ts.TypeNode) : null;
}

/** The one thing a schema is besides `null`, its `$ref` left as written; null for a `oneOf` of several. */
function soleSchema(schema: Schema): Schema | null {
  if (schema.oneOf === undefined) {
    return schema;
  }

  const rest = schema.oneOf.filter((member) => resolve(member).type !== 'null');

  return rest.length === 1 ? soleSchema(rest[0] as Schema) : null;
}

/** `T` of `T[]` and of `Array<T>`. */
function elementType(node: ts.TypeNode): ts.TypeNode | null {
  if (ts.isArrayTypeNode(node)) {
    return node.elementType;
  }

  const isArray = ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Array';

  return isArray ? (node.typeArguments?.[0] ?? null) : null;
}

/**
 * Where a value of the SDK and its schema part ways: what kind of value it is,
 * and then what is inside it. An object written out in place is compared
 * member by member; an interface is compared on its own under `SHAPES`, so
 * here it is enough that the spec means the same schema; an array goes on into
 * its items.
 */
function divergencesOfValue(where: string, type: ts.TypeNode, schema: Schema): string[] {
  const found = divergencesOfField(where, factsOfType(type), factsOfSchema(schema));
  const inner = soleType(type);
  const wire = soleSchema(schema);

  if (inner === null || wire === null) {
    return found;
  }

  const element = elementType(inner);
  const items = resolve(wire).items;

  if (ts.isTypeLiteralNode(inner)) {
    found.push(...divergencesOfMembers(where, inner.members, wire));
  } else if (element !== null && items !== undefined) {
    found.push(...divergencesOfValue(`${where}[]`, element, items));
  } else if (ts.isTypeReferenceNode(inner) && ts.isIdentifier(inner.typeName)) {
    const name = inner.typeName.text;
    const declaration = INTERFACES.get(name);
    const named = wire.$ref?.replace(SCHEMA_REFERENCE, '');

    if (declaration !== undefined && named === undefined) {
      // The spec writes the object out where the SDK names an interface.
      found.push(...divergencesOfMembers(where, declaration.members, wire));
    } else if (declaration !== undefined && Object.hasOwn(SHAPES, name) && SHAPES[name] !== named) {
      found.push(`${where}: ${name} in the SDK, which transcribes ${SHAPES[name]}; the spec has ${named} there`);
    }
  }

  return found;
}

/** Where the members of an object type and an object schema part ways, one line per difference. */
function divergencesOfMembers(owner: string, members: ts.NodeArray<ts.TypeElement>, schema: Schema): string[] {
  const wire = objectOf(schema);
  const found: string[] = [];
  const declared = new Set<string>();

  for (const member of members) {
    if (!ts.isPropertySignature(member) || member.type === undefined || !ts.isIdentifier(member.name)) {
      throw new Error(`${owner} has a member this test cannot read.`);
    }

    const name = member.name.text;
    const where = `${owner}.${name}`;
    const property = wire.properties[name];
    declared.add(name);

    if (property === undefined) {
      found.push(`${where}: in the SDK, not in the spec`);

      continue;
    }

    const optional = member.questionToken !== undefined;

    if (optional !== !wire.required.has(name)) {
      found.push(`${where}: ${optional ? 'optional in the SDK, required in the spec' : 'required in the SDK, optional in the spec'}`);
    }

    found.push(...divergencesOfValue(where, member.type, property));
  }

  for (const name of Object.keys(wire.properties)) {
    if (!declared.has(name)) {
      found.push(`${owner}.${name}: in the spec, not in the SDK`);
    }
  }

  return found;
}

/** Where an interface of the type files and its schema part ways, one line per difference. */
function divergencesOfShape(type: string, address: string): string[] {
  const declaration = INTERFACES.get(type);

  if (declaration === undefined) {
    throw new Error(`The type files declare no interface ${type}.`);
  }

  return divergencesOfMembers(type, declaration.members, schemaAt(address));
}

/**
 * SDK type → the schema it transcribes: the name of a component, or a place
 * inside one (`schemaAt`). An interface is compared field by field, an alias as
 * a kind of value and a closed list. Every type the type files declare is
 * here or in `NOT_COMPARED` — a type in neither fails the suite.
 */
const SHAPES: Record<string, string> = {
  Money: 'Money',
  Credits: 'Credits',
  Id: 'Id',
  ExecutionStatus: 'ExecutionStatus',
  ParkReason: 'ParkReason',
  WaitingOn: 'WaitingOn',
  ExecutionCache: 'ExecutionCache',
  ExecutionCost: 'ExecutionCost',
  ExecutionResult: 'ExecutionResult',
  ExecutionStatusView: 'ExecutionStatusView',
  NodeExecutionStatus: 'NodeExecutionStatus',
  AttemptSummary: 'AttemptSummary',
  FlowExecutionNode: 'FlowExecutionNode',
  FlowExecutionEvent: 'FlowExecutionEvent',
  ExecutionTrace: 'FlowExecutionTrace',
  CustomerStatus: 'CustomerStatus',
  Customer: 'Customer',
  CustomerAccount: 'CustomerAccount',
  CreditEntryType: 'CustomerCreditEntry.entry_type',
  CreditEntry: 'CustomerCreditEntry',
  CreditPrice: 'CreditPrice',
  CursorMeta: 'CursorMeta',
  Health: 'Health',
  ExecutionFinishedEventData: 'ExecutionFinishedEventData',
  CustomerBalanceLowEventData: 'CustomerBalanceLowEventData',
  ApprovalRequestedEventData: 'ApprovalRequestedEventData',
  ApprovalDecidedEventData: 'ApprovalDecidedEventData',
};

const WEBHOOK_EVENTS =
  'An event lives under `webhooks:` of the spec, not in `components`: `test/modules/spec.test.ts` holds the envelope, the names and the `data` of each typed event to it.';

/** Types of the type files that transcribe no schema, each with why. */
const NOT_COMPARED: Record<string, string> = {
  Page: 'A generic wrapper, `{ data: T[], meta: CursorMeta }`: no schema of its own in the spec either. `T` and `CursorMeta` are compared on their own.',
  WebhookEventType: 'Derived from `WEBHOOK_EVENT_TYPES`, which `test/modules/spec.test.ts` holds to the schema `WebhookEventType` and to the keys of `webhooks:`.',
  WebhookEventEnvelope: WEBHOOK_EVENTS,
  ExecutionFinishedEvent: WEBHOOK_EVENTS,
  CustomerBalanceLowEvent: WEBHOOK_EVENTS,
  ApprovalRequestedEvent: WEBHOOK_EVENTS,
  ApprovalDecidedEvent: WEBHOOK_EVENTS,
  UnknownWebhookEvent: WEBHOOK_EVENTS,
  WebhookEvent: WEBHOOK_EVENTS,
  TypedWebhookEventType: 'The four names whose `data` the SDK types: the ones `webhooks:` describes with a closed schema.',
};

/**
 * Where the type files say something else than the spec **on purpose**, or are
 * known to and waits for its package. The key is the line the comparison
 * prints; the value is why it is allowed. The list is held in both directions:
 * a difference that is not here fails the test, and so does an entry that no
 * longer differs — take it out when the two agree again.
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  // The two of the trace: what the contract lists, the SDK leaves open.
  'FlowExecutionNode.node_type: any string in the SDK, a closed list in the spec':
    'Node types are added by the backend between SDK releases; a closed union would make a new node a type error in code that only prints it.',
  'FlowExecutionEvent.type: any string in the SDK, a closed list in the spec':
    'The event list grows and shrinks with the runtime (a change of the runtime dropped `released` and added `model_substituted`); the SDK passes the name through.',

};

// ---------------------------------------------------------------------------

beforeAll(async () => {
  for (const [name, call] of Object.entries(CALLS)) {
    SENT[name] = await send(name, call.run, call.answer);

    if (call.bare !== undefined) {
      BARE[name] = await send(name, call.bare, call.answer);
    }
  }
});

function sent(name: string): Sent {
  const request = SENT[name];

  if (request === undefined) {
    throw new Error(`${name} was not sent.`);
  }

  return request;
}

describe('the call table of the contract test', () => {
  // The table above is written by hand, so it is held against the source in two
  // ways, and neither needs a spec. First by what the client offers: a public
  // method of the client or of one of its resources that has no row is a call
  // nobody checks — whatever path it calls and however that path is put
  // together — and a row for a call that is gone is stale.
  it('has a row for every public call of the client, or says why not', () => {
    const offered = [...publicCallsOfTheClient().keys()].sort();
    const accounted = [...Object.keys(CALLS), ...Object.keys(NOT_CALLS)].sort();

    expect(offered.length).toBeGreaterThan(20);
    expect(accounted).toEqual(offered);

    for (const reason of Object.values(NOT_CALLS)) {
      expect(reason.trim()).not.toBe('');
    }
  });

  // The operation of a row is the line of the shared call table
  // (`contract/calls.json`), which the PHP suite and the
  // console's Help & Docs read too: a row with no line there, or a line that
  // names this SDK and has no row, is a table that says something else than
  // the SDK.
  it('is, row for row, the call table of contract/calls.json for this SDK', () => {
    expect(Object.keys(LINES).sort()).toEqual(Object.keys(ROWS).sort());
  });

  it('reads a call table whose every line is an operation and the SDKs that offer it', () => {
    const problems: string[] = [];

    expect(Object.keys(CALL_TABLE).length).toBeGreaterThan(10);

    for (const [name, line] of Object.entries(CALL_TABLE)) {
      if (typeof line.operation !== 'string' || !/^(?:GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(line.operation)) {
        problems.push(`${name}: the operation is not \`METHOD /path\`: ${JSON.stringify(line.operation)}`);
      }

      const sdks = Array.isArray(line.sdks) ? line.sdks : [];

      if (sdks.length === 0 || sdks.some((sdk) => !['php', 'typescript'].includes(sdk)) || new Set(sdks).size !== sdks.length) {
        problems.push(`${name}: \`sdks\` is not a list of php and typescript: ${JSON.stringify(line.sdks)}`);
      }
    }

    expect(problems).toEqual([]);
  });

  // The table is held against the code with no spec: each call goes where its
  // line says. So the console, which prints the table, prints what the SDK does
  // in every run of this suite, not only in the runs that have the spec.
  it('sends every call to the method and the path its line names', () => {
    const problems = Object.entries(CALLS)
      .filter(([, call]) => call.operation !== '')
      .flatMap(([name, call]) => {
        const [method = '', template = ''] = call.operation.split(' ');
        const { method: went, path } = sent(name);

        return went === method && pathPattern(template).test(path) ? [] : [`${name} called ${went} ${path}, and its line says ${call.operation}`];
      });

    expect(problems).toEqual([]);
  });

  // A row also says what its call answers with. That is held against the
  // method's own return type here, and against the spec further down — so the
  // two ends meet: the type a caller gets is the schema the operation answers.
  it('names, in every row, the types its call is declared to return', () => {
    const wrappers: Record<string, string[]> = { Page: ['CursorMeta'] };
    const problems: string[] = [];

    for (const [name, type] of publicCallsOfTheClient()) {
      const call = CALLS[name];

      if (call === undefined) {
        continue; // a line of NOT_CALLS, or the test above names it
      }

      const declared = new Set<string>();
      const visit = (node: ts.Node): void => {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
          const reference = node.typeName.text;

          (wrappers[reference] ?? (INTERFACES.has(reference) || ALIASES.has(reference) ? [reference] : [])).forEach(
            (found) => declared.add(found),
          );
        }

        ts.forEachChild(node, visit);
      };

      if (type !== undefined) {
        visit(type);
      }

      const named = Object.values(call.returns ?? {}).map((value) => value.replace('[]', ''));

      if (list(declared) !== list(named)) {
        problems.push(`${name}: the row says ${list(named) || 'nothing typed'}, the method returns ${list(declared) || 'nothing typed'}`);
      }
    }

    expect(problems).toEqual([]);
  });

  // `SHAPES` is written by hand as well: a type added to a type file and
  // left out of it would be a shape nobody compares. Needs no spec either.
  it('compares every type of the type files with a schema, or says why not', () => {
    const declared = [...INTERFACES.keys(), ...ALIASES.keys()].sort();
    const accounted = [...Object.keys(SHAPES), ...Object.keys(NOT_COMPARED)].sort();

    expect(declared.length).toBeGreaterThan(20);
    expect(accounted).toEqual(declared);

    for (const reason of Object.values(NOT_COMPARED)) {
      expect(reason.trim()).not.toBe('');
    }
  });

  // Then by what the source spells. Every operation the SDK can make is a value
  // of `ENDPOINTS`, and the values are the operations of the call table, both
  // ways: an operation of the table no call makes, or one the table does not
  // have, is a request the check above does not see.
  it('takes every operation it makes from ENDPOINTS, whose values are the operations of the call table', () => {
    const table = [...new Set(Object.values(LINES).map((line) => line.operation))].sort();
    const values = Object.values(ENDPOINTS) as string[];

    expect(values.length).toBe(16);
    expect([...new Set(values)].sort()).toEqual(table);
    expect(new Set(values).size, 'an operation is one value of ENDPOINTS').toBe(values.length);
  });

  // And no literal outside `ENDPOINTS` spells a path or an operation of ours:
  // a module that builds its own route makes a request no line describes.
  it('spells no path of the API outside ENDPOINTS', () => {
    expect(operationsOutsideTheTable()).toEqual([]);
    expect(spellsAnOperation('PUT /v1/customers/{externalUserId}')).toBe(true);
    expect(spellsAnOperation('/health')).toBe(true);
    expect(spellsAnOperation('/v1/traces')).toBe(false);
  });
});

// The bodies the spec check below holds against the error schemas are held
// here against the error factory itself, with no spec: each field the body
// names is read into the error, so `REFUSALS` cannot drift from the code.
describe('the refusals of the contract test', () => {
  it('are read by the error factory, field by field: the envelope', () => {
    const { error } = REFUSALS.Error.body;
    const read = errorFromResponse(402, REFUSALS.Error.body, null);

    expect(read).toBeInstanceOf(BudgetExceededError);
    expect([read.code, read.message, read.details, read.requestId]).toEqual([
      error.code,
      error.message,
      error.details,
      error.request_id,
    ]);
  });

  it('are read by the error factory, field by field: a field validation', () => {
    const { body } = REFUSALS.ValidationError;
    const read = errorFromResponse(422, body, null);

    expect(read).toBeInstanceOf(InvalidRequestError);
    expect([read.code, read.message, read.details]).toEqual([null, body.message, { errors: body.errors }]);
  });

  it('name every path they read in their body', () => {
    for (const { body, reads } of Object.values(REFUSALS)) {
      expect(reads.filter((path) => valueAt(body, path) === undefined)).toEqual([]);
    }
  });
});

describe.skipIf(SPEC === null)('the SDK against the OpenAPI spec', () => {
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  const PARAMETER_REFERENCE = '#/components/parameters/';

  /** A parameter with its `$ref` followed into `components.parameters`. */
  function parameter(given: Parameter): Parameter {
    if (given.$ref === undefined) {
      return given;
    }

    const target = given.$ref.startsWith(PARAMETER_REFERENCE)
      ? spec().components.parameters?.[given.$ref.slice(PARAMETER_REFERENCE.length)]
      : undefined;

    if (target === undefined) {
      throw new Error(`The spec refers to ${given.$ref}, which it does not define.`);
    }

    return parameter(target);
  }

  /**
   * Whether the header is among the parameters — by what the parameter is
   * (`in: header`, `name: Idempotency-Key`), not by how the spec gets to it: a
   * `$ref` to the shared component and an inline declaration are the same
   * header on the wire.
   */
  function declaresIdempotencyKey(parameters: Parameter[]): boolean {
    return parameters.some((declared) => declared.in === 'header' && declared.name?.toLowerCase() === 'idempotency-key');
  }

  /**
   * Every operation of the spec as the spec writes it, keyed as `wire()` spells
   * it. `parameters` holds the operation's own and the ones its path item
   * declares for all of its operations, each with its `$ref` followed.
   */
  function operationsOfTheSpec(): Map<string, Operation & { parameters: Parameter[] }> {
    const found = new Map<string, Operation & { parameters: Parameter[] }>();

    for (const [path, item] of Object.entries(spec().paths)) {
      for (const method of METHODS) {
        const operation = item[method] as Operation | undefined;

        if (operation !== undefined) {
          const shared = (item['parameters'] ?? []) as Parameter[];

          found.set(wire(`${method.toUpperCase()} ${path}`), {
            ...operation,
            parameters: [...shared, ...(operation.parameters ?? [])].map(parameter),
          });
        }
      }
    }

    return found;
  }

  /** Every operation of the spec, keyed as `wire()` spells it, with whether it declares the `Idempotency-Key` header. */
  function operations(): Map<string, boolean> {
    return new Map(
      [...operationsOfTheSpec()].map(([key, operation]) => [key, declaresIdempotencyKey(operation.parameters)]),
    );
  }

  it.each(Object.entries(CALLS))('%s is an operation of the spec', (name, call) => {
    const [method = '', template = ''] = call.operation.split(' ');

    expect(operations().has(wire(call.operation)), `${call.operation} is not an operation of the spec`).toBe(true);
    expect(sent(name).method).toBe(method);
    expect(sent(name).path).toMatch(pathPattern(template));
  });

  // What a call sends is what its operation describes: every key of the body is
  // a property of the request schema, every property the schema requires is in
  // the body, an operation without a request body is sent none, and every name
  // in the query is a query parameter of the operation.
  //
  // Two forms of a call are looked at. `run` passes everything the call can
  // send, and its keys have to be properties. `bare` passes nothing optional,
  // and its keys have to cover what is required — against the full form, a
  // field the backend began to require would pass as long as the SDK can send
  // it. A row that sends more than the required keys has to have a `bare`.
  //
  // This is where the money fields are (`estimated_input_tokens`,
  // `max_output_tokens`, `credits`, `input_tokens`): a field the backend renamed
  // is one the server no longer reads, and a field it began to require is a 422
  // on every call. `requests.test.ts` holds the same bodies against what the SDK
  // itself expects — not against the spec.
  it('sends, in every call, the body and the query its operation describes', () => {
    const declared = operationsOfTheSpec();
    const problems: string[] = [];
    let bodies = 0;

    for (const [name, call] of Object.entries(CALLS)) {
      const operation = declared.get(wire(call.operation));

      if (operation === undefined) {
        continue; // '… is an operation of the spec' names it
      }

      const { body, query } = sent(name);
      const names = operation.parameters.filter((given) => given.in === 'query').map((given) => given.name);
      const asked = query.filter((key) => !names.includes(key));
      const schema = operation.requestBody?.content?.['application/json']?.schema;

      if (asked.length > 0) {
        problems.push(`${name} puts ${list(asked)} in the query, which ${call.operation} does not declare`);
      }

      if (schema === undefined) {
        if (body.length > 0) {
          problems.push(`${name} sends ${list(body)}, and ${call.operation} takes no body`);
        }

        continue;
      }

      const wanted = objectOf(schema);
      const least = BARE[name]?.body ?? body;
      const unknown = body.filter((key) => !Object.hasOwn(wanted.properties, key));
      const missing = [...wanted.required].filter((key) => !least.includes(key));
      bodies += 1;

      if (unknown.length > 0) {
        problems.push(`${name} sends ${list(unknown)}, which the request of ${call.operation} does not have`);
      }

      if (missing.length > 0) {
        problems.push(
          `${name} does not send ${list(missing)} unless asked to, and the request of ${call.operation} requires it`,
        );
      }

      if (call.bare === undefined && body.some((key) => !wanted.required.has(key))) {
        problems.push(`${name} sends keys the request does not require and has no \`bare\` form to show which it always sends`);
      }
    }

    // Hardly any request schema found means the spec is not read the way this test expects.
    expect(bodies).toBeGreaterThan(5);
    expect(problems).toEqual([]);
  });

  // What a call answers with is what its operation answers with: the schema the
  // spec gives every 2xx JSON answer of the operation is the one the row's type
  // transcribes (`SHAPES`), in the envelope the SDK reads it out of — `data`,
  // `data` and `meta`, or none. Without this the shapes were compared by name
  // alone: an operation that began to answer with another schema, or moved its
  // answer out of `data`, changed nothing here.
  it('reads, in every call, the schema its operation answers with', () => {
    const declared = operationsOfTheSpec();
    const problems: string[] = [];

    /** A schema as a row would name it: the component it refers to, `[]` for a list of them. */
    const named = (schema: Schema): string => {
      if (schema.$ref !== undefined) {
        return schema.$ref.replace(SCHEMA_REFERENCE, '');
      }

      return schema.items === undefined ? '(written in place)' : `${named(schema.items)}[]`;
    };

    /** The answer as `Returns` spells it: the fields of the envelope, or the body itself. */
    const answerOf = (schema: Schema): Record<string, string> => {
      const { properties } = objectOf(schema);

      return Object.hasOwn(properties, 'data')
        ? Object.fromEntries(Object.entries(properties).map(([field, value]) => [field, named(value)]))
        : { body: named(schema) };
    };

    for (const [name, call] of Object.entries(CALLS)) {
      const operation = declared.get(wire(call.operation));

      if (operation === undefined || call.returns === null) {
        continue;
      }

      const expected = Object.fromEntries(
        Object.entries(call.returns).map(([field, type]) => {
          const bare = type.replace('[]', '');

          return [field, type.replace(bare, SHAPES[bare] ?? `${bare}, which SHAPES does not have`)];
        }),
      );
      const answers = Object.entries(operation.responses ?? {})
        .filter(([status]) => status.startsWith('2'))
        .map(([status, response]) => [status, response.content?.['application/json']?.schema] as const)
        .filter((answer): answer is [string, Schema] => answer[1] !== undefined);

      if (answers.length === 0) {
        problems.push(`${name}: ${call.operation} has no 2xx JSON answer`);
      }

      for (const [status, schema] of answers) {
        // A `oneOf` answer is a body the request chooses (`GET /v1/customers` by its `view`): one alternative must be it.
        const actual = (schema.oneOf ?? [schema]).map((alternative) => JSON.stringify(answerOf(alternative)));

        if (!actual.includes(JSON.stringify(expected))) {
          problems.push(
            `${name}: read as ${JSON.stringify(expected)}; ${call.operation} answers ${status} with ${actual.join(' or ')}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  // A call that moves money is replayed by the transport after a timeout, and
  // only the key makes the replay safe. The spec says which calls those are,
  // and the SDK has to agree in both directions: a key the spec declares and
  // the SDK does not send is an unsafe replay; a key the SDK sends and the spec
  // does not declare is a promise of a replay guard the server never made (or
  // a header the spec lost).
  describe('the Idempotency-Key header', () => {
    const sendsKey = (name: string): boolean => (sent(name).headers['idempotency-key'] ?? '').trim() !== '';
    const rows = (declares: boolean): string[] => {
      const declared = operations();

      return Object.entries(CALLS)
        .filter(([, call]) => declared.get(wire(call.operation)) === declares)
        .map(([name]) => name);
    };

    // The two checks below prove nothing if this test stops recognising the
    // header in the spec. A run and the read of its status are the anchors.
    it('is still what the spec marks the calls that run or move money with', () => {
      expect(operations().get('POST /v1/operations/execute')).toBe(true);
      expect(operations().get(wire('GET /v1/executions/{id}/status'))).toBe(false);
      expect(rows(true).length).toBeGreaterThan(0);
    });

    it('is sent on every call whose operation declares it', () => {
      expect(rows(true).filter((name) => !sendsKey(name))).toEqual([]);
    });

    it('is sent on no call whose operation does not declare it', () => {
      expect(rows(false).filter(sendsKey)).toEqual([]);
    });
  });

  // Three things every call of the SDK rests on, which the checks above never
  // looked at: the body of a refusal, the prefix of every
  // path, and the credential. A change to any of them in the spec breaks every
  // call at once — and the contract job, kept to catch exactly that kind of
  // drift of the backend, said nothing.
  describe('what every call rests on', () => {
    const RESPONSE_REFERENCE = '#/components/responses/';
    const JSON_MEDIA_TYPE = 'application/json';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** An answer with its `$ref` followed into `components.responses`. */
    const answer = (given: SpecResponse): SpecResponse => {
      if (given.$ref === undefined) {
        return given;
      }

      const target = given.$ref.startsWith(RESPONSE_REFERENCE)
        ? spec().components.responses?.[given.$ref.slice(RESPONSE_REFERENCE.length)]
        : undefined;

      if (target === undefined) {
        throw new Error(`The spec refers to ${given.$ref}, which it does not define.`);
      }

      return answer(target);
    };

    /** What a body may be: the schema it refers to, or each alternative of a `oneOf`. */
    const bodies = (schema: Schema): string[] =>
      schema.oneOf === undefined
        ? [schema.$ref?.replace(SCHEMA_REFERENCE, '') ?? '(a schema written in place)']
        : schema.oneOf.flatMap(bodies);

    // `errorFromResponse()` reads the envelope and the framework's field
    // validation, and nothing else. A refusal answered in a third shape would
    // reach the caller as an error with no code and a made-up message. So
    // would one the spec describes in another media type, or with no body
    // at all: the transport parses whatever comes as JSON and finds no
    // envelope in it — and a check that looked at `application/json` alone
    // passed such a refusal without a word.
    it('answers every refusal of a call in a body the error factory reads', () => {
      const declared = operationsOfTheSpec();
      const problems = new Set<string>();
      let refusals = 0;

      for (const call of Object.values(CALLS)) {
        const operation = declared.get(wire(call.operation));

        if (operation === undefined) {
          continue; // '… is an operation of the spec' names it
        }

        for (const [status, given] of Object.entries(operation.responses ?? {})) {
          if (status.startsWith('2')) {
            continue;
          }

          refusals += 1;

          const content = answer(given).content ?? {};
          const otherTypes = Object.keys(content).filter((media) => media !== JSON_MEDIA_TYPE);
          const schema = content[JSON_MEDIA_TYPE]?.schema;

          if (otherTypes.length > 0) {
            problems.add(`${call.operation} answers ${status} as ${list(otherTypes)}, which the error factory does not read`);
          }

          if (schema === undefined) {
            problems.add(`${call.operation} answers ${status} with no ${JSON_MEDIA_TYPE} body the error factory could read`);

            continue;
          }

          const foreign = bodies(schema).filter((name) => !Object.hasOwn(REFUSALS, name));

          if (foreign.length > 0) {
            problems.add(`${call.operation} answers ${status} with ${list(foreign)}, which the error factory does not read`);
          }
        }
      }

      // Hardly any refusal found means the spec is not read the way this test expects.
      expect(refusals).toBeGreaterThan(20);
      expect([...problems]).toEqual([]);
    });

    it('names in its error schemas every field the error factory reads', () => {
      const missing: string[] = [];

      for (const [name, { reads }] of Object.entries(REFUSALS)) {
        for (const path of reads) {
          let schema: Schema = { $ref: `${SCHEMA_REFERENCE}${name}` };

          for (const key of path.split('.')) {
            const next = objectOf(schema).properties[key];

            if (next === undefined) {
              missing.push(`${name}: ${path}`);

              break;
            }

            schema = next;
          }
        }
      }

      expect(missing).toEqual([]);
      // The code of the envelope is the enum the error table is held to below:
      // a code that stopped being `ErrorCode` would leave that check reading a
      // list nothing answers with.
      expect(schemaAt('Error.error.code').$ref).toBe(`${SCHEMA_REFERENCE}ErrorCode`);
    });

    // The SDK puts `/api` before every path itself (`apiBase()`); the spec says
    // where the paths are served in `servers`. Every row above is checked
    // under that prefix — and the prefix itself was checked against nothing.
    it('serves every path under the prefix the SDK puts before it', () => {
      const prefix = new URL(apiBase(resolveConfig({ apiKey: 'k', baseUrl: 'https://host.example' }))).pathname;
      const servers = spec().servers ?? [];

      expect(prefix).toBe('/api');
      expect(servers.length).toBeGreaterThan(0);
      expect(servers.map(({ url }) => new URL(url).pathname.replace(/\/+$/, '')).filter((path) => path !== prefix)).toEqual(
        [],
      );
    });

    it('lists first among its servers the host the SDK talks to by default', () => {
      vi.stubEnv('SLEN_BASE_URL', undefined);

      expect(apiBase(resolveConfig({ apiKey: 'k' }))).toBe(spec().servers?.[0]?.url.replace(/\/+$/, ''));
    });

    // The transport sends `Authorization: Bearer <key>` on every request. An
    // operation that asks for another credential — an API-key header, a
    // cookie — is a 401 on every call, with nothing in the SDK to show why.
    it('asks, wherever it asks for a credential, for the bearer token the SDK sends', () => {
      const schemes = spec().components.securitySchemes ?? {};
      const bearer = Object.keys(schemes).filter(
        (name) => schemes[name]?.type?.toLowerCase() === 'http' && schemes[name]?.scheme?.toLowerCase() === 'bearer',
      );
      // A list of requirements is a choice: one of them has to be met, each by all the schemes it names.
      const takesTheBearer = (requirements: SecurityRequirement[]): boolean =>
        requirements.some((requirement) => Object.keys(requirement).every((name) => bearer.includes(name)));
      const global = spec().security ?? [];
      const declared = operationsOfTheSpec();
      const problems: string[] = [];
      let asking = 0;

      expect(bearer.length).toBeGreaterThan(0);
      expect(takesTheBearer(global)).toBe(true);

      for (const [name, call] of Object.entries(CALLS)) {
        const requirements = declared.get(wire(call.operation))?.security ?? global;

        if (requirements.length === 0) {
          continue; // `security: []` — the operation asks for no credential (`/health`)
        }

        asking += 1;

        if (!takesTheBearer(requirements)) {
          problems.push(`${call.operation} asks for ${list(requirements.flatMap(Object.keys))}, and ${name} sends a bearer token`);
        }

        if (sent(name).headers['authorization'] !== 'Bearer sl_live_key') {
          problems.push(`${name} sent no bearer token`);
        }
      }

      expect(asking).toBeGreaterThan(10);
      expect(problems).toEqual([]);
    });
  });

  describe('error codes', () => {
    const table = Object.keys(readJson<{ codes: Record<string, unknown> }>('error-codes.json').codes);
    const groups = readJson<{ groups: Record<string, { reason: string; codes: string[] }> }>(
      'unmapped-error-codes.json',
    ).groups;
    const unmapped = Object.values(groups).flatMap((group) => group.codes);
    const codes = (): string[] => (spec().components.schemas['ErrorCode']?.enum ?? []).map(String);

    it('reads a non-empty ErrorCode enum', () => {
      expect(codes().length).toBeGreaterThan(0);
    });

    it('maps only codes the spec has', () => {
      // The table in the code is the table of the file (`errors.test.ts`), so
      // either names a type nothing can raise when its code left the spec.
      expect(table.filter((code) => !codes().includes(code))).toEqual([]);
      expect(MAPPED_ERROR_CODES.filter((code) => !codes().includes(code))).toEqual([]);
    });

    it('has decided on every code of the spec: a type, or a line in unmapped-error-codes.json', () => {
      expect(codes().filter((code) => !table.includes(code) && !unmapped.includes(code))).toEqual([]);
    });

    it('lists as unmapped only live codes outside the table, each once and with a reason', () => {
      expect(unmapped.filter((code) => !codes().includes(code))).toEqual([]);
      expect(unmapped.filter((code) => table.includes(code))).toEqual([]);
      expect(unmapped.filter((code, index) => unmapped.indexOf(code) !== index)).toEqual([]);

      for (const group of Object.values(groups)) {
        expect(group.reason.trim()).not.toBe('');
      }
    });
  });

  it('declares the shapes the spec declares, except where KNOWN_DIVERGENCES says why not', () => {
    const found: string[] = [];

    for (const [type, address] of Object.entries(SHAPES)) {
      const alias = ALIASES.get(type);

      if (alias === undefined) {
        found.push(...divergencesOfShape(type, address));
      } else {
        found.push(...divergencesOfField(type, factsOfType(alias), factsOfSchema(schemaAt(address))));
      }
    }

    expect(found.sort()).toEqual(Object.keys(KNOWN_DIVERGENCES).sort());
  });
});
