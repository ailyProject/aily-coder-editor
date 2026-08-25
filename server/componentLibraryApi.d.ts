import type { IncomingMessage, ServerResponse } from 'node:http'

export function handleComponentLibraryApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean>
