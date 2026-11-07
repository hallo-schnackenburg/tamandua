<script lang="ts">
  import * as db from './db.js'
  import { onMount } from 'svelte'
  import Chat from './Chat.svelte'
  import Files from './Files.svelte'
  import Objects from './Objects.svelte'
  import { FakeAgent } from './agent.js'
  import { WorkerAgent } from './worker-agent.js'
  import { FakeStore, S3Store } from './uploader.js'
  import { FakeBackend, HttpBackend } from './backend.js'
  import { onSignedOut } from './api.js'
  import { Workspace } from './workspace.svelte.js'

  // All state lives in the workspace; this component only arranges the panes.
  // With a Worker the app is real: the model answers and files go to the bucket. Without one, stand-ins.
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const ws = new Workspace(
    workerUrl ? new S3Store(workerUrl) : new FakeStore(),
    workerUrl ? new WorkerAgent(workerUrl) : new FakeAgent(),
    workerUrl ? new HttpBackend(workerUrl) : new FakeBackend(),
  )

  /** Why a sign-in did not work, from the address GitHub sent the browser back to (see the Worker's /auth/callback). */
  function loginNotice(): string | undefined {
    const params = new URLSearchParams(location.search)
    const result = params.get('login')
    if (!result) return undefined
    history.replaceState(null, '', location.pathname) // the notice is shown once
    if (result === 'denied') {
      return `Du bist als „${params.get('user') ?? '?'}“ bei GitHub angemeldet, aber noch nicht freigeschaltet. Gib dein GitHub-Konto beim Archiv-Team an, damit es dich ins Repository einlädt.`
    }
    return 'Die Anmeldung bei GitHub hat nicht geklappt. Bitte versuche es noch einmal.'
  }

  let confirming = $state(false)

  function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    ws.addDropped(input.files ?? [])
    input.value = '' // so that the same file can be picked again
  }

  onMount(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as { workspace: Workspace }).workspace = ws // for the console and the browser tests
      // Development helper for the console: `resetArchive()` clears everything stored in the browser and reloads.
      ;(window as unknown as { resetArchive: () => Promise<void> }).resetArchive = async () => {
        await db.reset()
        location.reload()
      }
    }
    void ws.load()
    void ws.refreshSession(loginNotice())
    const stopSignedOut = onSignedOut(() => ws.signedOut())
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void ws.flush()
        void ws.sync()
      } else {
        void ws.checkPulls()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    const poll = setInterval(() => document.visibilityState === 'visible' && void ws.checkPulls(), 60_000)
    return () => {
      stopSignedOut()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  })

  // A file dropped on a part of the page that does not take it would be opened by the browser,
  // and the page with it. Files from outside go to the "Dateien" pane only.
  onMount(() => {
    const stop = (event: DragEvent) => event.dataTransfer?.types.includes('Files') && event.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  })
</script>

