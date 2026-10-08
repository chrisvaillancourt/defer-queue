export type DeferredPrompt = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'defer-queue': { held: DeferredPrompt[]; runningTurn: string | null }
  }
}
