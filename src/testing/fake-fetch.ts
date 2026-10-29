export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** One piece of a paced body. */
export interface QueuedFrame {
  text: string;
  /** How long the wire stays silent before this piece, in ms. */
  delayMs?: number;
}

export interface QueuedResponse {
  status?: number;
  body?: unknown;
  /** Raw text, sent as it is. Wins over `body`. */
  text?: string;
  /** The body piece by piece, each after its own pause; a bare string has none. Wins over `text` and `body`. */
  frames?: Array<string | QueuedFrame>;
  /** How long the headers take to arrive, in ms. */
  delayMs?: number;
  headers?: Record<string, string>;
}

// A `Response` of these statuses cannot carry a body, not even an empty one.
const NO_BODY = new Set([204, 205, 304]);

/** A `fetch` stand-in for tests: answers in the order pushed, the last one repeated, and honours `init.signal` as `fetch` does. */
export class FakeFetch {
  readonly requests: RecordedRequest[] = [];

  private readonly queue: QueuedResponse[] = [];

  push(response: QueuedResponse): this {
    this.queue.push(response);

    return this;
  }

  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};

      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }

      this.requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });

      const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
      const answer = next ?? { status: 200, body: {} };
      const signal = init?.signal ?? null;

      await pause(answer.delayMs ?? 0, signal);

      const status = answer.status ?? 200;
      const payload = NO_BODY.has(status)
        ? null
        : answer.frames === undefined
          ? (answer.text ?? JSON.stringify(answer.body ?? {}))
          : pacedBody(answer.frames, signal);

      return new Response(payload, {
        status,
        headers: { 'Content-Type': 'application/json', ...answer.headers },
      });
    }) as typeof fetch;
  }

  last(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }
}

function pause(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);

      return;
    }

    if (ms <= 0) {
      resolve();

      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pacedBody(frames: ReadonlyArray<string | QueuedFrame>, signal: AbortSignal | null): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // One switch for both ways a body ends early: the request's signal, and the reader cancelling.
  const stop = new AbortController();
  const onAbort = (): void => {
    stop.abort(signal?.reason);
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  if (signal?.aborted === true) {
    onAbort();
  }

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      void (async (): Promise<void> => {
        try {
          for (const frame of frames) {
            const piece = typeof frame === 'string' ? { text: frame } : frame;

            await pause(piece.delayMs ?? 0, stop.signal);
            controller.enqueue(encoder.encode(piece.text));
          }

          controller.close();
        } catch (error) {
          if (signal?.aborted === true) {
            controller.error(error);
          }
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      })();
    },
    cancel(): void {
      stop.abort();
    },
  });
}