<main>
  {#if ws.session.state === 'user'}
    {@const user = ws.session.user}
    <header>
      <strong class="brand">Tamandua</strong>
      <span class="sync" class:failed={ws.syncState === 'failed'} role="status">
        {#if ws.syncState === 'failed'}
          Noch nicht in GitHub gesichert{ws.syncError ? `: ${ws.syncError}` : ''}
        {:else if ws.syncState === 'saving'}
          Wird gesichert …
        {:else if ws.objects.some((o) => o.text !== o.synced)}
          Änderungen werden gleich gesichert
        {:else if ws.objects.length > 0}
          Alles gesichert
        {/if}
      </span>
      {#if ws.saveState === 'failed'}
        <span class="sync failed">Nicht gespeichert: Änderungen gehen verloren, wenn du die Seite schließt.</span>
      {/if}
      <span class="spacer"></span>
      {#if confirming}
        <span class="confirm">
          {ws.outgoing.length === 1 ? 'Ein Objekt' : `${ws.outgoing.length} Objekte`} einreichen?
          <button class="primary" onclick={() => { confirming = false; void ws.submit() }}>Ja, einreichen</button>
          <button onclick={() => (confirming = false)}>Abbrechen</button>
        </span>
      {:else}
        <button class="primary" disabled={ws.outgoing.length === 0 || ws.submitting} onclick={() => (confirming = true)}>
          {ws.submitting ? 'Wird eingereicht …' : ws.outgoing.length > 0 ? `${ws.outgoing.length} einreichen` : 'Einreichen'}
        </button>
      {/if}
      <span class="user">
        {#if user.avatar}<img src={user.avatar} alt="" width="24" height="24" />{/if}
        {user.name || user.login}
      </span>
      <button class="link" onclick={() => ws.logout()}>Abmelden</button>
    </header>

    <div class="panes">
      <section class="pane">
        <h2>Chat</h2>
        <Chat workspace={ws} />
      </section>

      <section class="pane">
        <h2>
          Dateien
          <label class="add" title="Dateien hinzufügen" aria-label="Dateien hinzufügen">
            +
            <input type="file" multiple onchange={pick} />
          </label>
        </h2>
        <Files workspace={ws} />
      </section>

      <section class="pane">
        <h2>Objekte</h2>
        <Objects workspace={ws} />
      </section>
    </div>
  {:else if ws.session.state === 'loading'}
    <div class="welcome"><p class="quiet">Einen Moment …</p></div>
  {:else}
    <div class="welcome">
      <h1>Tamandua</h1>
      <p>Hier erfasst du Objekte des Archivs.</p>
      {#if ws.session.state === 'anonymous'}
        {#if ws.session.notice}<p class="notice">{ws.session.notice}</p>{/if}
        <a class="primary button" href={ws.loginUrl}>Mit GitHub anmelden</a>
        {#if ws.objects.length > 0}<p class="quiet">Deine bisherige Arbeit auf diesem Gerät bleibt erhalten.</p>{/if}
      {:else}
        <p class="notice">{ws.session.message}</p>
        <button class="primary" onclick={() => ws.refreshSession()}>Noch einmal versuchen</button>
      {/if}
    </div>
  {/if}
</main>

<style>
  main { display: flex; flex-direction: column; gap: 12px; height: 100%; padding: 12px; }
  header { display: flex; align-items: center; gap: 12px; font-size: 0.9rem; min-height: 28px; }
  .brand { font-size: 1rem; }
  .spacer { flex: 1; }
  .sync { color: #777; }
  .sync.failed { color: #a11; }
  .user { display: inline-flex; align-items: center; gap: 6px; }
  .user img { border-radius: 50%; }
  .confirm { display: inline-flex; align-items: center; gap: 8px; }
  button { font: inherit; padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
  button.primary, a.primary { background: #36c; border-color: #36c; color: #fff; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.link { border: 0; background: none; color: #36c; padding: 4px; }
  .welcome { margin: auto; max-width: 28rem; text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .welcome h1 { margin: 0; }
  .welcome p { margin: 0; }
  .button { display: inline-block; padding: 8px 16px; border-radius: 6px; text-decoration: none; }
  .notice { color: #a11; }
  .quiet { color: #888; font-size: 0.9rem; }
  .panes { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.6fr); /* minmax(0, …): long YAML lines must not widen the pane */ gap: 12px; min-height: 0; }
  /* The hint of an empty pane: centered below the heading, on the same height in every pane. */
  :global(.empty-state) { position: absolute; margin: 0; padding: 0; inset: calc(20px + 1.6rem) 12px 12px 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; line-height: 1.3; color: #aaa; text-align: center; pointer-events: none; }
  :global(.empty-state small) { font-size: 0.78rem; color: #c4c4c4; }
  .pane { position: relative; display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: 6px; padding: 12px; }
  h2 { display: flex; align-items: center; height: 1.6rem; margin: 0 0 8px; font-size: 1rem; }
  .add { margin-left: auto; width: 1.6rem; height: 1.6rem; display: grid; place-items: center; border-radius: 50%; color: #36c; font-size: 1.3rem; font-weight: 400; line-height: 1; cursor: pointer; }
  .add:hover { background: #eef2fb; }
  .add input { display: none; }
</style>
