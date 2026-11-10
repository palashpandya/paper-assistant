# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local web app for writing LaTeX papers with an AI agent: editor, live PDF preview and agent chat on the same files. The agent is the user's own Claude Code or Codex CLI, spawned headlessly by the server. A hard product constraint: it must run on the user's existing CLI subscription login. Do not introduce API-key-based agent code or hosted/multi-tenant designs.

## Commands

```sh
npm run dev                      # server (node --watch) + Vite at http://localhost:5173, on examples/sample
PAPER=/path/to/paper npm run dev # same, on another project
npm run build                    # vite build -> dist/, tsc -> dist-server/
npm start -- <folder> [--port N] [--no-open]   # run the built app (bin/paper-assistant.js)
npm run typecheck                # front end and server tsconfigs
npm run release                  # build and pack release/paper-assistant-<version>.tgz
```

There is no test suite and no linter. `npm run typecheck` is the only static check. UI changes have been verified by driving the built app in headless Chrome (`puppeteer-core` with `/usr/bin/google-chrome`, kept outside the repo) against a scratch copy of `examples/sample` on a spare port with `--no-open`. Do not test against the user's real paper folders; builds and agent turns write into the project.

Users install the release tarball with `npm install -g ./paper-assistant-<version>.tgz`. It ships `dist/` and `dist-server/` prebuilt, so only what the server imports at run time (`express`, `ws`, `chokidar`) belongs in `dependencies`; everything the browser uses is bundled by Vite and stays in `devDependencies`.

`npm start` serves `dist/` and runs `dist-server/`, so rebuild after changes. `prepare` runs the build, so `npm install` and `npm pack` build too.

## Server (`server/`)

Written in TypeScript and run two ways: directly by Node's type stripping in dev (`node server/index.ts`), and compiled by `tsc` to `dist-server/` for the installed command (Node refuses to strip types under `node_modules`). Consequences:

- Only erasable TypeScript syntax: no constructor parameter properties, enums or namespaces (`erasableSyntaxOnly` enforces this).
- Relative imports use the `.ts` extension; the build rewrites them.

`index.ts` wires everything: Express API under `/api`, a WebSocket at `/ws` that broadcasts state changes, and a chokidar watcher. It binds to `127.0.0.1` and rejects non-local `Host`/`Origin` headers; keep that check on any new route or socket.

