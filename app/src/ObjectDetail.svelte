<script lang="ts">
  import type { Entry } from './database.svelte.js'
  import Lightbox from './Lightbox.svelte'
  import { bucketPreview } from './viewer.js'
  import { formatDate } from './dates.js'
  import { ENTITY_NAMES, EXTERNAL_NAMES, FIELD_NAMES, objectLabel } from './labels.js'

  // One object as plain text (reading only): its files as small pictures, then its fields as labelled lines.
  // Used by the database and by the review.
  let {
    entry,
    lookup,
    membersOf,
    problems = [],
    filesBase,
    onopen,
  }: {
    entry: Entry
    /** Another object by its id (an object of the archive, or of the session that is looked at). */
    lookup: (id: string) => Entry | undefined
    /** The objects that name the group as a parent. */
    membersOf: (id: string) => Entry[]
    /** What is wrong with the object, in words. */
    problems?: string[]
    filesBase?: string
    /** A link to another object was clicked. */
    onopen: (id: string) => void
  } = $props()

  type Data = Record<string, unknown>
  const isData = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value)
  const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

  /** A person, place, business ...: "Karl Lemke (Person), Schnackenburg, Fotograf". */
  function entity(value: unknown): string {
    if (!isData(value)) return text(value)
    const kind = text(value.type)
    const head = `${text(value.name)}${kind ? ` (${ENTITY_NAMES[kind] ?? kind})` : ''}`
    return [head, text(value.location), text(value.note)].filter(Boolean).join(', ')
  }

  /** A piece of a line: plain text, or text that is a link. */
  interface Part {
    text: string
    href?: string
    /** Another object of the archive: the text is a button that shows it. */
    id?: string
  }
  const toParts = (value: string | Part[]): Part[] => (typeof value === 'string' ? (value ? [{ text: value }] : []) : value)

  /** The address as a link, if it is a web address (only http and https: nothing that could run something). */
  function linkOf(uri: string): string | undefined {
    try {
      const url = new URL(uri)
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
    } catch {
      return undefined
    }
  }

  /** A place outside our storage: "Stadtarchiv Salzwedel (Plattform), Signatur, https://…, Notiz"; the address is a link. */
  function place(value: unknown): Part[] {
    if (!isData(value)) return toParts(text(value))
    const kind = text(value.type)
    const uri = text(value.uri)
    const pieces: Part[] = [
      { text: [text(value.site), kind && `(${EXTERNAL_NAMES[kind] ?? kind})`].filter(Boolean).join(' ') },
      { text: text(value.reference) },
      { text: uri, href: uri ? linkOf(uri) : undefined },
      { text: text(value.note) },
      { text: value.retrieved ? `gesehen am ${text(value.retrieved)}` : '' },
    ].filter((piece) => piece.text)
    return pieces.flatMap((piece, i) => (i === 0 ? [piece] : [{ text: ', ' }, piece]))
  }

  /** Where the original is: "Stadtarchiv Schnackenburg (Betrieb), Signatur Fotos/Album 3, https://…, Regal 4"; the address is a link. */
  function original(value: unknown): Part[] {
    if (!isData(value)) return toParts(text(value))
    const uri = text(value.uri)
    const pieces: Part[] = [
      { text: entity(value.holder) },
      { text: text(value.reference) && `${FIELD_NAMES.reference} ${text(value.reference)}` },
      { text: uri, href: uri ? linkOf(uri) : undefined },
      { text: text(value.note) },
    ].filter((piece) => piece.text)
    return pieces.flatMap((piece, i) => (i === 0 ? [piece] : [{ text: ', ' }, piece]))
  }

  const MEMBERS_SHOWN = 50
  let allMembers = $state(false)
  $effect(() => {
    void entry.id
    allMembers = false
  })

  /** The fields of an object as labelled lines; a list has one line per item. */
  function lines(entry: Entry): { label: string; field?: string; values: Part[][] }[] {
    const get = (key: string): unknown => entry.data[key]
    const list = (key: string, one: (item: unknown) => string | Part[]) => {
      const value = get(key)
      return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(one).filter(Boolean)
    }
    const geo = get('geocode')
    const files = get('files')
    const count = Array.isArray(files) ? files.length : 0
    const all = membersOf(entry.id)
    const members = allMembers ? all : all.slice(0, MEMBERS_SHOWN)
    const rows: { label: string; field?: string; values: (string | Part[])[] }[] = [
      { label: FIELD_NAMES.title, field: 'title', values: [entry.title] },
      { label: 'Art', field: 'subtype', values: [objectLabel(entry.type, entry.subtype)] },
      { label: FIELD_NAMES.description, field: 'description', values: list('description', text) },
      { label: FIELD_NAMES.date, field: 'date', values: list('date', (value) => formatDate(text(value))) },
      { label: FIELD_NAMES.location, field: 'location', values: list('location', text) },
      { label: FIELD_NAMES.geocode, field: 'geocode', values: isData(geo) ? [`${text(geo.lat)}, ${text(geo.lon)}${geo.precision ? ` (${text(geo.precision)})` : ''}`] : [] },
      { label: FIELD_NAMES.origin, field: 'origin', values: list('origin', entity) },
      { label: FIELD_NAMES.recipient, field: 'recipient', values: list('recipient', text) },
      { label: FIELD_NAMES.language, field: 'language', values: list('language', text) },
      { label: FIELD_NAMES.original, field: 'original', values: list('original', original) },
      { label: FIELD_NAMES.owner, field: 'owner', values: list('owner', entity) },
      { label: FIELD_NAMES.subjects, field: 'subjects', values: list('subjects', entity) },
      { label: FIELD_NAMES.storage, field: 'storage', values: [entry.external ? 'extern, nicht in unserem Speicher' : 'hier'] },
      { label: FIELD_NAMES.external, field: 'external', values: list('external', place) },
      { label: 'Dateien', field: 'files', values: count > 0 ? [`${count} ${count === 1 ? 'Datei' : 'Dateien'}`] : [] },
      { label: FIELD_NAMES.parents, field: 'parents', values: entry.parents.map((id): Part[] => [{ text: lookup(id)?.title || id, id: lookup(id) ? id : undefined }]) },
      { label: FIELD_NAMES.members, values: members.map((e): Part[] => [{ text: e.title || 'Ohne Titel', id: e.id }]) },
      { label: FIELD_NAMES.notes, field: 'notes', values: list('notes', text) },
      { label: 'Problem', values: problems },
      { label: 'ID', values: [entry.id] },
    ]
    return rows.map((row) => ({ label: row.label, field: row.field, values: row.values.map(toParts).filter((parts) => parts.length > 0) })).filter((row) => row.values.length > 0)
  }

  // The files of the chosen object, as small pictures above its fields; a click opens the detail view.
  interface Tile {
    name: string
    sha256: string
    entry: Record<string, unknown>
    preview?: string
  }
  const SHOWN_AT_FIRST = 24
  const tiles = $derived.by((): Tile[] => {
    const list = entry.data.files
    if (!Array.isArray(list)) return []
    return list.filter(isData).map((entry, i) => ({
      name: text(entry.original_name) || `Datei ${i + 1}`,
      sha256: text(entry.sha256) || String(i),
      entry,
      preview: filesBase ? bucketPreview(entry, filesBase) : undefined,
    }))
  })
  let allTiles = $state(false)
  let broken = $state(new Set<string>()) // pictures that could not be loaded: they show the file type instead
  const shownTiles = $derived(allTiles ? tiles : tiles.slice(0, SHOWN_AT_FIRST))
  const extension = (name: string) => (name.split('.').pop() ?? '').toLowerCase()
  let looking = $state<number>()
  // Another object starts with its first files again.
  $effect(() => {
    void entry.id
    allTiles = false
  })
