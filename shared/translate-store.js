// shared/translate-store.js
// 网页翻译存储层
// - 配置（明文）：引擎选择、目标语言、样式、AI 模式（reuse 复用 ai_classifier_config | custom 独立）
// - 缓存：文本 hash → 译文，30 天 TTL，最多 1000 条
// - 历史：最近 500 条翻译记录
// - 词汇本：用户维护的原文→译文映射，翻译时注入 prompt
// - 统计：总次数/成功率/平均延迟
//
// 依赖：chrome.storage.local
// 暴露：通过 self.translateStore = {...} 供 background.js importScripts 使用

(function (global) {
  'use strict';

  const CONFIG_KEY = 'translate_config';
  const CACHE_KEY = 'translate_cache';
  const HISTORY_KEY = 'translate_history';
  const GLOSSARY_KEY = 'translate_glossary';
  const STATS_KEY = 'translate_stats';

  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
  const CACHE_MAX = 1000;
  const HISTORY_MAX = 500;
  const GLOSSARY_MAX = 1000;

  // ===== 默认配置 =====
  const DEFAULT_CONFIG = {
    enabled: true,
    engine: 'ai',              // 'ai' | 'microsoft' | 'google' | 'deepl' | 'bing'
    aiMode: 'reuse',           // 'reuse'（复用 ai_classifier_config） | 'custom'
    aiConfig: null,            // aiMode='custom' 时使用，结构同 ai_classifier_config
    traditionalConfig: {
      google: { targetLang: 'zh-CN' },
      deepl: { apiKey: '', targetLang: 'ZH' },
      bing: { token: '', targetLang: 'zh-Hans' }
    },
    targetLang: 'zh-CN',
    sourceLang: 'auto',        // 'auto'（自动检测）| 'zh-CN' | 'en' | 'ja' ... 手动指定源语言
    defaultMode: 'bilingual',  // 'bilingual' | 'translationOnly' | 'originalOnly'
    hoverHotkey: 'ctrlKey',    // 'ctrlKey' | 'altKey' | 'metaKey'
    style: {
      theme: 'none',            // 主题：none|underline|nativeUnderline|dashed|dotted|wavy|grey|highlight|marker|background|borderLeft|blockquote|dividingLine
      position: 'below',        // 'below' | 'above'
      fontSize: 'follow',       // 'follow'（跟随原文 1em）| 'smaller'（0.9em）| 'custom'
      customFontSize: 14,       // fontSize='custom' 时使用（px）
      showDivider: false        // 是否显示分隔符（默认关闭，最沉浸）
    },
    summary: {
      length: 'medium',
      lang: 'follow',
      maxKeyPoints: 5
    },
    mindmap: {
      maxDepth: 3,
      layout: 'radial'
    },
    glossaryEnabled: true,
    cacheEnabled: true
  };

  // ===== 配置读写 =====
  async function getConfig() {
    const r = await chrome.storage.local.get(CONFIG_KEY);
    const stored = r[CONFIG_KEY] || {};
    // 深度合并默认值（一层）
    const merged = { ...DEFAULT_CONFIG, ...stored };
    merged.traditionalConfig = { ...DEFAULT_CONFIG.traditionalConfig, ...(stored.traditionalConfig || {}) };
    merged.style = { ...DEFAULT_CONFIG.style, ...(stored.style || {}) };
    merged.summary = { ...DEFAULT_CONFIG.summary, ...(stored.summary || {}) };
    merged.mindmap = { ...DEFAULT_CONFIG.mindmap, ...(stored.mindmap || {}) };
    return merged;
  }

  async function setConfig(config) {
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    return config;
  }

  // ===== 文本 hash（FNV-1a，简单快速，足够区分）=====
  function _hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  // ===== 缓存（按文本 hash + 目标语言 + 引擎 + 模型）=====
  // 参考 immersive-translate cacheKey：切换引擎或模型后不命中旧译文
  async function getCache(text, targetLang, engine, model) {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const cache = r[CACHE_KEY] || {};
    const key = _buildCacheKey(text, targetLang, engine, model);
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) {
      delete cache[key];
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
      return null;
    }
    return entry.translation;
  }

  async function setCache(text, targetLang, translation, engine, model) {
    const r = await chrome.storage.local.get(CACHE_KEY);
    const cache = r[CACHE_KEY] || {};
    const key = _buildCacheKey(text, targetLang, engine, model);
    cache[key] = { translation, ts: Date.now() };
    // 超上限时按时间淘汰最旧的
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      while (keys.length > CACHE_MAX) {
        delete cache[keys.shift()];
      }
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }

  // 缓存 key 构造：hash(text):targetLang:engine:model
  // 向后兼容：未传 engine/model 时退化为 hash(text):targetLang
  function _buildCacheKey(text, targetLang, engine, model) {
    const h = _hashText(text);
    const parts = [h, targetLang || 'zh-CN'];
    if (engine) parts.push(engine);
    if (model) parts.push(model);
    return parts.join(':');
  }

  async function clearCache() {
    await chrome.storage.local.remove(CACHE_KEY);
  }

  // ===== 历史记录 =====
  async function getHistory(limit = 100, urlFilter) {
    const r = await chrome.storage.local.get(HISTORY_KEY);
    let list = r[HISTORY_KEY] || [];
    if (urlFilter) list = list.filter(h => h.url === urlFilter);
    return list.slice(0, limit);
  }

  async function addHistory(entry) {
    const r = await chrome.storage.local.get(HISTORY_KEY);
    const list = r[HISTORY_KEY] || [];
    list.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      ...entry
    });
    while (list.length > HISTORY_MAX) list.pop();
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
  }

  async function clearHistory() {
    await chrome.storage.local.remove(HISTORY_KEY);
  }

  // ===== 词汇本 =====
  async function getGlossary() {
    const r = await chrome.storage.local.get(GLOSSARY_KEY);
    return (r[GLOSSARY_KEY] || { terms: [] }).terms;
  }

  async function addGlossaryTerm(term) {
    const r = await chrome.storage.local.get(GLOSSARY_KEY);
    const data = r[GLOSSARY_KEY] || { terms: [] };
    const newTerm = {
      id: term.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
      source: term.source || '',
      target: term.target || '',
      context: term.context || '',
      note: term.note || '',
      createdAt: Date.now()
    };
    data.terms.unshift(newTerm);
    while (data.terms.length > GLOSSARY_MAX) data.terms.pop();
    await chrome.storage.local.set({ [GLOSSARY_KEY]: data });
    return newTerm;
  }

  async function removeGlossaryTerm(id) {
    const r = await chrome.storage.local.get(GLOSSARY_KEY);
    const data = r[GLOSSARY_KEY] || { terms: [] };
    data.terms = data.terms.filter(t => t.id !== id);
    await chrome.storage.local.set({ [GLOSSARY_KEY]: data });
  }

  // ===== 统计 =====
  async function getStats() {
    const r = await chrome.storage.local.get(STATS_KEY);
    return r[STATS_KEY] || {
      totalRequests: 0,
      successCount: 0,
      failCount: 0,
      cacheHits: 0,
      avgLatencyMs: 0,
      lastUsed: null
    };
  }

  async function updateStats(delta) {
    const stats = await getStats();
    stats.totalRequests += delta.totalRequests || 0;
    stats.successCount += delta.successCount || 0;
    stats.failCount += delta.failCount || 0;
    stats.cacheHits += delta.cacheHits || 0;
    if (delta.latencyMs) {
      const n = stats.successCount || 1;
      stats.avgLatencyMs = Math.round((stats.avgLatencyMs * (n - 1) + delta.latencyMs) / n);
    }
    if (delta.successCount) stats.lastUsed = Date.now();
    await chrome.storage.local.set({ [STATS_KEY]: stats });
  }

  global.translateStore = {
    getConfig,
    setConfig,
    getCache,
    setCache,
    clearCache,
    getHistory,
    addHistory,
    clearHistory,
    getGlossary,
    addGlossaryTerm,
    removeGlossaryTerm,
    getStats,
    updateStats,
    _hashText
  };
})(self);
