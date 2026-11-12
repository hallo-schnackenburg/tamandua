<script lang="ts">
  import { untrack } from 'svelte'
  import Chat from './Chat.svelte'
  import Files from './Files.svelte'
  import Objects from './Objects.svelte'
  import Splitter from './Splitter.svelte'
  import { Sizes } from './layout.svelte.js'
  import ObjectDetail from './ObjectDetail.svelte'
  import { formatDate } from './dates.js'
  import { FIELD_NAMES, objectLabel } from './labels.js'
  import { isWaiting, type Action, type Change, type Filter, type ReviewDb } from './review.svelte.js'
  import { defaultName, type Session, type Workspace } from './workspace.svelte.js'
  import type { Checks } from './backend.js'

  // The sessions of everybody in one place. Left: the sessions (the chosen one opens up with what can be done with it), under them the chat.
  // Middle: the objects of the chosen session. Right: its files and the talk about it (tabs). The sessions of this person are worked
  // on right here (objects, files, chat); the other ones are read and discussed, working on them follows.
  let { ws, review, filesBase, mode = $bindable('own') }: { ws: Workspace; review: ReviewDb; filesBase?: string; mode?: 'own' | 'other' } = $props()

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'waiting', label: 'Eingereicht' },
    { id: 'drafts', label: 'Entwürfe' },
    { id: 'done', label: 'Abgeschlossen' },
  ]
  // The widths of the three columns, and the heights of the sessions and the chat (kept in this browser).
  const columns = new Sizes('sessions.columns', [100 / 3, 100 / 3, 100 / 3])
  const heights = new Sizes('sessions.left', [200 / 3, 100 / 3])

  // --- the rows of the list: what GitHub knows, and the sessions of this browser that GitHub does not know yet ---
  interface Row {
    key: string
    name: string
    login?: string
    createdAt?: string
    state: 'draft' | 'submitted' | 'merged' | 'closed'
    checks?: Checks
    pull?: number
    session?: Session
  }
  const categoryOf = (state: Row['state']): Filter => (state === 'submitted' ? 'waiting' : state === 'draft' ? 'drafts' : 'done')
  const localRows = $derived(
    ws.sessions
      .filter((s) => s.pull === undefined || !review.list.some((e) => e.number === s.pull))
      .map((s): Row => ({ key: `s${s.id}`, name: s.name, state: s.state === 'merged' ? 'merged' : s.state === 'submitted' ? 'submitted' : 'draft', pull: s.pull, session: s })),
  )
  const remoteRows = $derived(
    review.shown.map((e): Row => ({
      key: `p${e.number}`,
      name: e.name,
      login: e.login,
      createdAt: e.createdAt,
      state: e.state === 'merged' ? 'merged' : e.closed ? 'closed' : e.state === 'submitted' ? 'submitted' : 'draft',
      checks: e.checks,
      pull: e.number,
      session: ws.sessions.find((s) => s.pull === e.number),
    })),
  )
  const rows = $derived([...localRows.filter((r) => categoryOf(r.state) === review.filter), ...remoteRows])
  const count = (id: Filter): number => (id === 'waiting' ? review.waiting.length : id === 'drafts' ? review.drafts.length : review.done.length) + localRows.filter((r) => categoryOf(r.state) === id).length
  const EMPTY: Record<Filter, string> = {
    waiting: 'Nichts eingereicht.',
    drafts: 'Keine Entwürfe.',
    done: 'Noch nichts abgeschlossen.',
  }
  const CHANGES: Record<Change, string> = { added: 'neu', modified: 'geändert', removed: 'gelöscht' }

  const dateOf = (iso: string): string => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const detail = $derived(review.detail)
  const pull = $derived(detail?.pull)
  const waiting = $derived(!!pull && pull.state === 'open' && !pull.draft)

  // What the person is about to do: nothing yet, or one of the actions, which wants a second click.
  let asking = $state<Action>()
  // Another session starts without a question.
  $effect(() => {
    void review.selectedPull
    asking = undefined
  })

  // --- the choice ---
  /** Whether the chosen session is open in the list (with what can be done with it); a second click on it closes it. */
  let unfolded = $state(true)
  const isCurrent = (row: Row): boolean => (row.session ? mode === 'own' && ws.currentId === row.session.id : mode === 'other' && review.selectedPull === row.pull)

  function choose(row: Row) {
    if (isCurrent(row)) {
      unfolded = !unfolded
      return
    }
    unfolded = true
    if (row.session) {
      ws.selectSession(row.session.id)
      mode = 'own'
    } else mode = 'other'
    void review.select(row.pull)
  }

  /** Another part of the list: nothing of it is chosen yet, so the columns next to it are empty. */
  function showPart(part: Filter) {
    if (review.filter === part) return
    review.filter = part
    mode = 'other'
    void review.select(undefined)
  }

  // What the chat does belongs to the session of this person: when it adds something while none is chosen, that session is shown again.
  $effect(() => {
    void ws.shown.length
    void ws.currentId
    untrack(() => {
      if (mode === 'other' && review.selectedPull === undefined) mode = 'own'
    })
  })

  // The talk and the objects of the review follow the session that is worked on (also when it is changed elsewhere, or when its pull request appears).
  $effect(() => {
    if (mode !== 'own') return
    const wanted = ws.current?.pull
    untrack(() => {
      if (wanted !== review.selectedPull) void review.select(wanted)
    })
  })

  // The list shows the part the session that is worked on is in, so that it is always to be seen.
  $effect(() => {
    const session = mode === 'own' ? ws.current : undefined
    if (!session) return
    const category = categoryOf(session.state === 'merged' ? 'merged' : session.state === 'submitted' ? 'submitted' : 'draft')
    untrack(() => {
      if (review.filter !== category) review.filter = category
    })
  })

  const own = $derived(mode === 'own' ? ws.current : undefined)
  /** The objects of the own session are worked on in place; other sessions (and the ones taken over) are read. */
  const working = $derived(mode === 'own' && ws.current?.state !== 'merged')

  // --- a new session, a new name, handing in ---
  let creating = $state(false)
  let newName = $state('')
  let renaming = $state(false)
  let renameTo = $state('')
  let submitting = $state(false)
  function create() {
    const session = ws.createSession(newName.trim() || defaultName())
    creating = false
    newName = ''
    unfolded = true
    mode = 'own'
    void review.select(session.pull)
  }
  function rename() {
    if (own && renameTo.trim()) ws.renameSession(own.id, renameTo)
    renaming = false
  }
  function select(node: HTMLInputElement) {
    node.focus()
    node.select()
  }

  // --- the right column ---
  let tab = $state<'files' | 'comments'>('files')
  $effect(() => {
    if (mode === 'other') tab = 'comments'
  })
  /** Files carried over the comments: the files are shown, so that they can be dropped there. */
  function fileOver(event: DragEvent) {
    if (tab === 'comments' && mode === 'own' && event.dataTransfer?.types.includes('Files')) tab = 'files'
  }
  function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    ws.addDropped(input.files ?? [])
    input.value = '' // so that the same file can be picked again
  }

  async function go(action: Action) {
    if (await review.act(action)) asking = undefined
  }

  const timeOf = (iso: string): string => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  const titleOf = (id: string): string => review.items.find((i) => i.entry.id === id)?.entry.title || review.lookup(id)?.title || 'Objekt'

  // --- the comments ---
  const shownComments = $derived(review.comments)
  let text = $state('')
  let sending = $state(false)
  // Another session: a new start.
  $effect(() => {
    void review.selectedPull
    text = ''
    editing = undefined
    removing = undefined
  })

  async function send() {
    const clean = text.trim()
    if (!clean || sending) return
    sending = true
    try {
      if (await review.comment(clean)) text = ''
    } finally {
      sending = false
    }
  }

  let editing = $state<number>()
  let editText = $state('')
  let removing = $state<number>() // the comment whose removal waits for a second click
  /** Puts the cursor at the end of the text as soon as the field appears. */
  function focus(node: HTMLTextAreaElement) {
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }

  async function saveEdit(id: number) {
    if (editText.trim() && (await review.editComment(id, editText.trim()))) editing = undefined
  }
  async function remove(id: number) {
    if (removing !== id) {
      removing = id
      return
    }
    await review.deleteComment(id)
    removing = undefined
  }
  function toggle(id: string) {
    review.selectedId = review.selectedId === id ? undefined : id
  }
