import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionError, SlenError, TimeoutError } from '../src/errors.js';
import { Slen } from '../src/slen.js';

/**
 * The attempt clock against a real socket. `FakeFetch` can only show that the SDK reacts to an abort;
 * whether an abort really tears a body down, and what a torn body rejects with, is the runtime's
 * `fetch` — so this file talks to a local `node:http` server.
 */

// The package has no `@types/node`, so the few members of `node:http` used here are described
// structurally and the module is loaded through a specifier the compiler does not try to resolve.
interface Outgoing {
  readonly writableEnded: boolean;
  writeHead(status: number, headers: Record<string, string>): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(chunk?: string): unknown;
  /** Tears the socket down without ending the response. */
  destroy(): unknown;
  on(event: 'close', listener: () => void): unknown;
}

interface HttpServer {
  listen(port: number, host: string, ready: () => void): unknown;
  address(): { port: number } | string | null;
  close(done: () => void): unknown;
  closeAllConnections(): void;
}

interface NodeHttp {
  createServer(handler: (request: unknown, response: Outgoing) => void): HttpServer;
}

interface Wire {
  readonly baseUrl: string;
  /** Requests that reached the server. */
  hits: number;
  /** Responses the client hung up on before the server had finished them. */
  dropped: number;
  stop(): Promise<void>;
}

const NODE_HTTP: string = 'node:http';
const wires: Wire[] = [];

async function serve(handler: (response: Outgoing) => void): Promise<Wire> {
  const http = (await import(NODE_HTTP)) as NodeHttp;

  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      wire.hits += 1;
      response.on('close', () => {
        if (!response.writableEnded) {
          wire.dropped += 1;
        }
      });
      handler(response);
    });

    const wire: Wire = {
      baseUrl: '',
      hits: 0,
      dropped: 0,
      stop: () =>
        new Promise((stopped) => {
          server.closeAllConnections();
          server.close(() => stopped());
        }),
    };

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      wires.push(wire);
      resolve(Object.assign(wire, { baseUrl: `http://127.0.0.1:${port}` }));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function until(condition: () => boolean, withinMs = 2_000): Promise<void> {
  const deadline = Date.now() + withinMs;

  while (!condition() && Date.now() < deadline) {
    await sleep(10);
  }
}

function clientFor(baseUrl: string, timeoutMs: number, retries = 2): Slen {
  return new Slen({ apiKey: 'sl_live_key', baseUrl, timeoutMs, retries });
}

afterEach(async () => {
  await Promise.all(wires.splice(0).map((wire) => wire.stop()));
});

describe('the attempt clock on a real socket', () => {
  it('turns a body that stalls after its headers into a TimeoutError, not a DOMException, and repeats it', async () => {
    const wire = await serve((response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"data":');
    });

    const error: unknown = await clientFor(wire.baseUrl, 300).executions.get('1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(SlenError);
    // The SDK's own clock: no wire code, no status.
    expect((error as SlenError).code).toBeNull();
    expect((error as SlenError).status).toBeNull();
    // No answer is repeated under the same key: the first attempt and two retries.
    expect(wire.hits).toBe(3);

    await until(() => wire.dropped === 3);
    expect(wire.dropped).toBe(3);
  });

  it('repeats an attempt whose headers never arrive, then gives up', async () => {
    const wire = await serve(() => undefined);

    const error: unknown = await clientFor(wire.baseUrl, 100).executions.get('1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as SlenError).code).toBeNull();
    expect(wire.hits).toBe(3);
  });

  it('turns a socket the server tore down mid-body into a ConnectionError', async () => {
    const wire = await serve((response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"data":');
      setTimeout(() => response.destroy(), 20);
    });

    const error: unknown = await clientFor(wire.baseUrl, 5_000, 1).executions.get('1').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as SlenError).code).toBeNull();
    expect(wire.hits).toBe(2);
  });

  it('ends at once on the caller\'s signal, with its reason and without a retry', async () => {
    const wire = await serve(() => undefined);
    const caller = new AbortController();
    const reason = new Error('the user went away');

    setTimeout(() => caller.abort(reason), 50);

    const error: unknown = await clientFor(wire.baseUrl, 5_000)
      .executions.get('1', { signal: caller.signal })
      .catch((thrown: unknown) => thrown);

    expect(error).toBe(reason);
    expect(wire.hits).toBe(1);
  });
});
