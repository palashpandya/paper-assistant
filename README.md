# Paper Assistant

A local LaTeX editor where you and an AI agent work on the same paper: source, live PDF and agent chat side by side.

The agent is the [Claude Code](https://claude.com/claude-code) or Codex CLI running under your own login, so it uses the subscription you already have and needs no API key.

## Requirements

- Node.js 22 or newer
- A TeX distribution with `pdflatex` and `synctex` (`latexmk` is used when installed)
- At least one agent CLI, installed and logged in: `claude` (Claude Code) or `codex`

## Install and run

Install from the release file, `paper-assistant-<version>.tgz`. It is already built, so this takes a few seconds:

```sh
npm install -g ./paper-assistant-0.1.0.tgz     # a downloaded file: keep the ./ or give the full path
```

That puts the `paper-assistant` command on your path. Then, in any paper's folder:

```sh
cd /path/to/your/paper
paper-assistant
```

This opens the paper in your browser. Options: `paper-assistant [folder] [--port <number>] [--no-open] [--version]`. If the port is taken, for example because another paper is open, the next free one is used. On starting, it says so if `pdflatex`, `synctex` or an agent CLI is missing.

To update, install the newer file the same way. To remove it: `npm uninstall -g paper-assistant`.

If `npm install -g` fails with a permissions error, your Node installation keeps global packages in a system folder; use a Node version manager such as `nvm`, or set a prefix you own with `npm config set prefix ~/.local`.

### From source

`npm install -g github:palashpandya/paper-assistant` installs straight from the repository, for those with access to it, building as it goes. From a checkout without installing: `npm install`, then `npm start -- /path/to/your/paper` (try `examples/sample`).

To make a release file: set the version in `package.json`, then `npm run release`, which builds and writes `release/paper-assistant-<version>.tgz`.

## What it does

- **Edit and build:** changes save automatically and the PDF rebuilds and refreshes in place.
- **Completion while you type:** a backslash offers LaTeX commands and symbols (with the symbol shown), plus the macros your paper defines; commands with arguments are filled in with places to Tab between. `\ref{` and its relatives offer the paper's labels, `\cite{` its citation keys (searchable by author, year and title), `\begin{` environments with the matching `\end`, `\usepackage{` the packages in your TeX installation, and `\input{` and `\includegraphics{` the paper's files. Enter accepts a suggestion, Escape dismisses it, Ctrl+Space asks for one. Typing `$` adds the closing `$` as brackets do (a second `$` makes `$$ $$`), and wraps the selection when there is one.
- **Jump between source and PDF:** Ctrl+click in the PDF goes to the source line; "Show in PDF" (Alt+Enter) highlights the current line in the PDF.
- **Agent chat:** the agent edits the project files directly. Its edits appear in the editor as a diff, with Accept and Reject per change or for the whole file. Choose Claude Code or Codex in the agent pane.
- **Point at a passage:** select text in the PDF and click "Ask agent", or select text in the editor; the selection and its source location are attached to your next message.
- **Conversations are kept:** the chat with the agent is saved with the paper, so reloading the page or restarting the app carries on where you were. The clock button in the agent pane lists earlier conversations; pick one to continue it, with the agent remembering what was said. The list also includes sessions you held with Claude Code or Codex outside the app, for example in a terminal, in the paper's folder or in the folders around it up to the top of its git repository; more load as you scroll, and the switch at the top narrows the list to one agent's conversations. The plus button starts a new one. Removing an entry only takes it off the list; the CLI's own record of the session is left alone.
- **Several Claude Code logins:** if you keep more than one Claude Code login on the machine (the default `~/.claude` plus folders such as `~/.claude-work` used through `CLAUDE_CONFIG_DIR`), a chooser appears in the top bar. The agent runs under the login you pick and History shows that login's conversations. The choice is remembered per paper; until you make one, the app uses the login it was started under.
- **Comments on the PDF:** select text in the PDF and choose Comment. Each comment is a thread you and the agent can reply in, with Resolve and Reopen. "Send to agent" hands over one comment, "Send all" every open one; the agent's answer is filed in the thread and it can mark the comment resolved.
- **Drawing on the PDF:** switch on Draw, mark up the page, and add a note. The agent receives a picture of the marked-up region and the source lines underneath it.
- **Comments from the agent:** ask the agent to review the paper or point things out, and it leaves its own comments on the PDF: highlighted lines, or a box or circle drawn around them, in blue. They are threads like yours, so you can reply, send them back to the agent to act on, resolve or delete them. The agent points at source lines, so its marks cover whole typeset lines rather than single words.
- **Comments follow the text:** when the PDF changes, comments and drawings move with the source line they point at. If that text is gone they are flagged as moved.
- **Typeset math in chat:** agent replies render Markdown and math. LaTeX you type in a message (`\rho_{ij}`, `$...$`, `$$...$$`) is typeset in a live preview above the input; the agent still receives the source you typed.
- **Layouts:** five pane arrangements in the top bar, all panes resizable, and a toggle for the file list. The choice is remembered per browser.
- **PDF in its own tab:** the arrow button at the right of the PDF bar moves the PDF to a separate browser tab, which you can drag to another window or screen. Jumping between source and PDF, Ask agent, comments and drawings work across the two; "Dock PDF" in the top bar, or closing the tab, brings it back.
- **Themes:** Paper (light), Solarized Light, Solarized Dark, Dracula, Nord and Gruvbox Dark, chosen in the top bar and remembered per browser. The PDF pages stay as LaTeX rendered them unless you switch on Night in the PDF bar, which inverts their colours on screen.
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

Creating or renaming files from the UI, and several people working on one paper at once.
