import type { FileStore, StoredFile } from '../../ports/stores.ts'
import type { Pool } from './pool.ts'

/** Long enough for an agent to hand the id to the next call, short enough that
 *  the gateway is not quietly storing anybody's documents. */
const TTL = '24 hours'

/** A workspace cannot park more than this at once. The sweep below runs on
 *  write, so the ceiling is on what is live rather than on what was ever
 *  written. ponytail: one number for every plan, split when a plan pays for it. */
const QUOTA_BYTES = 200 * 1024 * 1024

export function fileStore(pool: Pool): FileStore {
  return {
    async put(workspaceId, mimeType, bytes) {
      // Expired rows go before the quota is measured, so yesterday's downloads
      // cannot refuse today's.
      await pool.query(`DELETE FROM files WHERE created_at <= now() - interval '${TTL}'`)

      const { rows } = await pool.query<{ held: string }>(
        'SELECT coalesce(sum(size), 0) AS held FROM files WHERE workspace_id = $1',
        [workspaceId],
      )
      const held = Number(rows[0]?.held ?? 0)
      if (held + bytes.length > QUOTA_BYTES) {
        throw new Error(`file quota reached: ${held} bytes held, ${bytes.length} more requested`)
      }

      const inserted = await pool.query<{ id: string }>(
        'INSERT INTO files (workspace_id, mime_type, size, bytes) VALUES ($1, $2, $3, $4) RETURNING id',
        [workspaceId, mimeType, bytes.length, bytes],
      )
      return inserted.rows[0]!.id
    },

    async get(workspaceId, id) {
      const { rows } = await pool.query<{ mime_type: string; size: number; bytes: unknown }>(
        `SELECT mime_type, size, bytes FROM files
         WHERE id = $1 AND workspace_id = $2 AND created_at > now() - interval '${TTL}'`,
        [id, workspaceId],
      )
      const row = rows[0]
      if (!row) return null
      // pg hands back a Buffer and PGlite a Uint8Array, and only one of those
      // has the methods the callers use.
      return {
        mimeType: row.mime_type,
        size: row.size,
        bytes: Buffer.from(row.bytes as Uint8Array),
      } satisfies StoredFile
    },
  }
}
