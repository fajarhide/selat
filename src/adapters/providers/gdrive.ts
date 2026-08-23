import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

// Drive v3 returns id, name and mimeType and nothing else unless the request
// names the fields it wants. Declaring it as an argument with a default is how
// a manifest sends a fixed query parameter today, and it leaves an agent able
// to widen the selection when it genuinely needs more.
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress)'

export const gdriveManifest: ProviderManifest = {
  id: 'gdrive',
  prefix: 'gdrive',
  grantId: 'google',
  maturity: 'beta',
  baseUrl: 'https://www.googleapis.com',
  // Widened from drive.readonly in one step rather than per tool, because
  // every existing Google connection re-consents once either way.
  scopes: ['https://www.googleapis.com/auth/drive'],
  auth: { type: 'bearer' },
  errors: { forbidden: 'upstream_error' },
  pagination: {
    style: 'cursor',
    size: 25,
    sizeParam: 'pageSize',
    param: 'pageToken',
    nextPath: 'nextPageToken',
  },
  tools: [
    {
      name: 'get_about',
      description: 'Read the account behind this connection and how much Drive storage it has used',
      write: false,
      request: 'GET /drive/v3/about',
      args: {
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'user,storageQuota',
          param: 'fields',
        },
      },
      fields: ['user.emailAddress', 'user.displayName', 'storageQuota'],
    },
    {
      name: 'list_files',
      description: 'List or search files, using Drive query syntax such as "name contains report"',
      write: false,
      request: 'GET /drive/v3/files',
      args: {
        query: {
          type: 'string',
          description: 'Drive query syntax, for example "mimeType=\'application/pdf\'"',
          param: 'q',
        },
        order_by: {
          type: 'string',
          description: 'For example modifiedTime desc, or name',
          param: 'orderBy',
        },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: `nextPageToken,files(${FILE_FIELDS})`,
          param: 'fields',
        },
      },
      items: 'files',
      fields: ['id', 'name', 'mimeType', 'modifiedTime', 'size', 'webViewLink'],
    },
    {
      name: 'get_file',
      description: 'Fetch one file by id, with its owner and a link to open it',
      write: false,
      request: 'GET /drive/v3/files/{file_id}',
      args: {
        file_id: { type: 'string', required: true },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: FILE_FIELDS,
          param: 'fields',
        },
      },
      fields: ['id', 'name', 'mimeType', 'modifiedTime', 'size', 'webViewLink', 'owners'],
    },
    {
      name: 'create_folder',
      description: 'Create a folder, optionally inside another one',
      write: true,
      request: 'POST /drive/v3/files',
      args: {
        name: { type: 'string', required: true },
        parents: {
          type: 'string[]',
          description: 'Folder ids to create it in. Omitted, it lands in My Drive',
        },
        mime_type: {
          type: 'string',
          description: 'Leave as the folder type',
          default: FOLDER_MIME,
          param: 'mimeType',
        },
      },
      fields: ['id', 'name', 'mimeType'],
    },
    {
      name: 'rename_file',
      description: 'Rename one file or folder',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      args: {
        file_id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      fields: ['id', 'name'],
    },
    {
      name: 'move_file',
      description: 'Move a file between folders. Give remove_parents its current folder, or the file gains a second one instead of moving',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      args: {
        file_id: { type: 'string', required: true },
        add_parents: { type: 'string[]', required: true, in: 'query', param: 'addParents' },
        remove_parents: { type: 'string[]', in: 'query', param: 'removeParents' },
      },
      fields: ['id', 'name'],
    },
    {
      name: 'copy_file',
      description: 'Copy one file, optionally under a new name or into another folder',
      write: true,
      request: 'POST /drive/v3/files/{file_id}/copy',
      args: {
        file_id: { type: 'string', required: true },
        name: { type: 'string', description: 'Name for the copy. Drive picks one otherwise' },
        parents: { type: 'string[]', description: 'Folder ids to put the copy in' },
      },
      fields: ['id', 'name', 'mimeType'],
    },
    {
      name: 'trash_file',
      description: 'Move a file to the trash, or restore one by setting trashed to false',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      args: {
        file_id: { type: 'string', required: true },
        trashed: { type: 'boolean', default: true },
      },
      fields: ['id', 'name', 'trashed'],
    },
    {
      name: 'delete_file',
      description: 'Delete a file for good, skipping the trash. Prefer trash_file, which can be undone',
      write: true,
      request: 'DELETE /drive/v3/files/{file_id}',
      args: { file_id: { type: 'string', required: true } },
    },
    {
      name: 'share_file',
      description: 'Give somebody access to a file. type anyone makes it reachable by link',
      write: true,
      request: 'POST /drive/v3/files/{file_id}/permissions',
      args: {
        file_id: { type: 'string', required: true },
        role: { type: 'string', required: true, enum: ['reader', 'commenter', 'writer'] },
        type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'], default: 'user' },
        email_address: {
          type: 'string',
          description: 'Required for type user or group',
          param: 'emailAddress',
        },
      },
      fields: ['id', 'role', 'type'],
    },
    {
      name: 'download_file',
      description:
        'Download the bytes of one file. Google Docs, Sheets and Slides have no bytes of their own, so use export_file for those',
      write: false,
      request: 'GET /drive/v3/files/{file_id}',
      binary: true,
      args: {
        file_id: { type: 'string', required: true },
        alt: {
          type: 'string',
          description: 'Response format. media returns the file itself',
          default: 'media',
        },
      },
    },
    {
      name: 'export_file',
      description:
        'Export a Google Doc, Sheet or Slide as a format that has bytes, such as text/plain or application/pdf',
      write: false,
      request: 'GET /drive/v3/files/{file_id}/export',
      binary: true,
      args: {
        file_id: { type: 'string', required: true },
        mime_type: {
          type: 'string',
          required: true,
          description: 'For example text/plain, text/markdown, text/csv or application/pdf',
          param: 'mimeType',
        },
      },
    },
  ],
}

export function gdriveProvider(): ProviderAdapter {
  return manifestProvider(gdriveManifest)
}
