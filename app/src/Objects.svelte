<script lang="ts">
  import { locate, readField, readValue, validateObjectYaml } from '@archive/core'
  import type { Diagnostic } from '@codemirror/lint'
  import Editor from './Editor.svelte'
  import { colorOf, objectLabel } from './labels.js'
  import type { ObjectRecord, Workspace } from './workspace.svelte.js'

  let { workspace: ws }: { workspace: Workspace } = $props()

  // The object of the file that was clicked last; its row is open, all others are closed.
  const active = $derived(ws.activeObject)
  const text = $derived(active?.text ?? '')
  const issues = $derived(active ? validateObjectYaml(text) : [])
  const diagnostics = $derived<Diagnostic[]>(
    issues.map((issue) => ({ ...locate(text, issue.path), severity: 'error', message: issue.message })),
  )

  // Selected files without an object: a row "new object" stands in for it, below the others.

  // What a closed row shows.
  function summary(object: ObjectRecord) {
    const type = readField(object.text, 'type')
    const date = readValue(object.text, 'date')
    const files = ws.files.filter((f) => f.objectId === object.id).length
    return {
      title: readField(object.text, 'title'),
      kind: objectLabel(type, readField(object.text, 'subtype')),
      date: date === undefined || date === null ? '' : String(date),
      files,
      problems: validateObjectYaml(object.text).length,
    }
  }

  // Show the row that was opened, e.g. after a click on a tile far down the list.
  $effect(() => {
    const id = active?.id
    if (id) queueMicrotask(() => document.getElementById(`object-${id}`)?.scrollIntoView({ block: 'nearest' }))
  })
</script>

<div class="list">
  {#each ws.objects as object (object.id)}
    {@const info = summary(object)}
    {@const open = active?.id === object.id}
    <div
      class="row"
      class:open
      class:over={ws.dragTarget === object.id}
      data-object-id={object.id}
      ondragover={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return // tiles are moved with the pointer, see Files.svelte
        event.preventDefault()
        ws.dragTarget = object.id
      }}
      ondragleave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && ws.dragTarget === object.id) ws.dragTarget = undefined
      }}
      ondrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return
        event.preventDefault()
        ws.dragTarget = undefined
        ws.addDropped(event.dataTransfer.files, object.id)
      }}
      id={`object-${object.id}`}
      style:--color={colorOf(object.number)}
      role="group"
      aria-label={`Objekt ${object.number}`}
    >
      <button class="head" aria-expanded={open} onclick={() => (open ? ws.collapse() : ws.activate(object.id))}>
        <span class="main">
          <span class="title" class:empty={!info.title}>{info.title || 'ohne Titel'}</span>
          <span class="sub">
            Objekt {object.number} · {info.kind}{info.date ? ` · ${info.date}` : ''} · {info.files}
            {info.files === 1 ? 'Datei' : 'Dateien'}
          </span>
        </span>
        {#if info.problems > 0}<span class="problems">{info.problems} offen</span>{/if}
      </button>
      {#if open}
        <div class="body">
          <!-- {#key}: a new editor per object, so that undo never reaches into another object. -->
          {#key object.id}
            <Editor value={object.text} {diagnostics} onchange={(next) => ws.updateText(next)} />
          {/key}
          {#if issues.length > 0}
            <ul class="issues" aria-label="Probleme">
              {#each issues as issue}
                <li><code>{issue.path}</code> {issue.message}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  {#if ws.objects.length === 0}
    <p class="empty-state">
      <span>Keine Objekte</span>
      <small>Lege Dateien ab und beschreibe sie.</small>
    </p>
  {/if}
</div>

<style>
  .list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  .row { flex: none; border: 1px solid #ddd; border-left: 1em solid var(--color, #bbb); border-radius: 4px; background: #fff; }
  .row.open { display: flex; flex-direction: column; flex: 0 1 auto; min-height: 16rem; border-color: #999; border-left-color: var(--color, #bbb); }
  .row.over { background: #eef3ff; }
  .head { flex: none; display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; text-align: left; font: inherit; background: none; border: 0; cursor: pointer; }
  .main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.empty { font-weight: 400; color: #999; }
  .sub { font-size: 0.78rem; color: #777; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .problems { font-size: 0.78rem; color: #a11; white-space: nowrap; }
  .body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; border-top: 1px solid #ddd; }
  .issues { margin: 0; padding: 6px 10px; list-style: none; font-size: 0.9rem; border-top: 1px solid #eee; max-height: 8rem; overflow: auto; }
  .issues li { padding: 2px 0; color: #a11; }
  code { background: #eee; padding: 0 4px; border-radius: 3px; }
</style>
