import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

/**
 * Slides lists auth/drive among the scopes batchUpdate accepts, so this prefix
 * rides the grant gdrive already holds. Asking for auth/presentations instead
 * would buy nothing and send every connected account back through consent, and
 * the Google verification a new scope drags with it.
 */
export const gslidesManifest: ProviderManifest = {
  id: 'gslides',
  prefix: 'gslides',
  grantId: 'google',
  maturity: 'beta',
  baseUrl: 'https://slides.googleapis.com',
  scopes: ['https://www.googleapis.com/auth/drive'],
  auth: { type: 'bearer' },
  errors: {
    forbidden: 'upstream_error',
    // Same split as gdrive: a 403 is either a scope this grant never got or an
    // API nobody enabled, and only the first is worth a reconnect.
    bodyFailure: {
      path: 'error.status',
      equals: 'PERMISSION_DENIED',
      codeFrom: 'error.errors.0.reason',
      codes: { insufficientPermissions: 'reauth_required' },
    },
  },
  tools: [
    {
      name: 'replace_all_text',
      description:
        'Replace text everywhere in a presentation, across every slide, layout and speaker note',
      write: true,
      request: 'POST /v1/presentations/{presentation_id}:batchUpdate',
      args: {
        presentation_id: { type: 'string', required: true },
        replacements: {
          type: 'object[]',
          required: true,
          description:
            'One entry per string to swap. Sent together they apply as a single revision, so a half-renamed deck is not a state anyone can see.',
          param: 'requests',
          items: {
            find: { type: 'string', required: true, param: 'replaceAllText.containsText.text' },
            replace: { type: 'string', required: true, param: 'replaceAllText.replaceText' },
            match_case: {
              type: 'boolean',
              description: 'Defaults to an exact match, so replacing "IT" leaves "it" alone',
              default: true,
              param: 'replaceAllText.containsText.matchCase',
            },
          },
        },
      },
      // occurrencesChanged is the only way to learn a find matched nothing:
      // Slides answers 200 either way.
      fields: ['presentationId', 'replies'],
    },
  ],
}

export function gslidesProvider(): ProviderAdapter {
  return manifestProvider(gslidesManifest)
}
