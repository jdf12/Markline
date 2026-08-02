// shared/ai-nav-store.js
// AI 对话导航存储层
// - 非敏感配置明文存储，与 voice-store.js 同模式
// - 通过 chrome.storage.local 持久化
//
// 存储结构：
//   ai_nav_settings: {
//     enabled: true,                  // 总开关
//     floatingBallEnabled: true,      // 悬浮球开关
//     position: 'right',              // 默认停靠位置 left/right
//     theme: 'auto',                  // auto/light/dark
//     fontSize: 'medium',             // small/medium/large
//     maxLength: 140,                 // 预览文本最大长度
//     minLength: 0,                   // AI 消息最小长度过滤（仅过滤 AI）
//     showNumber: true,               // 显示编号
//     autoScrollActive: true,         // 滚动联动高亮
//     platforms: { chatgpt: true, claude: true, ... }, // 各平台启用开关
//     customSites: []                 // 自定义站点（同 ChatTOC schema）
//   }
//   ai_nav_bookmarks:          { [conversationKey]: { [messageId]: true } }
//   ai_nav_sidebar_state:      { [conversationKey]: { visible, collapsed, width } }
//   ai_nav_message_widths:     { [templateKey]: number }

(function (global) {
  'use strict';

  const STORAGE_KEY = 'ai_nav_settings';
  const BOOKMARKS_KEY = 'ai_nav_bookmarks';
  const SIDEBAR_STATE_KEY = 'ai_nav_sidebar_state';
  const MESSAGE_WIDTHS_KEY = 'ai_nav_message_widths';

  // 默认所有已知平台都启用
  function buildDefaultPlatforms() {
    const platforms = {};
    const keys = (global.AiPlatforms?.getAllPlatformKeys?.() || []);
    keys.forEach((k) => { platforms[k] = true; });
    return platforms;
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    floatingBallEnabled: true,
    showTimeline: true,           // 竖线时间轴开关（在悬浮球外贴边显示对话节点）
    timelinePosition: 'free',     // 时间轴位置 free(自由拖拽) | left | right
    timelineFreeSide: 'right',    // 自由拖拽模式下最近吸附的侧 left | right
    timelineOnlyUser: false,      // 时间轴是否仅显示用户提问节点（默认 false：同时展示用户+AI）
    sidebarOpen: false,           // 侧边栏开关（仿 ChatTOC）
    sidebarWidth: 360,            // 侧边栏宽度
    sidebarFilter: 'all',         // 筛选标签 all|user|assistant|bookmark
    position: 'right',
    theme: 'auto',
    fontSize: 'medium',
    maxLength: 140,
    minLength: 0,
    showNumber: true,
    autoScrollActive: true,
    platforms: null,  // 运行时填充
    customSites: []
  };

  async function getSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] || {};
    const defaults = { ...DEFAULT_SETTINGS, platforms: buildDefaultPlatforms() };
    const merged = { ...defaults, ...stored };
    // 合并 platforms（新增的默认平台自动启用）
    if (!merged.platforms) merged.platforms = {};
    const allKeys = (global.AiPlatforms?.getAllPlatformKeys?.() || []);
    allKeys.forEach((k) => {
      if (merged.platforms[k] === undefined) merged.platforms[k] = true;
    });
    return merged;
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const merged = { ...current, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    return merged;
  }

  async function resetSettings() {
    const defaults = { ...DEFAULT_SETTINGS, platforms: buildDefaultPlatforms() };
    await chrome.storage.local.set({ [STORAGE_KEY]: defaults });
    return defaults;
  }

  // ===== 书签 =====
  async function getBookmarks() {
    const result = await chrome.storage.local.get(BOOKMARKS_KEY);
    return result[BOOKMARKS_KEY] || {};
  }

  async function getConversationBookmarks(conversationKey) {
    const all = await getBookmarks();
    return all[conversationKey] || {};
  }

  async function toggleBookmark(conversationKey, messageId) {
    const all = await getBookmarks();
    if (!all[conversationKey]) all[conversationKey] = {};
    if (all[conversationKey][messageId]) {
      delete all[conversationKey][messageId];
    } else {
      all[conversationKey][messageId] = true;
    }
    await chrome.storage.local.set({ [BOOKMARKS_KEY]: all });
    return Boolean(all[conversationKey][messageId]);
  }

  // ===== 侧边栏状态 =====
  async function getSidebarState(conversationKey) {
    const result = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
    const all = result[SIDEBAR_STATE_KEY] || {};
    return all[conversationKey] || { visible: true, collapsed: false, width: 360 };
  }

  async function setSidebarState(conversationKey, patch) {
    const result = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
    const all = result[SIDEBAR_STATE_KEY] || {};
    const current = all[conversationKey] || { visible: true, collapsed: false, width: 360 };
    all[conversationKey] = { ...current, ...patch };
    await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: all });
    return all[conversationKey];
  }

  // ===== 消息宽度记忆 =====
  async function getMessageWidths() {
    const result = await chrome.storage.local.get(MESSAGE_WIDTHS_KEY);
    return result[MESSAGE_WIDTHS_KEY] || {};
  }

  async function setMessageWidth(templateKey, width) {
    const result = await chrome.storage.local.get(MESSAGE_WIDTHS_KEY);
    const all = result[MESSAGE_WIDTHS_KEY] || {};
    all[templateKey] = width;
    await chrome.storage.local.set({ [MESSAGE_WIDTHS_KEY]: all });
    return width;
  }

  async function deleteMessageWidth(templateKey) {
    const result = await chrome.storage.local.get(MESSAGE_WIDTHS_KEY);
    const all = result[MESSAGE_WIDTHS_KEY] || {};
    if (all[templateKey] !== undefined) {
      delete all[templateKey];
      await chrome.storage.local.set({ [MESSAGE_WIDTHS_KEY]: all });
    }
    return true;
  }

  // ===== ConversationKey 规范化（移植自 ChatTOC）=====
  // 忽略 utm_*、model、temporary-chat、hl、lang、locale、ref、source 等易变参数
  function buildConversationKey(domain) {
    const safeDomain = (domain || '').toString().trim().toLowerCase();
    let path = '/';
    let normalizedSearch = '';
    let normalizedHash = '';

    try {
      const url = new URL(window.location.href);
      path = url.pathname || '/';

      const ignoredParams = new Set([
        'model', 'temporary-chat', 'temporary', 'hl', 'lang', 'locale', 'ref', 'source'
      ]);
      const entries = [];
      url.searchParams.forEach((value, key) => {
        const safeKey = (key || '').toString().trim();
        if (!safeKey) return;
        const normalizedKey = safeKey.toLowerCase();
        if (normalizedKey.startsWith('utm_') || ignoredParams.has(normalizedKey)) return;
        entries.push([safeKey, (value || '').toString()]);
      });
      entries.sort(([left], [right]) => left.localeCompare(right));
      if (entries.length) {
        const params = new URLSearchParams();
        entries.forEach(([key, value]) => params.append(key, value));
        normalizedSearch = `?${params.toString()}`;
      }

      const hash = (url.hash || '').toString().trim();
      if (hash && hash !== '#') normalizedHash = hash;
    } catch {
      path = window.location.pathname || '/';
    }

    return `${safeDomain}${path}${normalizedSearch}${normalizedHash}`;
  }

  global.AiNavStore = {
    STORAGE_KEY,
    BOOKMARKS_KEY,
    SIDEBAR_STATE_KEY,
    MESSAGE_WIDTHS_KEY,
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    resetSettings,
    getBookmarks,
    getConversationBookmarks,
    toggleBookmark,
    getSidebarState,
    setSidebarState,
    getMessageWidths,
    setMessageWidth,
    deleteMessageWidth,
    buildConversationKey
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
