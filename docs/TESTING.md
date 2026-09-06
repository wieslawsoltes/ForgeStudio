# Validation record

Validation performed on 2026-09-06. The files in this directory are output from executed tests, not sample/placeholder reports.

## Results

| Layer | Result | Evidence |
|---|---|---|
| Text model, history, lexer, workspace, modules, tracing, ZIP | 19 / 19 passed | `core-test-results.txt` |
| Browser integration, portable bundle | 28 / 28 passed | `browser-test-results.json` |
| Bundled Nebula JavaScript tests inside runtime | 7 / 7 passed | Browser test record and screenshots |
| Uncaught browser exceptions in integration run | 0 | Final browser integration assertion |
| WebGPU hardware execution | Not exercised | No secure origin / GPU API in the permitted offline harness |
| IndexedDB reload recovery | Not exercised in browser | Opaque-origin storage was unavailable; workspace serialization was tested |
| Native file picker / directory handle writes | Not exercised | Requires interactive browser permission |
| Cross-browser screen readers and OS IME | Not exercised | Event paths are implemented; interoperability remains to be verified |

The raw timing fields are individual test durations and CPU observations, not benchmarks. The 100,000-line test verifies buffer correctness and indexing after an insertion; it does not establish end-to-end rendering performance for all document shapes.

## Core suite

```sh
node --test tests/*.test.js
# or: npm test
```

Node 22.16.0 was used. Core tests need no npm packages. The randomized reference-model test performs 4,000 UTF-16 edits and checks reconstructed text, line counts, line lookup, positions, and treap subtree/heap invariants. Revision tests cover save barriers, undo to a saved checkpoint, invalid-edit atomicity, and in-flight save snapshots.

## Browser integration suite

Install test tooling separately from the application:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
node tools/build-standalone.mjs
python3 tests/browser_e2e.py
```

The test defaults to offline DOM injection of the standalone HTML. This mode is useful for testing the bundle and fallback on an opaque origin, but cannot validate secure-context APIs or origin-bound persistence.

Select a locally installed browser with `CHROMIUM_PATH`. The recorded run used `/usr/bin/chromium`; the exact browser version is in the JSON report.

For a normal served-origin run, start the app, then use:

```sh
FORGE_URL=http://localhost:8080 python3 tests/browser_e2e.py
```

The integration suite checks actual keyboard input, selection and edit history, pair insertion/deletion, grapheme deletion, find/replace, native accessible editing, completion popup, parser errors and recovery, script output, quick-open, trace checkpoints/locals, test modules, exported ZIPs using Python's independent ZIP reader, workspace backups, preview input, stop/lifetime cleanup, and theme changes. It saves dark, light, and split-preview screenshots.

For deterministic runs, use a fresh browser context and the bundled sample workspace. The suite creates and deletes `scratch.js` in the test context. It exports temporary files under `docs/` and removes them after validation.

## Remaining release verification

Before wider deployment, run on a real HTTPS/localhost origin with the target browsers and GPUs. Confirm the `WebGPU` badge, inspect shader/device errors, switch themes and DPI, exercise device loss/fallback, and profile long lines and sustained edits. Separately test quota failure/recovery, multiple tabs, clipboard permissions, local-folder write permissions, Safari/Firefox/Chromium input behavior, real IME composition, and screen-reader operation in native mode.

This package deliberately does not label these unexecuted checks as passed.
