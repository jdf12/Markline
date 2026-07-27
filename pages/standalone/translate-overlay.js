// pages/standalone/translate-overlay.js
// 网页翻译父页面桥接层 + MDI 窗口翻译工具栏 UI
// - 运行在 standalone.html（chrome-extension 上下文，可使用 chrome.scripting / chrome.webNavigation / chrome.runtime）
// - 通过 chrome.scripting.executeScript({target:{tabId, frameIds:[frameId]}}) 注入 translate-injector.js 到指定 iframe
// - 通过 window.postMessage 与 iframe 内的 translate-injector.js 桥接
// - 通过 chrome.runtime.sendMessage 与 background/translate-channel.js 通信
// - 暴露 window.TranslateOverlay = { toggle(windowId, url, winEl), hide(), ... }
//
// 依赖：chrome.tabs, chrome.webNavigation, chrome.scripting, chrome.runtime

(function () {
  'use strict';

  // ===== 状态：当前活跃的翻译工具栏（每个 MDI 窗口一个）=====
  // key: windowId, value: { winEl, url, iframeEl, toolbarEl, injected, config }
  const _activeOverlays = new Map();
  let _translateConfig = null;

  // ===== 加载翻译配置 =====
  async function _loadConfig() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'translateGetConfig' });
      if (resp && resp.success && resp.config) {
        _translateConfig = resp.config;
        return resp.config;
      }
    } catch (err) {
      console.warn('[TranslateOverlay] load config failed:', err);
    }
    _translateConfig = { enabled: true, engine: 'ai', defaultMode: 'bilingual', style: {}, targetLang: 'zh-CN' };
    return _translateConfig;
  }

  // ===== 监听配置变化：settings 页改了主题/语言等，自动重载并同步到所有活跃 iframe =====
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // translate_config 是 translate-store.js 的 CONFIG_KEY
    if (!changes.translate_config) return;
    _loadConfig().then(() => {
      // 同步新配置到所有活跃 overlay 的 iframe
      for (const ov of _activeOverlays.values()) {
        if (ov.injectorReady && ov.iframeEl) {
          _sendCommand(ov.iframeEl, 'setConfig', { config: _buildInjectorConfig() });
        }
      }
    });
  });

  // ===== 获取 standalone 页面所在的 tab =====
  let _cachedTabId = null;
  async function _getTabId() {
    if (_cachedTabId !== null) return _cachedTabId;
    try {
      const tab = await chrome.tabs.getCurrent();
      _cachedTabId = tab ? tab.id : null;
    } catch (err) {
      console.warn('[TranslateOverlay] getCurrent tab failed:', err);
    }
    return _cachedTabId;
  }

  // ===== frameId 缓存（避免每次注入都调用 webNavigation.getAllFrames）=====
  // key: iframeUrl, value: { frameId, ts }
  const _frameIdCache = new Map();
  const _FRAME_ID_CACHE_TTL = 60000; // 60 秒内复用 frameId

  // ===== 通过 webNavigation 查找 iframe 的 frameId（带缓存）=====
  async function _findFrameId(iframeUrl) {
    // 1. 查缓存（未过期则直接返回）
    const cached = _frameIdCache.get(iframeUrl);
    if (cached && (Date.now() - cached.ts) < _FRAME_ID_CACHE_TTL) {
      return cached.frameId;
    }

    const tabId = await _getTabId();
    if (tabId === null) return null;
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!frames) return null;
      // 预计算目标 URL 的 origin+path（避免循环内重复 new URL）
      let targetKey = null;
      try {
        const u = new URL(iframeUrl);
        targetKey = u.origin + u.pathname;
      } catch {}

      // 2. 精确匹配优先，origin+path 兜底
      let match = frames.find(f => f.url === iframeUrl && f.frameId > 0);
      if (!match && targetKey) {
        match = frames.find(f => {
          if (f.frameId <= 0 || !f.url) return false;
          if (f.url === iframeUrl) return true;
          try {
            const fu = new URL(f.url);
            return (fu.origin + fu.pathname) === targetKey;
          } catch {
            return false;
          }
        });
      }
      if (match) {
        // 写缓存
        _frameIdCache.set(iframeUrl, { frameId: match.frameId, ts: Date.now() });
        return match.frameId;
      }
      return null;
    } catch (err) {
      console.warn('[TranslateOverlay] getAllFrames failed:', err);
      return null;
    }
  }

  // ===== 使 frameId 缓存失效（iframe reload 后调用）=====
  function _invalidateFrameIdCache(iframeUrl) {
    if (iframeUrl) {
      _frameIdCache.delete(iframeUrl);
    } else {
      _frameIdCache.clear();
    }
  }

  // ===== 注入翻译脚本到 iframe（JS + CSS 并行注入）=====
  async function _injectInjector(iframeUrl) {
    const tabId = await _getTabId();
    const frameId = await _findFrameId(iframeUrl);
    if (tabId === null || frameId === null) {
      console.warn('[TranslateOverlay] cannot resolve tab/frame for', iframeUrl);
      return false;
    }
    try {
      // 并行注入 JS 和 CSS，节省一次往返时间
      const target = { tabId, frameIds: [frameId] };
      const [jsResult, cssResult] = await Promise.allSettled([
        chrome.scripting.executeScript({
          target,
          files: ['content/translate-injector.js']
        }),
        chrome.scripting.insertCSS({
          target,
          files: ['content/translate-injector.css']
        })
      ]);
      // JS 注入失败才算整体失败（CSS 失败不影响功能，仅样式缺失）
      if (jsResult.status === 'rejected') {
        console.warn('[TranslateOverlay] JS inject failed:', jsResult.reason);
        return false;
      }
      // JS 注入成功但 frameId 可能已失效（iframe reload），清除缓存重试一次
      const jsArr = jsResult.value;
      if (!jsArr || jsArr.length === 0) {
        _invalidateFrameIdCache(iframeUrl);
        // 重新查找 frameId 并重试一次
        const newFrameId = await _findFrameId(iframeUrl);
        if (newFrameId === null || newFrameId === frameId) return false;
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [newFrameId] },
            files: ['content/translate-injector.js']
          });
          return true;
        } catch (err) {
          console.warn('[TranslateOverlay] retry inject failed:', err);
          return false;
        }
      }
      return true;
    } catch (err) {
      console.warn('[TranslateOverlay] inject failed:', err);
      return false;
    }
  }

  // ===== 向 iframe 发送请求-响应消息 =====
  function _sendRequest(iframeEl, action, payload, timeoutMs = 60000) {
    return new Promise((resolve) => {
      if (!iframeEl || !iframeEl.contentWindow) {
        resolve({ ok: false, error: 'NO_IFRAME' });
        return;
      }
      const id = 'ov-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: 'TIMEOUT' });
      }, timeoutMs);

      function handler(e) {
        const data = e.data;
        if (!data || data.source !== 'markline-injector') return;
        if (data.id !== id) return;
        // 验证来源 iframe（通过 e.source）
        if (e.source !== iframeEl.contentWindow) return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(data.payload || { ok: false, error: 'EMPTY' });
      }
      window.addEventListener('message', handler);
      iframeEl.contentWindow.postMessage({
        source: 'markline-overlay',
        type: 'request',
        id,
        action,
        ...payload
      }, '*');
    });
  }

  // ===== 向 iframe 发送命令（无需响应）=====
  function _sendCommand(iframeEl, command, extra = {}) {
    if (!iframeEl || !iframeEl.contentWindow) return;
    iframeEl.contentWindow.postMessage({
      source: 'markline-overlay',
      type: 'command',
      command,
      ...extra
    }, '*');
  }

  // ===== 响应 iframe 的请求（translateSingle / translateSelection）=====
  async function _handleInjectorRequest(iframeEl, url, action, payload) {
    try {
      let msgAction, msgPayload;
      // 注入页面标题作为上下文（P2-10 上下文注入）
      let pageTitle = '';
      try { pageTitle = iframeEl?.contentDocument?.title || ''; } catch {}
      switch (action) {
        case 'translateSingle':
          msgAction = 'translateSingle';
          msgPayload = { text: payload.text, pageTitle };
          break;
        case 'translateSelection':
          msgAction = 'translateSelection';
          msgPayload = {
            text: payload.text,
            contextBefore: payload.contextBefore,
            contextAfter: payload.contextAfter,
            pageTitle
          };
          break;
        default:
          return { ok: false, error: 'UNKNOWN_ACTION' };
      }
      const resp = await chrome.runtime.sendMessage({ action: msgAction, url, ...msgPayload });
      if (resp && resp.success) {
        // 划词字典增强：透传 dictionary 字段（单词返回字典 JSON）
        const result = { ok: true, translation: resp.translation };
        if (resp.dictionary) result.dictionary = resp.dictionary;
        if (resp.isWord !== undefined) result.isWord = resp.isWord;
        return result;
      }
      return { ok: false, error: resp?.error || 'TRANSLATE_FAILED' };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // ===== 监听 iframe 发来的请求（请求-响应模式）=====
  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || data.source !== 'markline-injector') return;
    // 请求-响应模式（id 存在但无 type）
    if (data.id && !data.type && data.action) {
      // 找到对应的 overlay
      for (const [winId, ov] of _activeOverlays.entries()) {
        if (ov.iframeEl && ov.iframeEl.contentWindow === e.source) {
          const payload = await _handleInjectorRequest(ov.iframeEl, ov.url, data.action, data.payload || {});
          ov.iframeEl.contentWindow.postMessage({
            source: 'markline-overlay',
            id: data.id,
            payload
          }, '*');
          return;
        }
      }
    }
    // 就绪通知
    if (data.type === 'ready') {
      // 找到对应 overlay，标记就绪
      for (const [winId, ov] of _activeOverlays.entries()) {
        if (ov.iframeEl && ov.iframeEl.contentWindow === e.source) {
          ov.injectorReady = true;
          // 注入当前配置
          _sendCommand(ov.iframeEl, 'setConfig', { config: _buildInjectorConfig() });
          // 自动检测源语种（仅当用户选 auto 时），更新「自动检测」option 文本
          _autoDetectSourceLang(ov);
        }
      }
    }
  });

  // ===== 构建传给 injector 的配置子集 =====
  function _buildInjectorConfig() {
    if (!_translateConfig) return {};
    return {
      defaultMode: _translateConfig.defaultMode || 'bilingual',
      hoverHotkey: _translateConfig.hoverHotkey || 'ctrlKey',
      style: _translateConfig.style || {
        theme: 'none',
        position: 'below',
        fontSize: 'follow',
        customFontSize: 14,
        showDivider: false
      }
    };
  }

  // ===== 构建 MDI 窗口的翻译工具栏 =====
  function _buildToolbar(ov) {
    const toolbar = document.createElement('div');
    toolbar.className = 'translate-toolbar';
    const initialMode = ov.currentMode || 'bilingual';
    toolbar.innerHTML = `
      <div class="translate-toolbar-header">
        <span class="translate-toolbar-title">${i18n('translateToolbarTitle')}</span>
        <button class="translate-toolbar-close" title="${i18n('close')}">✕</button>
      </div>
      <div class="translate-toolbar-row translate-lang-row">
        <select class="translate-engine-select" title="${i18n('translateEngineLabel')}">
          <option value="ai">${i18n('translateEngineAI')}</option>
          <option value="microsoft">${i18n('translateEngineMicrosoft')}</option>
          <option value="google">${i18n('translateEngineGoogle')}</option>
        </select>
        <select class="translate-source-lang-select" title="${i18n('translateSourceLabel')}">
          <option value="auto" data-i18n="translateSourceAuto">${i18n('translateSourceAuto')}</option>
          <option value="zh-CN">中文</option>
          <option value="zh-TW">中文（繁）</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
          <option value="es">Español</option>
          <option value="ru">Русский</option>
        </select>
        <span class="translate-lang-arrow" aria-hidden="true">→</span>
        <select class="translate-lang-select" title="${i18n('translateTargetLabel')}">
          <option value="zh-CN">中文</option>
          <option value="zh-TW">中文（繁）</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
          <option value="es">Español</option>
          <option value="ru">Русский</option>
        </select>
      </div>
      <div class="translate-mode-segments" role="tablist">
        <button class="translate-mode-segment" data-mode="bilingual" role="tab"
          title="${i18n('translateModeTipBilingual')}">${i18n('translateModeBilingual')}</button>
        <button class="translate-mode-segment" data-mode="translationOnly" role="tab"
          title="${i18n('translateModeTipTranslationOnly')}">${i18n('translateModeTranslationOnly')}</button>
        <button class="translate-mode-segment" data-mode="originalOnly" role="tab"
          title="${i18n('translateModeTipOriginalOnly')}">${i18n('translateModeOriginalOnly')}</button>
      </div>
      <div class="translate-toolbar-row">
        <button class="translate-btn translate-btn--primary translate-btn--full" data-action="translateAll">${i18n('translateActionTranslateAll')}</button>
      </div>
      <div class="translate-toolbar-row">
        <button class="translate-btn" data-action="summary">${i18n('translateActionSummary')}</button>
        <button class="translate-btn" data-action="mindmap">${i18n('translateActionMindmap')}</button>
      </div>
      <div class="translate-toolbar-row">
        <button class="translate-btn" data-action="clear">${i18n('translateActionClear')}</button>
        <button class="translate-btn" data-action="settings">${i18n('translateActionSettings')}</button>
      </div>
      <div class="translate-toolbar-status"></div>
      <div class="translate-toolbar-hint">
        <small>${i18n('translateHoverHint')}</small>
      </div>
    `;

    // 设置当前选中值
    const engineSel = toolbar.querySelector('.translate-engine-select');
    const sourceLangSel = toolbar.querySelector('.translate-source-lang-select');
    const langSel = toolbar.querySelector('.translate-lang-select');
    if (_translateConfig) {
      engineSel.value = _translateConfig.engine || 'ai';
      sourceLangSel.value = _translateConfig.sourceLang || 'auto';
      langSel.value = _translateConfig.targetLang || 'zh-CN';
    }

    // 初始化分段控件激活态
    _setModeUI(ov, initialMode, toolbar);

    // 关闭按钮
    toolbar.querySelector('.translate-toolbar-close').addEventListener('click', () => {
      hide(ov.windowId);
    });

    // 引擎/语言切换：实时同步到 _translateConfig 并保存
    engineSel.addEventListener('change', async () => {
      _translateConfig.engine = engineSel.value;
      await chrome.runtime.sendMessage({ action: 'translateSetConfig', config: _translateConfig });
      // 引擎切换后更新按钮可见性（摘要/脑图仅 AI 引擎可用）
      _updateToolbarButtonVisibility(ov);
    });
    sourceLangSel.addEventListener('change', async () => {
      _translateConfig.sourceLang = sourceLangSel.value;
      await chrome.runtime.sendMessage({ action: 'translateSetConfig', config: _translateConfig });
    });
    langSel.addEventListener('change', async () => {
      _translateConfig.targetLang = langSel.value;
      await chrome.runtime.sendMessage({ action: 'translateSetConfig', config: _translateConfig });
    });

    // 模式分段控件点击
    toolbar.querySelectorAll('.translate-mode-segment').forEach(seg => {
      seg.addEventListener('click', () => {
        _setMode(ov, seg.dataset.mode);
      });
    });

    // 按钮事件（点击前检查禁用状态）
    toolbar.querySelectorAll('.translate-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled') || btn.disabled) return;
        _onAction(btn.dataset.action, ov);
      });
    });

    // 先把 toolbar 挂到 ov 上，让后续的可见性/状态函数能正确读取 ov.toolbarEl
    ov.toolbarEl = toolbar;

    // 初始化按钮可见性（摘要/脑图仅 AI 引擎显示）
    _updateToolbarButtonVisibility(ov);
    // 初始状态：注入未完成前禁用所有翻译相关按钮（ov.injected 默认为 false）
    _updateToolbarButtonState(ov);

    return toolbar;
  }

  // ===== 更新工具栏按钮可见性（摘要/脑图仅 AI 引擎显示）=====
  function _updateToolbarButtonVisibility(ov) {
    if (!ov || !ov.toolbarEl) return;
    const engine = _translateConfig?.engine || 'ai';
    const isAI = engine === 'ai';
    // 摘要、脑图按钮仅在 AI 引擎下显示
    const summaryBtn = ov.toolbarEl.querySelector('[data-action="summary"]');
    const mindmapBtn = ov.toolbarEl.querySelector('[data-action="mindmap"]');
    if (summaryBtn) summaryBtn.style.display = isAI ? '' : 'none';
    if (mindmapBtn) mindmapBtn.style.display = isAI ? '' : 'none';
  }

  // ===== 更新工具栏按钮启用状态（注入失败时禁用翻译相关按钮）=====
  function _updateToolbarButtonState(ov) {
    if (!ov || !ov.toolbarEl) return;
    // 翻译相关按钮：翻译整页、摘要、脑图
    const actionBtns = ov.toolbarEl.querySelectorAll('.translate-btn[data-action="translateAll"], .translate-btn[data-action="summary"], .translate-btn[data-action="mindmap"]');
    const enabled = !!ov.injected;
    actionBtns.forEach(btn => {
      if (enabled) {
        btn.classList.remove('disabled');
        btn.disabled = false;
        btn.removeAttribute('title');
      } else {
        btn.classList.add('disabled');
        btn.disabled = true;
        btn.setAttribute('title', i18n('translateBtnDisabledTip'));
      }
    });
  }

  // ===== 设置模式（更新 UI + 发送命令到 injector）=====
  function _setMode(ov, mode) {
    if (!['bilingual', 'translationOnly', 'originalOnly'].includes(mode)) return;
    if (ov.currentMode === mode) return;
    ov.currentMode = mode;
    _setModeUI(ov, mode);
    _sendCommand(ov.iframeEl, 'setMode', { mode });
  }

  // ===== 仅更新分段控件 UI 激活态 =====
  function _setModeUI(ov, mode, toolbar) {
    const tb = toolbar || ov.toolbarEl;
    if (!tb) return;
    tb.querySelectorAll('.translate-mode-segment').forEach(seg => {
      const active = seg.dataset.mode === mode;
      seg.classList.toggle('active', active);
      seg.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  // ===== 按钮动作分发 =====
  async function _onAction(action, ov) {
    const statusEl = ov.toolbarEl.querySelector('.translate-toolbar-status');

    switch (action) {
      case 'translateAll':
        await _doTranslateAll(ov, statusEl);
        break;
      case 'clear':
        _sendCommand(ov.iframeEl, 'clearAll');
        if (statusEl) statusEl.textContent = i18n('translateStatusCleared');
        break;
      case 'summary':
        await _doSummary(ov, statusEl);
        break;
      case 'mindmap':
        await _doMindmap(ov, statusEl);
        break;
      case 'settings':
        if (chrome.runtime.openOptionsPage) {
          chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings/settings.html') + '#translate' });
        }
        break;
    }
  }

  // ===== 启发式语种检测（基于字符 Unicode 范围，用于「自动检测」option 显示）=====
  // 准确度足够 UI 展示，不依赖 API 调用
  const _LANG_DISPLAY = {
    'zh-CN': '中文', 'zh-TW': '中文', 'en': 'English', 'ja': '日本語',
    'ko': '한국어', 'fr': 'Français', 'de': 'Deutsch', 'es': 'Español', 'ru': 'Русский'
  };
  function _detectLangHeuristic(text) {
    if (!text) return '';
    // 取前 500 字符统计
    const sample = text.slice(0, 500);
    let cjk = 0, hiragana = 0, katakana = 0, hangul = 0, cyrillic = 0, latin = 0;
    for (const ch of sample) {
      const c = ch.codePointAt(0);
      if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
      else if (c >= 0x3040 && c <= 0x309F) hiragana++;
      else if (c >= 0x30A0 && c <= 0x30FF) katakana++;
      else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
      else if (c >= 0x0400 && c <= 0x04FF) cyrillic++;
      else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0xC0 && c <= 0xFF)) latin++;
    }
    // 优先级：假名/韩文 > 中文 > 西里尔 > 拉丁
    if (hiragana + katakana > 2) return 'ja';
    if (hangul > 2) return 'ko';
    if (cjk > latin * 0.3 && cjk > 2) return 'zh-CN';
    if (cyrillic > latin * 0.5 && cyrillic > 2) return 'ru';
    if (latin > 0) return 'en';
    return '';
  }

  // ===== 更新「自动检测」option 文本（显示检测到的语种）=====
  function _updateAutoDetectOption(sourceLangSel, detectedLang) {
    if (!sourceLangSel) return;
    const autoOption = sourceLangSel.querySelector('option[value="auto"]');
    if (!autoOption) return;
    if (detectedLang && _LANG_DISPLAY[detectedLang]) {
      autoOption.textContent = `${i18n('translateSourceAuto')} - ${_LANG_DISPLAY[detectedLang]}`;
    } else {
      autoOption.textContent = i18n('translateSourceAuto');
    }
  }

  // ===== 自动检测源语种并更新「自动检测」option =====
  // 在 iframe 就绪后立即调用，无需用户点击翻译
  async function _autoDetectSourceLang(ov) {
    if (!ov || !ov.injectorReady || !ov.iframeEl) return;
    const sourceLangSel = ov.toolbarEl && ov.toolbarEl.querySelector('.translate-source-lang-select');
    if (!sourceLangSel || sourceLangSel.value !== 'auto') return;
    try {
      const resp = await _sendRequest(ov.iframeEl, 'collectParagraphs', {}, 5000);
      if (!resp.ok || !resp.items || !resp.items.length) return;
      const sampleText = resp.items.map(it => it.text).join(' ').slice(0, 1000);
      const detected = _detectLangHeuristic(sampleText);
      _updateAutoDetectOption(sourceLangSel, detected);
    } catch {
      // 静默失败，不影响工具栏正常使用
    }
  }

  // ===== 整页翻译（流式：通过 port 实时推送 partial 到 iframe）=====
  async function _doTranslateAll(ov, statusEl) {
    // 防御性检查：iframe contentWindow 可能中途失效（长时间挂起/睡眠后）
    if (!_isIframeAlive(ov.iframeEl)) {
      if (statusEl) statusEl.textContent = i18n('translateStatusReloadingIframe');
      const loaded = await _waitForIframeLoad(ov.iframeEl, ov.url);
      if (!loaded) {
        if (statusEl) statusEl.textContent = i18n('translateStatusIframeExpired');
        return;
      }
      // reload 后需要重新注入翻译脚本
      ov.injectorReady = false;
      ov.injected = false;
      await _injectInjector(ov.url);
    }
    if (statusEl) statusEl.textContent = i18n('translateStatusCollecting');
    // 1. 收集段落
    const collectResp = await _sendRequest(ov.iframeEl, 'collectParagraphs', {});
    if (!collectResp.ok || !collectResp.items || !collectResp.items.length) {
      if (statusEl) statusEl.textContent = collectResp.error || i18n('translateStatusNoText');
      return;
    }
    const items = collectResp.items;
    if (statusEl) statusEl.textContent = i18n('translateStatusTranslating', ['0%', `0/${items.length}`]);

    // 2. 通过 port 流式翻译（边翻译边推送 partial 到 iframe）
    const texts = items.map(it => it.text);
    const targetLang = _translateConfig.targetLang || 'zh-CN';
    const sourceLang = _translateConfig.sourceLang || 'auto';
    let pageTitle = '';
    try {
      pageTitle = ov.iframeEl?.contentDocument?.title || ov.iframeEl?.contentWindow?.document?.title || '';
    } catch {}

    // 建立 port 长连接
    const port = chrome.runtime.connect({ name: 'translate-stream' });
    let renderedCount = 0;
    let totalCount = items.length;

    // 通知 injector 开始流式翻译（清空旧译文，进入流式模式）
    _sendCommand(ov.iframeEl, 'streamStart', { count: totalCount });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'partial') {
        // 实时推送 partial 到 injector 增量渲染
        _sendCommand(ov.iframeEl, 'streamPartial', {
          idx: msg.idx,
          translation: msg.translation,
          final: msg.final === true
        });
        if (msg.final) renderedCount++;
        // 更新状态栏进度（百分比 + 当前/总数）
        if (statusEl) {
          const percent = totalCount > 0 ? Math.round((renderedCount / totalCount) * 100) : 0;
          statusEl.textContent = i18n('translateStatusTranslating', [`${percent}%`, `${renderedCount}/${totalCount}`]);
        }
      } else if (msg.type === 'batchError') {
        // 批次失败，更新状态但不中断
        if (statusEl) {
          statusEl.textContent = i18n('translateStatusFailed', [msg.error || 'batch error']);
        }
      } else if (msg.type === 'retry') {
        // 限流重试中：显示等待提示
        if (statusEl) {
          const secs = Math.ceil(msg.waitMs / 1000);
          statusEl.textContent = i18n('translateStatusRateLimited', [secs]);
        }
      } else if (msg.type === 'complete') {
        port.disconnect();
        if (msg.success) {
          // 最终 applyBatch 确保完整性（覆盖 partial）
          if (msg.results) {
            _sendCommand(ov.iframeEl, 'applyBatch', { results: msg.results });
          }
          _sendCommand(ov.iframeEl, 'streamEnd', {});
          if (statusEl) {
            const cached = msg.cacheHits || 0;
            const total = msg.results?.length || 0;
            if (ov.currentMode === 'originalOnly') {
              statusEl.textContent = i18n('translateStatusDoneHidden', [`100%`, total]);
            } else {
              statusEl.textContent = i18n('translateStatusDone', [`100%`, total, cached]);
            }
          }
        } else {
          _sendCommand(ov.iframeEl, 'streamEnd', {});
          if (statusEl) statusEl.textContent = i18n('translateStatusFailed', [msg.error || 'unknown']);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      _sendCommand(ov.iframeEl, 'streamEnd', {});
    });

    // 发起流式翻译请求
    port.postMessage({
      action: 'translateParagraphs',
      url: ov.url,
      texts,
      targetLang,
      sourceLang,
      pageTitle
    });
  }

  // ===== 智能摘要 =====
  async function _doSummary(ov, statusEl) {
    if (statusEl) statusEl.textContent = i18n('translateStatusExtracting');
    // 通过 injector 提取页面正文
    const extractResp = await _sendRequest(ov.iframeEl, 'collectParagraphs', {});
    if (!extractResp.ok) {
      if (statusEl) statusEl.textContent = i18n('translateStatusExtractFailed');
      return;
    }
    const content = extractResp.items.map(it => it.text).join('\n\n');
    if (content.length < 50) {
      if (statusEl) statusEl.textContent = i18n('translateContentTooShort');
      return;
    }
    if (statusEl) statusEl.textContent = i18n('translateStatusGenSummary');
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'translateGenerateSummary',
        url: ov.url,
        content
      });
      if (resp && resp.success) {
        _showSummaryPanel(ov, resp);
        if (statusEl) statusEl.textContent = i18n('translateStatusSummaryDone');
      } else {
        if (statusEl) statusEl.textContent = i18n('translateStatusSummaryFailed', [resp?.error || 'unknown']);
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = i18n('translateStatusSummaryError', [err.message]);
    }
  }

  // ===== 显示摘要浮层 =====
  function _showSummaryPanel(ov, resp) {
    // 移除已有
    _removeSummaryPanel(ov);
    const panel = document.createElement('div');
    panel.className = 'translate-summary-panel';
    const tagsHtml = (resp.tags || []).map(t => `<span class="translate-tag">${_esc(t)}</span>`).join('');
    const kpHtml = (resp.keyPoints || []).map(k => `<li>${_esc(k)}</li>`).join('');
    panel.innerHTML = `
      <div class="translate-summary-header">
        <span class="translate-summary-title">📝 ${i18n('translateSummaryTitle')}</span>
        <button class="translate-summary-close" title="${i18n('close')}">✕</button>
      </div>
      <div class="translate-summary-body">
        <div class="translate-summary-section">
          <div class="translate-summary-label">${i18n('translateSummaryLabel')}</div>
          <div class="translate-summary-text">${_esc(resp.summary || '')}</div>
        </div>
        ${kpHtml ? `<div class="translate-summary-section">
          <div class="translate-summary-label">${i18n('translateKeyPointsLabel')}</div>
          <ul class="translate-summary-kp">${kpHtml}</ul>
        </div>` : ''}
        ${tagsHtml ? `<div class="translate-summary-section">
          <div class="translate-summary-label">${i18n('translateTagsLabel')}</div>
          <div class="translate-summary-tags">${tagsHtml}</div>
        </div>` : ''}
      </div>
    `;
    ov.winEl.appendChild(panel);
    ov.summaryPanel = panel;
    panel.querySelector('.translate-summary-close').addEventListener('click', () => _removeSummaryPanel(ov));
  }

  function _removeSummaryPanel(ov) {
    if (ov.summaryPanel) {
      ov.summaryPanel.remove();
      ov.summaryPanel = null;
    }
  }

  // ===== 脑图生成与渲染 =====
  async function _doMindmap(ov, statusEl) {
    if (statusEl) statusEl.textContent = i18n('translateStatusExtracting');
    // 通过 injector 提取页面正文（复用 collectParagraphs）
    const extractResp = await _sendRequest(ov.iframeEl, 'collectParagraphs', {});
    if (!extractResp.ok) {
      if (statusEl) statusEl.textContent = i18n('translateStatusExtractFailed');
      return;
    }
    const content = extractResp.items.map(it => it.text).join('\n\n');
    if (content.length < 50) {
      if (statusEl) statusEl.textContent = i18n('translateContentTooShort');
      return;
    }
    if (statusEl) statusEl.textContent = i18n('translateStatusGenMindmap');
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'translateGenerateMindmap',
        url: ov.url,
        content
      });
      if (!resp || !resp.success || !resp.mindmap) {
        if (statusEl) statusEl.textContent = i18n('translateStatusMindmapFailed', [resp?.error || 'unknown']);
        return;
      }
      // 渲染脑图
      _showMindmapPanel(ov, resp.mindmap);
      if (statusEl) statusEl.textContent = i18n('translateStatusMindmapDone');
    } catch (err) {
      if (statusEl) statusEl.textContent = i18n('translateStatusMindmapError', [err.message]);
    }
  }

  // ===== 显示脑图浮层 =====
  function _showMindmapPanel(ov, mindmapData) {
    // 移除已有
    _removeMindmapPanel(ov);
    const panel = document.createElement('div');
    panel.className = 'translate-mindmap-panel';
    ov.winEl.appendChild(panel);
    ov.mindmapPanel = panel;

    // 调用 mindmap-view.js 渲染
    if (window.MindmapView && typeof window.MindmapView.show === 'function') {
      const config = _translateConfig || {};
      const mindmapCfg = config.mindmap || {};
      window.MindmapView.show(panel, mindmapData, {
        layout: mindmapCfg.layout || 'radial',
        maxDepth: mindmapCfg.maxDepth || 3
      });
    } else {
      panel.innerHTML = `<div style="padding:20px;text-align:center;color:#718096;">${i18n('translateMindmapNotLoaded')}</div>`;
    }
  }

  function _removeMindmapPanel(ov) {
    if (ov.mindmapPanel) {
      if (window.MindmapView && typeof window.MindmapView.hide === 'function') {
        window.MindmapView.hide();
      }
      ov.mindmapPanel.remove();
      ov.mindmapPanel = null;
    }
  }

  // ===== HTML 转义 =====
  function _esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== 工具栏定位：放在 MDI 窗口右上角内部 =====
  function _positionToolbar(ov) {
    const toolbar = ov.toolbarEl;
    const winRect = ov.winEl.getBoundingClientRect();
    // 相对于 winEl 定位
    toolbar.style.position = 'absolute';
    toolbar.style.top = '36px'; // 标题栏高度
    toolbar.style.right = '8px';
    toolbar.style.zIndex = '9999';
  }

  // ===== 检查 iframe 是否存活（contentWindow 可用）=====
  // 长时间挂起/睡眠后，浏览器可能卸载 iframe 的 contentWindow 但保留 DOM 元素
  function _isIframeAlive(iframeEl) {
    return !!(iframeEl && iframeEl.contentWindow);
  }

  // ===== 等待 iframe 加载完成（reload 后重建 contentWindow）=====
  function _waitForIframeLoad(iframeEl, url, timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (!iframeEl) { resolve(false); return; }
      // 已经加载完成
      try {
        if (iframeEl.contentDocument && iframeEl.contentDocument.readyState === 'complete') {
          resolve(true);
          return;
        }
      } catch {}
      const timer = setTimeout(() => {
        iframeEl.removeEventListener('load', onLoad, true);
        resolve(false);
      }, timeoutMs);
      function onLoad() {
        clearTimeout(timer);
        iframeEl.removeEventListener('load', onLoad, true);
        resolve(true);
      }
      iframeEl.addEventListener('load', onLoad, true);
      // 触发重新加载
      iframeEl.src = url;
    });
  }

  // ===== 对外 API：toggle（点击翻译按钮触发）=====
  async function toggle(windowId, url, winEl) {
    // 已存在则隐藏
    if (_activeOverlays.has(windowId)) {
      hide(windowId);
      return;
    }

    // 加载配置（首次）
    if (!_translateConfig) await _loadConfig();

    const iframeEl = winEl.querySelector('.mdi-window-iframe');
    if (!iframeEl) {
      console.warn('[TranslateOverlay] no iframe found');
      return;
    }

    const ov = {
      windowId,
      url,
      winEl,
      iframeEl,
      toolbarEl: null,
      injectorReady: false,
      injected: false,
      currentMode: _translateConfig.defaultMode || 'bilingual',
      summaryPanel: null,
      mindmapPanel: null
    };

    // 创建工具栏
    ov.toolbarEl = _buildToolbar(ov);
    winEl.appendChild(ov.toolbarEl);
    _positionToolbar(ov);

    _activeOverlays.set(windowId, ov);

    // 检测 iframe contentWindow 是否存活
    // 长时间挂起/睡眠后 iframe 可能被浏览器卸载，需要 reload 恢复
    if (!_isIframeAlive(iframeEl)) {
      const statusElReload = ov.toolbarEl.querySelector('.translate-toolbar-status');
      if (statusElReload) statusElReload.textContent = i18n('translateStatusReloadingIframe');
      _invalidateFrameIdCache(url); // iframe 将要 reload，清除旧的 frameId 缓存
      const loaded = await _waitForIframeLoad(iframeEl, url);
      if (!loaded) {
        const statusElFail = ov.toolbarEl.querySelector('.translate-toolbar-status');
        if (statusElFail) statusElFail.textContent = i18n('translateStatusIframeExpired');
        return;
      }
    }

    // 注入翻译脚本到 iframe
    const statusEl0 = ov.toolbarEl.querySelector('.translate-toolbar-status');
    if (statusEl0) statusEl0.textContent = i18n('translateStatusInjecting');
    // 并行预热 frameId 缓存 + 执行注入
    const injected = await _injectInjector(url);
    ov.injected = injected;
    const statusEl = ov.toolbarEl.querySelector('.translate-toolbar-status');
    if (statusEl) {
      statusEl.textContent = injected
        ? i18n('translateStatusReady')
        : i18n('translateStatusInjectFailed');
    }
    // 注入完成（或失败）后更新按钮启用状态
    _updateToolbarButtonState(ov);
    // 兜底：若 injector 已就绪（ready 通知先到），立即触发自动检测
    if (injected && ov.injectorReady) {
      _autoDetectSourceLang(ov);
    }
  }

  // ===== 隐藏 =====
  function hide(windowId) {
    const ov = _activeOverlays.get(windowId);
    if (!ov) return;
    // 清除 iframe 内翻译
    _sendCommand(ov.iframeEl, 'clearAll');
    if (ov.toolbarEl) ov.toolbarEl.remove();
    _removeSummaryPanel(ov);
    _removeMindmapPanel(ov);
    _activeOverlays.delete(windowId);
  }

  // ===== 隐藏全部（窗口关闭时调用）=====
  function hideAll() {
    for (const id of Array.from(_activeOverlays.keys())) hide(id);
  }

  // ===== 监听 MDI 窗口关闭事件（通过 custom event 由 mdi-manager 触发）=====
  // mdi-manager 在 closeWindow 时会移除 win DOM，这里在 detached 时清理
  // 简化：每秒检查一次活跃 overlay 对应的 winEl 是否仍在 DOM
  setInterval(() => {
    for (const [id, ov] of _activeOverlays.entries()) {
      if (!document.body.contains(ov.winEl)) {
        _activeOverlays.delete(id);
      }
    }
  }, 2000);

  // ===== 暴露 API =====
  window.TranslateOverlay = {
    toggle,
    hide,
    hideAll,
    getConfig: () => _translateConfig,
    reloadConfig: _loadConfig
  };

  // 初始加载配置
  _loadConfig();
})();
