# Forge Studio — architecture and contracts

## Rendering and UI separation

The desktop chrome is native HTML/CSS. The code viewport is owned by `CodeEditor`, which submits primitives to `Surface`. A DOM textarea is used for keyboard/IME input; it is not the visible renderer. When accessibility mode is selected, a full native textarea intentionally replaces the custom visual editor.

The flow is:

```text
keyboard / pointer / clipboard / composition
  → TextDocument edit or selection transaction
  → PieceTable and revision history
  → document events
  → token-cache / layout-cache invalidation
  → visible-row display list
  → Surface: WebGPU or Canvas 2D

content changes
  → debounced language-worker request + buffer version
  → parser diagnostics and symbols
  → version check
  → Error List / outline / editor decorations
```

The workbench has one command map. Menus, toolbars, keyboard shortcuts, palette results, and integration scripts call the same handlers. `window.forge` exposes the workspace, editor, runtime, analysis service, command map, and command execution as an explicit inspection seam. It is not exposed to the execution sandbox.

## Text representation

`PieceTable` stores immutable source/insertion strings in `buffers[]`. Each string has an ascending array of UTF-16 newline offsets. A treap node references a contiguous interval and stores its interval newline range and subtree measures:

```js
{
  buffer, start, count, firstBreak, breaks,
  priority, left, right,
  length, newlines
}
```

Replacement splits at the two boundaries, discards the middle subtree, inserts a new piece, and merges the result. Text is not flattened by the replacement itself. Tree lookup uses character/newline measures, and per-piece newline lookup uses binary search. Extracting the whole document, exporting, serializing, or parsing necessarily costs linear work in the document size. Treap balance is randomized, not a worst-case AVL guarantee.

UTF-16 offsets intentionally match JavaScript string slicing and parser locations. Screen navigation maps grapheme clusters to approximate monospace cells with `Intl.Segmenter`. Tabs advance to the next configured indentation stop. Wide-character handling is approximate; this is not HarfBuzz, Unicode bidi layout, font fallback shaping across runs, or a complete East Asian width implementation.

`TextDocument` adds edit transactions with removed/inserted text and before/after selections. Revisions make dirty-state checks constant-time and allow undo to return to an exact saved checkpoint. Typing coalescing is capped by elapsed time and will not cross the saved revision. Saved text is separately retained for exports/recovery. Saving an earlier snapshot does not mark later concurrent edits as saved.

History is capped at 2,000 edit groups. Insertion buffers remain retained until compaction. `PieceTable.compact()` reconstitutes live text, but this release does not automatically impose an insertion-buffer memory budget. Large, long-lived editing workloads need measurement and a compaction/history-retention policy before deployment at scale.

## WebGPU draw contract

Each submitted instance occupies 48 bytes / 12 float32 values:

| Byte offset | Shader location | Value |
|---|---|---|
| 0 | 0 | `rect`: x, y, width, height in CSS pixels |
| 16 | 1 | `uvRect`: atlas u, v, width, height |
| 32 | 2 | `color`: red, green, blue, alpha |

Six vertex-shader-generated corners form two triangles. A 16-byte uniform stores viewport size and padding. The vertex shader converts CSS-pixel coordinates to clip space; the backing canvas dimensions incorporate device pixel ratio, capped at two.

A fixed 2048 × 2048 RGBA glyph atlas is rasterized using the browser's text rasterizer. White glyph alpha is sampled and tinted in WGSL. ASCII is prewarmed; other graphemes enter the atlas on demand. The atlas is uploaded when dirty. A negative UV x-coordinate marks a solid-color rectangle; the fragment shader then bypasses texture sampling.

The GPU path emits one `draw(6, instanceCount)` for the editor display list. This includes text, selections, cursor, active-line shading, gutter, guides, diagnostic marks, breakpoint indicators, and the sampled minimap. It is **not** a claim that the browser composits all DOM chrome with that same draw call. Buffer capacity grows geometrically; the current draw stream is uploaded with `queue.writeBuffer`.

GPU initialization checks adapter availability, shader compilation messages, and pipeline creation. Device loss selects the Canvas backend. Since one canvas cannot change context types, fallback replaces the canvas element before acquiring the 2D context. Canvas consumes the same display list and caches tinted glyph tiles.

The renderer invalidates on edits, selection/scroll/resize/theme changes, worker results, and focused-caret blinking. Only visible source rows are submitted. Layout caching is bounded to 700 rows; the minimap samples approximately 180 rows. A single exceptionally long line is still laid out as a line and may be costly. Atlas exhaustion substitutes a question-mark glyph; multi-page atlas eviction/growth is a follow-on capability, not silently implemented.

The status time is CPU work from display-list start through submission. It excludes GPU completion, composition, presentation, and input-event queuing. No claim of fixed frame rate or hardware-independent latency is supported by this metric.

## Language services

`TokenCache` carries lexical state across lines and invalidates from the first changed line. It supports multiline comments/strings sufficiently for the included examples, but its language modes are not full syntax trees.

