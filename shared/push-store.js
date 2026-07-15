// shared/push-store.js
// 推送通知设置存储层
// - API Key / SMTP 授权码 按服务商分片加密存储（AES-GCM），密钥由设备 secret + PBKDF2 派生
// - CryptoKey 设置 extractable=false，避免被导出
// - 调用方通过 getDecryptedApiKeyForProvider(provider) 临时解密使用，用完即丢
// - 切换服务商时，UI 切换显示对应服务商的凭证状态，互不影响
//
// 依赖：chrome.storage.local, crypto.subtle (Service Worker / 页面均可用)
//
// 存储结构：
//   push_settings: {
//     enabled: false,
//     email: {
//       providerType: 'http',     // 'http' | 'smtp'
//       provider: 'resend',       // http: resend|sendgrid|mailgun|custom; smtp: gmail|qq|163|126|outlook|aliyun|sina|sohu|189|feishu|custom-smtp
//       to: '',                   // 收件人
//       from: '',                 // 发件人
//       // HTTP API 模式
//       endpoint: '',             // Custom HTTP 端点
//       authType: 'bearer',       // bearer | basic | xapikey（仅 custom 模式生效，预置 provider 强制 bearer）
//       // SMTP 模式
//       username: '',             // SMTP 账号
//       smtpHost: '',             // Custom SMTP 主机
//       smtpPort: 465,            // Custom SMTP 端口
//       smtpTls: 'ssl'            // ssl | starttls | none
//     },
//     strategy: 'daily',                       // 推送策略: instant 即时通知 | daily 每日摘要
//     dailySendAt: '08:00',                    // 每日摘要发送时间 (HH:MM)，仅 strategy=daily 生效
//     quietHours: { start: '22:00', end: '07:00' },  // 静默时段 (仅 instant 生效)，空=不启用
//     keywords: { include: [], exclude: [] },  // 关键词过滤
//     feedPushTo: {},                          // { feedId: ['email'] }，预留多渠道
//     digest: {                                // AI 早报摘要配置（仅 strategy=daily 生效）
//       aiEnabled: true,                       //   启用 AI 智能摘要（失败自动回退列表）
//       maxItems: 30,                          //   早报最多包含文章数（10-50）
//       style: 'briefing'                      //   'briefing'(AI早报) | 'list'(传统列表)
//     }
//   }
//   push_key_<provider>: { encKey, iv, salt }       // 按服务商分片的 API Key 加密存储
//   push_pass_<provider>: { encKey, iv, salt }      // 按服务商分片的 SMTP 授权码加密存储
//   push_queue: [{ feedId, feedTitle, item, queuedAt, dedupKey }]  // 聚合待推送队列（daily 模式累积）
//     item: { title, link, summary(≤1000字), imageUrl, publishedAt, author }
//   push_history: [{ id, time, status, count, error }]  // 发送历史（最近 20 条）
//   push_device_secret: base64  // 设备绑定密钥（首次生成）