- **`project.ts`** tracks text files with three maps: `known` (last content seen on disk), `baseline` (content the user has reviewed) and `clientWrites` (last save from the browser, so the watcher can skip its echo). A file is "pending review" when `known !== baseline`. Saves from the editor advance the baseline unless a review is already pending; edits from anywhere else (the agent) do not. This is what drives the accept/reject diff.
- **`compiler.ts`** builds with `latexmk` if installed, otherwise its own `pdflatex`/`bibtex`/`biber` loop. Build output goes next to the main `.tex` file. It passes `-recorder` and reads `<job>.fls` to learn which files LaTeX itself wrote (`generated`).
- **Rebuild loop guard:** file events that arrive during a build are deferred until it finishes, then dropped if the path is in `compiler.generated`. Without this, classes that write source-like files on every run (REVTeX's `<job>Notes.bib`) cause endless rebuilds. Preserve this when touching the watcher.
- **`agent.ts`** defines one `Backend` per CLI (args, optional preamble, JSON-line parser) and an `Agents` class that runs one process per chat turn and resumes each CLI's own session. Claude Code is limited to `Read, Edit, Write, Glob, Grep` with `--permission-mode acceptEdits`; Codex runs `codex exec --json` with the `workspace-write` sandbox. The shared `INSTRUCTIONS` text tells agents not to run LaTeX and how to format replies.
- **`chats.ts`** saves agent conversations in `.paper-assistant/chats.json`: the messages as the chat shows them (built from the same `AgentEvent` stream the browser gets) and each CLI's session id. The agents' actual memory is in the CLIs' own session stores; opening a saved conversation calls `Agents.restore()` so the next turn runs with `--resume`. The browser loads the current conversation from `/api/chat` on every (re)connect. `cliHistory.ts` reads the CLIs' own session stores for the project folder (Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<path with - for non-alphanumerics>/*.jsonl`; Codex: `~/.codex/sessions/**/rollout-*.jsonl`, filtered by `cwd`), so sessions held outside the app appear in History as `cli:<agent>:<session id>`. The folders searched are the paper's and its ancestors up to the git root (`scope()`), since both CLIs can resume a session recorded against an enclosing folder. `/api/chats` is paged (`offset`, `limit`, `next`) because titles are read out of the session files lazily; opening one copies its transcript into a saved chat (`adopt`). These are undocumented formats: keep that code read-only and tolerant of lines it does not understand.
- **`settings.ts`** holds the per-paper choice of Claude Code login (`.paper-assistant/settings.json`) and detects the logins on the machine: the default `~/.claude` and any `~/.claude-*` config folder. `Agents` runs `claude` with `CLAUDE_CONFIG_DIR` set to the chosen folder, or unset for the default (pointing it at `~/.claude` would move where Claude Code looks for its login file). Sessions belong to a login, so `cliHistory.ts` reads that login's store, each saved chat records the login of its Claude session (`claudeConfig`), and `Chats.resumable()` withholds sessions of another login.
- **`annotations.ts`** stores PDF comment/drawing threads in the paper folder under `.paper-assistant/` (`annotations.json`, one PNG per drawing). Each thread has a SyncTeX anchor (source path, line, line text, PDF box). `views()` re-anchors on every build: it re-finds the line by its text, asks SyncTeX where it now is, and returns a page plus `dx/dy` offset, or `stale`. `prompt()` builds the agent message for a set of threads; `applyReply()` parses the agent's `#<id>: ... [resolved]` lines back into threads. The prompt format and the parser must stay in sync. Agents make their own threads (`author: 'agent'`) by writing `.paper-assistant/agent-notes.json`, a list of `{file, line, endLine?, quote?, text, mark?}`; `collectAgentNotes()` turns each into a thread whose rects (highlight) or outline stroke (box, circle) come from SyncTeX forward search on those source lines, then deletes the file. Agents never deal in PDF coordinates. `index.ts` calls it after every agent turn, once any build of the agent's edits has finished. The format is described to agents in `INSTRUCTIONS` in `agent.ts`; keep the two in sync.
- **`synctex.ts`** wraps the `synctex` CLI. All PDF coordinates everywhere are PDF points from the page's top-left.

## Front end (`src/`)

React + Vite. `App.tsx` owns all state and the WebSocket handler; `api.ts` has the typed fetch client and message types, which mirror the server's shapes by hand (update both sides together).

- **Layout:** the editor, PDF and agent panes are always the same three sibling grid cells; presets in `layout.ts` only change their grid placement, so switching layouts never remounts a pane. Keep it that way, since the editor and PDF hold imperative state.
- **`Editor.tsx`:** one CodeMirror view created once, driven through refs. `doc.version` bumps mean content arrived from outside (file load or agent edit); those transactions carry the `External` annotation so they are not saved back. Review mode is `@codemirror/merge`'s `unifiedMergeView` in a compartment, with the baseline as the original; accepting a chunk changes the original (reported via `onBaseline`), rejecting changes the document (saved like a normal edit).
- **`latexComplete.ts`:** the editor's completion source, attached to the LaTeX language as `autocomplete` language data. It decides from the text before the cursor what is wanted: a command after an odd number of backslashes (built-in lists in that file plus the paper's macros), or the contents of a known command's argument (`argKind()`: labels, citation keys, environments, packages, classes, files). The paper's own names come from `/api/symbols` (`server/symbols.ts`, a regex scan of the tracked files, re-fetched at most every 2 s) and the installed packages from `/api/tex-installed` (read once from the TeX tree's `ls-R` indexes found by `kpsewhich`, with a built-in fallback list). The `Symbols` shape is mirrored in `api.ts`.
- **`PdfView.tsx`:** pages are managed imperatively (PDF.js canvas + text layer per page, rendered lazily, swapped in place so rebuilds do not flicker or lose scroll). Annotations are drawn as an SVG overlay per page with a viewBox in PDF points. `pdfjs-dist` is pinned to v4 because the text layer relies on the `--scale-factor` CSS variable.
- **PDF in a separate tab:** `/?view=pdf` renders `PdfTab.tsx` (a `PdfView` with its own socket) instead of `App`. The two windows talk over a `BroadcastChannel` (`tabChannel.ts`, message types in `TabMsg`); the server is not involved. The main window is "detached" while a PDF tab answers `ping` with `hello`; its own `PdfView` then stays mounted but hidden with `version` 0, and the layout preset is used with the PDF pane filtered out (sizes saved under `<preset>/no-pdf`). The PDF tab does its own SyncTeX lookups and annotation saves and only forwards what the editor and agent panes need.
- **`Markdown.tsx`:** chat rendering with `react-markdown` + KaTeX. For user text, `autoMath` wraps bare LaTeX that KaTeX can parse in `$...$`; the agent always receives the raw text.
- **Themes:** `themes.css` holds one block of CSS variables per theme, selected by `data-theme` on `<html>` (`themes.ts` lists them). All UI and editor colours, including CodeMirror syntax colours (`--syn-*`), must come from these variables; the only hard-coded colours are those drawn on the white PDF pages. PDF night mode is a CSS filter on the page canvas only, so annotation overlays and the snapshots sent to agents stay uninverted. Adding a theme means one new block plus an entry in `THEMES`.
- UI preferences (theme, layout, sizes, sidebar, chosen agent) go through `load`/`save` in `layout.ts` (guarded `localStorage`).
