export type SharedWorkerSseClientOptions = {
  /**
   * SSE endpoint URL (absolute or relative).
   */
  url: string
  /**
   * Name passed to the SharedWorker constructor. Use this to ensure multiple tabs reuse the same worker.
   * Default: "sse-shared-worker"
   */
  workerName?: string
  /**
   * If provided, use this URL to create the SharedWorker.
   * If not provided, a Blob-based SharedWorker is created.
   */
  workerUrl?: string
  /**
   * Passed to EventSource inside the worker.
   * Note: EventSource does not support custom headers.
   */
  withCredentials?: boolean
  /**
   * Delay in milliseconds before initial connection attempt.
   * Default: 0
   */
  connectDelay?: number
  /**
   * Delay in milliseconds before retrying a failed connection.
   * Default: 1000
   */
  retryDelay?: number
  /**
   * Maximum number of retry attempts. Set to -1 for unlimited retries.
   * Default: -1 (unlimited)
   */
  maxRetries?: number
}

export type SharedWorkerSseClient = {
  /**
   * The underlying SharedWorker instance.
   */
  worker: SharedWorker
  /**
   * Listen for a specific SSE event type (e.g. "message", "open", "error", or your custom SSE event name).
   *
   * For custom events, this tells the worker to attach an EventSource listener for that event.
   */
  listen(eventName: string): void
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: AddEventListenerOptions | boolean,
  ): void
  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: EventListenerOptions | boolean,
  ): void
  /**
   * Close the connection and cleanup resources.
   */
  close(): void
  /**
   * Get the current connection state.
   */
  getState(): 'connecting' | 'connected' | 'disconnected' | 'error'
  /**
   * Sync data to all tabs. This broadcasts data to all connected tabs via the SharedWorker.
   */
  syncData<T = unknown>(key: string, data: T): void
  /**
   * Listen for synced data from other tabs.
   */
  onDataSync<T = unknown>(
    key: string,
    callback: (data: T, sourceTab: string) => void,
  ): () => void
}

type WorkerToClientMessage =
  | {
      type: 'open'
      url: string
    }
  | {
      type: 'error'
      url: string
      /**
       * EventSource error events do not expose much detail; this is mostly a marker.
       */
      message?: string
      retryCount?: number
      maxRetries?: number
    }
  | {
      type: 'event'
      url: string
      event: string
      data: string
      lastEventId: string
    }
  | {
      type: 'retrying'
      url: string
      retryCount: number
      maxRetries: number
      delay: number
    }
  | {
      type: 'retry-exhausted'
      url: string
      retryCount: number
      maxRetries: number
    }
  | {
      type: 'data-sync'
      key: string
      data: unknown
      sourceTab: string
    }

type ClientToWorkerMessage =
  | {
      type: 'subscribe'
      url: string
      withCredentials?: boolean
      connectDelay?: number
      retryDelay?: number
      maxRetries?: number
    }
  | {
      type: 'unsubscribe'
      url: string
    }
  | {
      type: 'listen'
      url: string
      event: string
    }
  | {
      type: 'sync-data'
      key: string
      data: unknown
      sourceTab: string
    }

/**
 * Returns a plain-JS SharedWorker script that:
 * - Shares a single EventSource per URL across all ports (tabs)
 * - Broadcasts events to all subscribed ports
 * - Implements retry logic with configurable delay and max retries
 * - Supports delayed initial connection
 */
