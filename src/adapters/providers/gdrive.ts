import { manifestProvider, type ProviderManifest } from './manifest.ts'
import type { ProviderAdapter } from './registry.ts'

// Drive v3 returns id, name and mimeType and nothing else unless the request
// names the fields it wants. Declaring it as an argument with a default is how
// a manifest sends a fixed query parameter today. `selector` is what makes the
// widening real: set response_fields and the result comes back whole, because
// Drive has already narrowed it to what was asked for.
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
      selector: 'response_fields',
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
      selector: 'response_fields',
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
      selector: 'response_fields',
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
      selector: 'response_fields',
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
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name,mimeType',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name', 'mimeType'],
    },
    {
      name: 'rename_file',
      description: 'Rename one file or folder',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name'],
    },
    {
      name: 'move_file',
      description: 'Move a file between folders. Give remove_parents its current folder, or the file gains a second one instead of moving',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        add_parents: { type: 'string[]', required: true, in: 'query', param: 'addParents' },
        remove_parents: { type: 'string[]', in: 'query', param: 'removeParents' },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name'],
    },
    {
      name: 'copy_file',
      description: 'Copy one file, optionally under a new name or into another folder',
      write: true,
      request: 'POST /drive/v3/files/{file_id}/copy',
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        name: { type: 'string', description: 'Name for the copy. Drive picks one otherwise' },
        parents: { type: 'string[]', description: 'Folder ids to put the copy in' },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name,mimeType',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name', 'mimeType'],
    },
    {
      name: 'trash_file',
      description: 'Move a file to the trash, or restore one by setting trashed to false',
      write: true,
      request: 'PATCH /drive/v3/files/{file_id}',
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        trashed: { type: 'boolean', default: true },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name,trashed',
          param: 'fields',
          in: 'query',
        },
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
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        role: { type: 'string', required: true, enum: ['reader', 'commenter', 'writer'] },
        type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'], default: 'user' },
        email_address: {
          type: 'string',
          description: 'Required for type user or group',
          param: 'emailAddress',
        },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,role,type',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'role', 'type'],
    },
    {
      name: 'upload_file',
      description:
        'Upload a new file with its contents. The whole call is capped near 750 KB of file, so hand it text and small documents rather than media',
      write: true,
      request: 'POST /upload/drive/v3/files',
      upload: { content: 'content', mimeType: 'mime_type', fileId: 'file_id' },
      selector: 'response_fields',
      args: {
        name: { type: 'string', required: true },
        content: {
          type: 'base64',
          description: 'The file bytes, base64 encoded. Give this or file_id, not both',
        },
        file_id: {
          type: 'string',
          description:
            'A file this gateway already holds, from an earlier download or export. Uploading it costs no bytes in the conversation',
        },
        mime_type: {
          type: 'string',
          description: 'Media type of the bytes. Taken from the stored file when file_id is used',
        },
        parents: { type: 'string[]', description: 'Folder ids to put it in' },
        upload_type: {
          type: 'string',
          description: 'Leave as multipart, which sends the name and the bytes together',
          default: 'multipart',
          in: 'query',
          param: 'uploadType',
        },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name,mimeType',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name', 'mimeType'],
    },
    {
      name: 'replace_file_content',
      description: 'Replace what is inside an existing file, keeping its id, name and folder',
      write: true,
      request: 'PATCH /upload/drive/v3/files/{file_id}',
      upload: { content: 'content', mimeType: 'mime_type', fileId: 'source_file_id' },
      selector: 'response_fields',
      args: {
        file_id: { type: 'string', required: true },
        content: {
          type: 'base64',
          description: 'The new bytes, base64 encoded. Give this or source_file_id, not both',
        },
        source_file_id: {
          type: 'string',
          description: 'A file this gateway already holds, used as the new contents',
        },
        mime_type: { type: 'string', description: 'Media type of the new bytes' },
        upload_type: {
          type: 'string',
          description: 'Leave as multipart',
          default: 'multipart',
          in: 'query',
          param: 'uploadType',
        },
        response_fields: {
          type: 'string',
          description: 'Drive fields selector',
          default: 'id,name,mimeType',
          param: 'fields',
          in: 'query',
        },
      },
      fields: ['id', 'name', 'mimeType'],
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
