'use strict';
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const multer = require('multer');
const cron = require('node-cron');
const { Rcon } = require('rcon-client');
const execFileAsync = promisify(execFile);

const app = express();
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PANEL_PORT || 3000);
const USER = process.env.PANEL_USERNAME || 'admin';
const HASH = process.env.PANEL_PASSWORD_HASH || '';
const SECRET = process.env.SESSION_SECRET || '';
const SERVICE = (process.env.MINECRAFT_SERVICE || 'minecraft').replace(/\.service$/, '');
const MC_DIR = path.resolve(process.env.MINECRAFT_DIR || '/opt/minecraft');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || '/opt/nekopanel/backups');
const DATA_DIR = path.resolve(process.env.PANEL_DATA_DIR || '/opt/nekopanel/data');
const RCLONE_DEST = process.env.RCLONE_DESTINATION || '';
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const tasks = new Map();
const failedLogins = new Map();

if (!SECRET || SECRET.length < 32 || !HASH) {
  console.error('Set PANEL_PASSWORD_HASH and a random SESSION_SECRET of at least 32 characters.');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PANEL_PORT must be 1–65535');

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"]
  } }, crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '2mb' }));
app.use(session({ name: 'nekopanel.sid', secret: SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8 * 60 * 60 * 1000 } }));

function auth(req, res, next) {
  if (req.session?.user === USER) return next();
  return res.status(401).json({ error: 'Please log in.' });
}
function loginThrottle(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = failedLogins.get(key);
  if (entry && entry.count >= 10 && Date.now() - entry.last < 15 * 60 * 1000)
    return res.status(429).json({ error: 'Too many login attempts. Wait 15 minutes and try again.' });
  if (entry && Date.now() - entry.last >= 15 * 60 * 1000) failedLogins.delete(key);
  next();
}
async function run(file, args, timeout = 15000, options = {}) {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, ...options });
    return (stdout || '').trim();
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || 'Command failed').trim();
    throw new Error(details || 'Command failed');
  }
}
async function systemctl(action, extra = [], timeout = 30000) {
  const valid = new Set(['is-active','show','start','stop','restart','is-enabled','enable','disable']);
  if (!valid.has(action)) throw new Error('Unsupported systemd action.');
  return run('/usr/bin/sudo', ['/usr/bin/systemctl', action, ...extra], timeout);
}
async function serviceState() {
  try { return await systemctl('is-active', [SERVICE]); }
  catch (e) {
    const message = String(e.message || '');
    if (/could not be found|not-found|not loaded|Unit .* not found/i.test(message)) return 'not-installed';
    return 'inactive';
  }
}
function resolveInside(base, requested = '') {
  const baseResolved = path.resolve(base);
  const target = path.resolve(baseResolved, String(requested || '').replace(/^[/\\]+/, ''));
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) throw new Error('Path escapes the allowed directory.');
  return target;
}
async function safeExistingTarget(base, requested = '') {
  const target = resolveInside(base, requested);
  const realBase = await fs.promises.realpath(base);
  const relative = path.relative(path.resolve(base), target);
  let cursor = realBase;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed in the web file manager.');
  }
  const realTarget = await fs.promises.realpath(target);
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) throw new Error('Path escapes the server directory.');
  return realTarget;
}
async function isRunning() { return (await serviceState()) === 'active'; }
async function ensureDir(dir) { await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 }); }
function bytes(n) { return Number.isFinite(n) ? n : 0; }

