const DEFAULT_INTERVAL = 20;
const AI_COOLDOWN      = 2 * 60 * 1000;
const STUCK_THRESHOLD  = 3;

let popupRules   = [...DEFAULT_CONFIG.popupRules];
let lastAiCallTs = 0;
let aiPending    = false;
let timerId      = null;
let myTabId      = null;
let stuckCount   = 0;
let prevRemaining = null;
let externalTimer = null;

// ─── 初始化 ────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'get_tab_id' }, (tabId) => {
  myTabId = tabId;
  checkIfMonitored();
});

function checkIfMonitored() {
  chrome.storage.local.get('monitoredTabId', (data) => {
    if (data.monitoredTabId !== myTabId) return;
    chrome.storage.sync.get(['popupRules', 'agentConfig'], (data) => {
      if (data.popupRules?.length) popupRules = data.popupRules;
      const interval = data.agentConfig?.interval || DEFAULT_INTERVAL;
      startTimer(interval);
      console.log(`[课程助手] 代课助手模式已启动，轮询间隔 ${interval}s`);
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.monitoredTabId) {
    const newId = changes.monitoredTabId.newValue;
    if (newId === myTabId)                          checkIfMonitored();
    else if (changes.monitoredTabId.oldValue === myTabId) stopTimer();
  }
  if (area === 'sync' && timerId) {
    if (changes.popupRules) popupRules = changes.popupRules.newValue;
    if (changes.agentConfig) {
      const interval = changes.agentConfig.newValue?.interval || DEFAULT_INTERVAL;
      startTimer(interval);
    }
  }
});

function startTimer(intervalSec) {
  if (timerId) clearInterval(timerId);
  timerId = setInterval(check, intervalSec * 1000);
}

function stopTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
  clearExternalTimer();
  console.log('[课程助手] 代课助手模式已停止');
}

function clearExternalTimer() {
  if (externalTimer) { clearTimeout(externalTimer); externalTimer = null; }
}

// ─── 弹窗处理 ──────────────────────────────────────────
function dismissPopup() {
  const body = document.body.innerText;
  for (const { indicator, button } of popupRules) {
    if (!body.includes(indicator)) continue;
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.innerText?.trim() === button) {
        console.log(`[课程助手] 检测到弹窗，点击"${button}"`);
        btn.click();
        return true;
      }
    }
  }
  return false;
}

// ─── 外链打卡页 ────────────────────────────────────────
const EXTERNAL_LINK_BTNS = ['立即前往', '前往查看', '立即查看'];

function handleExternalLinkPage() {
  const candidates = document.querySelectorAll('button, a, [role="button"]');
  for (const el of candidates) {
    const text = el.innerText?.trim();
    if (EXTERNAL_LINK_BTNS.includes(text)) {
      console.log(`[课程助手] 检测到"${text}"，点击并等待关闭外链...`);
      el.click();
      clearExternalTimer();
      externalTimer = setTimeout(() => {
        externalTimer = null;
        clickByText('下一个') || clickByText('下一节') || clickByText('下一课');
      }, 3000);
      return true;
    }
  }
  return false;
}

// ─── 倒计时 ────────────────────────────────────────────
function getRemaining() {
  const text = document.body.innerText;
  if (!text.includes('可完成本课程学习')) return null;
  const mMatch = text.match(/还需[^可]*?(\d+)\s*分钟/);
  const sMatch = text.match(/还需[^可]*?(\d+)\s*秒/);
  return (mMatch ? parseInt(mMatch[1]) : 0) * 60 + (sMatch ? parseInt(sMatch[1]) : 0);
}

// ─── 点击播放（视频暂停时）─────────────────────────────
function clickPlay() {
  const video = document.querySelector('video');
  if (video) {
    if (video.paused) {
      console.log('[课程助手] 视频暂停，点击播放');
      video.play();
      return true;
    }
  }
  const candidates = document.querySelectorAll('button, a, [role="button"], .vjs-play-control');
  for (const el of candidates) {
    const text = el.innerText?.trim() || '';
    const aria = el.getAttribute('aria-label') || '';
    const cls  = el.className || '';
    if (text.includes('播放') || aria.includes('播放') || cls.includes('play')) {
      console.log(`[课程助手] 点击播放按钮`);
      el.click();
      return true;
    }
  }
  return false;
}

// ─── 点击导航按钮 ──────────────────────────────────────
function clickByText(btnText) {
  const candidates = document.querySelectorAll('button, a, [role="button"]');
  for (const el of candidates) {
    const text = el.innerText?.trim();
    if (text === btnText) {
      console.log(`[课程助手] 点击: "${text}"`);
      el.click();
      return true;
    }
  }
  if (btnText.length < 2) return false;
  for (const el of candidates) {
    const text = el.innerText?.trim();
    if (text && text.includes(btnText)) {
      console.log(`[课程助手] 模糊点击: "${text}"`);
      el.click();
      return true;
    }
  }
  return false;
}

// ─── AI 截图分析 ────────────────────────────────────────
function triggerAiAnalysis(isStuck = false) {
  const now = Date.now();
  if (aiPending || now - lastAiCallTs < AI_COOLDOWN) return;
  aiPending    = true;
  lastAiCallTs = now;
  console.log(`[课程助手] 截图发给 AI 分析（isStuck=${isStuck}）...`);

  chrome.runtime.sendMessage({ type: 'analyze_screenshot', isStuck }, (result) => {
    aiPending = false;
    if (!result) { console.warn('[课程助手] AI 无响应'); return; }
    console.log(`[课程助手] AI 判断: ${result.reason}（action=${result.action}）`);
    if (result.action === 'click' && result.text) {
      const clicked = clickByText(result.text);
      if (clicked) stuckCount = 0;
    }
  });
}

// ─── 主循环 ────────────────────────────────────────────
function check() {
  clearExternalTimer();

  // 1. 弹窗
  if (dismissPopup()) { stuckCount = 0; prevRemaining = null; return; }

  // 2. 外链打卡页
  if (handleExternalLinkPage()) { stuckCount = 0; prevRemaining = null; return; }

  // 3. 倒计时
  const totalSeconds = getRemaining();

  if (totalSeconds !== null) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;

    if (totalSeconds === 0) {
      console.log('[课程助手] 学习时长已满足，点击下一个...');
      clickByText('下一个') || clickByText('下一节') || clickByText('下一课');
      prevRemaining = null;
    } else if (prevRemaining !== null && totalSeconds === prevRemaining) {
      console.log(`[课程助手] 倒计时 ${m}分${s}秒 未变化，可能视频暂停，尝试播放`);
      clickPlay();
    } else {
      console.log(`[课程助手] 还需 ${m}分${s}秒`);
    }

    prevRemaining = totalSeconds;
    stuckCount = 0;
    return;
  }

  // 4. 未知状态
  stuckCount++;
  prevRemaining = null;
  console.log(`[课程助手] 无进展 (${stuckCount}/${STUCK_THRESHOLD})`);
  if (stuckCount >= STUCK_THRESHOLD) {
    stuckCount = 0;
    triggerAiAnalysis(true);
  }
}
