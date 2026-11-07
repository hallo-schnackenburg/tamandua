<script lang="ts">
  import { onMount } from 'svelte'
  import { EditorView, basicSetup } from 'codemirror'
  import { yaml } from '@codemirror/lang-yaml'
  import { setDiagnostics, type Diagnostic } from '@codemirror/lint'

  interface Props {
    value: string
    diagnostics: Diagnostic[]
    onchange: (text: string) => void
  }

  let { value, diagnostics, onchange }: Props = $props()

  let host: HTMLDivElement
  // $state.raw: effects below re-run when the editor exists, but its insides are not tracked.
  let view = $state.raw<EditorView>()

  // Create the editor once, when the element exists; destroy it when the component goes.
  onMount(() => {
    view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        basicSetup,
        yaml(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onchange(update.state.doc.toString())
        }),
      ],
    })
    return () => view?.destroy()
  })

  // Text changed from outside (a dropped file, later the agent): show it in the editor.
  // When the user types, `value` already equals the document, so nothing happens.
  $effect(() => {
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  })

  // Runs again whenever `diagnostics` changes: hand the new markers to the editor.
  $effect(() => {
    if (!view) return
    const length = view.state.doc.length
    const clamped = diagnostics.map((d) => ({
      ...d,
      from: Math.min(d.from, length),
      to: Math.min(d.to, length),
    }))
    view.dispatch(setDiagnostics(view.state, clamped))
  })
</script>

<div class="editor" bind:this={host}></div>

<style>
  /* The editor grows with the text, up to a maximum; longer text scrolls inside. */
  .editor { background: white; }
  .editor :global(.cm-editor) { max-height: 34rem; }
  /* No line numbers, fold markers or lint markers for now; the text lines up with the title above. */
  .editor :global(.cm-gutters) { display: none; }
  .editor :global(.cm-line) { padding-left: 10px; }
  .editor :global(.cm-editor.cm-focused) { outline: none; }
  .editor :global(.cm-scroller) { overflow: auto; }
</style>
