<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Workspace } from './workspace.svelte.js'

  let { workspace: ws }: { workspace: Workspace } = $props()

  // Shown in the middle of an empty chat; one is picked per page load.
  const greetings: [string, string][] = [
    ['Was haben wir heute?', 'Beschreibe, was du in den Dateien siehst.'],
    ['Womit fangen wir an?', 'Wähle Dateien aus und erzähl mir davon.'],
    ['Zeig mir, was du gefunden hast.', 'Schreib mir, was du darüber weißt.'],
    ['Was liegt heute auf dem Tisch?', 'Beschreibe es in deinen eigenen Worten.'],
    ['Schön, dass du da bist.', 'Erzähl mir von deinen Dateien.'],
    ['Bereit, wenn du es bist.', 'Schreib einfach los.'],
    ['Welche Schätze gibt es heute?', 'Erzähl mir, was du siehst.'],
    ['Los geht’s.', 'Sag mir, was auf den Dateien zu sehen ist.'],
  ]
  const greeting = greetings[Math.floor(Math.random() * greetings.length)]

  let text = $state('')
  let input: HTMLTextAreaElement | undefined
  let log: HTMLDivElement | undefined

  // Whenever something happens that should put the cursor back (a tile was clicked, an answer arrived).
  $effect(() => {
    ws.focusTick
    input?.focus()
  })

  // Typing anywhere on the page, while nothing that takes text has the focus, goes to the chat.
  onMount(() => {
    input?.focus()
    const redirect = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
      const active = document.activeElement
      if (active && active !== document.body && active.closest('input, textarea, select, [contenteditable="true"]')) return
      input?.focus()
    }
    window.addEventListener('keydown', redirect)
    return () => window.removeEventListener('keydown', redirect)
  })

  // The input grows with its text, up to a limit.
  $effect(() => {
    text
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`
  })

  // Keep the latest message in view, also while a status message grows.
  $effect(() => {
    ws.chat.length
    ws.chat[ws.chat.length - 1]?.text
    void tick().then(() => log && (log.scrollTop = log.scrollHeight))
  })

  // What the next message is about: the selected files.
  const subject = $derived(ws.target.length === 0 ? '' : ws.target.length === 1 ? `Datei: ${ws.target[0].name}` : `${ws.target.length} Dateien`)

  function submit() {
    if (ws.busy || !text.trim()) return
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
    {#each ws.chat.filter((m) => m.role !== 'log') as message}
      <p class={message.role}>{message.text}</p>
    {:else}
      <div class="empty-state">
        <span>{greeting[0]}</span>
        <small>{greeting[1]}</small>
      </div>
    {/each}
    {#if ws.busy}<p class="assistant wait">…</p>{/if}
  </div>

  <div class="composer">
    {#if subject}<div class="subject">{subject}</div>{/if}
    <textarea
      bind:this={input}
      bind:value={text}
      {onkeydown}
      rows="1"
      placeholder="Beschreibung eingeben"
    ></textarea>
    <button class="send" onclick={submit} disabled={ws.busy || !text.trim()} aria-label="Senden">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
    </button>
  </div>
</div>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
  .log { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  p { margin: 0; padding: 6px 10px; border-radius: 8px; max-width: 92%; white-space: pre-line; font-size: 0.92rem; }
  .user { align-self: flex-end; background: #dbe7fd; }
  .assistant { align-self: flex-start; background: #f1f1f1; }
  .status { align-self: stretch; max-width: none; background: none; border-left: 3px solid #bbb; border-radius: 0; color: #555; font-size: 0.82rem; }
  .wait { color: #888; }
  .composer { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px; border: 1px solid #e2e0dc; border-radius: 18px; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.06); }
  .composer:focus-within { border-color: #c9c6c0; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.09); }
  .subject { font-size: 0.8rem; color: #555; padding: 2px 8px; background: #f4f2ee; border-radius: 10px; align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { resize: none; font: inherit; line-height: 1.4; min-height: 1.4em; padding: 2px 40px 2px 2px; border: 0; outline: none; background: transparent; }
  textarea::placeholder { color: #aaa; }
  .send { position: absolute; right: 8px; bottom: 8px; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: #1f1f1f; color: #fff; cursor: pointer; }
  .send:disabled { background: #e4e2de; color: #fff; cursor: default; }
</style>
