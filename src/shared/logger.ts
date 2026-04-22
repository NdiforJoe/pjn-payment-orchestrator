import { StructuredLog } from './types';

const SERVICE = process.env.SERVICE_NAME ?? 'pjn-unknown';

function log(entry: Omit<StructuredLog, 'service'>): void {
  console.log(JSON.stringify({ ...entry, service: SERVICE }));
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) =>
    log({ level: 'INFO', message, ...context }),
  warn: (message: string, context?: Record<string, unknown>) =>
    log({ level: 'WARN', message, ...context }),
  error: (message: string, err?: unknown, context?: Record<string, unknown>) =>
    log({
      level: 'ERROR',
      message,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      ...context,
    }),
};
