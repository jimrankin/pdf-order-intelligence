/**
 * prompts/customerHints.js
 *
 * Per-customer layout guidance injected into the extraction prompt at runtime.
 * Add a new entry for each customer whose PDF has known quirks.
 *
 * Keys must match the folder name used in WATCH_FOLDERS.
 */

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

  // Add further customers here
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
