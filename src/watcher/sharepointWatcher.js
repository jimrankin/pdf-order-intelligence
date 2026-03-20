/**
 * src/watcher/sharepointWatcher.js
 *
 * Polls a SINGLE SharePoint folder via MS Graph for new PDF files.
 * When a new file is detected, downloads it and passes to runPipeline().
 *
 * This is a swappable trigger module — the pipeline is trigger-agnostic.
 * A future email watcher can replace this by calling runPipeline(buffer, filename)
 * in the same way.
 */

import { runPipeline } from '../router/pipeline.js'
import { log } from '../utils/logger.js'

// Track processed files to avoid re-processing
const processedFiles = new Set()

/**
 * Acquire an MS Graph access token using client credentials.
 */
async function getGraphToken() {
  const tenantId    = process.env.GRAPH_TENANT_ID
  const clientId    = process.env.GRAPH_CLIENT_ID
  const clientSecret = process.env.GRAPH_CLIENT_SECRET

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default'
    })
  })

  if (!res.ok) {
    throw new Error(`Graph token request failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()
  return data.access_token
}

/**
 * List files in the watched SharePoint folder.
 *
 * @param {string} accessToken
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function listFolderFiles(accessToken) {
  const siteId = process.env.SHAREPOINT_SITE_ID
  const folderPath = process.env.WATCH_FOLDER ?? 'customers/incoming'

  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${folderPath}:/children`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (!res.ok) {
    throw new Error(`SharePoint folder listing failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json()

  // Only return PDF files
  return (data.value ?? [])
    .filter(item => item.name?.toLowerCase().endsWith('.pdf'))
    .map(item => ({ id: item.id, name: item.name, downloadUrl: item['@microsoft.graph.downloadUrl'] }))
}

/**
 * Download a file from SharePoint by its download URL.
 *
 * @param {string} downloadUrl
 * @returns {Promise<Buffer>}
 */
async function downloadFile(downloadUrl) {
  const res = await fetch(downloadUrl)
  if (!res.ok) {
    throw new Error(`File download failed: ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Run one poll cycle: list files, process any new ones.
 */
async function pollOnce() {
  try {
    const token = await getGraphToken()
    const files = await listFolderFiles(token)

    for (const file of files) {
      if (processedFiles.has(file.id)) continue

      log.info('New PDF detected', { filename: file.name, fileId: file.id })
      processedFiles.add(file.id)

      try {
        const buffer = await downloadFile(file.downloadUrl)
        await runPipeline(buffer, file.name)
      } catch (err) {
        log.error('Pipeline failed for file', {
          filename: file.name,
          fileId: file.id,
          error: err.message
        })
        // Don't remove from processedFiles — avoid retrying a broken file in a loop
      }
    }
  } catch (err) {
    log.error('Poll cycle failed', { error: err.message })
  }
}

/**
 * Start the SharePoint folder watcher.
 * Polls at the interval specified by POLL_INTERVAL_SECONDS.
 *
 * @returns {{ stop: () => void }} - Call stop() to halt polling
 */
export function startWatcher() {
  const intervalSeconds = parseInt(process.env.POLL_INTERVAL_SECONDS ?? '60')

  log.info('SharePoint watcher started', {
    folder: process.env.WATCH_FOLDER ?? 'customers/incoming',
    intervalSeconds
  })

  // Run immediately on start
  pollOnce()

  const intervalId = setInterval(pollOnce, intervalSeconds * 1000)

  return {
    stop() {
      clearInterval(intervalId)
      log.info('SharePoint watcher stopped')
    }
  }
}
