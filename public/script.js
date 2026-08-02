const codeEl = document.getElementById('code');
const stdinEl = document.getElementById('stdin');
const outputEl = document.getElementById('output');
const runBtn = document.getElementById('runBtn');
const resetBtn = document.getElementById('resetBtn');
const statusBadge = document.getElementById('statusBadge');
const quotaFill = document.getElementById('quotaFill');
const quotaText = document.getElementById('quotaText');

const SESSION_KEY = 'runpy_session_id';

async function getOrCreateSession() {
  let sid = localStorage.getItem(SESSION_KEY);
  if (sid) return sid;
  const res = await fetch('/api/session', { method: 'POST' });
  const data = await res.json();
  localStorage.setItem(SESSION_KEY, data.sessionId);
  return data.sessionId;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function refreshQuota(sid) {
  try {
    const res = await fetch(`/api/usage/${sid}`);
    const data = await res.json();
    quotaFill.style.width = Math.min(data.usedPercent, 100) + '%';
    quotaText.textContent = `${fmtBytes(data.usedBytes)} / 20 MB`;
    if (data.usedPercent > 90) {
      quotaFill.style.background = '#fc8181';
    } else {
      quotaFill.style.background = '';
    }
  } catch {}
}

function setStatus(state, label) {
  statusBadge.className = 'status-badge ' + state;
  statusBadge.textContent = label;
}

async function runCode() {
  const sid = await getOrCreateSession();
  const code = codeEl.value;
  const stdin = stdinEl.value;

  runBtn.disabled = true;
  setStatus('running', 'Đang chạy...');
  outputEl.classList.remove('has-error');
  outputEl.textContent = '⏳ Đang gửi code lên máy chủ...';

  const startedAt = performance.now();
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, sessionId: sid, stdin }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus('error', 'Lỗi');
      outputEl.classList.add('has-error');
      outputEl.textContent = '⚠️ ' + (data.error || 'Đã có lỗi xảy ra.');
      return;
    }

    let text = '';
    if (data.stdout) text += data.stdout;
    if (data.stderr) text += (text ? '\n\n' : '') + '--- STDERR ---\n' + data.stderr;
    if (!text) text = '(Không có kết quả in ra)';

    const clientMs = Math.round(performance.now() - startedAt);
    text += `\n\n[Hoàn thành trong ${data.durationMs}ms · tổng thời gian yêu cầu ${clientMs}ms]`;

    if (data.status === 'timeout') {
      setStatus('timeout', 'Hết thời gian (8s)');
      outputEl.classList.add('has-error');
    } else if (data.status === 'error') {
      setStatus('error', 'Có lỗi');
      outputEl.classList.add('has-error');
    } else {
      setStatus('ok', 'Thành công');
    }
    outputEl.textContent = text;
  } catch (err) {
    setStatus('error', 'Lỗi kết nối');
    outputEl.classList.add('has-error');
    outputEl.textContent = '⚠️ Không thể kết nối tới máy chủ: ' + err.message;
  } finally {
    runBtn.disabled = false;
    refreshQuota(sid);
  }
}

async function resetSession() {
  const sid = await getOrCreateSession();
  if (!confirm('Xóa toàn bộ file trong không gian lưu trữ của bạn?')) return;
  await fetch('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid }),
  });
  await refreshQuota(sid);
  setStatus('idle', 'Sẵn sàng');
  outputEl.classList.remove('has-error');
  outputEl.textContent = 'Đã dọn dẹp không gian lưu trữ.';
}

runBtn.addEventListener('click', runCode);
resetBtn.addEventListener('click', resetSession);
codeEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runCode();
  }
});

// Tự tạo/khôi phục session và cập nhật dung lượng khi tải trang
getOrCreateSession().then(refreshQuota);
