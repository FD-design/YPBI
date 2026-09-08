import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Bind an in-flight operation to both request-body aborts and premature
 * response/socket closure. Call the returned cleanup after the operation settles.
 */
export function bindClientRequestAbort(
  rawRequest: IncomingMessage,
  rawResponse: ServerResponse,
  controller: AbortController,
  reason = "client_request_aborted"
) {
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  };
  const abortForPrematureResponseClose = () => {
    if (!rawResponse.writableEnded) abort();
  };

  rawRequest.once("aborted", abort);
  rawResponse.once("close", abortForPrematureResponseClose);
  if (rawRequest.aborted || (rawResponse.destroyed && !rawResponse.writableEnded)) abort();

  return () => {
    rawRequest.removeListener("aborted", abort);
    rawResponse.removeListener("close", abortForPrematureResponseClose);
  };
}
