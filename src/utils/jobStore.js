/**
 * src/utils/jobStore.js
 *
 * In-memory job store for tracking pipeline jobs.
 * TODO: Replace with Azure Table Storage or SQLite for persistence.
 */

const store = new Map()

export const jobStore = {
  /**
   * Store or update a job.
   * @param {string} jobId
   * @param {object} data
   */
  set(jobId, data) {
    store.set(jobId, { ...data, updatedAt: Date.now() })
  },

  /**
   * Retrieve a job by ID.
   * @param {string} jobId
   * @returns {object|null}
   */
  get(jobId) {
    return store.get(jobId) ?? null
  },

  /**
   * List all jobs (for debugging / admin).
   * @returns {Array<{jobId: string, data: object}>}
   */
  all() {
    return [...store.entries()].map(([jobId, data]) => ({ jobId, ...data }))
  },

  /**
   * Delete a job.
   * @param {string} jobId
   */
  delete(jobId) {
    store.delete(jobId)
  },

  /** Clear all jobs (useful in tests). */
  clear() {
    store.clear()
  }
}