export function createSharedWorkerSseScript(): string {
  return `
  const urlToState = new Map();

  function getState(url) {
    let state = urlToState.get(url);
    if (!state) {
      state = {
        url,
        ports: new Set(),
        listeners: new Set(['open', 'error', 'message']),
        eventSource: null,
        retryCount: 0,
        maxRetries: -1,
        retryDelay: 1000,
        connectDelay: 0,
        retryTimeout: null,
        connectTimeout: null,
        withCredentials: false,
        isConnecting: false,
      };
      urlToState.set(url, state);
    }
    return state;
  }

  function broadcastToPorts(state, message) {
    for (const port of state.ports) {
      try {
        port.postMessage(message);
      } catch (e) {
        // Port may be closed, ignore
      }
    }
  }

  function handleEventSourceError(state) {
    if (!state.eventSource) return;
    
    const readyState = state.eventSource.readyState;
    if (readyState === EventSource.CLOSED) {
      // Connection closed, attempt retry if configured
      state.eventSource = null;
      state.isConnecting = false;
      
      if (state.maxRetries === -1 || state.retryCount < state.maxRetries) {
        state.retryCount++;
        broadcastToPorts(state, {
          type: 'retrying',
          url: state.url,
          retryCount: state.retryCount,
          maxRetries: state.maxRetries,
          delay: state.retryDelay,
        });
        
        state.retryTimeout = setTimeout(() => {
          ensureEventSource(state);
        }, state.retryDelay);
      } else {
        broadcastToPorts(state, {
          type: 'retry-exhausted',
          url: state.url,
          retryCount: state.retryCount,
          maxRetries: state.maxRetries,
        });
        broadcastToPorts(state, {
          type: 'error',
          url: state.url,
          message: 'Max retries exceeded',
          retryCount: state.retryCount,
          maxRetries: state.maxRetries,
        });
      }
    } else if (readyState === EventSource.CONNECTING) {
      // Still connecting, just broadcast error
      broadcastToPorts(state, {
        type: 'error',
        url: state.url,
        retryCount: state.retryCount,
        maxRetries: state.maxRetries,
      });
    }
  }

  function ensureEventSource(state) {
    if (state.eventSource || state.isConnecting) return;
    
    state.isConnecting = true;
    
    if (state.connectDelay > 0 && state.retryCount === 0) {
      // Initial connection delay
      state.connectTimeout = setTimeout(() => {
        createEventSource(state);
      }, state.connectDelay);
    } else {
      createEventSource(state);
    }
  }

  function createEventSource(state) {
    if (state.eventSource) return;
    
    try {
      const es = new EventSource(state.url, { withCredentials: state.withCredentials });
      state.eventSource = es;
      state.isConnecting = false;

      es.addEventListener('open', () => {
        state.retryCount = 0; // Reset retry count on successful connection
        if (state.retryTimeout) {
          clearTimeout(state.retryTimeout);
          state.retryTimeout = null;
        }
        broadcastToPorts(state, { type: 'open', url: state.url });
      });

      es.addEventListener('error', () => {
        handleEventSourceError(state);
      });

      function forward(eventName, ev) {
        const data = typeof ev.data === 'string' ? ev.data : '';
        const lastEventId = typeof ev.lastEventId === 'string' ? ev.lastEventId : '';
        broadcastToPorts(state, {
          type: 'event',
          url: state.url,
          event: eventName,
          data,
          lastEventId,
        });
      }

      es.addEventListener('message', (ev) => forward('message', ev));
    } catch (e) {
      state.isConnecting = false;
      handleEventSourceError(state);
    }
  }

  function addListener(state, eventName) {
    if (state.listeners.has(eventName)) return;
    state.listeners.add(eventName);
    if (!state.eventSource) return;

    state.eventSource.addEventListener(eventName, (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      const lastEventId = typeof ev.lastEventId === 'string' ? ev.lastEventId : '';
      broadcastToPorts(state, {
        type: 'event',
        url: state.url,
        event: eventName,
        data,
        lastEventId,
      });
    });
  }

  function maybeClose(state) {
    if (state.ports.size > 0) return;
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (state.retryTimeout) {
      clearTimeout(state.retryTimeout);
      state.retryTimeout = null;
    }
    if (state.connectTimeout) {
      clearTimeout(state.connectTimeout);
      state.connectTimeout = null;
    }
    state.isConnecting = false;
    urlToState.delete(state.url);
  }

  // Global data sync storage (shared across all tabs)
  const globalDataSync = new Map();
  
  // Generate unique tab ID for each port
  const portToTabId = new WeakMap();
  let tabIdCounter = 0;

  function getTabId(port) {
    if (!portToTabId.has(port)) {
      portToTabId.set(port, 'tab-' + (++tabIdCounter) + '-' + Date.now());
    }
    return portToTabId.get(port);
  }

  function broadcastDataSync(key, data, sourceTab, excludePort) {
    // Broadcast to all ports across all states
    const allPorts = new Set();
    for (const state of urlToState.values()) {
      for (const port of state.ports) {
        allPorts.add(port);
      }
    }
    
    for (const port of allPorts) {
      if (port !== excludePort) {
        try {
          port.postMessage({
            type: 'data-sync',
            key: key,
            data: data,
            sourceTab: sourceTab,
          });
        } catch (e) {
          // Port may be closed, ignore
        }
      }
    }
  }

  onconnect = function (connectEvent) {
    const port = connectEvent.ports[0];
    port.start();
    const tabId = getTabId(port);

    port.addEventListener('message', (messageEvent) => {
      const msg = messageEvent.data || {};
      if (msg.type === 'subscribe' && typeof msg.url === 'string') {
        const state = getState(msg.url);
        state.ports.add(port);
        
        // Update retry configuration if provided
        if (typeof msg.connectDelay === 'number') {
          state.connectDelay = msg.connectDelay;
        }
        if (typeof msg.retryDelay === 'number') {
          state.retryDelay = msg.retryDelay;
        }
        if (typeof msg.maxRetries === 'number') {
          state.maxRetries = msg.maxRetries;
        }
        if (typeof msg.withCredentials === 'boolean') {
          state.withCredentials = msg.withCredentials;
        }
        
        ensureEventSource(state);
      } else if (msg.type === 'unsubscribe' && typeof msg.url === 'string') {
        const state = urlToState.get(msg.url);
        if (state) {
          state.ports.delete(port);
          maybeClose(state);
        }
      } else if (
        msg.type === 'listen' &&
        typeof msg.url === 'string' &&
        typeof msg.event === 'string'
      ) {
        const state = getState(msg.url);
        addListener(state, msg.event);
      } else if (msg.type === 'sync-data' && typeof msg.key === 'string') {
        // Sync data to all other tabs
        globalDataSync.set(msg.key, msg.data);
        broadcastDataSync(msg.key, msg.data, msg.sourceTab || tabId, port);
      }
    });

    port.addEventListener('messageerror', () => {});
  };
  `
    .split('\n')
    .map((line) => line.replace(/^  /, ''))
    .join('\n')
    .trim()
}

