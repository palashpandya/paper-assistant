import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A Claude Code login. Claude Code keeps each login, with its sessions, in a config
 * folder: ~/.claude by default, or wherever CLAUDE_CONFIG_DIR points. `dir` is null
 * for the default, which must be selected by leaving the variable unset: setting it
 * to ~/.claude makes Claude Code look for its login file in a different place.
 */
export interface ClaudeAccount {
  dir: string | null;
  /** The folder, as the user would write it. */
  folder: string;
  /** Who is logged in there, when Claude Code has recorded it. */
  email: string | null;
}

const home = os.homedir();
const tilde = (p: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);

function emailIn(file: string): string | null {
  try {
    const email = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount?.emailAddress;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}

/** The Claude Code logins found on this machine: the default one and any ~/.claude-* folder that looks like one. */
export function claudeAccounts(): ClaudeAccount[] {
  const accounts: ClaudeAccount[] = [{ dir: null, folder: '~/.claude', email: emailIn(path.join(home, '.claude.json')) }];
  const dirs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  try {
    for (const name of fs.readdirSync(home)) {
      if (/^\.claude[-_.]./.test(name) && fs.statSync(path.join(home, name)).isDirectory()) dirs.add(path.join(home, name));
    }
  } catch {
    // Home is unreadable; the default and the environment's are all we know.
  }
  for (const dir of [...dirs].sort()) {
    if (dir === path.join(home, '.claude')) continue;
    const login = path.join(dir, '.claude.json');
    if (!fs.existsSync(login) && !fs.existsSync(path.join(dir, 'projects'))) continue;
    accounts.push({ dir, folder: tilde(dir), email: emailIn(login) });
  }
  return accounts;
}

/** Per-paper settings, kept in the paper folder under .paper-assistant/settings.json. */
export class Settings {
  /** Config folder of the Claude Code login to use; null is the default login. */
  claudeConfig: string | null;
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, '.paper-assistant', 'settings.json');
    // Until one is chosen for this paper, use the login the app was started under.
    const fromEnv = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
    this.claudeConfig = fromEnv === path.join(home, '.claude') ? null : fromEnv;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if ('claudeConfig' in saved && claudeAccounts().some((a) => a.dir === saved.claudeConfig)) this.claudeConfig = saved.claudeConfig;
    } catch {
      // Nothing saved for this paper.
    }
  }

  setClaudeConfig(dir: string | null) {
    if (!claudeAccounts().some((a) => a.dir === dir)) throw new Error('Not a Claude Code login on this machine');
    this.claudeConfig = dir;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ claudeConfig: dir }, null, 2));
  }

  /** The folder Claude Code keeps this login's sessions in. */
  claudeDir(): string {
    return this.claudeConfig ?? path.join(home, '.claude');
  }
}
