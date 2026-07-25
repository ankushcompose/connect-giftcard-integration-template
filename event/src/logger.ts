/** Minimal structured logger — Connect captures stdout as the app's logs. */
const write = (level: string, message: string, meta?: object): void => {
  process.stdout.write(`${JSON.stringify({ level, message, ...(meta ?? {}) })}\n`);
};

export const log = {
  info: (message: string, meta?: object) => write('info', message, meta),
  warn: (message: string, meta?: object) => write('warn', message, meta),
  error: (message: string, meta?: object) => write('error', message, meta),
};
