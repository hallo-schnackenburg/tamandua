// The real agent: sends the message to the Worker, which asks the model and returns
// tool calls. The Worker holds the Anthropic key; the browser never sees it.

import { stripFiles } from '@archive/core'
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

    let response: Response
    try {
      response = await fetch(`${this.#url}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      throw new Error('Der Server ist nicht erreichbar. Läuft der Worker (npm run dev:worker)?')
    }

    const data = (await response.json().catch(() => ({}))) as { calls?: ToolCall[]; error?: string }
    if (!response.ok || !data.calls) throw new Error(data.error ?? `Fehler ${response.status}`)
    return data.calls
  }
}
