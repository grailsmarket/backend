// erigon >= 3.5 briefly advertises a new head via eth_blockNumber while the
// block's results are still being flushed, and rejects getLogs ranges reaching
// it with -32602 "block range extends beyond current head block". The rejection
// clears within the sub-second flush window, so it warrants a quick quiet retry
// instead of the generic error path. Matched on the message, not the code
// (-32602 covers unrelated invalid-params errors), so providers that never
// emit it are unaffected.
export function isBeyondHeadError(error: any): boolean {
  return [error?.details, error?.message].some(
    (v) => typeof v === 'string' && v.includes('block range extends beyond current head block')
  );
}
