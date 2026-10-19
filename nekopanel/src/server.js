const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT || 3000);
const USER = process.env.PANEL_USERNAME || 'admin';
const HASH = process.env.PANEL_PASSWORD_HASH || '';
const SECRET = process.env.SESSION_SECRET || '';
const SERVICE = process.env.MINECRAFT_SERVICE || 'minecraft';
const MC_DIR = path.resolve(process.env.MINECRAFT_DIR || '/opt/minecraft');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || '/opt/nekopanel/backups');
const RCLONE_DEST = process.env.RCLONE_DESTINATION || '';
if (!SECRET || SECRET.length < 32 || !HASH) {
  console.error('Set PANEL_PASSWORD_HASH and a random SESSION_SECRET of at least 32 characters.');
  process.exit(1);
}
function run(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message || 'Command failed').trim()));
    resolve((stdout || '').trim());
  }));
}
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(session({ name: 'nekopanel.sid', secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8 * 60 * 60 * 1000 } }));
function auth(req, res, next) { if (req.session?.user === USER) return next(); return res.status(401).json({ error: 'Please log in.' }); }
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'NekoPanel', version: '0.1.0' }));
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== USER || typeof password !== 'string' || !(await bcrypt.compare(password, HASH)))
    return res.status(401).json({ error: 'Invalid username or password.' });
  req.session.user = USER; res.json({ ok: true });
});
app.post('/api/logout', auth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/status', auth, async (_req, res) => {
  try {
    const state = await run('/usr/bin/sudo', ['/usr/bin/systemctl', 'is-active', SERVICE]);
    let memory = '';
    try { memory = await run('/usr/bin/sudo', ['/usr/bin/systemctl', 'show', SERVICE, '--property=MemoryCurrent', '--value']); } catch {}
    res.json({ service: state, memoryBytes: /^\d+$/.test(memory) ? Number(memory) : null });
  } catch { res.json({ service: 'inactive', memoryBytes: null }); }
});
app.post('/api/server/:action', auth, async (req, res) => {
  const action = { start: 'start', stop: 'stop', restart: 'restart' }[req.params.action];
  if (!action) return res.status(400).json({ error: 'Unsupported action.' });
  try { await run('/usr/bin/sudo', ['/usr/bin/systemctl', action, SERVICE], 30000); res.json({ ok: true, action }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/console', auth, async (_req, res) => {
  try {
    const out = await run('/usr/bin/sudo', ['/usr/bin/journalctl', '-u', SERVICE, '-n', '120', '--no-pager', '-o', 'short-iso']);
    res.json({ lines: out.split('\n').slice(-120) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/files', auth, async (req, res) => {
  const requested = typeof req.query.path === 'string' ? req.query.path : '';
  const target = path.resolve(MC_DIR, requested);
  if (target !== MC_DIR && !target.startsWith(MC_DIR + path.sep)) return res.status(400).json({ error: 'Invalid path.' });
  try {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const items = await Promise.all(entries.map(async e => {
      const st = await fs.promises.lstat(path.join(target, e.name));
      return { name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', size: st.size };
    }));
    res.json({ path: path.relative(MC_DIR, target), items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/backup', auth, async (_req, res) => {
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true, mode: 0o750 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = path.join(BACKUP_DIR, `minecraft-${stamp}.tar.gz`);
    await run('/usr/bin/tar', ['-czf', archive, '-C', MC_DIR, '.'], 30 * 60 * 1000);
    let drive = 'not-configured';
    if (RCLONE_DEST) {
      await run('/usr/bin/rclone', ['copyto', archive, `${RCLONE_DEST.replace(/\/+$/, '')}/${path.basename(archive)}`], 30 * 60 * 1000);
      drive = 'uploaded';
    }
    const st = await fs.promises.stat(archive);
    res.json({ ok: true, file: path.basename(archive), sizeBytes: st.size, drive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.listen(PORT, HOST, () => console.log(`NekoPanel listening on http://${HOST}:${PORT}`));
