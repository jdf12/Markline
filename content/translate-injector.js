// content/translate-injector.js
// 注入到 MDI iframe 的翻译脚本
// - 通过 chrome.scripting.executeScript({target:{tabId, frameIds:[frameId]}}) 注入
// - sandbox 限制下无法使用 chrome.runtime，故通过 window.postMessage 与父页面（translate-overlay.js）桥接
// - 父页面转发到 background，background 调用 translate-engine 后回传
//
// 消息协议：
//   injector → overlay:  { source:'markline-injector', id, action, payload }
//   overlay → injector:  { source:'markline-overlay',  id, action, payload }
//   id 用于请求-响应配对
//
// 功能：
//   P1: 收集段落 + 单段翻译
//   P2: 批量翻译 + 双语/仅译文/仅原文 模式切换
//   P3: 鼠标悬停翻译（Ctrl+hover）+ 划词翻译
//
// 字段采集策略（参考 immersive-translate）：
//   - 块级标签：P, H1-H6, LI, BLOCKQUOTE, TD, TH, FIGCAPTION, DT, DD, DIV, UL, OL, CAPTION, SUMMARY, LEGEND, OPTION
//   - 内联标签：SPAN, A, B, STRONG, EM, I, U, MARK, SMALL, SUB, SUP（仅当父元素不在块级白名单内时作为独立段落翻译）
//   - 表单元素：BUTTON, LABEL
//   - 属性翻译：placeholder / title / alt / aria-label
//   - 排除：SCRIPT, STYLE, NOSCRIPT, CODE, PRE, TEXTAREA, KBD, SAMP, INPUT(password/email/button/submit/reset)
//   - DIV 嵌套去重：若 DIV 子树内已含块级白名单元素，则该 DIV 不作为翻译单元（避免嵌套重复翻译）

