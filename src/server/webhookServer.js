/**
 * src/server/webhookServer.js
 *
 * Express server that handles review responses from email links.
 * Routes:
 *   GET /review?token=<signed-token>  — approve or reject a review job
 *   GET /health                       — health check
 */

import express from 'express'
import { verifyReviewToken } from '../email/notify.js'
import { approveReview, rejectReview } from '../router/pipeline.js'
import { log } from '../utils/logger.js'

const app = express()
app.use(express.json())

/**
 * Review action endpoint.
 * The token encodes { jobId, action, customerId }.
 */
app.get('/review', async (req, res) => {
  const { token } = req.query

  if (!token) {
    return res.status(400).send('Missing review token')
  }

  let payload
  try {
    payload = verifyReviewToken(token)
  } catch (err) {
    log.warn('Invalid review token', { error: err.message })
    return res.status(403).send('Invalid or expired review link')
  }

  const { jobId, action, customerId } = payload
  log.info('Review action received', { jobId, action, customerId })

  try {
    if (action === 'approve') {
      const bcResult = await approveReview(jobId, 'reviewer@email', customerId)
      res.send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1 style="color: #28a745;">✅ Order Approved</h1>
          <p>BC Order <strong>${bcResult.orderNumber}</strong> has been created.</p>
          <p>Customer: <strong>${customerId}</strong></p>
        </body></html>
      `)
    } else if (action === 'reject') {
      await rejectReview(jobId)
      res.send(`
        <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1 style="color: #dc3545;">❌ Order Rejected</h1>
          <p>The order has been flagged for manual processing.</p>
        </body></html>
      `)
    } else {
      res.status(400).send(`Unknown action: ${action}`)
    }
  } catch (err) {
    log.error('Review action failed', { jobId, action, error: err.message })
    res.status(500).send(`
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1 style="color: #dc3545;">Error</h1>
        <p>${err.message}</p>
      </body></html>
    `)
  }
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pdf-order-intelligence', timestamp: new Date().toISOString() })
})

/**
 * Start the webhook server.
 * @param {number} port
 * @returns {Promise<import('http').Server>}
 */
export function startWebhookServer(port) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      log.info('Webhook server started', { port })
      resolve(server)
    })
  })
}

export { app }
