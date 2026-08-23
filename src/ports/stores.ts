import type { CredentialScope } from '../domain/credential.ts'

export type CredentialRecord = {
  id: string
  workspaceId: string
  scope: CredentialScope
  revokedAt: Date | null
}

export interface CredentialStore {
  findByHash(hash: string): Promise<CredentialRecord | null>
  touch(workspaceId: string, id: string): Promise<void>
}

export interface EnablementStore {
  enabledPrefixes(workspaceId: string): Promise<string[]>
  disabledTools(workspaceId: string): Promise<Set<string>>
  enable(workspaceId: string, prefix: string): Promise<void>
  disable(workspaceId: string, prefix: string): Promise<void>
  setToolOverride(workspaceId: string, toolName: string, enabled: boolean): Promise<void>
}

export type StoredFile = { mimeType: string; size: number; bytes: Buffer }

/**
 * Bytes a tool produced that were too large to hand to a model. Written on the
 * way out of a call and read back by id, with a TTL, because this is a handoff
 * between calls rather than somewhere to keep anything.
 */
export interface FileStore {
  put(workspaceId: string, mimeType: string, bytes: Buffer): Promise<string>
  get(workspaceId: string, id: string): Promise<StoredFile | null>
}
