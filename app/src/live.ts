// The connection on which the Worker tells the browser that the archive changed (a WebSocket to /live).
// It does not carry data, only the news "main moved"; the browser then asks for what changed.
// If the connection breaks it is opened again, with growing pauses. Whoever uses it has to make sure
// by other means (polling) that nothing is missed while it is closed: every time it opens, `onNews`
// is called once, because something may have happened meanwhile.

/** The parts of a WebSocket that are used (so that a stand-in can be used in tests). */
export interface Socket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

/** Pauses before the next try, in milliseconds; the last one is repeated. */
export const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]
/** How often the connection says "ping": the other end answers "pong" without being woken up. */
export const PING_MS = 25_000
/** If no answer to a ping comes within this time, the connection is taken for dead (a train in a tunnel does not close it). */
export const PONG_MS = 10_000

/** The address of the live connection for a Worker address that may be relative (e.g. "/api"). */
export function liveUrl(worker: string, base: string): string {
  const url = new URL(`${worker.replace(/\/$/, '')}/live`, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export class Live {
  /** Whether the connection is open right now. */
  open = false
  #url: string
  #onNews: () => void
  #onState: (open: boolean) => void
  #connect: (url: string) => Socket
  #socket: Socket | undefined
  #tries = 0
  #retry: ReturnType<typeof setTimeout> | undefined
  #ping: ReturnType<typeof setInterval> | undefined
  #pong: ReturnType<typeof setTimeout> | undefined
  #wanted = false

  constructor(url: string, onNews: () => void, onState: (open: boolean) => void = () => {}, connect: (url: string) => Socket = (u) => new WebSocket(u) as unknown as Socket) {
    this.#url = url
    this.#onNews = onNews
    this.#onState = onState
    this.#connect = connect
  }

  start(): void {
    if (this.#wanted) return
    this.#wanted = true
    this.#tries = 0
    this.#attempt()
  }

  stop(): void {
    this.#wanted = false
    clearTimeout(this.#retry)
    this.#release()
    this.#set(false)
  }

  #attempt(): void {
    if (!this.#wanted) return
    let socket: Socket
    try {
      socket = this.#connect(this.#url)
    } catch {
      return this.#later()
    }
    this.#socket = socket
    socket.onopen = () => {
      this.#tries = 0
      this.#set(true)
      this.#ping = setInterval(() => {
        try {
          socket.send('ping')
        } catch {
          // the close that follows is handled there
        }
        this.#pong ??= setTimeout(() => lost(), PONG_MS)
      }, PING_MS)
      this.#onNews() // something may have happened while there was no connection
    }
    socket.onmessage = (event) => {
      clearTimeout(this.#pong) // it is alive
      this.#pong = undefined
      if (event.data === 'pong') return
      this.#onNews()
    }
    const lost = () => {
      if (this.#socket !== socket) return // an old connection
      this.#release()
      this.#set(false)
      this.#later()
    }
    socket.onclose = lost
    socket.onerror = lost
  }

  #later(): void {
    if (!this.#wanted) return
    const pause = RETRY_MS[Math.min(this.#tries, RETRY_MS.length - 1)]
    this.#tries++
    this.#retry = setTimeout(() => this.#attempt(), pause)
  }

  /** The network is back, or the page is in front again: do not wait for the next try, try now. */
  nudge(): void {
    if (!this.#wanted || this.open) return
    clearTimeout(this.#retry)
    this.#release()
    this.#tries = 0
    this.#attempt()
  }

  /** Lets go of the connection without any more calls from it. */
  #release(): void {
    clearInterval(this.#ping)
    clearTimeout(this.#pong)
    this.#pong = undefined
    const socket = this.#socket
    this.#socket = undefined
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
    try {
      socket.close()
    } catch {
      // already closed
    }
  }

  #set(open: boolean): void {
    if (this.open === open) return
    this.open = open
    this.#onState(open)
  }
}
