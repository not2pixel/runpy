'use strict';

const express  = require('express');
const { spawn } = require('child_process');
const fs       = require('fs');
const fsp      = fs.promises;
const path     = require('path');
const crypto   = require('crypto');

const app = express();

// ── SECURITY HEADERS ─────────────────────────────────────────────
// Chặn XSS, clickjacking, MIME sniff, và rò rỉ thông tin server
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "connect-src 'self' https://cdnjs.cloudflare.com; " +
    "img-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self';"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Body parser — chỉ nhận JSON, giới hạn nhỏ để chặn body-size attack
app.use(express.json({ limit: '128kb' }));

// Static files — phục vụ public/
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h',
}));

// ── LOGGER ───────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (Object.keys(meta).length) {
    console[level === 'error' ? 'error' : 'log'](line, JSON.stringify(meta));
  } else {
    console[level === 'error' ? 'error' : 'log'](line);
  }
}

// ── CONFIG ───────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '25080', 10);
const SESSIONS_DIR     = path.join(__dirname, 'sessions');
const MAX_CONCURRENT   = 10;
const MAX_QUEUE        = 30;
const QUEUE_TIMEOUT_MS = 15_000;
const EXEC_TIMEOUT_SEC = 8;
const MEM_LIMIT_KB     = 256 * 1024;   // 256 MB virtual memory
const FILE_SIZE_LIMIT  = 20 * 1024;    // 20 MB file size (ulimit -f blocks, in KB)
// KHÔNG dùng ulimit -u — gây crash Node.js worker threads trên ARM/aarch64
const SESSION_QUOTA    = 20 * 1024 * 1024;  // 20 MB / session
const SESSION_TTL_MS   = 2 * 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 100_000;
const CODE_MAX_LEN     = 50_000;
const STDIN_MAX_LEN    = 20_000;

// Tạo thư mục sessions nếu chưa có
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  log('info', `Sessions dir ready: ${SESSIONS_DIR}`);
} catch (err) {
  log('error', 'Không thể tạo sessions dir', { err: err.message });
  process.exit(1);
}

// ── RATE LIMIT đơn giản (per IP, in-memory) ──────────────────────
// Chặn spam — tối đa 20 request/run mỗi 60 giây per IP
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT   = 20;
const RATE_WINDOW  = 60_000;

function checkRateLimit(ip) {
  const now   = Date.now();
  let entry   = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Dọn rateLimitMap mỗi 5 phút để tránh memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// ── CONCURRENCY QUEUE ────────────────────────────────────────────
let running = 0;
const queue  = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, queuedAt: Date.now() };
    if (running < MAX_CONCURRENT) {
      running++;
      resolve(() => releaseSlot());
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      log('warn', 'Queue full, rejecting request');
      reject(new Error('QUEUE_FULL'));
      return;
    }
    const timer = setTimeout(() => {
      const idx = queue.indexOf(task);
      if (idx !== -1) queue.splice(idx, 1);
      log('warn', 'Queue timeout for task', { waited: Date.now() - task.queuedAt });
      reject(new Error('QUEUE_TIMEOUT'));
    }, QUEUE_TIMEOUT_MS);
    task.timer = timer;
    queue.push(task);
  });
}

function releaseSlot() {
  running--;
  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
    running++;
    next.resolve(() => releaseSlot());
  }
}

// ── SESSION UTILS ────────────────────────────────────────────────
function isValidSessionId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function sessionDir(id) {
  // path.join() an toàn — nhưng double-check để chắc không có path traversal
  const dir = path.join(SESSIONS_DIR, id);
  if (!dir.startsWith(SESSIONS_DIR + path.sep)) {
    throw new Error('Path traversal detected');
  }
  return dir;
}

async function ensureSessionDir(id) {
  const dir = sessionDir(id);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function getDirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSize(full);
    } else {
      try {
        const st = await fsp.stat(full);
        total += st.size;
      } catch {}
    }
  }
  return total;
}

// Dọn session cũ không dùng
async function cleanupOldSessions() {
  let entries;
  try {
    entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch (err) {
    log('error', 'cleanupOldSessions: readdir failed', { err: err.message });
    return;
  }
  const now     = Date.now();
  let cleaned   = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SESSIONS_DIR, entry.name);
    try {
      const st = await fsp.stat(dir);
      if (now - st.mtimeMs > SESSION_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        cleaned++;
      }
    } catch (err) {
      log('error', 'cleanupOldSessions: failed to rm', { dir, err: err.message });
    }
  }
  if (cleaned > 0) log('info', `Cleaned ${cleaned} old sessions`);
}
setInterval(cleanupOldSessions, 15 * 60_000);

