// Adds (or removes) Claude Code hooks that report activity to Notch Buddy.
// Usage: node scripts/install-hooks.js            -> install
//        node scripts/install-hooks.js --uninstall -> remove
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 47321;
const MARKER = `127.0.0.1:${PORT}/hook`;
// One command that works whether Claude Code runs hooks through cmd, PowerShell or Git Bash:
// no shell-specific redirects, and `curl.exe` (built into Windows 10+) so PowerShell's `curl`
// alias isn't picked up. The island answers with an empty body, so nothing is printed.
const COMMAND = process.platform === 'win32'
  ? `curl.exe -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- http://${MARKER}`
  : `curl -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- http://${MARKER} >/dev/null 2>&1 || true`;
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function isOurs(group) {
  return Array.isArray(group && group.hooks) && group.hooks.some(h => typeof h.command === 'string' && h.command.includes(MARKER));
}

const isCurrent = g => isOurs(g) && g.hooks.some(h => h.command === COMMAND);
function status() {
  try {
    const hooks = readSettings(settingsPath()).hooks || {};
    return EVENTS.every(e => Array.isArray(hooks[e]) && hooks[e].some(isCurrent));
  } catch {
    return false;
  }
}
// installed by an older version with a different command?
function outdated() {
  try {
    const hooks = readSettings(settingsPath()).hooks || {};
    const any = EVENTS.some(e => Array.isArray(hooks[e]) && hooks[e].some(isOurs));
    return any && !status();
  } catch { return false; }
}

function apply(uninstall = false) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readSettings(file);
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-island');
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    const kept = (settings.hooks[ev] || []).filter(g => !isOurs(g));
    if (!uninstall) {
      const group = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
      if (TOOL_EVENTS.has(ev)) group.matcher = '*';
      kept.push(group);
    }
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

module.exports = { install: () => apply(false), uninstall: () => apply(true), status, outdated, COMMAND, settingsPath };

if (require.main === module) {
  const un = process.argv.includes('--uninstall');
  try {
    const file = apply(un);
    console.log(`${un ? 'Removed' : 'Installed'} Notch Buddy hooks in ${file}`);
    if (!un) console.log('Restart any running Claude Code sessions to pick them up.');
  } catch (e) {
    console.error('Could not update settings.json:', e.message);
    process.exit(1);
  }
}
