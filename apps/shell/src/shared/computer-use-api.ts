export interface ComputerUseStatus {
  available: boolean
  version: string
  platform: string
  state: 'stopped' | 'ready' | 'busy' | 'error'
  active: boolean
  waiting: number
  error?: string
}
export interface ComputerUseApi {
  status(): Promise<ComputerUseStatus>
  restart(): Promise<ComputerUseStatus>
  stop(): Promise<void>
}
export const COMPUTER_USE_CHANNELS = {
  status: 'computer-use:status',
  restart: 'computer-use:restart',
  stop: 'computer-use:stop',
} as const
declare global {
  interface Window {
    aiOfficeComputer: ComputerUseApi
  }
}
