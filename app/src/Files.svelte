<script lang="ts">
  import { colorOf } from './labels.js'
  import type { FileRecord, Workspace } from './workspace.svelte.js'

  let { workspace: ws }: { workspace: Workspace } = $props()

  const objectsById = $derived(new Map(ws.objects.map((o) => [o.id, o])))
  const selected = $derived(new Set(ws.selection))

  // One address per preview image; created when first shown.
  const urls = new WeakMap<Blob, string>()
  const urlOf = (blob: Blob): string => {
    let url = urls.get(blob)
    if (!url) urls.set(blob, (url = URL.createObjectURL(blob)))
    return url
  }

  const extension = (name: string) => (name.split('.').pop() ?? '').toLowerCase()

  let over = $state(false) // files from outside are over the pane
  let zone: HTMLElement | undefined

  // The whole pane is tinted, not only the area of the tiles; the tiles stay visible below the tint (the style is below, `:global`).
  $effect(() => {
    zone?.closest('.pane')?.classList.toggle('drop', over)
  })

  // --- moving a tile to an object, or out of it ---
  // Done with pointer events and not with the browser's drag and drop, because the picture
  // that is carried along must change while it is dragged (see `ghost`), and a native drag
  // image cannot be changed once it has started.
  //
  // The tile that is carried keeps the object's color while it is over its original place.
  // Away from it, the color is gone: letting go takes the file out of the object. Over
  // another object it takes that object's color: letting go moves the file there. Back over
  // the original place, the color returns, and letting go does nothing.

  interface Ghost {
    x: number
    y: number
    width: number
    file: FileRecord
    /** The border color, or none when the tile has left its object. */
    color?: string
    /** How many files are carried. */
    count: number
  }
  let ghost = $state<Ghost>()

  const colorOfFile = (file: FileRecord): string | undefined => {
    const object = file.objectId ? objectsById.get(file.objectId) : undefined
    return object ? colorOf(object.number) : undefined
  }

  function onpointerdown(event: PointerEvent, file: FileRecord) {
    if (event.button !== 0 || ws.foreign(file)) return
    const node = event.currentTarget as HTMLElement
    const size = node.getBoundingClientRect()
    const grab = { x: event.clientX - size.left, y: event.clientY - size.top }
    const start = { x: event.clientX, y: event.clientY }
    let shas: string[] = []
    let moving = false
    let away = false // the tile has left its original place
    let target: string | undefined // the object under the pointer

    const move = (e: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return // still a click
        moving = true
        // The tiles the user picked by hand go along if this is one of them, otherwise only this one.
        shas = ws.picked && selected.has(file.sha256) ? ws.files.filter((f) => selected.has(f.sha256)).map((f) => f.sha256) : [file.sha256]
        ws.dragging = shas
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      const x = e.clientX - grab.x
      const y = e.clientY - grab.y
      const home = node.getBoundingClientRect()
      const overlaps = x < home.right && x + size.width > home.left && y < home.bottom && y + size.height > home.top
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-object-id]')
      target = row?.dataset.objectId
      away = !overlaps && !target
      ws.dragTarget = target
      const targetObject = target ? objectsById.get(target) : undefined
      ghost = {
        x,
        y,
        width: size.width,
        file,
        count: shas.length,
        color: targetObject ? colorOf(targetObject.number) : overlaps ? colorOfFile(file) : undefined,
      }
    }

    const finish = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (!moving) return
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // The click that follows the release must not select anything.
      const swallow = (c: Event) => c.stopPropagation()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)

      ghost = undefined
      ws.dragging = []
      ws.dragTarget = undefined
      if (e.type === 'pointercancel') return
      if (target) ws.attach(shas, target)
      else if (away) ws.detach(shas)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

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

