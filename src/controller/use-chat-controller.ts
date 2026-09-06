import { useSyncExternalStore } from 'react'
import type { ChatController } from './chat-controller'

export function useChatController(controller: ChatController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
