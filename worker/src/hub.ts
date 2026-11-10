// The hub: one Durable Object that knows every browser that has the app open (as WebSockets) and passes a
// message on to all of them. The GitHub webhook tells it that main moved (webhook.ts); the browsers then
// bring their copy of the archive up to date. Nothing is stored here: a browser that was not connected
// asks the repository itself when it connects.
//
// The sockets use the hibernation API: while nothing is sent, the object is not running (and not billed).
// The browsers send "ping" now and then; the runtime answers "pong" without waking the object.

/** The parts of the runtime that are used here (the project has no type package for Workers). */
interface HubState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): WebSocket[]
  setWebSocketAutoResponse(pair: unknown): void
}
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket }
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown

/** What the Worker needs of the namespace the hub is bound to. */
export interface HubNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** There is one hub; every request goes to the same object. */
export const hubOf = (namespace: HubNamespace) => namespace.get(namespace.idFromName('hub'))

export class Hub {
  #state: HubState

  constructor(state: HubState) {
    this.#state = state
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/notify') {
      const message = await request.text()
      for (const socket of this.#state.getWebSockets()) {
        try {
          socket.send(message)
        } catch {
          // a connection that is gone: the others still get it
        }
      }
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 })
    const pair = new WebSocketPair()
    this.#state.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }

  // The browsers say nothing but "ping", which is answered automatically.
  webSocketMessage(): void {}

  webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 ? 1000 : code)
    } catch {
      // already closed
    }
  }
}
