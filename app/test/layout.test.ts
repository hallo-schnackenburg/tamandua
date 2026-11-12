import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sizes } from '../src/layout.svelte.js'

const THIRDS = [100 / 3, 100 / 3, 100 / 3]
const sum = (parts: number[]) => parts.reduce((a, b) => a + b, 0)

describe('Sizes', () => {
  let kept: Record<string, string>
  beforeEach(() => {
    kept = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept[key] ?? null,
      setItem: (key: string, value: string) => void (kept[key] = value),
      removeItem: (key: string) => void delete kept[key],
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts with the usual sizes, and gives them to a grid with a track for each handle', () => {
    expect(new Sizes('view', THIRDS).template).toMatch(/^minmax\(0, 33\.3+\d*fr\) 12px minmax\(0, 33\.3+\d*fr\) 12px minmax\(0, 33\.3+\d*fr\)$/)
  })

  it('moves a border: the pane before it grows by what the one after it loses', () => {
    const sizes = new Sizes('view', THIRDS)
    sizes.move(0, 10, 5)
    expect(sizes.parts[0]).toBeCloseTo(43.33, 1)
    expect(sizes.parts[1]).toBeCloseTo(23.33, 1)
    expect(sizes.parts[2]).toBeCloseTo(100 / 3, 5) // the third one stays
    expect(sum(sizes.parts)).toBeCloseTo(100, 5)
  })

  it('does not make a pane smaller than the least it may be, in either direction', () => {
    const sizes = new Sizes('view', THIRDS)
    sizes.move(0, 500, 10)
    expect(sizes.parts[1]).toBeCloseTo(10, 5)
    sizes.move(0, -500, 10)
    expect(sizes.parts[0]).toBeCloseTo(10, 5)
    expect(sum(sizes.parts)).toBeCloseTo(100, 5)
  })

  it('moves from where a drag began, not from where the last step ended', () => {
    const sizes = new Sizes('view', THIRDS)
    const from = [...sizes.parts]
    sizes.move(0, 5, 5, from)
    sizes.move(0, 8, 5, from)
    expect(sizes.parts[0]).toBeCloseTo(100 / 3 + 8, 5)
  })

  it('keeps the sizes in the browser, for each view, and finds them again', () => {
    const a = new Sizes('one', THIRDS)
    a.move(1, 12, 5)
    a.save()
    expect(new Sizes('one', THIRDS).parts[1]).toBeCloseTo(100 / 3 + 12, 5)
    expect(new Sizes('other', THIRDS).parts[1]).toBeCloseTo(100 / 3, 5)
  })

  it('brings back the usual sizes, and forgets the kept ones', () => {
    const sizes = new Sizes('view', THIRDS)
    sizes.move(0, 12, 5)
    sizes.save()
    sizes.reset()
    expect(sizes.parts[0]).toBeCloseTo(100 / 3, 5)
    expect(new Sizes('view', THIRDS).parts[0]).toBeCloseTo(100 / 3, 5)
  })

  it('ignores what is kept if it does not fit any more (another number of panes, nonsense, zero)', () => {
    for (const bad of ['[50,50]', 'nonsense', '[0,50,50]', '[1,"a",3]', '{"a":1}']) {
      kept['tamandua.layout.view'] = bad
      expect(new Sizes('view', THIRDS).parts[0]).toBeCloseTo(100 / 3, 5)
    }
  })

  it('works when the browser keeps nothing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('no') },
      setItem: () => { throw new Error('no') },
      removeItem: () => { throw new Error('no') },
    })
    const sizes = new Sizes('view', THIRDS)
    sizes.move(0, 5, 5)
    expect(() => (sizes.save(), sizes.reset())).not.toThrow()
  })
})
