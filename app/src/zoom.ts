// The arithmetic of the detail view: a picture that fits into the window, can be enlarged around a point
// (the point under the finger or the mouse stays where it is), and moved as long as it is bigger than the window.

export interface Size {
  w: number
  h: number
}

/** `z` is the enlargement (1: the picture fits into the window); `x`, `y` how far it was moved from the center. */
export interface View {
  z: number
  x: number
  y: number
}

export const MAX_ZOOM = 6
export const HOME: View = { z: 1, x: 0, y: 0 }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** The size at which a picture fits into the window (never larger than itself would need: a small picture is enlarged to fit too). */
export function fit(stage: Size, picture: Size, margin = 24): Size {
  const room = { w: Math.max(1, stage.w - 2 * margin), h: Math.max(1, stage.h - 2 * margin) }
  const scale = Math.min(room.w / picture.w, room.h / picture.h)
  return { w: picture.w * scale, h: picture.h * scale }
}

/** Keeps the enlargement in its range and the picture from being moved away: while it is smaller than the window it stays in the middle. */
export function clampView(view: View, stage: Size, shown: Size): View {
  const z = clamp(view.z, 1, MAX_ZOOM)
  const rangeX = Math.max(0, (shown.w * z - stage.w) / 2)
  const rangeY = Math.max(0, (shown.h * z - stage.h) / 2)
  return { z, x: clamp(view.x, -rangeX, rangeX), y: clamp(view.y, -rangeY, rangeY) }
}

/** Enlarges by `factor` around `point` (measured from the middle of the window). */
export function zoomAt(view: View, factor: number, point: { x: number; y: number }, stage: Size, shown: Size): View {
  const z = clamp(view.z * factor, 1, MAX_ZOOM)
  const k = z / view.z
  return clampView({ z, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k }, stage, shown)
}
