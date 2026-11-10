import { describe, expect, it } from 'vitest'
import { clampView, fit, HOME, MAX_ZOOM, zoomAt } from '../src/zoom.js'

const stage = { w: 1000, h: 800 }

describe('fit', () => {
  it('makes a picture fit into the window with a margin, whatever its shape', () => {
    expect(fit(stage, { w: 4000, h: 2000 }, 0)).toEqual({ w: 1000, h: 500 }) // wide: the width counts
    expect(fit(stage, { w: 1000, h: 4000 }, 0)).toEqual({ w: 200, h: 800 }) // tall: the height counts
    const small = fit(stage, { w: 100, h: 100 }, 24)
    expect(small.h).toBe(752) // a small picture is enlarged to fit
  })
})

describe('zooming', () => {
  const shown = { w: 1000, h: 500 }

  it('keeps the point under the mouse where it is', () => {
    const view = zoomAt(HOME, 2, { x: 200, y: 0 }, stage, shown)
    expect(view.z).toBe(2)
    // The picture point that was under x=200 (at the start: 200 from the middle) is still there:
    expect((200 - view.x) / view.z).toBeCloseTo(200, 5)
  })

  it('does not go below the fit nor above the maximum', () => {
    expect(zoomAt(HOME, 0.1, { x: 0, y: 0 }, stage, shown).z).toBe(1)
    expect(zoomAt(HOME, 100, { x: 0, y: 0 }, stage, shown).z).toBe(MAX_ZOOM)
  })

  it('returns to the middle when it is made small again', () => {
    const big = zoomAt(HOME, 3, { x: 400, y: 100 }, stage, shown)
    expect(big.x).not.toBe(0)
    const back = zoomAt(big, 1 / 3, { x: 400, y: 100 }, stage, shown)
    expect(back).toEqual(HOME)
  })
})

describe('moving', () => {
  const shown = { w: 1000, h: 500 }

  it('is not possible while the picture is not bigger than the window', () => {
    expect(clampView({ z: 1, x: 300, y: 300 }, stage, shown)).toEqual(HOME)
    // wider than the window, but not taller: only sideways
    const wide = clampView({ z: 1.5, x: 900, y: 900 }, stage, shown)
    expect(wide.x).toBe(250) // (1500 - 1000) / 2
    expect(wide.y).toBe(0) // 750 < 800
  })

  it('stops at the edge of the picture', () => {
    expect(clampView({ z: 4, x: -9999, y: 9999 }, stage, shown)).toEqual({ z: 4, x: -1500, y: 600 })
  })
})
