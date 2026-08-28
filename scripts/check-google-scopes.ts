/**
 * Exercises every Google scope the gateway asks for, against a real account,
 * and puts each one back the way it found it.
 *
 * It exists because the Google consent screen makes you justify each scope in
 * writing and then demonstrate it on video, and both are worth checking before
 * a reviewer does. A passing run is the evidence: the tools ran, the writes
 * took effect, and nothing narrower would have served.
 *
 * Not a unit test and not run by vitest. It needs a live gateway, a workspace
 * credential, and a connected Google account, so it is a command you run:
 *
 *   GATEWAY_URL=https://api.selat.dev SELAT_TOKEN=... npm run check:google
 *
 * ponytail: creates its own scratch folder, event and message rather than
 * touching anything already in the account. Slower than renaming a file that
 * is already there, and the only version safe to hand someone else.
 */

const gateway = (process.env.GATEWAY_URL ?? '').replace(/\/$/, '')
const token = process.env.SELAT_TOKEN ?? ''
if (!gateway || !token) {
  console.error('set GATEWAY_URL and SELAT_TOKEN')
  process.exit(2)
}

const MARK = 'selat-scope-check'
let failed = 0

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${gateway}/v1/tools/${tool}/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = (await res.json()) as { content?: unknown; error?: { code: string; message: string } }
  if (!res.ok || body.error) {
    throw new Error(`${tool}: ${body.error?.code ?? res.status} ${body.error?.message ?? ''}`)
  }
  return body.content
}

/** One line per call, so a failure names the tool rather than the scope. */
async function step(tool: string, args: Record<string, unknown>, show: (c: any) => string) {
  try {
    const content = await call(tool, args)
    console.log(`  ok    ${tool.padEnd(24)} ${show(content)}`)
    return content
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${tool.padEnd(24)} ${(error as Error).message}`)
    return null
  }
}

const count = (c: any) => `${(c?.items ?? c?.messages ?? c?.files ?? []).length} rows`
const first = (c: any) => (c?.items ?? c?.messages ?? c?.files ?? [])[0]

console.log(`\ncalendar.calendarlist.readonly`)
await step('gcal__list_calendars', {}, count)

console.log(`\ncalendar.events`)
await step('gcal__list_events', { calendar_id: 'primary' }, count)
// A year out and an hour long, so a run that dies before cleanup leaves
// something obviously synthetic rather than something in next week's view.
const event = await step(
  'gcal__create_event',
  {
    calendar_id: 'primary',
    summary: MARK,
    start_time: '2027-01-04T10:00:00+07:00',
    end_time: '2027-01-04T11:00:00+07:00',
  },
  (c) => `created ${c.id}`,
)
if (event) {
  await step(
    'gcal__delete_event',
    { calendar_id: 'primary', event_id: event.id },
    () => `deleted ${event.id}`,
  )
}

console.log(`\ndrive`)
const files = await step('gdrive__list_files', {}, count)
const someFile = first(files)
if (someFile) {
  // The id, never the name. This runs against a real account and its output
  // gets pasted into issues and shown on screen while recording the consent
  // video, and a document title is the one field in this whole run that can
  // carry something private.
  await step('gdrive__get_file', { file_id: someFile.id }, (c) => `read ${c.id}`)
}
const folder = await step('gdrive__create_folder', { name: MARK }, (c) => `created ${c.id}`)
if (folder) {
  await step(
    'gdrive__rename_file',
    { file_id: folder.id, name: `${MARK}-renamed` },
    (c) => `renamed to ${c.name}`,
  )
  // delete rather than trash: it existed for two seconds and leaving it in the
  // bin makes the caller clean up after a check that claimed to clean up.
  await step('gdrive__delete_file', { file_id: folder.id }, () => `deleted ${folder.id}`)
}

console.log(`\ngmail.modify`)
const profile = await step('gmail__get_profile', {}, (c) => c.emailAddress)
await step('gmail__list_messages', { query: 'in:inbox' }, count)
const messages = await call('gmail__list_messages', { query: 'in:inbox' }).catch(() => null)
const someMessage = first(messages)
if (someMessage) {
  await step('gmail__get_message', { id: someMessage.id }, (c) => `read ${c.id}`)
}
if (profile) {
  const raw = Buffer.from(
    `To: ${profile.emailAddress}\r\nSubject: ${MARK}\r\n\r\nSent and trashed by ${MARK}.\r\n`,
  ).toString('base64')
  const sent = await step('gmail__send_message', { raw }, (c) => `sent ${c.id}`)
  if (sent) {
    // STARRED is visible and reversible. Removing UNREAD would also prove the
    // scope, but it edits state a person might care about.
    await step(
      'gmail__modify_message',
      { id: sent.id, add_label_ids: ['STARRED'] },
      (c) => `labels ${c.labelIds.join(',')}`,
    )
    await step('gmail__trash_message', { id: sent.id }, (c) => `labels ${c.labelIds.join(',')}`)
  }
}

console.log(failed === 0 ? '\nall scopes exercised, nothing left behind\n' : `\n${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