The language worker uses Acorn for JavaScript modules and `JSON.parse` for JSON validation. AST locations provide actual source diagnostics and symbols. Responses carry the source-buffer version; stale versions are ignored. Requests time out and worker errors are surfaced without preventing the editor from initializing. The modular build uses an ES-module worker; the portable build bundles the worker and launches it as a classic Blob worker.

Semantic completion, project-wide name binding, accurate overload lists, language-server refactoring, and project evaluation require a language-service adapter. The present completion popup and definition lookup are explicitly lexical.

## Virtual module loader

Acorn identifies `import`, `export ... from`, and literal dynamic-import source ranges. Replacements are applied from right to left, preserving unrelated strings/comments and source ordering. The resolver normalizes relative paths inside the virtual workspace and rejects path escape, unresolved imports, unsupported module types, and bare/external dependencies.

The browser preview creates an import map from `forge:/path` names to Blob modules. This preserves native browser module caching and cyclic-graph semantics for local modules. HTML is parsed with `DOMParser`, local stylesheet links are inlined, module script entries are rewritten, and a console bridge is installed before document execution.

Worker execution materializes an acyclic dependency graph into Blob URLs. It rejects cycles with an explicit error. This split is intentional: worker import maps are not emulated. Arbitrary computed dynamic imports cannot be rewritten soundly and are rejected.

The included test API registers `test(name, asyncOrSyncFunction)` and provides `assert`, `assert.equal`, `assert.deepEqual`, and `assert.throws`. `deepEqual` uses JSON serialization and therefore is deliberately a JSON-data comparison, not a complete structural comparison of arbitrary JavaScript values.

## Isolation and execution lifetime

Preview and worker-host frames use `sandbox="allow-scripts"` without `allow-same-origin`. They cannot directly access the editor document, its storage, or retained disk handles. Each session has a cryptographically random 192-bit token, and parent message handlers verify both token and source frame.

The runtime CSP defaults to no resources. It explicitly allows inline/blob scripts and inline styles needed by local execution, but rejects network connections, frames, form submissions, and external assets. Script evaluation intentionally needs `unsafe-eval` **inside the isolated execution frame**; the root workbench does not apply this CSP to its own origin.

Console output is capped at 500 messages per session with 8,000-character payloads. Worker execution has a ten-second watchdog, suspended while a trace is paused. Stop removes the session/frame and terminates the worker. This limits accidental hangs in workers; an infinite loop in the interactive web preview can still consume browser resources and may freeze that frame/tab. The browser sandbox is a boundary, not a substitute for only running code you trust or for independent security review.

## Trace semantics

Trace instrumentation parses a standalone JavaScript script, rejects imports/exports, and inserts `await __checkpoint(line, getLocals)` before each top-level non-directive statement. Binding snapshots include top-level variables/functions/classes only after their declaration checkpoint has completed, avoiding reads in the temporal dead zone.

The first checkpoint pauses. Step resumes to the next checkpoint; Continue runs until a selected checkpoint or completion. Source gutter clicks are snapped to a top-level statement. Editing invalidates breakpoints and stops an active trace rather than silently reusing stale offsets.

There is no instruction-level debugger, nested-function stepping, native call stack, arbitrary expression watch, or debug adapter hidden behind these controls.

## Persistence and file-system boundary

The workspace snapshot is stored in IndexedDB database `forge-studio`, version 1, object store `workspaces`, key `current`. Autosave is debounced 650 ms. A failed storage operation emits an actionable error instead of claiming success. The recovery object contains source, saved-state content, baseline map, tab order, selection, scroll, and newline preference. History and live sessions are not persisted.

Folder import is permission-driven. Only explicit Save calls retained `FileSystemFileHandle.createWritable()`. Virtual rename/delete never rename/delete the source disk file. A rename drops the old handle association. Recovery intentionally does not restore disk authority. `Save` captures content and revision for the write and does not treat edits occurring during I/O as part of that saved snapshot.

Backups are validated before replacing the current workspace. Normalized paths prevent directory escape. Limits exist for imported file sizes, counts, and backup content, but they are not an operating-system resource quota for arbitrary edited documents. Multi-tab writer conflict resolution and transaction journals are not implemented; use one active editing tab per origin.

## Extension seams

A native/remote companion can attach genuine Roslyn/MSBuild/LSP/DAP services without replacing the text model or viewport. Such a companion should use an authenticated, explicitly authorized protocol and keep filesystem capabilities out of untrusted preview contexts. Project evaluation, language analysis, build execution, debugger events, and terminal streams should be separate services rather than expanding `Runtime` into a privileged catch-all.

For renderer expansion, preserve the primitive contract while replacing the atlas with paged eviction, adding shaping/cell mapping, and instrumenting actual GPU timestamp measurements where supported. For document scale, add memory-budgeted compaction, chunked lexical scanning, pathological-line handling, and project-wide background search before making new performance claims.

## Primary API references

- WebGPU specification: https://www.w3.org/TR/webgpu/
- WebGPU canvas configuration: https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure
- Browser GPU entry point and secure contexts: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/gpu
- Sandboxed srcdoc frames: https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc
- Acorn parser and license: https://github.com/acornjs/acorn
- Visual Studio Solution Explorer interaction reference: https://learn.microsoft.com/en-us/visualstudio/ide/use-solution-explorer
