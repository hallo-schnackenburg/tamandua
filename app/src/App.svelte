<script lang="ts">
  import { onMount } from 'svelte'
  import Chat from './Chat.svelte'
  import Files from './Files.svelte'
  import Objects from './Objects.svelte'
  import Sessions from './Sessions.svelte'
  import Database from './Database.svelte'
  import { ArchiveDb } from './database.svelte.js'
  import { liveUrl } from './live.js'
  import { FakeAgent } from './agent.js'
  import { WorkerAgent } from './worker-agent.js'
  import { FakeStore, S3Store } from './uploader.js'
  import { FakeBackend, HttpBackend } from './backend.js'
  import { onSignedOut } from './api.js'
  import { formatRoute, parseRoute, type Route } from './route.js'
  import { Workspace } from './workspace.svelte.js'

  // All state lives in the workspace; this component only arranges the panes.
  // With a Worker the app is real: the model answers and files go to the bucket. Without one, stand-ins.
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const backend = workerUrl ? new HttpBackend(workerUrl) : new FakeBackend()
  const ws = new Workspace(workerUrl ? new S3Store(workerUrl) : new FakeStore(), workerUrl ? new WorkerAgent(workerUrl) : new FakeAgent(), backend)
  const archive = new ArchiveDb(backend.archive, workerUrl ? liveUrl(workerUrl, location.href) : undefined)

  // The copy of the archive in the browser is kept up to date for as long as somebody is signed in.
  // (A derived value: the effect only runs again when somebody signs in or out, not whenever the session is renewed.)
  const signedIn = $derived(ws.login.state === 'user')
  $effect(() => {
    if (!signedIn) return
    void archive.start()
    return () => archive.stop()
  })

  // The tabs separate the UI concepts: capturing (the three panes) and the database. Only a convenience of this browser.
  type Tab = 'capture' | 'database'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'capture', label: 'Erfassen' },
    { id: 'database', label: 'Datenbank' },
  ]
  let tab = $state<Tab>(readTab())
  function readTab(): Tab {
    try {
      return localStorage.getItem('tamandua.tab') === 'database' ? 'database' : 'capture'
    } catch {
      return 'capture'
    }
  }
  function show(next: Tab) {
    tab = next
    try {
      localStorage.setItem('tamandua.tab', next)
    } catch {
      // not remembered, that is all
    }
  }

  // --- the address of the page: tab, session and chosen object are in it, so that back and forward work and it can be passed on (route.ts) ---
  const REMEMBERED = 'tamandua.route'
  const recalled = (): string => {
    try {
      return sessionStorage.getItem(REMEMBERED) ?? ''
    } catch {
      return ''
    }
  }
  /** A session named in the address that is not here (yet): it is chosen when it appears, e.g. when it is brought back from GitHub. */
  let pendingSession = $state<string>()

  /** Makes the app show what the route says. */
  function apply(route: Route) {
    show(route.tab)
    if (route.tab === 'database') {
      archive.selectedId = route.id
      archive.groupId = route.group
    } else if (route.session && route.session !== ws.currentId) {
      if (ws.sessions.some((s) => s.id === route.session)) {
        ws.selectSession(route.session)
        pendingSession = undefined
      } else pendingSession = route.session
    }
  }
  // The address, or the one before a sign-in (GitHub sends the browser back to the bare address).
  const start = parseRoute(location.hash) ?? parseRoute(recalled())
  if (start) apply(start)

  $effect(() => {
    const wanted = pendingSession
    if (wanted && ws.sessions.some((s) => s.id === wanted)) {
      if (ws.currentId !== wanted) ws.selectSession(wanted)
      pendingSession = undefined
    }
  })

  const current = $derived<Route>(tab === 'database' ? { tab, id: archive.selectedId, group: archive.groupId } : { tab, session: ws.currentId })
  let last: Route | undefined
  $effect(() => {
    const route = current
    if (!signedIn || pendingSession) return
    const hash = formatRoute(route)
    if (hash !== location.hash) {
      // The first address, and the session becoming known while the page loads, are not steps of the user's: they replace the entry.
      const replace = last === undefined || (last.tab === 'capture' && route.tab === 'capture' && last.session === undefined)
      history[replace ? 'replaceState' : 'pushState'](null, '', hash)
    }
    last = route
    try {
      sessionStorage.setItem(REMEMBERED, hash)
    } catch {
      // not remembered, that is all
    }
  })

  /** Why a sign-in did not work, from the address GitHub sent the browser back to (see the Worker's /auth/callback). */
  function loginNotice(): string | undefined {
    const params = new URLSearchParams(location.search)
    const result = params.get('login')
    if (!result) return undefined
    history.replaceState(null, '', location.pathname) // the notice is shown once
    if (result === 'denied') {
      return `Du bist als „${params.get('user') ?? '?'}“ bei GitHub angemeldet, aber noch nicht freigeschaltet. Gib dein GitHub-Konto beim Archiv-Team an, damit es dich ins Repository einlädt.`
    }
    return 'Die Anmeldung bei GitHub hat nicht geklappt. Bitte versuche es noch einmal.'
  }

  let confirming = $state(false)

  function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    ws.addDropped(input.files ?? [])
    input.value = '' // so that the same file can be picked again
  }

  onMount(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as { workspace: Workspace }).workspace = ws // for the console and the browser tests
      // Development helper for the console: `resetArchive()` clears everything stored in the browser and reloads.
      ;(window as unknown as { resetArchive: () => Promise<void> }).resetArchive = () => ws.resetAll()
    }
    void ws.load()
    void ws.refreshSession(loginNotice())
    const stopSignedOut = onSignedOut(() => ws.signedOut())
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void ws.flush()
        void ws.sync()
      } else {
        void ws.checkPulls()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Back and forward.
    const onPop = () => {
      const route = parseRoute(location.hash)
      if (route) apply(route)
    }
    window.addEventListener('popstate', onPop)
    // Another window in front, the tab still visible: save as well.
    const onBlur = () => {
      void ws.flush()
      ws.leave()
    }
    window.addEventListener('blur', onBlur)
    const poll = setInterval(() => document.visibilityState === 'visible' && void ws.checkPulls(), 60_000)
    return () => {
      stopSignedOut()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('blur', onBlur)
    }
  })

  // A file dropped on a part of the page that does not take it would be opened by the browser,
  // and the page with it. Files from outside go to the "Dateien" pane only.
  onMount(() => {
    const stop = (event: DragEvent) => event.dataTransfer?.types.includes('Files') && event.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  })
