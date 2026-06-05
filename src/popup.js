// ─── 代课助手开关 ──────────────────────────────────────────
let currentTab = null;
let timerInterval = null;
let monitorStartTime = null;

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateToggleBtn(isOn) {
  const btn = document.getElementById('btn-toggle');
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (isOn && monitorStartTime) {
    const tick = () => { btn.textContent = formatElapsed(Date.now() - monitorStartTime); };
    tick();
    timerInterval = setInterval(tick, 1000);
    btn.style.background = '#d93025';
  } else {
    btn.textContent = '开始';
    btn.style.background = '#1a73e8';
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  currentTab = tab;
  document.getElementById('monitor-url').textContent = tab.url || '';
  document.getElementById('monitor-url').title = tab.url || '';
  chrome.storage.local.get(['monitoredTabId', 'monitorStartTime'], (data) => {
    const isOn = data.monitoredTabId === tab.id;
    if (isOn && data.monitorStartTime) monitorStartTime = data.monitorStartTime;
    updateToggleBtn(isOn);
  });
});

document.getElementById('btn-toggle').addEventListener('click', () => {
  chrome.storage.local.get(['monitoredTabId', 'monitorStartTime'], (data) => {
    const isOn = data.monitoredTabId === currentTab.id;
    if (isOn) {
      chrome.storage.local.remove(['monitoredTabId', 'monitorStartTime']);
      monitorStartTime = null;
      updateToggleBtn(false);
      showSaved('已停止代课助手');
    } else {
      const startTime = Date.now();
      chrome.storage.local.set({ monitoredTabId: currentTab.id, monitorStartTime: startTime });
      monitorStartTime = startTime;
      updateToggleBtn(true);
      showSaved('已开启代课助手 ✓');
    }
  });
});

// ─── Agent 配置 ───────────────────────────────────────────
chrome.storage.sync.get('agentConfig', (data) => {
  const c = data.agentConfig || {};
  document.getElementById('ai-url').value   = c.baseUrl  || '';
  document.getElementById('ai-key').value   = c.apiKey   || '';
  document.getElementById('ai-model').value = c.model    || '';
});

// 轮询间隔：变更即存，不走 Agent 保存按钮
chrome.storage.sync.get('agentConfig', (data) => {
  if (data.agentConfig?.interval) document.getElementById('ai-interval').value = data.agentConfig.interval;
});
document.getElementById('ai-interval').addEventListener('change', () => {
  const interval = parseInt(document.getElementById('ai-interval').value);
  chrome.storage.sync.get('agentConfig', (d) => {
    const agentConfig = d.agentConfig || {};
    agentConfig.interval = interval;
    chrome.storage.sync.set({ agentConfig });
  });
});

document.getElementById('btn-save-ai').addEventListener('click', () => {
  const agentConfig = {
    baseUrl: document.getElementById('ai-url').value.trim().replace(/\/$/, ''),
    apiKey:  document.getElementById('ai-key').value.trim(),
    model:   document.getElementById('ai-model').value.trim(),
  };
  chrome.storage.sync.get('agentConfig', (d) => {
    agentConfig.interval = d.agentConfig?.interval || 20;
    chrome.storage.sync.set({ agentConfig }, () => showSaved('Agent 配置已保存 ✓'));
  });
});

// ─── 测试 Agent 配置 ────────────────────────────────────
let testResultTimer = null;

function showTestResult(msg, type = 'info') {
  const el = document.getElementById('test-result');
  if (testResultTimer) { clearTimeout(testResultTimer); testResultTimer = null; }
  el.className = 'test-result ' + type;
  el.textContent = msg;
  // 成功保留 8s，失败保留 15s（方便用户排查）
  const keep = type === 'error' ? 15000 : 8000;
  testResultTimer = setTimeout(() => { el.textContent = ''; el.className = 'test-result'; }, keep);
}

