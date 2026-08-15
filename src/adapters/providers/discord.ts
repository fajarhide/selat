import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * A bot token, not an OAuth grant, and that is the whole point of this file.
 *
 * Discord's OAuth2 user token reaches `identify`, `guilds` and `connections`
 * and stops there: no channel, no message, no reply. Everything an agent would
 * actually want is behind a bot token, which is a static secret from the
 * developer console rather than anything a consent screen produces. A catalog
 * that only speaks OAuth cannot model this provider at all.
 *
 * The token is workspace-wide rather than per user, so the bot sees whatever
 * the servers it was invited to let it see, and nothing else.
 *
 * Driven against the real API on 2026-08-15 for everything except
 * post_message, which writes into somebody's server and was left alone.
 */
export const discordManifest: ProviderManifest = {
  id: 'discord',
  prefix: 'discord',
  maturity: 'beta',
  baseUrl: 'https://discord.com/api/v10',
  // Discord grants a bot its permissions at invite time, in the server, so
  // there is no scope list to ask for here.
  scopes: [],
  auth: { type: 'api_key', in: 'header', name: 'authorization', prefix: 'Bot ' },
  pagination: {
    // Discord sends no cursor back. The caller asks for what came before the
    // oldest id it holds, so the cursor is a message id read off the page.
    style: 'id',
    size: 25,
    sizeParam: 'limit',
    param: 'before',
  },
  tools: [
    {
      name: 'get_bot_user',
      description: 'Read the bot account this token belongs to',
      write: false,
      request: 'GET /users/@me',
      args: {},
      fields: ['id', 'username', 'discriminator', 'bot'],
    },
    {
      name: 'list_guilds',
      description: 'List the servers this bot has been invited to',
      write: false,
      request: 'GET /users/@me/guilds',
      args: {},
      items: '$',
      fields: ['id', 'name', 'owner', 'permissions'],
    },
    {
      name: 'list_channels',
      description: 'List the channels of one server, including their type and topic',
      write: false,
      request: 'GET /guilds/{guild_id}/channels',
      args: { guild_id: { type: 'string', required: true } },
      items: '$',
      fields: ['id', 'name', 'type', 'topic', 'parent_id', 'position'],
    },
    {
      name: 'list_messages',
      description: 'Read recent messages in one channel, newest first',
      write: false,
      request: 'GET /channels/{channel_id}/messages',
      args: { channel_id: { type: 'string', required: true } },
      items: '$',
      fields: ['id', 'content', 'timestamp', 'author.username', 'author.id', 'edited_timestamp'],
    },
    {
      name: 'post_message',
      description: 'Post a message to one channel as the bot',
      write: true,
      request: 'POST /channels/{channel_id}/messages',
      args: {
        channel_id: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      fields: ['id', 'channel_id', 'timestamp'],
    },
  ],
}

export function discordProvider(): ProviderAdapter {
  return manifestProvider(discordManifest)
}