{#snippet badge(kind: 'progress' | 'ok' | 'bad', progress: number, message?: string)}
  {#if kind === 'progress'}
    <span class="badge progress" title="wird hochgeladen">
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" fill="none" stroke="#dcdcdc" stroke-width="2.4" />
        <circle cx="10" cy="10" r="6.5" fill="none" stroke="#4a7fd4" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="40.84" stroke-dashoffset={40.84 * (1 - Math.max(0.04, progress))} transform="rotate(-90 10 10)" />
      </svg>
    </span>
  {:else if kind === 'ok'}
    <span class="badge state ok" title="hochgeladen">
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M6 10.5l2.6 2.6L14 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
  {:else}
    <span class="badge state bad" title={message}>!</span>
  {/if}
{/snippet}

<!-- The whole pane is the drop target for files from outside, so there is no small target to aim at.
     Tiles are moved with the pointer (see above); the browser's own dragging of the tiles and their
     preview images is switched off, otherwise it would take a dragged image along as a file, and
     dropping it back here would add that image as a new file. -->
<div
  class="zone"
  bind:this={zone}
  role="region"
  aria-label="Dateien"
  ondragover={(event) => {
    if (!event.dataTransfer?.types.includes('Files')) return // not files from outside
    event.preventDefault()
    over = true
  }}
  ondragleave={(event) => {
    // dragleave also fires when the pointer moves onto a child element; ignore that.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) over = false
  }}
  {ondrop}
>
  {#if ws.visibleFiles.length === 0 && ws.pending.length === 0}
    <label class="hint empty-state">
      <span>Dateien hierher ziehen</span>
      <small>oder klicken zum Auswählen</small>
      <input type="file" multiple onchange={onpick} />
    </label>
  {:else}
    <div class="grid">
      {#each ws.visibleFiles as file (file.sha256)}
        {@const object = file.objectId ? objectsById.get(file.objectId) : undefined}
        {@const color = object ? colorOf(object.number) : undefined}
        <div
          class="tile"
          role="button"
          tabindex="0"
          class:selected={selected.has(file.sha256)}
          class:assigned={!!object}
          class:foreign={ws.foreign(file)}
          class:dragged={ws.dragging.includes(file.sha256)}
          class:failed={file.status === 'error' || file.status === 'conflict'}
          style:--color={color}
          title={ws.foreign(file) ? `${file.name} (gehört zu einer anderen Sitzung)` : file.name}
          ondragstart={(event) => event.preventDefault()}
          onpointerdown={(event) => onpointerdown(event, file)}
          onclick={(event) => ws.select(file.sha256, { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
          onkeydown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            ws.select(file.sha256, { range: event.shiftKey, toggle: event.metaKey || event.ctrlKey })
          }}
        >
          <span class="thumb">
            {#if file.preview}
              <img src={urlOf(file.preview)} alt="" draggable="false" />
            {:else}
              <span class="noimg">{extension(file.name)}</span>
            {/if}
            {#if file.status === 'uploading'}
              {@render badge('progress', file.progress ?? 0)}
            {:else if file.status === 'uploaded'}
              {@render badge('ok', 1)}
            {:else}
              {@render badge('bad', 1, file.message)}
            {/if}
          </span>
          <span class="name">{file.name}</span>
        </div>
      {/each}

      {#each ws.pending as item}
        <div class="tile pending" class:failed={item.state === 'error'}>
          <span class="thumb">
            <span class="noimg">…</span>
            {#if item.state === 'hashing'}{@render badge('progress', item.progress)}{/if}
          </span>
          <span class="name">{item.name}</span>
          {#if item.state === 'error'}
            <span class="state bad">! {item.message}</span>
            <button class="close" onclick={() => ws.dismissPending(item)} aria-label="Schließen">×</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if over}<div class="overlay">Zum Hinzufügen loslassen</div>{/if}
  {#if ghost}
    <div class="tile ghost" style:left="{ghost.x}px" style:top="{ghost.y}px" style:width="{ghost.width}px" style:border-color={ghost.color ?? '#ddd'}>
      {#if ghost.file.preview}
        <img src={urlOf(ghost.file.preview)} alt="" draggable="false" />
      {:else}
        <span class="noimg">{extension(ghost.file.name)}</span>
      {/if}
      <span class="name">{ghost.file.name}</span>
      {#if ghost.count > 1}<span class="count">{ghost.count}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .zone { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .hint { pointer-events: auto; cursor: pointer; }
  input[type='file'] { display: none; }
  .close { border: 0; background: none; cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 2px; }
  :global(main .pane.drop::after) { content: ''; position: absolute; inset: 0; border-radius: 6px; background: rgba(157, 188, 247, 0.5); pointer-events: none; }
  .overlay { position: absolute; z-index: 2; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 0.5rem 1rem; border-radius: 999px; background: rgba(255, 255, 255, 0.92); color: #36c; font-weight: 600; pointer-events: none; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; overflow: auto; align-content: start; padding: 4px; }
  .tile { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 4px; text-align: left; font: inherit; font-size: 0.78rem; background: #fafafa; border: 2px solid #e6e6e6; border-radius: 6px; cursor: pointer; user-select: none; min-width: 0; }
  .tile.assigned { border-color: var(--color); }
  .tile.selected { background: #dbe7fd; }
  .tile.dragged { opacity: 0.5; }
  .tile.foreign { opacity: 0.35; cursor: default; }
  .tile.pending { cursor: default; }
  .tile.failed { border-color: #c92a2a; }
  .tile img, .noimg { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 3px; background: #e9e9e9; }
  .noimg { display: flex; align-items: center; justify-content: center; color: #888; text-transform: uppercase; font-weight: 600; }
  .ghost { position: fixed; z-index: 10; pointer-events: none; opacity: 0.92; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25); cursor: grabbing; }
  .count { position: absolute; top: 6px; right: 6px; min-width: 1.4em; padding: 0 5px; border-radius: 10px; background: #1c1c1c; color: #fff; font-weight: 700; text-align: center; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thumb { position: relative; display: block; }
  .badge { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: rgba(255, 255, 255, 0.9); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06); font-size: 0.8rem; font-weight: 700; line-height: 1; pointer-events: none; }
  .badge.ok { color: #2b8a3e; }
  .badge.bad { background: #c92a2a; color: #fff; }
  .state.bad { font-size: 0.72rem; line-height: 1.2; color: #c92a2a; }
</style>
