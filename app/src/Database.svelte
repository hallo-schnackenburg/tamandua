<script lang="ts">
  import type { ArchiveDb, Entry } from './database.svelte.js'
  import ObjectDetail from './ObjectDetail.svelte'
  import { formatDate } from './dates.js'
  import { ancestors, rowsOf } from './group-tree.js'
  import { NO_GROUP } from './route.js'
  import { untrack } from 'svelte'
  import Splitter from './Splitter.svelte'
  import { GAP, Sizes } from './layout.svelte.js'
  import { objectLabel } from './labels.js'

  // The database: the objects that are already in the archive. The list with its search is on the left,
  // the chosen object on the right, as plain text (reading only).
  let { archive, filesBase }: { archive: ArchiveDb; filesBase?: string } = $props()

  const megabytes = (bytes: number) => (bytes / 1e6).toLocaleString('de', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  const selected = $derived(archive.selected)
  const shown = $derived(archive.shown)

  // --- the groups: a tree on the left, which can be closed (this is remembered in this browser) ---
  const GROUPS_OPEN = 'tamandua.groups'
  let treeOpen = $state(
    (() => {
      try {
        return localStorage.getItem(GROUPS_OPEN) !== 'closed'
      } catch {
        return true
      }
    })(),
  )
  function toggleTree() {
    treeOpen = !treeOpen
    try {
      localStorage.setItem(GROUPS_OPEN, treeOpen ? 'open' : 'closed')
    } catch {
      // not remembered, that is all
    }
  }
  // The widths of the panes (kept in this browser); with the groups folded away, the first pane is a narrow strip.
  const sizes = new Sizes('database', [100 / 3, 100 / 3, 100 / 3])
  const template = $derived(treeOpen ? sizes.template : `2.4rem ${GAP}px minmax(0, ${sizes.parts[1]}fr) ${GAP}px minmax(0, ${sizes.parts[2]}fr)`)
  /** Ids of the groups that are open in the tree. */
  let expanded = $state(new Set<string>())
  function toggle(id: string) {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }
  let groupQuery = $state('')
  const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const rows = $derived(rowsOf(archive.tree, expanded))
  /** With words in the search field the groups that match are listed one below the other (the tree would hide most of them). */
  const found = $derived.by(() => {
    const words = fold(groupQuery).split(/\s+/).filter(Boolean)
    return words.length === 0 ? undefined : archive.entries.filter((e) => e.type === 'group' && words.every((w) => e.folded.includes(w)))
  })
  // A group that is chosen (here, by a link, or by the address) is made visible: the groups above it are opened.
  $effect(() => {
    const id = archive.groupId
    void archive.byId
    if (!id || id === NO_GROUP) return
    const above = ancestors(archive.byId, id)
    untrack(() => {
      if ([...above].some((a) => !expanded.has(a))) expanded = new Set([...expanded, ...above])
    })
  })
  const countOf = (id: string): number => archive.tree.members.get(id)?.size ?? 0
  const scopeGroup = $derived(archive.groupId && archive.groupId !== NO_GROUP ? archive.byId.get(archive.groupId) : undefined)

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

{#snippet groupRow(group: Entry, depth: number, branch: boolean, open: boolean)}
  <div class="node" class:current={group.id === archive.groupId} style:padding-left="{depth * 14}px">
    {#if branch}
      <button class="twisty" aria-label="{group.title || 'Ohne Titel'} {open ? 'zuklappen' : 'aufklappen'}" aria-expanded={open} onclick={() => toggle(group.id)}>{open ? '▾' : '▸'}</button>
    {:else}
      <span class="twisty"></span>
    {/if}
    <button class="name" title={group.title} onclick={() => { archive.open(group.id); if (branch && !open) toggle(group.id) }}>
      <span class="label" class:empty={!group.title}>{group.title || 'Ohne Titel'}</span>
      <span class="n">{countOf(group.id).toLocaleString('de')}</span>
    </button>
  </div>
{/snippet}

<div class="database" class:collapsed={!treeOpen} style:grid-template-columns={template}>
  <section class="pane groups">
    {#if treeOpen}
      <h2>
        Gruppen
        <button class="fold" title="Gruppen ausblenden" aria-label="Gruppen ausblenden" onclick={toggleTree}>‹</button>
      </h2>
      {#if archive.state === 'ready'}
        <input class="search" type="search" placeholder="Gruppe suchen" bind:value={groupQuery} aria-label="Gruppe suchen" />
        <div class="tree">
          {#if !found}
            <div class="node" class:current={!archive.groupId}>
              <span class="twisty"></span>
              <button class="name" onclick={() => (archive.groupId = undefined)}><span class="label">Alle Objekte</span><span class="n">{archive.tree.objects.toLocaleString('de')}</span></button>
            </div>
            <div class="node" class:current={archive.groupId === NO_GROUP}>
              <span class="twisty"></span>
              <button class="name" onclick={() => (archive.groupId = NO_GROUP)}><span class="label">Ohne Gruppe</span><span class="n">{archive.tree.ungrouped.toLocaleString('de')}</span></button>
            </div>
            {#each rows as row (row.key)}{@render groupRow(row.group, row.depth, row.branch, row.open)}{/each}
          {:else if found.length === 0}
            <p class="quiet">Keine Gruppe gefunden.</p>
          {:else}
            {#each found as group (group.id)}{@render groupRow(group, 0, false, false)}{/each}
          {/if}
        </div>
      {/if}
    {:else}
      <button class="fold open" title="Gruppen einblenden" aria-label="Gruppen einblenden" onclick={toggleTree}>›<span>Gruppen</span></button>
    {/if}
  </section>

  {#if treeOpen}<Splitter {sizes} index={0} />{/if}

  <section class="pane list-pane">
    <h2>
      Objekte
      <span class="count">{archive.state === 'ready' && !archive.progress ? (archive.query || archive.groupId ? `${shown.length.toLocaleString('de')} von ${archive.tree.objects.toLocaleString('de')}` : archive.tree.objects.toLocaleString('de')) : ''}</span>
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
    {#if archive.groupId && archive.state === 'ready'}
      <div class="scope">
        {#if archive.groupId === NO_GROUP}
          <span class="what">Objekte ohne Gruppe</span>
        {:else if scopeGroup}
          <span class="what" title={scopeGroup.title}>{scopeGroup.title || 'Ohne Titel'}</span>
          <button class="refresh" disabled={archive.selectedId === scopeGroup.id} onclick={() => (archive.selectedId = scopeGroup.id)}>Details</button>
        {:else if !archive.syncing && !archive.progress}
          <span class="what">Diese Gruppe gibt es nicht (mehr).</span>
        {/if}
        <button class="clear" title="Alle Objekte zeigen" aria-label="Alle Objekte zeigen" onclick={() => (archive.groupId = undefined)}>×</button>
      </div>
    {/if}
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
      <p class="quiet">{archive.query ? 'Nichts gefunden.' : archive.groupId ? 'Hier sind keine Objekte.' : 'Im Archiv ist noch kein Objekt.'}</p>
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

  <Splitter {sizes} index={1} fixed={treeOpen ? 0 : 38} shares={treeOpen ? 100 : sizes.parts[1] + sizes.parts[2]} />

  <section class="pane detail">
    {#if selected}
      <ObjectDetail entry={selected} lookup={(id) => archive.byId.get(id)} membersOf={(id) => archive.members.get(id) ?? []} problems={archive.problems.get(selected.id)} {filesBase} onopen={(id) => archive.open(id)} />
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



<style>
  /* The handles sit in the tracks between the panes (see Splitter.svelte). */
  .database { flex: 1; display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
  .database > :global(.groups) { grid-column: 1; }
  .database > :global(.list-pane) { grid-column: 3; }
  .database > :global(.detail) { grid-column: 5; }
  .groups { padding: 12px 8px 12px 12px; }
  .collapsed .groups { padding: 8px 0; align-items: center; }
  .fold { all: unset; margin-left: auto; width: 1.4rem; height: 1.4rem; text-align: center; line-height: 1.3rem; border-radius: 999px; color: #666; cursor: pointer; font-size: 1.1rem; }
  .fold:hover { background: #eef2fb; color: #36c; }
  .fold:focus-visible { outline: 2px solid #36c; }
  .fold.open { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; width: auto; height: auto; padding: 4px 0; }
  .fold.open span { writing-mode: vertical-rl; font-size: 0.78rem; }
  .groups .search { margin-right: 4px; }
  .tree { flex: 1; min-height: 0; overflow: auto; padding-right: 4px; }
  .node { display: flex; align-items: center; gap: 2px; border-radius: var(--r-m); }
  .node.current { background: #eef3ff; }
  .twisty { all: unset; flex: none; width: 1.2rem; text-align: center; color: #888; font-size: 0.8rem; cursor: pointer; }
  span.twisty { cursor: default; }
  button.twisty:hover { color: #36c; }
  button.twisty:focus-visible { outline: 2px solid #36c; border-radius: 2px; }
  .node .name { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; padding: 5px 4px; font-size: 0.85rem; line-height: 1.3; cursor: pointer; }
  .node.current .name { color: #24b; font-weight: 500; }
  .node .name:hover .label { text-decoration: underline; }
  .node .name:focus-visible { outline: 2px solid #36c; border-radius: 4px; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.empty { color: #999; }
  .n { flex: none; font-size: 0.72rem; color: #999; }
  .scope { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; padding: 4px 4px 4px 12px; border-radius: 999px; background: #eef3ff; font-size: 0.8rem; }
  .scope .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #24b; }
  .clear { all: unset; flex: none; width: 1.4rem; height: 1.4rem; text-align: center; line-height: 1.3rem; border-radius: 50%; color: #666; cursor: pointer; }
  .clear:hover { background: #fff; color: #36c; }
  .clear:focus-visible { outline: 2px solid #36c; }
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
</style>
