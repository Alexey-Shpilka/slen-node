import { LOG_EVENTS, type SlenLogger, writeLog } from '../../logger.js';
import type { ExecutionWarning } from './types.js';

/** @internal */
export function writeWarnings(logger: SlenLogger, run: { readonly execution_id: string; readonly warnings?: readonly ExecutionWarning[] }): void {
  if (!Array.isArray(run.warnings) || run.warnings.length === 0) {
    return;
  }

  writeLog(logger, LOG_EVENTS.executionWarnings, {
    execution_id: run.execution_id,
    warnings: run.warnings.map((warning) => ({ code: warning.code, keys: warning.keys ?? null })),
  });
}
