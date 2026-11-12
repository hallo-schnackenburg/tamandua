// The sizes of the panes of a view, which the person can change by dragging the handles between them (see Splitter.svelte).
// They are kept in this browser, one set per view, so that a favourite arrangement does not have to be made again and again.

/** The space between two panes, in pixels: the handle sits in it. */
export const GAP = 12

/** The parts are shares of the free space (they add up to 100); a grid takes them as fractions. */
export class Sizes {
  parts = $state<number[]>([])
  readonly #key: string
  readonly #defaults: number[]

  constructor(key: string, defaults: number[]) {
    this.#key = `tamandua.layout.${key}`
    this.#defaults = defaults
    this.parts = this.#read() ?? [...defaults]
  }

  /** The value for `grid-template-columns` (or `-rows`): the panes with a handle track between each two. */
  get template(): string {
    return this.parts.map((p) => `minmax(0, ${p}fr)`).join(` ${GAP}px `)
  }

  /** What was kept, if it is still usable: as many parts as there are panes, all positive. */
  #read(): number[] | undefined {
    try {
      const kept: unknown = JSON.parse(localStorage.getItem(this.#key) ?? 'null')
      if (!Array.isArray(kept) || kept.length !== this.#defaults.length || !kept.every((p) => typeof p === 'number' && Number.isFinite(p) && p > 0)) return undefined
      const sum = kept.reduce((a: number, b: number) => a + b, 0)
      return kept.map((p: number) => (p / sum) * 100)
    } catch {
      return undefined
    }
  }

  /**
   * Moves the border after pane `index` by `delta` (a share): the pane before it grows, the one after it shrinks.
   * `from` are the parts when the move started; no pane gets smaller than `min` (a share).
   */
  move(index: number, delta: number, min: number, from: number[] = this.parts): void {
    const total = from[index] + from[index + 1]
    const before = Math.min(Math.max(from[index] + delta, Math.min(min, total / 2)), total - Math.min(min, total / 2))
    const next = [...from]
    next[index] = before
    next[index + 1] = total - before
    this.parts = next
  }

  save(): void {
    try {
      localStorage.setItem(this.#key, JSON.stringify(this.parts))
    } catch {
      // not remembered, that is all
    }
  }

  reset(): void {
    this.parts = [...this.#defaults]
    try {
      localStorage.removeItem(this.#key)
    } catch {
      // nothing was kept
    }
  }
}