function createBlobWorkerUrl(script: string): string {
  const blob = new Blob([script], { type: 'text/javascript' })
  return URL.createObjectURL(blob)
}

/**
 * Create an SSE client that uses a SharedWorker to share a single EventSource across tabs.
 *
 * Works in browsers that support `SharedWorker`. If your environment doesn't support it,
 * `new SharedWorker(...)` will throw.
 *
 * Features:
 * - Tab synchronization: All tabs share the same EventSource connection
 * - Retry logic: Configurable retry delay and max retries
 * - Delayed connection: Optional delay before initial connection
 * - Type-safe: Full TypeScript support
 */
export function createSharedWorkerSseClient(
  options: SharedWorkerSseClientOptions,
): SharedWorkerSseClient {
  const target = new EventTarget()

  const workerName = options.workerName ?? 'sse-shared-worker'
  const workerUrl =
    options.workerUrl ?? createBlobWorkerUrl(createSharedWorkerSseScript())

  const worker = new SharedWorker(workerUrl, { name: workerName })
  const port = worker.port

  let connectionState: 'connecting' | 'connected' | 'disconnected' | 'error' = 'connecting'

  const forward = (payload: WorkerToClientMessage) => {
    // Update connection state based on message type
    if (payload.type === 'open') {
      connectionState = 'connected'
    } else if (payload.type === 'error' || payload.type === 'retry-exhausted') {
      connectionState = 'error'
    } else if (payload.type === 'retrying') {
      connectionState = 'connecting'
    }

    const messageEvent = new MessageEvent(payload.type === 'event' ? payload.event : payload.type, {
      data: payload,
    })
    target.dispatchEvent(messageEvent)
  }

  port.addEventListener('message', (ev: MessageEvent<WorkerToClientMessage>) => {
    if (!ev?.data || typeof ev.data !== 'object') return
    forward(ev.data)
  })

  port.start()

  const subscribeMessage: ClientToWorkerMessage = {
    type: 'subscribe',
    url: options.url,
    withCredentials: options.withCredentials,
    connectDelay: options.connectDelay,
    retryDelay: options.retryDelay ?? 1000,
    maxRetries: options.maxRetries ?? -1,
  }
  port.postMessage(subscribeMessage)

  // Generate unique tab ID for this client
  const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  const dataSyncListeners = new Map<string, Set<(data: unknown, sourceTab: string) => void>>()

  // Listen for data sync messages
  port.addEventListener('message', (ev: MessageEvent<WorkerToClientMessage>) => {
    if (!ev?.data || typeof ev.data !== 'object') return
    
    if (ev.data.type === 'data-sync') {
      const syncData = ev.data
      const listeners = dataSyncListeners.get(syncData.key)
      if (listeners) {
        listeners.forEach((callback) => {
          try {
            callback(syncData.data, syncData.sourceTab)
          } catch (e) {
            // Ignore errors in callbacks
          }
        })
      }
    }
  })

  return {
    worker,
    listen(eventName: string) {
      const listenMessage: ClientToWorkerMessage = {
        type: 'listen',
        url: options.url,
        event: eventName,
      }
      port.postMessage(listenMessage)
    },
    addEventListener(type, listener, opts) {
      target.addEventListener(type, listener as EventListener, opts)
    },
    removeEventListener(type, listener, opts) {
      target.removeEventListener(type, listener as EventListener, opts)
    },
    close() {
      connectionState = 'disconnected'
      const unsubscribeMessage: ClientToWorkerMessage = {
        type: 'unsubscribe',
        url: options.url,
      }
      port.postMessage(unsubscribeMessage)
      port.close()
      dataSyncListeners.clear()
    },
    getState() {
      return connectionState
    },
    syncData<T = unknown>(key: string, data: T) {
      const syncMessage: ClientToWorkerMessage = {
        type: 'sync-data',
        key,
        data,
        sourceTab: tabId,
      }
      port.postMessage(syncMessage)
    },
    onDataSync<T = unknown>(
      key: string,
      callback: (data: T, sourceTab: string) => void,
    ) {
      if (!dataSyncListeners.has(key)) {
        dataSyncListeners.set(key, new Set())
      }
      const listeners = dataSyncListeners.get(key)!
      listeners.add(callback as (data: unknown, sourceTab: string) => void)

      return () => {
        listeners.delete(callback as (data: unknown, sourceTab: string) => void)
        if (listeners.size === 0) {
          dataSyncListeners.delete(key)
        }
      }
    },
  }
}


