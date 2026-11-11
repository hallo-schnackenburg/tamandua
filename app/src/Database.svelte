<script lang="ts">
  import type { ArchiveDb, Entry } from './database.svelte.js'
  import Lightbox from './Lightbox.svelte'
  import { bucketPreview } from './viewer.js'
  import { formatDate } from './dates.js'
  import { ENTITY_NAMES, EXTERNAL_NAMES, FIELD_NAMES, objectLabel } from './labels.js'

  // The database: the objects that are already in the archive. The list with its search is on the left,
  // the chosen object on the right, as plain text (reading only).
  let { archive, filesBase }: { archive: ArchiveDb; filesBase?: string } = $props()

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
    void archive.selectedId
    allMembers = false
  })

  /** The fields of an object as labelled lines; a list has one line per item. */
  function lines(entry: Entry): { label: string; values: Part[][] }[] {
    const get = (key: string): unknown => entry.data[key]
    const list = (key: string, one: (item: unknown) => string | Part[]) => {
      const value = get(key)
      return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(one).filter(Boolean)
    }
    const geo = get('geocode')
    const files = get('files')
    const count = Array.isArray(files) ? files.length : 0
    const all = archive.members.get(entry.id) ?? []
    const members = allMembers ? all : all.slice(0, MEMBERS_SHOWN)
    const rows: { label: string; values: (string | Part[])[] }[] = [
      { label: FIELD_NAMES.title, values: [entry.title] },
      { label: 'Art', values: [objectLabel(entry.type, entry.subtype)] },
      { label: FIELD_NAMES.description, values: list('description', text) },
      { label: FIELD_NAMES.date, values: list('date', (value) => formatDate(text(value))) },
      { label: FIELD_NAMES.location, values: list('location', text) },
      { label: FIELD_NAMES.geocode, values: isData(geo) ? [`${text(geo.lat)}, ${text(geo.lon)}${geo.precision ? ` (${text(geo.precision)})` : ''}`] : [] },
      { label: FIELD_NAMES.origin, values: list('origin', entity) },
      { label: FIELD_NAMES.recipient, values: list('recipient', text) },
      { label: FIELD_NAMES.language, values: list('language', text) },
      { label: FIELD_NAMES.original, values: list('original', original) },
      { label: FIELD_NAMES.owner, values: list('owner', entity) },
      { label: FIELD_NAMES.subjects, values: list('subjects', entity) },
      { label: FIELD_NAMES.storage, values: [entry.external ? 'extern, nicht in unserem Speicher' : 'hier'] },
      { label: FIELD_NAMES.external, values: list('external', place) },
      { label: 'Dateien', values: count > 0 ? [`${count} ${count === 1 ? 'Datei' : 'Dateien'}`] : [] },
      { label: FIELD_NAMES.parents, values: entry.parents.map((id): Part[] => [{ text: archive.entries.find((e) => e.id === id)?.title || id, id: archive.entries.some((e) => e.id === id) ? id : undefined }]) },
      { label: FIELD_NAMES.members, values: members.map((e): Part[] => [{ text: e.title || 'Ohne Titel', id: e.id }]) },
      { label: FIELD_NAMES.notes, values: list('notes', text) },
      { label: 'Problem', values: archive.problems.get(entry.id) ?? [] },
      { label: 'ID', values: [entry.id] },
    ]
    return rows.map((row) => ({ label: row.label, values: row.values.map(toParts).filter((parts) => parts.length > 0) })).filter((row) => row.values.length > 0)
  }

  const megabytes = (bytes: number) => (bytes / 1e6).toLocaleString('de', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  // The files of the chosen object, as small pictures above its fields; a click opens the detail view.
  interface Tile {
    name: string
    sha256: string
    entry: Record<string, unknown>
    preview?: string
  }
  const SHOWN_AT_FIRST = 24
  const tiles = $derived.by((): Tile[] => {
    const list = selected?.data.files
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
    void archive.selectedId
    allTiles = false
  })

  const selected = $derived(archive.selected)
  const shown = $derived(archive.shown)

  // The list is long (tens of thousands of objects are possible), so only the rows that can be seen are in the page, plus a few
  // more above and below: the rows have a fixed height, so the position of every row is known without drawing the others.
  const PITCH = 56 // the height of a row (52) and the gap below it (4)
  const SPARE = 6
  let scroller = $state<HTMLElement>()
  let top = $state(0)
  let viewport = $state(400)
  const first = $derived(Math.max(0, Math.floor(top / PITCH) - SPARE))
  const last = $derived(Math.min(shown.length, Math.ceil((top + viewport) / PITCH) + SPARE))
  const visible = $derived(shown.slice(first, last))
  // A new search starts at the top.
  $effect(() => {
    void archive.query
    if (scroller) scroller.scrollTop = 0
  })
</script>

{#snippet progress()}
  {#if archive.progress}
    {@const p = archive.progress}
    <div class="progress" role="progressbar" aria-label="Fortschritt" aria-valuemin="0" aria-valuemax={p.total} aria-valuenow={p.done}>
      <div class="bar"><i style:width="{(p.done / p.total) * 100}%"></i></div>
      {#if p.phase === 'downloading'}
        <span>Wird heruntergeladen · {megabytes(p.done)} von {megabytes(p.total)} MB</span>
      {:else}
        <span>Objekte laden · {p.done.toLocaleString('de')} von {p.total.toLocaleString('de')}</span>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="database">
  <section class="pane list-pane">
    <h2>
      Objekte
      <span class="count">{archive.state === 'ready' && !archive.progress ? (archive.query ? `${shown.length} von ${archive.entries.length}` : archive.entries.length) : ''}</span>
      {#if archive.syncing && archive.state === 'ready' && !archive.progress}<span class="spinner" role="status" aria-label="Wird aktualisiert" title="Wird aktualisiert"></span>{/if}
      {#if archive.liveState === 'live'}
        <span class="badge live" title="Änderungen am Online-Archiv erscheinen hier sofort.">Live</span>
      {:else if archive.liveState === 'connecting'}
        <span class="badge connecting" title="Die Verbindung zum Online-Archiv wird aufgebaut.">Verbindet<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>
      {:else if archive.liveState === 'lost'}
        <span class="badge lost" title="Keine Verbindung zum Online-Archiv. Es wird jede Minute geprüft.">Nicht live</span>
        <button class="refresh" disabled={archive.syncing} onclick={() => archive.refresh(true)}>Aktualisieren</button>
      {/if}
    </h2>
    {@render progress()}
    <input class="search" type="search" placeholder="Titel suchen" bind:value={archive.query} aria-label="Titel suchen" />
    {#if archive.stale && archive.state === 'ready'}
      <p class="problem small">Keine Verbindung zum Online-Archiv. Du siehst den zuletzt geladenen Stand.</p>
    {/if}
    {#if archive.state === 'failed'}
      <p class="problem">Die Datenbank konnte nicht gelesen werden: {archive.error}</p>
    {:else if archive.state !== 'ready'}
      {#if !archive.progress}<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Wird geladen …</p>{/if}
    {:else if archive.entries.length === 0}
      <p class="quiet">Im Archiv ist noch kein Objekt.</p>
    {:else if shown.length === 0}
      <p class="quiet">Nichts gefunden.</p>
    {:else}
      <div class="scroller" bind:this={scroller} bind:clientHeight={viewport} onscroll={(event) => (top = event.currentTarget.scrollTop)}>
      <ul class="list" style:height="{shown.length * PITCH}px" style:padding-top="{first * PITCH}px">
        {#each visible as entry (entry.id)}
          <li>
            <button class="row" class:current={entry.id === archive.selectedId} onclick={() => (archive.selectedId = entry.id)}>
              <span class="title" class:empty={!entry.title}>{entry.title || 'Ohne Titel'}</span>
              <span class="sub">{[objectLabel(entry.type, entry.subtype), entry.date && formatDate(entry.date), entry.external && `extern${entry.place ? `: ${entry.place}` : ''}`].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        {/each}
      </ul>
      </div>
    {/if}
  </section>

  <section class="pane detail">
    {#if selected}
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
        {#each lines(selected) as row (row.label)}
          <dt>{row.label}</dt>
          <dd>
            {#each row.values as parts, i (i)}
              <div>{#each parts as part}{#if part.href}<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>{:else if part.id}<button class="goto" onclick={() => (archive.selectedId = part.id)}>{part.text}</button>{:else}{part.text}{/if}{/each}</div>
            {/each}
            {#if row.label === FIELD_NAMES.members && !allMembers && (archive.members.get(selected.id)?.length ?? 0) > MEMBERS_SHOWN}
              <button class="more" onclick={() => (allMembers = true)}>+ {(archive.members.get(selected.id)?.length ?? 0) - MEMBERS_SHOWN} weitere</button>
            {/if}
          </dd>
        {/each}
      </dl>
    {:else}
      {#if archive.selectedId}
        <!-- The address names an object: it is looked for as long as the copy is still being read. -->
        <p class="quiet center">{archive.state === 'ready' && !archive.syncing && !archive.progress ? 'Dieses Objekt gibt es nicht (mehr).' : 'Wird geladen …'}</p>
      {:else}
        <p class="quiet center">Wähle links ein Objekt.</p>
      {/if}
    {/if}
  </section>
</div>

{#if looking !== undefined && tiles.length > 0}
  <Lightbox files={tiles.filter((t) => t.preview)} start={Math.max(0, tiles.filter((t) => t.preview).indexOf(tiles[looking]))} base={filesBase} onclose={() => (looking = undefined)} />
{/if}

<style>
  .database { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; min-height: 0; }
  .pane { display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: var(--r-m); padding: 12px; }
  h2 { display: flex; align-items: center; gap: 8px; height: 1.6rem; margin: 0 0 8px; font-size: 1rem; }
  .count { font-size: 0.75rem; font-weight: 400; color: #888; }
  .search { font: inherit; font-size: 0.9rem; height: 2rem; box-sizing: border-box; padding: 0 12px; margin-bottom: 8px; border: 1px solid #ddd; border-radius: 999px; }
  .search:focus { outline: none; border-color: #36c; }
  .progress { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; font-size: 0.75rem; color: #777; }
  .bar { height: 6px; border-radius: 999px; background: #e6ebf7; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 999px; background: #36c; transition: width 0.15s linear; }
  .scroller { flex: 1; min-height: 0; overflow: auto; }
  .list { box-sizing: border-box; margin: 0; padding: 0; list-style: none; }
  .list li { height: 52px; margin-bottom: 4px; }
  .row { display: flex; flex-direction: column; justify-content: center; gap: 3px; width: 100%; height: 100%; box-sizing: border-box; padding: 0 12px; text-align: left; font: inherit; background: #fff; border: 1px solid #ddd; border-radius: var(--r-m); cursor: pointer; }
  .row:hover { border-color: #b9c8ee; }
  .row.current { border-color: #36c; background: #eef3ff; }
  .title { font-size: 0.85rem; line-height: 1.3; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.empty { font-weight: 400; color: #999; }
  .sub { font-size: 0.75rem; line-height: 1.3; color: #777; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spinner { flex: none; width: 12px; height: 12px; border: 1.5px solid #b9c8ee; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* The same quiet labels as in the header: a dot and a word. */
  .badge { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 1.4rem; box-sizing: border-box; padding: 0 10px; border-radius: 999px; background: #f0f0ee; color: #666; font-size: 0.72rem; font-weight: 400; white-space: nowrap; }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #999; }
  .badge.live { background: #e9f5ec; color: #2a7a3b; }
  .badge.live::before { background: #3aa655; }
  .badge.lost { background: #fdebd7; color: #a85408; }
  .badge.lost::before { background: #e07b1a; }
  /* Three dots that rise and fall one after the other. */
  .badge.connecting::before { display: none; }
  .dots { display: inline-flex; gap: 2px; margin-left: 1px; }
  .dots i { width: 3px; height: 3px; border-radius: 50%; background: #888; animation: bubble 1.1s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: 0.15s; }
  .dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bubble { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-3px); opacity: 1; } }
  .refresh { font: inherit; font-size: 0.72rem; height: 1.4rem; padding: 0 10px; border: 1px solid #b9c8ee; border-radius: 999px; background: #fff; color: #36c; cursor: pointer; }
  .refresh:hover:not(:disabled) { background: #eef2fb; }
  .refresh:disabled { opacity: 0.4; cursor: default; }
  .loading { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 24px 0; color: #888; font-size: 0.9rem; }
  .quiet { margin: 0; color: #aaa; font-size: 0.9rem; }
  .quiet.center { margin: auto; }
  .problem { margin: 0; color: #a11; font-size: 0.9rem; }
  .problem.small { margin-bottom: 8px; font-size: 0.78rem; }
  .detail { overflow: auto; }
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
