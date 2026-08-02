'use strict';

// ── CONFIG ──────────────────────────────────────────────────────
const SESSION_KEY = 'runpy_v2_session';

const STARTER_CODE = `print("Xin chào, RunPy!")

# Fibonacci với generator
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

for n in fib(10):
    print(n, end=' ')
print()
`;

// ── STATE ─────────────────────────────────────────────────────────
let editor    = null;
let isRunning = false;

// ── ELEMENTS ──────────────────────────────────────────────────────
const runBtn        = document.getElementById('runBtn');
const resetBtn      = document.getElementById('resetBtn');
const statusBadge   = document.getElementById('statusBadge');
const outputEl      = document.getElementById('output');
const stdinEl       = document.getElementById('stdin');
const quotaFill     = document.getElementById('quotaFill');
const quotaText     = document.getElementById('quotaText');
const runTime       = document.getElementById('runTime');
const cursorPos     = document.getElementById('cursorPos');
const copyBtn       = document.getElementById('copyBtn');
const clearBtn      = document.getElementById('clearBtn');
const copyOutputBtn = document.getElementById('copyOutputBtn');
const stdinToggle   = document.getElementById('stdinToggle');
const stdinPanel    = document.getElementById('stdinPanel');

// ── SESSION ───────────────────────────────────────────────────────
async function getOrCreateSession() {
  let sid = localStorage.getItem(SESSION_KEY);
  if (sid) return sid;
  try {
    const res  = await fetch('/api/session', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    localStorage.setItem(SESSION_KEY, data.sessionId);
    return data.sessionId;
  } catch (err) {
    console.error('[RunPy] getOrCreateSession failed:', err);
    throw err;
  }
}

function fmtBytes(b) {
  if (b < 1024)        return b + ' B';
  if (b < 1_048_576)   return (b / 1024).toFixed(1) + ' KB';
  return (b / 1_048_576).toFixed(2) + ' MB';
}

async function refreshQuota(sid) {
  try {
    const res  = await fetch(`/api/usage/${encodeURIComponent(sid)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d    = await res.json();
    quotaFill.style.width      = Math.min(d.usedPercent, 100) + '%';
    quotaText.textContent      = `${fmtBytes(d.usedBytes)} / 20 MB`;
    quotaFill.style.background = d.usedPercent > 90 ? '#f87171' : '';
  } catch (err) {
    console.error('[RunPy] refreshQuota failed:', err);
  }
}

// ── OUTPUT UTILS (XSS SAFE) ────────────────────────────────────────
// KHÔNG dùng innerHTML — luôn textContent để chặn XSS
function setOutput(text, stateClass) {
  outputEl.textContent = text;              // safe — không parse HTML
  outputEl.className   = 'output-area' + (stateClass ? ' ' + stateClass : '');
}

// ── STATUS ────────────────────────────────────────────────────────
function setStatus(state, label) {
  statusBadge.className   = 'status-badge ' + state;
  statusBadge.textContent = label;
  document.getElementById('sbStatus').textContent = label;
}

// ── SERVER STATUS POLL ────────────────────────────────────────────
async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return;
    const d = await r.json();
    const dot = document.querySelector('#sbQueue svg circle');
    if (!dot) return;
    if (d.running >= 8)      dot.setAttribute('fill', '#fbbf24');
    else if (d.running >= 5) dot.setAttribute('fill', '#86efac');
    else                     dot.setAttribute('fill', '#4ade80');
  } catch (err) {
    console.error('[RunPy] pollStatus failed:', err);
  }
}

// ── MONACO INIT ───────────────────────────────────────────────────
require(['vs/editor/editor.main'], function () {
  monaco.editor.defineTheme('runpy-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '',           foreground: 'e8e8e8', background: '0a0a0a' },
      { token: 'comment',    foreground: '3d3d3d', fontStyle: 'italic' },
      { token: 'keyword',    foreground: '81e6d9' },
      { token: 'string',     foreground: 'a8e6cf' },
      { token: 'number',     foreground: 'ffd6a5' },
      { token: 'type',       foreground: 'c3b1e1' },
      { token: 'function',   foreground: '87ceeb' },
      { token: 'operator',   foreground: 'c0cfe0' },
      { token: 'delimiter',  foreground: 'c0cfe0' },
      { token: 'delimiter.bracket', foreground: 'c0cfe0' },
      { token: 'delimiter.parenthesis', foreground: 'c0cfe0' },
      { token: 'delimiter.square', foreground: 'c0cfe0' },
      { token: 'delimiter.curly', foreground: 'c0cfe0' },
      { token: 'punctuation', foreground: 'c0cfe0' },
    ],
    colors: {
      'editor.background':                  '#0a0a0a',
      'editor.foreground':                  '#e8e8e8',
      'editor.lineHighlightBackground':     '#111111',
      'editor.selectionBackground':         '#1a3a3a',
      'editor.inactiveSelectionBackground': '#151515',
      'editorCursor.foreground':            '#4fd1c5',
      'editorLineNumber.foreground':        '#2e2e2e',
      'editorLineNumber.activeForeground':  '#555555',
      'editorWidget.background':            '#111111',
      'editorWidget.border':                '#1e1e1e',
      'input.background':                   '#161616',
      'input.border':                       '#2a2a2a',
      'scrollbarSlider.background':         '#1c1c1c',
      'scrollbarSlider.hoverBackground':    '#252525',
      'editorGutter.background':            '#0a0a0a',
      'minimap.background':                 '#0a0a0a',
    },
  });

  const savedCode = sessionStorage.getItem('runpy_code') || STARTER_CODE;

  editor = monaco.editor.create(document.getElementById('monacoEditor'), {
    value:                        savedCode,
    language:                     'python',
    theme:                        'runpy-dark',
    fontSize:                     13.5,
    fontFamily:                   "'Geist Mono', 'Cascadia Code', Consolas, monospace",
    fontLigatures:                true,
    lineHeight:                   22,
    padding:                      { top: 14, bottom: 14 },
    minimap:                      { enabled: false },
    scrollBeyondLastLine:         false,
    renderLineHighlight:          'line',
    renderWhitespace:             'none',
    cursorBlinking:               'smooth',
    cursorSmoothCaretAnimation:   'on',
    smoothScrolling:              true,
    tabSize:                      4,
    insertSpaces:                 true,
    wordWrap:                     'off',
    automaticLayout:              true,
    lineNumbers:                  'on',
    glyphMargin:                  false,
    folding:                      true,
    fixedOverflowWidgets:         true,
    quickSuggestions:             true,
    parameterHints:               { enabled: true },
    bracketPairColorization:      { enabled: true },
    guides:                       { bracketPairs: false, indentation: true },
    overviewRulerLanes:           0,
    hideCursorInOverviewRuler:    true,
    scrollbar: {
      vertical:              'auto',
      horizontal:            'auto',
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
    },
  });

  // Track cursor
  editor.onDidChangeCursorPosition(e => {
    cursorPos.textContent = `${e.position.lineNumber}:${e.position.column}`;
  });

  // Lưu code liên tục vào sessionStorage
  editor.onDidChangeModelContent(() => {
    sessionStorage.setItem('runpy_code', editor.getValue());
  });

  // Ctrl/Cmd+Enter → chạy
  editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => { if (!isRunning) runCode(); }
  );

  // Init
  getOrCreateSession()
    .then(refreshQuota)
    .catch(err => console.error('[RunPy] Init failed:', err));

  setInterval(pollStatus, 5_000);
});

// ── RUN CODE ──────────────────────────────────────────────────────
async function runCode() {
  if (isRunning) return;
  isRunning = true;

  let sid;
  try {
    sid = await getOrCreateSession();
  } catch {
    setOutput('⚠ Không thể tạo session. Tải lại trang.', 'has-error');
    isRunning = false;
    return;
  }

  const code  = editor.getValue();
  const stdin = stdinEl.value;

  // UI: running state
  runBtn.disabled = true;
  runBtn.classList.add('running');
  runBtn.innerHTML = `<span class="dots"><span></span><span></span><span></span></span> Đang chạy`;
  setStatus('running', 'Đang chạy...');
  setOutput('');
  runTime.textContent     = '';
  copyOutputBtn.style.display = 'none';

  const startedAt = performance.now();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, sessionId: sid, stdin }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('[RunPy] /api/run error:', res.status, data);
      setStatus('error', 'Lỗi');
      setOutput('⚠ ' + (data.error || 'Đã có lỗi xảy ra.'), 'has-error');
      return;
    }

    // Build output text — an toàn, dùng textContent
    const parts = [];
    if (data.stdout) parts.push(data.stdout);
    if (data.stderr) {
      if (parts.length) parts.push('');
      parts.push('── stderr ────────────────────────────');
      parts.push(data.stderr);
    }
    const outText = parts.join('\n') || '(Không có output)';

    runTime.textContent = `${data.durationMs}ms`;

    if (data.status === 'timeout') {
      setStatus('timeout', `Timeout ${data.durationMs}ms`);
      setOutput(outText, 'timeout');
    } else if (data.status === 'error') {
      setStatus('error', 'Có lỗi');
      setOutput(outText, 'has-error');
    } else {
      setStatus('ok', 'Thành công');
      setOutput(outText, 'ok');
    }

    copyOutputBtn.style.display = 'flex';

  } catch (err) {
    console.error('[RunPy] runCode fetch failed:', err);
    setStatus('error', 'Mất kết nối');
    setOutput('⚠ Không thể kết nối: ' + err.message, 'has-error');
  } finally {
    isRunning = false;
    runBtn.disabled = false;
    runBtn.classList.remove('running');
    runBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Chạy <span class="shortcut">⌘↵</span>`;
    refreshQuota(sid).catch(err => console.error('[RunPy] quota refresh failed:', err));
  }
}

// ── RESET ─────────────────────────────────────────────────────────
async function resetSession() {
  if (!confirm('Xóa toàn bộ file trong session?')) return;
  let sid;
  try {
    sid = await getOrCreateSession();
  } catch (err) {
    console.error('[RunPy] resetSession: cannot get session:', err);
    return;
  }
  try {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('[RunPy] resetSession failed:', err);
    setOutput('⚠ Không thể dọn dẹp: ' + err.message, 'has-error');
    return;
  }
  await refreshQuota(sid).catch(err => console.error('[RunPy] quota refresh failed:', err));
  setStatus('idle', 'Sẵn sàng');
  setOutput('Đã dọn dẹp session.');
  copyOutputBtn.style.display = 'none';
}

// ── STDIN TOGGLE ──────────────────────────────────────────────────
stdinToggle.addEventListener('click', () => {
  stdinPanel.classList.toggle('collapsed');
});

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;   // textContent — không XSS
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ── COPY ──────────────────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  const code = editor ? editor.getValue() : '';
  navigator.clipboard.writeText(code)
    .then(() => showToast('Đã sao chép code'))
    .catch(err => console.error('[RunPy] copy code failed:', err));
});

copyOutputBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(outputEl.textContent)
    .then(() => showToast('Đã sao chép kết quả'))
    .catch(err => console.error('[RunPy] copy output failed:', err));
});

clearBtn.addEventListener('click', () => {
  if (!editor) return;
  if (confirm('Xóa toàn bộ code?')) {
    editor.setValue('');
    editor.focus();
    sessionStorage.removeItem('runpy_code');
  }
});

// ── MAIN EVENTS ───────────────────────────────────────────────────
runBtn.addEventListener('click', runCode);
resetBtn.addEventListener('click', resetSession);
