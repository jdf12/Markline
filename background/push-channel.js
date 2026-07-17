// background/push-channel.js
// RSS 资讯推送通道（邮箱通知）
// - 挂载到 onFeedPollComplete 钩子
// - 推送策略：instant 即时通知 | daily 每日摘要（默认）
// - instant 模式：新文章立即发送，受静默时段约束（静默时段内入队，结束后发送）
// - daily 模式：所有新文章入队，每天 dailySendAt 时间合并发送一封摘要邮件
// - 失败重试：内存计数器，固定 3 次，每次间隔 5 分钟
// - flushQueue 采用 peek→send→drain，避免发送失败导致数据丢失
// - API Key 加密存储（见 push-store.js），调用时临时解密，用完即丢
//
// 依赖：PushStore, fetch, chrome.alarms

(function (global) {
  'use strict';

  const REQUEST_TIMEOUT_MS = 15000;
  const MAX_ARTICLES_PER_EMAIL = 20;
  const SUMMARY_LEN = 120;
  const ALARM_DAILY = 'push-daily';
  const ALARM_RETRY = 'push-retry';
  const RETRY_MAX = 3;
  const RETRY_DELAY_MIN = 5;

  // 防止同一天重复补偿发送（内存标记，SW 重启后重置，配合 history 检查双重保障）
  let _dailyFlushAttemptedDate = '';

  // ===== AI 早报主题映射 =====
  const DIGEST_TOPICS = {
    model:      { title: '大模型动态', emoji: '🤖' },
    funding:    { title: '融资与并购', emoji: '💰' },
    opensource: { title: '开源项目',   emoji: '🛠️' },
    product:    { title: '产品发布',   emoji: '🚀' },
    industry:   { title: '行业资讯',   emoji: '📎' }
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

  // ===== 科技资讯预过滤：轻量关键词匹配，减少传给 AI 的非科技文章 =====
  // 仅在文章数超过阈值时执行，过滤纯娱乐/生活/体育等非科技内容
  // 命中任一关键词即保留；未命中的若数量仍超 limit 也保留（避免过度过滤）
  const TECH_KEYWORDS = [
    // AI / 大模型
    'ai', '人工智能', '大模型', 'llm', 'gpt', 'claude', 'gemini', 'deepseek',
    '机器学习', '深度学习', '神经网络', 'agent', '智能体', 'rag',
    'openai', 'anthropic', '智谱', '通义', '文心', '豆包',
    '机器人', '具身智能', 'aigc', '生成式',
    // 科技产品 / 硬件
    '芯片', 'gpu', 'cpu', '处理器', '半导体', '台积电', '英伟达', 'nvidia', 'amd', 'intel',
    '手机', 'iphone', '安卓', 'android', 'ios', '华为', '小米', '苹果',
    '电脑', '笔记本', '平板', '穿戴', '耳机', '相机', '无人机',
    '电动汽车', '新能源', '自动驾驶', '特斯拉', '比亚迪', '蔚小理',
    // 软件 / 互联网
    '开源', 'github', 'hugging face', 'linux', 'python', 'javascript', 'typescript',
    '云计算', 'saas', 'api', '数据库', 'kubernetes', 'docker',
    '元宇宙', '区块链', 'web3', '加密货币',
    // 商业 / 资本
    '融资', '收购', '并购', 'ipo', '上市', '估值', '独角兽',
    '腾讯', '阿里', '字节', '百度', '美团', '京东', '拼多多',
    'google', '微软', 'microsoft', 'meta', '亚马逊', 'amazon', 'apple',
    'funding', 'acquisition', 'series a', 'series b',
    // 行业 / 政策
    '监管', '反垄断', '数据安全', '隐私', '算法', '出海',
    'open source', 'open-source', 'robotics'
  ];

  function _prefilterAiRelevant(entries, limit) {
    if (!entries || entries.length === 0) return entries;
    const matched = [];
    const unmatched = [];
    for (const e of entries) {
      const it = e.item || {};
      const text = ((it.title || '') + ' ' + (it.summary || '')).toLowerCase();
      const hit = TECH_KEYWORDS.some(kw => text.includes(kw));
      if (hit) matched.push(e);
      else unmatched.push(e);
    }
    // 若匹配数不足 limit，用未匹配的补足（避免过度过滤导致早报内容过少）
    if (matched.length < limit) {
      return [...matched, ...unmatched].slice(0, limit);
    }
    return matched.slice(0, limit);
  }

  // ===== 跨源去重：合并报道同一事件的不同来源 =====
  // 优化策略：
  //   1. dedupKey 完全相同 → 直接合并
  //   2. 标题 Jaccard 相似度 > 0.5 → 合并（原 0.7 过严，同源不同标题的新闻无法合并）
  //   3. 标题包含关系（A 包含 B 或 B 包含 A，且短标题长度 ≥ 8）→ 合并
  //   4. 阈值上限 80 桶（O(n²) 性能保护），超过则仅靠 dedupKey 合并
  function _dedupEntries(entries) {
    if (!entries || entries.length === 0) return [];
    const groups = new Map();  // dedupKey → [entry, ...]

    // 1. 按 dedupKey 分桶
    for (const e of entries) {
      const key = e.dedupKey || PushStore.makeDedupKey(e.item?.title);
      if (!key) {
        const soloKey = '__solo_' + Math.random().toString(36).slice(2);
        groups.set(soloKey, [e]);
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const mergedBuckets = Array.from(groups.values());

    // 2. 跨桶相似度合并（Jaccard > 0.5 或包含关系）
    //    阈值上限 80 桶，超过跳过（性能保护，此时 dedupKey 已合并大部分重复）
    let finalBuckets = mergedBuckets;
    if (mergedBuckets.length > 1 && mergedBuckets.length <= 80) {
      const titles = mergedBuckets.map(b => (b[0].item?.title || '').toLowerCase());
      const tokenized = titles.map(_tokenize);
      const merged = new Array(mergedBuckets.length).fill(false);
      const result = [];
      for (let i = 0; i < mergedBuckets.length; i++) {
        if (merged[i]) continue;
        let combined = [...mergedBuckets[i]];
        for (let j = i + 1; j < mergedBuckets.length; j++) {
          if (merged[j]) continue;
          // 判定 1：Jaccard 相似度
          const sim = _jaccard(tokenized[i], tokenized[j]);
          // 判定 2：标题包含关系（短标题 ≥ 8 字符，且长标题包含短标题）
          const isContained = _isTitleContained(titles[i], titles[j]);
          if (sim > 0.5 || isContained) {
            combined = combined.concat(mergedBuckets[j]);
            merged[j] = true;
          }
        }
        merged[i] = true;
        result.push(combined);
      }
      finalBuckets = result;
    }

    // 3. 每个桶合并为单个 entry，附加 sources 数组
    return finalBuckets.map(bucket => {
      // 选信息最全的为主条目（summary 最长的优先）
      let main = bucket[0];
      let maxLen = (main.item?.summary || '').length;
      for (let i = 1; i < bucket.length; i++) {
        const len = (bucket[i].item?.summary || '').length;
        if (len > maxLen) {
          main = bucket[i];
          maxLen = len;
        }
      }
      // 收集所有来源（去重）
      const sources = [];
      const seen = new Set();
      for (const e of bucket) {
        const ft = e.feedTitle || 'RSS';
        if (!seen.has(ft)) {
          seen.add(ft);
          sources.push(ft);
        }
      }
      return {
        ...main,
        item: { ...main.item },
        sources
      };
    });
  }

  // 标题包含关系判断：A 包含 B 或 B 包含 A，且短标题长度 ≥ 8
  function _isTitleContained(a, b) {
    if (!a || !b) return false;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length < 8) return false;  // 太短的标题容易误判
    return longer.includes(shorter);
  }

  // 标题分词：中文按字、英文按词，转小写
  function _tokenize(text) {
    if (!text) return new Set();
    const normalized = String(text).toLowerCase();
    const tokens = new Set();
    const enWords = normalized.match(/[a-z]{2,}/g) || [];
    for (const w of enWords) tokens.add(w);
    const cnChars = normalized.match(/[\u4e00-\u9fa5]/g) || [];
    for (const c of cnChars) tokens.add(c);
    return tokens;
  }

  function _jaccard(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
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
  const SMTP_TIMEOUT_MS = 60000;  // SMTP 需要多次往返，163/Gmail 等可能较慢，给 60 秒

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

    // 先检查桥接程序是否在运行（快速失败，避免等满 60 秒超时）
    try {
      const healthResp = await fetch(`${BRIDGE_BASE}/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
      if (!healthResp.ok) {
        return { ok: false, error: 'bridge_not_running' };
      }
    } catch (e) {
      console.warn('[Push] SMTP bridge not running:', e.message);
      return { ok: false, error: 'bridge_not_running' };
    }

    // 调用本地桥接程序 HTTP 接口（授权码用完即丢，桥接不持久化）
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), SMTP_TIMEOUT_MS);
    try {
      console.info('[Push] SMTP send: host=', host, 'port=', port, 'to=', to);
      const resp = await fetch(`${BRIDGE_BASE}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host, port, tls,
          username, password,
          from, fromName: 'Markline',
          to, subject, html
        }),
        signal: controller.signal
      });
      clearTimeout(tid);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { ok: false, error: `bridge_http_${resp.status}: ${text.slice(0, 200)}` };
      }
      const data = await resp.json();
      return data;
    } catch (err) {
      clearTimeout(tid);
      // 桥接程序未运行或连接失败
      if (err && err.name === 'AbortError') {
        return { ok: false, error: 'smtp_timeout (60s). Bridge running but SMTP connection timed out. Check 163 server / network.' };
      }
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

  // ===== 实际发送一封邮件（无频率检查，频率由调用方控制）=====
  async function _doSend(subject, html) {
    const settings = await PushStore.getSettings();
    if (!settings.email || !settings.email.to) return { ok: false, error: 'no_recipient' };

    let result;
    const providerType = settings.email.providerType || 'http';
    const provider = settings.email.provider || (providerType === 'smtp' ? 'gmail' : 'resend');
    console.info('[Push] _doSend: providerType=', providerType, 'provider=', provider);

    if (providerType === 'smtp') {
      // SMTP 模式：按 provider 解密授权码
      console.info('[Push] _doSend: decrypting SMTP password for', provider);
      const password = await PushStore.getDecryptedSmtpPassForProvider(provider);
      if (!password) {
        console.warn('[Push] _doSend: no SMTP password for', provider);
        return { ok: false, error: 'no_smtp_password' };
      }
      console.info('[Push] _doSend: calling _sendViaSmtp');
      result = await _sendViaSmtp(settings, password, subject, html);
      // password 在此之后不再被引用，函数返回即被 GC
    } else {
      // HTTP API 模式：按 provider 解密 API Key
      console.info('[Push] _doSend: decrypting API key for', provider);
      const apiKey = await PushStore.getDecryptedApiKeyForProvider(provider);
      if (!apiKey) {
        console.warn('[Push] _doSend: no API key for', provider);
        return { ok: false, error: 'no_api_key' };
      }
      console.info('[Push] _doSend: calling _sendViaHttp');
      result = await _sendViaHttp(settings, apiKey, subject, html);
    }

    if (result.ok) {
      console.info('[Push] email sent, subject=', subject, 'id=', result.id);
    } else {
      console.warn('[Push] email failed:', result.error);
    }
    return result;
  }

  // ===== flushQueue：peek→send→drain，避免数据丢失 =====
  // 触发场景：push-daily alarm 到期 / instant 静默结束后 / 手动 flushNow
  // 失败时：内存重试计数器累加，超过 RETRY_MAX 后放弃并清空队列
  // daily 模式 + digest.aiEnabled + AI 已配置 → 走 AI 早报；否则回退列表模式
  // 发送窗口：daily 模式下只发送最近 30 小时的文章，覆盖国外源的时区差异
  //   （北京时间 22:00 发送时，美西是前一天 06:00，30 小时窗口能覆盖欧美主要源）
  let _flushRetryCount = 0;
  let _flushingPromise = null;  // 共享 Promise：并发调用 flushQueue 会 await 同一个，避免 _onAlarm 被锁挡住导致 SW 被 Chrome 杀死
  const DIGEST_WINDOW_MS = 30 * 60 * 60 * 1000;  // 30 小时

  async function flushQueue() {
    // 并发调用返回同一个 Promise：_onAlarm await 正在进行的 flush → Chrome 保持 SW 存活
    if (_flushingPromise) {
      console.info('[Push] flushQueue: already in progress, awaiting same promise');
      return _flushingPromise;
    }
    _flushingPromise = _flushQueueInner().finally(() => {
      _flushingPromise = null;
    });
    return _flushingPromise;
  }

  async function _flushQueueInner() {
    console.info('[Push] flushQueue: start');
    const queue = await PushStore.getQueue();  // 先 peek，不排空
    console.info('[Push] flushQueue: queue length=', queue.length);
    if (queue.length === 0) {
      _flushRetryCount = 0;
      console.info('[Push] flushQueue: queue empty, nothing to send');
      return { ok: false, skipped: true, reason: 'empty_queue' };
    }

    const settings = await PushStore.getSettings();
    console.info('[Push] flushQueue: strategy=', settings.strategy, 'email.to=', settings.email?.to);

    // 关键词过滤（收敛到此一次，入队时不再过滤）
    const keywordFiltered = queue.filter(e => {
      const it = { ...e.item, feedTitle: e.feedTitle };
      const text = ((it.title || '') + ' ' + (it.summary || '')).toLowerCase();
      const inc = (settings.keywords?.include || []).filter(Boolean);
      const exc = (settings.keywords?.exclude || []).filter(Boolean);
      if (exc.length && exc.some(k => text.includes(k.toLowerCase()))) return false;
      if (inc.length && !inc.some(k => text.includes(k.toLowerCase()))) return false;
      return true;
    });
    console.info('[Push] flushQueue: after keyword filter, entries=', keywordFiltered.length);

    if (keywordFiltered.length === 0) {
      // 全部被关键词过滤掉，清空队列避免堆积
      await PushStore.drainQueue();
      _flushRetryCount = 0;
      console.info('[Push] flushQueue: all filtered out');
      return { ok: false, skipped: true, reason: 'filtered_out' };
    }

    // 发送窗口筛选：daily 模式只发送最近 30 小时的文章
    // instant 模式不受此限制（即时性优先）
    // 手动 flushNow 也应用此窗口，避免把 2 天的积压一次性发出
    const now = Date.now();
    const entries = keywordFiltered.filter(e => {
      const pub = e.item?.publishedAt;
      if (!pub) return true;  // 无发布时间保留
      const pubMs = typeof pub === 'number' ? pub : Date.parse(pub);
      if (!pubMs || isNaN(pubMs)) return true;  // 解析失败保留
      return (now - pubMs) < DIGEST_WINDOW_MS;
    });
    console.info('[Push] flushQueue: after window filter (30h), entries=', entries.length, '(before=', keywordFiltered.length, ')');

    if (entries.length === 0) {
      // 窗口内无文章，清空队列（窗口外的视为过期，避免无限堆积）
      await PushStore.drainQueue();
      _flushRetryCount = 0;
      console.info('[Push] flushQueue: no articles within 30h window');
      return { ok: false, skipped: true, reason: 'no_recent_articles' };
    }

    // 跨源去重 + 来源合并
    const deduped = _dedupEntries(entries);
    console.info('[Push] flushQueue: after dedup, entries=', deduped.length, '(before=', entries.length, ')');

    // 判断是否走 AI 早报：仅 daily 模式 + digest.aiEnabled + digest.style=briefing + AI 已配置
    const digestCfg = settings.digest || {};
    const useAiDigest = settings.strategy === 'daily'
      && digestCfg.aiEnabled
      && digestCfg.style !== 'list'
      && (typeof getAIConfig === 'function')
      && (typeof resolveProvider === 'function')
      && (await _isAIConfigured());

    let html;
    let digestMode = 'raw';
    let sentCount = deduped.length;  // 实际展示的文章数（AI 模式下可能少于 deduped.length）
    let subject;

    if (useAiDigest) {
      console.info('[Push] flushQueue: using AI briefing mode');
      const maxItems = Math.min(Math.max(digestCfg.maxItems || 30, 10), 50);
      // 预过滤：轻量关键词筛选，减少 AI 处理的非 AI 文章（降低 token 和耗时）
      // 只在文章数 > maxItems 时执行，避免小批次过度过滤
      let aiInput = deduped;
      if (deduped.length > maxItems) {
        aiInput = _prefilterAiRelevant(deduped, maxItems * 2);
        console.info('[Push] flushQueue: prefiltered for AI, kept', aiInput.length, '/', deduped.length);
      }
      const truncated = aiInput.slice(0, maxItems);
      const digestResult = await _generateAiDigest(truncated);
      if (digestResult.ok) {
        // 统计 AI 实际整理的篇数（sections 中所有 items 的总和）
        const aiCount = (digestResult.digest.sections || []).reduce((sum, s) => sum + (s.items?.length || 0), 0);
        sentCount = aiCount;
        html = _renderBriefingHtml(digestResult.digest, aiCount);
        digestMode = 'ai';
        subject = `Markline · 科技资讯早报（${aiCount} 篇）`;
        console.info('[Push] flushQueue: AI digest generated, sections=', digestResult.digest?.sections?.length || 0, 'articles=', aiCount);
      } else {
        console.warn('[Push] flushQueue: AI digest failed, fallback to list. error=', digestResult.error);
        html = _renderEmailHtml(deduped);
        subject = _t('emailSubjectDigest').replace('$1', String(deduped.length));
      }
    } else {
      console.info('[Push] flushQueue: using raw list mode');
      html = _renderEmailHtml(deduped);
      subject = _t('emailSubjectDigest').replace('$1', String(deduped.length));
    }

    const result = await _doSend(subject, html);
    console.info('[Push] flushQueue: result=', result.ok ? 'ok' : 'failed', result.error || '');

    if (result.ok) {
      // 成功：排空队列 + 记录历史 + 重置重试计数
      await PushStore.drainQueue();
      await PushStore.addHistory({ status: 'success', count: sentCount, digestMode });
      _flushRetryCount = 0;
      console.info('[Push] flushQueue: success, sent', sentCount, 'articles (mode=', digestMode, ')');
      return { ok: true, sent: sentCount, digestMode };
    }

    // 失败：重试计数
    const lastError = result.error || 'unknown';
    _flushRetryCount++;
    if (_flushRetryCount > RETRY_MAX) {
      // 超过最大重试次数：放弃，清空队列避免无限堆积
      await PushStore.drainQueue();
      await PushStore.addHistory({ status: 'failed', count: sentCount, error: `max_retries: ${lastError}`, digestMode });
      _flushRetryCount = 0;
      console.warn('[Push] flushQueue gave up after', RETRY_MAX, 'retries:', lastError);
      return { ok: false, error: lastError, retries_exhausted: true };
    }

    // 安排重试 alarm
    chrome.alarms.create(ALARM_RETRY, { delayInMinutes: RETRY_DELAY_MIN });
    await PushStore.addHistory({ status: 'failed', count: sentCount, error: lastError, retrying: true, digestMode });
    console.info('[Push] flushQueue will retry in', RETRY_DELAY_MIN, 'min (attempt', _flushRetryCount, ')');
    return { ok: false, error: lastError, retrying: true };
  }

  // 检测 AI 分类服务是否已配置（复用 ai-tagger 的顶层函数，经 importScripts 共享全局作用域）
  async function _isAIConfigured() {
    try {
      if (typeof getAIConfig !== 'function') return false;
      const cfg = await getAIConfig();
      return !!(cfg && cfg.enabled && cfg.apiKey);
    } catch (e) {
      console.warn('[Push] _isAIConfigured error:', e.message);
      return false;
    }
  }

  // ===== AI 早报生成：调用 AI 把多篇 RSS 文章整理成主题早报 =====
  // 复用 ai-tagger 的 resolveProvider / _doFetch / getAIConfig / _acquireAISlot
  // 失败时返回 { ok: false, error }，调用方回退列表模式
  const DIGEST_AI_TIMEOUT_MS = 90000;  // 早报生成 + 推理模型 thinking 较慢，给 90 秒

  async function _generateAiDigest(entries) {
    if (!entries || entries.length === 0) {
      return { ok: false, error: 'no_entries' };
    }
    try {
      const config = await getAIConfig();
      if (!config || !config.enabled || !config.apiKey) {
        return { ok: false, error: 'ai_not_configured' };
      }
      const resolved = resolveProvider(config);
      if (!resolved) {
        return { ok: false, error: 'resolve_provider_failed' };
      }

      const prompt = _buildDigestPrompt(entries);
      const body = resolved.buildBody(prompt, resolved.model);
      // 早报输出远比标签分类长，且推理模型（如 DeepSeek-v4-flash）会先输出 thinking 块
      // ai-tagger 默认 max_tokens=1024 太小，thinking 未结束就被截断，导致无 text 块
      // 此处覆盖为 8192，确保 thinking 结束后仍有空间输出完整早报 JSON
      if (body && typeof body === 'object' && 'max_tokens' in body) {
        body.max_tokens = 8192;
      }
      const timeoutMs = Math.max(10000, DIGEST_AI_TIMEOUT_MS);

      // 复用 ai-tagger 的并发槽（避免与书签分类争抢配额）
      const release = (typeof _acquireAISlot === 'function')
        ? await _acquireAISlot()
        : () => {};
      const startTime = Date.now();
      try {
        const { ok, status, text } = await _doFetch(
          resolved.endpoint,
          resolved.buildHeaders(config.apiKey),
          body,
          timeoutMs
        );
        if (!ok) {
          console.warn('[Push] AI digest HTTP error:', status, text.slice(0, 500));
          return { ok: false, error: `http_${status}` };
        }
        console.info('[Push] AI digest raw response (first 500 chars):', text.slice(0, 500));
        let json;
        try { json = JSON.parse(text); } catch {
          // 某些 provider 可能直接返回纯文本（非 JSON 包裹），尝试当作纯文本解析
          console.warn('[Push] AI response not JSON, trying as plain text');
          const digest = _parseDigestResponse(text);
          if (digest) {
            console.info('[Push] AI digest (plain text) generated in', Date.now() - startTime, 'ms');
            return { ok: true, digest };
          }
          return { ok: false, error: 'invalid_json_response' };
        }
        const raw = resolved.parseResponse(json);
        if (!raw) {
          // parseResponse 返回空，可能是响应结构异常，打印完整 json 便于排查
          console.warn('[Push] AI parseResponse returned empty, json keys=', Object.keys(json || {}), 'full=', JSON.stringify(json).slice(0, 800));
          return { ok: false, error: 'parse_response_empty' };
        }
        const digest = _parseDigestResponse(raw);
        if (!digest) {
          console.warn('[Push] AI digest parse failed, raw (first 500)=', String(raw).slice(0, 500));
          return { ok: false, error: 'parse_digest_failed' };
        }
        console.info('[Push] AI digest generated in', Date.now() - startTime, 'ms, sections=', digest.sections?.length || 0);
        return { ok: true, digest };
      } finally {
        release();
      }
    } catch (e) {
      const isTimeout = e && e.name === 'AbortError';
      console.warn('[Push] AI digest error:', isTimeout ? 'timeout' : e.message);
      return { ok: false, error: isTimeout ? 'ai_timeout' : (e.message || 'unknown') };
    }
  }

  // 构建 AI 早报 Prompt
  // 优化点：
  //   1. 明确泛科技筛选标准，避免 AI 浪费 thinking 思考"哪些相关"
  //   2. 给出 few-shot 示例，锚定输出格式和摘要风格
  //   3. 压缩输入字段，减少 token
  //   4. 时区无关：用"过去 30 小时"替代"今日"，适配国内外多源时区差异
  function _buildDigestPrompt(entries) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - DIGEST_WINDOW_MS);
    const windowLabel = `${windowStart.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ~ ${now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

    // 压缩输入：只传 id/title/summary/source/link，time 由 AI 原样输出
    // summary 截断到 150 字（足够判断主题和重要性，减少 token）
    const articles = entries.map((e, i) => {
      const it = e.item || {};
      const sources = (e.sources && e.sources.length > 0) ? e.sources.join('/') : (e.feedTitle || '');
      const time = it.publishedAt
        ? new Date(it.publishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      return {
        id: i,
        title: (it.title || '').slice(0, 120),
        summary: (it.summary || '').slice(0, 150),
        source: sources,
        link: it.link || '',
        time  // 保留时间，让 AI 能判断时效性
      };
    });

    return `你是一名资深科技资讯编辑，将 RSS 文章整理成每日科技资讯早报。

【时间范围】过去 30 小时（北京时间 ${windowLabel}），文章来自国内外多个源，时区不一，以文章自身的发布时间为准。

【筛选标准】保留科技相关文章，丢弃纯娱乐/生活/体育/八卦等非科技内容：
- AI / 大模型 / 机器学习
- 科技产品（手机/电脑/硬件/电动汽车/相机等）
- 软件开发 / 开源项目 / 云计算
- 科技公司融资 / 收购 / 上市
- 科技行业政策 / 监管 / 观点

【分组规则】
- model：AI 大模型发布/升级/能力评测
- funding：融资/收购/IPO
- opensource：开源项目/工具/框架
- product：科技产品/功能发布（含硬件、软件、服务）
- industry：政策/观点/产业动态/其他科技相关

【输出要求】
1. 合并报道同一事件的不同来源（source 字段用 / 分隔多源）
2. 每条摘要不超过 30 字，中文，陈述句
3. 组内按重要性降序
4. highlights 选 3-5 条最重要的，每条不超过 40 字
5. 无文章的分组不要出现在 sections 中
6. 严格输出 JSON，不要 markdown 代码块标记，不要解释

输入文章：
${JSON.stringify(articles)}

输出格式示例：
{"highlights":["OpenAI 发布 GPT-5","某公司完成 5 亿融资"],"sections":[{"topic":"model","items":[{"title":"原标题","summary":"一句话摘要","source":"源名","link":"https://...","time":"07/12 22:30"}]}]}

请输出早报 JSON：`;
  }

  // 安全 JSON 解析：失败返回 null（不抛异常）
  function _tryParseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // 解析 AI 返回的早报 JSON（容错处理）
  // 优化：多重 JSON 提取策略，兼容 AI 输出带思考过程、解释文字、markdown 标记等情况
  function _parseDigestResponse(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let text = raw.trim();
    // 策略 1：去除首尾 markdown 代码块标记
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    // 策略 2：直接解析（理想情况：纯 JSON）
    let obj = _tryParseJson(text);
    // 策略 3：提取最外层 { ... } 片段（AI 可能前后有解释文字）
    if (!obj) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        obj = _tryParseJson(text.slice(start, end + 1));
      }
    }
    // 策略 4：提取代码块内的 JSON（AI 可能用 ```json 包裹）
    if (!obj) {
      const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (codeMatch) {
        obj = _tryParseJson(codeMatch[1].trim());
      }
    }
    if (!obj || typeof obj !== 'object') return null;

    // 校验并归一化 sections
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    const validSections = sections
      .filter(s => s && typeof s === 'object' && Array.isArray(s.items))
      .map(s => {
        const topic = (typeof s.topic === 'string' && DIGEST_TOPICS[s.topic]) ? s.topic : 'industry';
        const items = (s.items || [])
          .filter(it => it && typeof it === 'object' && (it.title || it.summary))
          .map(it => ({
            title: String(it.title || '').slice(0, 200),
            summary: String(it.summary || '').slice(0, 100),
            source: String(it.source || ''),
            link: String(it.link || ''),
            time: String(it.time || '')
          }));
        return { topic, items };
      })
      .filter(s => s.items.length > 0);

    const highlights = Array.isArray(obj.highlights)
      ? obj.highlights.filter(h => typeof h === 'string').map(h => String(h).slice(0, 100))
      : [];

    if (validSections.length === 0 && highlights.length === 0) return null;
    return { highlights, sections: validSections };
  }

  // ===== 渲染 AI 早报 HTML =====
  function _renderBriefingHtml(digest, totalCount) {
    if (!digest || !digest.sections || digest.sections.length === 0) {
      // 兜底：解析成功但无 sections，回退空提示
      return `<div style="font-family:sans-serif;padding:24px;color:#171717;">
        <h2 style="color:#4B3FE3;">Markline · 科技资讯早报</h2>
        <p>过去 30 小时共 ${totalCount} 篇文章，但 AI 未能生成有效摘要，请查看原始列表。</p>
      </div>`;
    }

    const now = new Date();
    const windowStart = new Date(now.getTime() - DIGEST_WINDOW_MS);
    const windowLabel = `${windowStart.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ~ ${now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

    // 核心要点
    const highlightsHtml = (digest.highlights && digest.highlights.length > 0)
      ? `<div style="background:#F5F3FF;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
          <h3 style="color:#1A1759;font-size:15px;margin:0 0 10px 0;">📌 核心要点</h3>
          <ul style="margin:0;padding-left:20px;color:#3F3F46;font-size:14px;line-height:1.8;">
            ${digest.highlights.map(h => `<li>${_esc(h)}</li>`).join('')}
          </ul>
        </div>`
      : '';

    // 主题分组
    const sectionsHtml = digest.sections.map(section => {
      const topicInfo = DIGEST_TOPICS[section.topic] || DIGEST_TOPICS.industry;
      const itemsHtml = section.items.map((it, idx) => {
        const title = _esc(it.title || '(无标题)');
        const link = _esc(it.link || '');
        const summary = _esc(it.summary || '');
        const source = _esc(it.source || '');
        const time = _esc(it.time || '');
        const sourceText = source ? `<span style="color:#71717A;">${source}</span>` : '';
        const timeText = time ? `<span style="color:#A1A1AA;">${time}</span>` : '';
        const meta = (sourceText || timeText)
          ? `<p style="color:#A1A1AA;font-size:12px;margin:6px 0 0 0;">${sourceText}${sourceText && timeText ? ' · ' : ''}${timeText}</p>`
          : '';
        const titleHtml = link
          ? `<a href="${link}" style="color:#4B3FE3;text-decoration:none;font-size:15px;font-weight:600;">${title}</a>`
          : `<span style="color:#1A1759;font-size:15px;font-weight:600;">${title}</span>`;
        const summaryHtml = summary
          ? `<p style="color:#52525B;font-size:13px;line-height:1.6;margin:6px 0 0 0;">${summary}</p>`
          : '';
        return `
          <div style="margin-bottom:16px;padding:12px 14px;border-left:3px solid #E5E7EB;">
            <div style="display:flex;align-items:baseline;gap:8px;">
              <span style="color:#A1A1AA;font-size:12px;min-width:18px;">${idx + 1}.</span>
              ${titleHtml}
            </div>
            ${summaryHtml}
            ${meta}
          </div>`;
      }).join('');

      return `
        <div style="margin-bottom:24px;">
          <h3 style="color:#1A1759;font-size:15px;margin:0 0 12px 0;padding-bottom:6px;border-bottom:1px solid #f3f4f6;">
            ${topicInfo.emoji} ${_esc(topicInfo.title)}
            <span style="color:#A1A1AA;font-size:12px;font-weight:normal;margin-left:8px;">${section.items.length} 篇</span>
          </h3>
          ${itemsHtml}
        </div>`;
    }).join('');

    return `
      <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;">
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #4B3FE3;">
          <h2 style="color:#1A1759;margin:0 0 6px 0;">Markline · 科技资讯早报</h2>
          <p style="color:#A1A1AA;font-size:13px;margin:0;">${windowLabel} · 共 ${totalCount} 篇 · 由 AI 智能整理</p>
        </div>
        ${highlightsHtml}
        ${sectionsHtml}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
        <p style="color:#A1A1AA;font-size:12px;text-align:center;">— Markline · 科技日报 —</p>
      </div>`;
  }

  // ===== onFeedPollComplete 钩子入口 =====
  async function onPollComplete(results) {
    if (!Array.isArray(results)) return;
    const settings = await PushStore.getSettings();
    if (!settings.enabled) {
      console.info('[Push] onPollComplete: push disabled, skip');
      return;
    }

    const strategy = settings.strategy === 'instant' ? 'instant' : 'daily';
    console.info('[Push] onPollComplete: strategy=', strategy, 'results=', results.length, 'feeds with new articles=', results.filter(r => r && r.added && r.added.length > 0).length);

    for (const r of results) {
      if (!r || !r.added || r.added.length === 0) continue;
      const feed = r.feed || { title: r.feedTitle || 'RSS', id: r.feedId };
      // feed 级别开关
      const pushTo = settings.feedPushTo[r.feedId];
      if (pushTo && !pushTo.includes('email')) continue;

      // 关键词过滤收敛到 flushQueue，入队时不再过滤（daily 模式）
      // instant 模式立即发送，仍需在此过滤
      const filtered = strategy === 'instant'
        ? _filterByKeywords(r.added, settings.keywords)
        : r.added;
      if (filtered.length === 0) continue;

      if (strategy === 'instant') {
        // 即时模式：检查静默时段
        const qh = settings.quietHours;
        if (qh && qh.start && qh.end && PushStore.isInQuietHours(qh.start, qh.end)) {
          // 静默时段：入队，等静默结束后 flush
          const eqResult = await PushStore.enqueueItems(feed, filtered);
          console.info('[Push] onPollComplete: in quiet hours, enqueued', eqResult.enqueuedCount, 'articles from', feed.title, 'queueLength=', eqResult.queueLength, eqResult.overflowCount > 0 ? 'overflow=' + eqResult.overflowCount : '');
          _ensureFlushAfterQuiet(qh.end).catch(e => console.warn('[Push] ensureFlushAfterQuiet error:', e.message));
        } else {
          // 非静默：立即发送（每 feed 一封）
          try {
            await _pushFeedInstant(feed, filtered);
          } catch (e) {
            console.warn('[Push] instant error:', e.message);
          }
        }
      } else {
        // daily 模式：入队所有新文章（enqueueItems 内部过滤超过 2 天的历史文章）
        // 关键词过滤在 flushQueue 发送前统一执行
        const eqResult = await PushStore.enqueueItems(feed, filtered);
        console.info('[Push] onPollComplete: enqueued', eqResult.enqueuedCount, 'articles from', feed.title, 'queueLength=', eqResult.queueLength, eqResult.overflowCount > 0 ? 'overflow=' + eqResult.overflowCount : '');
      }
    }

    // daily 模式：确保 push-daily alarm 已注册
    if (strategy === 'daily') {
      _ensureDailyAlarm(settings.dailySendAt || '08:00').catch(e => console.warn('[Push] ensureDailyAlarm error:', e.message));
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
    const result = await _doSend(subject, html);
    if (result.ok) {
      await PushStore.addHistory({ status: 'success', count: items.length });
    } else {
      // instant 模式失败也记录历史，但不重试（避免静默外时段堆积）
      await PushStore.addHistory({ status: 'failed', count: items.length, error: result.error });
    }
    return result;
  }

  // ===== push-daily alarm：每日固定时间发送 =====
  async function _ensureDailyAlarm(dailySendAt) {
    const existing = await chrome.alarms.get(ALARM_DAILY);
    if (existing) {
      // 已存在：检查时间是否匹配，不匹配则重建
      const expectedTs = _nextDailySendTs(dailySendAt);
      const existingTs = existing.scheduledTime;
      // 允许 60 秒误差
      if (Math.abs(existingTs - expectedTs) > 60000) {
        console.info('[Push] daily alarm time mismatch, recreating. existing=', new Date(existingTs).toLocaleString(), 'expected=', new Date(expectedTs).toLocaleString());
        await chrome.alarms.clear(ALARM_DAILY);
      } else {
        return;  // 时间匹配，无需重建
      }
    }
    const nextTs = _nextDailySendTs(dailySendAt);
    await chrome.alarms.create(ALARM_DAILY, {
      when: nextTs,
      periodInMinutes: 1440  // 24 小时周期
    });
    console.info('[Push] daily alarm created for', new Date(nextTs).toLocaleString(), '(' + dailySendAt + ')');
  }

  // 计算下一个 dailySendAt 时间戳（如果今天的时间已过，则为明天）
  function _nextDailySendTs(dailySendAt) {
    const [hh, mm] = (dailySendAt || '08:00').split(':').map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(hh || 8, mm || 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      // 今天的时间已过，安排到明天
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  // ===== 静默结束后触发 flush（instant 模式入队的文章）=====
  async function _ensureFlushAfterQuiet(quietEnd) {
    const existing = await chrome.alarms.get('push-quiet-end');
    if (existing) return;
    const [hh, mm] = (quietEnd || '07:00').split(':').map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    await chrome.alarms.create('push-quiet-end', { when: next.getTime() });
    console.info('[Push] quiet-end alarm created for', next.toLocaleString());
  }

  // ===== 策略变更时重建 alarm =====
  async function onStrategyChanged(settings) {
    console.info('[Push] onStrategyChanged:', { enabled: settings.enabled, strategy: settings.strategy, dailySendAt: settings.dailySendAt });
    await chrome.alarms.clear(ALARM_DAILY);
    await chrome.alarms.clear('push-quiet-end');

    if (!settings.enabled) {
      console.info('[Push] push disabled, alarms cleared');
      return;
    }

    if (settings.strategy === 'daily') {
      await _ensureDailyAlarm(settings.dailySendAt || '08:00');
    }
    // instant 模式不需要 daily alarm；静默结束 alarm 在 onPollComplete 时按需创建
  }

  // ===== alarm 监听 =====
  // MV3 注意：alarm 回调必须返回 Promise，否则 SW 可能在 flushQueue 完成前被终止
  async function _onAlarm(alarm) {
    console.info('[Push] alarm fired:', alarm.name, 'scheduledTime=', new Date(alarm.scheduledTime).toLocaleString());
    try {
      if (alarm.name === ALARM_DAILY) {
        // daily 模式：先触发 RSS 轮询拿最新文章，再 flush
        _dailyFlushAttemptedDate = new Date().toDateString();  // 标记今天已由 alarm 处理
        // 若 _checkMissedDailyFlush 已经启动了 flush（SW 启动时竞态），直接 await 同一个 Promise
        // 避免重复 pollAll，且 Chrome 会因 _onAlarm await 而保持 SW 存活直到 flush 完成
        if (_flushingPromise) {
          console.info('[Push] daily alarm: flush already in progress (from _checkMissedDailyFlush), awaiting');
          await _flushingPromise;
        } else {
          console.info('[Push] daily alarm: triggering RSS poll before flush');
          if (typeof global.FeedFetcher !== 'undefined' && global.FeedFetcher.pollAll) {
            await global.FeedFetcher.pollAll();  // pollAll 内部会调用 onPollComplete → enqueueItems
          }
          // 等待入队完成后 flush
          await flushQueue();
        }
      } else if (alarm.name === 'push-quiet-end') {
        await flushQueue();
      } else if (alarm.name === ALARM_RETRY) {
        await flushQueue();
      }
    } catch (e) {
      console.warn('[Push] flush (' + alarm.name + ') error:', e.message, e.stack);
    }
  }

  // ===== 诊断：获取当前 alarm 状态 =====
  async function getAlarmStatus() {
    const daily = await chrome.alarms.get(ALARM_DAILY);
    const retry = await chrome.alarms.get(ALARM_RETRY);
    const quietEnd = await chrome.alarms.get('push-quiet-end');
    const queue = await PushStore.getQueue();
    const history = await PushStore.getHistory();
    return {
      dailyAlarm: daily ? {
        scheduledTime: new Date(daily.scheduledTime).toLocaleString(),
        periodInMinutes: daily.periodInMinutes
      } : null,
      retryAlarm: retry ? { scheduledTime: new Date(retry.scheduledTime).toLocaleString() } : null,
      quietEndAlarm: quietEnd ? { scheduledTime: new Date(quietEnd.scheduledTime).toLocaleString() } : null,
      queueLength: queue.length,
      historyLength: history.length,
      lastHistory: history[0] || null
    };
  }

  // ===== 启动时恢复 alarm =====
  async function _init() {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    chrome.alarms.onAlarm.addListener(_onAlarm);

    // 清理旧版本残留的持久化锁（已改用 in-memory _flushingPromise）
    chrome.storage.local.remove('push_flush_started_at').catch(() => {});

    const settings = await PushStore.getSettings();
    console.info('[Push] _init: enabled=', settings.enabled, 'strategy=', settings.strategy, 'dailySendAt=', settings.dailySendAt);
    if (!settings.enabled) return;

    // daily 模式：确保 push-daily 存在
    if (settings.strategy === 'daily') {
      await _ensureDailyAlarm(settings.dailySendAt || '08:00');
    }

    // 队列有残留：清理超过 2 天的过期文章
    const queue = await PushStore.getQueue();
    if (queue.length > 0) {
      const now = Date.now();
      const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
      const valid = queue.filter(e => {
        const pub = e.item?.publishedAt;
        if (!pub) return true;
        const pubMs = typeof pub === 'number' ? pub : Date.parse(pub);
        if (!pubMs || isNaN(pubMs)) return true;
        return (now - pubMs) < MAX_AGE_MS;
      });
      const expiredCount = queue.length - valid.length;
      if (expiredCount > 0) {
        console.info('[Push] _init: filtered', expiredCount, 'expired articles (older than 2 days)');
      }

      if (valid.length === 0) {
        console.info('[Push] _init: queue all expired, draining', queue.length, 'articles');
        await PushStore.drainQueue();
      } else {
        if (valid.length < queue.length) {
          await chrome.storage.local.set({ ['push_queue']: valid });
        }
        console.info('[Push] _init: found orphan queue, valid=', valid.length);
        if (settings.strategy === 'instant') {
          chrome.alarms.create(ALARM_RETRY, { delayInMinutes: 1 });
        }
      }
    }

    // daily 模式：检查是否错过了今日发送时间（独立于队列状态）
    // 场景：SW 在 dailySendAt 时未运行（电脑休眠/Chrome 未启动），alarm 错过
    if (settings.strategy === 'daily') {
      await _checkMissedDailyFlush(settings);
    }
  }

  // ===== 错过每日发送的补偿逻辑 =====
  // SW 在 dailySendAt 时未运行 → alarm 不会触发 → 启动时检测并补偿
  // 防重复机制：in-memory _dailyFlushAttemptedDate + history 成功记录检查 + _flushingPromise
  //   - _flushingPromise：同一 SW 实例内并发调用 flushQueue 会 await 同一个 Promise（_onAlarm 场景）
  //   - SW 被杀重启后 _flushingPromise 为 null，history 检查决定是否重试（发送成功则跳过）
  async function _checkMissedDailyFlush(settings) {
    const now = new Date();
    const [dh, dm] = (settings.dailySendAt || '08:00').split(':').map(Number);
    const todaySendAt = new Date();
    todaySendAt.setHours(dh || 8, dm || 0, 0, 0);

    // 还没到今天的发送时间，无需补偿
    if (now.getTime() <= todaySendAt.getTime()) return;

    // 防止同一天重复补偿（SW 多次重启时）
    const todayStr = now.toDateString();
    if (_dailyFlushAttemptedDate === todayStr) return;

    // 今天是否已成功发送（通过 history 判断，比 lastQueuedAt 可靠）
    const history = await PushStore.getHistory();
    const lastSuccess = history.find(h => h.status === 'success');
    if (lastSuccess && lastSuccess.time >= todaySendAt.getTime()) {
      _dailyFlushAttemptedDate = todayStr;
      return;
    }

    // 是否有待处理的重试 alarm（避免与重试机制冲突导致重复发送）
    const retryAlarm = await chrome.alarms.get(ALARM_RETRY);
    if (retryAlarm) {
      _dailyFlushAttemptedDate = todayStr;
      console.info('[Push] _checkMissedDailyFlush: retry alarm pending, skip compensation');
      return;
    }

    _dailyFlushAttemptedDate = todayStr;
    console.info('[Push] _checkMissedDailyFlush: detected missed daily send, compensating with pollAll + flushQueue');
    try {
      if (typeof global.FeedFetcher !== 'undefined' && global.FeedFetcher.pollAll) {
        await global.FeedFetcher.pollAll();  // 先轮询拿最新文章（与 alarm 处理器一致）
      }
      // flushQueue 内部通过 _flushingPromise 防并发；若 _onAlarm 同时触发，会 await 同一个 Promise
      await flushQueue();
    } catch (e) {
      console.warn('[Push] _checkMissedDailyFlush error:', e.message, e.stack);
    }
  }

  // ===== 测试邮件（供设置页调用，不写入历史）=====
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
    onStrategyChanged,
    sendTestEmail,
    flushQueue,
    flush,
    checkBridgeHealth,
    getAlarmStatus,
    _renderEmailHtml,
    _renderBriefingHtml,
    _filterByKeywords,
    _dedupEntries,
    _generateAiDigest,
    _buildDigestPrompt,
    DIGEST_TOPICS,
    HTTP_PROVIDERS,
    SMTP_PROVIDERS
  };
})(typeof self !== 'undefined' ? self : this);
