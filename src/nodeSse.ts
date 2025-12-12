export type SseRetry = number

export type SseSendOptions = {
  id?: string
  event?: string
  retry?: SseRetry
}

export type SseEvent = SseSendOptions & {
  data: string
}

export type SseInitOptions = {
  /**
   * Extra headers to add to the SSE response.
   * Note: `Content-Type`, `Cache-Control` and `Connection` are set by default.
   */
  headers?: Record<string, string>
  /**
   * Send an initial comment line to "open" the stream in some proxies.
   * Default: true
   */
  sendInitialComment?: boolean
  /**
   * Initial retry value (ms) for clients.
   */
  retry?: SseRetry
}

export type NodeLikeResponse = {
  setHeader(name: string, value: string): void
  write(chunk: string): void
  end(): void
  flushHeaders?: () => void
}

export type SseConnection = {
  send(event: SseEvent): void
  comment(commentText?: string): void
  close(): void
}

function normalizeSseData(data: string): string {
  return data.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function formatSseEvent({ data, id, event, retry }: SseEvent): string {
  const lines: string[] = []

  if (id != null) {
    lines.push(`id: ${id}`)
  }
  if (event != null) {
    lines.push(`event: ${event}`)
  }
  if (retry != null) {
    lines.push(`retry: ${retry}`)
  }

  const normalized = normalizeSseData(data)
  for (const line of normalized.split('\n')) {
    lines.push(`data: ${line}`)
  }

  return `${lines.join('\n')}\n\n`
}

/**
 * Initialize a Server-Sent Events (SSE) response and get a small helper API to send events.
 *
 * This is framework-agnostic: pass any Node response-like object (e.g. Node `http.ServerResponse`,
 * Express `res`, Fastify `reply.raw`, etc).
 */
export function createSseConnection(
  res: NodeLikeResponse,
  options: SseInitOptions = {},
): SseConnection {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  if (options.headers) {
    for (const [headerName, headerValue] of Object.entries(options.headers)) {
      res.setHeader(headerName, headerValue)
    }
  }

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders()
  }

  if (options.retry != null) {
    res.write(formatSseEvent({ data: '', retry: options.retry }))
  }

  if (options.sendInitialComment !== false) {
    res.write(`: connected\n\n`)
  }

  return {
    send(event: SseEvent) {
      res.write(formatSseEvent(event))
    },
    comment(commentText = '') {
      const normalized = normalizeSseData(commentText)
      const lines = normalized.length ? normalized.split('\n') : ['']
      res.write(`${lines.map((l) => `: ${l}`).join('\n')}\n\n`)
    },
    close() {
      res.end()
    },
  }
}


