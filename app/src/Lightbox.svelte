<script lang="ts">
  import { addressOf, sourceOf, type Viewable } from './viewer.js'
  import { clampView, fit, HOME, zoomAt, type Size, type View } from './zoom.js'

  type Item = Viewable & { sha256: string }
  let { files, start, base, onclose }: { files: Item[]; start: number; base?: string; onclose: () => void } = $props()

  let index = $state(start)
  const file = $derived(files[index])
  const source = $derived(sourceOf(file, base))

  // Addresses for the blobs of the current file; given back when the file changes.
  let previewUrl = $state<string>()
  let largeUrl = $state<string>()
  $effect(() => {
    const made: string[] = []
    const make = (blob: Blob) => {
      const url = URL.createObjectURL(blob)
      made.push(url)
      return url
    }
    previewUrl = source.preview ? make(source.preview) : undefined
    largeUrl = source.large instanceof Blob ? make(source.large) : source.large
    return () => made.forEach((url) => URL.revokeObjectURL(url))
  })

  let loaded = $state(false) // the large picture is there
  let failed = $state(false)
  $effect(() => {
    void largeUrl
    loaded = false
    failed = false
    view = HOME
  })

  let stage = $state<Size>({ w: 800, h: 600 })
  let natural = $state<Size>() // the shape of the preview, if the entry does not tell
  const shape = $derived<Size>(source.width && source.height ? { w: source.width, h: source.height } : (natural ?? { w: 4, h: 3 }))
  const shown = $derived(fit(stage, shape))

  let view = $state<View>(HOME)
  const apply = (next: View) => (view = clampView(next, stage, shown))
  // Points are measured from the middle of the window.
  let area: HTMLElement | undefined
  const centered = (x: number, y: number) => {
    const box = area!.getBoundingClientRect()
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 }
  }

  function onwheel(event: WheelEvent) {
    event.preventDefault()
    // A pinch on a trackpad arrives as a wheel with ctrlKey and small steps.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))
    view = zoomAt(view, factor, centered(event.clientX, event.clientY), stage, shown)
  }

  // One pointer moves the picture, two pointers pinch it.
  const pointers = new Map<number, { x: number; y: number }>()
  let last = 0 // distance of the two pointers
  let moved = false
  function onpointerdown(event: PointerEvent) {
    if ((event.target as Element).closest('button, a')) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    moved = false
    if (pointers.size === 2) last = distance()
  }
  const distance = () => {
    const [a, b] = [...pointers.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  function onpointermove(event: PointerEvent) {
    const before = pointers.get(event.pointerId)
    if (!before) return
    const now = { x: event.clientX, y: event.clientY }
    pointers.set(event.pointerId, now)
    if (pointers.size === 1) {
      if (Math.hypot(now.x - before.x, now.y - before.y) > 0) moved = true
      apply({ ...view, x: view.x + now.x - before.x, y: view.y + now.y - before.y })
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const size = distance()
      if (last > 0) view = zoomAt(view, size / last, centered((a.x + b.x) / 2, (a.y + b.y) / 2), stage, shown)
      last = size
      moved = true
    }
  }
  function onpointerup(event: PointerEvent) {
    pointers.delete(event.pointerId)
    last = 0
  }

  function toggle(event: MouseEvent) {
    view = view.z > 1 ? HOME : zoomAt(HOME, 2.5, centered(event.clientX, event.clientY), stage, shown)
  }

  const go = (step: number) => {
    const next = index + step
    if (next >= 0 && next < files.length) index = next
  }
  const by = (factor: number) => (view = zoomAt(view, factor, { x: 0, y: 0 }, stage, shown))

  function onkeydown(event: KeyboardEvent) {
    const keys: Record<string, () => void> = {
      Escape: onclose,
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      '+': () => by(1.4),
      '=': () => by(1.4),
      '-': () => by(1 / 1.4),
      '0': () => (view = HOME),
    }
    const action = keys[event.key]
    if (!action) return
    event.preventDefault()
    action()
  }

  // Focus goes in, and back to where it was.
  let dialog: HTMLElement | undefined
  $effect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog?.focus()
    return () => before?.focus?.()
  })
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="lightbox" role="dialog" aria-modal="true" aria-label={file.name} tabindex="-1" bind:this={dialog} onpointerdown={(event) => event.stopPropagation()} onclick={(event) => event.stopPropagation()}>
  <header>
    <span class="title">{file.name}</span>
    {#if files.length > 1}<span class="count">{index + 1} / {files.length}</span>{/if}
    <span class="spacer"></span>
    {#if source.original}<a href={source.original} target="_blank" rel="noopener">Original öffnen</a>{/if}
    <button onclick={onclose} aria-label="Schließen">×</button>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="area"
    bind:this={area}
    bind:clientWidth={stage.w}
    bind:clientHeight={stage.h}
    {onwheel}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={onpointerup}
    ondblclick={toggle}
    onclick={(event) => {
      // A click beside the picture closes; one that ended a move does not.
      if (event.target === area && !moved) onclose()
    }}
  >
    <div class="frame" class:zoomed={view.z > 1} style:width="{shown.w}px" style:height="{shown.h}px" style:transform="translate({view.x}px, {view.y}px) scale({view.z})">
      {#if previewUrl}
        <img src={previewUrl} alt="" draggable="false" onload={(event) => { const img = event.currentTarget as HTMLImageElement; if (!source.width) natural = { w: img.naturalWidth, h: img.naturalHeight } }} />
      {:else}
        <span class="none">Keine Vorschau</span>
      {/if}
      {#if largeUrl && !failed}
        <img class="large" class:loaded src={largeUrl} alt={file.name} draggable="false" onload={() => (loaded = true)} onerror={() => (failed = true)} />
      {/if}
    </div>
    {#if largeUrl && !loaded && !failed}<span class="hint">Wird geladen …</span>{/if}
    {#if failed}<span class="hint">Das große Bild ließ sich nicht laden.</span>{/if}
  </div>

  {#if index > 0}<button class="step prev" onclick={() => go(-1)} aria-label="Vorherige Datei">‹</button>{/if}
  {#if index < files.length - 1}<button class="step next" onclick={() => go(1)} aria-label="Nächste Datei">›</button>{/if}

  <footer>
    <button onclick={() => by(1 / 1.4)} aria-label="Verkleinern">−</button>
    <button class="level" onclick={() => (view = HOME)} aria-label="Einpassen">{Math.round(view.z * 100)} %</button>
    <button onclick={() => by(1.4)} aria-label="Vergrößern">+</button>
  </footer>
</div>

<style>
  .lightbox { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; background: rgba(18, 18, 18, 0.94); color: #eee; outline: none; touch-action: none; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px; font-size: 0.85rem; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .count { color: #aaa; flex: none; }
  .spacer { flex: 1; }
  header a { color: #cfd8f6; flex: none; }
  button { border: 0; background: rgba(255, 255, 255, 0.12); color: inherit; font: inherit; cursor: pointer; border-radius: 999px; min-width: 2rem; height: 2rem; line-height: 1; }
  button:hover { background: rgba(255, 255, 255, 0.22); }
  header button { font-size: 1.3rem; }

  .area { position: relative; flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden; cursor: grab; }
  .area:active { cursor: grabbing; }
  .frame { position: relative; flex: none; transform-origin: center; will-change: transform; background: #222; }
  .frame img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; user-select: none; }
  .large { opacity: 0; transition: opacity 0.15s; }
  .large.loaded { opacity: 1; }
  .none { position: absolute; inset: 0; display: grid; place-items: center; color: #888; }
  .hint { position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%); padding: 3px 12px; border-radius: 999px; background: rgba(0, 0, 0, 0.6); font-size: 0.78rem; pointer-events: none; }

  .step { position: absolute; top: 50%; transform: translateY(-50%); width: 2.6rem; height: 2.6rem; font-size: 1.8rem; padding-bottom: 4px; }
  .prev { left: 12px; }
  .next { right: 12px; }
  footer { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; gap: 4px; padding: 4px; border-radius: 999px; background: rgba(0, 0, 0, 0.55); }
  footer .level { min-width: 4rem; font-size: 0.8rem; }
</style>
