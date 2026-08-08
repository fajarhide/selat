import type { CredentialScope } from '../domain/credential.ts'

export type CredentialRecord = {
  id: string
  workspaceId: string
  scope: CredentialScope
  revokedAt: Date | null
}

export interface CredentialStore {
  findByHash(hash: string): Promise<CredentialRecord | null>
  touch(id: string): Promise<void>
}

export interface EnablementStore {
  enabledPrefixes(workspaceId: string): Promise<string[]>
  disabledTools(workspaceId: string): Promise<Set<string>>
  enable(workspaceId: string, prefix: string): Promise<void>
  disable(workspaceId: string, prefix: string): Promise<void>
}
