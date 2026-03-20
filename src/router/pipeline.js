/**
 * src/router/pipeline.js
 *
 * Main pipeline orchestrator.
 * Called by the SharePoint watcher (or any future trigger) and the review webhook.
 *
 * Flow:
 *   PDF buffer + filename
 *     → extract       (AI — identifies customer + extracts order)
 *     → validate      (schema + confidence + customer identification)
 *     → route         (AUTO | REVIEW | REJECT)
 *       AUTO   → createBCSalesOrder → sendSuccessEmail
 *       REVIEW → store job → sendReviewEmail
 *       REJECT → sendRejectEmail
 */

import crypto from 'crypto'
import { extractOrder }       from '../extractor/extract.js'
import { validateExtraction } from '../validator/validate.js'
import { createBCSalesOrder } from '../bc/createOrder.js'
import {
  sendSuccessEmail,
  sendReviewEmail,
  sendRejectEmail
} from '../email/notify.js'
import { jobStore } from '../utils/jobStore.js'
import { log }      from '../utils/logger.js'

/**
 * Run the full pipeline for a new PDF file.
 * Trigger-agnostic — any watcher (SharePoint, email, manual) can call this.
 *
 * @param {Buffer} pdfBuffer   - Raw PDF file contents
 * @param {string} filename    - Original filename for logging/metadata
 * @returns {Promise<string>}  - Job ID
 */
export async function runPipeline(pdfBuffer, filename) {
  const jobId = crypto.randomUUID()
  log.info('Pipeline started', { jobId, filename })

  let validationReport

  try {
    // 1. Extract (Claude identifies customer + extracts order in one call)
    const extraction = await extractOrder(pdfBuffer, filename)

    // 2. Read customer ID from extraction result
    const customerId = extraction.extraction_meta?.customer_id ?? null

    log.info('Customer identification', {
      jobId,
      customerId: customerId ?? 'UNIDENTIFIED',
      confidence: extraction.extraction_meta?.customer_id_confidence ?? 0
    })

    // 3. Validate (includes CUSTOMER_UNIDENTIFIED check)
    validationReport = validateExtraction(extraction)
    const { disposition } = validationReport

    log.info('Routing decision', { jobId, disposition, customerId })

    // 4. Route
    if (disposition === 'AUTO') {
      await handleAuto(jobId, validationReport, customerId)
    } else if (disposition === 'REVIEW') {
      await handleReview(jobId, validationReport, customerId, filename)
    } else {
      await handleReject(jobId, validationReport, customerId, null)
    }

  } catch (err) {
    log.error('Pipeline error', { jobId, error: err.message, stack: err.stack })
    await sendRejectEmail({
      validationReport,
      customerId: null,
      errorMessage: err.message
    }).catch(mailErr => log.error('Failed to send reject email', { error: mailErr.message }))
  }

  return jobId
}

async function handleAuto(jobId, validationReport, customerId) {
  const bcResult = await createBCSalesOrder(
    validationReport.extraction,
    customerId,
    null
  )
  await sendSuccessEmail({
    extraction: validationReport.extraction,
    bcResult,
    customerId
  })
  jobStore.set(jobId, { status: 'complete', disposition: 'AUTO', bcResult })
}

async function handleReview(jobId, validationReport, customerId, filename) {
  // Store job so the webhook can retrieve it on reviewer response
  jobStore.set(jobId, {
    status:           'awaiting_review',
    disposition:      'REVIEW',
    customerId,
    filename,
    validationReport,
    createdAt:        Date.now()
  })

  await sendReviewEmail({ validationReport, customerId, jobId })

  // Schedule escalation
  const timeoutMs = parseInt(process.env.REVIEW_TIMEOUT_MINUTES ?? '240') * 60_000
  setTimeout(() => escalateReview(jobId), timeoutMs)
}

async function handleReject(jobId, validationReport, customerId, errorMessage) {
  await sendRejectEmail({ validationReport, customerId, errorMessage })
  jobStore.set(jobId, { status: 'rejected', disposition: 'REJECT' })
}

/**
 * Called when a reviewer clicks Approve in the review email.
 * Creates the BC order and sends a success confirmation.
 *
 * @param {string} jobId
 * @param {string} reviewerEmail
 * @param {string|null} confirmedCustomerId - If reviewer manually selected a customer
 */
export async function approveReview(jobId, reviewerEmail, confirmedCustomerId = null) {
  const job = jobStore.get(jobId)
  if (!job || job.status !== 'awaiting_review') {
    throw new Error(`Job ${jobId} not found or not awaiting review`)
  }

  // Use reviewer-confirmed customer if provided, otherwise use extracted ID
  const customerId = confirmedCustomerId ?? job.customerId

  log.info('Review approved', { jobId, reviewerEmail, customerId, wasManuallyIdentified: !!confirmedCustomerId })

  const bcResult = await createBCSalesOrder(
    job.validationReport.extraction,
    customerId,
    reviewerEmail
  )

  await sendSuccessEmail({
    extraction: job.validationReport.extraction,
    bcResult,
    customerId
  })

  jobStore.set(jobId, {
    ...job,
    status: 'complete',
    disposition: 'REVIEW_APPROVED',
    customerId,
    bcResult,
    confirmedBy: reviewerEmail
  })
  return bcResult
}

/**
 * Called when a reviewer clicks Reject.
 */
export async function rejectReview(jobId) {
  const job = jobStore.get(jobId)
  if (!job) throw new Error(`Job ${jobId} not found`)

  log.info('Review rejected', { jobId })
  jobStore.set(jobId, { ...job, status: 'manually_rejected' })

  await sendRejectEmail({
    validationReport: job.validationReport,
    customerId:       job.customerId,
    errorMessage:     'Rejected by reviewer — please process manually'
  })
}

async function escalateReview(jobId) {
  const job = jobStore.get(jobId)
  if (!job || job.status !== 'awaiting_review') return

  log.warn('Review escalation triggered', { jobId })

  const { sendEscalationEmail } = await import('../email/notify.js')
  await sendEscalationEmail?.({ jobId, job }).catch(err =>
    log.error('Escalation email failed', { jobId, error: err.message })
  )
  jobStore.set(jobId, { ...job, status: 'escalated' })
}
