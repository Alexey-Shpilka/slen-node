import { apiBase, type SlenConfig } from '../config.js';
import {
  ConnectionError,
  INVALID_REQUEST,
  INVALID_RESPONSE,
  InvalidRequestError,
  InvalidResponseError,
  TimeoutError,
} from '../errors.js';
import { SDK_VERSION } from '../version.js';
import { errorFromAnswer } from './error-mapper.js';
import type { HttpJournal } from './logging.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** What a call may say about its own request. */
export interface RequestOptions {
  /** Ends the request when aborted; the call rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Replaces the client's `timeoutMs` for each attempt of this call. */
  timeoutMs?: number;
  /** Replaces the client's `retries` for this call: a whole number of attempts after the first; `0` sends it once. */
  retries?: number;
}

/** What a call that carries an idempotency key may say about its own request. */
export interface CallOptions extends RequestOptions {
  /** What the server knows a repeat by. Generated when absent; never empty. */
  idempotencyKey?: string;
}

/** @internal */
export interface ApiRequest {
  readonly method: HttpMethod;
  readonly route: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly envelope?: false | 'list' | 'page';
  readonly doneAfterNoAnswer?: string;
}

/** @internal */
export interface HttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly bodyLength: number;
  readonly requestId: string | null;
  readonly attempts: number;
  readonly afterNoAnswer: boolean;
}

/** @internal */
export interface HttpClient {
  send(request: ApiRequest): Promise<HttpAnswer>;
}

// The headers the SDK owns; `headers` of the options cannot replace them.
const OWN_HEADERS = new Set(['authorization', 'accept', 'content-type', 'idempotency-key']);

// `setTimeout` keeps its delay in a signed 32-bit integer and fires at once beyond it.
const LONGEST_TIMER_MS = 2_147_483_647;

// A browser forbids setting it, so it is sent only where the runtime says it is Node.
const USER_AGENT: string | null = (() => {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;

  return typeof node === 'string' ? `slen-sdk-node/${SDK_VERSION} node/${node}` : null;
})();

class AttemptClock {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout> | null;
  readonly #unfollow: () => void;
  #expired = false;

  constructor(timeoutMs: number, caller: AbortSignal | undefined) {
    this.#timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          this.#expired = true;
          this.#controller.abort(new Error(`no answer within ${timeoutMs} ms`));
        }, Math.min(timeoutMs, LONGEST_TIMER_MS))
      : null;

    const onAbort = (): void => {
      this.#controller.abort(caller?.reason);
    };

    // A signal aborted already fires no event: the listener waits for nothing, the call below acts.
    caller?.addEventListener('abort', onAbort, { once: true });
    this.#unfollow = (): void => caller?.removeEventListener('abort', onAbort);

    if (caller?.aborted === true) {
      onAbort();
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get expired(): boolean {
    return this.#expired;
  }

  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }

    this.#unfollow();
  }
}

/** @internal */
export class FetchClient implements HttpClient {
  readonly #config: SlenConfig;

  constructor(config: SlenConfig) {
    this.#config = config;
  }

