<script lang="ts">
  import { onMount } from 'svelte'
  import { locate, validateObjectYaml } from '@archive/core'
  import type { Diagnostic } from '@codemirror/lint'
  import Editor from './Editor.svelte'
  import Files from './Files.svelte'
  import { FakeStore } from './uploader.js'
  import { Workspace } from './workspace.svelte.js'

  // All state lives in the workspace; this component only arranges the panes.
  const ws = new Workspace(new FakeStore())

  onMount(() => {
    void ws.load()
    const onHide = () => document.visibilityState === 'hidden' && void ws.flush()
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  })

  // The object of the file that was clicked last. Without one, the editor stays empty.
  const object = $derived(ws.activeObject)
  const text = $derived(object?.text ?? '')
  const issues = $derived(object ? validateObjectYaml(text) : [])
  const diagnostics = $derived<Diagnostic[]>(
    issues.map((issue) => ({ ...locate(text, issue.path), severity: 'error', message: issue.message })),
  )
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
      <h2>YAML{#if object} <small>Object {object.number}</small>{/if}</h2>
      <div class="editor-box">
        {#if object}
          <!-- {#key}: a new editor per object, so that undo never reaches into another object. -->
          {#key object.id}
            <Editor value={object.text} {diagnostics} onchange={(next) => ws.updateText(next)} />
          {/key}
        {/if}
      </div>
      <ul class="issues" aria-label="Probleme">
        {#if object}
          {#each issues as issue}
            <li><code>{issue.path}</code> {issue.message}</li>
          {:else}
            <li class="ok">Keine Probleme.</li>
          {/each}
        {/if}
      </ul>
    </section>

    <section class="pane">
      <h2>Chat</h2>
      <p class="muted">Kommt als Nächstes.</p>
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
  .muted { color: #777; }
  .editor-box { flex: 1; min-height: 0; border: 1px solid #ddd; }
  .issues { margin: 8px 0 0; padding: 0; list-style: none; font-size: 0.9rem; max-height: 8rem; overflow: auto; }
  .issues li { padding: 2px 0; color: #a11; }
  .issues li.ok { color: #272; }
  code { background: #eee; padding: 0 4px; border-radius: 3px; }
</style>
