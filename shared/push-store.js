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
//     strategy: 'batch30',      // 推送策略: instant | batch30 | batch60 | batch180 | daily
//     minIntervalMin: 30,       // 最小推送间隔(分钟)
//     dailyLimit: 20,           // 每日推送上限(封), 0=不限
//     quietHours: { start: '', end: '' },  // 静默时段 HH:MM, 空=不启用
//     keywords: { include: [], exclude: [] },
//     feedPushTo: {}            // { feedId: ['email'] }，预留多渠道
//   }
//   push_key_<provider>: { encKey, iv, salt }       // 按服务商分片的 API Key 加密存储
//   push_pass_<provider>: { encKey, iv, salt }      // 按服务商分片的 SMTP 授权码加密存储
//   push_queue: [{ feed, item, queuedAt }]  // 聚合待推送队列
//   push_rate: { lastSentAt: 0, todayCount: 0, todayDate: 'YYYY-MM-DD' }  // 频率控制状态
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
      // HTTP API 模式
      encKey: '', iv: '', salt: '',
      endpoint: '',
      authType: 'bearer',
      // SMTP 模式
      username: '',
      encPass: '', ivPass: '', saltPass: '',
      smtpHost: '',
      smtpPort: 465,
      smtpTls: 'ssl'
    },
    strategy: 'batch30',
    minIntervalMin: 30,
    dailyLimit: 20,
    quietHours: { start: '', end: '' },
    keywords: { include: [], exclude: [] },
    feedPushTo: {}
  };

  async function getSettings() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const s = r[STORAGE_KEY];
    if (!s) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // 深度合并，确保嵌套字段不缺失
    const merged = {
      ...DEFAULT_SETTINGS,
      ...s,
      email: { ...DEFAULT_SETTINGS.email, ...(s.email || {}) },
      quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(s.quietHours || {}) },
      keywords: { ...DEFAULT_SETTINGS.keywords, ...(s.keywords || {}) },
      feedPushTo: s.feedPushTo || {}
    };
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
      feedPushTo: { ...cur.feedPushTo, ...(patch.feedPushTo || {}) }
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  // ===== SMTP 授权码加密存储（复用 AES-GCM，独立 IV/salt）=====
  async function saveSmtpPassword(plainPass) {
    const encData = await encryptApiKey(plainPass); // 复用同一加密函数
    return saveSettings({
      email: { encPass: encData.encKey, ivPass: encData.iv, saltPass: encData.salt }
    });
  }

  async function getDecryptedSmtpPassword() {
    const s = await getSettings();
    if (!s.email.encPass || !s.email.ivPass || !s.email.saltPass) return '';
    return decryptApiKey({
      encKey: s.email.encPass,
      iv: s.email.ivPass,
      salt: s.email.saltPass
    });
  }

  async function hasSmtpPassword() {
    const s = await getSettings();
    return !!(s.email.encPass && s.email.ivPass && s.email.saltPass);
  }

  // ===== 聚合队列管理 =====
  const QUEUE_KEY = 'push_queue';

  async function getQueue() {
    const r = await chrome.storage.local.get(QUEUE_KEY);
    return r[QUEUE_KEY] || [];
  }

  async function enqueueItems(feed, items) {
    const q = await getQueue();
    const queuedAt = Date.now();
    const newEntries = items.map(it => ({
      feedId: feed.id || feed.feedId || '',
      feedTitle: feed.title || '',
      item: {
        title: it.title || '',
        link: it.link || '',
        summary: it.summary || '',
        imageUrl: it.imageUrl || '',
        publishedAt: it.publishedAt || ''
      },
      queuedAt
    }));
    const next = [...q, ...newEntries];
    // 队列上限 100 条，避免无限增长
    const trimmed = next.length > 100 ? next.slice(next.length - 100) : next;
    await chrome.storage.local.set({ [QUEUE_KEY]: trimmed });
    return trimmed.length;
  }

  async function drainQueue() {
    const q = await getQueue();
    if (q.length === 0) return [];
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    return q;
  }

  // ===== 频率控制状态 =====
  const RATE_KEY = 'push_rate';

  async function getRateState() {
    const r = await chrome.storage.local.get(RATE_KEY);
    const today = new Date().toISOString().slice(0, 10);
    const s = r[RATE_KEY] || { lastSentAt: 0, todayCount: 0, todayDate: today };
    // 跨天重置
    if (s.todayDate !== today) {
      s.todayCount = 0;
      s.todayDate = today;
    }
    return s;
  }

  async function recordSend() {
    const s = await getRateState();
    s.lastSentAt = Date.now();
    s.todayCount = (s.todayCount || 0) + 1;
    await chrome.storage.local.set({ [RATE_KEY]: s });
  }

  // 检查是否允许推送（返回原因）
  async function checkRateLimit(settings) {
    const s = await getRateState();
    const now = Date.now();
    // 最小间隔检查
    const minIntervalMs = (settings.minIntervalMin || 0) * 60 * 1000;
    if (minIntervalMs > 0 && s.lastSentAt > 0 && (now - s.lastSentAt) < minIntervalMs) {
      return { allowed: false, reason: 'min_interval' };
    }
    // 每日上限检查
    if (settings.dailyLimit && settings.dailyLimit > 0 && s.todayCount >= settings.dailyLimit) {
      return { allowed: false, reason: 'daily_limit' };
    }
    // 静默时段检查
    const qh = settings.quietHours;
    if (qh && qh.start && qh.end) {
      if (_isInQuietHours(qh.start, qh.end)) {
        return { allowed: false, reason: 'quiet_hours' };
      }
    }
    return { allowed: true };
  }

  // 判断当前时间是否在静默时段内
  function _isInQuietHours(start, end) {
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

  // 专门用于保存 API Key（先加密再存）
  async function saveApiKey(plainKey) {
    const encData = await encryptApiKey(plainKey);
    return saveSettings({ email: encData });
  }

  // 读取并解密 API Key（供 background 调用）
  async function getDecryptedApiKey() {
    const s = await getSettings();
    return decryptApiKey(s.email);
  }

  // 判断是否已配置 API Key（不解密）
  async function hasApiKey() {
    const s = await getSettings();
    return !!(s.email && s.email.encKey && s.email.iv && s.email.salt);
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
    saveApiKey,
    getDecryptedApiKey,
    hasApiKey,
    encryptApiKey,
    decryptApiKey,
    saveSmtpPassword,
    getDecryptedSmtpPassword,
    hasSmtpPassword,
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
    getRateState,
    recordSend,
    checkRateLimit
  };
})(typeof self !== 'undefined' ? self : this);
