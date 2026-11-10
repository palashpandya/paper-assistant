# Paper Assistant

A local LaTeX editor where you and an AI agent work on the same paper: source, live PDF and agent chat side by side.

The agent is the [Claude Code](https://claude.com/claude-code) or Codex CLI running under your own login, so it uses the subscription you already have and needs no API key.

## Requirements

- Node.js 22 or newer
- A TeX distribution with `pdflatex` and `synctex` (`latexmk` is used when installed)
- At least one agent CLI, installed and logged in: `claude` (Claude Code) or `codex`

## Install and run

```sh
npm install -g /path/to/paper-assistant      # or the packed .tgz, or a git URL
cd /path/to/your/paper
paper-assistant
```

This opens the paper in your browser. Options: `paper-assistant [folder] [--port <number>] [--no-open]`. If the port is taken, for example because another paper is open, the next free one is used.

From a checkout without installing: `npm install`, then `npm start -- /path/to/your/paper` (try `examples/sample`).

## What it does

- **Edit and build:** changes save automatically and the PDF rebuilds and refreshes in place.
- **Jump between source and PDF:** Ctrl+click in the PDF goes to the source line; "Show in PDF" (Alt+Enter) highlights the current line in the PDF.
- **Agent chat:** the agent edits the project files directly. Its edits appear in the editor as a diff, with Accept and Reject per change or for the whole file. Choose Claude Code or Codex in the agent pane.
- **Point at a passage:** select text in the PDF and click "Ask agent", or select text in the editor; the selection and its source location are attached to your next message.
- **Comments on the PDF:** select text in the PDF and choose Comment. Each comment is a thread you and the agent can reply in, with Resolve and Reopen. "Send to agent" hands over one comment, "Send all" every open one; the agent's answer is filed in the thread and it can mark the comment resolved.
- **Drawing on the PDF:** switch on Draw, mark up the page, and add a note. The agent receives a picture of the marked-up region and the source lines underneath it.
- **Comments follow the text:** when the PDF changes, comments and drawings move with the source line they point at. If that text is gone they are flagged as moved.
- **Typeset math in chat:** agent replies render Markdown and math. LaTeX you type in a message (`\rho_{ij}`, `$...$`, `$$...$$`) is typeset in a live preview above the input; the agent still receives the source you typed.
- **Layouts:** five pane arrangements in the top bar, all panes resizable, and a toggle for the file list. The choice is remembered per browser.
- **Build errors:** click the build status for errors and warnings, jump to the offending line, or hand them to the agent with "Fix with agent".

## How it works

- `server/` is a small Node server. It watches the project folder, runs LaTeX, answers SyncTeX lookups, and starts the agent CLI in the project folder for each chat turn.
  - Claude Code runs with `claude -p` and may only read, search and edit files; it cannot run shell commands.
  - Codex runs with `codex exec` in its own `workspace-write` sandbox, so it can run commands but only write inside the project folder.
- `src/` is the React front end: CodeMirror for the editor and diff review, PDF.js for the preview, KaTeX for math.
- Comments and drawings are stored in the paper's folder under `.paper-assistant/` (`annotations.json` plus one PNG per drawing), so they can be committed with the paper or ignored.
- The server only listens on `127.0.0.1` and rejects requests from other origins.
- LaTeX build files are written next to the main `.tex` file, as with a normal local build.

## Development

`npm run dev` starts the server and Vite with hot reload at http://localhost:5173 (set `PAPER=/path/to/paper` to use a different project). `npm run build` produces `dist/` (front end) and `dist-server/` (server), which is what the `paper-assistant` command runs.

## Not built yet

Creating or renaming files from the UI, a dark theme, and several people working on one paper at once.
