import type { IncomingMessage, ServerResponse } from 'node:http'

export function handleUiStateApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  filePath?: string,
): Promise<boolean>
