import { useEffect, useRef } from 'react'
import { isTauriRuntime } from '@branchline/git-client'

export interface NativeMenuState {
  language: string
  hasRepository: boolean
  busy: boolean
  operation: boolean
  hasSelection: boolean
  sidebarVisible: boolean
  inspectorVisible: boolean
  diffLayout: string
  wordWrap: boolean
  showWhitespace: boolean
  diffFontSize: number
  theme: string
  recent: Array<{ path: string; name: string }>
}

function inTauri() {
  return typeof window !== 'undefined' && isTauriRuntime()
}

export function useNativeMenu(onAction: (id: string) => void, labels: Record<string, string>, state: NativeMenuState) {
  const onActionRef = useRef(onAction)
  onActionRef.current = onAction
  // Menu commands are serialized: a language rebuild must finish before the state update lands.
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (!inTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ id: string }>('menu-action', (event) => {
        if (!disposed) onActionRef.current(event.payload.id)
      }))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!inTauri()) return
    queue.current = queue.current
      .then(() => import('@tauri-apps/api/core'))
      .then(({ invoke }) => invoke('set_menu_language', { language: state.language, labels }))
      .catch(() => undefined)
  }, [labels, state.language])

  useEffect(() => {
    if (!inTauri()) return
    queue.current = queue.current
      .then(() => import('@tauri-apps/api/core'))
      .then(({ invoke }) => invoke('sync_menu_state', { state }))
      .catch(() => undefined)
  }, [state])
}
