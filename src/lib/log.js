/**
 * Error logging without financial data.
 *
 * Forge logs can be read by the app developer when a site admin allows it, so
 * CloseProof never logs balances, amounts or file contents. Control messages can
 * contain amounts ("Unexplained difference of 12.34 USD"), so every run of
 * digits is masked before the message is logged. The error type and the shape of
 * the message are kept, which is enough to diagnose a failure.
 */
export function logError(where, e) {
  const message = String(e?.message ?? e).replace(/\d[\d,.]*/g, '#').slice(0, 300);
  console.error(`[CloseProof] ${where}: ${e?.name ?? 'Error'}: ${message}`);
}
