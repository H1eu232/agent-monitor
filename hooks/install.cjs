#!/usr/bin/env node
/**
 * install.cjs - register the agent-monitor hooks in ~/.claude/settings.json:
 *   ledger.cjs       SessionStart, UserPromptSubmit, Stop
 *   usage-cache.cjs  UserPromptSubmit, Stop (account 5h usage; idle until the Claude Code CLI is logged in)
 *
 *   node hooks/install.cjs              add the hooks (backs up settings.json first)
 *   node hooks/install.cjs --dry-run    print the resulting hooks block, change nothing
 *   node hooks/install.cjs --uninstall  remove them again
 *
 * Idempotent; leaves every other setting and hook untouched.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(ROOT, 'settings.json');
// script -> events it runs on
const SCRIPTS = {
  'ledger.cjs': ['SessionStart', 'UserPromptSubmit', 'Stop'],
  'usage-cache.cjs': ['UserPromptSubmit', 'Stop'],
};
const EVENTS = [...new Set(Object.values(SCRIPTS).flat())];
// Forward slashes work in both Git Bash and cmd, which Claude Code may use to run hooks on Windows.
const command = (script) => `node "${path.join(__dirname, script).split(path.sep).join('/')}"`;
const ours = (h) => h && typeof h.command === 'string' && h.command.includes('agent-monitor')
  && Object.keys(SCRIPTS).some((s) => h.command.includes(s));

const dry = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

let raw = '';
try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (_) { /* no settings yet */ }
let settings;
try { settings = raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
  console.error(`${SETTINGS} is not valid JSON (${e.message}); fix it first, nothing changed.`);
  process.exit(1);
}

const hooks = settings.hooks || {};
for (const ev of EVENTS) {
  // Drop any earlier copy of our hook, then add it back once (unless uninstalling).
  const groups = (hooks[ev] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
    .filter((g) => g.hooks.length);
  if (!uninstall) {
    for (const [script, events] of Object.entries(SCRIPTS)) {
      if (events.includes(ev)) groups.push({ hooks: [{ type: 'command', command: command(script), timeout: 10 }] });
    }
  }
  if (groups.length) hooks[ev] = groups; else delete hooks[ev];
}
if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;

if (dry) {
  console.log(JSON.stringify({ hooks: settings.hooks || {} }, null, 2));
  process.exit(0);
}
if (raw) {
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.writeFileSync(backup, raw);
  console.log(`backup: ${backup}`);
}
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`${uninstall ? 'removed' : 'installed'} agent-monitor hooks in ${SETTINGS}`);
if (!uninstall) console.log('New Claude Code sessions will write ~/.claude/harness/; restart open ones to pick it up.');
