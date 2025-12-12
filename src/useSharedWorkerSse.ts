import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  SharedWorkerSseClient,
  SharedWorkerSseClientOptions,
} from './sharedWorkerSse'
import { createSharedWorkerSseClient } from './sharedWorkerSse'

export type UseSharedWorkerSseOptions = SharedWorkerSseClientOptions & {
  /**
   * Whether to automatically connect when the hook mounts.
   * Default: true
   */
  autoConnect?: boolean
  /**
   * Event types to automatically listen for.
   * Default: ['message']
   */
  autoListen?: string[]
  /**
   * Whether to expose the SharedWorker instance in the return value.
   * Default: false
   */
  exposeWorker?: boolean
}

export type UseSharedWorkerSseReturn<T = unknown> = {
  /**
   * The SSE client instance.
   */
  client: SharedWorkerSseClient | null
  /**
   * The underlying SharedWorker instance (only available if exposeWorker is true).
   */
  worker: SharedWorker | null
  /**
   * Current connection state.
   */
  state: 'connecting' | 'connected' | 'disconnected' | 'error'
  /**
   * Latest message received (parsed as JSON if possible).
   */
  lastMessage: T | null
  /**
   * Latest raw message data string.
   */
  lastMessageRaw: string | null
  /**
   * Latest event name.
   */
  lastEvent: string | null
  /**
   * Error message if any.
   */
  error: string | null
  /**
   * Manually connect to the SSE endpoint.
   */
  connect: () => void
  /**
   * Manually disconnect from the SSE endpoint.
   */
  disconnect: () => void
  /**
   * Listen for a specific event type.
   */
  listen: (eventName: string) => void
  /**
   * Sync data to all tabs.
   */
  syncData: <TData = unknown>(key: string, data: TData) => void
  /**
   * Listen for synced data from other tabs.
   */
  onDataSync: <TData = unknown>(
    key: string,
    callback: (data: TData, sourceTab: string) => void,
  ) => () => void
}

/**
 * React hook for easy access to SharedWorker SSE client.
 *
 * @example
 * ```tsx
 * const { lastMessage, state, error } = useSharedWorkerSse({
 *   url: 'https://api.example.com/events',
 *   retryDelay: 2000,
 *   maxRetries: 5,
 *   connectDelay: 500,
 * })
 *
 * useEffect(() => {
 *   if (lastMessage) {
 *     console.log('Received:', lastMessage)
 *   }
 * }, [lastMessage])
 * ```
 */
export function useSharedWorkerSse<T = unknown>(
  options: UseSharedWorkerSseOptions,
): UseSharedWorkerSseReturn<T> {
  const {
    autoConnect = true,
    autoListen = ['message'],
    exposeWorker = false,
    ...clientOptions
  } = options

  const clientRef = useRef<SharedWorkerSseClient | null>(null)
  const [state, setState] = useState<
    'connecting' | 'connected' | 'disconnected' | 'error'
  >('disconnected')
  const [lastMessage, setLastMessage] = useState<T | null>(null)
  const [lastMessageRaw, setLastMessageRaw] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(() => {
    if (clientRef.current) {
      return
    }

    try {
      const client = createSharedWorkerSseClient(clientOptions)
      clientRef.current = client
      setState(client.getState())

      // Set up auto-listen for specified events
      autoListen.forEach((eventName) => {
        client.listen(eventName)
      })

      // Handle all event types
      const handleEvent = (event: MessageEvent) => {
        const data = event.data
        if (!data || typeof data !== 'object') return

        if (data.type === 'event') {
          setLastEvent(data.event)
          setLastMessageRaw(data.data)

          // Try to parse as JSON
          try {
            const parsed = JSON.parse(data.data) as T
            setLastMessage(parsed)
          } catch {
            // If not JSON, use raw data
            setLastMessage(data.data as T)
          }
        } else if (data.type === 'open') {
          setState('connected')
          setError(null)
        } else if (data.type === 'error') {
          setState('error')
          setError(data.message || 'Connection error')
        } else if (data.type === 'retrying') {
          setState('connecting')
          setError(
            `Retrying connection (${data.retryCount}/${data.maxRetries === -1 ? '∞' : data.maxRetries})...`,
          )
        } else if (data.type === 'retry-exhausted') {
          setState('error')
          setError('Max retries exceeded')
        }
      }

      // Listen to all message types
      client.addEventListener('open', handleEvent)
      client.addEventListener('error', handleEvent)
      client.addEventListener('retrying', handleEvent)
      client.addEventListener('retry-exhausted', handleEvent)

      // Listen to auto-listen events
      autoListen.forEach((eventName) => {
        client.addEventListener(eventName, handleEvent)
      })

      // Also listen to generic 'message' for any other events
      client.addEventListener('message', handleEvent)
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Failed to create client')
    }
  }, [clientOptions, autoListen])

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close()
      clientRef.current = null
      setState('disconnected')
      setLastMessage(null)
      setLastMessageRaw(null)
      setLastEvent(null)
      setError(null)
    }
  }, [])

  const listen = useCallback(
    (eventName: string) => {
      if (clientRef.current) {
        clientRef.current.listen(eventName)
        clientRef.current.addEventListener(eventName, (event: MessageEvent) => {
          const data = event.data
          if (data && typeof data === 'object' && data.type === 'event') {
            setLastEvent(data.event)
            setLastMessageRaw(data.data)
            try {
              const parsed = JSON.parse(data.data) as T
              setLastMessage(parsed)
            } catch {
              setLastMessage(data.data as T)
            }
          }
        })
      }
    },
    [],
  )

  useEffect(() => {
    if (autoConnect) {
      connect()
    }

    return () => {
      disconnect()
    }
  }, [autoConnect, connect, disconnect])

  const syncData = useCallback(
    <TData = unknown>(key: string, data: TData) => {
      if (clientRef.current) {
        clientRef.current.syncData(key, data)
      }
    },
    [],
  )

  const onDataSync = useCallback(
    <TData = unknown>(
      key: string,
      callback: (data: TData, sourceTab: string) => void,
    ) => {
      if (clientRef.current) {
        return clientRef.current.onDataSync(key, callback)
      }
      return () => {}
    },
    [],
  )

  return {
    client: clientRef.current,
    worker: exposeWorker ? clientRef.current?.worker ?? null : null,
    state,
    lastMessage,
    lastMessageRaw,
    lastEvent,
    error,
    connect,
    disconnect,
    listen,
    syncData,
    onDataSync,
  }
}

