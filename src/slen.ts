import { resolveConfig, type SlenConfig, type SlenOptions } from './config.js';
import { ApiClient, FetchClient, type RequestOptions, transportOf } from './http/client.js';
import { endpoint, ENDPOINTS } from './http/endpoints.js';
import { HttpJournal } from './http/logging.js';
import { RetryClient } from './http/retry.js';
import type { SlenLogger } from './logger.js';
import { CustomersModule } from './modules/customers/customers.js';
import { ExecutionsModule } from './modules/executions/executions.js';
import { OperationsModule } from './modules/operations/operations.js';
import { WebhooksModule } from './modules/webhooks/webhooks.js';
import { OtlpSpanRecorder } from './observability/otlp.js';
import { MultiSpanRecorder, NullSpanRecorder, type SpanRecorder } from './observability/recorder.js';
import type { WithRequestId } from './wire.js';

/** The body of `GET /health`: the process serves, and how each dependency answered. */
export interface Health {
  app: string;
  release: string | null;
  server: string;
  /** `ok`, or `down: ` and the reason. */
  mysql: string;
  /** `ok`, or `down: ` and the reason. */
  redis: string;
  queue: string | null;
  broadcast: string | null;
  opcache_preloaded_files: number | null;
  opcache_cached_scripts: number | null;
}

/** The SDK's entry point. Building it checks the options and touches no network. */
export class Slen {
  /** Runs of flows: `execute()`, `executeAsync()`. */
  readonly operations: OperationsModule;
  /** Runs that exist: `get()`, `wait()`, `trace()`. */
  readonly executions: ExecutionsModule;
  /** End customers, their accounts and the movements of their credits. */
  readonly customers: CustomersModule;
  /** Webhooks: `verify()`, `constructEvent()`. */
  readonly webhooks: WebhooksModule;

  readonly #config: SlenConfig;
  readonly #api: ApiClient;
  readonly #spans: SpanRecorder;

  constructor(options: SlenOptions = {}) {
    const config = resolveConfig(options);
    const journal = new HttpJournal(config.logger);

    this.#config = config;
    this.#api = new ApiClient(new RetryClient(new FetchClient(config), journal, { retries: config.retries }), journal);
    this.#spans = recorderOf(options);

    const context = { api: this.#api, config, spans: this.#spans };

    this.operations = new OperationsModule(context);
    this.executions = new ExecutionsModule(context);
    this.customers = new CustomersModule(context);
    this.webhooks = new WebhooksModule({
      secret: config.webhookSecret,
      toleranceSeconds: config.webhookToleranceSeconds,
      logger: config.logger,
    });
  }

  /** A client like this one that writes its journal to `logger`, over the same `fetch` and the same span recorders. */
  withLogger(logger: SlenLogger): Slen {
    const config = this.#config;

    return new Slen({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      logger,
      spanRecorder: this.#spans,
      fetch: config.fetch,
      headers: config.headers,
      ...(config.webhookSecret === null ? {} : { webhookSecret: config.webhookSecret }),
      webhookToleranceSeconds: config.webhookToleranceSeconds,
    });
  }

  /** Liveness of the API: a dependency that is down is named in the body, not in the status. @throws SlenError */
  health(options: RequestOptions = {}): Promise<WithRequestId<Health>> {
    return this.#api.request<Health>({ ...endpoint(ENDPOINTS.health), envelope: false, ...transportOf(options) });
  }

  /** Sends what the span recorders buffer. Never rejects; call it before a short-lived process exits. */
  async flush(): Promise<void> {
    try {
      await this.#spans.flush?.();
    } catch {
      // Telemetry that could not be sent does not fail the process's exit path.
    }
  }
}

function recorderOf(options: SlenOptions): SpanRecorder {
  const recorders = [options.spanRecorder, options.otlp === undefined ? undefined : new OtlpSpanRecorder(options.otlp)].filter(
    (recorder): recorder is SpanRecorder => recorder !== undefined,
  );

  if (recorders.length === 0) {
    return new NullSpanRecorder();
  }

  return recorders.length === 1 ? (recorders[0] as SpanRecorder) : new MultiSpanRecorder(recorders);
}
