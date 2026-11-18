export const errorCode = (reason) => reason?.code || reason?.message || 'COMMAND_REJECTED'
// Only uncertainty at the transport boundary qualifies for offline delivery.
export const canQueueOffline = (reason) =>
  ['NETWORK_ERROR', 'HOST_OFFLINE', 'NOT_CONNECTED'].includes(errorCode(reason))
export function blockCommand(durable, command, reason) {
  const queued = durable.value.queue[command.requestId]
  if (!queued) return
  queued.status = 'blocked'
  queued.errorCode = errorCode(reason)
  durable.save()
}
export async function deliverCommand(client, sessionId, command) {
  const known = await client.rpc('messages.receipt', { sessionId, requestId: command.requestId })
  const receipt =
    known ||
    (await client.rpc('messages.send', {
      sessionId,
      requestId: command.requestId,
      text: command.text,
    }))
  if (!receipt || typeof receipt.taskId !== 'string') throw new Error('INVALID_RESPONSE')
  return receipt
}
