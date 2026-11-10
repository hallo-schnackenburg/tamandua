// Which picture the detail view shows for a file. The list shows the small preview; the detail view wants
// a bigger one, which is looked for in this order:
//   1. the picture made in the browser, as long as it is not in the bucket yet (`web`)
//   2. the picture for the detail view in the bucket (the variant "web"), for what is bigger than 2000 pixels
//   3. the original itself, if it is a picture the browser shows (JPEG, PNG): for what is not bigger than that
// If there is none of them, only the preview is shown.

interface Variant {
  kind?: unknown
  path?: unknown
}

/** What is needed of a file of the list. */
export interface Viewable {
  name: string
  entry: { path?: unknown; mime?: unknown; variants?: unknown; width?: unknown; height?: unknown }
  preview?: Blob
  web?: Blob
}

export interface Source {
  /** The picture that is shown at once (the preview), and then replaced. */
  preview?: Blob
  /** The bigger one: a local picture or an address in the bucket. */
  large?: Blob | string
  /** The original in the bucket, to open in another tab (only for what the browser can show). */
  original?: string
  /** The size of the original in pixels, if known: the frame has this shape. */
  width?: number
  height?: number
}

const SHOWN = new Set(['image/jpeg', 'image/png'])
const OPENED = new Set(['image/jpeg', 'image/png', 'application/pdf'])

/** The address of a file in the bucket; the paths consist of safe characters only. */
export const addressOf = (base: string, path: string): string => `${base.replace(/\/$/, '')}/${path}`

export function sourceOf(file: Viewable, base?: string): Source {
  const { entry } = file
  const mime = typeof entry.mime === 'string' ? entry.mime : ''
  const path = typeof entry.path === 'string' ? entry.path : undefined
  const web = (Array.isArray(entry.variants) ? (entry.variants as Variant[]) : []).find((v) => v.kind === 'web')

  let large: Source['large']
  if (file.web) large = file.web
  else if (base && typeof web?.path === 'string') large = addressOf(base, web.path)
  else if (base && path && SHOWN.has(mime)) large = addressOf(base, path)

  return {
    preview: file.preview,
    large,
    original: base && path && OPENED.has(mime) ? addressOf(base, path) : undefined,
    width: typeof entry.width === 'number' ? entry.width : undefined,
    height: typeof entry.height === 'number' ? entry.height : undefined,
  }
}

/** Whether there is anything to show for the file. */
export const viewable = (file: Viewable): boolean => !!file.preview || !!file.web
