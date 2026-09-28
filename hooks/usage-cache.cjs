#!/usr/bin/env node
/**
 * usage-cache.cjs - Claude Code hook that caches the account's 5h usage for agent-monitor.
 *
 * Writes $TMPDIR/ck-usage-limits-cache.json in the shape lib/usage-local.cjs reads:
 *   { status: 'available', timestamp: <ms>, data: { five_hour: { utilization, resets_at }, seven_day, ... } }
 *
 * The OAuth token comes from the Claude Code CLI's own login (~/.claude/.credentials.json); it is sent
 * only to api.anthropic.com and never printed or stored elsewhere. Without that file the hook does nothing.
 * The hook itself returns at once: when the cache is older than a minute it starts a detached
 * copy of this script (`--fetch`) to refresh it. Never blocks Claude: prints nothing and always exits 0.
 *
 * `api/oauth/usage` is the endpoint Claude Code uses for /usage; it is not a documented API and may change.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const CREDENTIALS = path.join(ROOT, '.credentials.json');
const CACHE = process.env.USAGE_CACHE || path.join(os.tmpdir(), 'ck-usage-limits-cache.json');
const LOCK = `${CACHE}.lock`;
const EVERY_MS = 60000;
const TIMEOUT_MS = 8000;

const age = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch (_) { return Infinity; } };

function token() {
  try {
    const o = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')).claudeAiOauth || {};
    // An expired token is left for the CLI to refresh; refreshing here would rotate the CLI's login.
    if (!o.accessToken || (o.expiresAt && o.expiresAt < Date.now())) return null;
    return o.accessToken;
  } catch (_) { return null; }
}

function writeCache(data) {
  const tmp = `${CACHE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ status: 'available', timestamp: Date.now(), data }));
  fs.renameSync(tmp, CACHE);
}

/** GET api/oauth/usage; resolves the parsed body, or null on any failure. */
function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET', timeout: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function refresh() {
  const t = token();
  if (!t) return;
  const data = await fetchUsage(t);
  if (data && data.five_hour) writeCache(data);
}

if (process.argv.includes('--fetch')) {
  refresh().catch(() => {}).finally(() => process.exit(0));
} else {
  // Hook mode: drain stdin, and start a refresh only when due and not already running.
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    try {
      if (age(CACHE) >= EVERY_MS && age(LOCK) >= EVERY_MS && fs.existsSync(CREDENTIALS)) {
        fs.writeFileSync(LOCK, String(process.pid));
        spawn(process.execPath, [__filename, '--fetch'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch (_) { /* never block Claude */ }
    process.exit(0);
  });
}
