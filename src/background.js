// background.js — 截图 + AI 分析 + 关闭外链标签页

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_tab_id') {
    sendResponse(sender.tab.id);
    return;
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'analyze_screenshot') {
    handleAnalyze(sender.tab.windowId, msg.isStuck)
      .then(sendResponse)
      .catch(e => sendResponse({ action: 'wait', reason: '分析失败: ' + e.message }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'agent_test') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'test_agent') {
      console.log('[课程助手] [port:agent_test] 收到测试请求:', { baseUrl: msg.baseUrl, model: msg.model });
      try {
        const result = await testAgent(msg.baseUrl, msg.apiKey, msg.model);
        port.postMessage(result);
      } catch (e) {
        console.error('[课程助手] [port:agent_test] 测试请求异常:', e);
        port.postMessage({ ok: false, detail: e.message });
      }
    }
  });
});

// 关闭从监控标签页打开的外链标签页
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.openerTabId) return;
  const data = await chrome.storage.local.get('monitoredTabId');
  if (tab.openerTabId !== data.monitoredTabId) return;

  setTimeout(() => {
    chrome.tabs.remove(tab.id, () =>
      console.log('[课程助手] 已关闭外链标签页，返回课程页')
    );
  }, 1500);
});

async function handleAnalyze(windowId, isStuck = false) {
  const config = await getConfig();
  if (!config.apiKey || !config.baseUrl || !config.model) {
    return { action: 'wait', reason: 'AI 未配置，请点击插件图标填写 API 信息' };
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const base64  = dataUrl.split(',')[1];

  console.log(`[课程助手] 发起 AI 请求: ${config.baseUrl} | model=${config.model} | isStuck=${isStuck}`);

  const prompt = isStuck
    ? `这是一个在线课程学习页面的截图，脚本已连续多个轮询周期停留此处，没有检测到倒计时或已知弹窗，需要你判断如何继续推进课程。

请按以下优先级判断：
1. 页面中间是否有「立即前往」「开始学习」「继续」「我知道了」等操作按钮 → action=click
2. 右上角是否有「下一个」导航按钮 → action=click，text="下一个"
3. 左侧课程列表中是否有下一个可点击的未完成课程项 → action=click，text=该课程项的文字
4. 如果是需要用户手动完成的任务（答题/填写表单）→ action=wait

只返回 JSON，不要其他文字，不要 <think> 标签：
{"action": "click"/"wait", "text": "要点击的按钮或链接文字，或null", "reason": "一句话说明"}`
    : `这是一个在线课程学习页面的截图。当前脚本停留在此页面，不确定下一步操作。

请判断：
1. 如果有可以直接点击的导航按钮（如"继续学习"、"下一步"、"开始学习"、"我知道了"等），返回 click 动作
2. 如果是需要用户手动完成的任务（答题/填写），返回 wait 动作
3. 如果视频正在播放或页面加载中，返回 wait 动作

只返回 JSON，不要其他文字，不要 <think> 标签：
{"action": "click"/"wait", "text": "要点击的按钮文字或null", "reason": "一句话说明"}`;

  const resp = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
        { type: 'text', text: prompt },
      ]}],
    }),
  });

  if (!resp.ok) {
    console.error(`[课程助手] AI API 请求失败: ${resp.status} ${resp.statusText}`);
    return { action: 'wait', reason: `AI 请求失败: ${resp.status}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    const raw = await resp.text().catch(() => '');
    console.error(`[课程助手] AI 响应体解析失败: ${e.message}`, raw.slice(0, 200));
    return { action: 'wait', reason: `AI 响应格式异常(${resp.status})，请检查 Base URL / Model 配置` };
  }
  let text = data.content?.[0]?.text?.trim() ?? '';
  if (text.includes('<think>')) text = text.split('</think>').pop().trim();
  if (text.includes('```'))     text = text.split('```')[1].replace(/^json/, '').trim();

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { result = JSON.parse(match[0]); } catch { /* fall through */ }
    }
    if (!result) {
      console.error('[课程助手] AI 回复解析失败:', text);
      return { action: 'wait', reason: 'AI 回复格式异常，等待下一轮重试' };
    }
  }

  console.log(`[课程助手] AI 回复:`, result);
  return result;
}

function getConfig() {
  return new Promise(resolve =>
    chrome.storage.sync.get('agentConfig', d => resolve(d.agentConfig || {}))
  );
}

async function testAgent(baseUrl, apiKey, model) {
  const url = `${baseUrl}/v1/messages`;
  console.log(`[课程助手] ▶ 测试 Agent: url=${url} | model=${model}`);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
  } catch (e) {
    console.error('[课程助手] ✗ 测试 fetch 网络错误:', e.message);
    return { ok: false, detail: `网络错误: ${e.message}（请检查 Base URL 是否可达）` };
  }
  if (resp.ok) {
    console.log('[课程助手] ✓ 测试成功, HTTP', resp.status);
    return { ok: true };
  }
  let detail = `HTTP ${resp.status}`;
  try {
    const err = await resp.json();
    if (err.error?.message) detail += ` ${err.error.message}`;
    console.error('[课程助手] ✗ 测试失败:', resp.status, JSON.stringify(err));
  } catch {
    const text = await resp.text().catch(() => '');
    console.error('[课程助手] ✗ 测试失败:', resp.status, text.slice(0, 200));
  }
  return { ok: false, detail };
}
