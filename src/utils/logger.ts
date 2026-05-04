import { config } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, message: string, data?: unknown): void {
  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  const line = data !== undefined ? `${prefix} ${message} ${JSON.stringify(data)}` : `${prefix} ${message}`;
  // MCP servers write to stderr — stdout is reserved for the JSON-RPC protocol
  process.stderr.write(line + '\n');
}

export const logger = {
  debug(message: string, data?: unknown): void {
    if (config.debug.enabled) write('debug', message, data);
  },
  verboseDebug(message: string, data?: unknown): void {
    if (config.debug.verbose) write('debug', `[VERBOSE] ${message}`, data);
  },
  info(message: string, data?: unknown): void {
    write('info', message, data);
  },
  warn(message: string, data?: unknown): void {
    write('warn', message, data);
  },
  error(message: string, data?: unknown): void {
    write('error', message, data);
  },
};
