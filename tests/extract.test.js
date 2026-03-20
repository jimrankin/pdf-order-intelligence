/**
 * tests/extract.test.js
 *
 * Unit tests for the extraction and validation pipeline.
 * Uses Node's built-in test runner (node --test).
 *
 * Run: npm test
 */

import { describe, it, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'

// ─── Mock environment ────────────────────────────────────────────────────────
process.env.ANTHROPIC_API_KEY     = 'test-key'
process.env.CONFIDENCE_THRESHOLD  = '0.85'
process.env.CUSTOMER_ID_THRESHOLD = '0.80'
process.env.EXTRACTION_MODEL      = 'claude-opus-4-20250514'
process.env.WEBHOOK_SECRET        = 'test-secret'

// ─── Sample extraction fixtures ──────────────────────────────────────────────

const HIGH_CONFIDENCE_EXTRACTION = {
  extraction_meta: {
    customer_id: 'acorn',
    customer_id_confidence: 0.95,
    source_filename: 'acorn-po-001.pdf',
    extracted_at: '2026-03-20T09:00:00Z',
    overall_confidence: 'high',
    notes: null
  },
  header: {
    customer_po_ref:  { value: 'PO-2026-001', confidence: 0.98 },
    order_date:       { value: '2026-03-20',  confidence: 0.97 },
    delivery_date:    { value: '2026-04-15',  confidence: 0.96 },
    delivery_address: { value: 'Aberdeen, AB21 0GL', confidence: 0.95 },
    currency:         { value: 'GBP', confidence: 1.0 },
    notes:            { value: null, confidence: 1.0 }
  },
  lines: [
    {
      line_no: 1,
      customer_item_ref: { value: 'AIC-4421', confidence: 0.99 },
      description:       { value: 'Steel Bracket 40mm', confidence: 0.98 },
      quantity:          { value: 50, confidence: 0.99 },
      unit_of_measure:   { value: 'EA', confidence: 1.0 },
      unit_price:        { value: 12.40, confidence: 0.97 },
      line_total:        { value: 620.00, confidence: 0.97 },
      flags: []
    },
    {
      line_no: 2,
      customer_item_ref: { value: 'AIC-4422', confidence: 0.99 },
      description:       { value: 'Hex Bolt M8x25', confidence: 0.98 },
      quantity:          { value: 200, confidence: 0.99 },
      unit_of_measure:   { value: 'EA', confidence: 1.0 },
      unit_price:        { value: 0.85, confidence: 0.97 },
      line_total:        { value: 170.00, confidence: 0.97 },
      flags: []
    },
    {
      line_no: 3,
      customer_item_ref: { value: null, confidence: 1.0 },
      description:       { value: 'CARRIAGE', confidence: 1.0 },
      quantity:          { value: 1, confidence: 1.0 },
      unit_of_measure:   { value: 'EA', confidence: 1.0 },
      unit_price:        { value: 15.00, confidence: 1.0 },
      line_total:        { value: 15.00, confidence: 1.0 },
      flags: ['NON_PRODUCT_LINE']
    }
  ],
  totals: {
    subtotal: { value: 790.00, confidence: 0.96 },
    tax:      { value: 158.00, confidence: 0.96 },
    total:    { value: 948.00, confidence: 0.96 }
  }
}

const LOW_CONFIDENCE_EXTRACTION = {
  ...HIGH_CONFIDENCE_EXTRACTION,
  extraction_meta: {
    ...HIGH_CONFIDENCE_EXTRACTION.extraction_meta,
    source_filename: 'acorn-po-002.pdf',
    overall_confidence: 'medium'
  },
  lines: [
    {
      line_no: 1,
      customer_item_ref: { value: 'AIC-??21', confidence: 0.45 },
      description:       { value: 'Steel Bracket 40mm', confidence: 0.90 },
      quantity:          { value: 50, confidence: 0.60 },
      unit_of_measure:   { value: 'EA', confidence: 1.0 },
      unit_price:        { value: 12.40, confidence: 0.90 },
      line_total:        { value: 620.00, confidence: 0.70 },
      flags: ['ITEM_REF_UNCERTAIN', 'QTY_UNCERTAIN']
    }
  ]
}

const CRITICAL_FAIL_EXTRACTION = {
  ...HIGH_CONFIDENCE_EXTRACTION,
  header: {
    ...HIGH_CONFIDENCE_EXTRACTION.header,
    customer_po_ref: { value: null, confidence: 0.0 },
    order_date:      { value: null, confidence: 0.0 }
  }
}

const CUSTOMER_UNIDENTIFIED_EXTRACTION = {
  ...HIGH_CONFIDENCE_EXTRACTION,
  extraction_meta: {
    ...HIGH_CONFIDENCE_EXTRACTION.extraction_meta,
    customer_id: null,
    customer_id_confidence: 0.30,
    source_filename: 'unknown-customer-po.pdf',
    overall_confidence: 'medium'
  }
}

const CUSTOMER_LOW_CONFIDENCE_EXTRACTION = {
  ...HIGH_CONFIDENCE_EXTRACTION,
  extraction_meta: {
    ...HIGH_CONFIDENCE_EXTRACTION.extraction_meta,
    customer_id: 'acorn',
    customer_id_confidence: 0.65,
    source_filename: 'maybe-acorn-po.pdf',
    overall_confidence: 'medium'
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Validation — disposition routing', async () => {
  const { validateExtraction } = await import('../src/validator/validate.js')

  it('routes clean extraction to AUTO', () => {
    const report = validateExtraction(HIGH_CONFIDENCE_EXTRACTION)
    assert.equal(report.disposition, 'AUTO')
    assert.equal(report.issueCount, 0)
  })

  it('routes low-confidence extraction to REVIEW', () => {
    const report = validateExtraction(LOW_CONFIDENCE_EXTRACTION)
    assert.equal(report.disposition, 'REVIEW')
    assert.ok(report.issueCount > 0)
  })

  it('routes critical-fail extraction to REJECT', () => {
    const report = validateExtraction(CRITICAL_FAIL_EXTRACTION)
    assert.equal(report.disposition, 'REJECT')
    assert.ok(report.criticalCount > 0)
  })

  it('ignores NON_PRODUCT_LINE rows in validation', () => {
    // The CARRIAGE line in HIGH_CONFIDENCE_EXTRACTION should not generate issues
    const report = validateExtraction(HIGH_CONFIDENCE_EXTRACTION)
    const carriageIssues = report.issues.filter(i => i.location.includes('line 3'))
    assert.equal(carriageIssues.length, 0)
  })

  it('returns correct issue counts', () => {
    const report = validateExtraction(LOW_CONFIDENCE_EXTRACTION)
    assert.equal(typeof report.issueCount, 'number')
    assert.ok(report.warningCount >= 0)
    assert.ok(report.criticalCount >= 0)
    assert.equal(report.issueCount, report.warningCount + report.criticalCount)
  })
})

describe('Validation — customer identification', async () => {
  const { validateExtraction } = await import('../src/validator/validate.js')

  it('routes CUSTOMER_UNIDENTIFIED (null customer_id) to REVIEW', () => {
    const report = validateExtraction(CUSTOMER_UNIDENTIFIED_EXTRACTION)
    assert.equal(report.disposition, 'REVIEW')
    const custIssue = report.issues.find(i => i.reason === 'CUSTOMER_UNIDENTIFIED')
    assert.ok(custIssue, 'Should have a CUSTOMER_UNIDENTIFIED issue')
    assert.equal(custIssue.severity, 'warning')
    assert.equal(custIssue.confidence, 0.30)
  })

  it('routes low-confidence customer_id (below 0.80) to REVIEW', () => {
    const report = validateExtraction(CUSTOMER_LOW_CONFIDENCE_EXTRACTION)
    assert.equal(report.disposition, 'REVIEW')
    const custIssue = report.issues.find(i => i.reason === 'CUSTOMER_UNIDENTIFIED')
    assert.ok(custIssue, 'Should have a CUSTOMER_UNIDENTIFIED issue even when customer_id is set but confidence is low')
    assert.equal(custIssue.confidence, 0.65)
  })

  it('does NOT flag customer when confidence is above threshold', () => {
    const report = validateExtraction(HIGH_CONFIDENCE_EXTRACTION)
    const custIssue = report.issues.find(i => i.reason === 'CUSTOMER_UNIDENTIFIED')
    assert.equal(custIssue, undefined, 'Should NOT have a CUSTOMER_UNIDENTIFIED issue')
  })
})

describe('Review tokens', async () => {
  const { generateReviewToken, verifyReviewToken } = await import('../src/email/notify.js')

  it('generates and verifies a valid token', () => {
    const payload = { jobId: 'test-123', action: 'approve', customerId: 'acorn' }
    const token   = generateReviewToken(payload)
    const decoded = verifyReviewToken(token)
    assert.deepEqual(decoded, payload)
  })

  it('rejects a tampered token', () => {
    const token = generateReviewToken({ jobId: 'test-123', action: 'approve', customerId: 'acorn' })
    const tampered = token.slice(0, -5) + 'XXXXX'
    assert.throws(() => verifyReviewToken(tampered))
  })
})

describe('Job store', async () => {
  const { jobStore } = await import('../src/utils/jobStore.js')

  it('stores and retrieves a job', () => {
    jobStore.set('job-1', { status: 'awaiting_review', customerId: 'acorn' })
    const job = jobStore.get('job-1')
    assert.equal(job.status, 'awaiting_review')
    assert.equal(job.customerId, 'acorn')
  })

  it('returns null for unknown job', () => {
    assert.equal(jobStore.get('does-not-exist'), null)
  })

  it('updates an existing job', () => {
    jobStore.set('job-2', { status: 'awaiting_review' })
    jobStore.set('job-2', { status: 'complete' })
    assert.equal(jobStore.get('job-2').status, 'complete')
  })

  it('lists all jobs', () => {
    const all = jobStore.all()
    assert.ok(Array.isArray(all))
    assert.ok(all.length >= 2)
  })
})

describe('Customer hints', async () => {
  const {
    customerList,
    getCustomerHints,
    getCustomerListForPrompt,
    getAllHintsForPrompt
  } = await import('../prompts/customerHints.js')

  it('exports a customerList array', () => {
    assert.ok(Array.isArray(customerList))
    assert.ok(customerList.length >= 1)
    assert.ok(customerList[0].id)
    assert.ok(customerList[0].name)
    assert.ok(Array.isArray(customerList[0].identifiers))
  })

  it('returns customer-specific hints for known customer', () => {
    const hints = getCustomerHints('acorn')
    assert.ok(hints.includes('AIC-NNNN'))
  })

  it('returns default hints for unknown customer', () => {
    const hints = getCustomerHints('unknown-customer-xyz')
    assert.ok(hints.includes('Extract all visible line items'))
  })

  it('formats customer list for prompt injection', () => {
    const block = getCustomerListForPrompt()
    assert.ok(block.includes('acorn'))
    assert.ok(block.includes('Acorn Industrial Components'))
  })

  it('formats all hints for prompt injection', () => {
    const block = getAllHintsForPrompt()
    assert.ok(block.includes('Customer: acorn'))
    assert.ok(block.includes('Default'))
  })
})
