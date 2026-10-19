export type QueueRow = { ref: string; title: string; priority?: number; rank?: number; role?: string | null; cell?: string | null /* before ADR 0028 */; mode?: string | null }
export type Queue = { inFlight: QueueRow[]; ready: QueueRow[]; waitingOnUser: QueueRow[]; blocked: QueueRow[]; proposed: QueueRow[] }

declare module 'claude-code' {
  interface PluginState {
    queue: { queue: Queue | null }
  }
}
