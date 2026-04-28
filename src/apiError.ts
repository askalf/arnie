import Anthropic from "@anthropic-ai/sdk";

export function handleApiError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) {
    const retry = err.headers?.get("retry-after");
    return `rate limited${retry ? ` (retry after ${retry}s)` : ""}: ${err.message}`;
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return `authentication failed — check ANTHROPIC_API_KEY: ${err.message}`;
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `permission denied: ${err.message}`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `not found (model id?): ${err.message}`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `bad request: ${err.message}`;
  }
  if (err instanceof Anthropic.InternalServerError) {
    return `server error: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `network error: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `api error (${err.status ?? "?"}): ${err.message}`;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("abort")) {
      return "request cancelled";
    }
    return `error: ${err.message}`;
  }
  return `error: ${String(err)}`;
}
