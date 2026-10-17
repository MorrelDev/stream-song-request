import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'info' | 'warn' | 'error';

/**
 * Кроме консоли, лог дублируется в файл LOG_DIR/stream-companion-ГГГГ-ММ-ДД.log
 * (по умолчанию ./data/logs) — чтобы после стрима было что посмотреть и
 * переслать. В тестах (node --test) файл не пишется.
 */
const logDir = process.env.NODE_TEST_CONTEXT ? null : process.env.LOG_DIR?.trim() || './data/logs';
let fileLoggingBroken = false;

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatExtra(extra: unknown): string {
  if (extra === undefined || extra === null || extra === '') return '';
  if (extra instanceof Error) return extra.stack ?? `${extra.name}: ${extra.message}`;
  if (typeof extra === 'string') return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function writeToFile(line: string, extra: unknown): void {
  if (!logDir || fileLoggingBroken) return;
  const extraText = formatExtra(extra);
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, `stream-companion-${localDate(new Date())}.log`),
      `${line}${extraText ? ` ${extraText}` : ''}\n`,
      'utf8',
    );
  } catch (err) {
    // Не роняем приложение из-за лога — пишем только в консоль.
    fileLoggingBroken = true;
    console.error(`[logger] Не удалось писать лог в файл (${logDir}), дальше только консоль:`, err);
  }
}

function log(level: Level, scope: string, message: string, extra?: unknown): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${message}`;
  if (level === 'error') {
    console.error(line, extra ?? '');
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  writeToFile(line, extra);
}

export const logger = {
  info: (scope: string, message: string): void => log('info', scope, message),
  warn: (scope: string, message: string): void => log('warn', scope, message),
  error: (scope: string, message: string, extra?: unknown): void => log('error', scope, message, extra),
};
