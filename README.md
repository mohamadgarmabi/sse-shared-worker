# sse-shared-worker

Utilities for:
- **Node-side SSE** response helpers
- **Browser-side SharedWorker** that shares one `EventSource` across tabs and broadcasts events to all subscribers

## Install

```bash
npm i sse-shared-worker
```

## Node SSE (server)

```ts
import { createSseConnection } from 'sse-shared-worker'
import http from 'node:http'

const server = http.createServer((req, res) => {
  if (req.url !== '/events') {
    res.statusCode = 404
    res.end('Not found')
    return
  }

  const sse = createSseConnection(res, { retry: 2000 })

  const intervalId = setInterval(() => {
    sse.send({ data: JSON.stringify({ now: Date.now() }), event: 'tick' })
  }, 1000)

  req.on('close', () => {
    clearInterval(intervalId)
    sse.close()
  })
})

server.listen(3000)
```

## SharedWorker SSE fan-out (browser)

### Basic Usage

```ts
import { createSharedWorkerSseClient } from 'sse-shared-worker'

const client = createSharedWorkerSseClient({
  url: '/events',
  withCredentials: false,
})

// Ask worker to also forward custom SSE event types (optional):
client.listen('tick')

client.addEventListener('tick', (ev) => {
  const payload = (ev as MessageEvent).data
  console.log('tick', payload)
})
```

### Advanced Configuration

```ts
import { createSharedWorkerSseClient } from 'sse-shared-worker'

const client = createSharedWorkerSseClient({
  url: '/events',
  withCredentials: false,
  // Delay before initial connection (milliseconds)
  connectDelay: 500,
  // Delay before retrying failed connections (milliseconds)
  retryDelay: 2000,
  // Maximum retry attempts (-1 for unlimited)
  maxRetries: 5,
  // Custom worker name for tab synchronization
  workerName: 'my-sse-worker',
})

// Listen for connection events
client.addEventListener('open', () => {
  console.log('Connected!')
})

client.addEventListener('error', (ev) => {
  const payload = (ev as MessageEvent).data
  console.log('Error:', payload.message)
  console.log('Retry count:', payload.retryCount)
})

client.addEventListener('retrying', (ev) => {
  const payload = (ev as MessageEvent).data
  console.log(`Retrying... (${payload.retryCount}/${payload.maxRetries})`)
})

// Get current connection state
const state = client.getState() // 'connecting' | 'connected' | 'disconnected' | 'error'

// Access the underlying SharedWorker instance
const worker = client.worker

// Sync data to all tabs
client.syncData('user-preference', { theme: 'dark' })

// Listen for synced data from other tabs
const unsubscribe = client.onDataSync('user-preference', (data, sourceTab) => {
  console.log('Data synced from tab:', sourceTab, data)
  // Update UI based on synced data
})

// Cleanup listener when done
unsubscribe()
```

### React Hook (Easy Access)

```tsx
import { useSharedWorkerSse } from 'sse-shared-worker'
import { useEffect } from 'react'

function MyComponent() {
  const {
    lastMessage,
    lastMessageRaw,
    lastEvent,
    state,
    error,
    connect,
    disconnect,
    listen,
    worker, // Available when exposeWorker: true
    syncData,
    onDataSync,
  } = useSharedWorkerSse({
    url: '/events',
    retryDelay: 2000,
    maxRetries: 5,
    connectDelay: 500,
    autoConnect: true, // Default: true
    autoListen: ['message', 'tick'], // Default: ['message']
    exposeWorker: true, // Expose SharedWorker instance
  })

  // Listen for custom events
  useEffect(() => {
    listen('custom-event')
  }, [listen])

  // Sync data to all tabs
  const handleSync = () => {
    syncData('user-action', { action: 'button-clicked', timestamp: Date.now() })
  }

  // Listen for synced data from other tabs
  useEffect(() => {
    const unsubscribe = onDataSync('user-action', (data, sourceTab) => {
      console.log('Action from tab:', sourceTab, data)
      // Update UI based on synced data
    })
    return unsubscribe
  }, [onDataSync])

  return (
    <div>
      <p>State: {state}</p>
      {error && <p>Error: {error}</p>}
      {lastMessage && (
        <p>
          Last {lastEvent}: {JSON.stringify(lastMessage)}
        </p>
      )}
      <button onClick={disconnect}>Disconnect</button>
      <button onClick={connect}>Connect</button>
      <button onClick={handleSync}>Sync to All Tabs</button>
      {worker && <p>Worker: {worker.port ? 'Connected' : 'Disconnected'}</p>}
    </div>
  )
}
```

### Tab Synchronization

The SharedWorker automatically synchronizes data across all browser tabs:

```tsx
import { useSharedWorkerSse } from 'sse-shared-worker'

function TabSyncExample() {
  const { syncData, onDataSync } = useSharedWorkerSse({
    url: '/events',
  })

  // Sync user preferences to all tabs
  const updateTheme = (theme: string) => {
    syncData('theme', theme)
  }

  // Listen for theme changes from other tabs
  useEffect(() => {
    const unsubscribe = onDataSync('theme', (theme, sourceTab) => {
      console.log(`Theme changed to ${theme} by tab ${sourceTab}`)
      // Apply theme change
    })
    return unsubscribe
  }, [onDataSync])

  return <button onClick={() => updateTheme('dark')}>Switch to Dark</button>
}
```

## Features

- ✅ **Tab Synchronization**: All browser tabs share a single EventSource connection
- ✅ **Data Sync**: Sync arbitrary data across all tabs using `syncData()` and `onDataSync()`
- ✅ **Retry Logic**: Configurable retry delay and maximum retry attempts
- ✅ **Delayed Connection**: Optional delay before initial connection
- ✅ **Type-Safe**: Full TypeScript support with proper types
- ✅ **React Hook**: Easy-to-use React hook for seamless integration
- ✅ **SharedWorker Access**: Expose SharedWorker instance via `exposeWorker` prop
- ✅ **Message Forwarding**: Automatic forwarding of all SSE events to all tabs
- ✅ **Connection State**: Track connection state in real-time

## Notes

- `EventSource` **cannot set custom headers** (this is a platform limitation).
- `SharedWorker` isn't supported in all browsers (check [caniuse.com](https://caniuse.com/sharedworkers)).
- React is a peer dependency (only required when using the React hook).


