const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===================== CẤU HÌNH =====================
const PORT = process.env.PORT || 25080;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const MAX_CONCURRENT = 10;          // tối đa 10 tiến trình chạy song song
const MAX_QUEUE = 30;               // hàng đợi tối đa, tránh quá tải
const QUEUE_TIMEOUT_MS = 15_000;    // tối đa chờ trong hàng đợi
const EXEC_TIMEOUT_SEC = 8;         // mỗi lần chạy tối đa 8 giây
const MEM_LIMIT_KB = 256 * 1024;    // 256MB bộ nhớ ảo / tiến trình
const FILE_SIZE_LIMIT_KB = 20 * 1024; // 1 file tối đa 20MB (an toàn)
const PROC_LIMIT = 200;             // chống fork-bomb (đủ cao để không chặn nhầm khi nhiều người chạy cùng lúc)
const SESSION_QUOTA_BYTES = 20 * 1024 * 1024; // 20MB / user
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;    // dọn session sau 2h không dùng
const MAX_OUTPUT_CHARS = 100_000;   // chặn output khổng lồ làm treo trình duyệt

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ===================== HÀNG ĐỢI CONCURRENCY =====================
let running = 0;
const queue = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, queuedAt: Date.now() };
    if (running < MAX_CONCURRENT) {
      running++;
      resolve(() => releaseSlot());
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      reject(new Error('QUEUE_FULL'));
      return;
    }
    const timer = setTimeout(() => {
      const idx = queue.indexOf(task);
      if (idx !== -1) queue.splice(idx, 1);
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

// ===================== TIỆN ÍCH SESSION =====================
function isValidSessionId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function sessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

async function ensureSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
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

// Dọn các session cũ không hoạt động quá SESSION_TTL_MS
async function cleanupOldSessions() {
  let entries;
  try {
    entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SESSIONS_DIR, entry.name);
    try {
      const st = await fsp.stat(dir);
      if (now - st.mtimeMs > SESSION_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    } catch {}
  }
}
setInterval(cleanupOldSessions, 15 * 60 * 1000);

// ===================== THỰC THI PYTHON (SANDBOX) =====================
function runPythonSandboxed(dir, code, stdin) {
  return new Promise((resolve) => {
    const codeFile = path.join(dir, 'main.py');
    fs.writeFileSync(codeFile, code, 'utf8');

    // Giới hạn tài nguyên bằng ulimit: -v bộ nhớ ảo, -f kích thước file tối đa,
    // -u số tiến trình (chống fork-bomb ở mức hạt nhân, nhưng KHÔNG đủ để tự dọn
    // các tiến trình mồ côi khi timeout, nên phần giết tiến trình do Node đảm nhiệm bên dưới).
    const bashCmd =
      `ulimit -v ${MEM_LIMIT_KB}; ` +
      `ulimit -f ${FILE_SIZE_LIMIT_KB}; ` +
      `ulimit -u ${PROC_LIMIT} 2>/dev/null || true; ` +
      `exec python3 -I -B main.py`;

    // detached: true -> tiến trình con trở thành trưởng nhóm tiến trình (setsid) mới.
    // Nhờ vậy mọi tiến trình con/cháu do code Python tự fork ra (kể cả fork-bomb)
    // đều nằm chung nhóm này, và ta có thể giết SẠCH cả nhóm bằng process.kill(-pid).
    const child = spawn('bash', ['-c', bashCmd], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let killedForOutput = false;
    let timedOut = false;
    let settled = false;

    function killGroup(signal) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // nhóm tiến trình có thể đã kết thúc, bỏ qua
      }
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += chunk.toString();
      } else if (!killedForOutput) {
        killedForOutput = true;
        stdout += '\n[... output đã bị cắt bớt do quá dài ...]';
        killGroup('SIGKILL');
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += chunk.toString();
      }
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    const startedAt = Date.now();

    // Timer chính: hết giờ -> giết cả nhóm tiến trình (SIGTERM rồi SIGKILL sau 1s)
    const hardTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 1000);
    }, EXEC_TIMEOUT_SEC * 1000);

    // Lưới an toàn: nếu vì lý do gì đó 'close' không bao giờ bắn (trường hợp cực hiếm
    // với fork-bomb dữ dội), vẫn phải trả lời request thay vì treo mãi.
    const failsafeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup('SIGKILL');
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr + '\n[Đã buộc dừng: chương trình tạo quá nhiều tiến trình con]').slice(0, MAX_OUTPUT_CHARS),
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        status: 'timeout',
      });
    }, (EXEC_TIMEOUT_SEC + 5) * 1000);

    child.on('close', (codeExit, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(failsafeTimer);
      const durationMs = Date.now() - startedAt;
      let status = 'ok';
      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        status = 'timeout';
      } else if (codeExit !== 0) {
        status = 'error';
      }
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: codeExit,
        durationMs,
        status,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(failsafeTimer);
      resolve({
        stdout,
        stderr: `Lỗi hệ thống khi khởi chạy: ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        status: 'error',
      });
    });
  });
}

// ===================== API ROUTES =====================

// Tạo session mới (id ngẫu nhiên, phía client tự lưu để dùng lại)
app.post('/api/session', (req, res) => {
  const sessionId = crypto.randomBytes(16).toString('hex');
  res.json({ sessionId });
});

// Chạy code
app.post('/api/run', async (req, res) => {
  const { code, sessionId, stdin } = req.body || {};

  if (typeof code !== 'string' || code.length === 0) {
    return res.status(400).json({ error: 'Thiếu mã nguồn (code).' });
  }
  if (code.length > 50_000) {
    return res.status(400).json({ error: 'Mã nguồn quá dài (tối đa 50.000 ký tự).' });
  }
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId không hợp lệ. Hãy gọi /api/session trước.' });
  }
  if (typeof stdin === 'string' && stdin.length > 20_000) {
    return res.status(400).json({ error: 'Dữ liệu đầu vào (stdin) quá dài.' });
  }

  let release;
  try {
    release = await acquireSlot();
  } catch (e) {
    if (e.message === 'QUEUE_FULL') {
      return res.status(503).json({ error: 'Hệ thống đang bận (quá nhiều người chạy code cùng lúc). Vui lòng thử lại sau vài giây.' });
    }
    return res.status(504).json({ error: 'Hết thời gian chờ trong hàng đợi. Vui lòng thử lại.' });
  }

  try {
    const dir = await ensureSessionDir(sessionId);

    const currentSize = await getDirSize(dir);
    if (currentSize > SESSION_QUOTA_BYTES) {
      return res.status(413).json({
        error: `Không gian lưu trữ của bạn đã đầy (giới hạn 20MB). Hãy gọi /api/reset để dọn dẹp.`,
        usedBytes: currentSize,
      });
    }

    const result = await runPythonSandboxed(dir, code, stdin);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ khi chạy code: ' + err.message });
  } finally {
    release();
  }
});

// Xem dung lượng đã dùng
app.get('/api/usage/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId không hợp lệ.' });
  }
  const dir = sessionDir(sessionId);
  const usedBytes = await getDirSize(dir);
  res.json({
    usedBytes,
    quotaBytes: SESSION_QUOTA_BYTES,
    usedPercent: Math.round((usedBytes / SESSION_QUOTA_BYTES) * 100),
  });
});

// Xóa toàn bộ file của session (giải phóng dung lượng)
app.post('/api/reset', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId không hợp lệ.' });
  }
  const dir = sessionDir(sessionId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Không thể dọn dẹp: ' + err.message });
  }
});

// Trạng thái tải hệ thống (hiển thị cho người dùng nếu muốn)
app.get('/api/status', (req, res) => {
  res.json({
    running,
    queued: queue.length,
    maxConcurrent: MAX_CONCURRENT,
  });
});

app.listen(PORT, () => {
  console.log(`RunPy đang chạy tại http://localhost:${PORT}`);
});