(function (global) {
  'use strict';

  const STORAGE_KEY = 'push_settings';
  const DEVICE_SECRET_KEY = 'push_device_secret';
  const PBKDF2_ITERATIONS = 100000;
  const KEY_LENGTH = 256;

  // ===== base64 工具（Service Worker 无 btoa/atop，用 Buffer 替代）=====
  function _bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function _b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // ===== 设备 secret（首次生成，持久化）=====
  async function _getDeviceSecret() {
    const r = await chrome.storage.local.get(DEVICE_SECRET_KEY);
    if (r[DEVICE_SECRET_KEY]) return r[DEVICE_SECRET_KEY];
    // 生成 32 字节随机 secret
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = _bufToB64(secretBytes.buffer);
    await chrome.storage.local.set({ [DEVICE_SECRET_KEY]: secret });
    return secret;
  }

  // ===== PBKDF2 派生 AES-GCM CryptoKey =====
  async function _deriveKey(saltBuf) {
    const secret = await _getDeviceSecret();
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBuf,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,            // extractable=false，密钥不可导出
      ['encrypt', 'decrypt']
    );
  }

  // ===== 加密 API Key =====
  async function encryptApiKey(plainKey) {
    if (!plainKey) return { encKey: '', iv: '', salt: '' };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await _deriveKey(salt.buffer);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(plainKey)
    );
    return {
      encKey: _bufToB64(ciphertext),
      iv: _bufToB64(iv.buffer),
      salt: _bufToB64(salt.buffer)
    };
  }

  // ===== 解密 API Key（返回明文，调用方用完即丢）=====
  async function decryptApiKey(encData) {
    if (!encData || !encData.encKey || !encData.iv || !encData.salt) return '';
    try {
      const saltBuf = _b64ToBuf(encData.salt);
      const ivBuf = _b64ToBuf(encData.iv);
      const key = await _deriveKey(saltBuf);
      const cipherBuf = _b64ToBuf(encData.encKey);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBuf },
        key,
        cipherBuf
      );
      return new TextDecoder().decode(plainBuf);
    } catch (e) {
      console.warn('[Push] decrypt apiKey failed:', e.message);
      return '';
    }
  }

  // ===== 设置 CRUD =====
  const DEFAULT_SETTINGS = {
    enabled: false,
    email: {
      providerType: 'http',     // 'http' | 'smtp'
      provider: 'resend',
      to: '',
      from: '',
      endpoint: '',
      authType: 'bearer',
      username: '',
      smtpHost: '',
      smtpPort: 465,
      smtpTls: 'ssl'
    },
    strategy: 'daily',                                  // instant | daily
    dailySendAt: '08:00',                               // 每日摘要发送时间
    quietHours: { start: '22:00', end: '07:00' },      // 静默时段 (仅 instant 生效)
    keywords: { include: [], exclude: [] },
    feedPushTo: {},
    // AI 早报摘要配置（仅 strategy=daily 生效）
    digest: {
      aiEnabled: true,      // 启用 AI 智能摘要（失败自动回退列表）
      maxItems: 30,         // 早报最多包含文章数（10-50）
      style: 'briefing'     // 'briefing'(AI早报) | 'list'(传统列表)
    }
  };

  async function getSettings() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const s = r[STORAGE_KEY];
    if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // 深度合并，确保嵌套字段不缺失；同时清理已废弃字段（minIntervalMin/dailyLimit/email.encKey 等）
    const merged = {
      ...DEFAULT_SETTINGS,
      ...s,
      email: { ...DEFAULT_SETTINGS.email, ...(s.email || {}) },
      quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(s.quietHours || {}) },
      keywords: { ...DEFAULT_SETTINGS.keywords, ...(s.keywords || {}) },
      feedPushTo: s.feedPushTo || {},
      digest: { ...DEFAULT_SETTINGS.digest, ...(s.digest || {}) }
    };
    // 兼容旧数据：batch30/60/180 → daily，instant 保留
    if (merged.strategy !== 'instant' && merged.strategy !== 'daily') {
      merged.strategy = 'daily';
    }
    // 清理已废弃字段
    delete merged.minIntervalMin;
    delete merged.dailyLimit;
    delete merged.email.encKey;
    delete merged.email.iv;
    delete merged.email.salt;
    delete merged.email.encPass;
    delete merged.email.ivPass;
    delete merged.email.saltPass;
    return merged;
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = {
      ...cur,
      ...patch,
      email: { ...cur.email, ...(patch.email || {}) },
      quietHours: { ...cur.quietHours, ...(patch.quietHours || {}) },
      keywords: { ...cur.keywords, ...(patch.keywords || {}) },
      feedPushTo: { ...cur.feedPushTo, ...(patch.feedPushTo || {}) },
      digest: { ...cur.digest, ...(patch.digest || {}) }
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  // ===== 聚合队列管理 =====
  const QUEUE_KEY = 'push_queue';

  async function getQueue() {
    const r = await chrome.storage.local.get(QUEUE_KEY);
    return r[QUEUE_KEY] || [];
  }

  // 入队文章。过滤超过 2 天的历史文章（防止首次订阅刷屏）
  // r.added 已通过 FeedStore guid 去重，后续轮询只返回新文章
  // 多源公平策略：每 feed 软配额 MAX_PER_FEED，避免高频源挤占低频源
  const PUSH_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;  // 2 天
  const MAX_QUEUE = 150;        // 队列总上限（提升，给 AI 摘要更多素材）
  const MAX_PER_FEED = 15;      // 每 feed 软配额，保证多源覆盖

  // 生成 dedupKey：标题归一化后取前 40 字符的简易哈希，用于跨源去重
  function _makeDedupKey(title) {
    if (!title) return '';
    const normalized = String(title)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')        // 去所有空白（含全角空格）
      .replace(/[【】\[\]()（）{}<>《》""'':：,，.。!！?？;；\-_~`·]/g, ''); // 去标点
    const slice = normalized.slice(0, 40);
    // 简易 32 位哈希（djb2 变体）
    let hash = 5381;
    for (let i = 0; i < slice.length; i++) {
      hash = ((hash << 5) + hash + slice.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  async function enqueueItems(feed, items) {
    const q = await getQueue();
    const queuedAt = Date.now();
    const now = Date.now();

    // 时间过滤：剔除超过 2 天的历史文章（首次订阅保护）
    const recentItems = items.filter(it => {
      const pub = it.publishedAt;
      if (!pub) return true;  // 无发布时间保留
      const pubMs = typeof pub === 'number' ? pub : Date.parse(pub);
      if (!pubMs || isNaN(pubMs)) return true;  // 解析失败保留
      return (now - pubMs) < PUSH_MAX_AGE_MS;
    });
    if (recentItems.length < items.length) {
      console.info('[PushStore] filtered old articles: kept', recentItems.length, '/', items.length, '(feed:', feed.title, ', max age: 2 days)');
    }

    const newEntries = recentItems.map(it => ({
      feedId: feed.id || feed.feedId || '',
      feedTitle: feed.title || '',
      item: {
        title: it.title || '',
        link: it.link || '',
        summary: (it.summary || '').slice(0, 1000),  // 放宽到 1000 字，给 AI 更多上下文
        imageUrl: it.imageUrl || '',
        publishedAt: it.publishedAt || '',
        author: it.author || ''                       // 新增：用于来源署名
      },
      queuedAt,
      dedupKey: _makeDedupKey(it.title)                // 新增：跨源去重 key
    }));
    const next = [...q, ...newEntries];
    let quotaOverflow = 0;
    let globalOverflow = 0;
    let trimmed = next;
    if (next.length > MAX_QUEUE) {
      // 1. 先按 feed 软配额截断（每 feed 最多 MAX_PER_FEED 篇，保留最新）
      const cntByFeed = new Map();
      // 倒序遍历便于保留最新（入队是按时间追加，末尾较新）
      const afterQuota = [];
      for (let i = next.length - 1; i >= 0; i--) {
        const e = next[i];
        const cnt = cntByFeed.get(e.feedId) || 0;
        if (cnt < MAX_PER_FEED) {
          cntByFeed.set(e.feedId, cnt + 1);
          afterQuota.unshift(e);  // 保持原顺序
        }
      }
      quotaOverflow = next.length - afterQuota.length;

      // 2. 若仍超限，按 publishedAt 降序全局截断
      if (afterQuota.length > MAX_QUEUE) {
        afterQuota.sort((a, b) => {
          const aT = a.item.publishedAt ? (typeof a.item.publishedAt === 'number' ? a.item.publishedAt : Date.parse(a.item.publishedAt)) : 0;
          const bT = b.item.publishedAt ? (typeof b.item.publishedAt === 'number' ? b.item.publishedAt : Date.parse(b.item.publishedAt)) : 0;
          return (bT || 0) - (aT || 0);
        });
        globalOverflow = afterQuota.length - MAX_QUEUE;
        trimmed = afterQuota.slice(0, MAX_QUEUE);
      } else {
        trimmed = afterQuota;
      }
      console.warn('[PushStore] queue overflow: quotaOverflow=', quotaOverflow, 'globalOverflow=', globalOverflow, '(feed:', feed.title, ')');
    }
    await chrome.storage.local.set({ [QUEUE_KEY]: trimmed });
    return {
      queueLength: trimmed.length,
      overflowCount: quotaOverflow + globalOverflow,
      quotaOverflow,
      globalOverflow,
      enqueuedCount: recentItems.length
    };
  }

  async function drainQueue() {
    const q = await getQueue();
    if (q.length === 0) return [];
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    return q;
  }

  // ===== 静默时段判断（仅 instant 模式使用）=====
  function isInQuietHours(start, end) {
    if (!start || !end) return false;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (startMin < endMin) {
      // 同日内: 02:00 - 08:00
      return nowMin >= startMin && nowMin < endMin;
    } else {
      // 跨日: 22:00 - 07:00
      return nowMin >= startMin || nowMin < endMin;
    }
  }

  // ===== 发送历史（最近 20 条）=====
  const HISTORY_KEY = 'push_history';
  const HISTORY_MAX = 20;

  async function getHistory() {
    const r = await chrome.storage.local.get(HISTORY_KEY);
    return r[HISTORY_KEY] || [];
  }

  async function addHistory(record) {
    const history = await getHistory();
    history.unshift({
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      time: Date.now(),
      ...record
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
    return history;
  }

  async function clearHistory() {
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  }

  // ===== 按服务商分片存储 API Key / SMTP 授权码 =====
  // 存储键格式：push_key_<provider> / push_pass_<provider>
  // 每个服务商独立存储，互不覆盖，切换服务商即切换对应的凭证

  function _apiKeyStorageKey(provider) {
    return `push_key_${provider}`;
  }
  function _smtpPassStorageKey(provider) {
    return `push_pass_${provider}`;
  }

  // 保存指定 provider 的 API Key（加密）
  async function saveApiKeyForProvider(provider, plainKey) {
    if (!provider || !plainKey) return;
    const encData = await encryptApiKey(plainKey);
    await chrome.storage.local.set({ [_apiKeyStorageKey(provider)]: encData });
  }

  // 读取并解密指定 provider 的 API Key
  async function getDecryptedApiKeyForProvider(provider) {
    if (!provider) return '';
    const r = await chrome.storage.local.get(_apiKeyStorageKey(provider));
    const encData = r[_apiKeyStorageKey(provider)];
    if (!encData) return '';
    return decryptApiKey(encData);
  }

  // 判断指定 provider 是否已配置 API Key（不解密）
  async function hasApiKeyForProvider(provider) {
    if (!provider) return false;
    const r = await chrome.storage.local.get(_apiKeyStorageKey(provider));
    const encData = r[_apiKeyStorageKey(provider)];
    return !!(encData && encData.encKey && encData.iv && encData.salt);
  }

  // 清除指定 provider 的 API Key
  async function clearApiKeyForProvider(provider) {
    if (!provider) return;
    await chrome.storage.local.remove(_apiKeyStorageKey(provider));
  }

  // 保存指定 provider 的 SMTP 授权码（加密，复用 AES-GCM）
  async function saveSmtpPassForProvider(provider, plainPass) {
    if (!provider || !plainPass) return;
    const encData = await encryptApiKey(plainPass);
    await chrome.storage.local.set({ [_smtpPassStorageKey(provider)]: encData });
  }

  // 读取并解密指定 provider 的 SMTP 授权码
  async function getDecryptedSmtpPassForProvider(provider) {
    if (!provider) return '';
    const r = await chrome.storage.local.get(_smtpPassStorageKey(provider));
    const encData = r[_smtpPassStorageKey(provider)];
    if (!encData) return '';
    return decryptApiKey(encData);
  }

  // 判断指定 provider 是否已配置 SMTP 授权码（不解密）
  async function hasSmtpPassForProvider(provider) {
    if (!provider) return false;
    const r = await chrome.storage.local.get(_smtpPassStorageKey(provider));
    const encData = r[_smtpPassStorageKey(provider)];
    return !!(encData && encData.encKey && encData.iv && encData.salt);
  }

  // 清除指定 provider 的 SMTP 授权码
  async function clearSmtpPassForProvider(provider) {
    if (!provider) return;
    await chrome.storage.local.remove(_smtpPassStorageKey(provider));
  }

  global.PushStore = {
    getSettings,
    saveSettings,
    encryptApiKey,
    decryptApiKey,
    // 按服务商分片存储
    saveApiKeyForProvider,
    getDecryptedApiKeyForProvider,
    hasApiKeyForProvider,
    clearApiKeyForProvider,
    saveSmtpPassForProvider,
    getDecryptedSmtpPassForProvider,
    hasSmtpPassForProvider,
    clearSmtpPassForProvider,
    getQueue,
    enqueueItems,
    drainQueue,
    // 静默时段判断
    isInQuietHours,
    // 发送历史
    getHistory,
    addHistory,
    clearHistory,
    // 跨源去重工具（供 push-channel 的相似度合并复用）
    makeDedupKey: _makeDedupKey
  };
})(typeof self !== 'undefined' ? self : this);
