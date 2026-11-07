<script lang="ts">
  import { onMount } from 'svelte'
  import Chat from './Chat.svelte'
  import Files from './Files.svelte'
  import Objects from './Objects.svelte'
  import { FakeAgent } from './agent.js'
  import { WorkerAgent } from './worker-agent.js'
  import { FakeStore } from './uploader.js'
  import { Workspace } from './workspace.svelte.js'

  // All state lives in the workspace; this component only arranges the panes.
  const ws = new Workspace(
    new FakeStore(),
    import.meta.env.VITE_WORKER_URL ? new WorkerAgent(import.meta.env.VITE_WORKER_URL) : new FakeAgent(),
  )

  onMount(() => {
    void ws.load()
    const onHide = () => document.visibilityState === 'hidden' && void ws.flush()
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
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
  <header>
    <strong>Stadtarchiv</strong>
    <span class="save" class:failed={ws.saveState === 'failed'}>
      {ws.saveState === 'saved' ? 'Gespeichert' : ws.saveState === 'saving' ? 'Speichert …' : 'Nicht gespeichert'}
    </span>
  </header>

  <div class="panes">
    <section class="pane">
      <h2>Dateien</h2>
      <Files workspace={ws} />
    </section>

    <section class="pane">
      <h2>Objects{#if ws.objects.length > 0} <small>{ws.objects.length}</small>{/if}</h2>
      <Objects workspace={ws} />
    </section>

    <section class="pane">
      <h2>Chat</h2>
      <Chat workspace={ws} />
    </section>
  </div>
</main>

<style>
  main { display: grid; grid-template-rows: auto 1fr; gap: 12px; height: 100%; padding: 12px; }
  header { display: flex; align-items: center; gap: 10px; }
  .save { margin-left: auto; color: #777; font-size: 0.85rem; }
  .save.failed { color: #a11; }
  .panes { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.6fr) minmax(0, 1fr); /* minmax(0, …): long YAML lines must not widen the pane */ gap: 12px; min-height: 0; }
  .pane { display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: 6px; padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 1rem; }
  h2 small { font-weight: 400; color: #777; margin-left: 6px; }
</style>
