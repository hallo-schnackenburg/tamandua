<script lang="ts">
  import { GAP, type Sizes } from './layout.svelte.js'

  // The handle between two panes of a grid (it sits in the track the grid leaves between them). Drag it, or use the arrow keys;
  // a double click brings back the usual sizes.
  // `fixed`: pixels of the grid that are not shared (a pane of fixed width); `shares`: what the parts that are shared add up to.
  let { sizes, index, axis = 'x', min = 256, fixed = 0, shares = 100 }: { sizes: Sizes; index: number; axis?: 'x' | 'y'; min?: number; fixed?: number; shares?: number } = $props()

  /** The track of the grid the handle sits in (counted from 1): the panes are in the odd ones. */
  const track = $derived(2 * index + 2)
  const horizontal = $derived(axis === 'x')
  let dragging = $state(false)
  let from: number[] = []
  let start = 0

  /** The pixels the panes share. */
  function pixels(element: HTMLElement): number {
    const box = element.parentElement!.getBoundingClientRect()
    return (horizontal ? box.width : box.height) - GAP * (sizes.parts.length - 1) - fixed
  }

  function down(event: PointerEvent) {
    if (event.button !== 0) return
    const element = event.currentTarget as HTMLElement
    element.setPointerCapture(event.pointerId)
    dragging = true
    from = [...sizes.parts]
    start = horizontal ? event.clientX : event.clientY
    event.preventDefault()
  }
  function moved(event: PointerEvent) {
    if (!dragging) return
    const element = event.currentTarget as HTMLElement
    const room = pixels(element)
    if (room <= 0) return
    sizes.move(index, (((horizontal ? event.clientX : event.clientY) - start) / room) * shares, (min / room) * shares, from)
  }
  function up() {
    if (!dragging) return
    dragging = false
    sizes.save()
  }
  function key(event: KeyboardEvent) {
    const more = horizontal ? 'ArrowRight' : 'ArrowDown'
    const less = horizontal ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== more && event.key !== less) return
    event.preventDefault()
    const room = pixels(event.currentTarget as HTMLElement)
    if (room <= 0) return
    sizes.move(index, event.key === more ? (2 * shares) / 100 : (-2 * shares) / 100, (min / room) * shares)
    sizes.save()
  }
</script>

<!-- A separator that can be focused is a widget (the pattern of a window splitter). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="split"
  class:x={horizontal}
  class:y={!horizontal}
  class:dragging
  role="separator"
  aria-orientation={horizontal ? 'vertical' : 'horizontal'}
  aria-valuenow={Math.round(sizes.parts[index])}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-label="Größe ändern (Pfeiltasten, Doppelklick setzt zurück)"
  tabindex="0"
  style:grid-column={horizontal ? track : undefined}
  style:grid-row={horizontal ? undefined : track}
  onpointerdown={down}
  onpointermove={moved}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
  ondblclick={() => sizes.reset()}
></div>

<style>
  .split { position: relative; touch-action: none; outline: none; }
  .split.x { cursor: col-resize; grid-row: 1; }
  .split.y { cursor: row-resize; grid-column: 1; }
  /* A thin line in the middle of the gap shows itself when the pointer is near, or while it is being moved. */
  /* No hover or drag highlight: the cursor is the cue. Keyboard focus stays visible. */
  .split::after { content: ''; position: absolute; border-radius: 2px; background: transparent; }
  .split.x::after { left: 4px; right: 4px; top: 10%; bottom: 10%; }
  .split.y::after { top: 4px; bottom: 4px; left: 10%; right: 10%; }
  .split:focus-visible::after { background: #b9c8ee; }
</style>
