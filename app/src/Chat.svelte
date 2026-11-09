<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { readField } from '@tamandua/core'
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

  // The hint in the input; it moves on to the next one after every message, starting at a random one.
  const hints = ['Erzähl mir, was du da hast …', 'Was hast du da Schönes?', 'Worum geht’s?', 'Sag mir, was du siehst …', 'Erzähl mir etwas über die Datei …']
  let hint = $state(Math.floor(Math.random() * hints.length))

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

  // The objects of those files, if they have any: a message to a file that has none creates an object, so there is nothing to show then.
  const objectSubject = $derived.by(() => {
    const ids = new Set(ws.target.map((f) => f.objectId).filter((id): id is string => !!id))
    const objects = ws.objects.filter((o) => ids.has(o.id))
    if (objects.length === 0) return ''
    if (objects.length > 1) return `${objects.length} Objekte`
    const title = readField(objects[0].text, 'title')
    return `Objekt ${objects[0].number}${typeof title === 'string' && title ? `: ${title}` : ''}`
  })

  function submit() {
    if (ws.busy || !text.trim()) return
    const message = text
    text = ''
    if (ws.command(message)) return
    hint = (hint + 1) % hints.length
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
    {#if ws.busy}<p class="assistant wait" role="status"><span class="spinner" aria-hidden="true"></span>Einen Moment …</p>{/if}
  </div>

  <div class="composer">
    {#if subject}
      <div class="subjects">
        <span class="subject">{subject}</span>
        {#if objectSubject}<span class="subject object">{objectSubject}</span>{/if}
      </div>
    {/if}
    <textarea
      bind:this={input}
      bind:value={text}
      {onkeydown}
      rows="1"
      placeholder={hints[hint]}
    ></textarea>
    <button class="send" onclick={submit} disabled={ws.busy || !text.trim()} aria-label="Senden">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
    </button>
  </div>
</div>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
  .log { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
  p { margin: 0; padding: 6px 10px; border-radius: var(--r-m); max-width: 92%; white-space: pre-line; font-size: 0.92rem; }
  /* The person speaks on the right, in a blue bubble; the answers stand on the left, in a light warm gray bubble. */
  .user { align-self: flex-end; max-width: 88%; background: #dbe7fd; }
  .assistant { align-self: flex-start; max-width: 88%; background: #f3f2ee; }
  .status { align-self: stretch; max-width: none; background: none; border-left: 3px solid #bbb; border-radius: 0; color: #555; font-size: 0.82rem; }
  .wait { color: #888; display: flex; align-items: center; gap: 8px; }
  .spinner { width: 10px; height: 10px; border: 1.5px solid #ccc; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .composer { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px; border: 1px solid #e2e0dc; border-radius: var(--r-l); background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.06); }
  .composer:focus-within { border-color: #c9c6c0; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.09); }
  .subjects { display: flex; flex-wrap: wrap; gap: 6px; align-self: flex-start; max-width: 100%; }
  .subject { font-size: 0.8rem; color: #6b5a1e; padding: 2px 8px; background: #f7f0d2; border-radius: 999px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject.object { color: #2c4a8a; background: #e3ebfa; }
  textarea { resize: none; font: inherit; line-height: 1.4; min-height: 1.4em; padding: 2px 40px 2px 2px; border: 0; outline: none; background: transparent; }
  textarea::placeholder { color: #aaa; }
  .send { position: absolute; right: 8px; bottom: 8px; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: #1f1f1f; color: #fff; cursor: pointer; }
  .send:disabled { background: #e4e2de; color: #fff; cursor: default; }
</style>
