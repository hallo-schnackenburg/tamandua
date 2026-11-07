// The real agent: sends the message to the Worker, which asks the model and returns
// tool calls. The Worker holds the Anthropic key; the browser never sees it.

import { stripFiles } from '@tamandua/core'
import { jsonOf, request as call } from './api.js'
import type { Agent, AgentRequest, ToolCall } from './agent.js'

export class WorkerAgent implements Agent {
  #url: string

  constructor(url: string) {
    this.#url = url.replace(/\/$/, '')
  }

  async respond(request: AgentRequest): Promise<ToolCall[]> {
    const body = {
      message: request.message,
      files: request.files.map((f) => ({ name: f.name, object: f.object })),
      // The file hashes are of no use to the model; leave them out.
      objects: request.objects.map((o) => ({ number: o.number, text: stripFiles(o.text), issues: o.issues })),
      history: request.history,
    }

    const response = await call(`${this.#url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await jsonOf<{ calls?: ToolCall[] }>(response)
    if (!response.ok || !data.calls) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data.calls
  }
}