document.getElementById('btn-test-ai').addEventListener('click', async () => {
  const baseUrl = document.getElementById('ai-url').value.trim().replace(/\/$/, '');
  const apiKey  = document.getElementById('ai-key').value.trim();
  const model   = document.getElementById('ai-model').value.trim();
  if (!baseUrl || !apiKey || !model) {
    showTestResult('请先填写 Base URL、API Key、Model', 'error');
    return;
  }

  const btn = document.getElementById('btn-test-ai');
  btn.disabled = true;
  btn.textContent = '测试中...';
  showTestResult('正在唤醒 service worker ...', 'info');
  console.log('[课程助手] 开始测试 Agent 配置:', { baseUrl, model });

  // 两步连接：先用 sendMessage 唤醒 service worker，再建立持久 port
  // 这是 Chrome Manifest V3 处理休眠 service worker 的标准做法
  try {
    await chrome.runtime.sendMessage({ type: 'ping' });
    console.log('[课程助手] service worker 已唤醒');
  } catch (e) {
    console.error('[课程助手] 唤醒 service worker 失败:', e.message);
    btn.disabled = false;
    btn.textContent = '测试';
    showTestResult('连接失败: service worker 无法唤醒，请重新加载插件', 'error');
    return;
  }

  let port;
  try {
    port = chrome.runtime.connect({ name: 'agent_test' });
  } catch (e) {
    console.error('[课程助手] 建立端口失败:', e.message);
    btn.disabled = false;
    btn.textContent = '测试';
    showTestResult('连接失败: ' + (e.message || 'service worker 无法连接'), 'error');
    return;
  }

  showTestResult('正在请求 ' + baseUrl + ' ...', 'info');

  port.onMessage.addListener((result) => {
    btn.disabled = false;
    btn.textContent = '测试';
    if (result.ok) {
      console.log('[课程助手] 测试成功 ✓');
      showTestResult('连接成功，模型可用 ✓', 'success');
    } else {
      console.error('[课程助手] 测试失败:', result.detail);
      showTestResult('请求失败: ' + result.detail, 'error');
    }
  });
  port.onDisconnect.addListener(() => {
    btn.disabled = false;
    btn.textContent = '测试';
    const err = chrome.runtime.lastError;
    if (err) {
      console.error('[课程助手] 测试端口断开:', err.message);
      showTestResult('连接失败: ' + err.message, 'error');
    }
  });
  port.postMessage({ type: 'test_agent', baseUrl, apiKey, model });
});

// ─── 防挂机策略 ──────────────────────────────────────────
let rules = [];

function render() {
  const tbody = document.getElementById('rules-body');
  tbody.innerHTML = '';
  if (rules.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无规则</td></tr>';
    return;
  }
  rules.forEach((rule, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="indicator">${rule.indicator}</td>
      <td>${rule.button}</td>
      <td><button class="del" data-i="${i}" title="删除">✕</button></td>
    `;
    tbody.appendChild(tr);
  });
}

function saveRules(msg = '已保存 ✓') {
  chrome.storage.sync.set({ popupRules: rules }, () => showSaved(msg));
}

chrome.storage.sync.get('popupRules', (data) => {
  rules = (data.popupRules && data.popupRules.length) ? data.popupRules : [...DEFAULT_CONFIG.popupRules];
  render();
});

document.getElementById('rules-body').addEventListener('click', (e) => {
  if (!e.target.classList.contains('del')) return;
  rules.splice(parseInt(e.target.dataset.i), 1);
  render();
  saveRules('已删除 ✓');
});

document.getElementById('btn-add').addEventListener('click', () => {
  const indicator = document.getElementById('inp-indicator').value.trim();
  const button    = document.getElementById('inp-button').value.trim();
  if (!indicator || !button) return;
  rules.push({ indicator, button });
  document.getElementById('inp-indicator').value = '';
  document.getElementById('inp-button').value    = '';
  render();
  saveRules();
});

['inp-indicator', 'inp-button'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-add').click();
  });
});

// ─── 工具 ──────────────────────────────────────────────
function showSaved(msg) {
  const el = document.getElementById('saved-msg');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 2000);
}
