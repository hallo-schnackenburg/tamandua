<script lang="ts">
  import type { Workspace, Session } from './workspace.svelte.js'

  // The choice of the session: its name only, the sessions in groups, a pencil to rename, and a way to make a new one.
  let { workspace: ws }: { workspace: Workspace } = $props()

  let listed = $state(false)
  let mode = $state<'view' | 'rename' | 'new'>('view')
  let draft = $state('')

  const GROUPS = [
    { state: 'open', title: 'Offen' },
    { state: 'submitted', title: 'Eingereicht' },
    { state: 'merged', title: 'Übernommen' },
  ] as const
  const BADGES = { open: '', submitted: 'wird geprüft', merged: 'übernommen' } as const

  const groups = $derived(
    GROUPS.map((g) => ({ ...g, sessions: ws.sessions.filter((s) => s.state === g.state) })).filter((g) => g.sessions.length > 0),
  )
  const countOf = (session: Session) => ws.objects.filter((o) => o.sessionId === session.id).length

  function start(next: 'rename' | 'new') {
    mode = next
    draft = next === 'rename' ? (ws.current?.name ?? '') : ''
    listed = false
  }

  function commit() {
    if (mode === 'new' && draft.trim()) ws.createSession(draft)
    else if (mode === 'rename' && ws.current) ws.renameSession(ws.current.id, draft)
    mode = 'view'
  }

  function focusAndSelect(node: HTMLInputElement) {
    node.focus()
    node.select()
  }

  function outside(event: MouseEvent) {
    if (listed && !(event.target as HTMLElement).closest('.sessions')) listed = false
  }
</script>

<svelte:window onclick={outside} onkeydown={(e) => e.key === 'Escape' && (listed = false)} />

{#snippet mark(session: Session)}
  {#if ws.savingSessions.includes(session.id)}
    <span class="spinner" title="Wird gesichert" aria-label="Wird gesichert"></span>
  {:else if ws.failedSessions.includes(session.id)}
    <span class="failed" title="Das Sichern hat nicht geklappt" aria-label="Das Sichern hat nicht geklappt">!</span>
  {/if}
{/snippet}

<div class="sessions">
  {#if mode !== 'view'}
    <input
      class="name"
      use:focusAndSelect
      bind:value={draft}
      placeholder="Name der Sitzung, z. B. Dachbodenfund Postkarten"
      aria-label={mode === 'new' ? 'Name der neuen Sitzung' : 'Neuer Name der Sitzung'}
      maxlength="100"
      onkeydown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') mode = 'view'
      }}
      onblur={commit}
    />
  {:else}
    <button class="choice" aria-haspopup="listbox" aria-expanded={listed} onclick={() => (listed = !listed)}>
      <span class="label" class:none={!ws.current}>{ws.current?.name ?? 'Keine Sitzung'}</span>
      {#if ws.current}{@render mark(ws.current)}{/if}
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    {#if ws.current}
      <button class="pencil" title="Sitzung umbenennen" aria-label="Sitzung umbenennen" onclick={() => start('rename')}>✎</button>
    {/if}
    {#if listed}
      <div class="list" role="listbox">
        {#each groups as group}
          <div class="group">{group.title} ({group.sessions.length})</div>
          {#each group.sessions as session (session.id)}
            <button
              class="item"
              role="option"
              aria-selected={session.id === ws.currentId}
              class:current={session.id === ws.currentId}
              onclick={() => {
                ws.selectSession(session.id)
                listed = false
              }}
            >
              <span class="label">{session.name}</span>
              {@render mark(session)}
              {#if BADGES[session.state]}<span class="badge {session.state}">{BADGES[session.state]}</span>{/if}
              <span class="count">{countOf(session)}</span>
            </button>
          {/each}
        {/each}
        <button class="item new" onclick={() => start('new')}>+ Neue Sitzung …</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .sessions { position: relative; display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
  button { font: inherit; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
  .choice { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; max-width: 22rem; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.none { color: #888; }
  .caret { color: #888; font-size: 0.8rem; }
  .pencil { border: 0; background: none; color: #888; padding: 4px 6px; }
  .pencil:hover { color: #36c; }
  .name { font: inherit; padding: 4px 10px; width: 22rem; max-width: 40vw; border: 1px solid #36c; border-radius: 6px; }
  .list { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; min-width: 20rem; max-width: 30rem; max-height: 60vh; overflow: auto; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); padding: 4px; display: flex; flex-direction: column; }
  .group { padding: 6px 8px 2px; font-size: 0.75rem; color: #888; }
  .item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; padding: 6px 8px; border-radius: 4px; }
  .item:hover { background: #f1f4fb; }
  .item.current { background: #eef2fb; }
  .item .label { flex: 1; min-width: 0; }
  .item.new { color: #36c; margin-top: 4px; border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
  .count { font-size: 0.78rem; color: #888; }
  .spinner { flex: none; width: 10px; height: 10px; border: 1.5px solid #b9c8ee; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .failed { flex: none; width: 14px; height: 14px; display: grid; place-items: center; border-radius: 50%; background: #c92a2a; color: #fff; font-size: 0.72rem; font-weight: 700; line-height: 1; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .badge { font-size: 0.72rem; color: #36c; border: 1px solid #b9c8ee; border-radius: 10px; padding: 0 7px; white-space: nowrap; }
  .badge.merged { color: #2a7a3b; border-color: #b5dcbd; }
</style>
