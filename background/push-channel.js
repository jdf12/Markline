// background/push-channel.js
// RSS 资讯推送通道（邮箱通知）
// - 挂载到 onFeedPollComplete 钩子
// - 推送策略：instant 即时 / batch30|60|180 聚合窗口 / daily 每日早报
// - 频率控制：最小间隔、每日上限、静默时段
// - API Key 加密存储（见 push-store.js），调用时临时解密，用完即丢
// - 聚合模式通过 chrome.alarms 调度，到期后 drainQueue 合并发送
//
// 依赖：PushStore, fetch, chrome.alarms

(function (global) {
  'use strict';

  const RESEND_ENDPOINT = 'https://api.resend.com/emails';
  const REQUEST_TIMEOUT_MS = 15000;
  const MAX_ARTICLES_PER_EMAIL = 20;
  const SUMMARY_LEN = 120;
  const ALARM_NAME = 'push-flush';

  // 策略对应的聚合窗口(分钟)
  const STRATEGY_WINDOW_MIN = {
    instant: 0,
    batch30: 30,
    batch60: 60,
    batch180: 180,
    daily: 1440
  };

  // ===== HTTP API Provider 预置表 =====
  const HTTP_PROVIDERS = {
    resend:   { endpoint: 'https://api.resend.com/emails', authType: 'bearer', defaultFrom: 'Markline <onboarding@resend.dev>' },
    sendgrid: { endpoint: 'https://api.sendgrid.com/v3/mail/send', authType: 'bearer', defaultFrom: '' },
    mailgun:  { endpoint: 'https://api.mailgun.net/v3/messages', authType: 'bearer', defaultFrom: '' },
    custom:   { endpoint: '', authType: 'bearer', defaultFrom: '' }
  };

  // ===== SMTP Provider 预置表 =====
  const SMTP_PROVIDERS = {
    gmail:        { host: 'smtp.gmail.com',              port: 465, tls: 'ssl',      label: 'Gmail' },
    qq:           { host: 'smtp.qq.com',                 port: 465, tls: 'ssl',      label: 'QQ 邮箱' },
    163:          { host: 'smtp.163.com',                port: 465, tls: 'ssl',      label: '网易 163 邮箱' },
    '126':        { host: 'smtp.126.com',                port: 465, tls: 'ssl',      label: '网易 126 邮箱' },
    outlook:      { host: 'smtp-mail.outlook.com',       port: 587, tls: 'starttls', label: 'Outlook' },
    aliyun:       { host: 'smtp.qiye.aliyun.com',        port: 465, tls: 'ssl',      label: '阿里企业邮箱' },
    sina:         { host: 'smtp.sina.com',               port: 465, tls: 'ssl',      label: '新浪邮箱' },
    sohu:         { host: 'smtp.sohu.com',               port: 465, tls: 'ssl',      label: '搜狐邮箱' },
    '189':        { host: 'smtp.189.cn',                 port: 465, tls: 'ssl',      label: '天翼 189 邮箱' },
    feishu:       { host: 'smtp.feishu.cn',              port: 465, tls: 'ssl',      label: '飞书邮箱' },
    'custom-smtp': { host: '', port: 465, tls: 'ssl',    label: '自定义 SMTP' }
  };

  // ===== i18n 占位 =====
  const _zhMap = {
    emailSubjectSingle: 'Markline · 新资讯：$1',
    emailSubjectMulti: 'Markline · $1 篇新资讯',
    emailSubjectTest: 'Markline 推送测试',
    emailSubjectDigest: 'Markline · 资讯聚合（$1 篇）'
  };
  function _t(key) {
    if (typeof global.i18n === 'function') {
      try { return global.i18n(key) || _zhMap[key] || key; } catch {}
    }
    return _zhMap[key] || key;
  }

  // ===== HTML 转义 =====
  function _esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ===== 文章过滤：关键词 include/exclude =====
  function _filterByKeywords(items, keywords) {
    if (!keywords) return items;
    const inc = (keywords.include || []).filter(Boolean);
    const exc = (keywords.exclude || []).filter(Boolean);
    return items.filter(it => {
      const text = ((it.title || '') + ' ' + (it.summary || '')).toLowerCase();
      if (exc.length && exc.some(k => text.includes(k.toLowerCase()))) return false;
      if (inc.length && !inc.some(k => text.includes(k.toLowerCase()))) return false;
      return true;
    });
  }

  // ===== 渲染邮件 HTML（支持多 feed 聚合）=====
  function _renderEmailHtml(items) {
    // 按 feed 分组
    const groups = {};
    for (const e of items) {
      const key = e.feedTitle || e.feedId || 'RSS';
      if (!groups[key]) groups[key] = [];
      groups[key].push(e.item);
    }

    const sections = Object.keys(groups).map(feedTitle => {
      const feedItems = groups[feedTitle].slice(0, MAX_ARTICLES_PER_EMAIL);
      const list = feedItems.map(it => {
        const title = _esc(it.title || '(无标题)');
        const link = _esc(it.link || '');
        const summary = _esc((it.summary || '').slice(0, SUMMARY_LEN));
        const img = it.imageUrl ? `<img src="${_esc(it.imageUrl)}" style="max-width:100%;max-height:160px;border-radius:6px;margin:8px 0;" />` : '';
        const pubDate = it.publishedAt
          ? new Date(it.publishedAt).toLocaleString()
          : '';
        return `
          <div style="margin-bottom:20px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">
            <a href="${link}" style="color:#4B3FE3;text-decoration:none;font-size:16px;font-weight:600;">${title}</a>
            ${img}
            ${summary ? `<p style="color:#52525B;font-size:14px;line-height:1.6;margin:8px 0 0 0;">${summary}${(it.summary||'').length > SUMMARY_LEN ? '...' : ''}</p>` : ''}
            ${pubDate ? `<p style="color:#A1A1AA;font-size:12px;margin:8px 0 0 0;">${pubDate}</p>` : ''}
          </div>`;
      }).join('');
      return `
        <div style="margin-bottom:24px;">
          <h3 style="color:#1A1759;font-size:15px;margin:0 0 12px 0;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">${_esc(feedTitle)}</h3>
          ${list}
        </div>`;
    }).join('');

    return `
      <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;">
        <h2 style="color:#1A1759;margin:0 0 8px 0;">Markline · 资讯聚合</h2>
        <p style="color:#A1A1AA;font-size:13px;margin:0 0 24px 0;">共 ${items.length} 篇新文章</p>
        ${sections}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#A1A1AA;font-size:12px;text-align:center;">— Markline · RSS Push —</p>
      </div>`;
  }

  // ===== HTTP API 模式：调用 Provider 端点 =====
  async function _sendViaHttp(settings, apiKey, subject, html) {
    const provider = settings.email.provider || 'resend';
    const preset = HTTP_PROVIDERS[provider] || HTTP_PROVIDERS.resend;
    const endpoint = settings.email.endpoint || preset.endpoint;
    // 预置 provider 强制使用 preset.authType；仅 custom 模式才允许用户自定义
    const authType = provider === 'custom' ? (settings.email.authType || 'bearer') : preset.authType;
    const from = settings.email.from || preset.defaultFrom || 'Markline <noreply@markline.local>';
    const to = settings.email.to;

    if (!endpoint) return { ok: false, error: 'no_endpoint' };

    // 构造鉴权 Header
    const headers = { 'Content-Type': 'application/json' };
    if (authType === 'bearer') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else if (authType === 'xapikey') {
      headers['X-API-Key'] = apiKey;
    } else if (authType === 'basic') {
      headers['Authorization'] = `Basic ${btoa(apiKey)}`;
    }

    // 构造请求体（Resend/Custom 通用格式，SendGrid/Mailgun 需适配）
    let body;
    if (provider === 'sendgrid') {
      body = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/html', value: html }]
      };
    } else if (provider === 'mailgun') {
      body = { from, to, subject, html };
    } else {
      // resend / custom
      body = { from, to: [to], subject, html };
    }

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit'
      });
      clearTimeout(tid);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { ok: false, status: resp.status, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      }
      const data = await resp.json().catch(() => ({}));
      return { ok: true, id: data.id || '' };
    } catch (e) {
      clearTimeout(tid);
      return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // ===== SMTP 模式：通过本地桥接程序发送 =====
  // MV3 Service Worker 不支持 chrome.sockets.tcp，无法直连 SMTP 服务器。
  // 改为通过本地 Python 桥接程序（smtp_bridge.py）转发，监听 127.0.0.1:7821。
  const BRIDGE_BASE = 'http://127.0.0.1:7821';

  async function _sendViaSmtp(settings, password, subject, html) {
    const provider = settings.email.provider || 'gmail';
    const preset = SMTP_PROVIDERS[provider] || SMTP_PROVIDERS.gmail;
    const host = settings.email.smtpHost || preset.host;
    const port = settings.email.smtpPort || preset.port;
    const tls = settings.email.smtpTls || preset.tls;
    const from = settings.email.from || settings.email.username;
    const username = settings.email.username || from;
    const to = settings.email.to;

    if (!host) return { ok: false, error: 'no_smtp_host' };

    // 调用本地桥接程序 HTTP 接口（授权码用完即丢，桥接不持久化）
    try {
      const resp = await fetch(`${BRIDGE_BASE}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host, port, tls,
          username, password,
          from, fromName: 'Markline',
          to, subject, html
        })
      });
      if (!resp.ok) {
        return { ok: false, error: `bridge_http_${resp.status}` };
      }
      const data = await resp.json();
      return data;
    } catch (err) {
      // 桥接程序未运行或连接失败
      if (err && (err.name === 'TypeError' || /Failed to fetch|NetworkError/i.test(err.message))) {
        return { ok: false, error: 'bridge_not_running' };
      }
      return { ok: false, error: `bridge_error: ${err.message || String(err)}` };
    }
  }

  // 检测本地桥接程序是否在运行（供设置页调用）
  async function checkBridgeHealth() {
    try {
      const resp = await fetch(`${BRIDGE_BASE}/health`, { method: 'GET' });
      if (!resp.ok) return { ok: false, running: false };
      const data = await resp.json();
      return { ok: true, running: true, version: data.version };
    } catch {
      return { ok: false, running: false };
    }
  }

  // ===== 实际发送一封邮件（含频率检查与状态记录）=====
  async function _doSend(subject, html) {
    const settings = await PushStore.getSettings();
    if (!settings.email || !settings.email.to) return { ok: false, error: 'no_recipient' };

    // 频率检查
    const rateCheck = await PushStore.checkRateLimit(settings);
    if (!rateCheck.allowed) {
      return { ok: false, error: rateCheck.reason, skipped: true };
    }

    let result;
    const providerType = settings.email.providerType || 'http';
    const provider = settings.email.provider || (providerType === 'smtp' ? 'gmail' : 'resend');

    if (providerType === 'smtp') {
      // SMTP 模式：按 provider 解密授权码
      const password = await PushStore.getDecryptedSmtpPassForProvider(provider);
      if (!password) return { ok: false, error: 'no_smtp_password' };
      result = await _sendViaSmtp(settings, password, subject, html);
      // password 在此之后不再被引用，函数返回即被 GC
    } else {
      // HTTP API 模式：按 provider 解密 API Key
      const apiKey = await PushStore.getDecryptedApiKeyForProvider(provider);
      if (!apiKey) return { ok: false, error: 'no_api_key' };
      result = await _sendViaHttp(settings, apiKey, subject, html);
    }

    if (result.ok) {
      await PushStore.recordSend();
      console.info('[Push] email sent, subject=', subject, 'id=', result.id);
    } else {
      console.warn('[Push] email failed:', result.error);
    }
    return result;
  }

  // ===== 聚合刷新：把队列中所有待推送条目合并为一封邮件 =====
  async function flushQueue() {
    const queue = await PushStore.drainQueue();
    if (queue.length === 0) return { ok: false, skipped: true, reason: 'empty_queue' };

    const settings = await PushStore.getSettings();
    const filtered = _filterByKeywords(
      queue.map(e => ({ ...e.item, feedTitle: e.feedTitle })),
      settings.keywords
    );
    // 还原结构给渲染器
    const entries = queue.filter(e => {
      const it = { ...e.item, feedTitle: e.feedTitle };
      const text = ((it.title || '') + ' ' + (it.summary || '')).toLowerCase();
      const inc = (settings.keywords?.include || []).filter(Boolean);
      const exc = (settings.keywords?.exclude || []).filter(Boolean);
      if (exc.length && exc.some(k => text.includes(k.toLowerCase()))) return false;
      if (inc.length && !inc.some(k => text.includes(k.toLowerCase()))) return false;
      return true;
    });
    if (entries.length === 0) return { ok: false, skipped: true, reason: 'filtered_out' };

    const subject = _t('emailSubjectDigest').replace('$1', String(entries.length));
    const html = _renderEmailHtml(entries);
    return _doSend(subject, html);
  }

  // ===== onFeedPollComplete 钩子入口 =====
  async function onPollComplete(results) {
    if (!Array.isArray(results)) return;
    const settings = await PushStore.getSettings();
    if (!settings.enabled) return;

    const strategy = settings.strategy || 'batch30';
    const windowMin = STRATEGY_WINDOW_MIN[strategy] ?? 30;

    for (const r of results) {
      if (!r || !r.added || r.added.length === 0) continue;
      const feed = r.feed || { title: r.feedTitle || 'RSS', id: r.feedId };
      // feed 级别开关
      const pushTo = settings.feedPushTo[r.feedId];
      if (pushTo && !pushTo.includes('email')) continue;

      // 关键词过滤后入队
      const filtered = _filterByKeywords(r.added, settings.keywords);
      if (filtered.length === 0) continue;

      if (strategy === 'instant') {
        // 即时模式：每 feed 一封邮件
        try {
          await _pushFeedInstant(feed, filtered);
        } catch (e) {
          console.warn('[Push] instant error:', e.message);
        }
      } else {
        // 聚合模式：入队等待 flush
        await PushStore.enqueueItems(feed, filtered);
      }
    }

    // 聚合模式：确保 alarm 已注册
    if (strategy !== 'instant' && windowMin > 0) {
      _ensureFlushAlarm(windowMin);
    }
  }

  // ===== 即时模式：单 feed 单邮件 =====
  async function _pushFeedInstant(feed, items) {
    const subject = items.length === 1
      ? _t('emailSubjectSingle').replace('$1', items[0].title || '新文章')
      : _t('emailSubjectMulti').replace('$1', String(items.length));

    // 复用聚合渲染器，构造单 feed 结构
    const entries = items.map(it => ({
      feedTitle: feed.title || 'RSS',
      item: it
    }));
    const html = _renderEmailHtml(entries);
    return _doSend(subject, html);
  }

  // ===== 注册/刷新聚合 alarm =====
  function _ensureFlushAlarm(windowMin) {
    // 检查是否已有同名 alarm
    chrome.alarms.get(ALARM_NAME, (existing) => {
      if (existing) return; // 已有待触发的 alarm，等它到期
      // delayInMinutes 使用窗口的一半，确保在窗口内被触发
      const delay = Math.max(1, Math.floor(windowMin / 2));
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    });
  }

  // ===== alarm 监听：触发时 flush 队列 =====
  function _onAlarm(alarm) {
    if (alarm.name !== ALARM_NAME) return;
    flushQueue().catch(e => console.warn('[Push] flush error:', e.message));
  }

  // ===== 启动时检查队列中是否有残留（SW 重启后继续推送）=====
  async function _init() {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    chrome.alarms.onAlarm.addListener(_onAlarm);
    // 检查是否有遗留队列，若有时机合适的策略则重新调度
    const queue = await PushStore.getQueue();
    if (queue.length > 0) {
      const settings = await PushStore.getSettings();
      if (settings.enabled && settings.strategy !== 'instant') {
        const windowMin = STRATEGY_WINDOW_MIN[settings.strategy] ?? 30;
        _ensureFlushAlarm(windowMin);
      }
    }
  }

  // ===== 测试邮件（供设置页调用，绕过频率限制）=====
  async function sendTestEmail() {
    const settings = await PushStore.getSettings();
    if (!settings.email || !settings.email.to) {
      return { ok: false, error: 'recipient_empty' };
    }

    const subject = _t('emailSubjectTest');
    const html = `<div style="font-family:sans-serif;padding:24px;color:#171717;">
        <h2 style="color:#4B3FE3;">Markline 推送测试</h2>
        <p>这是一封来自 Markline RSS 推送通道的测试邮件。</p>
        <p>如果你收到此邮件，说明邮箱服务配置正确。</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
        <p style="color:#A1A1AA;font-size:12px;">— Markline · RSS Push —</p>
      </div>`;

    const providerType = settings.email.providerType || 'http';
    const provider = settings.email.provider || (providerType === 'smtp' ? 'gmail' : 'resend');
    let result;

    if (providerType === 'smtp') {
      const password = await PushStore.getDecryptedSmtpPassForProvider(provider);
      if (!password) return { ok: false, error: 'no_smtp_password' };
      result = await _sendViaSmtp(settings, password, subject, html);
    } else {
      const apiKey = await PushStore.getDecryptedApiKeyForProvider(provider);
      if (!apiKey) return { ok: false, error: 'no_api_key' };
      result = await _sendViaHttp(settings, apiKey, subject, html);
    }

    if (result.ok) {
      console.info('[Push] test email sent, id=', result.id);
    }
    return result;
  }

  // ===== 手动 flush（供设置页/调试调用）=====
  function flush() {
    return flushQueue();
  }

  _init();

  global.PushChannel = {
    onPollComplete,
    sendTestEmail,
    flushQueue,
    flush,
    checkBridgeHealth,
    _renderEmailHtml,
    _filterByKeywords,
    HTTP_PROVIDERS,
    SMTP_PROVIDERS
  };
})(typeof self !== 'undefined' ? self : this);
