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
  /** Defaults to the space RFC 6749 specifies. Meta reads the Threads scope
   *  list as comma separated and grants nothing when it is given spaces. */
  scopeSeparator?: string
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
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  })
  return parseTokenResponse(await post(cfg.tokenUrl, body, doFetch))
}

export async function refreshGrant(
  cfg: ProviderOAuthConfig,
  refreshToken: string,
  doFetch: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  })
  return parseTokenResponse(await post(cfg.tokenUrl, body, doFetch))
}

async function post(url: string, body: URLSearchParams, doFetch: typeof fetch): Promise<Response> {
  return doFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  })
}

async function parseTokenResponse(res: Response): Promise<TokenSet> {
  if (!res.ok) {
    throw new GatewayError('upstream_error', `token endpoint returned ${res.status}`)
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
