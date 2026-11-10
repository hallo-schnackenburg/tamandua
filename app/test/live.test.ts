import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Live, liveUrl, PING_MS, PONG_MS, RETRY_MS, type Socket } from '../src/live.js'

class FakeSocket implements Socket {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const news = vi.fn()
  const states: boolean[] = []
  const live = new Live('wss://x/live', news, (open) => states.push(open), () => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  })
  return { live, sockets, news, states }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the live connection', () => {
  it('reports news once when it opens (something may have happened) and for every message', () => {
    const { live, sockets, news, states } = setup()
    live.start()
    expect(live.open).toBe(false)
    sockets[0].onopen?.()
    expect(live.open).toBe(true)
    expect(states).toEqual([true])
    expect(news).toHaveBeenCalledTimes(1)
    sockets[0].onmessage?.({ data: '{"type":"push","head":"abc"}' })
    expect(news).toHaveBeenCalledTimes(2)
  })

  it('says "ping" now and then and does not take the answer for news', () => {
    const { live, sockets, news } = setup()
    live.start()
    sockets[0].onopen?.()
    vi.advanceTimersByTime(PING_MS)
    sockets[0].onmessage?.({ data: 'pong' })
    vi.advanceTimersByTime(PING_MS)
    sockets[0].onmessage?.({ data: 'pong' })
    expect(sockets[0].sent).toEqual(['ping', 'ping'])
    expect(news).toHaveBeenCalledTimes(1) // only the one from opening
  })

  it('takes a connection for dead when a ping is not answered, and opens a new one', () => {
    const { live, sockets, states } = setup()
    live.start()
    sockets[0].onopen?.()
    vi.advanceTimersByTime(PING_MS) // ping sent
    sockets[0].onmessage?.({ data: 'pong' }) // answered: fine
    vi.advanceTimersByTime(PING_MS + PONG_MS) // the second ping is not answered
    expect(live.open).toBe(false)
    expect(states).toEqual([true, false])
    expect(sockets[0].closed).toBe(true)
    vi.advanceTimersByTime(RETRY_MS[0])
    expect(sockets).toHaveLength(2)
  })

  it('tries at once when it is told the network is back, and not when it is open anyway', () => {
    const { live, sockets } = setup()
    live.start()
    sockets[0].onclose?.()
    live.nudge() // no waiting for the pause
    expect(sockets).toHaveLength(2)
    sockets[1].onopen?.()
    live.nudge()
    expect(sockets).toHaveLength(2)
  })

  it('opens again after a break, with growing pauses that start anew once it worked', () => {
    const { live, sockets, states } = setup()
    live.start()
    sockets[0].onclose?.() // never opened
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(RETRY_MS[0] - 1)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    sockets[1].onerror?.()
    vi.advanceTimersByTime(RETRY_MS[1])
    expect(sockets).toHaveLength(3)

    sockets[2].onopen?.()
    expect(states).toEqual([true])
    sockets[2].onclose?.()
    expect(states).toEqual([true, false])
    vi.advanceTimersByTime(RETRY_MS[0]) // the first pause again
    expect(sockets).toHaveLength(4)
  })

  it('does not wait longer than the last pause', () => {
    const { live, sockets } = setup()
    live.start()
    for (let i = 0; i < RETRY_MS.length + 3; i++) {
      sockets.at(-1)!.onclose?.()
      vi.advanceTimersByTime(RETRY_MS.at(-1)!)
    }
    expect(sockets).toHaveLength(RETRY_MS.length + 4)
  })

  it('stops for good, and an old connection that reports late does no harm', () => {
    const { live, sockets, states } = setup()
    live.start()
    sockets[0].onopen?.()
    live.stop()
    expect(sockets[0].closed).toBe(true)
    expect(live.open).toBe(false)
    expect(states).toEqual([true, false])
    sockets[0].onclose?.() // detached: nothing happens
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].sent).toEqual([]) // no pings any more
  })

  it('tries again if a connection cannot even be created', () => {
    let tries = 0
    const sockets: FakeSocket[] = []
    const live = new Live('wss://x/live', () => {}, () => {}, () => {
      if (tries++ === 0) throw new Error('no network')
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
    live.start()
    vi.advanceTimersByTime(RETRY_MS[0])
    expect(sockets).toHaveLength(1)
  })
})

describe('liveUrl', () => {
  it('makes a WebSocket address of the Worker address, also a relative one', () => {
    expect(liveUrl('/api', 'http://localhost:5173/')).toBe('ws://localhost:5173/api/live')
    expect(liveUrl('/api/', 'https://tamandua.example/app')).toBe('wss://tamandua.example/api/live')
    expect(liveUrl('https://worker.example', 'http://localhost:5173/')).toBe('wss://worker.example/live')
  })
})
