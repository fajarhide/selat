import { describe, expect, it } from 'vitest'
import { callTool, type CallDeps } from '../src/application/call-tool.ts'
import { createRegistry } from '../src/adapters/providers/registry.ts'
import { manifestProvider } from '../src/adapters/providers/manifest.ts'
import { createEmbeddedPool } from '../src/adapters/db/embedded.ts'
import { runMigrations } from '../src/adapters/db/pool.ts'
import { fileStore } from '../src/adapters/db/file-store.ts'
import { fakeUpstream } from './helpers/fake-upstream.ts'
import type { FileStore } from '../src/ports/stores.ts'

const bytes = (n: number) => 'x'.repeat(n)

function provider(payload: string) {
  const upstream = fakeUpstream([
    { match: /blob/, raw: payload, headers: { 'content-type': 'application/pdf' } },
  ])
  const adapter = manifestProvider({
    id: 'demo',
    prefix: 'demo',
    maturity: 'experimental',
    baseUrl: 'https://api.demo.test',
    scopes: [],
    auth: { type: 'bearer' },
    tools: [
      {
        name: 'download',
        description: 'Download one blob',
        write: false,
        request: 'GET /blob',
        binary: true,
        args: {},
      },
    ],
  })
  // The executor reaches the network through the context, so the double is
  // installed by wrapping the adapter rather than by patching global fetch.
  return {
    ...adapter,
    callTool: (ctx: Parameters<typeof adapter.callTool>[0], name: string, args: unknown) =>
      adapter.callTool({ ...ctx, fetch: upstream.fetch }, name, args),
  }
}

function deps(files: FileStore | undefined, payload: string): CallDeps {
  return {
    registry: createRegistry([provider(payload)]),
    enablement: {
      async enabledPrefixes() { return ['demo'] },
      async disabledTools() { return new Set<string>() },
      async enable() {},
      async disable() {},
      async setToolOverride() {},
    },
    grants: { async accessTokenFor() { return 'token' } },
    idempotency: { async get() { return null }, async put() {} },
    ...(files ? { files } : {}),
  }
}

const call = { workspaceId: '', scope: { providers: null, readOnly: false }, requestId: 'r1' }

describe('large downloads become a file handle', () => {
  it('stores anything past the inline limit and answers with an id', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const files = fileStore(pool)
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('a') RETURNING id",
    )
    const workspaceId = rows[0]!.id

    const payload = bytes(300 * 1024)
    const result = await callTool(deps(files, payload), {
      ...call,
      workspaceId,
      name: 'demo__download',
      args: {},
    })

    const content = result.content as { file_id: string; mime_type: string; size: number }
    expect(result.binary).toBe(false)
    expect(content.mime_type).toBe('application/pdf')
    expect(content.size).toBe(payload.length)
    // The point of the whole change: the bytes are not in the answer.
    expect(JSON.stringify(result.content).length).toBeLessThan(500)

    const stored = await files.get(workspaceId, content.file_id)
    expect(stored?.bytes.toString()).toBe(payload)
    await pool.end()
  })

  it('leaves a small one inline, because a short file is more use read than fetched', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('a') RETURNING id",
    )
    const payload = 'a short document'
    const result = await callTool(deps(fileStore(pool), payload), {
      ...call,
      workspaceId: rows[0]!.id,
      name: 'demo__download',
      args: {},
    })
    expect(result.binary).toBe(true)
    const content = result.content as { data: string }
    expect(Buffer.from(content.data, 'base64').toString()).toBe(payload)
    await pool.end()
  })

  it('refuses a file id belonging to another workspace', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const files = fileStore(pool)
    const made = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('a'), ('b') RETURNING id",
    )
    const [a, b] = made.rows.map((row) => row.id)
    const id = await files.put(a!, 'text/plain', Buffer.from('theirs'))

    expect((await files.get(a!, id))?.bytes.toString()).toBe('theirs')
    expect(await files.get(b!, id)).toBeNull()
    await pool.end()
  })
})

describe('an upload can name a file the gateway already holds', () => {
  function uploader() {
    const upstream = fakeUpstream([{ match: /upload/, body: { id: 'new', name: 'copy.txt' } }])
    const adapter = manifestProvider({
      id: 'demo',
      prefix: 'demo',
      maturity: 'experimental',
      baseUrl: 'https://api.demo.test',
      scopes: [],
      auth: { type: 'bearer' },
      tools: [
        {
          name: 'put',
          description: 'Upload one thing',
          write: true,
          request: 'POST /upload/things',
          upload: { content: 'content', mimeType: 'mime_type', fileId: 'from_file' },
          args: {
            name: { type: 'string', required: true },
            content: { type: 'base64' },
            from_file: { type: 'string' },
            mime_type: { type: 'string' },
          },
        },
      ],
    })
    return { upstream, adapter }
  }

  function withStore(adapter: ReturnType<typeof manifestProvider>, files: FileStore): CallDeps {
    return {
      registry: createRegistry([adapter]),
      enablement: {
        async enabledPrefixes() { return ['demo'] },
        async disabledTools() { return new Set<string>() },
        async enable() {},
        async disable() {},
        async setToolOverride() {},
      },
      grants: { async accessTokenFor() { return 'token' } },
      idempotency: { async get() { return null }, async put() {} },
      files,
    }
  }

  it('sends the stored bytes and its media type, without the caller holding either', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const files = fileStore(pool)
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('a') RETURNING id",
    )
    const workspaceId = rows[0]!.id
    const stored = await files.put(workspaceId, 'application/pdf', Buffer.from('%PDF-1.7 body'))

    const { upstream, adapter } = uploader()
    const wrapped = {
      ...adapter,
      callTool: (c: Parameters<typeof adapter.callTool>[0], n: string, a: unknown) =>
        adapter.callTool({ ...c, fetch: upstream.fetch }, n, a),
    }
    await callTool(withStore(wrapped, files), {
      ...call,
      workspaceId,
      name: 'demo__put',
      args: { name: 'copy.txt', from_file: stored },
    })

    const sent = Buffer.from(upstream.calls[0]?.init?.body as Uint8Array).toString()
    expect(sent).toContain('%PDF-1.7 body')
    expect(sent).toContain('content-type: application/pdf')
    // The id named a file; it is not a field the upstream ever sees.
    expect(sent).not.toContain('from_file')
    await pool.end()
  })

  it('refuses a file id from another workspace, and one that is neither given', async () => {
    const pool = createEmbeddedPool()
    await runMigrations(pool)
    const files = fileStore(pool)
    const made = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name) VALUES ('a'), ('b') RETURNING id",
    )
    const [a, b] = made.rows.map((row) => row.id)
    const stored = await files.put(a!, 'text/plain', Buffer.from('theirs'))

    const { upstream, adapter } = uploader()
    const wrapped = {
      ...adapter,
      callTool: (c: Parameters<typeof adapter.callTool>[0], n: string, x: unknown) =>
        adapter.callTool({ ...c, fetch: upstream.fetch }, n, x),
    }
    const deps = withStore(wrapped, files)

    await expect(
      callTool(deps, { ...call, workspaceId: b!, name: 'demo__put', args: { name: 'c', from_file: stored } }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })

    await expect(
      callTool(deps, { ...call, workspaceId: a!, name: 'demo__put', args: { name: 'c' } }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })

    expect(upstream.calls).toHaveLength(0)
    await pool.end()
  })
})
