/**
 * prompts/customerHints.js
 *
 * Per-customer layout guidance AND a known customer list for identification.
 *
 * customerList — used by the extraction prompt so Claude can identify which
 *   customer a PDF belongs to by matching company names, email domains,
 *   PO reference prefixes, logos, etc.
 *
 * customerHints — per-customer layout quirks injected once the customer
 *   has been identified (or all hints injected so the model can self-select).
 */

// ─── Known Customer List ─────────────────────────────────────────────────────
// Each entry gives Claude identifiers to match against the document content.

export const customerList = [
  {
    id: 'acorn',
    name: 'Acorn Industrial Components',
    identifiers: [
      'Acorn Industrial',
      'Acorn Industrial Components',
      'acornic.co.uk',
      'AIC-'
    ]
  },
  {
    id: 'customer2',
    name: 'Customer Two Ltd',
    identifiers: [
      'Customer Two',
      'customer2.com'
    ]
  },
  {
    id: 'customer3',
    name: 'Customer Three plc',
    identifiers: [
      'Customer Three',
      'SUP-'
    ]
  }
  // Add further customers here
]

// ─── Per-Customer Layout Hints ───────────────────────────────────────────────
// Keys must match the `id` field in customerList.

export const customerHints = {

  acorn: `
- Item references follow the pattern AIC-NNNN (4-digit numeric suffix).
- The PO reference is labelled "Order No." in the header, top-right.
- Delivery date is labelled "Required Delivery" — this is the date needed in BC.
- Unit prices are always GBP excluding VAT.
- Ignore any row where the Description column contains "TOTAL", "SUBTOTAL", or is blank.
- The document sometimes includes a "Carriage" line — treat this as a non-product line (NON_PRODUCT_LINE).
  `,

  customer2: `
- PO reference is in a barcode field at the top — read the text below the barcode, not the barcode itself.
- Quantities may be expressed as decimals (e.g. 2.5 metres).
- Unit of measure is printed in parentheses after the description, e.g. "Steel Rod (MTR)".
  `,

  customer3: `
- This customer uses a two-page format: page 1 is header/terms, page 2 contains all line items.
- Item references are prefixed "SUP-" followed by our own BC item number — extract the BC item number portion only.
- Prices are inclusive of VAT at 20%; back-calculate the ex-VAT price.
  `,

  _default: `
- Extract all visible line items.
- If the PO reference cannot be found, look for any reference beginning with "PO", "ORD", or a 6+ digit number.
- Treat any row without a quantity or price as a non-product line.
  `
}

/**
 * Returns the hint string for a given customer ID,
 * falling back to _default if no specific hint exists.
 */
export function getCustomerHints(customerId) {
  return customerHints[customerId] ?? customerHints._default
}

/**
 * Formats the known customer list as a string block for prompt injection.
 * The model uses this to identify which customer issued the PDF.
 */
export function getCustomerListForPrompt() {
  return customerList.map(c =>
    `- ID: "${c.id}" | Name: "${c.name}" | Look for: ${c.identifiers.map(i => `"${i}"`).join(', ')}`
  ).join('\n')
}

/**
 * Formats ALL customer hints (keyed by ID) for prompt injection.
 * Allows the model to self-select the relevant hints once it identifies the customer.
 */
export function getAllHintsForPrompt() {
  return Object.entries(customerHints)
    .filter(([key]) => key !== '_default')
    .map(([id, hints]) => `### Customer: ${id}\n${hints.trim()}`)
    .join('\n\n') +
    `\n\n### Default (if customer not matched above)\n${customerHints._default.trim()}`
}