</script>

  {#if tiles.length > 0}
    <div class="files">
      {#each shownTiles as tile, i (tile.sha256)}
        <button class="tile" disabled={!tile.preview} title={tile.name} aria-label="{tile.name} vergrößern" onclick={() => (looking = i)}>
          {#if tile.preview && !broken.has(tile.sha256)}
            <img src={tile.preview} alt="" loading="lazy" draggable="false" onerror={() => (broken = new Set(broken).add(tile.sha256))} />
          {:else}
            <span class="noimg">{extension(tile.name)}</span>
          {/if}
        </button>
      {/each}
      {#if !allTiles && tiles.length > SHOWN_AT_FIRST}
        <button class="more" onclick={() => (allTiles = true)}>+ {tiles.length - SHOWN_AT_FIRST} weitere</button>
      {/if}
    </div>
  {/if}
  <dl>
    {#each lines(entry) as row (row.label)}
      <dt>
        {row.label}
      </dt>
      <dd>
        {#each row.values as parts, i (i)}
          <div>{#each parts as part}{#if part.href}<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>{:else if part.id}<button class="goto" onclick={() => onopen(part.id!)}>{part.text}</button>{:else}{part.text}{/if}{/each}</div>
        {/each}
        {#if row.label === FIELD_NAMES.members && !allMembers && (membersOf(entry.id).length) > MEMBERS_SHOWN}
          <button class="more" onclick={() => (allMembers = true)}>+ {(membersOf(entry.id).length) - MEMBERS_SHOWN} weitere</button>
        {/if}
      </dd>
    {/each}
  </dl>

{#if looking !== undefined && tiles.length > 0}
  <Lightbox files={tiles.filter((t) => t.preview)} start={Math.max(0, tiles.filter((t) => t.preview).indexOf(tiles[looking]))} base={filesBase} onclose={() => (looking = undefined)} />
{/if}

<style>
  .files { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 0 0 16px; }
  .tile { display: block; padding: 0; border: 0; border-radius: var(--r-m); overflow: hidden; background: #ececec; box-shadow: 0 0 0 1px #e3e3e3; cursor: zoom-in; }
  .tile:disabled { cursor: default; }
  .tile:hover:not(:disabled) { box-shadow: 0 0 0 2px #8fadea; }
  .tile img, .noimg { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
  .noimg { display: flex; align-items: center; justify-content: center; color: #888; text-transform: uppercase; font-weight: 600; font-size: 0.78rem; }
  .more { grid-column: 1 / -1; justify-self: start; font: inherit; font-size: 0.78rem; padding: 3px 12px; border: 1px solid #b9c8ee; border-radius: 999px; background: #fff; color: #36c; cursor: pointer; }
  dl { margin: 0; display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: 8px 16px; font-size: 0.9rem; line-height: 1.4; }
  dt { color: #888; }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd a { color: #36c; text-decoration: none; }
  .goto { all: unset; color: #36c; cursor: pointer; }
  .goto:hover { text-decoration: underline; }
  .goto:focus-visible { outline: 2px solid #36c; border-radius: 2px; }
  dd a:hover { text-decoration: underline; }
</style>
