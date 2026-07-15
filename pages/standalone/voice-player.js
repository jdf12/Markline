// pages/standalone/voice-player.js
// 语音朗读播放器主模块
// - 通过 chrome.runtime.sendMessage 调用 background 的 voice* 消息
// - 短文本：同步合成 → base64 dataUrl → <audio> 播放
// - 长文本：分段 → 异步合成 → <audio src="streamUrl"> 流式播放 + 预合成下一段
// - 提取正文用 background/vendor/Readability.js（已在 standalone.html 加载）
//
// 暴露 window.VoicePlayer：
//   init()                          初始化（创建 <audio>、绑定 UI 事件）
//   async playFromUrl(url, title)   从 URL 抓取正文并朗读
//   async playFromText(text, title) 直接朗读文本
//   togglePlay()
//   stop()
//   seek(ratio)                     0~1
//   setRate(rateStr)                "+0%" 等
//   isPlaying()
//   getState()
//   onStateChange(cb)               注册状态变更回调（供 MDI 按钮同步）
//   showUI() / hideUI()

(function (global) {
  'use strict';

  // ===== 状态 =====
  let _audio = null;             // <audio> 元素
  let _ui = null;                // 浮动播放器 DOM 根
  let _initialized = false;

  let _settings = null;          // 缓存的 voice_settings
  let _bridgeOk = false;         // 桥接是否可用

  // 当前朗读任务
  let _current = null;
  // _current 结构:
  //   { windowId, url, title, chunks: [{ text }], currentIndex,
  //     mode: 'sync'|'async', taskId?, objectUrl?, mediaSource?, totalLen,
  //     sentences?, wordGroups?, words?, totalChars, activeSentenceIdx }

  // 预合成队列
  let _prefetchTaskId = null;

  // ===== Web Audio API: 频谱分析 =====
  let _audioCtx = null;           // AudioContext
  let _analyser = null;           // AnalyserNode
  let _sourceNode = null;         // MediaElementAudioSourceNode
  let _freqData = null;           // Uint8Array 频谱数据
  let _rafId = null;              // requestAnimationFrame 句柄（波形动画）
  const _BAR_COUNT = 5;           // 波形柱子数量（与 SVG 中 data-bar 数量一致）
  const _BAR_VALUES = new Array(_BAR_COUNT).fill(0);  // 平滑后的柱子高度（0~1）

  // ===== 歌词实时滚动 =====
  let _lyricsRafId = null;        // requestAnimationFrame 句柄（歌词滚动）
  let _lastScrollOffset = null;   // 上次计算的偏移量，用于跳变检测

  // 状态变更订阅者
  const _subscribers = new Set();

  // ===== i18n 兜底（依赖全局 i18n()，但避免硬性依赖） =====
  function _t(key, fallback) {
    try {
      const v = (typeof global.i18n === 'function') ? global.i18n(key) : null;
      return v || fallback || key;
    } catch {
      return fallback || key;
    }
  }

  function _notifyState() {
    const state = getState();
    for (const cb of _subscribers) {
      try { cb(state); } catch {}
    }
  }

  function onStateChange(cb) {
    _subscribers.add(cb);
    return () => _subscribers.delete(cb);
  }

  function getState() {
    if (!_audio) {
      return { playing: false, position: 0, duration: 0, windowId: null, title: '', ready: false };
    }
    return {
      playing: !_audio.paused && !_audio.ended,
      position: _audio.currentTime || 0,
      duration: _audio.duration || 0,
      windowId: _current ? _current.windowId : null,
      title: _current ? _current.title : '',
      ready: _initialized && _bridgeOk
    };
  }

  function isPlaying() {
    return _audio && !_audio.paused && !_audio.ended;
  }

  // ===== 初始化 =====
  function init() {
    if (_initialized) return;
    _audio = new Audio();
    _audio.preload = 'auto';

    _audio.addEventListener('timeupdate', _onTimeUpdate);
    _audio.addEventListener('play', _onPlayPause);
    _audio.addEventListener('pause', _onPlayPause);
    _audio.addEventListener('ended', _onEnded);
    _audio.addEventListener('error', _onError);
    _audio.addEventListener('loadedmetadata', _onTimeUpdate);

    _buildUI();
    _bindUI();

    _initialized = true;

    // 加载设置 + 健康检查
    _refreshSettings();
  }

  async function _refreshSettings() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'voiceGetSettings' });
      if (resp && resp.success) {
        _settings = resp.settings;
      }
    } catch {}
    await checkBridge();
  }

  /**
   * 检测桥接是否可用（外部也可调用）
   */
  async function checkBridge() {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'voiceBridgeHealth' });
      _bridgeOk = !!(resp && resp.ok && resp.running);
    } catch {
      _bridgeOk = false;
    }
    return _bridgeOk;
  }

  // ===== UI 构建 =====
  function _buildUI() {
    if (document.getElementById('saVoicePlayer')) return;
    const el = document.createElement('div');
    el.id = 'saVoicePlayer';
    el.className = 'voice-player voice-player--hidden';
    el.innerHTML = `
      <div class="voice-player__handle">
        <div class="voice-player__handle-left">
          <svg class="voice-player__handle-icon voice-player__waveform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line class="voice-player__bar" data-bar="0" x1="4"  y1="12" x2="4"  y2="12"/>
            <line class="voice-player__bar" data-bar="1" x1="8"  y1="12" x2="8"  y2="12"/>
            <line class="voice-player__bar" data-bar="2" x1="12" y1="12" x2="12" y2="12"/>
            <line class="voice-player__bar" data-bar="3" x1="16" y1="12" x2="16" y2="12"/>
            <line class="voice-player__bar" data-bar="4" x1="20" y1="12" x2="20" y2="12"/>
          </svg>
          <div class="voice-player__title">${_t('voiceReading', '朗读中')}...</div>
        </div>
        <button class="voice-player__close" title="${_t('voiceStop', '关闭')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="voice-player__main">
        <button class="voice-player__play voice-player__play--play" title="${_t('voicePlay', '播放')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="voice-player__info">
          <div class="voice-player__lyrics" title="${_t('voiceClickToSeek', '点击句子跳转')}">
            <div class="voice-player__lyrics-track"></div>
          </div>
          <div class="voice-player__progress">
            <div class="voice-player__progress-bar"><div class="voice-player__progress-fill"></div></div>
            <div class="voice-player__time"><span class="voice-player__cur">00:00</span> / <span class="voice-player__dur">00:00</span></div>
          </div>
        </div>
        <div class="voice-player__controls">
          <select class="voice-player__rate" title="${_t('voiceRate', '语速')}">
            <option value="-30%">0.7x</option>
            <option value="-15%">0.85x</option>
            <option value="+0%" selected>1.0x</option>
            <option value="+15%">1.15x</option>
            <option value="+30%">1.3x</option>
            <option value="+50%">1.5x</option>
          </select>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    _ui = el;
  }

  function _bindUI() {
    if (!_ui) return;
    _ui.querySelector('.voice-player__play').addEventListener('click', togglePlay);
    _ui.querySelector('.voice-player__close').addEventListener('click', stop);

    const rateSel = _ui.querySelector('.voice-player__rate');
    if (rateSel) {
      rateSel.addEventListener('change', (e) => {
        setRate(e.target.value);
      });
    }

    // 点击进度条跳转
    const bar = _ui.querySelector('.voice-player__progress-bar');
    if (bar) {
      bar.addEventListener('click', (e) => {
        const rect = bar.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        seek(Math.max(0, Math.min(1, ratio)));
      });
    }

    // 点击句子跳转：通过时间戳或字符偏移反推播放进度
    const lyrics = _ui.querySelector('.voice-player__lyrics');
    if (lyrics) {
      lyrics.addEventListener('click', (e) => {
        const item = e.target.closest('.voice-player__lyrics-item');
        if (!_current) return;
        const idx = parseInt(item.dataset.idx, 10);
        if (isNaN(idx)) return;

        // 优先使用 WordBoundary 时间戳（精确）
        if (_current.wordGroups && idx < _current.wordGroups.length) {
          // startOffset 是 100ns 单位，转为秒
          const sec = _current.wordGroups[idx].startOffset / 1e7;
          if (_audio && _audio.duration && isFinite(_audio.duration)) {
            _audio.currentTime = sec;
            _updateLyricsPosition();
            return;
          }
        }

        // 回退：通过字符偏移反推
        if (_current.sentences && idx < _current.sentences.length) {
          const s = _current.sentences[idx];
          const ratio = s.startOffset / Math.max(1, _current.totalChars);
          seek(Math.max(0, Math.min(1, ratio)));
        }
      });
    }

    // 初始化拖拽
    _initDrag();
  }

  // ===== 拖拽逻辑 =====
  function _initDrag() {
    if (!_ui) return;
    const handle = _ui.querySelector('.voice-player__handle');
    if (!handle) return;

    let dragging = false;
    let startMouseX = 0;
    let startMouseY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    handle.addEventListener('mousedown', (e) => {
      // 点击关闭按钮时不触发拖拽
      if (e.target.closest('.voice-player__close')) return;

      dragging = true;
      moved = false;
      startMouseX = e.clientX;
      startMouseY = e.clientY;

      // 读取当前位置
      const rect = _ui.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      // 切换为绝对定位（脱离 left:50% + transform 的居中布局）
      _ui.style.left = startLeft + 'px';
      _ui.style.top = startTop + 'px';
      _ui.style.bottom = 'auto';
      _ui.style.transform = 'none';

      _ui.classList.add('voice-player--dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // 边界限制（至少保留部分可见）
      const rect = _ui.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width * 0.5;
      const minLeft = rect.width * -0.5 + 60;
      const maxTop = window.innerHeight - 50;
      const minTop = 4;

      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(minTop, Math.min(maxTop, newTop));

      _ui.style.left = newLeft + 'px';
      _ui.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      _ui.classList.remove('voice-player--dragging');
    });
  }

  // ===== Web Audio API: 频谱分析 =====

  /**
   * 初始化 AudioContext + AnalyserNode
   * 必须在用户交互后调用（点击朗读按钮已满足）
   * 注意：createMediaElementSource 会"劫持" audio 的输出，
   *       必须连接到 destination 才能听到声音
   */
  function _initAudioAnalyser() {
    if (!_audio) return;
    // 已初始化则跳过
    if (_sourceNode) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;  // 不支持 Web Audio API

      _audioCtx = new AudioCtx();
      _sourceNode = _audioCtx.createMediaElementSource(_audio);
      _analyser = _audioCtx.createAnalyser();
      _analyser.fftSize = 64;            // 32 个频段
      _analyser.smoothingTimeConstant = 0.7;  // 平滑度
      _freqData = new Uint8Array(_analyser.frequencyBinCount);

      // 连接: audio → analyser → destination
      _sourceNode.connect(_analyser);
      _analyser.connect(_audioCtx.destination);
    } catch (e) {
      console.warn('VoicePlayer: AudioAnalyser init failed:', e);
      _audioCtx = null;
      _analyser = null;
      _sourceNode = null;
    }
  }

  /**
   * 启动波形动画循环
   */
  function _startWaveform() {
    if (!_analyser || !_ui) return;
    if (_rafId) return;  // 已在运行
    _loopWaveform();
  }

  /**
   * 停止波形动画循环，柱子归位
   */
  function _stopWaveform() {
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    // 重置柱子高度为静止状态
    _resetBars();
  }

  /**
   * 重置柱子到静止高度（小高度，表示待机）
   */
  function _resetBars() {
    if (!_ui) return;
    const bars = _ui.querySelectorAll('.voice-player__bar');
    if (!bars.length) return;
    for (let i = 0; i < bars.length; i++) {
      _setBarHeight(bars[i], 0.15);  // 静止时 15% 高度
    }
  }

  /**
   * 设置单根柱子的高度（0~1）
   * 柱子以 y=12 为中心，向上下对称延伸
   * 最大半高 = 10（即 y 范围 2~22）
   */
  function _setBarHeight(barEl, ratio) {
    if (!barEl) return;
    const r = Math.max(0, Math.min(1, ratio));
    const halfHeight = 1 + r * 9;  // 1px ~ 10px
    const cy = 12;                 // 中心 y 坐标
    const y1 = cy - halfHeight;
    const y2 = cy + halfHeight;
    barEl.setAttribute('y1', y1.toFixed(1));
    barEl.setAttribute('y2', y2.toFixed(1));
  }

  /**
   * 波形动画主循环
   * 通过 AnalyserNode 读取频谱数据，更新 5 根柱子高度
   * 加入平滑过渡，避免抖动
   */
  function _loopWaveform() {
    if (!_analyser || !_ui) {
      _rafId = null;
      return;
    }

    _analyser.getByteFrequencyData(_freqData);

    // 把频谱数据分成 5 段，每段取平均值
    const totalBins = _freqData.length;
    const binsPerBar = Math.max(1, Math.floor(totalBins / _BAR_COUNT));

    const bars = _ui.querySelectorAll('.voice-player__bar');

    for (let i = 0; i < _BAR_COUNT && i < bars.length; i++) {
      // 取该频段的平均值
      let sum = 0;
      const start = i * binsPerBar;
      const end = Math.min(start + binsPerBar, totalBins);
      for (let j = start; j < end; j++) {
        sum += _freqData[j];
      }
      const avg = sum / Math.max(1, (end - start));
      // 归一化到 0~1，并增强低音区（语音主要在中低频）
      let target = avg / 255;
      // 非线性增强：小信号放大，避免波形太弱
      target = Math.pow(target, 0.7);

      // 平滑过渡（低通滤波）
      _BAR_VALUES[i] = _BAR_VALUES[i] * 0.6 + target * 0.4;

      _setBarHeight(bars[i], _BAR_VALUES[i]);
    }

    _rafId = requestAnimationFrame(_loopWaveform);
  }

  function showUI() {
    if (_ui) _ui.classList.remove('voice-player--hidden');
  }

  function hideUI() {
    if (_ui) _ui.classList.add('voice-player--hidden');
  }

  // ===== 播放控制 =====
  function togglePlay() {
    if (!_audio) return;
    if (_audio.paused) {
      _audio.play().catch(() => {});
    } else {
      _audio.pause();
    }
  }

  function stop() {
    if (!_audio) return;
    _audio.pause();
    _audio.src = '';
    _stopWaveform();  // 停止波形动画
    if (_ui) {
      const waveform = _ui.querySelector('.voice-player__waveform');
      if (waveform) waveform.classList.remove('voice-player__waveform--active');
    }
    _clearLyrics();  // 清空歌词轨道
    _cleanupCurrent();
    hideUI();
    _current = null;
    _notifyState();
  }

  function seek(ratio) {
    const dur = _getEffectiveDuration();
    if (!_audio || dur <= 0) return;
    _audio.currentTime = ratio * dur;
    // seek 后立即更新歌词位置
    _updateLyricsPosition();
  }

  function setRate(rateStr) {
    // rateStr 形如 "+15%"
    // <audio>.playbackRate 用浮点数
    const m = /^([+-]?\d+)%$/.exec(rateStr || '');
    if (!m) return;
    const pct = parseInt(m[1], 10);
    const rate = 1 + pct / 100;
    if (_audio) _audio.playbackRate = Math.max(0.5, Math.min(2.0, rate));
  }

  // ===== 抓取网页正文 =====
  async function _fetchAndExtract(url) {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`fetch_failed: ${resp.status}`);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (_settings && _settings.autoExtract && typeof Readability !== 'undefined') {
      try {
        const reader = new Readability(doc);
        const article = reader.parse();
        if (article && article.textContent && article.textContent.trim().length > 100) {
          return { text: article.textContent.trim(), title: article.title || '' };
        }
      } catch {}
    }
    // 回退：整个 body 文本
    const text = (doc.body && doc.body.innerText) || '';
    return { text: text.trim(), title: (doc.title || '') };
  }

  /**
   * 从 URL 朗读
   */
  async function playFromUrl(url, title, windowId) {
    if (!url) return;
    if (!_bridgeOk) {
      const ok = await checkBridge();
      if (!ok) {
        _toast(_t('voiceBridgeNotRunning', '语音桥接未运行，请先启动 voice_bridge.py'), 'warning');
        return;
      }
    }

    // 停止当前任务
    if (_current) stop();

    showUI();
    _setTitle(title || url);
    _setStatus(_t('voiceFetching', '正在抓取页面...'));

    try {
      const { text, title: extractedTitle } = await _fetchAndExtract(url);
      if (!text) {
        _toast(_t('voiceEmptyContent', '页面无正文可朗读'), 'warning');
        hideUI();
        return;
      }
      const finalTitle = title || extractedTitle || url;
      await playFromText(text, finalTitle, windowId);
      if (windowId) {
        _current = _current || {};
        _current.windowId = windowId;
      }
    } catch (e) {
      _toast(_t('voiceFetchFailed', '抓取页面失败') + ': ' + (e.message || e), 'error');
      hideUI();
    }
  }

  /**
   * 从文本朗读（核心入口）
   */
  async function playFromText(text, title, windowId) {
    if (!text || !text.trim()) {
      _toast(_t('voiceEmptyContent', '无正文可朗读'), 'warning');
      return;
    }

    // 每次朗读都强制刷新设置，确保用户在设置页修改的音色/语速等立即生效
    // （_settings 是缓存对象，不刷新会一直用旧值）
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'voiceGetSettings' });
      if (resp && resp.success) _settings = resp.settings;
    } catch {}

    // 截断超长文本
    const maxChars = (_settings && _settings.maxChars) || 30000;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
    }

    // 分段：按句子边界切，每段不超过 asyncThreshold
    const threshold = (_settings && _settings.asyncThreshold) || 3000;
    const chunks = _splitText(text, threshold);
    if (chunks.length === 0) {
      _toast(_t('voiceEmptyContent', '无正文可朗读'), 'warning');
      return;
    }

    _current = {
      windowId: windowId || null,
      url: null,
      title: title || '',
      chunks,
      currentIndex: 0,
      mode: chunks.length === 1 ? 'sync' : 'async',
      taskId: null,
      objectUrl: null,
      mediaSource: null,  // MediaSource 引用（流式播放时使用）
      totalLen: text.length
    };

    _setTitle(_current.title);
    _setStatus(_t('voiceSynthesizing', '正在合成语音...'));
    showUI();

    // 应用语速
    if (_settings && _settings.rate) {
      const rateSel = _ui && _ui.querySelector('.voice-player__rate');
      if (rateSel) {
        // 选中接近的选项
        for (const opt of rateSel.options) {
          if (opt.value === _settings.rate) { opt.selected = true; break; }
        }
      }
      setRate(_settings.rate);
    }

    await _playChunk(0);
  }

  // ===== 分段 =====
  function _splitText(text, maxLen) {
    // 按段落 + 句子边界切分，尽量在自然停顿处断开
    const chunks = [];
    // 先按段落分
    const paragraphs = text.split(/\n{1,}/).map(s => s.trim()).filter(Boolean);
    let cur = '';
    for (const p of paragraphs) {
      if ((cur + '\n' + p).length <= maxLen) {
        cur = cur ? cur + '\n' + p : p;
        continue;
      }
      // 当前段已满，先推入
      if (cur) { chunks.push(cur); cur = ''; }
      // 单段超长，按句子切
      if (p.length > maxLen) {
        const sentences = p.split(/(?<=[。！？.!?；;\n])/).filter(Boolean);
        for (const s of sentences) {
          if ((cur + s).length <= maxLen) {
            cur += s;
          } else {
            if (cur) chunks.push(cur);
            // 句子本身超长，硬切
            if (s.length > maxLen) {
              for (let i = 0; i < s.length; i += maxLen) {
                chunks.push(s.slice(i, i + maxLen));
              }
              cur = '';
            } else {
              cur = s;
            }
          }
        }
      } else {
        cur = p;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  /**
   * 将 chunk 文本按句子切分，记录每句的字符偏移
   * 用于实时滚动高亮显示当前朗读位置
   */
  function _splitSentences(text) {
    if (!text) return [];
    const sentences = [];
    // 匹配中英文句末标点（含引号闭合）+ 换行
    const re = /[^。！？.!?；;\n]+[。！？.!?；;\n]*/g;
    let m;
    let lastEnd = 0;
    while ((m = re.exec(text)) !== null) {
      const s = m[0];
      if (s.trim()) {
        sentences.push({
          text: s.trim(),
          startOffset: m.index,
          endOffset: m.index + s.length
        });
      }
      lastEnd = m.index + s.length;
    }
    // 兜底：未匹配到任何句子，整段作为一句
    if (sentences.length === 0 && text.trim()) {
      sentences.push({ text: text.trim(), startOffset: 0, endOffset: text.length });
    }
    // 末尾剩余（无标点结尾的文本）
    if (lastEnd < text.length) {
      const rest = text.slice(lastEnd).trim();
      if (rest) {
        sentences.push({ text: rest, startOffset: lastEnd, endOffset: text.length });
      }
    }
    return sentences;
  }

  /**
   * 渲染歌词轨道：在 lyrics-track 中生成所有句子 span
   */
  function _renderLyrics(sentences) {
    if (!_ui) return;
    const track = _ui.querySelector('.voice-player__lyrics-track');
    if (!track) return;
    track.innerHTML = '';
    if (!sentences || !sentences.length) return;
    for (let i = 0; i < sentences.length; i++) {
      const span = document.createElement('span');
      span.className = 'voice-player__lyrics-item';
      span.dataset.idx = String(i);
      span.textContent = sentences[i].text;
      track.appendChild(span);
    }
  }

  /**
   * 切换高亮类（仅当句子索引变化时调用）
   */
  function _setActiveLyricClass(idx) {
    if (!_ui) return;
    const items = _ui.querySelectorAll('.voice-player__lyrics-item');
    if (!items.length) return;
    for (let i = 0; i < items.length; i++) {
      if (i === idx) {
        items[i].classList.add('voice-player__lyrics-item--active');
      } else {
        items[i].classList.remove('voice-player__lyrics-item--active');
      }
    }
  }

  /**
   * 滚动到指定句子的中心位置（句子级滚动，不做句子内插值）
   */
  function _scrollLyricsTo(idx) {
    if (!_ui) return;
    const track = _ui.querySelector('.voice-player__lyrics-track');
    const container = _ui.querySelector('.voice-player__lyrics');
    if (!track || !container) return;
    const items = track.querySelectorAll('.voice-player__lyrics-item');
    if (idx < 0 || idx >= items.length) return;

    const containerW = container.clientWidth;
    const item = items[idx];
    const itemCenter = item.offsetLeft + item.offsetWidth / 2;

    // 让当前句中心对齐 container 中心
    let offset = containerW / 2 - itemCenter;

    // 边界限制
    const trackW = track.scrollWidth;
    const maxOffset = 4;
    const minOffset = containerW - trackW - 4;
    offset = Math.max(minOffset, Math.min(maxOffset, offset));

    track.style.transform = `translateX(${offset}px)`;
    _lastScrollOffset = offset;
  }

  /**
   * 获取有效播放时长
   * MediaSource 流式播放时 _audio.duration 可能为 Infinity（直到 endOfStream），
   * 此时用文本长度估算（中文约 5 字/秒，混合取 8 字/秒）
   */
  function _getEffectiveDuration() {
    if (_audio && _audio.duration && isFinite(_audio.duration) && _audio.duration > 0) {
      return _audio.duration;
    }
    // 兜底：按文本长度估算（考虑 playbackRate）
    if (_current && _current.totalChars) {
      const rate = (_audio && _audio.playbackRate) || 1;
      return _current.totalChars / (8 * rate);
    }
    return 0;
  }

  /**
   * 根据当前播放位置计算并更新歌词高亮与滚动
   * 优先使用 WordBoundary 时间戳（精确字级匹配），
   * 回退到字符比例估算（句子级匹配）
   * RAF 驱动（60fps），仅在显示索引变化时才操作 DOM
   *
   * 流式传输过程中 words 数组持续增长，
   * 每帧检测 words.length 变化，动态重新聚合 wordGroups 并增量渲染
   */
  function _updateLyricsPosition() {
    if (!_current) return;
    const cur = _audio.currentTime || 0;

    // ===== 方案 A: 使用 WordBoundary 时间戳（精确匹配）=====
    if (_current.words && _current.words.length) {
      // 检测 words 数组是否有新增，如有则重新聚合并增量渲染
      const wordsLen = _current.words.length;
      if (wordsLen !== (_current._lastWordsLen || 0)) {
        _current._lastWordsLen = wordsLen;
        const newGroups = _groupWords(_current.words);
        const oldLen = _current.wordGroups ? _current.wordGroups.length : 0;
        _current.wordGroups = newGroups;
        // 仅在词组数量变化时重新渲染（避免每帧都重建 DOM）
        if (newGroups.length !== oldLen) {
          _renderLyrics(newGroups);
          // 渲染后保持当前高亮（_renderLyrics 会清除高亮，需要重新设置）
          if (_current.activeSentenceIdx >= 0) {
            _setActiveLyricClass(_current.activeSentenceIdx);
            _scrollLyricsTo(_current.activeSentenceIdx);
          }
        }
      }

      if (_current.wordGroups && _current.wordGroups.length) {
        // currentTime 是秒，WordBoundary offset 是 100ns 单位，需要转换
        const cur100ns = cur * 1e7;
        const groups = _current.wordGroups;

        // 二分查找：找到 startOffset <= cur100ns 的最后一个 group
        let lo = 0, hi = groups.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (groups[mid].startOffset <= cur100ns) lo = mid;
          else hi = mid - 1;
        }
        const idx = lo;

        if (idx !== _current.activeSentenceIdx) {
          _current.activeSentenceIdx = idx;
          _setActiveLyricClass(idx);
          _scrollLyricsTo(idx);
        }
        return;
      }
    }

    // ===== 方案 B: 回退到字符比例估算（无字幕时间戳时）=====
    if (!_current.sentences || !_current.sentences.length) return;
    const dur = _getEffectiveDuration();
    if (dur <= 0) return;

    const progress = Math.min(1, cur / dur);
    const charPos = progress * _current.totalChars;

    let idx = -1;
    const sentences = _current.sentences;
    for (let i = 0; i < sentences.length; i++) {
      if (charPos >= sentences[i].startOffset && charPos < sentences[i].endOffset) {
        idx = i;
        break;
      }
    }
    if (idx === -1 && charPos >= sentences[sentences.length - 1].startOffset) {
      idx = sentences.length - 1;
    }
    if (idx === -1) return;

    if (idx !== _current.activeSentenceIdx) {
      _current.activeSentenceIdx = idx;
      _setActiveLyricClass(idx);
      _scrollLyricsTo(idx);
    }
  }

  /**
   * 启动歌词实时滚动循环（RAF 60fps）
   */
  function _startLyricsLoop() {
    if (_lyricsRafId) return;  // 已在运行
    const loop = () => {
      _updateLyricsPosition();
      _lyricsRafId = requestAnimationFrame(loop);
    };
    _lyricsRafId = requestAnimationFrame(loop);
  }

  /**
   * 停止歌词实时滚动循环
   */
  function _stopLyricsLoop() {
    if (_lyricsRafId) {
      cancelAnimationFrame(_lyricsRafId);
      _lyricsRafId = null;
    }
    _lastScrollOffset = null;  // 重置，下次启动重新计算
  }

  /**
   * 清空歌词轨道
   */
  function _clearLyrics() {
    _stopLyricsLoop();
    if (!_ui) return;
    const track = _ui.querySelector('.voice-player__lyrics-track');
    if (track) {
      track.innerHTML = '';
      track.style.transform = '';
    }
    _lastScrollOffset = null;
  }

  // ===== 直接 fetch 桥接 =====
  // 不经过 background 的 base64 转换，直接拿到 Blob → URL.createObjectURL
  // 性能更好，且避免了 Service Worker 中 btoa 的限制

  async function _getBridgeUrl() {
    if (!_settings) {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'voiceGetSettings' });
        if (resp && resp.success) _settings = resp.settings;
      } catch {}
    }
    const port = (_settings && _settings.bridgePort) || 7822;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * 流式同步合成：用 MediaSource API 边接收边播放
   * 桥接端用 chunked encoding 边合成边发送，客户端边接收边喂给 MediaSource
   * 实现真正的流式播放（无需等待完整下载）
   *
   * @returns {Promise<{ok, objectUrl, mediaSource?}>}
   */
  async function _startStreamPlayback(text) {
    const base = await _getBridgeUrl();
    const body = {
      text,
      voice: (_settings && _settings.defaultVoice) || 'zh-CN-XiaoxiaoNeural',
      rate: (_settings && _settings.rate) || '+0%',
      pitch: (_settings && _settings.pitch) || '+0Hz',
      volume: (_settings && _settings.volume) || '+0%'
    };

    // 发起 fetch 请求
    const resp = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      let err = `http_${resp.status}`;
      try {
        const j = await resp.json();
        if (j && j.error) err = j.error;
      } catch {}
      return { ok: false, error: err };
    }

    // 检查是否返回了 JSON 错误（合成失败时桥接可能返回 JSON）
    const ctype = resp.headers.get('Content-Type') || '';
    if (ctype.includes('application/json')) {
      const j = await resp.json();
      return { ok: false, error: (j && j.error) || 'unknown' };
    }

    // 检查 MediaSource 支持
    const canUseMSE = window.MediaSource && MediaSource.isTypeSupported('audio/mpeg');

    if (canUseMSE) {
      // ===== 方案 A: MediaSource 流式播放（边接收边播放）=====
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);

      // 在 sourceopen 事件中开始流式填充
      mediaSource.addEventListener('sourceopen', () => {
        _pumpStreamToMediaSource(resp.body, mediaSource);
      }, { once: true });

      return { ok: true, objectUrl, mediaSource };
    } else {
      // ===== 方案 B: 回退到完整下载后播放 =====
      const blob = await resp.blob();
      if (!blob || blob.size === 0) {
        return { ok: false, error: 'empty_audio' };
      }
      const objectUrl = URL.createObjectURL(blob);
      return { ok: true, objectUrl };
    }
  }

  /**
   * 将 ReadableStream 的数据流式喂给 MediaSource
   * 边读取边 appendBuffer，实现真正的流式播放
   */
  async function _pumpStreamToMediaSource(readableStream, mediaSource) {
    const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
    const reader = readableStream.getReader();
    let received = 0;

    const pump = async () => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // 流结束，关闭 MediaSource
          if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
          }
          return;
        }
        received += value.length;

        // 等待 sourceBuffer 就绪后追加
        const append = () => {
          try {
            sourceBuffer.appendBuffer(value);
          } catch (e) {
            console.warn('VoicePlayer: appendBuffer error:', e);
            // 如果是 quota 异常或其他错误，尝试结束
            if (mediaSource.readyState === 'open') {
              try { mediaSource.endOfStream('decode'); } catch {}
            }
          }
        };

        if (sourceBuffer.updating) {
          // 等当前追加完成后再追加
          sourceBuffer.addEventListener('updateend', append, { once: true });
        } else {
          append();
        }
      } catch (e) {
        console.warn('VoicePlayer: stream read error:', e);
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream('decode'); } catch {}
        }
      }
    };

    // 监听追加完成事件，继续读取下一块
    sourceBuffer.addEventListener('updateend', () => {
      if (mediaSource.readyState === 'open') {
        pump();
      }
    });

    // 启动第一次读取
    pump();
  }

  /**
   * 流式合成 + 字幕时间戳（混合流协议）
   * 桥接端 /synthesize-with-subtitles 返回二进制分帧流：
   *   每帧: [1字节类型 A/M/E][4字节大端长度][N字节载荷]
   *   A=音频字节 → MediaSource appendBuffer
   *   M=元数据 JSON {offset, duration, text} → 收集到 words 数组
   *   E=结束
   *
   * @returns {Promise<{ok, objectUrl, mediaSource?, words?}>}
   */
  async function _startStreamPlaybackWithSubtitles(text) {
    const base = await _getBridgeUrl();
    const body = {
      text,
      voice: (_settings && _settings.defaultVoice) || 'zh-CN-XiaoxiaoNeural',
      rate: (_settings && _settings.rate) || '+0%',
      pitch: (_settings && _settings.pitch) || '+0Hz',
      volume: (_settings && _settings.volume) || '+0%'
    };

    const resp = await fetch(`${base}/synthesize-with-subtitles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      let err = `http_${resp.status}`;
      try {
        const j = await resp.json();
        if (j && j.error) err = j.error;
      } catch {}
      return { ok: false, error: err };
    }

    // 检查 JSON 错误响应
    const ctype = resp.headers.get('Content-Type') || '';
    if (ctype.includes('application/json')) {
      const j = await resp.json();
      return { ok: false, error: (j && j.error) || 'unknown' };
    }

    const canUseMSE = window.MediaSource && MediaSource.isTypeSupported('audio/mpeg');
    if (!canUseMSE) {
      // 不支持 MediaSource，回退到无字幕模式
      return _startStreamPlayback(text);
    }

    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const words = [];  // WordBoundary 事件收集
    let onWordsReady = null;  // 回调：首批 words 到达时触发

    mediaSource.addEventListener('sourceopen', () => {
      _pumpMixedStreamToMediaSource(resp.body, mediaSource, words, () => {
        // 首批 WordBoundary 事件到达时触发回调
        if (onWordsReady && words.length > 0) {
          onWordsReady(words);
          onWordsReady = null;  // 只触发一次
        }
      });
    }, { once: true });

    return {
      ok: true, objectUrl, mediaSource, words,
      onWordsReady: (cb) => { onWordsReady = cb; }
    };
  }

  /**
   * 解析混合流并喂给 MediaSource + 收集字幕时间戳
   * 混合流分帧: [1字节类型][4字节大端长度][N字节载荷]
   */
  async function _pumpMixedStreamToMediaSource(readableStream, mediaSource, words, onFirstWords) {
    const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
    const reader = readableStream.getReader();

    // 缓冲区：跨 chunk 拼接不完整的帧
    let buffer = new Uint8Array(0);
    let totalAudio = 0;

    // 音频追加队列：避免 appendBuffer 竞态条件
    // 原问题：pump() 不等 updateend 就继续读取，多个 appendBuffer 冲突导致音频损坏
    const _audioQueue = [];
    let _appending = false;
    let _streamEnded = false;

    const _concat = (a, b) => {
      const c = new Uint8Array(a.length + b.length);
      c.set(a, 0);
      c.set(b, a.length);
      return c;
    };

    const _tryParseFrames = () => {
      // 帧头: 1字节类型 + 4字节大端长度 = 5字节
      const frames = [];
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const payloadLen = (buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4];
        const payloadLenU = payloadLen >>> 0;
        const frameTotal = 5 + payloadLenU;
        if (buffer.length < frameTotal) break;  // 不完整，等更多数据

        const payload = buffer.slice(5, 5 + payloadLenU);
        frames.push({ type, payload });
        buffer = buffer.slice(frameTotal);
      }
      return frames;
    };

    /**
     * 将音频数据加入队列，按顺序追加到 sourceBuffer
     * 每次 appendBuffer 必须等上一次的 updateend 事件后才能调用
     */
    const _enqueueAudio = (audioData) => {
      if (!audioData || audioData.length === 0) return;
      _audioQueue.push(audioData);
      _flushAudioQueue();
    };

    const _flushAudioQueue = () => {
      if (_appending) return;
      if (_audioQueue.length === 0) return;
      if (sourceBuffer.updating) return;
      if (mediaSource.readyState !== 'open') return;

      const data = _audioQueue.shift();
      _appending = true;
      try {
        sourceBuffer.appendBuffer(data);
      } catch (e) {
        _appending = false;
        console.warn('VoicePlayer: appendBuffer error:', e);
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream('decode'); } catch {}
        }
      }
    };

    // updateend 事件：上一次 appendBuffer 完成，追加下一段
    sourceBuffer.addEventListener('updateend', () => {
      _appending = false;
      _flushAudioQueue();
      // 如果流已结束且队列清空，关闭 MediaSource
      if (_streamEnded && _audioQueue.length === 0 && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch {}
      }
    });

    const pump = async () => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          _streamEnded = true;
          // 如果队列已空，立即关闭；否则等 updateend 关闭
          if (_audioQueue.length === 0 && !_appending && mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream(); } catch {}
          }
          return;
        }

        // 追加到缓冲区并尝试解析帧
        buffer = _concat(buffer, value);
        const frames = _tryParseFrames();

        let hasEndFrame = false;
        let audioChunks = [];

        for (const f of frames) {
          if (f.type === 'A') {
            audioChunks.push(f.payload);
            totalAudio += f.payload.length;
          } else if (f.type === 'M') {
            try {
              const json = JSON.parse(new TextDecoder().decode(f.payload));
              words.push(json);
              if (onFirstWords && words.length === 1) {
                onFirstWords();
              }
            } catch {}
          } else if (f.type === 'E') {
            hasEndFrame = true;
          }
        }

        // 合并本批音频并加入队列
        if (audioChunks.length > 0) {
          let combined;
          if (audioChunks.length === 1) {
            combined = audioChunks[0];
          } else {
            combined = audioChunks.reduce(_concat);
          }
          _enqueueAudio(combined);
        }

        if (hasEndFrame) {
          _streamEnded = true;
          if (_audioQueue.length === 0 && !_appending && mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream(); } catch {}
          }
          return;
        }

        // 继续读取（不等待 appendBuffer，音频追加由队列管理）
        pump();
      } catch (e) {
        console.warn('VoicePlayer: mixed stream read error:', e);
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream('decode'); } catch {}
        }
      }
    };

    pump();
  }

  /**
   * 将 WordBoundary 事件聚合为显示词组
   * 中文每 3~5 字一组，英文每 2~3 词一组
   * 避免单字滚动太快导致视觉闪烁
   *
   * @param {Array} words - [{offset, duration, text}, ...]
   * @returns {Array} [{startOffset, endOffset, text}, ...]
   */
  function _groupWords(words) {
    if (!words || !words.length) return [];
    const groups = [];
    let curText = '';
    let curStart = 0;
    let curEnd = 0;
    let charCount = 0;
    const TARGET_CHARS = 4;  // 每组目标字/词数

    for (const w of words) {
      if (charCount === 0) {
        curStart = w.offset;
      }
      curText += w.text;
      curEnd = w.offset + w.duration;
      charCount += w.text.length;

      // 达到目标字数或遇到句末标点时断开
      if (charCount >= TARGET_CHARS || /[。！？.!?；;\n]$/.test(w.text)) {
        groups.push({
          startOffset: curStart,
          endOffset: curEnd,
          text: curText
        });
        curText = '';
        charCount = 0;
      }
    }
    // 末尾剩余
    if (charCount > 0) {
      groups.push({ startOffset: curStart, endOffset: curEnd, text: curText });
    }
    return groups;
  }

  /**
   * 直接 fetch 桥接异步合成，返回 taskId + streamUrl
   */
  async function _synthAsyncDirect(text) {
    const base = await _getBridgeUrl();
    const body = {
      text,
      voice: (_settings && _settings.defaultVoice) || 'zh-CN-XiaoxiaoNeural',
      rate: (_settings && _settings.rate) || '+0%',
      pitch: (_settings && _settings.pitch) || '+0Hz',
      volume: (_settings && _settings.volume) || '+0%'
    };
    const resp = await fetch(`${base}/synthesize-async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      return { ok: false, error: data.error || `http_${resp.status}` };
    }
    return { ok: true, taskId: data.taskId, streamUrl: `${base}/stream/${data.taskId}` };
  }

  // ===== 播放某一段 =====
  async function _playChunk(index) {
    if (!_current || index >= _current.chunks.length) {
      // 全部播完
      _cleanupCurrent();
      _current = null;
      hideUI();
      _notifyState();
      return;
    }
    _current.currentIndex = index;
    const chunkText = _current.chunks[index].text || _current.chunks[index];
    const isLast = (index === _current.chunks.length - 1);

    // 预处理当前 chunk 的句子，用于实时滚动高亮（作为字幕时间戳的回退方案）
    _current.sentences = _splitSentences(chunkText);
    _current.totalChars = chunkText.length;
    _current.activeSentenceIdx = -1;
    _current.wordGroups = null;  // 清除上一段的字幕数据
    _renderLyrics(_current.sentences);

    // 单段直接走同步合成（即使是长文章，每段也较短）
    // 但若当前段 > threshold，用异步
    const threshold = (_settings && _settings.asyncThreshold) || 3000;
    const useAsync = chunkText.length > threshold;

    _setStatus(_t('voiceSynthesizing', '正在合成') + ` (${index + 1}/${_current.chunks.length})...`);

    try {
      _releaseObjectUrl();

      // 清除上一段的字幕数据
      _current.words = null;

      if (useAsync) {
        // 异步合成：拿到 streamUrl，<audio> 直接流式播放
        // 注意：异步模式不支持字幕时间戳，回退到句子级估算
        const result = await _synthAsyncDirect(chunkText);
        if (!result.ok) {
          throw new Error(result.error || 'synth_failed');
        }
        _current.taskId = result.taskId;
        _current.objectUrl = null;
        _current.mediaSource = null;
        _audio.src = result.streamUrl;
      } else {
        // 同步合成 + 字幕时间戳：流式播放（MediaSource 边接收边播放）
        // 优先尝试带字幕的端点，失败回退到普通流式
        let result = await _startStreamPlaybackWithSubtitles(chunkText);
        if (!result.ok) {
          // 回退到无字幕模式
          result = await _startStreamPlayback(chunkText);
        }
        if (!result.ok) {
          throw new Error(result.error || 'synth_failed');
        }
        _current.taskId = null;
        _current.objectUrl = result.objectUrl;
        _current.mediaSource = result.mediaSource || null;

        if (result.words) {
          // 带字幕模式：words 数组在流式传输过程中逐步填充
          // RAF 循环中的 _updateLyricsPosition 会检测 words.length 变化，
          // 自动重新聚合 wordGroups 并增量渲染，无需手动管理时机
          _current.words = result.words;
          _current._lastWordsLen = 0;  // 触发首次聚合
        }
        _audio.src = result.objectUrl;
      }
      _audio.load();

      _setStatus(_current.title || _t('voiceReading', '朗读中'));

      // 预合成下一段（仅对异步模式有意义）
      if (!isLast && _settings && _settings.preferAsync !== false) {
        _prefetchNext(index + 1);
      }

      // 首次播放时初始化音频分析器（必须在用户交互后）
      _initAudioAnalyser();

      await _audio.play().catch(e => {
        console.warn('VoicePlayer: play() failed:', e);
      });
      _notifyState();
    } catch (e) {
      _toast(_t('voiceSynthFailed', '语音合成失败') + ': ' + (e.message || e), 'error');
      // 失败时跳过本段继续
      if (!isLast) {
        await _playChunk(index + 1);
      } else {
        stop();
      }
    }
  }

  /**
   * 预合成下一段（仅异步模式有意义）
   * 提前发请求让桥接合成，播放时直接用 streamUrl
   */
  async function _prefetchNext(nextIndex) {
    if (!_current || nextIndex >= _current.chunks.length) return;
    const nextText = _current.chunks[nextIndex].text || _current.chunks[nextIndex];
    if (nextText.length <= ((_settings && _settings.asyncThreshold) || 3000)) {
      // 短文本无需预合成（同步合成本身就快）
      return;
    }
    try {
      const result = await _synthAsyncDirect(nextText);
      if (result.ok) {
        _prefetchTaskId = result.taskId;
      }
    } catch {}
  }

  // ===== 事件处理 =====
  // 注意：歌词实时滚动由 _startLyricsLoop (RAF 60fps) 驱动，
  //       _onTimeUpdate 仅负责进度条和时间显示
  function _onTimeUpdate() {
    if (!_ui || !_audio) return;
    const cur = _audio.currentTime || 0;
    const dur = _getEffectiveDuration();
    const fill = _ui.querySelector('.voice-player__progress-fill');
    if (fill && dur > 0) {
      fill.style.width = (Math.min(1, cur / dur) * 100) + '%';
    }
    _ui.querySelector('.voice-player__cur').textContent = _fmtTime(cur);
    _ui.querySelector('.voice-player__dur').textContent = _fmtTime(dur);
  }

  function _onPlayPause() {
    if (!_ui) return;
    const btn = _ui.querySelector('.voice-player__play');
    if (!btn) return;
    const waveform = _ui.querySelector('.voice-player__waveform');
    if (_audio.paused) {
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5v14l11-7z"/></svg>';
      btn.classList.add('voice-player__play--play');
      btn.classList.remove('voice-player__play--pause');
      _stopWaveform();  // 暂停时停止波形动画
      _stopLyricsLoop();  // 暂停时停止歌词滚动
      if (waveform) waveform.classList.remove('voice-player__waveform--active');
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
      btn.classList.add('voice-player__play--pause');
      btn.classList.remove('voice-player__play--play');
      // 确保 AudioContext 已恢复（浏览器自动挂起时需手动恢复）
      if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(() => {});
      }
      _startWaveform();  // 播放时启动波形动画
      _startLyricsLoop();  // 播放时启动歌词实时滚动
      if (waveform) waveform.classList.add('voice-player__waveform--active');
    }
    _notifyState();
  }

  async function _onEnded() {
    if (!_current) return;
    _stopLyricsLoop();  // 片段结束时停止歌词滚动（下一片段播放时会重新启动）
    const next = _current.currentIndex + 1;
    if (next < _current.chunks.length) {
      // 清理当前段的 taskId
      if (_current.taskId) {
        chrome.runtime.sendMessage({ action: 'voiceClearTask', taskId: _current.taskId }).catch(() => {});
        _current.taskId = null;
      }
      // 若下一段已预合成，直接用预合成的 taskId
      if (_prefetchTaskId) {
        // 检查预合成任务是否对应下一段文本（这里简化：只用一次预合成）
        _current.taskId = _prefetchTaskId;
        _prefetchTaskId = null;
      }
      await _playChunk(next);
    } else {
      _cleanupCurrent();
      _current = null;
      hideUI();
      _notifyState();
    }
  }

  function _onError(e) {
    console.warn('VoicePlayer: audio error:', e);
    if (_current && _current.currentIndex < _current.chunks.length - 1) {
      // 跳过本段
      _onEnded();
    }
  }

  // ===== 工具 =====
  function _fmtTime(sec) {
    if (!sec || !isFinite(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function _setTitle(title) {
    if (!_ui) return;
    const el = _ui.querySelector('.voice-player__title');
    if (el) el.textContent = title || _t('voiceReading', '朗读中');
  }

  function _setStatus(text) {
    if (!_ui) return;
    const el = _ui.querySelector('.voice-player__title');
    if (el) el.textContent = text;
  }

  function _releaseObjectUrl() {
    if (!_current) return;

    // 先清理 MediaSource
    if (_current.mediaSource) {
      try {
        if (_current.mediaSource.readyState === 'open') {
          _current.mediaSource.endOfStream();
        }
      } catch {}
      // revokeObjectURL 会自动断开 MediaSource 与 audio 的连接
      _current.mediaSource = null;
    }

    // 再释放 objectUrl
    if (_current.objectUrl) {
      try { URL.revokeObjectURL(_current.objectUrl); } catch {}
      _current.objectUrl = null;
    }
  }

  async function _clearTaskDirect(taskId) {
    if (!taskId) return;
    try {
      const base = await _getBridgeUrl();
      await fetch(`${base}/task/${taskId}`, { method: 'DELETE' });
    } catch {}
  }

  function _cleanupCurrent() {
    if (!_current) return;
    _releaseObjectUrl();
    if (_current.taskId) {
      _clearTaskDirect(_current.taskId);
    }
    if (_prefetchTaskId) {
      _clearTaskDirect(_prefetchTaskId);
      _prefetchTaskId = null;
    }
    _current.taskId = null;
  }

  function _toast(msg, type) {
    if (typeof global.showToast === 'function') {
      global.showToast(msg, type || 'info');
    } else {
      console.log(`[Voice] ${msg}`);
    }
  }

  // ===== 导出 =====
  global.VoicePlayer = {
    init,
    playFromUrl,
    playFromText,
    togglePlay,
    stop,
    seek,
    setRate,
    isPlaying,
    getState,
    onStateChange,
    showUI,
    hideUI,
    checkBridge
  };
})(window);
