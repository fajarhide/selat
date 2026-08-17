import { createHash, randomBytes } from 'node:crypto'
import { GatewayError } from '../../domain/errors.ts'

export type ProviderOAuthConfig = {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  /** Vendor specific authorize parameters, such as Google's access_type. They
   *  are applied first, so none of them can overwrite the ones below. */
  authorizeParams?: Record<string, string>
  /**
   * How the client proves itself at the token endpoint. RFC 6749 allows the
   * secret in the form body or as HTTP Basic, and leaves the choice to the
   * server. X rejects the body form from a confidential client, so it needs
   * basic. A client with no secret is public and always uses the body, which
   * is what PKCE alone expects.
   */
  tokenAuth?: 'body' | 'basic'
  /** Defaults to the space RFC 6749 specifies. Meta reads the Threads scope
   *  list as comma separated and grants nothing when it is given spaces. */
  scopeSeparator?: string
  /**
   * A second call some vendors require before the token is usable. Meta hands
   * back an hour-long token from the code exchange and expects it traded for a
   * sixty day one, through a GET carrying the token in the query string rather
   * than a form post. Declared as data so a second Meta surface is a table
   * entry, not another branch in here.
   */
  longLived?: LongLivedExchange
  /** How that long-lived token is rolled before it expires. Meta issues no
   *  refresh token, so the access token is what gets presented. */
  longLivedRefresh?: LongLivedExchange
}

export type LongLivedExchange = {
  url: string
  /** Query parameter the current token travels in. */
  tokenParam: string
  /** Fixed query parameters, such as grant_type=th_exchange_token. */
  params: Record<string, string>
  /** Meta wants the secret on the first trade and refuses it on the refresh. */
  withClientSecret?: boolean
  /**
   * Meta's two token trades differ here: th_exchange_token takes the secret
   * alone, fb_exchange_token refuses the call without the app id as well.
   */
  withClientId?: boolean
}

export type TokenSet = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string[]
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function buildAuthorizeUrl(
  cfg: ProviderOAuthConfig,
  params: { redirectUri: string; state: string; challenge: string; scopes: string[] },
): string {
  const url = new URL(cfg.authorizeUrl)
  for (const [key, value] of Object.entries(cfg.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.challenge)
  // S256 is sent even to providers that do not require PKCE. It costs nothing
  // and removes the code interception class of attack everywhere.
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', params.scopes.join(cfg.scopeSeparator ?? ' '))
  return url.toString()
}

export async function exchangeCode(
  cfg: ProviderOAuthConfig,
  params: { code: string; verifier: string; redirectUri: string },
  doFetch: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: cfg.clientId,
    code_verifier: params.verifier,
    ...secretInBody(cfg),
  })
  const short = await parseTokenResponse(await post(cfg, body, doFetch))
  if (!cfg.longLived) return short
  return tradeUp(cfg, short.accessToken, cfg.longLived, doFetch)
}

export async function refreshGrant(
  cfg: ProviderOAuthConfig,
  refreshToken: string,
  doFetch: typeof fetch = fetch,
): Promise<TokenSet> {
  // Where the vendor issues no refresh token, the stored one is the access
  // token itself, which is what its refresh endpoint asks to be shown.
  if (cfg.longLivedRefresh) return tradeUp(cfg, refreshToken, cfg.longLivedRefresh, doFetch)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    ...secretInBody(cfg),
  })
  return parseTokenResponse(await post(cfg, body, doFetch))
}

async function tradeUp(
  cfg: ProviderOAuthConfig,
  token: string,
  step: LongLivedExchange,
  doFetch: typeof fetch,
): Promise<TokenSet> {
  const url = new URL(step.url)
  for (const [key, value] of Object.entries(step.params)) url.searchParams.set(key, value)
  url.searchParams.set(step.tokenParam, token)
  if (step.withClientId) url.searchParams.set('client_id', cfg.clientId)
  if (step.withClientSecret && cfg.clientSecret) {
    url.searchParams.set('client_secret', cfg.clientSecret)
  }

  const traded = await parseTokenResponse(
    await doFetch(url.toString(), { method: 'GET', headers: { accept: 'application/json' } }),
  )
  // The refresh credential is the long-lived token, because the vendor that
  // needs this step is the vendor that never sends a refresh_token. Without
  // this the grant looks unrefreshable and dies at its first expiry.
  return { ...traded, refreshToken: traded.refreshToken ?? traded.accessToken }
}

function usesBasic(cfg: ProviderOAuthConfig): boolean {
  // No secret means a public client, and there is nothing to put in a Basic
  // header, so the body form is the only one that can work.
  return cfg.tokenAuth === 'basic' && Boolean(cfg.clientSecret)
}

function secretInBody(cfg: ProviderOAuthConfig): Record<string, string> {
  if (!cfg.clientSecret || usesBasic(cfg)) return {}
  return { client_secret: cfg.clientSecret }
}

async function post(
  cfg: ProviderOAuthConfig,
  body: URLSearchParams,
  doFetch: typeof fetch,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (usesBasic(cfg)) {
    const pair = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
    headers.authorization = `Basic ${pair}`
  }
  return doFetch(cfg.tokenUrl, { method: 'POST', headers, body })
}

/**
 * Bounded because a vendor that answers a token call with an HTML error page
 * would otherwise put the whole page in one log line.
 */
const REASON_LIMIT = 400

async function parseTokenResponse(res: Response): Promise<TokenSet> {
  if (!res.ok) {
    // Read on the failure path only. A successful body carries the tokens, and
    // the reason a vendor gives here is the difference between a first
    // connection that can be debugged and one that costs another consent round
    // trip to diagnose.
    const reason = await res
      .text()
      .then((text) => text.trim().slice(0, REASON_LIMIT))
      .catch(() => '')
    throw new GatewayError(
      'upstream_error',
      reason
        ? `token endpoint returned ${res.status}: ${reason}`
        : `token endpoint returned ${res.status}`,
    )
  }
  const json = (await res.json()) as Record<string, unknown>
  if (typeof json.access_token !== 'string') {
    throw new GatewayError('upstream_error', 'token endpoint returned no access_token')
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
  }
}
