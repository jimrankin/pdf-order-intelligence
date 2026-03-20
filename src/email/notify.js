/**
 * src/email/notify.js
 *
 * Email notifications for the pipeline:
 *   - sendSuccessEmail:    order created in BC
 *   - sendReviewEmail:     human review required (flagged lines or unidentified customer)
 *   - sendRejectEmail:     hard fail
 *   - sendEscalationEmail: review timed out
 *
 * Also provides HMAC-based review tokens for secure webhook links.
 */

import crypto from 'crypto'
import nodemailer from 'nodemailer'
import { customerList } from '../../prompts/customerHints.js'
import { log } from '../utils/logger.js'

// ─── SMTP Transport ──────────────────────────────────────────────────────────

let transporter = null

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT ?? '587'),
      secure: parseInt(process.env.SMTP_PORT ?? '587') === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  }
  return transporter
}

// ─── Review Tokens ──────────────────────────────────────────────────────────

const SECRET = process.env.WEBHOOK_SECRET ?? 'dev-secret'

/**
 * Generate an HMAC-signed token encoding a review action.
 * @param {object} payload - { jobId, action, customerId }
 * @returns {string} base64url token
 */
export function generateReviewToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

/**
 * Verify and decode an HMAC-signed review token.
 * @param {string} token
 * @returns {object} decoded payload
 * @throws if signature is invalid
 */
export function verifyReviewToken(token) {
  const [data, sig] = token.split('.')
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')

  if (sig !== expected) {
    throw new Error('Invalid review token signature')
  }

  return JSON.parse(Buffer.from(data, 'base64url').toString())
}

// ─── Email Builders ─────────────────────────────────────────────────────────

/**
 * Build the review email body. When CUSTOMER_UNIDENTIFIED is present,
 * make customer identification the first and most prominent section.
 */
function buildReviewEmailBody({ validationReport, customerId, jobId }) {
  const { issues, extraction } = validationReport
  const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3100'

  const customerIssue = issues.find(i => i.reason === 'CUSTOMER_UNIDENTIFIED')
  const fieldIssues = issues.filter(i => i.reason !== 'CUSTOMER_UNIDENTIFIED')

  let html = `<h2>📋 Sales Order Review Required</h2>`

  // ── Customer identification section (prominent if unidentified) ──────
  if (customerIssue) {
    html += `
      <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="margin-top: 0; color: #856404;">⚠️ Customer Could Not Be Identified</h3>
        <p>The AI could not identify which customer this order belongs to
           (confidence: ${((customerIssue.confidence ?? 0) * 100).toFixed(0)}%).</p>
        <p><strong>Please confirm the customer:</strong></p>
        <ul style="list-style: none; padding: 0;">`

    for (const c of customerList) {
      const token = generateReviewToken({ jobId, action: 'approve', customerId: c.id })
      const url = `${baseUrl}/review?token=${token}`
      html += `
          <li style="margin: 8px 0;">
            <a href="${url}"
               style="display: inline-block; padding: 8px 16px; background: #007bff; color: white;
                      text-decoration: none; border-radius: 4px; margin-right: 8px;">
              ✅ ${c.name}
            </a>
          </li>`
    }

    html += `
        </ul>
      </div>`
  } else {
    html += `<p><strong>Customer:</strong> ${customerId ?? 'Unknown'}</p>`
  }

  // ── Source file info ─────────────────────────────────────────────────
  html += `<p><strong>File:</strong> ${extraction.extraction_meta?.source_filename ?? 'Unknown'}</p>`
  html += `<p><strong>PO Ref:</strong> ${extraction.header?.customer_po_ref?.value ?? 'N/A'}</p>`

  // ── Flagged fields ──────────────────────────────────────────────────
  if (fieldIssues.length > 0) {
    html += `<h3>Flagged Items</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
      <tr><th>Location</th><th>Issue</th><th>Confidence</th><th>Value</th></tr>`

    for (const issue of fieldIssues) {
      html += `<tr>
        <td>${issue.location}</td>
        <td>${issue.reason}</td>
        <td>${issue.confidence != null ? (issue.confidence * 100).toFixed(0) + '%' : '—'}</td>
        <td>${issue.value ?? '—'}</td>
      </tr>`
    }
    html += `</table>`
  }

  // ── Approve / Reject links (only if customer IS identified) ────────
  if (!customerIssue) {
    const approveToken = generateReviewToken({ jobId, action: 'approve', customerId })
    const rejectToken  = generateReviewToken({ jobId, action: 'reject',  customerId })

    html += `
      <div style="margin-top: 20px;">
        <a href="${baseUrl}/review?token=${approveToken}"
           style="display: inline-block; padding: 10px 24px; background: #28a745; color: white;
                  text-decoration: none; border-radius: 4px; margin-right: 12px; font-weight: bold;">
          ✅ Approve — Create BC Order
        </a>
        <a href="${baseUrl}/review?token=${rejectToken}"
           style="display: inline-block; padding: 10px 24px; background: #dc3545; color: white;
                  text-decoration: none; border-radius: 4px; font-weight: bold;">
          ❌ Reject — Process Manually
        </a>
      </div>`
  }

  return html
}

