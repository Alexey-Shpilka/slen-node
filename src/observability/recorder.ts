import { spanAttributes, type SlenSpan } from './span.js';

/** Where finished spans go: `record()` runs on the path of the call and may not block; `flush()` sends a buffer. */
export interface SpanRecorder {
  record(span: SlenSpan): void;
  flush?(): Promise<void>;
}

/** The default: spans go nowhere. */
export class NullSpanRecorder implements SpanRecorder {
  record(): void {}
}

/** What `LoggerSpanRecorder` needs of a logger; `console` and `SlenLogger` have it. */
export interface SpanLogger {
  info(message: string, attributes: Record<string, unknown>): void;
}

/** Writes each span as one `slen.span` line with its attributes. */
export class LoggerSpanRecorder implements SpanRecorder {
  readonly #logger: SpanLogger;

  constructor(logger: SpanLogger = console) {
    this.#logger = logger;
  }

  record(span: SlenSpan): void {
    this.#logger.info('slen.span', spanAttributes(span));
  }
}

/** Keeps spans in memory, for tests. */
export class MemorySpanRecorder implements SpanRecorder {
  readonly spans: SlenSpan[] = [];

  record(span: SlenSpan): void {
    this.spans.push(span);
  }

  last(): SlenSpan | undefined {
    return this.spans.at(-1);
  }
}

/** Sends every span to each recorder; one that throws does not stop the others. */
export class MultiSpanRecorder implements SpanRecorder {
  readonly #recorders: readonly SpanRecorder[];

  constructor(recorders: readonly SpanRecorder[]) {
    this.#recorders = [...recorders];
  }

  record(span: SlenSpan): void {
    for (const recorder of this.#recorders) {
      try {
        recorder.record(span);
      } catch {
        // A recorder is telemetry; it may not break the call it describes.
      }
    }
  }

  /** Flushes every recorder that buffers; one that fails does not stop the others. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.#recorders.map(async (recorder) => recorder.flush?.()));
  }
}
