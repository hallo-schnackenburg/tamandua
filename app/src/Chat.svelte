<script lang="ts">
  import { tick } from 'svelte'
  import type { Workspace } from './workspace.svelte.js'

  let { workspace: ws }: { workspace: Workspace } = $props()

  let text = $state('')
  let input: HTMLTextAreaElement | undefined
  let log: HTMLDivElement | undefined

  // Whenever something happens that should put the cursor back (a tile was clicked, an answer arrived).
  $effect(() => {
    ws.focusTick
    input?.focus()
  })

  // Keep the latest message in view, also while a status message grows.
  $effect(() => {
    ws.chat.length
    ws.chat[ws.chat.length - 1]?.text
    void tick().then(() => log && (log.scrollTop = log.scrollHeight))
  })

  // What the next message is about.
  const subject = $derived.by(() => {
    const files = ws.target
    if (files.length === 0) return 'Keine freie Datei'
    if (ws.selection.length === 0) return `Nächste freie Datei: ${files[0].name}`
    return files.length === 1 ? files[0].name : `${files.length} Dateien`
  })

  function submit() {
    const message = text
    text = ''
    void ws.send(message)
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }
</script>

<div class="chat">
  <div class="log" bind:this={log}>
    {#each ws.chat as message}
      <p class={message.role}>{message.text}</p>
    {:else}
      <p class="empty">Datei(en) hierher ziehen, dann beschreiben, z. B. „Brief, Titel: Brief an die Schwester, Autor: Volker H., 3.1.65“.</p>
    {/each}
    {#if ws.busy}<p class="assistant wait">…</p>{/if}
  </div>

  <div class="subject">
    {subject}
  </div>
  <textarea
    bind:this={input}
    bind:value={text}
    {onkeydown}
    rows="3"
    placeholder="Beschreibung eingeben, Enter zum Senden"
    disabled={ws.busy}
  ></textarea>
</div>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
  .log { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  p { margin: 0; padding: 6px 10px; border-radius: 8px; max-width: 92%; white-space: pre-line; font-size: 0.92rem; }
  .user { align-self: flex-end; background: #dbe7fd; }
  .assistant { align-self: flex-start; background: #f1f1f1; }
  .status { align-self: stretch; max-width: none; background: none; border-left: 3px solid #bbb; border-radius: 0; color: #555; font-size: 0.82rem; }
  .empty { background: none; color: #888; }
  .wait { color: #888; }
  .subject { font-size: 0.8rem; color: #555; padding: 2px 8px; background: #f4f2ee; border-radius: 10px; align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { resize: none; font: inherit; padding: 8px; border: 1px solid #ccc; border-radius: 6px; }
</style>