  async send(request: ApiRequest): Promise<HttpAnswer> {
    const timeoutMs = request.timeoutMs ?? this.#config.timeoutMs;
    const url = urlOf(this.#config, request);
    const init: RequestInit = {
      method: request.method,
      headers: headersOf(this.#config, request),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    };
    // Called detached: a browser's `fetch` refuses any `this` but the global one.
    const send = this.#config.fetch;
    const clock = new AttemptClock(timeoutMs, request.signal);

    try {
      const response = await send(url, { ...init, signal: clock.signal });
      // The body is read under the same clock: an answer that stalls after its headers did not arrive.
      const text = await response.text();

      return answerOf(response, text);
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw request.signal.reason;
      }

      const where = `${request.method} ${request.route}`;

      throw clock.expired
        ? new TimeoutError(`Slen did not answer ${where} within ${timeoutMs} ms.`)
        : new ConnectionError(`Slen could not be reached for ${where}: ${describe(error)}`);
    } finally {
      clock.stop();
    }
  }
}

/** @internal */
export class ApiClient {
  readonly #chain: HttpClient;
  readonly #journal: HttpJournal;

  constructor(chain: HttpClient, journal: HttpJournal) {
    this.#chain = chain;
    this.#journal = journal;
  }

  /** @throws SlenError for a refusal, no answer, or an answer that cannot be read */
  async request<T>(request: ApiRequest): Promise<T> {
    refuseBeforeTheWire(request);

    const started = Date.now();
    const answer = await this.#chain.send(request);

    if (answer.status < 200 || answer.status >= 300) {
      const error = errorFromAnswer(answer);

      if (answer.afterNoAnswer && request.doneAfterNoAnswer !== undefined && error.code === request.doneAfterNoAnswer) {
        this.#journal.response(request, answer, Date.now() - started);

        return undefined as T;
      }

      this.#journal.rejected(request, error, answer.attempts);

      throw error;
    }

    let data: unknown;

    try {
      data = dataOf(request, answer);
    } catch (error) {
      this.#journal.rejected(request, error as InvalidResponseError, answer.attempts);

      throw error;
    }

    this.#journal.response(request, answer, Date.now() - started);

    return data as T;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @internal @throws InvalidRequestError, with nothing sent */
export function refuseBeforeTheWire(request: ApiRequest): void {
  if (request.timeoutMs !== undefined && !(request.timeoutMs > 0)) {
    throw new InvalidRequestError(`Slen: timeoutMs must be a number above 0, got ${String(request.timeoutMs)}.`, {
      code: INVALID_REQUEST,
    });
  }

  if (request.retries !== undefined && !(Number.isInteger(request.retries) && request.retries >= 0)) {
    throw new InvalidRequestError(`Slen: retries must be an integer of at least 0, got ${String(request.retries)}.`, {
      code: INVALID_REQUEST,
    });
  }

  for (const name of placeholdersOf(request.route)) {
    const value = request.params?.[name];

    if (value === undefined || value.trim() === '') {
      throw new InvalidRequestError(`Slen: ${request.method} ${request.route} needs a ${name} that is not empty.`, {
        code: INVALID_REQUEST,
      });
    }
  }

  if (request.idempotencyKey !== undefined && request.idempotencyKey.trim() === '') {
    throw new InvalidRequestError(
      `Slen: the idempotency key of ${request.method} ${request.route} is empty; pass one that is not, or none to have one generated.`,
      { code: INVALID_REQUEST },
    );
  }
}

/** @internal */
export function transportOf(options: RequestOptions): Pick<ApiRequest, 'signal' | 'timeoutMs' | 'retries'> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  };
}

function placeholdersOf(route: string): string[] {
  return Array.from(route.matchAll(/\{([^}]+)\}/g), (match) => match[1] ?? '');
}

function urlOf(config: SlenConfig, request: ApiRequest): string {
  const path = request.route.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(request.params?.[name] ?? ''));
  const query = new URLSearchParams();

  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) {
      query.append(name, String(value));
    }
  }

  const search = query.toString();

  return `${apiBase(config)}${path}${search === '' ? '' : `?${search}`}`;
}

function headersOf(config: SlenConfig, request: ApiRequest): Record<string, string> {
  const headers: Record<string, string> = USER_AGENT === null ? {} : { 'User-Agent': USER_AGENT };

  for (const [name, value] of Object.entries(config.headers)) {
    const lower = name.toLowerCase();

    if (lower === 'user-agent') {
      delete headers['User-Agent'];
    }

    if (!OWN_HEADERS.has(lower)) {
      headers[name] = value;
    }
  }

  headers['Authorization'] = `Bearer ${config.apiKey}`;
  headers['Accept'] = 'application/json';

  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (request.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = request.idempotencyKey;
  }

  return headers;
}

function answerOf(response: Response, text: string): HttpAnswer {
  let body: unknown;

  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }

  return {
    status: response.status,
    headers: response.headers,
    body,
    bodyLength: text.length,
    requestId: response.headers.get('x-request-id'),
    attempts: 1,
    afterNoAnswer: false,
  };
}

/** @throws InvalidResponseError when the body is not one of the API's answers */
function dataOf(request: ApiRequest, answer: HttpAnswer): unknown {
  if (answer.status === 204) {
    return undefined;
  }

  const body = answer.body;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw unreadable(request, answer, answer.bodyLength === 0 ? 'no body' : 'a body that is not a JSON object');
  }

  if (request.envelope === false) {
    return body;
  }

  const { data, meta } = body as { data?: unknown; meta?: unknown };

  if (typeof data !== 'object' || data === null) {
    throw unreadable(request, answer, 'JSON that has no `data` in it');
  }

  if (request.envelope === 'list' && !Array.isArray(data)) {
    throw unreadable(request, answer, 'a `data` that is not a list');
  }

  if (request.envelope === 'page') {
    if (!Array.isArray(data) || !isCursorMeta(meta)) {
      throw unreadable(request, answer, 'a page that has no `data` list or no `meta.next_cursor`');
    }

    return { data, meta };
  }

  return data;
}

function isCursorMeta(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }

  const cursor = (meta as { next_cursor?: unknown }).next_cursor;

  return cursor === null || typeof cursor === 'string';
}

// The body is not quoted: it may carry the output of a flow.
function unreadable(request: ApiRequest, answer: HttpAnswer, what: string): InvalidResponseError {
  return new InvalidResponseError(
    `Slen answered ${answer.status} to ${request.method} ${request.route} with ${what}. ` +
      'The call may have gone through; its answer cannot be read.',
    { code: INVALID_RESPONSE, status: answer.status, requestId: answer.requestId },
  );
}