// ─── Send Functions ─────────────────────────────────────────────────────────

export async function sendSuccessEmail({ extraction, bcResult, customerId }) {
  const subject = `✅ Sales Order Created — ${extraction.header?.customer_po_ref?.value ?? 'Unknown PO'} (${customerId ?? 'Unknown'})`
  const html = `
    <h2>Sales Order Created in Business Central</h2>
    <p><strong>Customer:</strong> ${customerId}</p>
    <p><strong>PO Ref:</strong> ${extraction.header?.customer_po_ref?.value ?? 'N/A'}</p>
    <p><strong>BC Order No:</strong> ${bcResult?.orderNumber ?? 'N/A'}</p>
    <p><strong>Lines:</strong> ${extraction.lines?.filter(l => !l.flags?.includes('NON_PRODUCT_LINE')).length ?? 0}</p>
    <p><strong>File:</strong> ${extraction.extraction_meta?.source_filename ?? 'Unknown'}</p>
  `
  await send(subject, html)
}

export async function sendReviewEmail({ validationReport, customerId, jobId }) {
  const poRef = validationReport.extraction?.header?.customer_po_ref?.value ?? 'Unknown PO'
  const subject = `⚠️ Review Required — ${poRef} (${customerId ?? 'Customer Unidentified'})`
  const html = buildReviewEmailBody({ validationReport, customerId, jobId })
  await send(subject, html)
}

export async function sendRejectEmail({ validationReport, customerId, errorMessage }) {
  const poRef = validationReport?.extraction?.header?.customer_po_ref?.value ?? 'Unknown PO'
  const subject = `❌ Order Rejected — ${poRef} (${customerId ?? 'Unknown'})`
  const html = `
    <h2>Sales Order Could Not Be Processed</h2>
    <p><strong>Customer:</strong> ${customerId ?? 'Unknown'}</p>
    <p><strong>PO Ref:</strong> ${poRef}</p>
    ${errorMessage ? `<p><strong>Error:</strong> ${errorMessage}</p>` : ''}
    <p>This order requires manual processing. Please check the original PDF.</p>
  `
  await send(subject, html)
}

export async function sendEscalationEmail({ jobId, job }) {
  const escalationTo = process.env.REVIEW_ESCALATION_EMAIL
  if (!escalationTo) {
    log.warn('No REVIEW_ESCALATION_EMAIL configured — skipping escalation')
    return
  }

  const subject = `🔴 Review Escalation — Job ${jobId}`
  const html = `
    <h2>Review Timed Out</h2>
    <p>Job <strong>${jobId}</strong> has been awaiting review for more than
       ${process.env.REVIEW_TIMEOUT_MINUTES ?? 240} minutes.</p>
    <p><strong>Customer:</strong> ${job?.customerId ?? 'Unidentified'}</p>
    <p>Please review and process manually.</p>
  `
  await send(subject, html, escalationTo)
}

async function send(subject, html, to = null) {
  const recipient = to ?? process.env.MAIL_TEAM
  if (!recipient) {
    log.warn('No email recipient configured — skipping email', { subject })
    return
  }

  try {
    await getTransporter().sendMail({
      from: process.env.MAIL_FROM ?? 'pdf-order-intelligence@localhost',
      to: recipient,
      subject,
      html
    })
    log.info('Email sent', { subject, to: recipient })
  } catch (err) {
    log.error('Email send failed', { subject, error: err.message })
    throw err
  }
}
