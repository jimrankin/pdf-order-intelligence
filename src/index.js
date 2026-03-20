/**
 * src/index.js
 *
 * Entry point for the PDF Order Intelligence service.
 * Starts the SharePoint watcher and the Express webhook server.
 */

import 'dotenv/config'
import { startWatcher }       from './watcher/sharepointWatcher.js'
import { startWebhookServer } from './server/webhookServer.js'
import { log }                from './utils/logger.js'

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? '3100')

async function main() {
  log.info('PDF Order Intelligence starting', {
    extractionModel: process.env.EXTRACTION_MODEL ?? 'claude-opus-4-20250514',
    watchFolder: process.env.WATCH_FOLDER ?? 'customers/incoming',
    webhookPort: WEBHOOK_PORT
  })

  // Start the webhook server (for review approve/reject links)
  await startWebhookServer(WEBHOOK_PORT)

  // Start the SharePoint folder watcher
  const watcher = startWatcher()

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...')
    watcher.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  log.error('Fatal startup error', { error: err.message, stack: err.stack })
  process.exit(1)
})
