/**
 * src/utils/logger.js
 *
 * Structured logger wrapping console with JSON output.
 */

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(level) {
  return (LEVELS[level] ?? 1) >= (LEVELS[LOG_LEVEL] ?? 1)
}

function formatMessage(level, message, meta = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  })
}

export const log = {
  debug(msg, meta) { if (shouldLog('debug')) console.debug(formatMessage('debug', msg, meta)) },
  info(msg, meta)  { if (shouldLog('info'))  console.info(formatMessage('info', msg, meta)) },
  warn(msg, meta)  { if (shouldLog('warn'))  console.warn(formatMessage('warn', msg, meta)) },
  error(msg, meta) { if (shouldLog('error')) console.error(formatMessage('error', msg, meta)) }
}
