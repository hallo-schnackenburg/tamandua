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
  let asking = $state<string>() // the session whose removal waits for a second click

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
    // composedPath: a clicked button may already be gone from the page (the trash can turns into a question)
    if (listed && !event.composedPath().some((n) => (n as HTMLElement).classList?.contains('sessions'))) listed = false
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
    <button
      class="choice"
      aria-haspopup="listbox"
      aria-expanded={listed}
      title={ws.current ? 'Doppelklick zum Umbenennen' : undefined}
      onclick={() => ((listed = !listed), (asking = undefined))}
      ondblclick={() => ws.current && start('rename')}
    >
      <span class="label" class:none={!ws.current}>{ws.current?.name ?? 'Keine Sitzung'}</span>
      {#if ws.current}{@render mark(ws.current)}{/if}
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    {#if listed}
      <div class="list" role="listbox">
        {#each groups as group}
          <div class="group">{group.title} ({group.sessions.length})</div>
          {#each group.sessions as session (session.id)}
            <div class="item" class:current={session.id === ws.currentId}>
              <button
                class="pick"
                role="option"
                aria-selected={session.id === ws.currentId}
                onclick={() => {
                  ws.selectSession(session.id)
                  listed = false
                }}
              >
                <span class="label">{session.name}</span>
                {@render mark(session)}
                {#if BADGES[session.state]}<span class="badge {session.state}">{BADGES[session.state]}</span>{/if}
              </button>
              {#if ws.removable(session)}
                {#if asking === session.id}
                  <button class="sure" onclick={() => ((asking = undefined), ws.removeSession(session.id))}>Entfernen?</button>
                {:else}
                  <button
                    class="trash"
                    title="Sitzung entfernen"
                    aria-label="Sitzung entfernen"
                    onclick={() => (session.state === 'open' ? ws.removeSession(session.id) : (asking = session.id))}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M7 7v3.5M9 7v3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                {/if}
              {/if}
            </div>
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
  .choice { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; height: 2.3rem; max-width: 24rem; border: 1px solid #ddd; border-radius: 999px; background: #fff; font-size: 1.1rem; font-weight: 600; }
  .choice:hover { border-color: #b9c8ee; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.none { color: #888; }
  .caret { color: #888; font-size: 0.8rem; }
  .name { font: inherit; font-size: 1.1rem; font-weight: 600; height: 2.3rem; box-sizing: border-box; padding: 0 14px; width: 22rem; max-width: 40vw; border: 1px solid #36c; border-radius: 999px; }
  .list { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; min-width: 22rem; max-width: 32rem; border-radius: 12px; max-height: 60vh; overflow: auto; background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); padding: 4px; display: flex; flex-direction: column; }
  .group { padding: 6px 8px 2px; font-size: 0.75rem; color: #888; }
  .item { display: flex; align-items: center; gap: 4px; border-radius: 4px; }
  .pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; text-align: left; border: 0; background: none; padding: 9px 10px; font-weight: 400; font-size: 0.95rem; }
  .trash, .sure { flex: none; border: 0; background: none; color: #999; padding: 4px 6px; margin-right: 4px; }
  .trash:hover { color: #c92a2a; }
  .sure { color: #c92a2a; font-size: 0.8rem; }
  .item:hover { background: #f1f4fb; }
  .item.current { background: #eef2fb; }
  .pick .label { flex: 1; min-width: 0; }
  .item.new { display: block; width: 100%; text-align: left; padding: 6px 8px; border: 0; background: none; color: #36c; margin-top: 4px; border-top: 1px solid #eee; border-radius: 0 0 4px 4px; }
  .spinner { flex: none; width: 10px; height: 10px; border: 1.5px solid #b9c8ee; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .failed { flex: none; width: 14px; height: 14px; display: grid; place-items: center; border-radius: 50%; background: #c92a2a; color: #fff; font-size: 0.72rem; font-weight: 700; line-height: 1; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .badge { font-size: 0.72rem; color: #36c; border: 1px solid #b9c8ee; border-radius: 10px; padding: 0 7px; white-space: nowrap; }
  .badge.merged { color: #2a7a3b; border-color: #b5dcbd; }
</style>
