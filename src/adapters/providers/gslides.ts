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
  maturity: 'experimental',
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
      name: 'get_presentation',
      description:
        'Read the structure of a deck: its slides, the layouts it can build from, and the object ids of the shapes on each slide. Those ids are what create_slide and insert_text aim at',
      write: false,
      request: 'GET /v1/presentations/{presentation_id}',
      selector: 'response_fields',
      args: {
        presentation_id: { type: 'string', required: true },
        response_fields: {
          type: 'string',
          description: 'Slides fields selector. Widen it to read more of the deck',
          // Narrowed at Google rather than here, so a thirteen slide deck never
          // becomes thirteen slides of JSON on the wire. The default carries the
          // three things a caller needs to build on the deck: the layout ids to
          // create from, the page ids, and the object id of every shape with the
          // text already in it.
          default:
            'presentationId,title,layouts(objectId,layoutProperties.displayName),slides(objectId,pageElements(objectId,shape(placeholder,text(textElements(textRun(content))))))',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['presentationId', 'title', 'layouts', 'slides'],
    },
    {
      name: 'create_slide',
      description:
        'Add slides to a deck. Build from layout_id to keep a template deck looking like itself, or from layout for one of the generic Google layouts',
      write: true,
      request: 'POST /v1/presentations/{presentation_id}:batchUpdate',
      args: {
        presentation_id: { type: 'string', required: true },
        slides: {
          type: 'object[]',
          required: true,
          description:
            'One entry per slide. Sent together they apply as a single revision, so a half-built deck is not a state anyone can see.',
          param: 'requests',
          items: {
            layout_id: {
              type: 'string',
              description:
                "A layout already in this deck, from get_presentation. This is the one that keeps a template's design",
              param: 'createSlide.slideLayoutReference.layoutId',
            },
            layout: {
              type: 'string',
              description: 'A generic Google layout, used when layout_id is not given',
              enum: [
                'BLANK',
                'CAPTION_ONLY',
                'TITLE',
                'TITLE_AND_BODY',
                'TITLE_AND_TWO_COLUMNS',
                'TITLE_ONLY',
                'SECTION_HEADER',
                'SECTION_TITLE_AND_DESCRIPTION',
                'ONE_COLUMN_TEXT',
                'MAIN_POINT',
                'BIG_NUMBER',
              ],
              param: 'createSlide.slideLayoutReference.predefinedLayout',
            },
            index: {
              type: 'number',
              description: 'Where the slide goes, counting from 0. Left out, it lands at the end',
              param: 'createSlide.insertionIndex',
            },
            object_id: {
              type: 'string',
              description:
                'Name the new slide, so text can go into it without reading the deck back first',
              param: 'createSlide.objectId',
            },
          },
        },
      },
      // replies carries the object id of each slide created, which is the only
      // way to learn it when the caller did not name one.
      fields: ['presentationId', 'replies'],
    },
    {
      name: 'insert_text',
      description:
        'Write text into one shape or placeholder, addressed by its object id. Text is inserted, not swapped, so use replace_all_text to change words already on a slide',
      write: true,
      request: 'POST /v1/presentations/{presentation_id}:batchUpdate',
      args: {
        presentation_id: { type: 'string', required: true },
        insertions: {
          type: 'object[]',
          required: true,
          description: 'One entry per shape to write into, applied as a single revision.',
          param: 'requests',
          items: {
            object_id: {
              type: 'string',
              required: true,
              description: 'The shape to write into, from get_presentation or a create_slide reply',
              param: 'insertText.objectId',
            },
            text: { type: 'string', required: true, param: 'insertText.text' },
            index: {
              type: 'number',
              description: 'Where in the existing text to insert. Left out, it goes at the front',
              param: 'insertText.insertionIndex',
            },
          },
        },
      },
      fields: ['presentationId', 'replies'],
    },
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
