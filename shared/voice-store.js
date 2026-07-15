// shared/voice-store.js
// 语音朗读设置存储层
// - 仅存储非敏感配置（音色、语速、音调、音量、桥接端口等），无需加密
// - 与 push-store.js 不同：无 API Key/授权码，纯明文存储
// - 通过 chrome.storage.local 持久化
//
// 存储结构：
//   voice_settings: {
//     enabled: true,                         // 总开关
//     bridgePort: 7822,                      // 本地桥接端口
//     defaultVoice: 'zh-CN-XiaoxiaoNeural',  // 默认音色 ShortName
//     rate: '+0%',                           // 语速 -50% ~ +100%
//     pitch: '+0Hz',                         // 音调
//     volume: '+0%',                         // 音量
//     autoExtract: true,                     // 用 Readability 提取正文
//     maxChars: 30000,                       // 单次合成最大字符数
//     preferAsync: true,                     // 长文本用异步合成
//     asyncThreshold: 3000                   // 超过此长度走异步
//   }

(function (global) {
  'use strict';

  const STORAGE_KEY = 'voice_settings';

  const DEFAULT_SETTINGS = {
    enabled: true,
    bridgePort: 7822,
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%',
    autoExtract: true,
    maxChars: 30000,
    preferAsync: true,
    asyncThreshold: 3000
  };

  /**
   * 读取设置（合并默认值，保证字段完整）
   */
  async function getSettings() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY] || {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /**
   * 保存设置（patch 合并）
   */
  async function setSettings(patch) {
    const current = await getSettings();
    const merged = { ...current, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    return merged;
  }

  /**
   * 重置为默认设置
   */
  async function resetSettings() {
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...DEFAULT_SETTINGS } });
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * 构造桥接基础 URL（基于端口）
   */
  function getBridgeBaseUrl(port) {
    const p = port || DEFAULT_SETTINGS.bridgePort;
    return `http://127.0.0.1:${p}`;
  }

  global.VoiceStore = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    getSettings,
    setSettings,
    resetSettings,
    getBridgeBaseUrl
  };
})(self);