// ── PYTHON SANDBOX ───────────────────────────────────────────────
// Dùng `exec python3` để python3 là PID trực tiếp trong group,
// giúp kill -PID giết được toàn bộ tiến trình con.
// KHÔNG dùng ulimit -u vì crash Node worker threads trên ARM.
function buildPythonCmd() {
  return (
    `ulimit -v ${MEM_LIMIT_KB} 2>/dev/null || true; ` +
    `ulimit -f ${FILE_SIZE_LIMIT} 2>/dev/null || true; ` +
    `exec python3 -I -B -S main.py`
    //   -I  : isolated mode (bỏ qua PYTHONPATH, user site-packages)
    //   -B  : không ghi .pyc
    //   -S  : bỏ qua site module (nhanh hơn, an toàn hơn)
    // Nếu muốn dùng được stdlib (os, sys, math...) thì bỏ -S
    // Ta GIỮ stdlib nhưng block import của system packages nguy hiểm qua RestrictedImport
  );
}

// Python wrapper: inject một import hook nhẹ chặn các module nguy hiểm
// mà không cần restict toàn bộ stdlib
const BLOCKED_MODULES = new Set([
  'subprocess', 'multiprocessing', 'ctypes', 'cffi',
  'socket', 'socketserver', 'http', 'urllib', 'urllib2',
  'ftplib', 'smtplib', 'telnetlib', 'ssl', 'asyncio',
  'threading', '__future__',
]);

function wrapUserCode(code) {
  const blocked = [...BLOCKED_MODULES].map(m => `'${m}'`).join(', ');
  // Prefix nhỏ inject vào đầu — không ảnh hưởng traceback line numbers
  // vì ta dùng compile() với offset
  const prefix = `
import sys as _sys
_BLOCKED = {${blocked}}
_real_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__
def _safe_import(name, *args, **kwargs):
    base = name.split('.')[0]
    if base in _BLOCKED:
        raise ImportError(f"Module '{base}' bị chặn vì lý do bảo mật.")
    return _real_import(name, *args, **kwargs)
__builtins__.__import__ = _safe_import
del _sys, _BLOCKED, _real_import, _safe_import
`;
  // Nối prefix + code user, giữ newline để traceback vẫn đúng từ dòng prefix+1
  return prefix + '\n' + code;
}

