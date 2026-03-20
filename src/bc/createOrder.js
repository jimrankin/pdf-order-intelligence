/**
 * src/bc/createOrder.js
 *
 * Creates a sales order in Business Central via the BC API v2.0.
 *
 * Flow:
 *   1. Resolve customer ID to BC customer record
 *   2. Create sales order header
 *   3. Add sales order lines
 *   4. Return BC order number + ID
 */

import { log } from '../utils/logger.js'

const BC_BASE_URL  = () => process.env.BC_BASE_URL
const BC_COMPANY_ID = () => process.env.BC_COMPANY_ID

/**
 * Get authorization headers for BC API calls.
 */
function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.BC_API_KEY}`
  }
}

/**
 * Resolve a pipeline customer ID to a BC customer record.
 * Matches on the BC Customer "Code" / "number" field.
 *
 * @param {string} customerId - Pipeline customer ID (e.g. 'acorn')
 * @returns {Promise<object>} BC customer record
 */
async function resolveCustomer(customerId) {
  if (!customerId) {
    throw new Error('Cannot create BC order — customer ID is null')
  }

  const url = `${BC_BASE_URL()}/companies(${BC_COMPANY_ID()})/customers?$filter=number eq '${customerId}'`

  const res = await fetch(url, { headers: getAuthHeaders() })
  if (!res.ok) {
    throw new Error(`BC customer lookup failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  const customer = data.value?.[0]

  if (!customer) {
    throw new Error(`BC customer not found for ID: ${customerId}`)
  }

  log.info('BC customer resolved', { customerId, bcCustomerId: customer.id, name: customer.displayName })
  return customer
}

/**
 * Create a sales order in Business Central.
 *
 * @param {object} extraction     - Extraction result from Claude
 * @param {string} customerId     - Resolved customer ID
 * @param {string|null} approvedBy - Reviewer email if manually approved
 * @returns {Promise<object>}     - { orderNumber, orderId, lineCount }
 */
export async function createBCSalesOrder(extraction, customerId, approvedBy) {
  log.info('Creating BC sales order', { customerId, approvedBy })

  // 1. Resolve customer
  const bcCustomer = await resolveCustomer(customerId)

  // 2. Create order header
  const orderPayload = {
    customerId: bcCustomer.id,
    externalDocumentNumber: extraction.header?.customer_po_ref?.value ?? '',
    orderDate: extraction.header?.order_date?.value ?? new Date().toISOString().slice(0, 10),
    requestedDeliveryDate: extraction.header?.delivery_date?.value ?? null
  }

  const orderRes = await fetch(
    `${BC_BASE_URL()}/companies(${BC_COMPANY_ID()})/salesOrders`,
    {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(orderPayload)
    }
  )

  if (!orderRes.ok) {
    const err = await orderRes.text()
    throw new Error(`BC order creation failed: ${orderRes.status} — ${err}`)
  }

  const order = await orderRes.json()
  log.info('BC order header created', { orderNumber: order.number, orderId: order.id })

  // 3. Add order lines
  const productLines = (extraction.lines ?? [])
    .filter(l => !l.flags?.includes('NON_PRODUCT_LINE'))

  let lineCount = 0
  for (const line of productLines) {
    const linePayload = {
      lineType: 'Item',
      description: line.description?.value ?? 'Unknown item',
      quantity: line.quantity?.value ?? 0,
      unitPrice: line.unit_price?.value ?? 0,
      unitOfMeasureCode: line.unit_of_measure?.value ?? 'EA'
    }

    const lineRes = await fetch(
      `${BC_BASE_URL()}/companies(${BC_COMPANY_ID()})/salesOrders(${order.id})/salesOrderLines`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(linePayload)
      }
    )

    if (!lineRes.ok) {
      const err = await lineRes.text()
      log.error('BC order line creation failed', {
        orderNumber: order.number,
        lineNo: line.line_no,
        error: err
      })
      // Continue — don't fail the whole order for one bad line
    } else {
      lineCount++
    }
  }

  log.info('BC sales order complete', { orderNumber: order.number, lineCount })

  return {
    orderNumber: order.number,
    orderId: order.id,
    lineCount,
    customerId,
    approvedBy
  }
}
