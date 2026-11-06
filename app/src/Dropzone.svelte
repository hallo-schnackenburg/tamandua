<script lang="ts">
  import type { FileEntry } from '@archive/core'
  import { prepareFile } from './prepare.js'

  interface Props {
    /** Adds the entry to the object. Throws an Error with a message if that is not possible. */
    onfile: (entry: FileEntry) => void
  }

  let { onfile }: Props = $props()

  interface Item {
    name: string
    state: 'working' | 'done' | 'error'
    progress: number
    message?: string
    previewUrl?: string
  }

  let items = $state<Item[]>([])
  let over = $state(false)
  let busy = false

  // One file after the other: hashing several large scans at once helps nobody.
  const queue: File[] = []

  async function run() {
    if (busy) return
    busy = true
    for (let file = queue.shift(); file; file = queue.shift()) {
      items.push({ name: file.name, state: 'working', progress: 0 })
      const item = items[items.length - 1] // the reactive version of the item
      try {
        const { entry, preview } = await prepareFile(file, (fraction) => (item.progress = fraction))
        onfile(entry)
        if (preview) item.previewUrl = URL.createObjectURL(preview)
        item.state = 'done'
      } catch (error) {
        item.state = 'error'
        item.message = (error as Error).message
      }
    }
    busy = false
  }

  function add(files: Iterable<File>) {
    queue.push(...files)
    run()
  }

  function ondrop(event: DragEvent) {
    event.preventDefault()
    over = false
    add(event.dataTransfer?.files ?? [])
  }

  function onpick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    add(input.files ?? [])
    input.value = '' // so that the same file can be picked again
  }
</script>

<!-- The whole pane is the drop target, so there is no small target to aim at. -->
<div
  class="zone"
  class:over
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
  {#if items.length === 0}
    <label class="hint">
      <span>Dateien hierher ziehen</span>
      <small>oder klicken zum Auswählen</small>
      <input type="file" multiple onchange={onpick} />
    </label>
  {:else}
    <label class="more">
      + Dateien auswählen
      <input type="file" multiple onchange={onpick} />
    </label>
    <ul class="items">
      {#each items as item}
        <li class={item.state}>
          {#if item.previewUrl}<img src={item.previewUrl} alt="" />{/if}
          <div>
            <strong>{item.name}</strong>
            {#if item.state === 'working'}
              <progress value={item.progress} max="1"></progress>
            {:else if item.state === 'done'}
              <span class="ok">Hinzugefügt</span>
            {:else}
              <span class="err">{item.message}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {#if over}<div class="overlay">Zum Hinzufügen loslassen</div>{/if}
</div>

<style>
  .zone { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .hint { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 2px dashed #bbb; border-radius: 6px; color: #666; cursor: pointer; text-align: center; }
  .hint small { color: #999; }
  .more { align-self: flex-start; color: #36c; cursor: pointer; font-size: 0.9rem; margin-bottom: 4px; }
  input { display: none; }
  .overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border: 2px dashed #36c; border-radius: 6px; background: #eef3ff; color: #36c; font-weight: 600; pointer-events: none; }
  .items { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
  li { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  li div { display: flex; flex-direction: column; min-width: 0; }
  strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  img { width: 56px; height: 56px; object-fit: cover; border-radius: 3px; }
  .ok { color: #272; }
  .err { color: #a11; }
  progress { width: 100%; }
</style>