(function () {
  'use strict';

  // 防重复注入
  if (window.__marklineTranslateInjector) return;
  window.__marklineTranslateInjector = true;

  // ===== 配置（由 overlay 注入）=====
  let _config = {
    defaultMode: 'bilingual',
    hoverHotkey: 'ctrlKey',
    style: {
      theme: 'none',
      position: 'below',
      fontSize: 'follow',
      customFontSize: 14,
      showDivider: false
    }
  };
  let _currentMode = 'bilingual'; // 'bilingual' | 'translationOnly' | 'originalOnly'
  let _translated = false; // 当前页面是否已翻译过
  let _lastCollectedItems = []; // 上次 collectParagraphs 的结果（含 DOM 引用），供 applyBatch 索引
  let _streamingMode = false; // 流式翻译进行中（避免 partial 渲染时频繁 setMode）

  // ===== 标签分类（参考 immersive-translate content_main.js d4e 函数）=====
  // 块级白名单：作为独立翻译单元的容器标签
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD',
    'CAPTION', 'SUMMARY', 'LEGEND', 'OPTION'
  ]);
  // 容器型块级标签：子树内若含其他块级白名单元素，则该容器不作为翻译单元（避免嵌套重复）
  const CONTAINER_BLOCK_TAGS = new Set(['DIV', 'UL', 'OL', 'SECTION', 'ARTICLE', 'ASIDE']);
  // 内联白名单：仅当父元素不在块级白名单内时作为独立翻译单元
  const INLINE_TAGS = new Set([
    'SPAN', 'A', 'B', 'STRONG', 'EM', 'I', 'U', 'MARK',
    'SMALL', 'SUB', 'SUP', 'FONT', 'BIG', 'TT'
  ]);
  // 表单文本元素
  const FORM_TAGS = new Set(['BUTTON', 'LABEL']);
  // 不可翻译的黑名单标签（自身及子树均跳过）
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA',
    'KBD', 'SAMP', 'VAR', 'INPUT', 'SELECT', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME'
  ]);
  // 自身产物黑名单（避免二次翻译自身浮窗）
  const OWN_MARK_CLASS = 'markline-translation';
  const OWN_POPUP_SELECTOR = '.markline-hover-popup, .markline-selection-popup';
  // 用户标记不翻译的类名（参考 immersive-translate imt-notranslate）
  const NOTRANSLATE_CLASS = 'markline-notranslate';
  // 可翻译的属性列表
  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  // INPUT 中需要跳过属性翻译的 type
  const INPUT_SKIP_TYPES = new Set(['password', 'email', 'hidden', 'submit', 'reset', 'button', 'image']);

  // 用于 querySelectorAll 的目标元素选择器（块级 + 内联 + 表单）
  const TARGET_SELECTOR = [
    ...BLOCK_TAGS, ...CONTAINER_BLOCK_TAGS, ...INLINE_TAGS, ...FORM_TAGS
  ].map(t => t).join(',');

  // ===== 文本是否值得翻译 =====
  function _isTranslatable(text) {
    const t = (text || '').trim();
    if (t.length < 2) return false;
    if (t.length > 2000) return false;
    // 纯数字/符号
    if (!/[\p{L}]/u.test(t)) return false;
    return true;
  }

  // ===== 元素是否在黑名单子树内（祖先命中 SKIP_TAGS 或 notranslate）=====
  function _isInSkipSubtree(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      if (node.classList && node.classList.contains(NOTRANSLATE_CLASS)) return true;
      // 富文本编辑器检测（参考 immersive-translate c4e）
      if (node.getAttribute && node.getAttribute('data-lexical-editor') === 'true') return true;
      if (node.getAttribute && node.getAttribute('contenteditable') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }

  // ===== 元素是否自身或祖先已是译文节点 =====
  function _isInTranslationSubtree(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList && (node.classList.contains(OWN_MARK_CLASS) ||
          node.matches(OWN_POPUP_SELECTOR))) return true;
      node = node.parentElement;
    }
    return false;
  }

  // ===== 取元素的可翻译文本（处理含 code/pre 等排除子节点的情况）=====
  function _getTranslatableText(el) {
    // 含块级排除元素（pre/textarea/noscript）：跳过整个元素
    if (el.querySelector('pre, textarea, noscript, script, style')) return '';
    // 含 inline code 或已有译文/浮窗：仅取直接文本节点 + 非排除子元素（避免把代码一并翻译）
    if (el.querySelector('code, kbd, samp, .markline-translation, .markline-hover-popup, .markline-selection-popup')) {
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          // 跳过黑名单标签内的文本
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.matches(OWN_POPUP_SELECTOR) || parent.classList.contains(OWN_MARK_CLASS)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.classList.contains(NOTRANSLATE_CLASS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) {
        text += n.textContent;
      }
      return text.replace(/\s+/g, ' ').trim();
    }
    // 普通元素：innerText 感知渲染（含隐藏文本过滤），textContent 兜底
    return (el.innerText || el.textContent || '').trim();
  }

  // ===== 容器型块级标签是否可作为翻译单元 =====
  // 规则：子树内若已含其他块级白名单元素，则该容器不作为翻译单元（避免嵌套重复翻译）
  function _containerIsLeaf(el) {
    // 检查子树是否含 BLOCK_TAGS / CONTAINER_BLOCK_TAGS / FORM_TAGS 中的任意元素
    // 注意：这里只查直接 querySelectorAll，O(N) 在合理范围内
    const child = el.querySelector(
      [...BLOCK_TAGS, ...CONTAINER_BLOCK_TAGS, ...FORM_TAGS].map(t => t).join(',')
    );
    return !child;
  }

  // ===== 内联元素是否应作为独立翻译单元 =====
  // 规则：父元素不在块级白名单内（否则让父元素统一翻译）
  function _inlineIsIndependent(el) {
    const parent = el.parentElement;
    if (!parent) return true;
    // 父元素是块级/容器型块级/表单 → 让父元素统一翻译
    if (BLOCK_TAGS.has(parent.tagName) || CONTAINER_BLOCK_TAGS.has(parent.tagName) || FORM_TAGS.has(parent.tagName)) {
      return false;
    }
    // 父元素是另一个内联元素 → 仍然让本元素翻译（避免内联嵌套链路过长）
    // 但若父元素也是内联白名单且已有可翻译文本，则由父元素翻译
    if (INLINE_TAGS.has(parent.tagName)) {
      const parentText = _getTranslatableText(parent);
      if (_isTranslatable(parentText) && parentText.includes((el.innerText || el.textContent || '').trim())) {
        return false;
      }
    }
    return true;
  }

  // ===== 收集元素型可翻译段落（block / inline / form）=====
  function _collectElementParagraphs(elements) {
    const out = [];
    for (const el of elements) {
      // 排除自身译文/浮窗节点
      if (el.classList && (el.classList.contains(OWN_MARK_CLASS) || el.matches(OWN_POPUP_SELECTOR))) continue;
      // 排除黑名单子树
      if (_isInSkipSubtree(el)) continue;
      // 排除已有译文子树
      if (_isInTranslationSubtree(el)) continue;

      const tag = el.tagName;

      // 容器型块级标签的嵌套去重
      if (CONTAINER_BLOCK_TAGS.has(tag)) {
        if (!_containerIsLeaf(el)) continue;
      }

      // 内联标签的独立性判定
      if (INLINE_TAGS.has(tag)) {
        if (!_inlineIsIndependent(el)) continue;
      }

      const text = _getTranslatableText(el);
      if (!_isTranslatable(text)) continue;

      // 排除完全不可见元素（保留 viewport 外的元素，允许懒翻译扩展）
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // 类型判定
      let type = 'block';
      if (INLINE_TAGS.has(tag)) type = 'inline';
      else if (FORM_TAGS.has(tag)) type = 'inline'; // 表单元素按 inline 处理，避免破坏布局

      out.push({ el, text, type });
    }
    return out;
  }

  // ===== 收集属性型可翻译字段 =====
  function _collectAttrParagraphs() {
    const out = [];
    // 选择所有带可翻译属性的元素
    const attrSelector = TRANSLATABLE_ATTRS.map(a => `[${a}]`).join(',');
    const candidates = document.querySelectorAll(attrSelector);
    for (const el of candidates) {
      // 排除黑名单子树
      if (_isInSkipSubtree(el)) continue;
      // 排除已有译文子树
      if (_isInTranslationSubtree(el)) continue;
      // INPUT 类型过滤
      if (el.tagName === 'INPUT') {
        const type = (el.type || 'text').toLowerCase();
        if (INPUT_SKIP_TYPES.has(type)) continue;
      }
      for (const attr of TRANSLATABLE_ATTRS) {
        const val = el.getAttribute(attr);
        if (!val || !_isTranslatable(val)) continue;
        // 已翻译过的属性跳过（data-markline-orig-xxx 存在则跳过）
        if (el.getAttribute(`data-markline-orig-${attr}`) !== null) continue;
        // 完全不可见元素跳过
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        out.push({ el, text: val, type: 'attr', attr });
      }
    }
    return out;
  }

  // ===== 收集页面所有可翻译段落（元素 + 属性）=====
  function collectParagraphs() {
    const allElements = document.querySelectorAll(TARGET_SELECTOR);
    const elementItems = _collectElementParagraphs(allElements);
    const attrItems = _collectAttrParagraphs();
    // 合并：元素在前，属性在后
    return elementItems.concat(attrItems);
  }

  // ===== 应用主题与样式（通过 CSS 变量驱动，无需 inline style）=====
  // 在 documentElement 设置 data-markline-theme 和 data-markline-position
  // 在 body 设置 markline-show-divider class
  function _applyTheme() {
    const root = document.documentElement;
    const style = _config.style || {};
    // 主题（默认 none）
    root.setAttribute('data-markline-theme', style.theme || 'none');
    // 译文位置
    root.setAttribute('data-markline-position', style.position || 'below');
    // 字号（通过 CSS 变量覆盖）
    const fontSizeVar = _resolveFontSize(style.fontSize, style.customFontSize);
    if (fontSizeVar) root.style.setProperty('--markline-t-font-size', fontSizeVar);
    // 分隔符
    if (style.showDivider) {
      document.body.classList.add('markline-show-divider');
    } else {
      document.body.classList.remove('markline-show-divider');
    }
  }

  function _resolveFontSize(mode, custom) {
    if (mode === 'smaller') return '0.9em';
    if (mode === 'custom' && custom) return custom + 'px';
    return '1em'; // 'follow'
  }

  // ===== 渲染：双语对照（译文在原文下方/上方） - 元素型 =====
  // 译文节点标签与原文相同（保持段落语义），样式由 CSS 变量驱动
  function renderBilingual(el, translation, type) {
    const isInline = type === 'inline';
    // 复用已有译文节点
    let node = el.nextElementSibling && el.nextElementSibling.classList &&
               el.nextElementSibling.classList.contains(OWN_MARK_CLASS)
      ? el.nextElementSibling : null;
    if (!node) {
      // inline 类型使用 span 包装，避免破坏行内布局；block 类型与原文同标签
      node = document.createElement(isInline ? 'span' : (el.tagName || 'P'));
      node.className = OWN_MARK_CLASS + (isInline ? ' markline-translation--inline' : '');
      node.dataset.marklineTranslation = '1';
      // 排版位置
      if (_config.style.position === 'above') {
        el.parentNode.insertBefore(node, el);
      } else {
        el.parentNode.insertBefore(node, el.nextSibling);
      }
    }
    // 清空并重建内容（仅 text span，分隔符由 CSS 控制）
    node.innerHTML = '';
    const t = document.createElement('span');
    t.className = 'markline-translation-text';
    t.textContent = translation;
    node.appendChild(t);
    // 样式由 CSS 变量驱动，无需 inline style
  }

  // ===== 渲染：属性型翻译（直接修改属性值，原值存入 data-markline-orig-xxx）=====
  function renderAttrTranslation(el, attr, translation) {
    // 若未保存过原值，先保存
    if (el.getAttribute(`data-markline-orig-${attr}`) === null) {
      const orig = el.getAttribute(attr);
      if (orig === null) return;
      el.setAttribute(`data-markline-orig-${attr}`, orig);
    }
    el.setAttribute(attr, translation);
    // 标记此元素的此属性已翻译
    el.setAttribute('data-markline-translated', '1');
  }

  // ===== 流式增量渲染：仅更新译文文本，不重建节点（避免 divider 闪烁）=====
  // 复用已有译文节点（renderBilingual 创建的），仅替换 .markline-translation-text 内容
  function renderPartialTranslation(el, partialText, type) {
    const isInline = type === 'inline';
    // 查找已有译文节点
    let node = el.nextElementSibling && el.nextElementSibling.classList &&
               el.nextElementSibling.classList.contains(OWN_MARK_CLASS)
      ? el.nextElementSibling : null;
    if (!node) {
      // 首次 partial：创建节点（复用 renderBilingual 逻辑）
      renderBilingual(el, partialText, type);
      return;
    }
    // 已有节点：仅更新文本内容（保留 divider）
    let textEl = node.querySelector('.markline-translation-text');
    if (!textEl) {
      // 无 text 子元素，直接更新整个节点
      node.textContent = partialText;
    } else {
      textEl.textContent = partialText;
    }
  }

  // ===== 渲染：仅译文（隐藏原文，显示译文） - 元素型 =====
  function renderTranslationOnly(el, translation, type) {
    // 双语节点先存在，再切换显示
    if (!el.nextElementSibling || !el.nextElementSibling.classList ||
        !el.nextElementSibling.classList.contains(OWN_MARK_CLASS)) {
      renderBilingual(el, translation, type);
    }
    el.style.display = 'none';
    if (el.nextElementSibling) el.nextElementSibling.style.display = '';
  }

  // ===== 切换显示模式 =====
  function setMode(mode) {
    _currentMode = mode;
    const translations = document.querySelectorAll('.' + OWN_MARK_CLASS);
    switch (mode) {
      case 'bilingual':
        translations.forEach(n => n.style.display = '');
        // 恢复原文显示
        document.querySelectorAll('.markline-original-hidden').forEach(el => {
          el.style.display = '';
          el.classList.remove('markline-original-hidden');
        });
        // 属性型翻译无显示切换概念（已直接替换），保持现状
        break;
      case 'translationOnly':
        // 隐藏所有原文（标记过的）
        translations.forEach(n => {
          const prev = n.previousElementSibling;
          if (prev && !prev.classList.contains(OWN_MARK_CLASS) && !prev.classList.contains('markline-original-hidden')) {
            prev.classList.add('markline-original-hidden');
            prev.style.display = 'none';
          }
        });
        translations.forEach(n => n.style.display = '');
        break;
      case 'originalOnly':
        translations.forEach(n => n.style.display = 'none');
        document.querySelectorAll('.markline-original-hidden').forEach(el => {
          el.style.display = '';
          el.classList.remove('markline-original-hidden');
        });
        break;
    }
  }

  // ===== 应用整页翻译结果 =====
  // items: [{el, text, type, attr?}]
  // results: [{idx, translation}]
  function applyBatchTranslations(items, results) {
    for (const r of results) {
      const item = items[r.idx];
      if (!item || !r.translation) continue;
      if (item.type === 'attr') {
        renderAttrTranslation(item.el, item.attr, r.translation);
      } else {
        renderBilingual(item.el, r.translation, item.type);
      }
    }
    _translated = true;
    // 应用当前模式
    setMode(_currentMode);
  }

  // ===== 清除所有翻译 =====
  function clearAll() {
    // 移除译文节点
    document.querySelectorAll('.' + OWN_MARK_CLASS).forEach(n => n.remove());
    // 恢复原文显示
    document.querySelectorAll('.markline-original-hidden').forEach(el => {
      el.style.display = '';
      el.classList.remove('markline-original-hidden');
    });
    // 恢复属性原文
    document.querySelectorAll('[data-markline-translated]').forEach(el => {
      for (const attr of TRANSLATABLE_ATTRS) {
        const orig = el.getAttribute(`data-markline-orig-${attr}`);
        if (orig !== null) {
          el.setAttribute(attr, orig);
          el.removeAttribute(`data-markline-orig-${attr}`);
        }
      }
      el.removeAttribute('data-markline-translated');
    });
    _translated = false;
  }

  // ===== 鼠标悬停翻译（P3）=====
  let _hoverTimer = null;
  let _lastHoverEl = null;
  let _hoverPopup = null;

  function _onMouseOver(e) {
    if (!e[_config.hoverHotkey]) {
      // 不在 hotkey 按下状态：用定时器等 hotkey
      return;
    }
    // 悬停目标：扩展后的标签集合
    const el = e.target.closest(TARGET_SELECTOR);
    if (!el || (el.classList && el.classList.contains(OWN_MARK_CLASS))) return;
    if (el === _lastHoverEl) return;
    _lastHoverEl = el;
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => _translateForHover(el), 200);
  }

  function _onKeyDown(e) {
    // 当 hotkey 按下且鼠标在某个段落上，触发翻译
    if (!e[_config.hoverHotkey]) return;
    if (!_lastHoverEl) return;
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(() => _translateForHover(_lastHoverEl), 100);
  }

  async function _translateForHover(el) {
    // 优先处理属性型悬停（如 input placeholder）
    const attr = TRANSLATABLE_ATTRS.find(a => el.getAttribute(a) && _isTranslatable(el.getAttribute(a)));
    if (attr && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'IMG' || el.hasAttribute(attr))) {
      const val = el.getAttribute(attr);
      const result = await _requestOverlay('translateSingle', { text: val });
      if (result && result.ok && result.translation) {
        _showHoverPopup(el, result.translation);
      }
      return;
    }
    // 元素型悬停
    const text = _getTranslatableText(el);
    if (!_isTranslatable(text)) return;
    // 若已有双语译文，直接显示浮窗
    const next = el.nextElementSibling;
    if (next && next.classList.contains(OWN_MARK_CLASS)) {
      const t = next.querySelector('.markline-translation-text')?.textContent || '';
      if (t) { _showHoverPopup(el, t); return; }
    }
    // 否则请求翻译
    const result = await _requestOverlay('translateSingle', { text });
    if (result && result.ok && result.translation) {
      _showHoverPopup(el, result.translation);
    }
  }

  function _showHoverPopup(anchorEl, text) {
    _removeHoverPopup();
    const popup = document.createElement('div');
    popup.className = 'markline-hover-popup';
    popup.textContent = text;
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.left = (rect.left + window.scrollX) + 'px';
    popup.style.top = (rect.bottom + window.scrollY + 6) + 'px';
    popup.style.maxWidth = Math.min(rect.width, 400) + 'px';
    _hoverPopup = popup;
    // 5 秒后自动消失
    setTimeout(_removeHoverPopup, 5000);
  }

  function _removeHoverPopup() {
    if (_hoverPopup) { _hoverPopup.remove(); _hoverPopup = null; }
  }

  // ===== 划词翻译（P3）=====
  let _selectionPopup = null;
  let _selectionDebounceTimer = null;
  let _selectionReqId = 0; // 用于丢弃过期的防抖请求结果
  let _selectionPopupPinned = false; // 弹窗固定状态：拖拽后变 true，不再被 selectionchange/click 自动关闭

  function _onSelectionChange() {
    // 弹窗已固定（用户拖拽过）时，selectionchange 不再自动关闭弹窗
    if (_selectionPopupPinned) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      _removeSelectionPopup();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 1000) return;

    // 防抖：用户选择过程中 selectionchange 会频繁触发，等 300ms 选择稳定后再翻译
    if (_selectionDebounceTimer) clearTimeout(_selectionDebounceTimer);
    _selectionDebounceTimer = setTimeout(() => {
      _selectionDebounceTimer = null;
      _doSelectionTranslate();
    }, 300);
  }

  async function _doSelectionTranslate() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 1000) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // 取上下文
    const container = range.commonAncestorContainer;
    const parentText = container.parentElement ? (container.parentElement.innerText || '') : '';
    const idx = parentText.indexOf(text);
    const before = idx > 0 ? parentText.slice(Math.max(0, idx - 200), idx) : '';
    const after = idx >= 0 ? parentText.slice(idx + text.length, idx + text.length + 200) : '';

    const reqId = ++_selectionReqId;
    const result = await _requestOverlay('translateSelection', { text, contextBefore: before, contextAfter: after });

    // 丢弃过期结果（用户在选择过程中又选了新的文本）
    if (reqId !== _selectionReqId) return;

    if (result && result.ok && result.translation) {
      // P2-11 划词字典增强：单词返回字典数据，句子返回纯译文
      if (result.isWord && result.dictionary) {
        _showSelectionPopup(rect, text, result.translation, result.dictionary);
      } else {
        _showSelectionPopup(rect, text, result.translation, null);
      }
    } else if (result && result.ok && !result.translation) {
      // 翻译成功但译文为空（微软翻译偶发返回空字符串）
      _showSelectionPopup(rect, text, '(译文为空)', null);
    } else if (result && !result.ok) {
      // 翻译失败：显示错误提示，方便用户定位问题
      _showSelectionPopup(rect, text, '翻译失败: ' + (result.error || 'UNKNOWN'), null);
    }
  }

  // ===== 显示划词翻译弹窗（dictionary 非空时渲染字典信息）=====
  function _showSelectionPopup(rect, original, translation, dictionary) {
    _removeSelectionPopup();
    _selectionPopupPinned = false; // 新弹窗初始未固定
    const popup = document.createElement('div');
    popup.className = 'markline-selection-popup';
    if (dictionary) {
      // 字典模式：音标 + 词性分组释义 + 上下文分析
      const defsHtml = (dictionary.definitions || []).map(d => `
        <div class="markline-popup-def">
          <span class="markline-popup-pos">${d.pos || ''}</span>
          <span class="markline-popup-meaning">${d.meaning || ''}</span>
          ${d.example ? `<div class="markline-popup-example">${d.example.source || ''}<br><span class="markline-popup-example-trans">${d.example.target || ''}</span></div>` : ''}
        </div>
      `).join('');
      popup.innerHTML = `
        <div class="markline-popup-handle" title="拖拽移动"></div>
        <button class="markline-popup-close" title="关闭">✕</button>
        <div class="markline-popup-orig"></div>
        ${dictionary.phonetic ? `<div class="markline-popup-phonetic">${dictionary.phonetic}</div>` : ''}
        <div class="markline-popup-trans"></div>
        ${defsHtml ? `<div class="markline-popup-defs">${defsHtml}</div>` : ''}
        ${dictionary.contextual_analysis ? `<div class="markline-popup-analysis">${dictionary.contextual_analysis}</div>` : ''}
      `;
      popup.querySelector('.markline-popup-orig').textContent = original;
      popup.querySelector('.markline-popup-trans').textContent = translation;
    } else {
      // 句子模式：原文 + 译文
      popup.innerHTML = `
        <div class="markline-popup-handle" title="拖拽移动"></div>
        <button class="markline-popup-close" title="关闭">✕</button>
        <div class="markline-popup-orig"></div>
        <div class="markline-popup-trans"></div>
      `;
      popup.querySelector('.markline-popup-orig').textContent = original;
      popup.querySelector('.markline-popup-trans').textContent = translation;
    }
    document.body.appendChild(popup);
    // 智能定位：弹窗居中于选区下方，超出视口边缘时自动调整
    const popupRect = popup.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    let left = rect.left + window.scrollX + rect.width / 2 - popupRect.width / 2;
    let top = rect.bottom + window.scrollY + 8;
    // 右边缘超出
    if (left + popupRect.width > window.scrollX + viewportW - 12) {
      left = window.scrollX + viewportW - popupRect.width - 12;
    }
    // 左边缘超出
    if (left < window.scrollX + 12) {
      left = window.scrollX + 12;
    }
    // 下方空间不足时显示在选区上方
    if (top + popupRect.height > window.scrollY + viewportH - 12) {
      const aboveTop = rect.top + window.scrollY - popupRect.height - 8;
      if (aboveTop > window.scrollY + 12) {
        top = aboveTop;
      }
    }
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    _selectionPopup = popup;

    // 关闭按钮
    const closeBtn = popup.querySelector('.markline-popup-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _removeSelectionPopup();
      });
      // 阻止关闭按钮的 mousedown 触发选区变化
      closeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // 启用拖拽
    _enablePopupDrag(popup);

    // 弹窗内部 mousedown：阻止默认行为，避免破坏选区
    popup.addEventListener('mousedown', (e) => {
      // 不阻止手柄的 mousedown（已单独处理）
      if (e.target.classList.contains('markline-popup-handle')) return;
      if (e.target.classList.contains('markline-popup-close')) return;
      e.preventDefault();
    });

    // 点击外部关闭：仅在未固定时生效
    setTimeout(() => {
      document.addEventListener('click', _onOutsideClick, { once: true });
    }, 200);
  }

  // 点击外部关闭弹窗（仅当未固定时）
  function _onOutsideClick(e) {
    // 弹窗已固定，不响应外部点击关闭
    if (_selectionPopupPinned) return;
    // 点击在弹窗内部，不关闭
    if (_selectionPopup && _selectionPopup.contains(e.target)) return;
    _removeSelectionPopup();
  }

  // ===== 弹窗拖拽（顶部手柄区域）=====
  function _enablePopupDrag(popup) {
    const handle = popup.querySelector('.markline-popup-handle');
    if (!handle) return;
    let dragging = false;
    let startX = 0, startY = 0;
    let popupStartX = 0, popupStartY = 0;
    let moved = false;

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = popup.getBoundingClientRect();
      popupStartX = rect.left + window.scrollX;
      popupStartY = rect.top + window.scrollY;
      popup.classList.add('dragging');
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // 移动超过 3px 才算拖拽，避免误触
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        moved = true;
        // 拖拽开始后固定弹窗，不再被 selectionchange/click 自动关闭
        _selectionPopupPinned = true;
        popup.classList.add('pinned');
      }
      if (!moved) return;
      const newLeft = popupStartX + dx;
      const newTop = popupStartY + dy;
      // 限制在视口内
      const popupW = popup.offsetWidth;
      const popupH = popup.offsetHeight;
      const minLeft = window.scrollX + 4;
      const maxLeft = window.scrollX + window.innerWidth - popupW - 4;
      const minTop = window.scrollY + 4;
      const maxTop = window.scrollY + window.innerHeight - popupH - 4;
      popup.style.left = Math.max(minLeft, Math.min(maxLeft, newLeft)) + 'px';
      popup.style.top = Math.max(minTop, Math.min(maxTop, newTop)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      popup.classList.remove('dragging');
    });
  }

  function _removeSelectionPopup() {
    if (_selectionPopup) { _selectionPopup.remove(); _selectionPopup = null; }
    _selectionPopupPinned = false;
  }

  // ===== 与父页面 overlay 桥接 =====
  const _pendingRequests = new Map();
  let _reqId = 0;

  function _requestOverlay(action, payload, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const id = ++_reqId;
      _pendingRequests.set(id, { resolve, timer: null });
      const timer = setTimeout(() => {
        if (_pendingRequests.has(id)) {
          _pendingRequests.delete(id);
          resolve({ ok: false, error: 'TIMEOUT' });
        }
      }, timeoutMs);
      _pendingRequests.get(id).timer = timer;
      window.parent.postMessage({
        source: 'markline-injector',
        id,
        action,
        payload
      }, '*');
    });
  }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.source !== 'markline-overlay') return;
    const pending = _pendingRequests.get(data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    _pendingRequests.delete(data.id);
    pending.resolve(data.payload || { ok: false, error: 'EMPTY' });
  });

  // ===== 接收父页面指令（无需响应）=====
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.source !== 'markline-overlay') return;
    if (data.type !== 'command') return;
    switch (data.command) {
      case 'setConfig':
        _config = { ..._config, ...(data.config || {}) };
        if (_config.defaultMode) _currentMode = _config.defaultMode;
        // 应用主题样式（CSS 变量驱动）
        _applyTheme();
        break;
      case 'streamStart':
        // 流式翻译开始：清空旧译文，标记进入流式模式
        _streamingMode = true;
        break;
      case 'streamPartial': {
        // 流式 partial 译文：增量渲染（idx 对应 _lastCollectedItems）
        if (!_lastCollectedItems || !_lastCollectedItems[data.idx]) break;
        const item = _lastCollectedItems[data.idx];
        if (data.translation) {
          if (item.type === 'attr') {
            renderAttrTranslation(item.el, item.attr, data.translation);
          } else {
            renderPartialTranslation(item.el, data.translation, item.type);
          }
        }
        break;
      }
      case 'streamEnd':
        _streamingMode = false;
        // 流式结束后应用当前模式（显示/隐藏原文）
        setMode(_currentMode);
        break;
      case 'setMode':
        setMode(data.mode);
        break;
      case 'applyBatch':
        // 命令模式无 items 字段时，回退使用上次收集的段落
        applyBatchTranslations(data.items || _lastCollectedItems, data.results || []);
        break;
      case 'clearAll':
        clearAll();
        break;
    }
  });

  // ===== 监听事件（P3）=====
  document.addEventListener('mouseover', _onMouseOver, true);
  document.addEventListener('keydown', _onKeyDown);
  document.addEventListener('selectionchange', _onSelectionChange);

  // ===== 暴露给 overlay 主动调用（通过 postMessage 请求-响应）=====
  // 当 overlay 发送 action='collectParagraphs' 时，返回段落列表
  // 已在通用 message 监听器中处理（_requestOverlay 是反向请求）
  // 这里需要响应 overlay 的请求
  window.addEventListener('message', async (e) => {
    const data = e.data;
    if (!data || data.source !== 'markline-overlay') return;
    if (data.type !== 'request') return;
    let payload = { ok: false, error: 'UNKNOWN_ACTION' };
    try {
      switch (data.action) {
        case 'collectParagraphs': {
          const items = collectParagraphs();
          // 返回时不能传 DOM 元素，标记 idx 即可；overlay 端用 items 数组对应
          // 但元素引用无法跨 postMessage 传递，故元素引用保留在 injector 内部，
          // overlay 调用 applyBatch 时通过 idx 索引回 injector 内部的 items 列表
          _lastCollectedItems = items;
          payload = {
            ok: true,
            items: items.map((it, i) => ({
              idx: i,
              text: it.text,
              type: it.type,
              attr: it.attr || null
            }))
          };
          break;
        }
        case 'applyBatch': {
          // data.results: [{idx, translation}]
          if (!_lastCollectedItems) {
            payload = { ok: false, error: 'NO_COLLECTED' };
            break;
          }
          applyBatchTranslations(_lastCollectedItems, data.results || []);
          payload = { ok: true };
          break;
        }
        case 'setMode':
          setMode(data.mode);
          payload = { ok: true };
          break;
        case 'setConfig':
          _config = { ..._config, ...(data.config || {}) };
          if (_config.defaultMode) _currentMode = _config.defaultMode;
          _applyTheme();
          payload = { ok: true };
          break;
        case 'clearAll':
          clearAll();
          payload = { ok: true };
          break;
        case 'getStatus':
          payload = { ok: true, translated: _translated, mode: _currentMode };
          break;
      }
    } catch (err) {
      payload = { ok: false, error: err.message || String(err) };
    }
    window.parent.postMessage({
      source: 'markline-injector',
      id: data.id,
      type: 'response',
      payload
    }, '*');
  });

  // ===== 通知 overlay 已就绪 =====
  window.parent.postMessage({
    source: 'markline-injector',
    type: 'ready',
    url: location.href
  }, '*');

  console.log('[Markline] translate-injector loaded on', location.href);
})();
