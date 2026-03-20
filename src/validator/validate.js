/**
 * src/validator/validate.js
 *
 * Validates an extraction result against the BC order schema.
 * Returns a ValidationReport indicating whether the order can be
 * auto-created, needs human review, or must be hard-rejected.
 *
 * Now includes CUSTOMER_UNIDENTIFIED check — if the model could not
 * identify the customer with sufficient confidence, the order routes
 * to REVIEW (not REJECT) so a human can confirm the customer.
 */

import { log } from '../utils/logger.js'

const CONFIDENCE_THRESHOLD    = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.85')
const CUSTOMER_ID_THRESHOLD   = parseFloat(process.env.CUSTOMER_ID_THRESHOLD ?? '0.80')

/**
 * @typedef {'AUTO' | 'REVIEW' | 'REJECT'} Disposition
 *
 * AUTO   — all fields meet threshold; create BC order immediately
 * REVIEW — some fields below threshold; send for human review
 * REJECT — critical fields missing or document unreadable
 */

/**
 * Required header fields and their minimum confidence to allow AUTO.
 */
const REQUIRED_HEADER_FIELDS = [
  'customer_po_ref',
  'order_date',
  'delivery_date'
]

const CRITICAL_LINE_FIELDS = ['description', 'quantity', 'unit_price']

/**
 * Validate a single extracted field object { value, confidence }.
 */
function fieldOk(field) {
  if (!field) return false
  if (field.value === null || field.value === undefined) return false
  return field.confidence >= CONFIDENCE_THRESHOLD
}

/**
 * Collect all low-confidence or flagged issues across an extraction result.
 * Returns an array of issue objects.
 */
function collectIssues(result) {
  const issues = []

  // ── Customer identification check ───────────────────────────────────────
  const meta = result.extraction_meta ?? {}
  const custId = meta.customer_id
  const custConf = meta.customer_id_confidence ?? 0

  if (!custId || custConf < CUSTOMER_ID_THRESHOLD) {
    issues.push({
      location: 'extraction_meta.customer_id',
      severity: 'warning', // routes to REVIEW, not REJECT
      reason: 'CUSTOMER_UNIDENTIFIED',
      confidence: custConf,
      value: custId ?? null
    })
  }

  // ── Header checks ──────────────────────────────────────────────────────
  for (const key of REQUIRED_HEADER_FIELDS) {
    const field = result.header?.[key]
    if (!field || field.value === null) {
      issues.push({
        location: `header.${key}`,
        severity: 'critical',
        reason: 'Field missing or null',
        confidence: field?.confidence ?? 0
      })
    } else if (field.confidence < CONFIDENCE_THRESHOLD) {
      issues.push({
        location: `header.${key}`,
        severity: 'warning',
        reason: `Low confidence: ${field.confidence.toFixed(2)}`,
        confidence: field.confidence,
        value: field.value
      })
    }
  }

  // ── Line checks ────────────────────────────────────────────────────────
  for (const line of result.lines ?? []) {
    // Skip non-product lines
    if (line.flags?.includes('NON_PRODUCT_LINE')) continue

    for (const key of CRITICAL_LINE_FIELDS) {
      const field = line[key]
      if (!field || field.value === null) {
        issues.push({
          location: `line ${line.line_no}.${key}`,
          severity: 'critical',
          reason: 'Field missing or null',
          confidence: 0,
          lineNo: line.line_no
        })
      } else if (field.confidence < CONFIDENCE_THRESHOLD) {
        issues.push({
          location: `line ${line.line_no}.${key}`,
          severity: 'warning',
          reason: `Low confidence: ${field.confidence.toFixed(2)}`,
          confidence: field.confidence,
          value: field.value,
          lineNo: line.line_no
        })
      }
    }

    // Explicit model flags
    for (const flag of line.flags ?? []) {
      if (!['NON_PRODUCT_LINE'].includes(flag)) {
        issues.push({
          location: `line ${line.line_no}`,
          severity: 'warning',
          reason: flag,
          lineNo: line.line_no
        })
      }
    }
  }

  // ── Totals check ───────────────────────────────────────────────────────
  const totals = result.totals
  if (totals?.subtotal?.confidence < 0.7) {
    issues.push({
      location: 'totals.subtotal',
      severity: 'warning',
      reason: `Arithmetic check failed or low confidence: ${totals.subtotal.confidence?.toFixed(2)}`,
      confidence: totals.subtotal.confidence
    })
  }

  return issues
}

/**
 * Determine disposition from issues list.
 */
function determineDisposition(issues) {
  const hasCritical = issues.some(i => i.severity === 'critical')
  const hasWarning  = issues.some(i => i.severity === 'warning')

  if (hasCritical) return 'REJECT'
  if (hasWarning)  return 'REVIEW'
  return 'AUTO'
}

/**
 * Main validation entry point.
 *
 * @param {object} extractionResult - Output from extractOrder()
 * @returns {object} ValidationReport
 */
export function validateExtraction(extractionResult) {
  const issues = collectIssues(extractionResult)
  const disposition = determineDisposition(issues)

  const report = {
    disposition,
    threshold: CONFIDENCE_THRESHOLD,
    customerIdThreshold: CUSTOMER_ID_THRESHOLD,
    issueCount: issues.length,
    criticalCount: issues.filter(i => i.severity === 'critical').length,
    warningCount:  issues.filter(i => i.severity === 'warning').length,
    issues,
    extraction: extractionResult
  }

  log.info('Validation complete', {
    disposition,
    issueCount: issues.length,
    customerId: extractionResult.extraction_meta?.customer_id ?? 'UNIDENTIFIED',
    filename: extractionResult.extraction_meta?.source_filename
  })

  return report
}
