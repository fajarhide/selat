import { createRegistry, type ProviderAdapter, type Registry } from './registry.ts'
import { fakeProvider } from './fake.ts'
import { githubProvider } from './github.ts'
import { gcalendarProvider } from './gcalendar.ts'
import { gdriveProvider } from './gdrive.ts'
import { gmailProvider } from './gmail.ts'
import { notionProvider } from './notion.ts'
import { slackProvider } from './slack.ts'

/**
 * The registry is booted from the environment: cloud enables per plan, a
 * self-host enables what it has OAuth applications for. A provider with no
 * client id is left out, because it could only ever fail at connect time.
 *
 * The fake provider is always present. It needs no vendor, which is what lets
 * the quickstart reach a first tool call before any OAuth application exists.
 */
export function bootRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const adapters: ProviderAdapter[] = [fakeProvider()]
  // Keyed on the grant's client id, not the prefix: gmail rides the google
  // application, so it appears the moment that one is configured.
  const gated = [
    ['GITHUB_CLIENT_ID', githubProvider],
    ['GOOGLE_CLIENT_ID', gmailProvider],
    ['GOOGLE_CLIENT_ID', gcalendarProvider],
    ['GOOGLE_CLIENT_ID', gdriveProvider],
    ['NOTION_CLIENT_ID', notionProvider],
    ['SLACK_CLIENT_ID', slackProvider],
  ] as const
  for (const [clientId, provider] of gated) {
    if (env[clientId]) adapters.push(provider())
  }
  return createRegistry(adapters)
}
