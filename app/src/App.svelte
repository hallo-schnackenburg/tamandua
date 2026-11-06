<script lang="ts">
  import { addFile, locate, validateObjectYaml, type FileEntry } from '@archive/core'
  import type { Diagnostic } from '@codemirror/lint'
  import Editor from './Editor.svelte'
  import Dropzone from './Dropzone.svelte'
  import { newDraftText } from './template.js'

  // `$state` makes `text` reactive: whatever uses it is updated when it changes.
  let text = $state(newDraftText())

  // `$derived` is recomputed whenever `text` changes. All checks come from the core.
  const issues = $derived(validateObjectYaml(text))
  const diagnostics = $derived<Diagnostic[]>(
    issues.map((issue) => ({ ...locate(text, issue.path), severity: 'error', message: issue.message })),
  )
</script>

<main>
  <section class="pane">
    <h2>Chat</h2>
    <p class="muted">Kommt in Schritt 5.</p>
  </section>

  <section class="pane">
    <h2>Dateien</h2>
    <Dropzone onfile={(entry: FileEntry) => (text = addFile(text, entry))} />
  </section>

  <section class="pane editor-pane">
    <h2>YAML</h2>
    <div class="editor-box">
      <Editor value={text} {diagnostics} onchange={(next) => (text = next)} />
    </div>
    <ul class="issues" aria-label="Probleme">
      {#each issues as issue}
        <li><code>{issue.path}</code> {issue.message}</li>
      {:else}
        <li class="ok">Keine Probleme.</li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main { display: grid; grid-template-columns: 1fr 1.2fr 1.6fr; gap: 12px; height: 100%; padding: 12px; }
  .pane { display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: 6px; padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 1rem; }
  .muted { color: #777; }
  .editor-box { flex: 1; min-height: 0; border: 1px solid #ddd; }
  .issues { margin: 8px 0 0; padding: 0; list-style: none; font-size: 0.9rem; max-height: 8rem; overflow: auto; }
  .issues li { padding: 2px 0; color: #a11; }
  .issues li.ok { color: #272; }
  code { background: #eee; padding: 0 4px; border-radius: 3px; }
</style>
