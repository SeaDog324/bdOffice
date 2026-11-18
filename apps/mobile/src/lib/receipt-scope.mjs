/** Receipts belong to a carrier origin and target host, never the global phone UI. */
export function recentReceipts(receipts, origin, target) {
  if (!origin || !target) return []
  return Object.entries(receipts)
    .filter(([key, value]) => key.startsWith(origin + '|') && value.target === target)
    .slice(-30)
    .reverse()
    .map(([, value]) => value)
}
export function matchesQueuedReceipt(command, receipt, origin) {
  return Boolean(
    command?.envelope &&
    command.serverOrigin === origin &&
    command.requestId === receipt.requestId &&
    command.envelope.target === receipt.target &&
    command.envelope.sessionId === receipt.sessionId,
  )
}
