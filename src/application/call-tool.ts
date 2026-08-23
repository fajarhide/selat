import { assertScopeAllows, type CredentialScope } from '../domain/credential.ts'
import { GatewayError } from '../domain/errors.ts'
import { parseToolName } from '../domain/tool-names.ts'
import type { Registry, ToolResult } from '../adapters/providers/registry.ts'
import type { EnablementStore, FileStore } from '../ports/stores.ts'

export interface GrantResolver {
  accessTokenFor(workspaceId: string, grantId: string): Promise<string | null>
}

export interface IdempotencyStore {
  get(workspaceId: string, key: string): Promise<ToolResult | null>
  put(workspaceId: string, key: string, result: ToolResult): Promise<void>
}

export type CallDeps = {
  registry: Registry
  enablement: EnablementStore
  grants: GrantResolver
  idempotency: IdempotencyStore
  /** Absent leaves every binary result inline, which is what the tests and the
   *  conformance suite want. A server passes one. */
  files?: FileStore
  /** Per-call budget. The upstream is abandoned past this, with upstream_timeout. */
  timeoutMs?: number
}

export type CallInput = {
  workspaceId: string
  scope: CredentialScope
  name: string
  args: unknown
  requestId: string
  idempotencyKey?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function callTool(deps: CallDeps, input: CallInput): Promise<ToolResult> {
  const { prefix, tool } = parseToolName(input.name)
  const adapter = deps.registry.get(prefix)

  const definition = adapter.listTools().find((candidate) => candidate.name === tool)
  if (!definition) {
    throw new GatewayError('tool_not_found', `unknown tool: ${input.name}`, { provider: prefix })
  }

  assertScopeAllows(input.scope, prefix, definition.write)

  const enabled = await deps.enablement.enabledPrefixes(input.workspaceId)
  if (!enabled.includes(prefix)) {
    throw new GatewayError('provider_not_connected', `${prefix} is not connected`, {
      provider: prefix,
    })
  }
  const disabled = await deps.enablement.disabledTools(input.workspaceId)
  if (disabled.has(input.name)) {
    throw new GatewayError('tool_not_found', `${input.name} is disabled for this workspace`, {
      provider: prefix,
    })
  }

  // Only writes are replayed. Replaying a read would serve stale data to a
  // client that simply reused a key.
  const replayable = Boolean(input.idempotencyKey) && definition.write
  if (replayable) {
    const replay = await deps.idempotency.get(input.workspaceId, input.idempotencyKey!)
    if (replay) return replay
  }

  const accessToken = await deps.grants.accessTokenFor(input.workspaceId, adapter.grantId)
  // Enabling a provider and connecting an account are separate steps, so a
  // workspace can reach here with no grant at all. Without this the null token
  // goes upstream as `Bearer null` and the vendor's 401 comes back as
  // reauth_required, which sends someone to repair a connection they never made.
  if (accessToken === null && adapter.credential !== 'none') {
    throw new GatewayError('provider_not_connected', `${prefix} has no connected account`, {
      provider: prefix,
    })
  }

  let result: ToolResult
  try {
    result = await withTimeout(
      adapter.callTool(
        {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          accessToken,
          fetch,
          ...(deps.files
            ? {
                readFile: async (workspaceId: string, id: string) => {
                  const found = await deps.files!.get(workspaceId, id)
                  return found ? { mimeType: found.mimeType, bytes: found.bytes } : null
                },
              }
            : {}),
        },
        tool,
        input.args,
      ),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      prefix,
    )
  } catch (err) {
    if (err instanceof GatewayError) throw err
    throw adapter.mapError(err)
  }

  result = await handOffLargeBytes(deps, input.workspaceId, result)

  if (replayable) {
    await deps.idempotency.put(input.workspaceId, input.idempotencyKey!, result)
  }
  return result
}

/** Base64 costs four bytes for every three and a model pays for every one of
 *  them, so anything past this is stored and answered as a reference instead.
 *  Below it, inline is still the better answer: a small text file is most
 *  useful read rather than fetched. */
const INLINE_LIMIT = 256 * 1024

type BinaryContent = { mime_type: string; size: number; data: string }

/**
 * The executor has no store and should not: it turns a response into a result
 * and nothing else. Whether those bytes are small enough to hand to a model is
 * a question about this deployment, so it is answered here.
 */
async function handOffLargeBytes(
  deps: CallDeps,
  workspaceId: string,
  result: ToolResult,
): Promise<ToolResult> {
  if (!result.binary || !deps.files) return result
  const content = result.content as BinaryContent
  if (content.size <= INLINE_LIMIT) return result

  const id = await deps.files.put(
    workspaceId,
    content.mime_type,
    Buffer.from(content.data, 'base64'),
  )
  // No longer binary: what comes back is metadata, and a surface that would
  // have emitted an image block should emit this as the JSON it is.
  return {
    ...result,
    binary: false,
    content: {
      file_id: id,
      mime_type: content.mime_type,
      size: content.size,
      note: 'Too large to inline. Fetch it at GET /v1/files/{file_id}, or hand the id to a tool that takes one. Available for 24 hours.',
    },
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, provider: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new GatewayError('upstream_timeout', `${provider} exceeded ${ms}ms`, { provider }),
            ),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