async function rconCommand(command) {
  if (!RCON_PASSWORD) throw new Error('RCON is not configured. Enable enable-rcon in server.properties and set RCON_PASSWORD in the panel environment file.');
  if (typeof command !== 'string' || !command.trim() || command.length > 300 || /[\r\n\0]/.test(command)) throw new Error('Command must be 1–300 characters on a single line.');
  const rcon = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
  try { return await rcon.send(command.trim().replace(/^\//, '')); }
  finally { rcon.end(); }
}

async function makeBackup({ suspend = true } = {}) {
  const st = await fs.promises.stat(MC_DIR).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Minecraft directory does not exist: ${MC_DIR}`);
  await ensureDir(BACKUP_DIR);
  const wasRunning = await isRunning();
  if (wasRunning && !suspend) throw new Error('Server is running. Stop it or enable suspend-before-backup to make a consistent archive.');
  if (wasRunning) await systemctl('stop', [SERVICE], 120000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `minecraft-${stamp}.tar.gz`;
  const archive = path.join(BACKUP_DIR, filename);
  try {
    await run('/usr/bin/tar', ['--warning=no-file-changed', '-czf', archive, '-C', MC_DIR, '.'], 30 * 60 * 1000);
    const stat = await fs.promises.stat(archive);
    let drive = 'not-configured';
    if (RCLONE_DEST) {
      await run('/usr/bin/rclone', ['copyto', archive, `${RCLONE_DEST.replace(/\/+$/, '')}/${filename}`], 30 * 60 * 1000);
      drive = 'uploaded';
    }
    return { file: filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), drive };
  } finally {
    if (wasRunning) {
      try { await systemctl('start', [SERVICE], 120000); }
      catch (e) { console.error('CRITICAL: backup completed or failed but the server could not be restarted:', e.message); }
    }
  }
}
async function listBackups() {
  await ensureDir(BACKUP_DIR);
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^minecraft-[\w.-]+\.tar\.gz$/.test(entry.name)) continue;
    const stat = await fs.promises.stat(path.join(BACKUP_DIR, entry.name));
    result.push({ file: entry.name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return result.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
function taskFile() { return path.join(DATA_DIR, 'tasks.json'); }
async function readTasks() {
  await ensureDir(DATA_DIR);
  try { const parsed = JSON.parse(await fs.promises.readFile(taskFile(), 'utf8')); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function writeTasks(items) {
  await ensureDir(DATA_DIR);
  const temp = taskFile() + '.tmp';
  await fs.promises.writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o640 });
  await fs.promises.rename(temp, taskFile());
}
function registerTask(task) {
  if (tasks.has(task.id)) { tasks.get(task.id).stop(); tasks.delete(task.id); }
  if (!task.enabled || !cron.validate(task.schedule)) return;
  const job = cron.schedule(task.schedule, async () => {
    const logFile = path.join(DATA_DIR, 'task-runs.jsonl');
    const record = { id: task.id, name: task.name, action: task.action, at: new Date().toISOString() };
    try {
      if (task.action === 'backup') await makeBackup({ suspend: true });
      else await systemctl(task.action, [SERVICE], 120000);
      record.result = 'success';
    } catch (e) { record.result = 'failed'; record.error = String(e.message).slice(0, 500); }
    try { await fs.promises.appendFile(logFile, JSON.stringify(record) + '\n', { mode: 0o640 }); } catch {}
  }, { timezone: process.env.TZ || 'UTC' });
  tasks.set(task.id, job);
}
async function loadTasks() {
  const list = await readTasks();
  list.forEach(registerTask);
}
const upload = multer({ dest: path.join(os.tmpdir(), 'nekopanel-upload-'), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'NekoPanel', version: '0.2.0' }));
app.post('/api/login', loginThrottle, async (req, res) => {
  const { username, password } = req.body || {};
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    if (username !== USER || typeof password !== 'string' || !(await bcrypt.compare(password, HASH))) {
      const entry = failedLogins.get(key) || { count: 0, last: 0 };
      entry.count += 1; entry.last = Date.now(); failedLogins.set(key, entry);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    failedLogins.delete(key);
    req.session.user = USER;
    res.json({ ok: true, username: USER });
  } catch (e) { res.status(500).json({ error: 'Login verification failed.' }); }
});
app.post('/api/logout', auth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/session', auth, (_req, res) => res.json({ username: USER, version: '0.2.0' }));

app.get('/api/status', auth, async (_req, res) => {
  const state = await serviceState();
  let memory = '';
  if (state === 'active') try { memory = await systemctl('show', [SERVICE, '--property=MemoryCurrent', '--value']); } catch {}
  res.json({ service: state, memoryBytes: /^\d+$/.test(memory) ? Number(memory) : null, serviceName: SERVICE, minecraftDir: MC_DIR, rconConfigured: Boolean(RCON_PASSWORD) });
});
app.post('/api/server/:action', auth, async (req, res) => {
  const action = { start: 'start', stop: 'stop', restart: 'restart' }[req.params.action];
  if (!action) return res.status(400).json({ error: 'Unsupported action.' });
  try { await systemctl(action, [SERVICE], 120000); res.json({ ok: true, action }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/host', auth, async (_req, res) => {
  let disk = null;
  try {
    const raw = await run('/usr/bin/df', ['-Pk', MC_DIR]);
    const row = raw.split('\n').slice(1).find(Boolean).trim().split(/\s+/);
    if (row.length >= 6) disk = { totalBytes: Number(row[1]) * 1024, usedBytes: Number(row[2]) * 1024, freeBytes: Number(row[3]) * 1024, usedPercent: Number(String(row[4]).replace('%','')) };
  } catch {}
  const total = os.totalmem(), free = os.freemem();
  res.json({ hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`, uptimeSeconds: os.uptime(), cpuCount: os.cpus().length, load: os.loadavg(), memory: { totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercent: Math.round((total-free)/total*100) }, disk });
});
app.get('/api/console', auth, async (_req, res) => {
  try {
    const out = await run('/usr/bin/sudo', ['/usr/bin/journalctl', '-u', `${SERVICE}.service`, '-n', '250', '--no-pager', '-o', 'short-iso'], 15000);
    res.json({ lines: out ? out.split('\n').slice(-250) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/console/command', auth, async (req, res) => {
  try { const response = await rconCommand(req.body?.command); res.json({ ok: true, response: response || '(command sent)' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/players/action', auth, async (req, res) => {
  const { action, player, reason } = req.body || {};
  const supported = new Set(['op','deop','kick','ban','pardon','whitelist-add','whitelist-remove']);
  if (!supported.has(action) || typeof player !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(player)) return res.status(400).json({ error: 'Choose a supported action and a valid Minecraft username.' });
  const safeReason = typeof reason === 'string' ? reason.replace(/[\r\n\0]/g,' ').slice(0,120) : '';
  const commands = { op: `op ${player}`, deop: `deop ${player}`, kick: `kick ${player}${safeReason ? ' '+safeReason : ''}`, ban: `ban ${player}${safeReason ? ' '+safeReason : ''}`, pardon: `pardon ${player}`, 'whitelist-add': `whitelist add ${player}`, 'whitelist-remove': `whitelist remove ${player}` };
  try { const response = await rconCommand(commands[action]); res.json({ ok: true, response }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/players', auth, async (_req, res) => {
  try {
    const result = await rconCommand('list');
    const match = result.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online(?::\s*(.*))?/i) || result.match(/(\d+) of a max of (\d+) players online(?:: (.*))?/i);
    const players = match && match[3] ? match[3].split(',').map(x => x.trim()).filter(Boolean) : [];
    res.json({ online: match ? Number(match[1]) : players.length, max: match ? Number(match[2]) : null, players, raw: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/files', auth, async (req, res) => {
  try {
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    const target = requested ? await safeExistingTarget(MC_DIR, requested) : await fs.promises.realpath(MC_DIR);
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const items = await Promise.all(entries.map(async e => {
      const full = path.join(target, e.name); const st = await fs.promises.lstat(full);
      return { name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', size: st.size, modifiedAt: st.mtime.toISOString() };
    }));
    items.sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
    res.json({ path: path.relative(MC_DIR, target), items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/file', auth, async (req, res) => {
  try {
    if (typeof req.query.path !== 'string' || !req.query.path) return res.status(400).json({ error: 'File path required.' });
    const target = await safeExistingTarget(MC_DIR, req.query.path); const st = await fs.promises.stat(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Only regular files can be opened.' });
    if (st.size > MAX_EDIT_BYTES) return res.status(413).json({ error: 'File is larger than the 1 MiB editor limit. Download it instead.' });
    const content = await fs.promises.readFile(target);
    if (content.includes(0)) return res.status(415).json({ error: 'Binary files cannot be edited here.' });
    res.json({ path: path.relative(MC_DIR, target), content: content.toString('utf8'), size: st.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/file', auth, async (req, res) => {
  try {
    const relative = req.body?.path, content = req.body?.content;
    if (typeof relative !== 'string' || !relative || typeof content !== 'string') return res.status(400).json({ error: 'Path and content are required.' });
    if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) return res.status(413).json({ error: 'File exceeds the 1 MiB editor limit.' });
    const target = await safeExistingTarget(MC_DIR, relative); const st = await fs.promises.stat(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Only regular files can be saved.' });
    await fs.promises.writeFile(target, content, { encoding: 'utf8', mode: st.mode });
    res.json({ ok: true, path: relative, sizeBytes: Buffer.byteLength(content, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/file/download', auth, async (req, res) => {
  try {
    if (typeof req.query.path !== 'string' || !req.query.path) return res.status(400).json({ error: 'File path required.' });
    const target = await safeExistingTarget(MC_DIR, req.query.path); const st = await fs.promises.stat(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Only files can be downloaded.' });
    res.download(target, path.basename(target));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/files/mkdir', auth, async (req, res) => {
  try {
    const parent = typeof req.body?.path === 'string' ? req.body.path : '';
    const name = req.body?.name;
    if (typeof name !== 'string' || !/^[^/\\.][^/\\]*$/.test(name) || name === '.' || name === '..') return res.status(400).json({ error: 'Invalid folder name.' });
    const parentFull = parent ? await safeExistingTarget(MC_DIR, parent) : await fs.promises.realpath(MC_DIR);
    await fs.promises.mkdir(path.join(parentFull, name), { mode: 0o750 });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/files/item', auth, async (req, res) => {
  try {
    if (typeof req.query.path !== 'string' || !req.query.path) return res.status(400).json({ error: 'Path required.' });
    const target = await safeExistingTarget(MC_DIR, req.query.path);
    if (target === await fs.promises.realpath(MC_DIR)) return res.status(400).json({ error: 'Cannot delete the server root.' });
    const st = await fs.promises.lstat(target);
    if (st.isDirectory()) await fs.promises.rm(target, { recursive: true, force: false });
    else if (st.isFile()) await fs.promises.unlink(target);
    else return res.status(400).json({ error: 'Unsupported file type.' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/files/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    const relDir = typeof req.body.path === 'string' ? req.body.path : '';
    const dir = relDir ? await safeExistingTarget(MC_DIR, relDir) : await fs.promises.realpath(MC_DIR);
    const name = path.basename(req.file.originalname).replace(/[\0\r\n]/g, '').slice(0, 200);
    if (!name || name === '.' || name === '..') return res.status(400).json({ error: 'Invalid filename.' });
    const target = path.join(dir, name);
    if (fs.existsSync(target)) return res.status(409).json({ error: 'A file with this name already exists.' });
    await fs.promises.rename(req.file.path, target);
    res.json({ ok: true, name, sizeBytes: req.file.size });
  } catch (e) { res.status(400).json({ error: e.message }); }
  finally { if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {}); }
});

app.get('/api/backups', auth, async (_req, res) => { try { res.json({ backups: await listBackups() }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/backup', auth, async (req, res) => { try { res.json({ ok: true, ...(await makeBackup({ suspend: req.body?.suspend !== false })) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/backup/download', auth, async (req, res) => {
  const filename = req.query.file;
  if (typeof filename !== 'string' || !/^minecraft-[\w.-]+\.tar\.gz$/.test(filename)) return res.status(400).json({ error: 'Invalid backup filename.' });
  const file = path.join(BACKUP_DIR, filename);
  try { const st = await fs.promises.stat(file); if (!st.isFile()) throw new Error('Not a file'); res.download(file); }
  catch { res.status(404).json({ error: 'Backup not found.' }); }
});
app.delete('/api/backup', auth, async (req, res) => {
  const filename = req.query.file;
  if (typeof filename !== 'string' || !/^minecraft-[\w.-]+\.tar\.gz$/.test(filename)) return res.status(400).json({ error: 'Invalid backup filename.' });
  try { await fs.promises.unlink(path.join(BACKUP_DIR, filename)); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/tasks', auth, async (_req, res) => {
  try { res.json({ tasks: await readTasks() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/tasks', auth, async (req, res) => {
  const { id, name, schedule, action, enabled } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return res.status(400).json({ error: 'Task name is required (up to 80 characters).' });
  if (typeof schedule !== 'string' || !cron.validate(schedule)) return res.status(400).json({ error: 'Use a valid cron schedule (e.g. 0 4 * * * for daily at 04:00 UTC).' });
  if (!['backup','start','stop','restart'].includes(action)) return res.status(400).json({ error: 'Unsupported task action.' });
  const list = await readTasks();
  const item = { id: typeof id === 'string' && /^[a-z0-9-]{8,50}$/.test(id) ? id : `task-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, name: name.trim(), schedule, action, enabled: enabled !== false };
  const index = list.findIndex(x => x.id === item.id);
  if (index >= 0) list[index] = item; else list.push(item);
  await writeTasks(list); registerTask(item); res.json({ ok: true, task: item });
});
app.delete('/api/tasks/:id', auth, async (req, res) => {
  const list = await readTasks(); const next = list.filter(x => x.id !== req.params.id);
  if (list.length === next.length) return res.status(404).json({ error: 'Task not found.' });
  await writeTasks(next); if (tasks.has(req.params.id)) { tasks.get(req.params.id).stop(); tasks.delete(req.params.id); }
  res.json({ ok: true });
});
app.get('/api/task-runs', auth, async (_req, res) => {
  try { const raw = await fs.promises.readFile(path.join(DATA_DIR, 'task-runs.jsonl'), 'utf8').catch(() => ''); const items = raw.split('\n').filter(Boolean).slice(-100).reverse().map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); res.json({ runs: items }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/settings', auth, async (_req, res) => res.json({ version: '0.2.0', hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`, serviceName: SERVICE, minecraftDir: MC_DIR, backupDir: BACKUP_DIR, rconConfigured: Boolean(RCON_PASSWORD), rconHost: RCON_HOST, rconPort: RCON_PORT, rcloneConfigured: Boolean(RCLONE_DEST), node: process.version, timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone }));
app.get('/api/metrics', (req, res) => {
  if (METRICS_TOKEN && req.get('authorization') !== `Bearer ${METRICS_TOKEN}`) return res.status(401).end();
  const total = os.totalmem(), free = os.freemem(), cpu = os.loadavg()[0];
  res.type('text/plain').send([
    '# HELP nekopanel_host_memory_bytes Host memory in bytes', '# TYPE nekopanel_host_memory_bytes gauge', `nekopanel_host_memory_bytes{kind="total"} ${total}`, `nekopanel_host_memory_bytes{kind="free"} ${free}`, `nekopanel_host_memory_bytes{kind="used"} ${total-free}`,
    '# HELP nekopanel_host_load_1m Host 1-minute load average', '# TYPE nekopanel_host_load_1m gauge', `nekopanel_host_load_1m ${cpu}`, '# HELP nekopanel_process_uptime_seconds NekoPanel process uptime', '# TYPE nekopanel_process_uptime_seconds counter', `nekopanel_process_uptime_seconds ${Math.floor(process.uptime())}`
  ].join('\n') + '\n');
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: '1h' }));
app.use((err, _req, res, _next) => {
  console.error(err.stack || err);
  if (res.headersSent) return;
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ error: err instanceof multer.MulterError ? err.message : 'Unexpected server error.' });
});

(async () => {
  await ensureDir(DATA_DIR).catch(e => console.error('Cannot create NekoPanel data directory:', e.message));
  await loadTasks().catch(e => console.error('Could not load scheduled tasks:', e.message));
  app.listen(PORT, HOST, () => console.log(`NekoPanel 0.2.0 listening on http://${HOST}:${PORT}`));
})();