</script>

<main>
  {#if ws.login.state === 'user'}
    {@const user = ws.login.user}
    <header>
      <img class="logo" src={`${import.meta.env.BASE_URL}tamandua.png`} alt="Tamandua" title="Tamandua" height="52" />
      <div class="tabs" role="tablist" aria-label="Ansicht">
        {#each TABS as t (t.id)}
          <button role="tab" class:active={tab === t.id} aria-selected={tab === t.id} onclick={() => show(t.id)}>{t.label}</button>
        {/each}
      </div>
      {#if tab === 'capture'}
      <Sessions workspace={ws} />
      {#if ws.current?.state === 'submitted'}
        <span class="state submitted">Eingereicht</span>
      {:else if ws.current?.state === 'merged'}
        <span class="state merged">Übernommen</span>
      {:else if confirming}
        <span class="confirm">
          Erfassung einreichen?
          <button class="submit" onclick={() => { confirming = false; void ws.submit() }}>Ja, einreichen</button>
          <button class="plain" onclick={() => (confirming = false)}>Abbrechen</button>
        </span>
      {:else}
        <!-- The wrapper carries the hint: a disabled button shows none in every browser. -->
        <span class="submit-wrap" title={ws.notReady.length > 0 ? 'Einreichen geht erst, wenn alle Objekte vollständig sind.' : ''}>
          <button class="submit" disabled={ws.current?.state !== 'open' || ws.shown.length === 0 || ws.notReady.length > 0 || ws.submitting} onclick={() => (confirming = true)}>
            {ws.submitting ? 'Wird eingereicht …' : 'Einreichen'}
          </button>
        </span>
      {/if}
      {/if}
      <span class="sync" class:failed={ws.syncState === 'failed'} role="status">
        {#if ws.syncState === 'failed'}
          Noch nicht in GitHub gesichert{ws.syncError ? `: ${ws.syncError}` : ''}. Neuer Versuch in einer Minute.
        {/if}
      </span>
      {#if ws.saveState !== 'failed' && !ws.picturesKept}
        <span class="sync" title="Der Browser speichert hier keine Bilder (z. B. in einem privaten Fenster). Texte und Objekte sind gesichert; die Vorschaubilder werden nach dem Neuladen neu geholt oder fehlen.">Vorschaubilder werden nicht lokal gespeichert.</span>
      {/if}
      {#if ws.saveState === 'failed'}
        <span class="sync failed" title="Im Browser konnte nichts gespeichert werden. Änderungen gehen verloren, wenn du die Seite schließt.">Konnte nicht gesichert werden.</span>
      {/if}
      <span class="spacer"></span>
      <span class="user">
        {#if user.avatar}<img src={user.avatar} alt="" width="24" height="24" />{/if}
        {user.name || user.login}
      </span>
      <button class="link" onclick={() => ws.logout()}>Abmelden</button>
    </header>

    <div class="panes" class:gone={tab !== 'capture'}>
      <section class="pane">
        <h2>Chat</h2>
        <Chat workspace={ws} />
      </section>

      <section class="pane">
        <h2>
          Dateien
          {#if ws.progress}
            <span class="progress" role="status"><span class="spinner" aria-hidden="true"></span>{ws.progress.done} von {ws.progress.total}</span>
          {/if}
          <label class="add" title="Dateien hinzufügen" aria-label="Dateien hinzufügen">
            +
            <input type="file" multiple onchange={pick} />
          </label>
        </h2>
        <Files workspace={ws} />
      </section>

      <section class="pane">
        <h2>
          Objekte
          {#if ws.current?.state === 'open'}
            <button class="add" title="Leeres Objekt hinzufügen" aria-label="Leeres Objekt hinzufügen" onclick={() => ws.addObject()}>+</button>
          {/if}
        </h2>
        {#if ws.current && ws.current.state !== 'open'}
          {@const session = ws.current}
          <p class="banner {session.state}" role="status">
            {#if session.state === 'submitted'}
              Diese Erfassung ist eingereicht. Sie kann hier nicht mehr geändert werden.
              {#if session.url}<a href={session.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>{/if}
            {:else}
              Diese Erfassung ist ins Archiv übernommen.
              {#if session.url}<a href={session.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>{/if}
            {/if}
          </p>
        {/if}
        <Objects workspace={ws} />
      </section>
    </div>
    {#if tab === 'database'}<Database {archive} filesBase={ws.filesBase} />{/if}
  {:else if ws.login.state === 'loading'}
    <div class="welcome"><p class="quiet">Einen Moment …</p></div>
  {:else}
    <div class="welcome">
      <img class="logo big" src={`${import.meta.env.BASE_URL}tamandua.png`} alt="" height="96" />
      <h1>Tamandua</h1>
      <p>Hier erfasst du Objekte des Archivs.</p>
      {#if ws.login.state === 'anonymous'}
        {#if ws.login.notice}<p class="notice">{ws.login.notice}</p>{/if}
        <a class="primary button" href={ws.loginUrl}>Mit GitHub anmelden</a>
        {#if ws.objects.length > 0}<p class="quiet">Deine bisherige Arbeit auf diesem Gerät bleibt erhalten.</p>{/if}
      {:else}
        <p class="notice">{ws.login.message}</p>
        <button class="primary" onclick={() => ws.refreshSession()}>Noch einmal versuchen</button>
      {/if}
    </div>
  {/if}
</main>

<style>
  main { display: flex; flex-direction: column; gap: 12px; height: 100%; padding: 12px; }
  /* A raised white bar: the session is the center of it, its state or the way forward stands right next to it. */
  header { position: relative; display: flex; align-items: center; gap: 12px; font-size: 0.9rem; min-height: calc(2.3rem + 16px); padding: 8px 14px 8px 84px; background: #fff; border-radius: var(--r-l); box-shadow: 0 1px 3px rgb(0 0 0 / 0.08), 0 4px 14px rgb(0 0 0 / 0.05); }
  .spacer { flex: 1; }
  /* Centered in the bar. One pill with a state per view, like the session pill: the active one is raised and blue. */
  .tabs { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; gap: 2px; height: 2.3rem; box-sizing: border-box; padding: 3px; border-radius: 999px; background: #f0f0ee; }
  .tabs button { height: 100%; padding: 0 16px; border: 1px solid transparent; border-radius: 999px; background: none; color: #666; font-weight: 600; }
  .tabs button:hover:not(.active) { color: #36c; }
  .tabs button.active { background: #fff; border-color: #ddd; color: #36c; cursor: default; box-shadow: 0 1px 2px rgb(0 0 0 / 0.06); }
  .sync { color: #777; }
  .sync.failed { color: #a11; }
  /* The state is a quiet label (gray, with a dot); the way forward is a solid blue button. They must not be mistaken for each other. */
  .state { display: inline-flex; align-items: center; gap: 6px; height: 1.4rem; box-sizing: border-box; padding: 0 10px; border-radius: 999px; background: #f0f0ee; color: #666; font-size: 0.72rem; }
  .state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #999; }
  .state.submitted { background: #fdebd7; color: #a85408; }
  .state.submitted::before { background: #e07b1a; }
  .state.merged { background: #e9f5ec; color: #2a7a3b; }
  .state.merged::before { background: #3aa655; }
  button.submit { height: 2.3rem; padding: 0 18px; border-radius: 999px; border: 0; background: #36c; color: #fff; font-weight: 600; box-shadow: 0 1px 2px rgb(51 102 204 / 0.35); }
  button.submit:hover:not(:disabled) { background: #2a58b8; }
  button.submit:disabled { background: #b4c3e6; box-shadow: none; cursor: default; }
  .submit-wrap { display: inline-flex; }
  button.plain { border-radius: 999px; }
  .progress { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 400; color: #777; }
  .progress + .add { margin-left: 6px; }
  .spinner { width: 10px; height: 10px; border: 1.5px solid #b9c8ee; border-top-color: #36c; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .add { margin-left: auto; width: 1.6rem; height: 1.6rem; display: grid; place-items: center; border-radius: 50%; color: #36c; font-size: 1.3rem; font-weight: 400; line-height: 1; cursor: pointer; }
  button.add { padding: 0; border: 0; background: none; }
  .add:hover { background: #eef2fb; }
  .add input { display: none; }
  .user { display: inline-flex; align-items: center; gap: 6px; }
  .user img { border-radius: 50%; }
  .confirm { display: inline-flex; align-items: center; gap: 8px; }
  button { font: inherit; padding: 4px 10px; border: 1px solid #ccc; border-radius: var(--r-m); background: #fff; cursor: pointer; }
  button.primary, a.primary { background: #36c; border-color: #36c; color: #fff; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.link { border: 0; background: none; color: #36c; padding: 4px; }
  .welcome { margin: auto; max-width: 28rem; text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .welcome h1 { margin: 0; }
  /* The logo sits on the header and reaches a little over its lower edge; the header leaves room for it on the left. */
  .logo { position: absolute; left: 14px; top: 9px; height: 50px; width: auto; }
  .logo.big { position: static; display: block; height: 96px; }
  .welcome p { margin: 0; }
  .button { display: inline-block; padding: 8px 16px; border-radius: var(--r-m); text-decoration: none; }
  .notice { color: #a11; }
  .banner { margin: 0 0 8px; padding: 6px 10px; border-radius: var(--r-m); font-size: 0.85rem; background: #eef2fb; color: #345; }
  .banner.submitted { background: #fdebd7; color: #7a4308; }
  .banner.merged { background: #edf7ef; }
  .banner a { color: #36c; margin: 0 4px; }
  .quiet { color: #888; font-size: 0.9rem; }
  .panes { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); /* minmax(0, …): long YAML lines must not widen the pane */ gap: 12px; min-height: 0; }
  .panes.gone { display: none; }
  /* The hint of an empty pane: centered below the heading, on the same height in every pane. */
  :global(.empty-state) { position: absolute; margin: 0; padding: 0; inset: calc(20px + 1.6rem) 12px 12px 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; line-height: 1.3; color: #aaa; text-align: center; pointer-events: none; }
  :global(.empty-state small) { font-size: 0.78rem; color: #c4c4c4; }
  .pane { position: relative; display: flex; flex-direction: column; min-height: 0; background: #fff; border-radius: var(--r-m); padding: 12px; }
  h2 { display: flex; align-items: center; height: 1.6rem; margin: 0 0 8px; font-size: 1rem; }
</style>
