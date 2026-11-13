// "Ask Claude" bridge: runs the user's own Claude Code CLI in print mode (`claude -p`),
// so answers use whatever account/plan Claude Code is signed into. No API key involved.
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const SYSTEM = [
  'You are a friendly assistant living inside a small desktop widget called Notch Buddy.',
  'Keep answers short and scannable: usually under 120 words, plain sentences, at most a few bullets.',
  'Use code blocks only for code. If the user shares clipboard text, focus on it.'
].join(' ');

const ASK_TOOLS_OFF = 'Bash,Edit,Write,MultiEdit,NotebookEdit,Task';

class Asker {
  constructor({ workDir, onUpdate, log }) {
    this.workDir = workDir;
    this.onUpdate = onUpdate;
    this.log = log || (() => {});
    this.sessionId = null;          // conversation to resume
    this.ownSessions = new Set();   // so hook events from these runs are ignored
    this.proc = null;
    this.bin = null;
    this.features = { partial: true, sessionId: true, settings: true };
    fs.mkdirSync(workDir, { recursive: true });
    this.settingsFile = path.join(workDir, 'ask-settings.json');
    try { fs.writeFileSync(this.settingsFile, JSON.stringify({ disableAllHooks: true })); } catch {}
  }

  isOwnSession(id) { return !!id && this.ownSessions.has(id); }

  reset() { this.cancel(); this.sessionId = null; }

  cancel() {
    if (this.proc) {
      this.proc._cancelled = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], { windowsHide: true });
        else this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }

  // Locate the claude executable once (PATH first, then common install spots).
  findBinary() {
    if (this.bin) return Promise.resolve(this.bin);
    const home = os.homedir();
    const candidates = process.platform === 'win32'
      ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
         path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe')]
      : [path.join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
    return new Promise(resolve => {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      execFile(finder, ['claude'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        const found = !err && String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        // prefer .exe, then .cmd on Windows
        let pick = found && (found.find(f => /\.exe$/i.test(f)) || found.find(f => /\.cmd$/i.test(f)) || found[0]);
        if (!pick) pick = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } });
        if (process.env.ISLAND_CLAUDE_BIN) pick = process.env.ISLAND_CLAUDE_BIN;
        this.bin = pick || null;
        this.log('ask: claude binary', this.bin);
        resolve(this.bin);
      });
    });
  }

  buildArgs(model) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', SYSTEM, '--disallowedTools', ASK_TOOLS_OFF, '--max-turns', '4'];
    if (this.features.partial) a.push('--include-partial-messages');
    if (this.features.settings) a.push('--settings', this.settingsFile);
    if (model && model !== 'default') a.push('--model', model);
    if (this.sessionId) a.push('--resume', this.sessionId);
    else if (this.features.sessionId) {
      const id = crypto.randomUUID();
      this.ownSessions.add(id);
      a.push('--session-id', id);
      this.pendingId = id;
    }
    return a;
  }

  async ask(reqId, prompt, { model } = {}) {
    const bin = await this.findBinary();
    if (!bin) {
      return this.onUpdate({ reqId, done: true, error: "I couldn't find Claude Code on this PC. Install it (claude.ai/code), sign in once in a terminal, then try again." });
    }
    this.cancel();
    this.run(bin, reqId, prompt, model, 0);
  }

  run(bin, reqId, prompt, model, attempt) {
    const args = this.buildArgs(model);
    const isCmd = /\.(cmd|bat)$/i.test(bin);
    // .cmd shims need a shell on Windows; every arg we pass is a fixed string without quotes,
    // and the user's prompt goes through stdin, so nothing user-typed hits the command line.
    const quoted = isCmd ? args.map(x => (/[\s,]/.test(x) ? `"${x}"` : x)) : args;
    const child = spawn(isCmd ? `"${bin}"` : bin, quoted, {
      cwd: this.workDir, windowsHide: true, shell: isCmd,
      env: { ...process.env, NOTCH_BUDDY_ASK: '1' }
    });
    this.proc = child;
    let buf = '', text = '', sawDelta = false, stderr = '', finished = false;
    const send = (extra = {}) => this.onUpdate({ reqId, text, ...extra });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.session_id) { this.ownSessions.add(o.session_id); }
        if (o.type === 'stream_event' && o.event && o.event.type === 'content_block_delta' && o.event.delta && o.event.delta.type === 'text_delta') {
          if (!sawDelta) { sawDelta = true; text = ''; }
          text += o.event.delta.text; send();
        } else if (o.type === 'stream_event' && o.event && o.event.type === 'message_start') {
          sawDelta = false;
        } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          const t = o.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
          if (t && !sawDelta) { text = t; send(); }
        } else if (o.type === 'result') {
          finished = true;
          if (o.session_id) this.sessionId = o.session_id;
          else if (this.pendingId) this.sessionId = this.pendingId;
          if (typeof o.result === 'string' && o.result.trim()) text = o.result;
          if (o.is_error) send({ done: true, error: text || 'Claude returned an error.' });
          else send({ done: true });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { if (!finished) { finished = true; send({ done: true, error: `Couldn't start Claude Code: ${e.message}` }); } });
    child.on('close', code => {
      if (this.proc === child) this.proc = null;
      if (finished) return;
      if (child._cancelled) return send({ done: true, cancelled: true });
      const err = stderr.trim();
      this.log('ask: exit', code, err.slice(0, 400));
      // Older Claude Code versions don't know some flags: drop them and retry once each.
      const unknown = /unknown option|unrecognized|invalid option|error: option/i.test(err);
      if (unknown && attempt < 3) {
        if (this.features.partial && /include-partial/i.test(err)) this.features.partial = false;
        else if (this.features.sessionId && /session-id/i.test(err)) this.features.sessionId = false;
        else if (this.features.settings && /settings/i.test(err)) this.features.settings = false;
        else if (this.features.partial) this.features.partial = false;
        else if (this.features.settings) this.features.settings = false;
        else this.features.sessionId = false;
        return this.run(bin, reqId, prompt, model, attempt + 1);
      }
      if (code === null) return send({ done: true, cancelled: true });
      let msg = err || `Claude Code exited (code ${code}).`;
      if (/log ?in|authenticat|api key|unauthor/i.test(err)) msg = 'Claude Code isn\'t signed in. Open a terminal, run "claude", sign in once, then ask again.';
      if (/rate limit|usage limit|limit reached/i.test(err)) msg = 'You\'ve hit your Claude usage limit for now. Try again later.';
      send({ done: true, error: msg.slice(0, 400), text: text || '' });
    });
    child.stdin.end(prompt, 'utf8');
  }
}

module.exports = { Asker };
