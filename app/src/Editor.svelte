<script lang="ts">
  import { onMount } from 'svelte'
  import { EditorView, basicSetup } from 'codemirror'
  import { Compartment, EditorState } from '@codemirror/state'
  import { yaml } from '@codemirror/lang-yaml'
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
  import { tags } from '@lezer/highlight'
  import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
  import { setDiagnostics, type Diagnostic } from '@codemirror/lint'

  // Quiet colors: keys in a gray blue, values dark, strings a muted brown.
  const quiet = HighlightStyle.define([
    { tag: tags.definition(tags.propertyName), color: '#5a6a8a' },
    { tag: tags.content, color: '#2f2f2f' },
    { tag: tags.string, color: '#9a5b46' },
    { tag: [tags.separator, tags.punctuation, tags.meta], color: '#b0b0b0' },
    { tag: tags.lineComment, color: '#999', fontStyle: 'italic' },
  ])

  // The id and the `files` block (hashes, paths, variants) are the least interesting parts: set them back.
  const quietFiles = Decoration.line({ class: 'cm-files' })
  function filesLines(view: EditorView): DecorationSet {
    const ranges = []
    let inFiles = false
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n)
      if (/^id:/.test(line.text)) ranges.push(quietFiles.range(line.from))
      if (/^files:/.test(line.text)) inFiles = true
      else if (inFiles && /^\S/.test(line.text) && !line.text.startsWith('-')) inFiles = false
      if (inFiles) ranges.push(quietFiles.range(line.from))
    }
    return Decoration.set(ranges)
  }
  const filesPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = filesLines(view)
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = filesLines(update.view)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )

  // Whether the text can be changed is switched on the running editor: a session can be submitted while its object is open.
  const locking = new Compartment()
  const lock = (frozen: boolean) => [EditorState.readOnly.of(frozen), EditorView.editable.of(!frozen)]

  interface Props {
    value: string
    diagnostics: Diagnostic[]
    onchange: (text: string) => void
    /** The editor lost the focus: the person turned to something else. */
    onleave?: () => void
    /** A submitted session is frozen: the text can be read and selected, not changed. */
    readonly?: boolean
  }

  let { value, diagnostics, onchange, onleave, readonly = false }: Props = $props()

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
        syntaxHighlighting(quiet),
        EditorView.lineWrapping, // long texts (description, notes) wrap instead of running off to the right
        filesPlugin,
        locking.of(lock(readonly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onchange(update.state.doc.toString())
          if (update.focusChanged && !update.view.hasFocus) onleave?.()
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

  $effect(() => {
    view?.dispatch({ effects: locking.reconfigure(lock(readonly)) })
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
  /* The editor is as tall as its text, but at most as tall as the room the open row has; longer text scrolls inside. */
  .editor { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; background: white; }
  .editor :global(.cm-editor) { flex: 1 1 auto; min-height: 0; }
  /* No line numbers, fold markers or lint markers for now; the text lines up with the title above. */
  .editor :global(.cm-gutters) { display: none; }
  .editor :global(.cm-line) { padding-left: 10px; }
  .editor :global(.cm-editor.cm-focused) { outline: none; }
  .editor :global(.cm-scroller) { overflow: auto; }
  .editor :global(.cm-files), .editor :global(.cm-files span) { color: #b3b3b3 !important; }
</style>
