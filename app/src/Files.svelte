<script lang="ts">
  import type { Workspace } from './workspace.svelte.js'

  let { workspace: ws }: { workspace: Workspace } = $props()

  // One color per object. Color alone is not enough (color blindness, printouts),
  // so every tile of an object also carries the object's number.
  const PALETTE = ['#1c7ed6', '#d9480f', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4']

  const objectsById = $derived(new Map(ws.objects.map((o) => [o.id, o])))
  const selected = $derived(new Set(ws.selection))
  const freeSelected = $derived(ws.files.filter((f) => selected.has(f.sha256) && !f.objectId).length)

  // One address per preview image; created when first shown.
  const urls = new WeakMap<Blob, string>()
  const urlOf = (blob: Blob): string => {
    let url = urls.get(blob)
    if (!url) urls.set(blob, (url = URL.createObjectURL(blob)))
    return url
  }

  const extension = (name: string) => (name.split('.').pop() ?? '').toLowerCase()

  // For the temporary "create object" controls, until the chat does this.
  let type = $state<'photo' | 'document'>('photo')
  let subtype = $state('letter')

  let over = $state(false)

  function ondrop(event: DragEvent) {
    event.preventDefault()
    over = false
    ws.addDropped(event.dataTransfer?.files ?? [])
  }

  function onpick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    ws.addDropped(input.files ?? [])
    input.value = '' // so that the same file can be picked again
  }
</script>

<!-- The whole pane is the drop target, so there is no small target to aim at. -->
<div
  class="zone"
  role="region"
  aria-label="Dateien"
  ondragover={(event) => {
    event.preventDefault()
    over = true
  }}
  ondragleave={(event) => {
    // dragleave also fires when the pointer moves onto a child element; ignore that.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) over = false
  }}
  {ondrop}
>
  {#if ws.files.length === 0 && ws.pending.length === 0}
    <label class="hint">
      <span>Dateien hierher ziehen</span>
      <small>oder klicken zum Auswählen</small>
      <input type="file" multiple onchange={onpick} />
    </label>
  {:else}
    <div class="toolbar">
      <label class="more">
        + Dateien
        <input type="file" multiple onchange={onpick} />
      </label>
      <span class="spacer"></span>
      <span class="count">{freeSelected} frei ausgewählt</span>
      <select bind:value={type} aria-label="Typ">
        <option value="photo">Foto</option>
        <option value="document">Dokument</option>
      </select>
      {#if type === 'document'}
        <select bind:value={subtype} aria-label="Untertyp">
          <option value="letter">Brief</option>
          <option value="protocol">Protokoll</option>
          <option value="note">Notiz</option>
          <option value="other">Sonstiges</option>
        </select>
      {/if}
      <button disabled={freeSelected === 0} onclick={() => ws.createObjects(type, subtype)}>Object anlegen</button>
    </div>

    {#each ws.notices as notice, index}
      <p class="notice">
        {notice}
        <button class="close" onclick={() => ws.dismissNotice(index)} aria-label="Schließen">×</button>
      </p>
    {/each}

    <div class="grid">
      {#each ws.files as file (file.sha256)}
        {@const object = file.objectId ? objectsById.get(file.objectId) : undefined}
        {@const color = object ? PALETTE[(object.number - 1) % PALETTE.length] : undefined}
        <button
          class="tile"
          class:selected={selected.has(file.sha256)}
          class:assigned={!!object}
          style:--color={color}
          title={file.name}
          onclick={(event) => ws.select(file.sha256, { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
        >
          {#if object}<span class="badge">{object.number}</span>{/if}
          {#if file.preview}
            <img src={urlOf(file.preview)} alt="" />
          {:else}
            <span class="noimg">{extension(file.name)}</span>
          {/if}
          <span class="name">{file.name}</span>
          {#if file.status === 'uploading'}
            <progress value={file.progress ?? 0} max="1"></progress>
          {:else if file.status === 'uploaded'}
            <span class="state ok">✓ hochgeladen</span>
          {:else}
            <span class="state bad">! {file.message}</span>
          {/if}
        </button>
      {/each}

      {#each ws.pending as item}
        <div class="tile pending" class:failed={item.state === 'error'}>
          <span class="noimg">…</span>
          <span class="name">{item.name}</span>
          {#if item.state === 'hashing'}
            <progress value={item.progress} max="1"></progress>
          {:else}
            <span class="state bad">! {item.message}</span>
            <button class="close" onclick={() => ws.dismissPending(item)} aria-label="Schließen">×</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if over}<div class="overlay">Zum Hinzufügen loslassen</div>{/if}
</div>

<style>
  .zone { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .hint { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 2px dashed #bbb; border-radius: 6px; color: #666; cursor: pointer; text-align: center; }
  .hint small { color: #999; }
  input[type='file'] { display: none; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 0.9rem; }
  .spacer { flex: 1; }
  .more { color: #36c; cursor: pointer; }
  .count { color: #777; }
  .notice { margin: 0 0 6px; padding: 4px 8px; background: #fff4e0; border-radius: 4px; font-size: 0.85rem; display: flex; justify-content: space-between; gap: 8px; }
  .close { border: 0; background: none; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 2px; }
  .overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border: 2px dashed #36c; border-radius: 6px; background: #eef3ff; color: #36c; font-weight: 600; pointer-events: none; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; overflow: auto; align-content: start; padding: 4px; }
  .tile { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 4px; text-align: left; font: inherit; font-size: 0.78rem; background: #fafafa; border: 3px solid #ddd; border-radius: 6px; cursor: pointer; user-select: none; min-width: 0; }
  .tile.assigned { border-color: var(--color); }
  .tile.selected { background: #e8f0fe; outline: 2px solid #1c1c1c; outline-offset: 1px; }
  .tile.pending { cursor: default; }
  .tile.failed { border-color: #c92a2a; }
  .tile img, .noimg { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 3px; background: #e9e9e9; }
  .noimg { display: flex; align-items: center; justify-content: center; color: #888; text-transform: uppercase; font-weight: 600; }
  .badge { position: absolute; top: 6px; left: 6px; min-width: 1.4em; padding: 0 5px; border-radius: 10px; background: var(--color); color: #fff; font-weight: 700; text-align: center; z-index: 1; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { font-size: 0.72rem; line-height: 1.2; }
  .state.ok { color: #2b8a3e; }
  .state.bad { color: #c92a2a; }
  progress { width: 100%; height: 6px; }
</style>
