/**
 * src/extractor/extract.js
 *
 * Converts a PDF to images, sends to Claude with the extraction prompt,
 * and returns a structured ExtractionResult.
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs/promises'
import path from 'path'
import { readFileSync } from 'fs'
import { getCustomerHints } from '../../prompts/customerHints.js'
import { log } from '../utils/logger.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const PROMPT_TEMPLATE = readFileSync(
  new URL('../../prompts/extraction.md', import.meta.url),
  'utf8'
)

/**
 * Convert a PDF buffer to an array of base64-encoded PNG images (one per page).
 * Uses pdfjs-dist for rendering.
 */
async function pdfToImages(pdfBuffer) {
  // Dynamic import — pdfjs-dist is ESM
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) })
  const pdfDoc = await loadingTask.promise
  const images = []

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum)
    const viewport = page.getViewport({ scale: 2.0 }) // 2× for clarity

    // Node canvas shim — requires 'canvas' package if not available
    // Falls back to returning null pages which triggers text-only extraction
    try {
      const { createCanvas } = await import('canvas')
      const canvas = createCanvas(viewport.width, viewport.height)
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      const dataUrl = canvas.toDataURL('image/png')
      images.push(dataUrl.split(',')[1]) // base64 only
    } catch {
      log.warn(`Canvas not available for page ${pageNum} — using text extraction fallback`)
      images.push(null)
    }
  }

  return images
}

/**
 * Extract text content from a PDF as a fallback when image rendering isn't available.
 */
async function pdfToText(pdfBuffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) })
  const pdfDoc = await loadingTask.promise
  let fullText = ''

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum)
    const textContent = await page.getTextContent()
    const pageText = textContent.items.map(item => item.str).join(' ')
    fullText += `\n--- PAGE ${pageNum} ---\n${pageText}`
  }

  return fullText
}

/**
 * Build the message content array for Claude.
 * Prefers image-based extraction; falls back to text.
 */
async function buildMessageContent(pdfBuffer, customerId, filename) {
  const hints = getCustomerHints(customerId)
  const prompt = PROMPT_TEMPLATE
    .replace('{{CUSTOMER_ID}}', customerId)
    .replace('{{CUSTOMER_SCHEMA_HINTS}}', hints)

  let images
  try {
    images = await pdfToImages(pdfBuffer)
  } catch (err) {
    log.warn('Image extraction failed, falling back to text', { error: err.message })
    images = []
  }

  const hasImages = images.some(img => img !== null)

  if (hasImages) {
    const imageBlocks = images
      .filter(Boolean)
      .map(base64 => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: base64 }
      }))

    return [
      ...imageBlocks,
      {
        type: 'text',
        text: `Filename: ${filename}\n\n${prompt}`
      }
    ]
  }

  // Text fallback
  const text = await pdfToText(pdfBuffer)
  return [
    {
      type: 'text',
      text: `Filename: ${filename}\n\nDocument text content:\n${text}\n\n${prompt}`
    }
  ]
}

/**
 * Main extraction function.
 *
 * @param {Buffer} pdfBuffer  - Raw PDF file buffer
 * @param {string} customerId - Customer folder/ID key
 * @param {string} filename   - Original filename for metadata
 * @returns {Promise<object>} - Parsed extraction result JSON
 */
export async function extractOrder(pdfBuffer, customerId, filename) {
  log.info('Starting extraction', { customerId, filename })

  const content = await buildMessageContent(pdfBuffer, customerId, filename)

  const response = await client.messages.create({
    model: process.env.EXTRACTION_MODEL ?? 'claude-opus-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content }]
  })

  const rawText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  // Strip any accidental markdown fences
  const cleaned = rawText.replace(/^```json\s*/m, '').replace(/\s*```$/m, '').trim()

  let result
  try {
    result = JSON.parse(cleaned)
  } catch (err) {
    log.error('Failed to parse extraction JSON', { error: err.message, raw: rawText.slice(0, 500) })
    throw new Error(`Extraction returned invalid JSON: ${err.message}`)
  }

  // Stamp source filename if not set by model
  if (!result.extraction_meta?.source_filename) {
    result.extraction_meta = { ...result.extraction_meta, source_filename: filename }
  }

  log.info('Extraction complete', {
    customerId,
    filename,
    lineCount: result.lines?.length ?? 0,
    overallConfidence: result.extraction_meta?.overall_confidence
  })

  return result
}
