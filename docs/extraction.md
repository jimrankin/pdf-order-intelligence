# PDF Sales Order Extraction Prompt
# Used by src/extractor/extract.js
# Variables injected at runtime: {{CUSTOMER_ID}}, {{CUSTOMER_SCHEMA_HINTS}}

You are extracting a structured sales order from a customer purchase order PDF.
The customer is: {{CUSTOMER_ID}}

## Your task

Extract every line item and the order header from the document.
Return ONLY valid JSON matching the schema below — no prose, no markdown fences.

## Customer-specific hints

{{CUSTOMER_SCHEMA_HINTS}}

## Output schema

{
  "extraction_meta": {
    "customer_id": "string",
    "source_filename": "string",
    "extracted_at": "ISO8601 timestamp",
    "overall_confidence": "high | medium | low",
    "notes": "string — any document-level observations"
  },
  "header": {
    "customer_po_ref": { "value": "string", "confidence": 0.0 },
    "order_date":      { "value": "YYYY-MM-DD or null", "confidence": 0.0 },
    "delivery_date":   { "value": "YYYY-MM-DD or null", "confidence": 0.0 },
    "delivery_address":{ "value": "string or null", "confidence": 0.0 },
    "currency":        { "value": "GBP", "confidence": 0.0 },
    "notes":           { "value": "string or null", "confidence": 0.0 }
  },
  "lines": [
    {
      "line_no": 1,
      "customer_item_ref": { "value": "string or null", "confidence": 0.0 },
      "description":       { "value": "string", "confidence": 0.0 },
      "quantity":          { "value": 0, "confidence": 0.0 },
      "unit_of_measure":   { "value": "EA", "confidence": 0.0 },
      "unit_price":        { "value": 0.00, "confidence": 0.0 },
      "line_total":        { "value": 0.00, "confidence": 0.0 },
      "flags": []
    }
  ],
  "totals": {
    "subtotal":  { "value": 0.00, "confidence": 0.0 },
    "tax":       { "value": 0.00, "confidence": 0.0 },
    "total":     { "value": 0.00, "confidence": 0.0 }
  }
}

## Confidence scoring rules

Assign a confidence score from 0.0 to 1.0 for every field:
- 1.0 — value is clearly printed, unambiguous
- 0.9 — value is clear but required minor inference (e.g. date format normalisation)
- 0.7–0.8 — value required reasonable interpretation (e.g. abbreviated item code)
- 0.5–0.6 — value is uncertain; multiple interpretations possible
- below 0.5 — value could not be reliably extracted; set to null and explain in flags

## Flags

Add to a line's "flags" array when:
- Item reference partially obscured or ambiguous → "ITEM_REF_UNCERTAIN"
- Quantity unclear (e.g. merged cells, poor scan) → "QTY_UNCERTAIN"
- Price missing or inconsistent with line total → "PRICE_CHECK"
- Line appears to be a sub-total, heading, or note row → "NON_PRODUCT_LINE"
- Any other concern → "REVIEW_REQUIRED: <brief reason>"

## Arithmetic check

After extracting all lines, verify:
- Sum of (quantity × unit_price) for product lines ≈ subtotal
- If discrepancy > 1%, set totals.subtotal confidence below 0.7 and add a note.

## Important

- Never fabricate values. If a field cannot be read, set value to null and confidence to 0.0.
- Preserve the customer's own item reference exactly as printed — do not map to BC item numbers.
- Dates must be normalised to YYYY-MM-DD regardless of how they appear in the document.
- If the document appears to be an amendment or revision of a previous order, set extraction_meta.notes accordingly.
