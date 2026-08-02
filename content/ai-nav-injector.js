// content/ai-nav-injector.js
// 注入到 AI 平台页面的悬浮对话目录
// - 通过 manifest.content_scripts 静态注入
// - Shadow DOM 隔离样式，避免与 AI 平台页面冲突
// - 与 background 通过 chrome.runtime.sendMessage 通信
// - 解析逻辑参考 ChatTOC：minLength 只过滤 AI 短消息，用户消息（"继续"/"OK"）一律保留
//
// 暴露 window.__marklineAiNav 标记防重复注入
// 暴露 window.MarklineAiNav 调试 API（dev 环境用）

(function () {
  'use strict';
  if (window.__marklineAiNav) return;
  window.__marklineAiNav = true;

  // ===== 状态 =====
  let _settings = null;
  let _template = null;        // { name, icon, domains, selectors, ... }
  let _templateKey = null;
  let _messages = [];          // [{ id, index, role, text, preview, element }]
  let _activeId = null;
  let _observer = null;        // MutationObserver
  let _root = null;            // Shadow Root
  let _ball = null;            // 悬浮球
  let _card = null;            // 消息卡片（轻量，保留兼容）
  let _sidebar = null;         // 侧边栏（仿 ChatTOC）
  let _timeline = null;        // 竖线时间轴
  let _timelineTooltip = null; // 时间轴 tooltip 浮层
  let _cardVisible = false;
  let _sidebarOpen = false;
  let _sidebarFilter = 'all';  // all | user | assistant | bookmark
  let _selectedMessageIds = new Set();  // 导出时选中的消息 id 集合
  let _searchQuery = '';
  let _activeMessageSearch = null;  // { msgId, query } 页内搜索状态（跨 renderSidebarList 恢复）
  let _suppressParse = false;       // 临时抑制 MutationObserver 触发的 parseMessages（如页内高亮改 DOM 时）
  let _suppressParseTimer = null;   // _suppressParse 延迟重置计时器（覆盖 observer 300ms 防抖窗口）
  let _locationHref = location.href;
  let _locationTimer = null;
  let _scrollSpyTimer = null;
  let _observerTimer = null;
  let _retryCount = 0;
  let _widthController = null;   // MessageWidthController 实例
  let _messageWidths = {};       // { [templateKey]: number }
  let _floatingMenu = null;      // 悬浮菜单（打开侧边栏 / 调整消息宽度）
  let _floatingMenuMode = null;  // 'main' | 'width'
  let _floatingMenuOutsideHandler = null;
  let _floatingMenuEscHandler = null;
  let _floatingMenuResizeHandler = null;
  let _floatingMenuWidthDebounce = null;

  // ===== 消息宽度常量（移植自 ChatTOC）=====
  const MESSAGE_WIDTH_STYLE_ID = 'markline-ainav-message-width-style';
  const MESSAGE_WIDTH_MIN = 320;
  const MESSAGE_WIDTH_EDGE_RESERVE = 48;

  // 将 CSS 长度值（px/rem/em/vw/vh/纯数字）转换为像素整数；失败返回 null
  function parseCssLengthToPx(value, refEl) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([a-z%]*)$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    if (!Number.isFinite(num)) return null;
    const unit = (match[2] || 'px').toLowerCase();
    if (unit === 'px' || unit === '') return Math.round(num);
    if (unit === 'rem') {
      const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return Math.round(num * fontSize);
    }
    if (unit === 'em') {
      const fontSize = parseFloat(getComputedStyle(refEl || document.documentElement).fontSize) || 16;
      return Math.round(num * fontSize);
    }
    if (unit === 'vw') return Math.round((num * window.innerWidth) / 100);
    if (unit === 'vh') return Math.round((num * window.innerHeight) / 100);
    return null;
  }

  // 消息宽度控制器（移植自 ChatTOC MessageWidthController）
  // - messageContainer 以 '--' 开头时改 :root CSS 变量；否则按选择器覆盖 width/max-width
  class MessageWidthController {
    constructor(getTemplateKey, getParser) {
      this.getTemplateKey = getTemplateKey;
      this.getParser = getParser;
      this.currentWidth = null;
    }

    getRawSelector() {
      const parser = this.getParser?.();
      const raw = parser?.config?.selectors?.messageContainer;
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }

    getCssVariableName() {
      const raw = this.getRawSelector();
      if (!raw) return null;
      return raw.startsWith('--') ? raw : null;
    }

    getSelector() {
      const raw = this.getRawSelector();
      if (!raw) return null;
      return raw.startsWith('--') ? null : raw;
    }

    getContainerSelector() {
      const parser = this.getParser?.();
      const raw = parser?.config?.selectors?.container;
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    }

    isSupported() {
      return Boolean(this.getRawSelector());
    }

    getMaxWidth() {
      const viewport = typeof window !== 'undefined' ? window.innerWidth : 1200;
      return Math.max(MESSAGE_WIDTH_MIN + 40, viewport - MESSAGE_WIDTH_EDGE_RESERVE);
    }

    clampWidth(value) {
      const max = this.getMaxWidth();
      const n = typeof value === 'number' ? value : parseInt(value, 10);
      if (!Number.isFinite(n)) return null;
      return Math.round(Math.max(MESSAGE_WIDTH_MIN, Math.min(max, n)));
    }

    // 读取站点原生宽度（作为滑块初始值的兜底）
    detectNativeWidth() {
      const cssVar = this.getCssVariableName();
      if (cssVar) {
        try {
          const styleEl = document.getElementById(MESSAGE_WIDTH_STYLE_ID);
          const wasDisabled = styleEl ? styleEl.disabled : null;
          if (styleEl) styleEl.disabled = true;
          const candidates = [document.documentElement];
          const containerSelector = this.getContainerSelector();
          if (containerSelector) {
            try {
              const el = document.querySelector(containerSelector);
              if (el) candidates.push(el);
            } catch {}
          }
          if (document.body) candidates.push(document.body);
          let result = null;
          for (const node of candidates) {
            const value = getComputedStyle(node).getPropertyValue(cssVar).trim();
            const px = parseCssLengthToPx(value, node);
            if (px != null && px > 0) { result = px; break; }
          }
          if (styleEl) styleEl.disabled = wasDisabled === null ? false : wasDisabled;
          return result;
        } catch { return null; }
      }
      const selector = this.getSelector();
      if (!selector) return null;
      try {
        const el = document.querySelector(selector);
        if (!el) return null;
        const width = Math.round(el.getBoundingClientRect().width);
        return width > 0 ? width : null;
      } catch { return null; }
    }

    ensureStyleEl() {
      let style = document.getElementById(MESSAGE_WIDTH_STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = MESSAGE_WIDTH_STYLE_ID;
        document.head.appendChild(style);
      }
      return style;
    }

    apply(width) {
      const cssVar = this.getCssVariableName();
      const selector = cssVar ? null : this.getSelector();
      if (!cssVar && !selector) { this.clear(); return; }
      const clamped = this.clampWidth(width);
      if (clamped == null) { this.clear(); return; }
      const style = this.ensureStyleEl();
      const css = cssVar
        ? `:root, * { ${cssVar}: ${clamped}px !important; }`
        : `${selector} { width: ${clamped}px !important; max-width: ${clamped}px !important; }`;
      if (style.textContent !== css) style.textContent = css;
      this.currentWidth = clamped;
    }

    clear() {
      const style = document.getElementById(MESSAGE_WIDTH_STYLE_ID);
      if (style) style.remove();
      this.currentWidth = null;
    }
  }

  function applyStoredMessageWidth() {
    if (!_widthController || !_templateKey) return;
    const value = _messageWidths?.[_templateKey];
    if (typeof value === 'number' && value > 0) {
      _widthController.apply(value);
    } else {
      _widthController.clear();
    }
  }

  // ===== 文本清理（移植自 ChatTOC）=====
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function truncate(text, max) {
    if (!text || text.length <= max) return text || '';
    const t = text.slice(0, max);
    const last = t.lastIndexOf(' ');
    return (last > max * 0.7 ? t.slice(0, last) : t) + '...';
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ===== 解析层 =====
  // 选择器可能含分号（多个备选），逐个尝试
  function querySelectorMulti(selector) {
    if (!selector) return null;
    const parts = selector.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of parts) {
      try {
        const el = document.querySelector(s);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  function querySelectorAllMulti(selector) {
    if (!selector) return [];
    const parts = selector.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of parts) {
      try {
        const els = document.querySelectorAll(s);
        if (els.length) return Array.from(els);
      } catch {}
    }
    return [];
  }

  function extractText(element, textSelector) {
    if (!element) return '';
    if (!textSelector) return element.innerText || '';
    // 多个选择器用逗号分隔，按顺序取第一个命中的
    const parts = textSelector.split(',').map(s => s.trim()).filter(Boolean);
    for (const s of parts) {
      try {
        const el = element.querySelector(s);
        if (el) return el.innerText || '';
      } catch {}
    }
    return element.innerText || '';
  }

  // 提取 AI 回答中的图片（参考 ChatTOC extractImages）
  function extractImages(element, imageSelector) {
    if (!element) return [];
    try {
      let imageElements = [];
      if (imageSelector) {
        // 多个选择器用分号分隔
        const parts = imageSelector.split(';').map(s => s.trim()).filter(Boolean);
        for (const s of parts) {
          try {
            const els = element.querySelectorAll(s);
            if (els.length) { imageElements = Array.from(els); break; }
          } catch {}
        }
      }
      if (!imageElements.length) {
        // 兜底：所有 img，排除极小图标
        imageElements = Array.from(element.querySelectorAll('img')).filter(img => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return w >= 32 && h >= 32;
        });
      }
      const seen = new Set();
      const images = [];
      for (const img of imageElements) {
        const source = (img.currentSrc || img.getAttribute('src') || '').trim();
        if (!source) continue;
        let normalizedSrc = source;
        try {
          normalizedSrc = new URL(source, window.location.href).href;
        } catch {}
        if (!normalizedSrc || seen.has(normalizedSrc)) continue;
        seen.add(normalizedSrc);
        images.push({
          src: normalizedSrc,
          alt: (img.getAttribute('alt') || '').trim()
        });
      }
      return images;
    } catch {
      return [];
    }
  }

  // 提取消息的 Markdown（参考 ChatTOC extractMarkdownFromNode）
  function extractMarkdown(element) {
    if (!element) return '';
    try {
      const clone = element.cloneNode(true);
      // 移除按钮、操作栏、脚注等噪音
      clone.querySelectorAll('button, .actions, .action-bar, [contenteditable], script, style, [class*="footer"], [class*="action"]').forEach(n => n.remove());
      return nodeToMarkdown(clone).trim();
    } catch {
      return element.innerText || '';
    }
  }

  // DOM 节点转 Markdown（简化版，覆盖常见结构）
  function nodeToMarkdown(root) {
    const lines = [];
    function walk(node) {
      node.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = (child.textContent || '').replace(/\s+/g, ' ');
          if (t.trim()) lines.push(t);
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (child.tagName || '').toLowerCase();
        switch (tag) {
          case 'h1': lines.push(`\n# ${child.textContent.trim()}\n`); break;
          case 'h2': lines.push(`\n## ${child.textContent.trim()}\n`); break;
          case 'h3': lines.push(`\n### ${child.textContent.trim()}\n`); break;
          case 'h4': lines.push(`\n#### ${child.textContent.trim()}\n`); break;
          case 'h5': lines.push(`\n##### ${child.textContent.trim()}\n`); break;
          case 'h6': lines.push(`\n###### ${child.textContent.trim()}\n`); break;
          case 'p': lines.push('\n'); walk(child); lines.push('\n'); break;
          case 'br': lines.push('\n'); break;
          case 'strong': case 'b': lines.push(`**${child.textContent.trim()}**`); break;
          case 'em': case 'i': lines.push(`*${child.textContent.trim()}*`); break;
          case 'code':
            if (child.parentElement && child.parentElement.tagName.toLowerCase() === 'pre') {
              lines.push(`\n\`\`\`\n${child.textContent}\n\`\`\`\n`);
            } else {
              lines.push(`\`${child.textContent}\``);
            }
            break;
          case 'pre': lines.push(`\n\`\`\`\n${child.textContent}\n\`\`\`\n`); break;
          case 'blockquote': lines.push('\n> '); walk(child); lines.push('\n'); break;
          case 'ul': case 'ol':
            lines.push('\n');
            child.querySelectorAll(':scope > li').forEach((li, i) => {
              const prefix = tag === 'ol' ? `${i + 1}. ` : '- ';
              lines.push(prefix + li.textContent.trim());
            });
            lines.push('\n');
            break;
          case 'a': {
            const href = child.getAttribute('href') || '';
            const text = child.textContent.trim();
            if (href && text) lines.push(`[${text}](${href})`);
            else lines.push(text);
            break;
          }
          case 'img': {
            const src = child.getAttribute('src') || '';
            const alt = child.getAttribute('alt') || '';
            if (src) lines.push(`![${alt}](${src})`);
            break;
          }
          case 'hr': lines.push('\n---\n'); break;
          case 'table':
            lines.push('\n');
            child.querySelectorAll('tr').forEach((tr, ri) => {
              const cells = Array.from(tr.querySelectorAll('th,td')).map(c => c.textContent.trim());
              lines.push('| ' + cells.join(' | ') + ' |');
              if (ri === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            });
            lines.push('\n');
            break;
          default:
            walk(child);
        }
      });
    }
    walk(root);
    return lines.join('').replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseMessages() {
    if (!_template) return;
    const sel = _template.selectors;
    const container = querySelectorMulti(sel.container);
    if (!container) {
      // 容器未渲染，安排重试
      scheduleRetry();
      return;
    }

    const userEls = querySelectorAllMulti(sel.userItem);
    const assistantEls = sel.assistantItem ? querySelectorAllMulti(sel.assistantItem) : [];
    if (userEls.length === 0 && assistantEls.length === 0) {
      scheduleRetry();
      return;
    }
    _retryCount = 0;

    // 合并并按 DOM 顺序排序
    const all = [
      ...userEls.map(el => ({ el, role: 'user' })),
      ...assistantEls.map(el => ({ el, role: 'assistant' }))
    ];
    all.sort((a, b) => {
      if (a.el === b.el) return 0;
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // 文心一言等老站点 DOM 倒序
    if (_template.messageOrder === 'reverse') {
      all.reverse();
    }

    const maxLen = _settings?.maxLength ?? 140;
    const minLen = _settings?.minLength ?? 0;
    const domain = _template.domains[0] || location.hostname;
    const result = [];
    for (let i = 0; i < all.length; i++) {
      const { el, role } = all[i];
      const textSel = role === 'user' ? sel.textUser : sel.textAssistant;
      const raw = extractText(el, textSel);
      const text = cleanText(raw);

      // 用户消息无论多短都保留（"继续"/"OK" 是对话节点）
      if (role === 'user') {
        if (!text) continue;
      } else {
        // AI 短消息（"好的"/"明白"）按 minLength 过滤
        if (text.length < minLen) continue;
      }

      result.push({
        id: `${domain}-idx-${i}`,
        index: result.length + 1,
        role,
        text,
        preview: truncate(text, maxLen),
        images: role === 'assistant' ? extractImages(el, sel.image) : [],
        element: el
      });
    }
    _messages = result;
    // 清理已失效的选中项（消息重新解析后 id 可能变化）
    if (_selectedMessageIds.size) {
      const validIds = new Set(result.map(m => m.id));
      for (const id of _selectedMessageIds) {
        if (!validIds.has(id)) _selectedMessageIds.delete(id);
      }
      if (_sidebar) updateSelectionBar();
    }
    renderSidebarList();
    renderTimeline();
    updateActive();
    notifyState();
  }

  // ===== SPA 重试机制 =====
  function scheduleRetry() {
    if (_retryCount >= 5) return;
    _retryCount++;
    setTimeout(() => {
      parseMessages();
    }, 1000 * _retryCount);
  }

  // ===== UI 层（Shadow DOM）=====
  function ensureUI() {
    if (_root) return;
    const host = document.createElement('div');
    host.id = 'markline-ainav-host';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    document.documentElement.appendChild(host);
    _root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .ball {
        position: fixed; right: 20px; bottom: 24px;
        width: 48px; height: 48px; border-radius: 50%;
        background: rgba(255,255,255,0.96);
        border: 1px solid rgba(148,163,184,0.32);
        box-shadow: 0 8px 24px rgba(15,23,42,0.18);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        cursor: grab; display: flex; align-items: center; justify-content: center;
        transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
        user-select: none; touch-action: none;
        color: #2563eb;
      }
      .ball:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 12px 28px rgba(15,23,42,0.22); }
      .ball:active { transform: scale(0.97); }
      .ball.dragging { cursor: grabbing; transition: none; transform: none; }
      .ball svg { width: 24px; height: 24px; pointer-events: none; }
      .ball[data-pos="left"] { left: 20px; right: auto; }
      @media (max-width: 720px) {
        .ball { right: 16px; bottom: 18px; }
        .ball[data-pos="left"] { left: 16px; right: auto; }
      }

      .card {
        position: fixed; right: 20px; bottom: 84px;
        width: 360px; max-height: 60vh;
        background: rgba(255,255,255,0.98);
        border: 1px solid rgba(148,163,184,0.28);
        border-radius: 14px;
        box-shadow: 0 18px 40px rgba(15,23,42,0.18);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        display: none; flex-direction: column;
        font: 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
        color: #0f172a; overflow: hidden;
      }
      .card.visible { display: flex; }
      .card[data-pos="left"] { left: 20px; right: auto; }
      @media (max-width: 720px) {
        .card { width: calc(100vw - 32px); right: 16px; bottom: 78px; }
        .card[data-pos="left"] { left: 16px; right: auto; }
      }

      .card-header {
        padding: 10px 14px; border-bottom: 1px solid rgba(148,163,184,0.2);
        display: flex; align-items: center; justify-content: space-between;
        font-weight: 600; font-size: 13px;
        background: rgba(248,250,252,0.6);
      }
      .card-title { display: flex; align-items: center; gap: 6px; }
      .card-title .count {
        background: rgba(37,99,235,0.12); color: #2563eb;
        font-size: 11px; padding: 1px 6px; border-radius: 8px; font-weight: 500;
      }
      .card-actions { display: flex; gap: 4px; }
      .icon-btn {
        border: none; background: transparent; cursor: pointer;
        width: 26px; height: 26px; border-radius: 6px; color: #64748b;
        display: flex; align-items: center; justify-content: center;
        transition: background .15s ease;
      }
      .icon-btn:hover { background: rgba(148,163,184,0.18); color: #0f172a; }
      .icon-btn svg { width: 14px; height: 14px; }

      .search-box {
        padding: 8px 10px; border-bottom: 1px solid rgba(148,163,184,0.16);
      }
      .search-box input {
        width: 100%; padding: 6px 10px; font-size: 12px;
        border: 1px solid rgba(148,163,184,0.3); border-radius: 8px;
        background: rgba(255,255,255,0.9); color: #0f172a; outline: none;
        transition: border-color .15s ease;
      }
      .search-box input:focus { border-color: rgba(37,99,235,0.5); }
      .search-box input::placeholder { color: #94a3b8; }

      .list { overflow-y: auto; padding: 6px; flex: 1; min-height: 0; }
      .list::-webkit-scrollbar { width: 6px; }
      .list::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.3); border-radius: 3px; }
      .list::-webkit-scrollbar-track { background: transparent; }

      .item {
        padding: 8px 10px; border-radius: 8px; cursor: pointer;
        display: flex; gap: 8px; align-items: flex-start;
        transition: background .15s ease;
        margin-bottom: 2px;
      }
      .item:hover { background: rgba(148,163,184,0.14); }
      .item.active { background: rgba(37,99,235,0.12); }
      .item.active .item-num { box-shadow: 0 0 0 2px rgba(37,99,235,0.25); }

      .item-num {
        flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
        font-size: 11px; display: flex; align-items: center; justify-content: center;
        background: rgba(148,163,184,0.2); color: #475569; font-weight: 500;
      }
      .item.user .item-num { background: rgba(37,99,235,0.18); color: #2563eb; }
      .item.assistant .item-num { background: rgba(16,185,129,0.18); color: #059669; }

      .item-text { flex: 1; min-width: 0; word-break: break-word; }
      .item-text .role {
        font-size: 10px; color: #94a3b8; text-transform: uppercase;
        letter-spacing: 0.04em; margin-bottom: 2px;
      }
      .item-text .preview { color: #334155; font-size: 12.5px; }
      .item.user .item-text .preview { color: #1e293b; }

      .empty {
        padding: 32px 16px; text-align: center; color: #94a3b8; font-size: 12px;
      }

      .card-footer {
        padding: 6px 12px; border-top: 1px solid rgba(148,163,184,0.16);
        font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between;
      }

      /* 暗色主题 */
      .card.dark, .ball.dark {
        background: rgba(15,23,42,0.96); color: #e2e8f0;
        border-color: rgba(71,85,105,0.4);
      }
      .card.dark .card-header { background: rgba(30,41,59,0.6); border-color: rgba(71,85,105,0.4); }
      .card.dark .icon-btn { color: #94a3b8; }
      .card.dark .icon-btn:hover { background: rgba(71,85,105,0.4); color: #f1f5f9; }
      .card.dark .item:hover { background: rgba(71,85,105,0.3); }
      .card.dark .item.active { background: rgba(59,130,246,0.18); }
      .card.dark .item.active .item-num { box-shadow: 0 0 0 2px rgba(59,130,246,0.35); }
      .card.dark .item-num { background: rgba(71,85,105,0.4); color: #cbd5e1; }
      .card.dark .item.user .item-num { background: rgba(59,130,246,0.25); color: #93c5fd; }
      .card.dark .item.assistant .item-num { background: rgba(16,185,129,0.25); color: #6ee7b7; }
      .card.dark .item-text .role { color: #64748b; }
      .card.dark .item-text .preview { color: #cbd5e1; }
      .card.dark .item.user .item-text .preview { color: #f1f5f9; }
      .card.dark .search-box input {
        background: rgba(30,41,59,0.7); color: #e2e8f0;
        border-color: rgba(71,85,105,0.5);
      }
      .card.dark .search-box input::placeholder { color: #64748b; }
      .card.dark .card-footer { color: #64748b; border-color: rgba(71,85,105,0.4); }
      .ball.dark { color: #60a5fa; }

      /* ===== 侧边栏（简约风）===== */
      .sidebar {
        position: fixed; top: 0; bottom: 0; right: 0;
        width: var(--sidebar-w, 340px); max-width: 90vw;
        z-index: 2147483646;
        display: flex; flex-direction: column;
        background: #ffffff;
        border-left: 1px solid #eef0f3;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
        transform: translateX(100%);
        transition: transform .22s cubic-bezier(.4,0,.2,1);
        overflow: hidden;
        color: #1a1d21;
      }
      .sidebar.is-open { transform: translateX(0); }
      .sidebar[data-pos="left"] { left: 0; right: auto; border-left: 0; border-right: 1px solid #eef0f3; transform: translateX(-100%); }
      .sidebar[data-pos="left"].is-open { transform: translateX(0); }

      /* Header — 只留标题 + 关闭 */
      .sidebar__header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 14px 8px;
        flex-shrink: 0;
      }
      .sidebar__site {
        display: flex; align-items: center; gap: 8px;
        min-width: 0;
      }
      .sidebar__logo {
        flex-shrink: 0;
        width: 24px; height: 24px; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 15px; line-height: 1;
        background: linear-gradient(135deg, #f0f2f5, #e4e7eb);
        border: 1px solid rgba(0,0,0,0.04);
      }
      .sidebar__site-name {
        font-size: 13px; font-weight: 600; color: #1a1d21;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        letter-spacing: -0.01em;
      }
      .sidebar__site-count {
        font-size: 11px; font-weight: 500; color: #8a8f98;
        flex-shrink: 0;
      }

      /* 通用图标按钮 */
      .sidebar__icon-btn {
        width: 26px; height: 26px; border-radius: 6px; border: none;
        background: transparent; color: #6f757d; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background .12s ease, color .12s ease;
        flex-shrink: 0;
      }
      .sidebar__icon-btn:hover { background: #f4f5f7; color: #1a1d21; }
      .sidebar__icon-btn.is-spinning svg { animation: sb-spin .8s linear infinite; transform-origin: center; }
      @keyframes sb-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

      /* Search — 独立一层 */
      .sidebar__search {
        padding: 0 14px 8px;
        flex-shrink: 0;
        display: flex; align-items: center; gap: 8px;
      }
      .sidebar__search-field {
        flex: 1; min-width: 0;
        display: flex; align-items: center; gap: 8px;
        height: 32px; padding: 0 10px; border-radius: 6px;
        background: #f4f5f7;
        transition: background .12s ease;
      }
      .sidebar__search-field:focus-within { background: #eceef1; }
      .sidebar__search-field input {
        border: none; outline: none; width: 100%;
        font-size: 13px; background: transparent; color: #1a1d21;
        font-family: inherit;
      }
      .sidebar__search-field input::placeholder { color: #8a8f98; }
      .sidebar__search-clear {
        border: none; background: none; font-size: 16px; cursor: pointer;
        color: #8a8f98; display: none; padding: 0; line-height: 1;
      }
      .sidebar__search-clear.is-visible { display: inline-flex; }

      /* 导出按钮 + 下拉菜单 */
      .sidebar__search-export { position: relative; flex-shrink: 0; }
      .sidebar__export-btn {
        width: 32px; height: 32px; border-radius: 7px; border: 1px solid #e4e7eb;
        background: #fff; color: #4a5058; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background .12s ease, color .12s ease, border-color .12s ease, transform .1s ease;
      }
      .sidebar__export-btn:hover { background: #1a1d21; color: #fff; border-color: #1a1d21; }
      .sidebar__export-btn:active { transform: scale(0.94); }
      .sidebar__export-menu {
        position: absolute; top: calc(100% + 6px); right: 0;
        min-width: 140px; background: #fff; border: 1px solid #e4e7eb;
        border-radius: 10px; box-shadow: 0 16px 24px rgba(15,23,42,0.16);
        padding: 6px; display: none; z-index: 10;
      }
      .sidebar__export-menu.is-open { display: block; }
      .sidebar__export-item {
        display: block; width: 100%; border: none; background: transparent;
        padding: 8px 10px; border-radius: 8px; cursor: pointer;
        font-size: 12px; color: #1a1d21; text-align: left; font-family: inherit;
        transition: background .12s ease;
      }
      .sidebar__export-item:hover { background: #f4f5f7; }

      /* 消息条目内嵌搜索框 */
      .sidebar__message-search {
        margin-top: 8px; display: flex; align-items: center; gap: 6px;
        padding: 6px 8px; background: #f7f8fa; border-radius: 6px;
        border: 1px solid #eceef1;
      }
      .sidebar__message-search input {
        flex: 1; border: none; outline: none; background: transparent;
        font-size: 12px; color: #1a1d21; font-family: inherit;
      }
      .sidebar__message-search input::placeholder { color: #8a8f98; }
      .sidebar__message-search-close {
        border: none; background: none; cursor: pointer; font-size: 16px;
        color: #8a8f98; width: 20px; height: 20px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .sidebar__message-search-close:hover { background: #e4e7eb; color: #1a1d21; }

      /* 页内高亮（醒目美观） */
      mark.markline-highlight {
        background: linear-gradient(180deg, transparent 55%, #fde68a 55%);
        color: inherit; padding: 0 2px; border-radius: 2px;
        font-weight: 600;
      }

      /* Tabs — 独立一层，标签左对齐 + 刷新按钮右对齐 */
      .sidebar__tabs {
        display: flex; align-items: center; gap: 2px;
        padding: 0 14px 8px;
        flex-shrink: 0;
      }
      .sidebar__tabs-spacer { flex: 1; }
      .sidebar__tab-btn {
        border: none; background: transparent; color: #6f757d;
        border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 500;
        cursor: pointer; font-family: inherit;
        transition: background .12s ease, color .12s ease;
      }
      .sidebar__tab-btn:hover { background: #f4f5f7; color: #1a1d21; }
      .sidebar__tab-btn.is-active { background: #1a1d21; color: #fff; }
      .sidebar__tab-btn:active { transform: scale(0.97); }

      /* List — 主区域 */
      .sidebar__list {
        flex: 1; min-height: 0; overflow-y: auto;
        padding: 4px 8px 8px;
      }
      .sidebar__list::-webkit-scrollbar { width: 6px; }
      .sidebar__list::-webkit-scrollbar-thumb { background: #e0e2e6; border-radius: 3px; }
      .sidebar__list::-webkit-scrollbar-thumb:hover { background: #d0d3d8; }
      .sidebar__list::-webkit-scrollbar-track { background: transparent; }

      /* Message — 无卡片，靠 hover 区分 */
      .sidebar__message {
        padding: 8px 10px; display: flex; flex-direction: column; gap: 3px;
        border-radius: 6px; cursor: pointer;
        transition: background .1s ease;
        position: relative;
      }
      .sidebar__message:hover { background: #f7f8fa; }
      .sidebar__message.is-active { background: #eef4ff; }
      .sidebar__message.is-active::before {
        content: ''; position: absolute; left: 0; top: 8px; bottom: 8px;
        width: 2px; border-radius: 1px; background: #3b82f6;
      }
      .sidebar__message-header {
        display: flex; align-items: center; gap: 6px;
        font-size: 11px; color: #8a8f98;
        flex-shrink: 0;
      }
      .sidebar__message-dot {
        width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
      }
      .sidebar__message.is-user .sidebar__message-dot { background: #3b82f6; }
      .sidebar__message.is-assistant .sidebar__message-dot { background: #10b981; }
      .sidebar__message-index { font-weight: 500; color: #6f757d; }
      .sidebar__message-role { color: #8a8f98; font-weight: 500; }
      .sidebar__message-actions {
        display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0;
        margin-left: auto; opacity: 0; transition: opacity .12s ease;
      }
      .sidebar__message:hover .sidebar__message-actions { opacity: 1; }
      .sidebar__action-btn {
        border: none; background: transparent; cursor: pointer;
        width: 22px; height: 22px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        color: #8a8f98; font-size: 13px; transition: background .1s ease, color .1s ease;
        padding: 0;
      }
      .sidebar__action-btn:hover { background: #eceef1; color: #1a1d21; }
      .sidebar__bookmark-btn { color: #d0d3d8; }
      .sidebar__bookmark-btn.is-active { color: #f59e0b; }
      .sidebar__message-preview {
        font-size: 13px; color: #1a1d21; line-height: 1.45;
        overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical;
        -webkit-line-clamp: 2; word-break: break-word;
        letter-spacing: -0.005em;
      }
      .sidebar__message mark { background: #fef3c7; color: inherit; padding: 0 2px; border-radius: 2px; }

      /* 消息选中复选框 */
      .sidebar__message-check {
        width: 14px; height: 14px; margin: 0; cursor: pointer; flex-shrink: 0;
        accent-color: #3b82f6;
        opacity: 0; transition: opacity .12s ease;
      }
      .sidebar__message:hover .sidebar__message-check,
      .sidebar__message.is-selected .sidebar__message-check { opacity: 1; }
      .sidebar__message.is-selected { background: #eff6ff; }
      .sidebar__message.is-selected.is-active { background: #dbeafe; }

      /* 选择栏（选中计数 + 全选/清除） */
      .sidebar__selection-bar {
        display: none; align-items: center; justify-content: space-between;
        padding: 6px 14px; border-bottom: 1px solid #eceef1;
        font-size: 12px; color: #6f757d; background: #fafbfc;
      }
      .sidebar__selection-bar.is-visible { display: flex; }
      .sidebar__selection-count { font-weight: 500; }
      .sidebar__selection-actions { display: flex; gap: 6px; }
      .sidebar__selection-btn {
        border: 1px solid #e4e7eb; background: #fff; cursor: pointer;
        padding: 3px 10px; border-radius: 5px; font-size: 11px; color: #4a5058;
        font-family: inherit; transition: background .12s ease, color .12s ease;
      }
      .sidebar__selection-btn:hover { background: #1a1d21; color: #fff; border-color: #1a1d21; }

      /* AI 回答图片缩略图 */
      .sidebar__message-images {
        display: flex; flex-wrap: wrap; gap: 6px;
        margin-top: 8px;
      }
      .sidebar__message-img-wrap {
        width: 72px; height: 72px; border-radius: 8px; overflow: hidden;
        cursor: pointer; position: relative;
        border: 1px solid #eceef1; background: #f7f8fa;
        transition: transform .12s ease, box-shadow .12s ease;
      }
      .sidebar__message-img-wrap:hover { transform: scale(1.04); box-shadow: 0 4px 12px rgba(15,23,42,0.15); }
      .sidebar__message-img {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }

      /* 操作按钮（复制/搜索/复制MD） */
      .sidebar__action-btn--copy, .sidebar__action-btn--search, .sidebar__action-btn--md {
        font-size: 11px;
      }
      .sidebar__action-btn--md {
        font-weight: 600; font-size: 10px; letter-spacing: 0.02em;
      }

      .sidebar__empty {
        padding: 48px 20px; text-align: center; color: #b4b8bf; font-size: 13px;
      }

      /* Toast 提示 */
      .sidebar__toast {
        position: fixed; left: 50%; bottom: 60px; transform: translateX(-50%) translateY(10px);
        background: rgba(15,23,42,0.92); color: #fff;
        padding: 8px 16px; border-radius: 8px; font-size: 13px;
        opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease;
        z-index: 2147483647; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      }
      .sidebar__toast.is-visible { opacity: 1; transform: translateX(-50%) translateY(0); }

      /* 图片查看器（全屏） */
      .sidebar__image-viewer-overlay {
        position: fixed; inset: 0; background: rgba(2,6,23,0.85);
        display: none; align-items: center; justify-content: center;
        z-index: 2147483647; padding: 24px;
      }
      .sidebar__image-viewer-overlay.is-visible { display: flex; }
      .sidebar__image-viewer-img {
        max-width: 92vw; max-height: 84vh; object-fit: contain;
        border-radius: 8px; box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      }
      .sidebar__image-viewer-close,
      .sidebar__image-viewer-prev,
      .sidebar__image-viewer-next {
        position: absolute; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: #fff; background: rgba(255,255,255,0.12); backdrop-filter: blur(8px);
        transition: background .15s ease;
      }
      .sidebar__image-viewer-close:hover,
      .sidebar__image-viewer-prev:hover,
      .sidebar__image-viewer-next:hover { background: rgba(255,255,255,0.24); }
      .sidebar__image-viewer-close {
        top: 20px; right: 24px; width: 40px; height: 40px; border-radius: 50%;
        font-size: 24px; line-height: 1;
      }
      .sidebar__image-viewer-prev, .sidebar__image-viewer-next {
        top: 50%; transform: translateY(-50%);
        width: 48px; height: 48px; border-radius: 50%;
        font-size: 32px; line-height: 1;
      }
      .sidebar__image-viewer-prev { left: 24px; }
      .sidebar__image-viewer-next { right: 24px; }
      .sidebar__image-viewer-info {
        position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
        color: #e8eaed; font-size: 13px; background: rgba(0,0,0,0.5);
        padding: 4px 12px; border-radius: 6px;
      }

      /* Active bar — 底部当前位置指示器 + 跳转 */
      .sidebar__active-bar {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px;
        border-top: 1px solid #f4f5f7;
        flex-shrink: 0;
        font-size: 11px; color: #8a8f98;
        background: #fafbfc;
      }
      .sidebar__jump-btn {
        width: 28px; height: 28px; border-radius: 7px; border: 1px solid #e4e7eb;
        background: #fff; color: #4a5058; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background .12s ease, color .12s ease, border-color .12s ease, transform .1s ease;
        flex-shrink: 0;
      }
      .sidebar__jump-btn:hover { background: #1a1d21; color: #fff; border-color: #1a1d21; }
      .sidebar__jump-btn:active { transform: scale(0.94); }
      .sidebar__jump-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .sidebar__jump-btn:disabled:hover { background: #fff; color: #4a5058; border-color: #e4e7eb; }
      .sidebar__active-text {
        flex: 1; text-align: center;
        font-variant-numeric: tabular-nums;
        font-size: 12px; font-weight: 600; color: #4a5058;
        letter-spacing: 0.02em;
      }

      /* 暗色主题 */
      .sidebar.dark {
        background: #16181c;
        border-left-color: #232629;
        color: #e8eaed;
      }
      .sidebar.dark .sidebar__site-name { color: #e8eaed; }
      .sidebar.dark .sidebar__site-count { color: #6f757d; }
      .sidebar.dark .sidebar__logo {
        background: linear-gradient(135deg, #232629, #2a2d31);
        border-color: rgba(255,255,255,0.06);
      }
      .sidebar.dark .sidebar__icon-btn { color: #8a8f98; }
      .sidebar.dark .sidebar__icon-btn:hover { background: #232629; color: #e8eaed; }
      .sidebar.dark .sidebar__search-field { background: #232629; }
      .sidebar.dark .sidebar__search-field:focus-within { background: #2a2d31; }
      .sidebar.dark .sidebar__search-field input { color: #e8eaed; }
      .sidebar.dark .sidebar__search-field input::placeholder { color: #6f757d; }
      .sidebar.dark .sidebar__export-btn { background: #232629; border-color: #2a2d31; color: #cbd5e1; }
      .sidebar.dark .sidebar__export-btn:hover { background: #e8eaed; color: #0f172a; border-color: #e8eaed; }
      .sidebar.dark .sidebar__export-menu { background: #1a1d21; border-color: #2a2d31; }
      .sidebar.dark .sidebar__export-item { color: #e8eaed; }
      .sidebar.dark .sidebar__export-item:hover { background: #2a2d31; }
      .sidebar.dark .sidebar__message-search { background: #232629; border-color: #2a2d31; }
      .sidebar.dark .sidebar__message-search input { color: #e8eaed; }
      .sidebar.dark .sidebar__message-search input::placeholder { color: #6f757d; }
      .sidebar.dark .sidebar__message-search-close { color: #94a3b8; }
      .sidebar.dark .sidebar__message-search-close:hover { background: #2a2d31; color: #e8eaed; }
      .sidebar.dark mark.markline-highlight { background: linear-gradient(180deg, transparent 55%, #b45309 55%); color: #fef3c7; }
      .sidebar.dark .sidebar__tab-btn { color: #8a8f98; }
      .sidebar.dark .sidebar__tab-btn:hover { background: #232629; color: #e8eaed; }
      .sidebar.dark .sidebar__tab-btn.is-active { background: #e8eaed; color: #16181c; }
      .sidebar.dark .sidebar__list::-webkit-scrollbar-thumb { background: #2a2d31; }
      .sidebar.dark .sidebar__list::-webkit-scrollbar-thumb:hover { background: #3a3d41; }
      .sidebar.dark .sidebar__message:hover { background: #1d1f23; }
      .sidebar.dark .sidebar__message.is-active { background: #1a2332; }
      .sidebar.dark .sidebar__message.is-active::before { background: #60a5fa; }
      .sidebar.dark .sidebar__message-header { color: #6f757d; }
      .sidebar.dark .sidebar__message.is-user .sidebar__message-dot { background: #60a5fa; }
      .sidebar.dark .sidebar__message.is-assistant .sidebar__message-dot { background: #34d399; }
      .sidebar.dark .sidebar__message-index { color: #8a8f98; }
      .sidebar.dark .sidebar__message-role { color: #6f757d; }
      .sidebar.dark .sidebar__action-btn { color: #6f757d; }
      .sidebar.dark .sidebar__action-btn:hover { background: #2a2d31; color: #e8eaed; }
      .sidebar.dark .sidebar__bookmark-btn { color: #3a3d41; }
      .sidebar.dark .sidebar__bookmark-btn.is-active { color: #f59e0b; }
      .sidebar.dark .sidebar__message-preview { color: #d8dade; }
      .sidebar.dark .sidebar__message mark { background: #6b5d1e; color: #fef3c7; }
      .sidebar.dark .sidebar__message.is-selected { background: #1e2a3a; }
      .sidebar.dark .sidebar__message.is-selected.is-active { background: #1a2332; }
      .sidebar.dark .sidebar__selection-bar { background: #16181c; border-bottom-color: #232629; color: #8a8f98; }
      .sidebar.dark .sidebar__selection-btn { background: #232629; border-color: #2a2d31; color: #c0c4cc; }
      .sidebar.dark .sidebar__selection-btn:hover { background: #e8eaed; color: #16181c; border-color: #e8eaed; }
      .sidebar.dark .sidebar__message-img-wrap { background: #232629; border-color: #2a2d31; }
      .sidebar.dark .sidebar__empty { color: #4a4d52; }
      .sidebar.dark .sidebar__active-bar { color: #6f757d; border-top-color: #232629; background: #1a1d21; }
      .sidebar.dark .sidebar__jump-btn { color: #8a8f98; background: #232629; border-color: #2a2d31; }
      .sidebar.dark .sidebar__jump-btn:hover { background: #e8eaed; color: #16181c; border-color: #e8eaed; }
      .sidebar.dark .sidebar__jump-btn:disabled:hover { background: #232629; color: #8a8f98; border-color: #2a2d31; }
      .sidebar.dark .sidebar__active-text { color: #c0c4cc; }

      /* ===== 竖线时间轴（对齐 ChatTOC）===== */
      .timeline {
        position: fixed; right: 18px;
        z-index: 2147483646;
        width: 20px; padding: 14px 4px;
        box-sizing: border-box;
        border-radius: 999px;
        background: rgba(15,23,42,0.08);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        box-shadow: 0 8px 18px rgba(15,23,42,0.18);
        user-select: none;
        pointer-events: auto;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
      }
      .timeline[data-pos="left"] { left: 18px; right: auto; }
      .timeline.is-hidden { display: none; }

      /* full-height 模式：节点垂直均分 */
      .timeline.is-full-height {
        top: 0; bottom: 0; height: 100vh; height: 100dvh;
        transform: none; overflow: visible;
      }
      .timeline.is-full-height .timeline-list {
        height: 100%; justify-content: space-between; gap: 2px;
      }

      /* compact 模式：居中、可滚动 */
      .timeline.is-compact {
        top: 50%; bottom: auto; height: auto;
        max-height: calc(min(100vh, 100dvh) - 20px);
        transform: translateY(-50%);
        overflow-y: auto; overflow-x: visible;
      }
      .timeline.is-compact .timeline-list {
        height: auto; min-height: 0;
        justify-content: flex-start; gap: 12px; flex: 0 0 auto;
      }

      .timeline-list {
        display: flex; flex-direction: column;
        align-items: center; overflow: visible;
      }

      .timeline-item {
        position: relative; width: 100%;
        display: flex; justify-content: center; overflow: visible;
      }

      .timeline-node {
        appearance: none; -webkit-appearance: none;
        display: block; width: 12px; height: 12px;
        border: 1px solid rgba(15,23,42,0.28);
        border-radius: 999px !important;
        background: rgba(148,163,184,0.85);
        color: transparent; padding: 0;
        cursor: pointer; line-height: 1;
        transition: transform .15s ease, background .15s ease;
      }
      .timeline-item.is-user .timeline-node {
        background: rgba(59,130,246,0.78);
        border-color: rgba(37,99,235,0.92);
        border-radius: 999px !important;
      }
      .timeline-item.is-assistant .timeline-node {
        background: rgba(16,185,129,0.74);
        border-color: rgba(5,150,105,0.95);
        border-radius: 2px !important;
        transform: rotate(45deg);
      }
      .timeline-node:hover { transform: scale(1.16); }
      .timeline-item.is-assistant .timeline-node:hover { transform: rotate(45deg) scale(1.16); }
      .timeline-node.is-active { background: rgba(59,130,246,0.95); }

      /* 暗色主题 */
      .timeline.dark {
        background: rgba(248,250,252,0.08);
        box-shadow: 0 8px 18px rgba(0,0,0,0.35);
      }
      .timeline.dark .timeline-node { border-color: rgba(241,245,249,0.28); background: rgba(100,116,139,0.85); }
      .timeline.dark .timeline-item.is-user .timeline-node {
        background: rgba(96,165,250,0.85); border-color: rgba(59,130,246,0.95);
      }
      .timeline.dark .timeline-item.is-assistant .timeline-node {
        background: rgba(52,211,153,0.78); border-color: rgba(16,185,129,0.95);
      }
      .timeline.dark .timeline-node.is-active { background: rgba(96,165,250,1); }

      /* tooltip 浮层（fixed 定位，适配 compact 模式滚动）*/
      .timeline-tooltip-float {
        position: fixed; z-index: 2147483647;
        width: 210px; max-width: min(210px, calc(100vw - 16px));
        padding: 6px 8px; border-radius: 8px;
        background: rgba(15,23,42,0.96); color: #f8fafc;
        font-size: 12px; line-height: 1.35;
        box-shadow: 0 6px 14px rgba(2,6,23,0.35);
        pointer-events: none; box-sizing: border-box;
        display: none; opacity: 0; visibility: hidden;
        -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; white-space: normal; word-break: break-word;
      }
      .timeline-tooltip-float.is-visible {
        display: -webkit-box; opacity: 1; visibility: visible;
      }

      /* 手动拖拽后：吸附到边缘并垂直居中（覆盖 full-height/compact 的容器定位）*/
      .timeline.is-manual-pos {
        top: 50%; bottom: auto; height: auto;
        max-height: calc(min(100vh, 100dvh) - 20px);
        transform: translateY(-50%);
        overflow-y: auto; overflow-x: visible;
      }
      .timeline.is-manual-pos .timeline-list {
        height: auto; min-height: 0;
        justify-content: flex-start; gap: 12px; flex: 0 0 auto;
      }
      .timeline.is-dragging { opacity: 0.85; cursor: grabbing; }

      /* ===== 悬浮菜单（打开侧边栏 / 调整消息宽度）===== */
      .fm {
        position: fixed; z-index: 2147483647;
        min-width: 188px; padding: 6px;
        background: rgba(255,255,255,0.98);
        border: 1px solid rgba(148,163,184,0.28);
        border-radius: 12px;
        box-shadow: 0 12px 28px rgba(15,23,42,0.20);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        font: 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;
        color: #0f172a;
        opacity: 0; transform: translateY(4px) scale(0.98); pointer-events: none;
        transition: opacity .15s ease, transform .15s ease;
      }
      .fm.is-visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .fm.dark {
        background: rgba(15,23,42,0.98); color: #e2e8f0;
        border-color: rgba(71,85,105,0.4);
      }
      .fm-btn {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 9px 10px; border: none; background: transparent;
        border-radius: 8px; cursor: pointer; color: inherit;
        font-size: 13px; text-align: left;
        transition: background .15s ease;
      }
      .fm-btn:hover:not(:disabled) { background: rgba(148,163,184,0.18); }
      .fm.dark .fm-btn:hover:not(:disabled) { background: rgba(71,85,105,0.4); }
      .fm-btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .fm-btn svg { width: 18px; height: 18px; flex-shrink: 0; }

      .fm-width { padding: 4px 6px 6px; width: 300px; }
      .fm-width-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 10px; font-weight: 600; font-size: 13px;
      }
      .fm-width-back {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 4px 8px; border: none; border-radius: 8px;
        background: rgba(148,163,184,0.14); color: inherit;
        font-size: 12px; cursor: pointer;
      }
      .fm-width-back:hover { background: rgba(148,163,184,0.28); }
      .fm-width-row { display: flex; align-items: center; gap: 10px; }
      .fm-width-slider { flex: 1; height: 4px; cursor: pointer; }
      .fm-width-reset {
        padding: 6px 10px; border: 1px solid rgba(148,163,184,0.32);
        border-radius: 8px; background: rgba(255,255,255,0.9); color: #0f172a;
        font-size: 12px; cursor: pointer; white-space: nowrap;
      }
      .fm-width-reset:hover:not(:disabled) { background: rgba(148,163,184,0.18); }
      .fm-width-reset:disabled { opacity: 0.45; cursor: not-allowed; }
      .fm.dark .fm-width-reset { background: rgba(30,41,59,0.7); color: #e2e8f0; border-color: rgba(71,85,105,0.5); }
      .fm-width-value {
        display: flex; justify-content: space-between;
        margin-top: 8px; font-size: 11px; color: #64748b;
      }
      .fm.dark .fm-width-value { color: #94a3b8; }
      .fm-width-hint {
        margin-top: 8px; font-size: 11px; color: #f59e0b;
        line-height: 1.4;
      }
    `;
    _root.appendChild(style);

    // 悬浮球
    _ball = document.createElement('button');
    _ball.className = 'ball';
    _ball.type = 'button';
    _ball.title = 'Markline AI 对话目录';
    _ball.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/>
        <line x1="3" y1="12" x2="3.01" y2="12"/>
        <line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    `;
    _root.appendChild(_ball);

    // 侧边栏（简约风）
    _sidebar = document.createElement('div');
    _sidebar.className = 'sidebar';
    _sidebar.innerHTML = `
      <div class="sidebar__header">
        <div class="sidebar__site">
          <span class="sidebar__logo" data-role="logo">🤖</span>
          <span class="sidebar__site-name" data-role="site-name">AI 对话目录</span>
          <span class="sidebar__site-count" data-role="count">0</span>
        </div>
        <button class="sidebar__icon-btn" data-action="close" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>
          </svg>
        </button>
      </div>
      <div class="sidebar__search">
        <div class="sidebar__search-field">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#8a8f98;flex-shrink:0">
            <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
          </svg>
          <input type="search" placeholder="搜索对话内容..." data-role="search">
          <button class="sidebar__search-clear" data-action="clear-search" title="清除">×</button>
        </div>
        <div class="sidebar__search-export">
          <button class="sidebar__export-btn" data-action="export" title="导出">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>
            </svg>
          </button>
          <div class="sidebar__export-menu">
            <button class="sidebar__export-item" data-action="export-json">导出 JSON</button>
            <button class="sidebar__export-item" data-action="export-markdown">导出 Markdown</button>
          </div>
        </div>
      </div>
      <div class="sidebar__tabs">
        <button class="sidebar__tab-btn is-active" data-filter="all">全部</button>
        <button class="sidebar__tab-btn" data-filter="user">用户</button>
        <button class="sidebar__tab-btn" data-filter="assistant">AI</button>
        <button class="sidebar__tab-btn" data-filter="bookmark">收藏</button>
        <div class="sidebar__tabs-spacer"></div>
        <button class="sidebar__jump-btn" data-action="refresh" title="刷新">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
      <div class="sidebar__selection-bar">
        <span class="sidebar__selection-count">已选 0 条</span>
        <div class="sidebar__selection-actions">
          <button class="sidebar__selection-btn" data-action="select-all" title="全选当前列表">全选</button>
          <button class="sidebar__selection-btn" data-action="clear-selection" title="清除选择">清除</button>
        </div>
      </div>
      <div class="sidebar__list" data-role="list"></div>
      <div class="sidebar__active-bar">
        <button class="sidebar__jump-btn" data-action="top" title="上一条 (↑)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
        <span class="sidebar__active-text" data-role="active-info">—</span>
        <button class="sidebar__jump-btn" data-action="bottom" title="下一条 (↓)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
    `;
    _root.appendChild(_sidebar);

    // 竖线时间轴（对齐 ChatTOC：胶囊背景 + flex 均分节点）
    _timeline = document.createElement('div');
    _timeline.className = 'timeline';
    _timeline.innerHTML = `
      <div class="timeline-list" data-role="tl-list"></div>
    `;
    _root.appendChild(_timeline);

    // tooltip 用 fixed 浮层（避免 compact 模式滚动时 absolute 跑偏）
    _timelineTooltip = document.createElement('div');
    _timelineTooltip.className = 'timeline-tooltip-float';
    _timelineTooltip.setAttribute('role', 'tooltip');
    _root.appendChild(_timelineTooltip);

    // 悬浮菜单（打开侧边栏 / 调整消息宽度）
    _floatingMenu = document.createElement('div');
    _floatingMenu.className = 'fm';
    _floatingMenu.setAttribute('role', 'menu');
    _floatingMenu.style.display = 'none';
    _root.appendChild(_floatingMenu);

    // 消息宽度控制器（读取 _template / _templateKey 的闭包）
    _widthController = new MessageWidthController(
      () => _templateKey,
      () => ({ config: { selectors: _template?.selectors } })
    );

    // 应用主题
    applyTheme();

    // 事件绑定
    _ball.addEventListener('click', (e) => {
      // 防止拖拽末尾误触发 click
      if (_ball._suppressClick && Date.now() - _ball._suppressClick < 200) return;
      toggleFloatingMenu();
    });
    _sidebar.querySelector('[data-action="close"]').addEventListener('click', () => toggleSidebar(false));
    _sidebar.querySelector('[data-action="top"]').addEventListener('click', () => navigateMessage('prev'));
    _sidebar.querySelector('[data-action="bottom"]').addEventListener('click', () => navigateMessage('next'));
    _sidebar.querySelector('[data-action="refresh"]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      btn.classList.add('is-spinning');
      parseMessages();
      setStatus('已刷新');
      setTimeout(() => btn.classList.remove('is-spinning'), 600);
    });
    _sidebar.querySelector('[data-role="search"]').addEventListener('input', (e) => {
      _searchQuery = e.target.value.trim().toLowerCase();
      _sidebar.querySelector('[data-action="clear-search"]').classList.toggle('is-visible', !!_searchQuery);
      renderSidebarList();
    });
    _sidebar.querySelector('[data-action="clear-search"]').addEventListener('click', () => {
      _searchQuery = '';
      _sidebar.querySelector('[data-role="search"]').value = '';
      _sidebar.querySelector('[data-action="clear-search"]').classList.remove('is-visible');
      renderSidebarList();
    });
    // 导出按钮：点击切换菜单，选择格式后导出
    const exportBtn = _sidebar.querySelector('[data-action="export"]');
    const exportMenu = _sidebar.querySelector('.sidebar__export-menu');
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('is-open');
    });
    exportMenu.querySelector('[data-action="export-json"]').addEventListener('click', () => {
      exportMenu.classList.remove('is-open');
      exportMessages('json');
    });
    exportMenu.querySelector('[data-action="export-markdown"]').addEventListener('click', () => {
      exportMenu.classList.remove('is-open');
      exportMessages('markdown');
    });
    // 点击外部关闭导出菜单
    document.addEventListener('click', (e) => {
      if (!exportMenu.classList.contains('is-open')) return;
      if (!e.target.closest('.sidebar__search-export')) exportMenu.classList.remove('is-open');
    });
    // 选择栏：全选 / 清除选择
    _sidebar.querySelector('[data-action="select-all"]').addEventListener('click', () => {
      // 仅选中当前列表中可见的消息（已应用过滤/搜索）
      let items = _messages;
      if (_sidebarFilter === 'user') items = items.filter(m => m.role === 'user');
      else if (_sidebarFilter === 'assistant') items = items.filter(m => m.role === 'assistant');
      else if (_sidebarFilter === 'bookmark') items = items.filter(m => m.bookmarked);
      if (_searchQuery) {
        items = items.filter(m => (m.text || '').toLowerCase().includes(_searchQuery));
      }
      items.forEach(m => _selectedMessageIds.add(m.id));
      renderSidebarList();
      updateSelectionBar();
    });
    _sidebar.querySelector('[data-action="clear-selection"]').addEventListener('click', () => {
      _selectedMessageIds.clear();
      renderSidebarList();
      updateSelectionBar();
    });
    _sidebar.querySelectorAll('.sidebar__tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _sidebarFilter = btn.dataset.filter;
        _sidebar.querySelectorAll('.sidebar__tab-btn').forEach(b => b.classList.toggle('is-active', b === btn));
        renderSidebarList();
      });
    });

    setupBallDrag();
    setupTimelineDrag();
  }

  function applyTheme() {
    if (!_ball) return;
    let theme = _settings?.theme || 'auto';
    if (theme === 'auto') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const isDark = theme === 'dark';
    _ball.classList.toggle('dark', isDark);
    if (_sidebar) _sidebar.classList.toggle('dark', isDark);
    if (_timeline) _timeline.classList.toggle('dark', isDark);
    if (_floatingMenu) _floatingMenu.classList.toggle('dark', isDark);
  }

  // 更新侧边栏头部：当前 AI 平台 logo + 名称
  function updateSidebarHeader() {
    if (!_sidebar) return;
    const logoEl = _sidebar.querySelector('[data-role="logo"]');
    const nameEl = _sidebar.querySelector('[data-role="site-name"]');
    if (!_template) return;
    // 平台名（中英文兼容）
    const nameObj = _template.name || {};
    const lang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    const platformName = nameObj[lang] || nameObj.zh || nameObj.en || _templateKey || 'AI';
    // 真实 logo：优先读取当前页面 favicon link（最可靠，国内外通用）
    if (logoEl) {
      let faviconUrl = '';
      try {
        const link = document.querySelector('link[rel~="icon"]')
          || document.querySelector('link[rel="shortcut icon"]')
          || document.querySelector('link[rel="apple-touch-icon"]');
        if (link?.href) faviconUrl = link.href;
      } catch {}
      if (!faviconUrl && _template.domains?.[0]) {
        faviconUrl = `https://${_template.domains[0]}/favicon.ico`;
      }
      if (faviconUrl) {
        logoEl.innerHTML = '';
        const img = document.createElement('img');
        img.src = faviconUrl;
        img.alt = platformName;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:4px;';
        img.onerror = () => {
          logoEl.textContent = _template.icon || '🤖';
        };
        logoEl.appendChild(img);
      } else {
        logoEl.textContent = _template.icon || '🤖';
      }
    }
    if (nameEl) nameEl.textContent = `${platformName} · 对话目录`;
  }

  function setStatus(text) {
    const el = _root?.querySelector('[data-role="status"]');
    if (el) el.textContent = text;
  }

  function renderSidebarList() {
    const list = _root?.querySelector('[data-role="list"]');
    const countEl = _root?.querySelector('[data-role="count"]');
    if (!list) return;
    // 页内搜索框激活时跳过破坏性重建（list.innerHTML='' 会清掉搜索框）。
    // 搜索是临时操作，期间列表内容暂不更新是可接受的；路由变化/关闭搜索时 _activeMessageSearch 已置空，不影响正常重建。
    if (_activeMessageSearch && list.querySelector('.sidebar__message-search')) {
      return;
    }
    list.innerHTML = '';

    if (countEl) countEl.textContent = String(_messages.length);

    // 标签 + 搜索过滤
    let items = _messages;
    if (_sidebarFilter === 'user') items = items.filter(m => m.role === 'user');
    else if (_sidebarFilter === 'assistant') items = items.filter(m => m.role === 'assistant');
    else if (_sidebarFilter === 'bookmark') items = items.filter(m => m.bookmarked);

    if (_searchQuery) {
      items = items.filter(m => (m.text || '').toLowerCase().includes(_searchQuery));
    }

    if (!items.length) {
      list.innerHTML = `<div class="sidebar__empty">${_searchQuery || _sidebarFilter !== 'all' ? '无匹配消息' : '暂无消息'}</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(msg => {
      const div = document.createElement('div');
      const isSelected = _selectedMessageIds.has(msg.id);
      div.className = `sidebar__message is-${msg.role}` + (msg.id === _activeId ? ' is-active' : '') + (isSelected ? ' is-selected' : '');
      div.dataset.id = msg.id;

      const roleLabel = msg.role === 'user' ? '用户' : 'AI';
      const num = _settings?.showNumber === false ? '' : `#${msg.index}`;

      div.innerHTML = `
        <div class="sidebar__message-header">
          <input type="checkbox" class="sidebar__message-check" data-action="select" ${isSelected ? 'checked' : ''} title="选择此消息用于导出" />
          <span class="sidebar__message-dot"></span>
          <span class="sidebar__message-index">${escapeHtml(num)}</span>
          <span class="sidebar__message-role">${roleLabel}</span>
          <div class="sidebar__message-actions">
            <button class="sidebar__action-btn sidebar__action-btn--search" data-action="search" title="页内搜索">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            </button>
            <button class="sidebar__action-btn sidebar__action-btn--copy" data-action="copy" title="复制纯文本">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="sidebar__action-btn sidebar__action-btn--md" data-action="copy-md" title="复制为 Markdown">MD</button>
            <button class="sidebar__action-btn sidebar__bookmark-btn ${msg.bookmarked ? 'is-active' : ''}" data-action="bookmark" title="收藏">★</button>
          </div>
        </div>
        <div class="sidebar__message-preview"></div>
        ${msg.images && msg.images.length ? `<div class="sidebar__message-images"></div>` : ''}
      `;
      // 用 textContent 设置预览（避免 XSS），再应用高亮
      const previewEl = div.querySelector('.sidebar__message-preview');
      previewEl.textContent = msg.preview || '';
      if (_searchQuery) {
        applyHighlight(previewEl, _searchQuery);
      }
      // 渲染图片缩略图
      if (msg.images && msg.images.length) {
        const imgBox = div.querySelector('.sidebar__message-images');
        if (imgBox) {
          msg.images.slice(0, 6).forEach((img, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'sidebar__message-img-wrap';
            wrap.title = img.alt || '点击查看大图';
            const im = document.createElement('img');
            im.className = 'sidebar__message-img';
            im.src = img.src;
            im.alt = img.alt || '';
            im.loading = 'lazy';
            wrap.appendChild(im);
            wrap.addEventListener('click', (e) => {
              e.stopPropagation();
              openImageViewer(msg.images, idx);
            });
            imgBox.appendChild(wrap);
          });
        }
      }
      // 事件绑定
      div.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (actionEl) {
          e.stopPropagation();
          const act = actionEl.dataset.action;
          if (act === 'select') {
            // checkbox 点击：切换选中状态，不滚动
            if (actionEl.checked) {
              _selectedMessageIds.add(msg.id);
              div.classList.add('is-selected');
            } else {
              _selectedMessageIds.delete(msg.id);
              div.classList.remove('is-selected');
            }
            updateSelectionBar();
            return;
          }
          if (act === 'bookmark') {
            toggleBookmark(msg);
            actionEl.classList.toggle('is-active', !!msg.bookmarked);
          } else if (act === 'copy') {
            copyMessageText(msg);
          } else if (act === 'copy-md') {
            copyMessageMarkdown(msg);
          } else if (act === 'search') {
            toggleMessageSearch(msg);
          }
          return;
        }
        scrollToMessage(msg);
      });
      fragment.appendChild(div);
    });
    list.appendChild(fragment);
    // 恢复页内搜索框（防止 list 重渲染清掉搜索框）
    restoreMessageSearchIfActive();
  }

  // 高亮搜索关键词（在已设置 textContent 的元素内）
  function applyHighlight(el, query) {
    if (!query) return;
    const text = el.textContent || '';
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) return;
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + query.length);
    const after = text.slice(idx + query.length);
    el.innerHTML = '';
    el.appendChild(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.textContent = match;
    el.appendChild(mark);
    el.appendChild(document.createTextNode(after));
  }

  function toggleBookmark(msg) {
    msg.bookmarked = !msg.bookmarked;
    // 持久化到 background（用 templateKey + location.pathname 作为 conversationKey 的 fallback）
    const conversationKey = `${_templateKey}:${location.pathname}`;
    try {
      chrome.runtime.sendMessage({
        action: 'aiNavToggleBookmark',
        conversationKey,
        messageId: msg.id
      }).catch(() => {});
    } catch {}
    // 如果当前在收藏标签下，取消收藏要从列表移除
    if (_sidebarFilter === 'bookmark' && !msg.bookmarked) {
      renderSidebarList();
    }
  }

  // 复制纯文本
  async function copyMessageText(msg) {
    const text = msg.text || msg.preview || '';
    if (!text) return;
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制' : '复制失败');
  }

  // 复制为 Markdown（参考 ChatTOC：用 ClipboardItem 写 text/plain + text/markdown）
  async function copyMessageMarkdown(msg) {
    let md = '';
    try {
      if (msg.element) md = extractMarkdown(msg.element);
    } catch {}
    if (!md) md = msg.text || msg.preview || '';
    if (!md) return;
    const ok = await copyMarkdownToClipboard(md);
    showToast(ok ? '已复制 Markdown' : '复制失败');
  }

  function copyToClipboard(text) {
    return new Promise((resolve) => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(fallbackCopy(text)));
        } else {
          resolve(fallbackCopy(text));
        }
      } catch {
        resolve(fallbackCopy(text));
      }
    });
  }

  function copyMarkdownToClipboard(text) {
    return new Promise((resolve) => {
      try {
        if (navigator.clipboard && window.isSecureContext && typeof ClipboardItem !== 'undefined') {
          const item = new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/markdown': new Blob([text], { type: 'text/markdown' })
          });
          navigator.clipboard.write([item]).then(() => resolve(true)).catch(() => copyToClipboard(text).then(resolve));
        } else {
          copyToClipboard(text).then(resolve);
        }
      } catch {
        copyToClipboard(text).then(resolve);
      }
    });
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // Toast 提示
  let _toastTimer = null;
  function showToast(text) {
    let toast = _root.querySelector('.sidebar__toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'sidebar__toast';
      _root.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
  }

  // 页内搜索：滚动到消息并在该条目下方展开内嵌搜索框
  function toggleMessageSearch(msg) {
    // 先滚动到消息
    scrollToMessage(msg);
    // 记录搜索状态，renderSidebarList 后可恢复
    _activeMessageSearch = { msgId: msg.id, query: '' };
    // 找到消息条目 DOM
    const itemEl = _sidebar.querySelector(`.sidebar__message[data-id="${CSS.escape(msg.id)}"]`);
    if (!itemEl) return;
    // 移除其他条目的搜索框
    _sidebar.querySelectorAll('.sidebar__message-search').forEach(el => el.remove());
    // 创建内嵌搜索框
    const searchBox = document.createElement('div');
    searchBox.className = 'sidebar__message-search';
    searchBox.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#8a8f98;flex-shrink:0">
        <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
      </svg>
      <input type="text" placeholder="输入关键词，高亮页内匹配..." />
      <button class="sidebar__message-search-close" title="关闭">×</button>
    `;
    itemEl.appendChild(searchBox);
    const input = searchBox.querySelector('input');
    const closeBtn = searchBox.querySelector('.sidebar__message-search-close');
    input.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      _activeMessageSearch.query = q;
      applyPageHighlight(msg, q);
    });
    closeBtn.addEventListener('click', () => {
      applyPageHighlight(msg, '');
      _activeMessageSearch = null;
      searchBox.remove();
    });
    input.focus();
  }

  // renderSidebarList 后恢复页内搜索框（防止 list 重渲染清掉搜索框）
  function restoreMessageSearchIfActive() {
    if (!_activeMessageSearch) return;
    const itemEl = _sidebar?.querySelector(`.sidebar__message[data-id="${CSS.escape(_activeMessageSearch.msgId)}"]`);
    if (!itemEl) return;
    if (itemEl.querySelector('.sidebar__message-search')) return; // 已存在
    const msg = _messages.find(m => m.id === _activeMessageSearch.msgId);
    if (!msg) return;
    const searchBox = document.createElement('div');
    searchBox.className = 'sidebar__message-search';
    searchBox.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#8a8f98;flex-shrink:0">
        <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
      </svg>
      <input type="text" placeholder="输入关键词，高亮页内匹配..." value="${escapeHtml(_activeMessageSearch.query)}" />
      <button class="sidebar__message-search-close" title="关闭">×</button>
    `;
    itemEl.appendChild(searchBox);
    const input = searchBox.querySelector('input');
    const closeBtn = searchBox.querySelector('.sidebar__message-search-close');
    input.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      _activeMessageSearch.query = q;
      applyPageHighlight(msg, q);
    });
    closeBtn.addEventListener('click', () => {
      applyPageHighlight(msg, '');
      _activeMessageSearch = null;
      searchBox.remove();
    });
    // 恢复焦点（不选中文本，光标放末尾）
    input.focus();
    try {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    } catch {}
  }

  // 在消息元素内高亮关键词
  function applyPageHighlight(msg, query) {
    if (!msg?.element) return;
    // 抑制 MutationObserver 触发的 parseMessages，避免 renderSidebarList 清掉搜索框。
    // 注意：observer 回调是异步的，同步 try/finally 会在回调执行前就重置标志，因此必须延迟重置，
    // 覆盖 observer 的 300ms 防抖窗口（+100ms 余量）。
    _suppressParse = true;
    if (_suppressParseTimer) clearTimeout(_suppressParseTimer);
    _suppressParseTimer = setTimeout(() => { _suppressParse = false; }, 400);

    // 先清除之前的高亮
    msg.element.querySelectorAll('mark.markline-highlight').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    if (!query) return;
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(msg.element, NodeFilter.SHOW_TEXT, null);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      const idx = text.toLowerCase().indexOf(lower);
      if (idx >= 0 && node.parentNode && !['SCRIPT', 'STYLE'].includes(node.parentNode.tagName)) {
        matches.push({ node, text, idx });
      }
    }
    matches.forEach(({ node, text, idx }) => {
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + query.length);
      const after = text.slice(idx + query.length);
      const mark = document.createElement('mark');
      mark.className = 'markline-highlight';
      mark.textContent = match;
      mark.style.cssText = 'background:#fef3c7;color:inherit;padding:0 2px;border-radius:2px;';
      const parent = node.parentNode;
      parent.replaceChild(document.createTextNode(before), node);
      parent.insertBefore(mark, node.nextSibling);
      parent.insertBefore(document.createTextNode(after), mark.nextSibling);
    });
  }

  // 图片查看器（全屏）
  let _imageViewer = null;
  let _imageViewerState = { images: [], index: 0 };
  function openImageViewer(images, startIndex = 0) {
    if (!images || !images.length) return;
    _imageViewerState = { images, index: startIndex };
    if (!_imageViewer) {
      _imageViewer = document.createElement('div');
      _imageViewer.className = 'sidebar__image-viewer-overlay';
      _imageViewer.innerHTML = `
        <button class="sidebar__image-viewer-close" title="关闭 (Esc)">×</button>
        <button class="sidebar__image-viewer-prev" title="上一张 (←)">‹</button>
        <img class="sidebar__image-viewer-img" />
        <button class="sidebar__image-viewer-next" title="下一张 (→)">›</button>
        <div class="sidebar__image-viewer-info"></div>
      `;
      _root.appendChild(_imageViewer);
      _imageViewer.querySelector('.sidebar__image-viewer-close').addEventListener('click', closeImageViewer);
      _imageViewer.querySelector('.sidebar__image-viewer-prev').addEventListener('click', () => navigateImageViewer(-1));
      _imageViewer.querySelector('.sidebar__image-viewer-next').addEventListener('click', () => navigateImageViewer(1));
      _imageViewer.addEventListener('click', (e) => {
        if (e.target === _imageViewer) closeImageViewer();
      });
      document.addEventListener('keydown', (e) => {
        if (!_imageViewer.classList.contains('is-visible')) return;
        if (e.key === 'Escape') closeImageViewer();
        else if (e.key === 'ArrowLeft') navigateImageViewer(-1);
        else if (e.key === 'ArrowRight') navigateImageViewer(1);
      });
    }
    syncImageViewer();
    _imageViewer.classList.add('is-visible');
  }

  function syncImageViewer() {
    if (!_imageViewer) return;
    const { images, index } = _imageViewerState;
    const img = _imageViewer.querySelector('.sidebar__image-viewer-img');
    const info = _imageViewer.querySelector('.sidebar__image-viewer-info');
    const cur = images[index];
    if (cur) {
      img.src = cur.src;
      img.alt = cur.alt || '';
      info.textContent = `${index + 1} / ${images.length}${cur.alt ? ' · ' + cur.alt : ''}`;
    }
    _imageViewer.querySelector('.sidebar__image-viewer-prev').style.display = images.length > 1 ? '' : 'none';
    _imageViewer.querySelector('.sidebar__image-viewer-next').style.display = images.length > 1 ? '' : 'none';
  }

  function navigateImageViewer(delta) {
    const { images, index } = _imageViewerState;
    if (images.length <= 1) return;
    _imageViewerState.index = (index + delta + images.length) % images.length;
    syncImageViewer();
  }

  function closeImageViewer() {
    if (_imageViewer) _imageViewer.classList.remove('is-visible');
  }

  // 导出消息（参考 ChatTOC：JSON / Markdown 两种格式，Blob + a 标签下载）
  // 更新选择栏：选中计数 + 显示/隐藏
  function updateSelectionBar() {
    if (!_sidebar) return;
    const count = _selectedMessageIds.size;
    const selectionBar = _sidebar.querySelector('.sidebar__selection-bar');
    const countEl = _sidebar.querySelector('.sidebar__selection-count');
    if (selectionBar) selectionBar.classList.toggle('is-visible', count > 0);
    if (countEl) countEl.textContent = `已选 ${count} 条`;
  }

  function exportMessages(format) {
    if (!_messages.length) {
      showToast('暂无消息可导出');
      return;
    }
    // 根据选择状态筛选消息：有选中则仅导出选中，否则导出全部
    const selectedSize = _selectedMessageIds.size;
    const filteredMessages = selectedSize > 0
      ? _messages.filter(m => _selectedMessageIds.has(m.id))
      : _messages;
    if (!filteredMessages.length) {
      showToast('暂无消息可导出');
      return;
    }
    const site = _template?.name || location.hostname || 'Chat';
    const url = location.href;
    const exportedAt = new Date().toISOString();
    const payload = {
      site,
      url,
      exportedAt,
      messages: filteredMessages.map(m => ({
        index: m.index,
        role: m.role,
        content: m.text || '',
        images: (m.images || []).map(img => ({ src: img.src, alt: img.alt || '' }))
      }))
    };
    const domain = (location.hostname || 'chat').replace(/\./g, '_');
    const timestamp = exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `chat_${domain}_${timestamp}`;
    const scopeHint = selectedSize > 0 ? `（选中 ${filteredMessages.length} 条）` : '（全部）';
    if (format === 'markdown') {
      const md = buildMarkdownFromPayload(payload);
      downloadFile(`${baseName}.md`, md, 'text/markdown');
      showToast(`已导出 Markdown${scopeHint}`);
    } else {
      downloadFile(`${baseName}.json`, JSON.stringify(payload, null, 2), 'application/json');
      showToast(`已导出 JSON${scopeHint}`);
    }
  }

  function buildMarkdownFromPayload(payload) {
    const lines = [`# ${payload.site} 对话导出

## 元信息

- 站点：${payload.site}
- 链接：${payload.url}
- 导出时间：${payload.exportedAt}

## 对话内容
`];
    payload.messages.forEach(m => {
      const roleLabel = m.role === 'user' ? '用户' : 'AI';
      lines.push(`### ${m.index}. ${roleLabel}

${m.content}
`);
      if (m.images && m.images.length) {
        lines.push('\n**图片：**\n');
        m.images.forEach(img => {
          lines.push(`![${img.alt || ''}](${img.src})`);
        });
        lines.push('');
      }
    });
    return lines.join('\n');
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function scrollToMessage(msg) {
    if (!msg?.element) return;
    try {
      msg.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      msg.element.scrollIntoView();
    }
    // 临时高亮
    const prevOutline = msg.element.style.outline;
    const prevOffset = msg.element.style.outlineOffset;
    msg.element.style.outline = '2px solid rgba(250,204,21,0.7)';
    msg.element.style.outlineOffset = '2px';
    setTimeout(() => {
      msg.element.style.outline = prevOutline;
      msg.element.style.outlineOffset = prevOffset;
    }, 1500);
    _activeId = msg.id;
    renderSidebarList();
    updateActiveInfo();
    updateTimelineActive();
    notifyState();
  }

  function getSearchValue() {
    return _searchQuery;
  }

  function scrollContainer(direction) {
    if (!_template) return;
    const container = querySelectorMulti(_template.selectors.container);
    if (!container) return;
    if (direction === 'top') {
      container.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  }

  // 上一条/下一条消息导航（底部按钮）
  function navigateMessage(direction) {
    if (!_messages.length) return;
    let idx = _messages.findIndex(m => m.id === _activeId);
    let target;
    if (idx < 0) {
      // 无当前活跃消息：默认从第一条开始
      target = _messages[0];
    } else if (direction === 'prev') {
      target = idx > 0 ? _messages[idx - 1] : _messages[idx]; // 已到顶，停留在第一条
    } else {
      target = idx < _messages.length - 1 ? _messages[idx + 1] : _messages[idx]; // 已到底，停留在最后一条
    }
    if (!target) return;
    // scrollToMessage 内部已处理 _activeId / renderSidebarList / updateActiveInfo
    scrollToMessage(target);
  }

  function updateActiveInfo() {
    const el = _root?.querySelector('[data-role="active-info"]');
    if (!el) return;
    const idx = _messages.findIndex(m => m.id === _activeId);
    if (!_messages.length || idx < 0) {
      el.textContent = _messages.length ? `0 / ${_messages.length}` : '—';
    } else {
      el.textContent = `${idx + 1} / ${_messages.length}`;
    }
    // 同步按钮禁用状态
    const prevBtn = _sidebar?.querySelector('[data-action="top"]');
    const nextBtn = _sidebar?.querySelector('[data-action="bottom"]');
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx >= _messages.length - 1;
  }

  // ===== 竖线时间轴（对齐 ChatTOC：胶囊背景 + flex 均分）=====
  function isTimelineEnabled() {
    return _settings?.showTimeline !== false;
  }

  function getFullHeightThreshold() {
    return 14; // 消息数 ≥ 14 时用 full-height 模式
  }

  function renderTimeline() {
    if (!_timeline) return;
    const show = isTimelineEnabled();
    _timeline.classList.toggle('is-hidden', !show);
    if (!show) return;

    // 位置
    const rawPos = _settings?.timelinePosition || 'free';
    if (rawPos === 'free') {
      // 自由拖拽模式：沿用上次拖拽吸附的侧（默认右）
      _timeline.dataset.pos = _settings?.timelineFreeSide || 'right';
    } else {
      // 固定模式：清除拖拽残留样式，固定吸附到设置侧
      _timeline.classList.remove('is-manual-pos');
      _timeline.style.left = '';
      _timeline.style.right = '';
      _timeline.style.top = '';
      _timeline.style.bottom = '';
      _timeline.style.transform = '';
      _timeline.dataset.pos = rawPos;
    }

    const list = _root.querySelector('[data-role="tl-list"]');
    if (!list) return;
    list.innerHTML = '';

    if (!_messages.length) return;

    // 数轴线始终展示全部消息节点（用户=蓝圆 / AI=绿棱形）
    const items = _messages;

    // 双模式：消息数 ≥ 阈值用 full-height（节点均分），否则 compact（居中、可滚动）
    const isFullHeight = items.length >= getFullHeightThreshold();
    _timeline.classList.toggle('is-full-height', isFullHeight);
    _timeline.classList.toggle('is-compact', !isFullHeight);

    const fragment = document.createDocumentFragment();
    items.forEach(msg => {
      const item = document.createElement('div');
      item.className = `timeline-item is-${msg.role}` + (msg.id === _activeId ? ' is-active' : '');
      item.dataset.id = msg.id;

      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'timeline-node' + (msg.id === _activeId ? ' is-active' : '');
      node.title = msg.preview || '';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        scrollToMessage(msg);
      });
      node.addEventListener('mouseenter', () => showTimelineTooltipFloat(msg, node));
      node.addEventListener('mouseleave', hideTimelineTooltipFloat);

      item.appendChild(node);
      fragment.appendChild(item);
    });
    list.appendChild(fragment);
  }

  // tooltip 用 fixed 浮层定位（参考 ChatTOC showPageTimelineTooltipFloat）
  function showTimelineTooltipFloat(msg, nodeEl) {
    if (!_timelineTooltip) return;
    _timelineTooltip.textContent = msg.preview || '';
    _timelineTooltip.classList.remove('is-visible');
    // 先隐藏测量
    _timelineTooltip.style.visibility = 'hidden';
    _timelineTooltip.style.left = '-9999px';
    _timelineTooltip.style.top = '0';
    _timelineTooltip.style.display = '-webkit-box';

    const rect = nodeEl.getBoundingClientRect();
    const gap = 8;
    const maxW = Math.min(210, Math.max(120, window.innerWidth - 16));
    _timelineTooltip.style.width = `${maxW}px`;
    const th = _timelineTooltip.offsetHeight;
    const tw = _timelineTooltip.offsetWidth;

    // 默认放在节点左侧
    let left = rect.left - gap - tw;
    let top = rect.top + rect.height / 2 - th / 2;
    // 左侧放不下则放右侧
    if (left < 8) {
      left = rect.right + gap;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
    _timelineTooltip.style.left = `${left}px`;
    _timelineTooltip.style.top = `${top}px`;
    _timelineTooltip.style.visibility = '';
    _timelineTooltip.classList.add('is-visible');
  }

  function hideTimelineTooltipFloat() {
    if (_timelineTooltip) _timelineTooltip.classList.remove('is-visible');
  }

  // ===== ScrollSpy =====
  function setupScrollSpy() {
    // 滚动时隐藏 tooltip（节点位置变了，tooltip 会跑偏）
    const onScroll = () => {
      hideTimelineTooltipFloat();
      if (_scrollSpyTimer) clearTimeout(_scrollSpyTimer);
      _scrollSpyTimer = setTimeout(updateActive, 100);
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', hideTimelineTooltipFloat, { passive: true });
    // 部分平台滚动容器不是 window
    if (_template) {
      const container = querySelectorMulti(_template.selectors.container);
      if (container && container !== document.body) {
        container.addEventListener('scroll', onScroll, { passive: true });
      }
    }
  }

  function updateActive() {
    if (!_messages.length) return;
    const center = window.scrollY + window.innerHeight / 2;
    let closest = null, minDist = Infinity;
    for (const m of _messages) {
      if (!m.element) continue;
      const r = m.element.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) {
        const c = r.top + window.scrollY + r.height / 2;
        const d = Math.abs(c - center);
        if (d < minDist) { minDist = d; closest = m; }
      }
    }
    if (closest && closest.id !== _activeId) {
      _activeId = closest.id;
      renderSidebarList();
      updateActiveInfo();
      updateTimelineActive();
      notifyState();
    }
  }

  // 仅更新时间轴节点的 active 状态（不重建 DOM，避免抖动）
  function updateTimelineActive() {
    if (!_timeline) return;
    const items = _root.querySelectorAll('.timeline-item');
    items.forEach(item => {
      const isActive = item.dataset.id === _activeId;
      item.classList.toggle('is-active', isActive);
      const node = item.querySelector('.timeline-node');
      if (node) node.classList.toggle('is-active', isActive);
    });
  }

  // ===== 窗口尺寸变化（时间轴重算）=====
  let _resizeTimer = null;
  function setupResizeListener() {
    window.addEventListener('resize', () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        renderTimeline();
      }, 200);
    }, { passive: true });
  }

  // ===== MutationObserver（防抖 300ms）=====
  function setupObserver() {
    if (!_template) return;
    const container = querySelectorMulti(_template.selectors.container);
    if (!container) {
      scheduleRetry();
      return;
    }
    if (_observer) _observer.disconnect();
    _observer = new MutationObserver(() => {
      // 页内高亮等自身 DOM 改动期间不触发重解析，避免 renderSidebarList 清掉搜索框
      if (_suppressParse) return;
      if (_observerTimer) clearTimeout(_observerTimer);
      _observerTimer = setTimeout(parseMessages, 300);
    });
    _observer.observe(container, { childList: true, subtree: true, characterData: true });
  }

  // ===== SPA 路由监听 =====
  function setupLocationMonitor() {
    if (_locationTimer) clearInterval(_locationTimer);
    _locationTimer = setInterval(() => {
      if (location.href !== _locationHref) {
        _locationHref = location.href;
        // 路由变化，重新解析
        _messages = [];
        _activeId = null;
        _activeMessageSearch = null;
        renderSidebarList();
        setStatus('路由变化，重新解析...');
        // 等待新页面渲染
        setTimeout(() => {
          parseMessages();
          setupObserver();
        }, 800);
      }
    }, 1000);
  }

  // ===== 拖拽（精简自 voice-player.js 的 pointer 事件方案）=====
  function setupBallDrag() {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    _ball.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = _ball.getBoundingClientRect();
      ox = r.left; oy = r.top;
      _ball.classList.add('dragging');
      _ball.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    _ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const newLeft = Math.max(0, Math.min(window.innerWidth - 48, ox + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 48, oy + dy));
      _ball.style.left = newLeft + 'px';
      _ball.style.top = newTop + 'px';
      _ball.style.right = 'auto';
      _ball.style.bottom = 'auto';
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      _ball.classList.remove('dragging');
      try { _ball.releasePointerCapture(e.pointerId); } catch {}
      // 判断是否真正发生拖拽（移动距离 > 3px），纯点击不抑制 click
      const dx = Math.abs(e.clientX - sx);
      const dy = Math.abs(e.clientY - sy);
      const moved = dx > 3 || dy > 3;
      if (!moved) return;
      // 自由移动：保留拖拽结束时的实际位置（inline left/top 已在 pointermove 中设置）
      // 仅根据水平中心点判定左右半边，用于侧边栏跟随定位
      const r = _ball.getBoundingClientRect();
      const onLeft = r.left + r.width / 2 < window.innerWidth / 2;
      _ball.dataset.pos = onLeft ? 'left' : 'right';
      // 同步侧边栏位置
      if (_sidebar) _sidebar.dataset.pos = onLeft ? 'left' : 'right';
      // 只有真正拖拽才抑制后续的 click 事件
      _ball._suppressClick = Date.now();
    }
    _ball.addEventListener('pointerup', endDrag);
    _ball.addEventListener('pointercancel', endDrag);
  }

  function toggleSidebar(force) {
    _sidebarOpen = (typeof force === 'boolean') ? force : !_sidebarOpen;
    if (_sidebar) {
      // 位置跟随悬浮球：优先用悬浮球的左右半边，回退到设置
      const pos = _ball?.dataset.pos || _settings?.position || 'right';
      _sidebar.dataset.pos = pos;
      const width = Math.max(280, Math.min(520, _settings?.sidebarWidth || 360));
      _sidebar.style.setProperty('--sidebar-w', `${width}px`);
      _sidebar.classList.toggle('is-open', _sidebarOpen);
    }
    // 侧边栏打开时隐藏竖线时间轴，避免遮挡和视觉重复
    if (_timeline) {
      _timeline.style.display = _sidebarOpen ? 'none' : '';
    }
    if (_sidebarOpen) updateActive();
    // 持久化打开状态
    try {
      chrome.runtime.sendMessage({
        action: 'aiNavSetSidebarState',
        data: { open: _sidebarOpen }
      }).catch(() => {});
    } catch {}
  }

  // ===== 悬浮菜单（打开侧边栏 / 调整消息宽度）=====
  function toggleFloatingMenu() {
    if (_floatingMenu && _floatingMenu.style.display !== 'none') {
      hideFloatingMenu();
    } else {
      showFloatingMenu('main');
    }
  }

  function showFloatingMenu(mode = 'main') {
    if (!_floatingMenu) return;
    _floatingMenuMode = mode;
    _floatingMenu.style.display = '';
    renderFloatingMenu();
    positionFloatingMenu();
    // 入场动画
    requestAnimationFrame(() => _floatingMenu.classList.add('is-visible'));

    if (!_floatingMenuOutsideHandler) {
      _floatingMenuOutsideHandler = (event) => {
        if (!_floatingMenu) return;
        const path = event.composedPath ? event.composedPath() : [];
        if (path.includes(_floatingMenu)) return;
        if (_ball && path.includes(_ball)) return; // 球的点击交给 click 处理
        hideFloatingMenu();
      };
      _floatingMenuEscHandler = (event) => {
        if (event.key === 'Escape') hideFloatingMenu();
      };
      _floatingMenuResizeHandler = () => positionFloatingMenu();
      document.addEventListener('pointerdown', _floatingMenuOutsideHandler, true);
      document.addEventListener('keydown', _floatingMenuEscHandler, true);
      window.addEventListener('resize', _floatingMenuResizeHandler);
    }
  }

  function hideFloatingMenu() {
    if (!_floatingMenu) return;
    _floatingMenu.classList.remove('is-visible');
    _floatingMenu.style.display = 'none';
    _floatingMenuMode = null;
    if (_floatingMenuOutsideHandler) {
      document.removeEventListener('pointerdown', _floatingMenuOutsideHandler, true);
      _floatingMenuOutsideHandler = null;
    }
    if (_floatingMenuEscHandler) {
      document.removeEventListener('keydown', _floatingMenuEscHandler, true);
      _floatingMenuEscHandler = null;
    }
    if (_floatingMenuResizeHandler) {
      window.removeEventListener('resize', _floatingMenuResizeHandler);
      _floatingMenuResizeHandler = null;
    }
    if (_floatingMenuWidthDebounce) {
      clearTimeout(_floatingMenuWidthDebounce);
      _floatingMenuWidthDebounce = null;
    }
  }

  function positionFloatingMenu() {
    if (!_floatingMenu || !_ball) return;
    const ballRect = _ball.getBoundingClientRect();
    // 先测量（display 已为 ''，但 opacity:0 不影响测量）
    const menuRect = _floatingMenu.getBoundingClientRect();
    const gap = 8;
    const ballOnLeft = _ball.dataset.pos === 'left';
    let left = ballOnLeft ? ballRect.left : (ballRect.right - menuRect.width);
    let top = ballRect.top - menuRect.height - gap;
    if (top < 8) top = ballRect.bottom + gap; // 上方放不下则放下方
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    _floatingMenu.style.left = `${left}px`;
    _floatingMenu.style.top = `${top}px`;
  }

  function renderFloatingMenu() {
    if (!_floatingMenu) return;
    if (_floatingMenuMode === 'width') renderFloatingMenuWidth();
    else renderFloatingMenuMain();
    // 渲染后重新定位（宽度可能变化）
    positionFloatingMenu();
  }

  function renderFloatingMenuMain() {
    const supported = _widthController?.isSupported() ?? false;
    const adjustLabel = '调整消息宽度';
    const openLabel = '打开侧边栏';
    const unsupportedTitle = '当前平台暂不支持宽度调整';

    _floatingMenu.innerHTML = '';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'fm-btn';
    openBtn.dataset.action = 'open-sidebar';
    openBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M5 8h2"/><path d="M5 12h2"/><path d="M5 16h2"/></svg>
      <span>${escapeHtml(openLabel)}</span>
    `;
    openBtn.addEventListener('click', () => {
      hideFloatingMenu();
      toggleSidebar(true);
    });
    _floatingMenu.appendChild(openBtn);

    const adjustBtn = document.createElement('button');
    adjustBtn.type = 'button';
    adjustBtn.className = 'fm-btn';
    adjustBtn.dataset.action = 'adjust-width';
    if (!supported) {
      adjustBtn.disabled = true;
      adjustBtn.title = unsupportedTitle;
    }
    adjustBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="M21 12H3"/><path d="M21 18H3"/><path d="M8 4l-4 2 4 2"/><path d="M16 20l4-2-4-2"/></svg>
      <span>${escapeHtml(adjustLabel)}</span>
    `;
    adjustBtn.addEventListener('click', () => {
      if (!supported) return;
      showFloatingMenu('width');
    });
    _floatingMenu.appendChild(adjustBtn);
  }

  function renderFloatingMenuWidth() {
    if (!_widthController) { showFloatingMenu('main'); return; }
    const titleLabel = '调整消息宽度';
    const backLabel = '返回';
    const resetLabel = '恢复默认';
    const nativeLabel = '原生宽度';
    const hintNotFound = '未匹配到消息容器，可能页面尚未渲染完成。';

    const stored = _templateKey ? _messageWidths?.[_templateKey] : null;
    const native = _widthController.detectNativeWidth();
    const min = MESSAGE_WIDTH_MIN;
    const max = _widthController.getMaxWidth();
    const fallback = native || stored || Math.min(max, 900);
    const current = _widthController.clampWidth(stored ?? fallback) ?? fallback;

    _floatingMenu.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'fm-width';
    wrap.innerHTML = `
      <div class="fm-width-header">
        <span>${escapeHtml(titleLabel)}</span>
        <button type="button" class="fm-width-back" data-action="back">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
          <span>${escapeHtml(backLabel)}</span>
        </button>
      </div>
      <div class="fm-width-row">
        <input type="range" class="fm-width-slider" min="${min}" max="${max}" step="8" value="${current}">
        <button type="button" class="fm-width-reset" data-action="reset" ${stored == null ? 'disabled' : ''}>${escapeHtml(resetLabel)}</button>
      </div>
      <div class="fm-width-value">
        <span><span data-role="current">${current}</span>px</span>
        <span>${escapeHtml(nativeLabel)}: ${native ? `${native}px` : '—'}</span>
      </div>
      ${native == null ? `<div class="fm-width-hint">${escapeHtml(hintNotFound)}</div>` : ''}
    `;
    _floatingMenu.appendChild(wrap);

    const slider = wrap.querySelector('.fm-width-slider');
    const currentEl = wrap.querySelector('[data-role="current"]');
    const resetBtn = wrap.querySelector('[data-action="reset"]');
    const backBtn = wrap.querySelector('[data-action="back"]');

    slider.addEventListener('input', () => {
      const value = parseInt(slider.value, 10);
      _widthController.apply(value);
      if (currentEl) currentEl.textContent = String(value);
      if (resetBtn) resetBtn.disabled = false;
      scheduleSaveMessageWidth(value);
    });
    resetBtn.addEventListener('click', () => resetCurrentMessageWidth());
    backBtn.addEventListener('click', () => showFloatingMenu('main'));
  }

  function scheduleSaveMessageWidth(width) {
    if (!_templateKey) return;
    if (_floatingMenuWidthDebounce) clearTimeout(_floatingMenuWidthDebounce);
    _floatingMenuWidthDebounce = setTimeout(() => {
      _floatingMenuWidthDebounce = null;
      persistMessageWidth(_templateKey, width);
    }, 200);
  }

  async function persistMessageWidth(templateKey, width) {
    if (!templateKey || !_widthController) return;
    const clamped = _widthController.clampWidth(width);
    if (clamped == null) return;
    _messageWidths = { ...(_messageWidths || {}), [templateKey]: clamped };
    try {
      await chrome.runtime.sendMessage({
        action: 'aiNavSetMessageWidth',
        templateKey,
        width: clamped
      });
    } catch (err) {
      console.warn('[AiNav] 保存消息宽度失败:', err);
    }
  }

  async function resetCurrentMessageWidth() {
    if (!_templateKey || !_widthController) return;
    if (_floatingMenuWidthDebounce) {
      clearTimeout(_floatingMenuWidthDebounce);
      _floatingMenuWidthDebounce = null;
    }
    const next = { ...(_messageWidths || {}) };
    delete next[_templateKey];
    _messageWidths = next;
    _widthController.clear();
    try {
      await chrome.runtime.sendMessage({
        action: 'aiNavSetMessageWidth',
        templateKey: _templateKey,
        width: null
      });
    } catch (err) {
      console.warn('[AiNav] 重置消息宽度失败:', err);
    }
    if (_floatingMenu && _floatingMenuMode === 'width') renderFloatingMenu();
  }

  // ===== 竖线时间轴拖拽（吸附到左右边缘 + 垂直居中）=====
  function setupTimelineDrag() {
    if (!_timeline) return;
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = false;

    _timeline.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 点击节点不触发拖拽（让节点 click 正常工作）
      if (e.target.closest('.timeline-node')) return;
      // 仅"自由拖拽"模式允许拖拽；固定左侧/右侧时禁用
      if ((_settings?.timelinePosition || 'free') !== 'free') return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = _timeline.getBoundingClientRect();
      ox = r.left; oy = r.top;
      _timeline.classList.add('is-dragging');
      try { _timeline.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });

    _timeline.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const w = _timeline.offsetWidth;
      const h = _timeline.offsetHeight;
      const newLeft = Math.max(0, Math.min(window.innerWidth - w, ox + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - h, oy + dy));
      _timeline.style.left = newLeft + 'px';
      _timeline.style.top = newTop + 'px';
      _timeline.style.right = 'auto';
      _timeline.style.bottom = 'auto';
      _timeline.style.transform = 'none';
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      _timeline.classList.remove('is-dragging');
      try { _timeline.releasePointerCapture(e.pointerId); } catch {}
      if (!moved) return;
      // 吸附到最近水平边缘 + 垂直居中
      const r = _timeline.getBoundingClientRect();
      const center = r.left + r.width / 2;
      const snapLeft = center < window.innerWidth / 2;
      _timeline.classList.add('is-manual-pos');
      _timeline.dataset.pos = snapLeft ? 'left' : 'right';
      // 清除拖拽期间的 inline 定位，改用吸附样式
      _timeline.style.transform = '';
      _timeline.style.top = '';
      _timeline.style.bottom = '';
      _timeline.style.left = snapLeft ? '18px' : '';
      _timeline.style.right = snapLeft ? '' : '18px';
      // 自由模式下持久化吸附侧（保持 timelinePosition=free 不变）
      try {
        chrome.runtime.sendMessage({
          action: 'aiNavSetSettings',
          patch: { timelineFreeSide: snapLeft ? 'left' : 'right' }
        }).catch(() => {});
      } catch {}
    }

    _timeline.addEventListener('pointerup', endDrag);
    _timeline.addEventListener('pointercancel', endDrag);
  }

  // ===== 状态广播 =====
  function notifyState() {
    try {
      chrome.runtime.sendMessage({
        action: 'aiNavState',
        state: {
          activeId: _activeId,
          count: _messages.length,
          templateKey: _templateKey,
          messages: _messages.map(m => ({
            id: m.id,
            index: m.index,
            role: m.role,
            preview: m.preview
          }))
        }
      }).catch(() => {});
    } catch {}
  }

  // ===== 消息监听（来自 background / 独立窗口）=====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.action) return;
    if (msg.action === 'aiNavScrollTo' && msg.messageId) {
      const m = _messages.find(x => x.id === msg.messageId);
      if (m) scrollToMessage(m);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'aiNavScrollContainer') {
      scrollContainer(msg.direction);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'aiNavRefresh') {
      parseMessages();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'aiNavGetState') {
      sendResponse({
        ok: true,
        state: {
          activeId: _activeId,
          count: _messages.length,
          templateKey: _templateKey,
          messages: _messages.map(m => ({
            id: m.id, index: m.index, role: m.role, preview: m.preview
          }))
        }
      });
      return true;
    }
    // 设置变化（由独立窗口触发）
    if (msg.action === 'aiNavSettingsChanged') {
      init(true);
      sendResponse({ ok: true });
      return true;
    }
  });

  // 监听 storage 变化（设置页保存后触发）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.ai_nav_settings) {
      init(true);
    }
  });

  // ===== 入口 =====
  async function init(reload = false) {
    const domain = location.hostname;
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ action: 'aiNavGetTemplate', domain });
    } catch (err) {
      console.warn('[AiNav] 获取模板失败:', err);
      return;
    }
    if (!resp?.ok) {
      // 不支持的平台或被禁用 → 移除 UI
      if (resp?.disabled) {
        removeUI();
      }
      return;
    }
    const newTemplateKey = resp.templateKey;
    // 模板未变化且非 reload，跳过
    if (!reload && _templateKey === newTemplateKey && _root) return;

    _template = resp.template;
    _templateKey = newTemplateKey;
    _settings = resp.settings;

    if (!_settings.enabled || !_settings.floatingBallEnabled) {
      removeUI();
      return;
    }

    ensureUI();
    applyTheme();
    updateSidebarHeader();
    // 应用已保存的消息宽度
    try {
      const wResp = await chrome.runtime.sendMessage({ action: 'aiNavGetMessageWidths' });
      if (wResp?.ok) {
        _messageWidths = wResp.widths || {};
        applyStoredMessageWidth();
      }
    } catch {}
    setupObserver();
    setupScrollSpy();
    setupResizeListener();
    setupLocationMonitor();
    setStatus('加载中...');

    // 等待容器渲染（SPA）
    setTimeout(parseMessages, 800);
  }

  function removeUI() {
    hideFloatingMenu();
    closeImageViewer();
    if (_widthController) { _widthController.clear(); }
    if (_observer) { _observer.disconnect(); _observer = null; }
    if (_locationTimer) { clearInterval(_locationTimer); _locationTimer = null; }
    if (_ball) { _ball.remove(); _ball = null; }
    if (_sidebar) { _sidebar.remove(); _sidebar = null; }
    if (_timeline) { _timeline.remove(); _timeline = null; }
    if (_timelineTooltip) { _timelineTooltip.remove(); _timelineTooltip = null; }
    if (_floatingMenu) { _floatingMenu.remove(); _floatingMenu = null; }
    _imageViewer = null;
    if (_root) {
      const host = _root.host;
      host.remove();
      _root = null;
    }
    _messages = [];
    _activeId = null;
    _templateKey = null;
    _widthController = null;
    _messageWidths = {};
    _activeMessageSearch = null;
    _suppressParse = false;
    if (_suppressParseTimer) { clearTimeout(_suppressParseTimer); _suppressParseTimer = null; }
    _selectedMessageIds = new Set();
  }

  // 暴露调试 API
  window.MarklineAiNav = {
    parseMessages,
    getMessages: () => _messages,
    getTemplate: () => _template,
    toggleSidebar,
    remove: removeUI
  };

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