</script>
<div class="review" style:grid-template-columns={columns.template}>
  <div class="left" style:grid-template-rows={heights.template}>
  <section class="pane upper">
    <h2>
      Erfassungen
      <button class="add" title="Neue Erfassung" aria-label="Neue Erfassung" onclick={() => ((creating = true), (newName = ''))}>+</button>
      {#if review.state === 'ready'}<button class="refresh" title="Neu laden" aria-label="Neu laden" onclick={() => review.refresh()}>↻</button>{/if}
    </h2>
    {#if creating}
      <span class="field">
        <input
          class="name"
          use:select
          bind:value={newName}
          placeholder={defaultName()}
          aria-label="Name der neuen Erfassung"
          maxlength="100"
          onkeydown={(e) => (e.key === 'Enter' ? create() : e.key === 'Escape' && (creating = false))}
          onblur={() => (creating = false)}
        />
        <button class="enter" type="button" title="Mit Return bestätigen" aria-label="Bestätigen" onmousedown={(e) => e.preventDefault()} onclick={create}>↵</button>
      </span>
    {/if}
    <div class="filters" role="tablist" aria-label="Erfassungen">
      {#each FILTERS as f (f.id)}
        <button role="tab" class:active={review.filter === f.id} aria-selected={review.filter === f.id} onclick={() => showPart(f.id)}>
          {f.label}{#if count(f.id) > 0}<span class="n">{count(f.id)}</span>{/if}
        </button>
      {/each}
    </div>
    {#if review.state === 'failed' && rows.length === 0}
      <p class="problem">Die Erfassungen konnten nicht gelesen werden: {review.error}</p>
    {:else if review.state !== 'ready' && rows.length === 0}
      <p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Wird geladen …</p>
    {:else if rows.length === 0}
      <p class="quiet">{EMPTY[review.filter]}</p>
    {:else}
      <ul class="list">
        {#each rows as row (row.key)}
          {@const current = isCurrent(row)}
          <li>
            <button class="row" class:current aria-expanded={current && unfolded} onclick={() => choose(row)}>
              <span class="title">{row.name}</span>
              <span class="meta">
                <span class="sub">{[row.login, row.createdAt && dateOf(row.createdAt)].filter(Boolean).join(' · ')}</span>
                <span class="tags">
                  <span class="chip" class:ok={row.state === 'merged'}>{row.state === 'merged' ? 'Übernommen' : row.state === 'closed' ? 'Geschlossen' : row.state === 'submitted' ? 'Eingereicht' : 'Entwurf'}</span>
                  {#if row.checks === 'success'}<span class="chip ok"><svg class="tick" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Geprüft</span>
                  {:else if row.checks === 'failure'}<span class="chip bad">Prüfung fehlgeschlagen</span>
                  {:else if row.checks === 'pending'}<span class="chip">Prüfung läuft …</span>{/if}
                  {#if row.session && ws.savingSessions.includes(row.session.id)}<span class="spinner" title="Wird gesichert" aria-label="Wird gesichert"></span>
                  {:else if row.session && ws.failedSessions.includes(row.session.id)}<span class="chip bad" title="Das Sichern hat nicht geklappt">!</span>{/if}
                </span>
              </span>
            </button>
            {#if current && unfolded}
              <div class="actions">
                {#if own && own.state === 'open'}
                  <!-- A draft of this person: handing it in, a new name, removing it. -->
                  {#if renaming}
                    <span class="field">
                      <input class="name" use:select bind:value={renameTo} aria-label="Neuer Name der Erfassung" maxlength="100" onkeydown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' && (renaming = false))} onblur={rename} />
                    </span>
                  {:else if submitting}
                    <div class="line">
                      <span>Erfassung einreichen?</span>
                      <button class="go" onclick={() => { submitting = false; void ws.submit() }}>Ja, einreichen</button>
                      <button class="plain" onclick={() => (submitting = false)}>Abbrechen</button>
                    </div>
                  {:else}
                    <div class="line">
                      <span title={ws.notReady.length > 0 ? 'Einreichen geht erst, wenn alle Objekte vollständig sind.' : ''}>
                        <button class="go" disabled={ws.shown.length === 0 || ws.notReady.length > 0 || ws.submitting} onclick={() => (submitting = true)}>{ws.submitting ? 'Wird eingereicht …' : 'Einreichen'}</button>
                      </span>
                      <button class="plain" onclick={() => ((renaming = true), (renameTo = own.name))}>Umbenennen</button>
                      {#if ws.removable(own)}<button class="plain" onclick={() => ws.removeSession(own.id)}>Entfernen</button>{/if}
                      {#if own.url}<a class="github" href={own.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>{/if}
                    </div>
                  {/if}
                {:else if detail && pull}
                  {#if waiting}
                    {#if review.blocked}<p class="note bad">{review.blocked}</p>{/if}
                    {#if asking}
                      <div class="line">
                        <span>{asking === 'merge' ? 'Erfassung ins Archiv übernehmen?' : 'Erfassung schließen, ohne sie zu übernehmen?'}</span>
                        <button class="go" class:danger={asking === 'close'} disabled={!!review.acting} onclick={() => go(asking!)}>
                          {#if asking === 'merge'}{review.acting ? 'Wird übernommen …' : 'Ja, übernehmen'}{:else}{review.acting ? 'Wird geschlossen …' : 'Ja, schließen'}{/if}
                        </button>
                        <button class="plain" disabled={!!review.acting} onclick={() => (asking = undefined)}>Abbrechen</button>
                        <a class="github" href={pull.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>
                      </div>
                    {:else}
                      <div class="line">
                        <span title={review.blocked ?? ''}><button class="go" disabled={!!review.blocked} onclick={() => (asking = 'merge')}>Übernehmen</button></span>
                        <button class="plain" onclick={() => (asking = 'close')}>Schließen</button>
                        <a class="github" href={pull.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>
                      </div>
                    {/if}
                    {#if review.actionError}<p class="note bad">{review.actionError}</p>{/if}
                  {:else}
                    <div class="line"><a class="github" href={pull.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a></div>
                  {/if}
                {:else}
                  <p class="quiet">Wird geladen …</p>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <Splitter sizes={heights} index={0} axis="y" min={96} />

  <section class="pane lower">
    <h2>Chat</h2>
    <Chat workspace={ws} />
  </section>
  </div>

  <Splitter sizes={columns} index={0} />

  {#if working}
  <section class="pane mid">
    <h2>
      Objekte
      {#if ws.current && ws.current.state !== 'merged'}
        <button class="add" title="Leeres Objekt hinzufügen" aria-label="Leeres Objekt hinzufügen" onclick={() => ws.addObject()}>+</button>
      {/if}
    </h2>
    <Objects workspace={ws} />
  </section>
  {:else}
  <section class="pane mid">
    {#if review.selectedPull === undefined}
      <h2>Objekte</h2>
      <p class="quiet center">Wähle links eine Erfassung.</p>
    {:else if review.detailState === 'failed'}
      <h2>Objekte</h2>
      <p class="problem">Die Erfassung konnte nicht gelesen werden: {review.detailError}</p>
    {:else if !detail || !pull}
      <h2>Objekte</h2>
      <p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Wird geladen …</p>
    {:else}
      <h2>
        Objekte
        <span class="count">{review.items.length}</span>
      </h2>
      {#if review.items.length === 0}
        <p class="quiet">Diese Erfassung enthält keine Objekte.</p>
      {:else}
        <ul class="list">
          {#each review.items as item (item.entry.id)}
            {@const id = item.entry.id}
            {@const open = id === review.selectedId}
            <li class="object" class:open>
              <button class="row" aria-expanded={open} onclick={() => toggle(id)}>
                <span class="title" class:empty={!item.entry.title}>{item.entry.title || 'Ohne Titel'}</span>
                <span class="sub">
                  <span class="change {item.change}">{CHANGES[item.change]}</span>
                  {#if review.problems.has(id)}<span class="warn" title="Hier stimmt etwas nicht">!</span>{/if}
                  <span class="kind">{[objectLabel(item.entry.type, item.entry.subtype), item.entry.date && formatDate(item.entry.date)].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              {#if open}
                <div class="body">
                  {#if item.change === 'removed'}
                    <p class="quiet">Dieses Objekt wird mit der Erfassung aus dem Archiv gelöscht.</p>
                  {:else}
                    <ObjectDetail entry={item.entry} lookup={review.lookup} membersOf={review.membersOf} problems={review.problems.get(id)} {filesBase} onopen={(other) => (review.byId.has(other) ? (review.selectedId = other) : undefined)} />
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
  {/if}

  <Splitter sizes={columns} index={1} />

  <section class="pane talking" ondragenter={fileOver} ondragover={fileOver} role="presentation">
    <div class="side" role="tablist" aria-label="Dateien und Kommentare">
      <button role="tab" class:active={tab === 'files'} aria-selected={tab === 'files'} onclick={() => (tab = 'files')}>Dateien</button>
      <button role="tab" class:active={tab === 'comments'} aria-selected={tab === 'comments'} onclick={() => (tab = 'comments')}>
        Kommentare{#if review.comments.length > 0}<span class="n">{review.comments.length}</span>{/if}
      </button>
      {#if tab === 'files' && mode === 'own'}
        {#if ws.progress}
          <span class="progress" role="status"><span class="spinner" aria-hidden="true"></span>{ws.progress.done} von {ws.progress.total}</span>
        {/if}
        <label class="add" title="Dateien hinzufügen" aria-label="Dateien hinzufügen">
          +
          <input type="file" multiple onchange={pick} />
        </label>
      {/if}
    </div>
    {#if tab === 'files'}
      {#if mode === 'own'}
        <Files workspace={ws} />
      {:else}
        <p class="quiet center">Dateien lassen sich bisher nur bei den eigenen Erfassungen ergänzen.</p>
      {/if}
    {:else if review.selectedPull === undefined}
      <p class="quiet center">{mode === 'own' && ws.current ? 'Kommentare gibt es, sobald die Erfassung bei GitHub ist, nach dem ersten gespeicherten Objekt.' : 'Wähle links eine Erfassung.'}</p>
    {:else}
      <div class="comments" role="log" aria-label="Kommentare">
        {#if review.commentsState === 'failed'}
          <p class="problem">Die Kommentare konnten nicht gelesen werden: {review.commentsError}</p>
        {:else if review.commentsState !== 'ready'}
          <p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Wird geladen …</p>
        {:else if shownComments.length === 0}
          <p class="quiet">Noch keine Kommentare. Schreib den ersten.</p>
        {:else}
          {#each shownComments as c (c.id)}
            <article class="comment">
              <header>
                {#if c.avatar}<img src={c.avatar} alt="" width="22" height="22" />{/if}
                <strong>{c.login}</strong>
                <time datetime={c.createdAt}>{timeOf(c.createdAt)}</time>
                {#if c.edited}<span class="edited">bearbeitet</span>{/if}
              </header>
              {#if c.object && c.kind === 'review'}
                <button class="about" title="Objekt zeigen" onclick={() => (review.selectedId = c.object)}>
                  {titleOf(c.object)}
                </button>
              {/if}
              {#if editing === c.id}
                <textarea class="edit" rows="3" bind:value={editText} maxlength="5000" aria-label="Kommentar bearbeiten" use:focus onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (editText.trim()) void saveEdit(c.id) } else if (e.key === 'Escape') { e.preventDefault(); editing = undefined } }}></textarea>
                <div class="tools">
                  <button class="go small" disabled={!editText.trim()} onclick={() => saveEdit(c.id)}>Speichern</button>
                  <button class="plain small" onclick={() => (editing = undefined)}>Abbrechen</button>
                </div>
              {:else}
                <p class="text">{c.text}</p>
                {#if c.kind === 'review'}
                  <span class="hint">Auf GitHub an einer Zeile geschrieben</span>
                {:else if review.isOwnComment(c)}
                  <div class="tools">
                    <button class="tool" onclick={() => { editing = c.id; editText = c.text; removing = undefined }}>Bearbeiten</button>
                    <button class="tool" class:danger={removing === c.id} onclick={() => remove(c.id)} onblur={() => removing === c.id && (removing = undefined)}>{removing === c.id ? 'Wirklich löschen?' : 'Löschen'}</button>
                  </div>
                {/if}
              {/if}
            </article>
          {/each}
        {/if}
      </div>
      {#if review.commentError}<p class="note bad">{review.commentError}</p>{/if}
      <form class="composer" onsubmit={(e) => { e.preventDefault(); void send() }}>
        <textarea
          bind:value={text}
          rows="3"
          maxlength="5000"
          placeholder="Kommentar schreiben …"
          aria-label="Kommentar"
          onkeydown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void send())}
        ></textarea>
        <div class="send">
          <span class="hint">⌘/Strg + Enter sendet</span>
          <button class="go" type="submit" disabled={!text.trim() || sending}>{sending ? 'Wird gesendet …' : 'Senden'}</button>
        </div>
      </form>
    {/if}
  </section>
</div>

<style>
  /* Three columns of the same width; the first holds two panes (the sessions above the chat). */
  /* The handles sit in the tracks between the panes (see Splitter.svelte), which are placed by hand. */
  .review { flex: 1; display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
  .review > :global(.left) { grid-column: 1; }
  .review > :global(.mid) { grid-column: 3; }
  .review > :global(.talking) { grid-column: 5; }
  .left { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .left > :global(.upper) { grid-row: 1; }
  .left > :global(.lower) { grid-row: 3; }
  .pane { position: relative; display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: var(--r-m); padding: 12px; }
  h2 { display: flex; align-items: center; gap: 8px; height: 1.6rem; margin: 0 0 8px; font-size: 1rem; }
  .count { font-size: 0.75rem; font-weight: 400; color: #888; }
  .refresh { margin-left: auto; width: 1.6rem; height: 1.6rem; padding: 0; border: 0; border-radius: 50%; background: none; color: #666; font-size: 1rem; cursor: pointer; }
  .refresh:hover { background: #eef2fb; color: #36c; }
  .filters { container-type: inline-size; display: flex; gap: 2px; margin: 0 0 8px; padding: 3px; border-radius: 999px; background: #f0f0ee; }
  .filters button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 1.8rem; padding: 0 6px; min-width: 0; border: 1px solid transparent; border-radius: 999px; background: none; color: #666; font: inherit; font-size: 0.76rem; font-weight: 600; cursor: pointer; white-space: nowrap; }
  /* A narrow list: the counts make way for the names. */
  @container (max-width: 330px) { .filters .n { display: none; } .filters button { padding: 0 2px; font-size: 0.72rem; } }
  .filters button:hover:not(.active) { color: #36c; }
  .filters button.active { background: #fff; border-color: #ddd; color: #36c; cursor: default; box-shadow: 0 1px 2px rgb(0 0 0 / 0.06); }
  .n { font-size: 0.7rem; font-weight: 600; min-width: 1.2rem; padding: 0 5px; border-radius: 999px; background: #fdebd7; color: #a85408; line-height: 1.2rem; }
  .list { flex: 1; min-height: 0; margin: 0; padding: 0; list-style: none; overflow: auto; }
  .list li { margin-bottom: 4px; }
  .row { display: flex; flex-direction: column; justify-content: center; gap: 3px; width: 100%; min-height: 52px; box-sizing: border-box; padding: 6px 12px; text-align: left; font: inherit; background: #fff; border: 1px solid #ddd; border-radius: var(--r-m); cursor: pointer; }
  .row:hover { border-color: #b9c8ee; }
  .row.current { border-color: #36c; background: #eef3ff; }
  .title { font-size: 0.85rem; line-height: 1.3; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.empty { font-weight: 400; color: #999; }
  .sub { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; line-height: 1.3; color: #777; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .change { flex: none; padding: 0 7px; border-radius: 999px; font-size: 0.68rem; background: #f0f0ee; color: #666; }
  .change.added { background: #e9f5ec; color: #2a7a3b; }
  .change.modified { background: #fdebd7; color: #a85408; }
  .change.removed { background: #fbe3e3; color: #a11; }
  .warn { flex: none; width: 1rem; height: 1rem; display: grid; place-items: center; border-radius: 50%; background: #a11; color: #fff; font-size: 0.7rem; font-weight: 700; }
  .loading { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 24px 0; color: #888; font-size: 0.9rem; }
  .spinner { flex: none; width: 12px; height: 12px; border: 1.5px solid #b9c8ee; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .quiet { margin: 0; color: #aaa; font-size: 0.9rem; }
  .quiet.center { margin: auto; }
  .problem { margin: 0; color: #a11; font-size: 0.9rem; }
  /* What can be done with the session: a quiet card above the object. */
  .actions { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid #36c; border-top: 0; border-radius: 0 0 var(--r-m) var(--r-m); background: #fff; }
  .list li:has(.actions) { margin-bottom: 8px; }
  .row.current[aria-expanded='true'] { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 0.85rem; }
  .state { display: inline-flex; align-items: center; gap: 6px; height: 1.4rem; box-sizing: border-box; padding: 0 10px; border-radius: 999px; background: #e6e6e3; color: #555; font-size: 0.72rem; }
  .state.waiting { background: #fdebd7; color: #a85408; }
  .state.merged { background: #e9f5ec; color: #2a7a3b; }
  .chip { height: 1.4rem; line-height: 1.4rem; padding: 0 10px; border-radius: 999px; background: #eef2fb; color: #345; font-size: 0.72rem; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
  .meta .sub { min-width: 0; }
  .tags { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
  .tags .chip { display: inline-flex; align-items: center; gap: 3px; height: 1.2rem; line-height: 1.2rem; padding: 0 8px; font-size: 0.68rem; }
  .chip.ok { background: #e9f5ec; color: #2a7a3b; }
  .chip.bad { background: #fbe3e3; color: #a11; }
  .github { margin-left: auto; font-size: 0.78rem; color: #36c; text-decoration: none; }
  .github:hover { text-decoration: underline; }
  .note { margin: 0; font-size: 0.82rem; color: #555; }
  .note.bad { color: #a11; }
  button.go { height: 2rem; padding: 0 16px; border: 0; border-radius: 999px; background: #36c; color: #fff; font: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  button.go:hover:not(:disabled) { background: #2a58b8; }
  button.go.danger { background: #b3261e; }
  button.go:disabled { background: #b4c3e6; cursor: default; }
  button.go.danger:disabled { background: #e3b4b1; }
  button.plain { height: 2rem; padding: 0 14px; border: 1px solid #ccc; border-radius: 999px; background: #fff; font: inherit; font-size: 0.85rem; cursor: pointer; }
  button.plain:hover:not(:disabled) { border-color: #b9c8ee; color: #36c; }
  button.plain:disabled { opacity: 0.45; cursor: default; }
  .list li.object.open { margin-bottom: 8px; }
  .object .row[aria-expanded='true'] { border-color: #36c; background: #eef3ff; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .object .body { padding: 12px; border: 1px solid #36c; border-top: 0; border-radius: 0 0 var(--r-m) var(--r-m); background: #fff; }
  .kind { overflow: hidden; text-overflow: ellipsis; }
  .talking { gap: 0; }
  .comments { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
  .comment { padding: 10px 12px; border-radius: var(--r-m); background: #f7f7f5; }
  .comment header { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: #888; }
  .comment header img { border-radius: 50%; }
  .comment header strong { color: #333; font-weight: 600; }
  .edited { font-size: 0.7rem; color: #aaa; }
  .about { display: block; margin: 6px 0 0; padding: 1px 8px; border: 0; border-radius: 999px; background: #eef2fb; color: #36c; font: inherit; font-size: 0.72rem; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .about:hover { background: #dde6fa; }
  .text { margin: 6px 0 0; font-size: 0.88rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hint { font-size: 0.72rem; color: #aaa; }
  .tools { display: flex; gap: 10px; margin-top: 6px; }
  .tool { all: unset; font-size: 0.75rem; color: #888; cursor: pointer; }
  .tool:hover { color: #36c; text-decoration: underline; }
  .tool.danger { color: #a11; }
  .tool:focus-visible { outline: 2px solid #36c; border-radius: 2px; }
  .edit, .composer textarea { font: inherit; font-size: 0.88rem; padding: 8px 10px; border: 1px solid #ddd; border-radius: var(--r-m); resize: vertical; width: 100%; box-sizing: border-box; background: #fff; }
  .edit { margin-top: 6px; }
  .edit:focus, .composer textarea:focus { outline: none; border-color: #36c; }
  .composer { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid #eee; }
  .send { display: flex; align-items: center; justify-content: space-between; }
  button.small { height: 1.7rem; padding: 0 12px; font-size: 0.78rem; }
  /* The pill of the right column (like the one of the filters): the tabs, and what belongs to the open one on the right. */
  .side { display: flex; align-items: center; gap: 2px; margin: 0 0 8px; padding: 3px; border-radius: 999px; background: #f0f0ee; }
  .side button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 1.8rem; padding: 0 16px; border: 1px solid transparent; border-radius: 999px; background: none; color: #666; font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; }
  .side button:hover:not(.active) { color: #36c; }
  .side button.active { background: #fff; border-color: #ddd; color: #36c; cursor: default; box-shadow: 0 1px 2px rgb(0 0 0 / 0.06); }
  .side .progress { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; color: #777; }
  .side .progress + .add { margin-left: 6px; }
  .add { margin-left: auto; width: 1.6rem; height: 1.6rem; padding: 0; display: grid; place-items: center; border: 0; border-radius: 50%; background: none; color: #36c; font-size: 1.3rem; font-weight: 400; line-height: 1; cursor: pointer; }
  h2 .add { margin-left: auto; }
  h2 .add + .refresh { margin-left: 0; }
  .add:hover { background: #eef2fb; }
  .add input { display: none; }
  .field { position: relative; display: flex; align-items: center; margin: 0 0 8px; }
  .name { flex: 1; min-width: 0; height: 2rem; box-sizing: border-box; padding: 0 34px 0 12px; border: 1px solid #b9c8ee; border-radius: 999px; font: inherit; font-size: 0.85rem; }
  .enter { position: absolute; right: 6px; border: 0; background: none; color: #888; font-size: 1.1rem; line-height: 1; padding: 2px 6px; cursor: pointer; }
</style>