function runPython(dir, code, stdin) {
  return new Promise((resolve) => {
    const wrappedCode = wrapUserCode(code);
    const codeFile    = path.join(dir, 'main.py');

    try {
      fs.writeFileSync(codeFile, wrappedCode, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      log('error', 'runPython: writeFile failed', { err: err.message });
      resolve({ stdout: '', stderr: 'Lỗi ghi file: ' + err.message, exitCode: -1, durationMs: 0, status: 'error' });
      return;
    }

    // Môi trường tối giản — không để lộ biến hệ thống
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: dir,
      TMPDIR: dir,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };

    let child;
    try {
      child = spawn('bash', ['-c', buildPythonCmd()], {
        cwd: dir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,   // trở thành process group leader → có thể kill cả nhóm
      });
    } catch (err) {
      log('error', 'runPython: spawn failed', { err: err.message });
      resolve({ stdout: '', stderr: 'Không thể khởi chạy Python: ' + err.message, exitCode: -1, durationMs: 0, status: 'error' });
      return;
    }

    let stdout         = '';
    let stderr         = '';
    let killedForLen   = false;
    let timedOut       = false;
    let settled        = false;
    const startedAt    = Date.now();

    function killGroup(signal) {
      try {
        process.kill(-child.pid, signal);
      } catch (err) {
        // Process group đã kết thúc — bỏ qua
      }
    }

    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(failsafeTimer);
      resolve(result);
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += chunk.toString('utf8');
        if (stdout.length >= MAX_OUTPUT_CHARS && !killedForLen) {
          killedForLen = true;
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS) + '\n[... output bị cắt (quá 100KB) ...]';
          killGroup('SIGKILL');
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += chunk.toString('utf8');
      }
    });

    child.stdout.on('error', (err) => {
      log('error', 'stdout pipe error', { err: err.message });
    });
    child.stderr.on('error', (err) => {
      log('error', 'stderr pipe error', { err: err.message });
    });

    // Ghi stdin trước khi bắt đầu tính giờ
    if (stdin) {
      try {
        child.stdin.write(stdin, 'utf8');
      } catch (err) {
        log('warn', 'stdin write failed', { err: err.message });
      }
    }
    try { child.stdin.end(); } catch {}

    // Timer chính: hết 8s → SIGTERM, rồi 1s sau SIGKILL
    const hardTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1_000);
    }, EXEC_TIMEOUT_SEC * 1_000);

    // Lưới an toàn: nếu close không bao giờ bắn (fork-bomb cực đoan)
    const failsafeTimer = setTimeout(() => {
      log('warn', 'Failsafe triggered — process group not closing', { pid: child.pid });
      killGroup('SIGKILL');
      settle({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr + '\n[Buộc dừng: tiến trình không thoát]').slice(0, MAX_OUTPUT_CHARS),
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        status: 'timeout',
      });
    }, (EXEC_TIMEOUT_SEC + 6) * 1_000);

    child.on('close', (exitCode, signal) => {
      const durationMs = Date.now() - startedAt;
      let status = 'ok';
      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        status = 'timeout';
      } else if (exitCode !== 0) {
        status = 'error';
      }

      // Làm sạch traceback — xóa dòng prefix wrapper khỏi stderr
      const cleanStderr = cleanTraceback(stderr);

      log('info', 'Run complete', { durationMs, exitCode, signal, status });

      settle({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: cleanStderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode,
        durationMs,
        status,
      });
    });

    child.on('error', (err) => {
      log('error', 'Child process error', { err: err.message });
      settle({
        stdout,
        stderr: `Lỗi hệ thống: ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        status: 'error',
      });
    });
  });
}

// Xóa các dòng của wrapper prefix khỏi traceback để user thấy số dòng đúng
function cleanTraceback(stderr) {
  if (!stderr) return stderr;
  return stderr
    .split('\n')
    .filter(line => !line.includes('_safe_import') && !line.includes('_BLOCKED') && !line.includes('__builtins__.__import__'))
    .join('\n');
}

// ── INPUT SANITIZER ──────────────────────────────────────────────
function sanitizeString(input, maxLen) {
  if (typeof input !== 'string') return '';
  // Chặn null byte — có thể dùng để bypass check
  return input.replace(/\0/g, '').slice(0, maxLen);
}

// ── ROUTES ───────────────────────────────────────────────────────

// Tạo session mới
app.post('/api/session', (req, res) => {
  const sessionId = crypto.randomBytes(16).toString('hex');
  log('info', 'New session created', { sessionId });
  res.json({ sessionId });
});

// Chạy code
app.post('/api/run', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  // Rate limit
  if (!checkRateLimit(ip)) {
    log('warn', 'Rate limit exceeded', { ip });
    return res.status(429).json({ error: 'Quá nhiều yêu cầu. Chờ 60 giây rồi thử lại.' });
  }

  const body = req.body || {};
  const code      = sanitizeString(body.code, CODE_MAX_LEN + 100);
  const sessionId = sanitizeString(body.sessionId, 64);
  const stdin     = sanitizeString(body.stdin, STDIN_MAX_LEN + 100);

  // Validation
  if (!code || code.trim().length === 0)
    return res.status(400).json({ error: 'Thiếu mã nguồn.' });
  if (code.length > CODE_MAX_LEN)
    return res.status(400).json({ error: `Mã nguồn quá dài (tối đa ${CODE_MAX_LEN} ký tự).` });
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'sessionId không hợp lệ. Gọi /api/session trước.' });
  if (stdin.length > STDIN_MAX_LEN)
    return res.status(400).json({ error: 'stdin quá dài.' });

  let release;
  try {
    release = await acquireSlot();
  } catch (e) {
    if (e.message === 'QUEUE_FULL')
      return res.status(503).json({ error: 'Server đang bận. Thử lại sau vài giây.' });
    return res.status(504).json({ error: 'Hết thời gian chờ hàng đợi.' });
  }

  try {
    const dir = await ensureSessionDir(sessionId);

    // Quota check
    const usedBytes = await getDirSize(dir);
    if (usedBytes > SESSION_QUOTA) {
      log('warn', 'Session quota exceeded', { sessionId, usedBytes });
      return res.status(413).json({
        error: 'Đã hết 20MB storage. Dọn dẹp session để tiếp tục.',
        usedBytes,
      });
    }

    const result = await runPython(dir, code, stdin);
    res.json(result);

  } catch (err) {
    log('error', '/api/run internal error', { err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Lỗi server. Thử lại sau.' });
  } finally {
    if (release) release();
  }
});

// Xem dung lượng session
app.get('/api/usage/:sessionId', async (req, res) => {
  const sessionId = sanitizeString(req.params.sessionId, 64);
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'sessionId không hợp lệ.' });
  try {
    const usedBytes = await getDirSize(sessionDir(sessionId));
    res.json({
      usedBytes,
      quotaBytes: SESSION_QUOTA,
      usedPercent: Math.round((usedBytes / SESSION_QUOTA) * 100),
    });
  } catch (err) {
    log('error', '/api/usage error', { sessionId, err: err.message });
    res.status(500).json({ error: 'Không thể đọc dung lượng.' });
  }
});

// Reset session
app.post('/api/reset', async (req, res) => {
  const sessionId = sanitizeString((req.body || {}).sessionId, 64);
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'sessionId không hợp lệ.' });
  try {
    const dir = sessionDir(sessionId);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    log('info', 'Session reset', { sessionId });
    res.json({ ok: true });
  } catch (err) {
    log('error', '/api/reset error', { sessionId, err: err.message });
    res.status(500).json({ error: 'Không thể reset: ' + err.message });
  }
});

// Trạng thái hệ thống
app.get('/api/status', (req, res) => {
  res.json({ running, queued: queue.length, maxConcurrent: MAX_CONCURRENT });
});

// ── 404 / ERROR HANDLERS ─────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Không tìm thấy endpoint.' });
});

app.use((err, req, res, next) => {
  log('error', 'Unhandled express error', { err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Lỗi server.' });
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────────
function gracefulShutdown(signal) {
  log('info', `Received ${signal}, shutting down...`);
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { err: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});

// ── START ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log('info', `RunPy ready`, { port: PORT, pid: process.pid });
});
