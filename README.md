# Paper Assistant

A local LaTeX editor with live PDF preview and an AI agent working on the same files. Uses your own Claude Code or Codex CLI login; no separate API key is needed.

## Features

- **Write and preview:** autosave, automatic LaTeX builds, command/citation/reference completion, and source ↔ PDF navigation.
- **Work with an agent:** chat with Claude Code or Codex, choose model and effort, and review file edits with Accept/Reject diffs. Conversations persist across restarts.
- **Review on the PDF:** select passages, add comment threads or drawings, and send them to the agent. Agents can also leave comments.
- **Arrange your workspace:** resizable layouts, themes, PDF night mode, and a detachable PDF tab for a second screen.
- **Keep edits safe:** concurrent editor and disk changes are merged; conflicting edits preserve both versions for manual resolution.

## Requirements

- **Node.js 22.18+** (Node.js 24 recommended), with npm.
- A TeX distribution providing `pdflatex` and `synctex`, plus the packages your paper uses. `latexmk` is recommended; bibliography builds may also need `bibtex` or `biber`.
- For AI features: **Claude Code or Codex CLI**, installed, available on `PATH`, and logged in. Check that your chosen CLI works in a terminal first.

## Install and run

Download **`paper-assistant-0.1.0.tgz`** from the [latest release](https://github.com/palashpandya/paper-assistant/releases/latest). Choose this prebuilt asset rather than GitHub's source-code archives. Then run:

```sh
npm install -g ./paper-assistant-0.1.0.tgz
cd /path/to/your/paper
paper-assistant
```

The app opens in your browser and runs in the background. Open a folder containing your LaTeX project; `main.tex` is preferred when several documents are found. Select your agent in the agent pane, edit some text, and check that the PDF rebuilds. Ctrl+click the PDF to jump to source; Alt+Enter in the editor shows the source line in the PDF.

```sh
paper-assistant list                    # open papers and their addresses
paper-assistant stop                    # close the paper in the current folder
paper-assistant stop --all              # close every running paper
paper-assistant /path/to/paper --foreground  # stay in the terminal; Ctrl+C to stop
```

The **Quit** button also stops the app. Use `--port 4317` to choose a port, `--no-open` to skip opening a browser, or `--help` for usage. If a port is occupied, the app tries the next one.

To update, install the newer release asset the same way. To uninstall: `npm uninstall -g paper-assistant`.

## Testing and troubleshooting

- Start with a copy of a paper: the editor and agent write directly to its files, and LaTeX outputs are written beside the main document.
- Test editing → PDF rebuild, source/PDF navigation, an agent edit → Accept/Reject, and a PDF comment → Send to agent.
- If compilation fails, click the build status for errors and check that TeX tools are on `PATH`. If chat fails, verify the CLI login in a terminal and try the default model/effort settings.
- Background logs are in `~/.paper-assistant/logs/`. If global npm installation gives a permissions error, use a Node version manager or a writable npm prefix on your `PATH`.
- Report problems in [Issues](https://github.com/palashpandya/paper-assistant/issues), including your OS, Node version, app version (`paper-assistant --version`), agent CLI version, and steps to reproduce. Remove private paper text or credentials from logs before sharing.

The server listens on `127.0.0.1`. Comments, drawings and chat are stored in `.paper-assistant/` inside the paper folder; AI requests run through your chosen CLI. This is a local, single-user app. File creation/renaming in the UI and simultaneous multi-user editing are not supported yet.

See the [usage guide](docs/usage.md) for detailed controls and behavior.

## Development and releases

```sh
git clone https://github.com/palashpandya/paper-assistant.git
cd paper-assistant
npm ci
npm start -- examples/sample
```

`npm run dev` enables hot reload; set `PAPER=/path/to/paper` for another project. Run `npm run typecheck`, `npm test`, and `npm run test:browser` before releasing. Browser tests require Chrome (`CHROME_BIN` overrides `/usr/bin/google-chrome`); tests use temporary projects and fake agents/builders.

`prod` is the protected release branch; submit changes through a pull request with passing **Build and test** checks. `main` remains the default branch. To package a release, update the version in `package.json` and `package-lock.json`, then run `npm ci` and `npm run release`. Publish the resulting `release/paper-assistant-<version>.tgz` on a GitHub release tagged at the tested `prod` commit.
