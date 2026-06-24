const MAX_DETAILS_LENGTH = 220;

function normalizeMessage(message: string) {
  return message.replace(/\s+/g, ' ').trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

function mapFriendlyMessage(rawMessage: string): string {
  const message = rawMessage.toLowerCase();

  if (message.includes('no available path found')) {
    return 'No swap path found for the provided token pair.';
  }

  if (message.includes('failed to compute a valid quote')) {
    return 'Unable to compute a quote with current pool and RPC data.';
  }

  if (message.includes('returned no data')) {
    return 'A required contract call returned no data. Check network/contract configuration.';
  }

  if (message.includes('out of gas')) {
    return 'RPC call limit reached while fetching route data. Please retry.';
  }

  if (message.includes('invalid address')) {
    return 'One or more token or wallet addresses are invalid.';
  }

  if (message.includes('unknown tool')) {
    return 'The requested MCP tool is not registered on this server.';
  }

  return 'Request failed while processing this MCP tool.';
}

export function formatToolError(toolName: string, error: unknown): string {
  const rawMessage = normalizeMessage(getErrorMessage(error));
  const friendlyMessage = mapFriendlyMessage(rawMessage);
  const shortDetails = rawMessage.slice(0, MAX_DETAILS_LENGTH);

  return `Tool "${toolName}" failed: ${friendlyMessage} Details: ${shortDetails}`;
}
