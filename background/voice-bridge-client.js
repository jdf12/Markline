// background/voice-bridge-client.js
// 语音合成桥接客户端
// - 通过 fetch 调用本地 voice_bridge.py（127.0.0.1:7822）
// - 同步合成：返回 Blob，供页面用 URL.createObjectURL 播放
// - 异步合成：返回 taskId，页面用 <audio src="http://127.0.0.1:PORT/stream/taskId"> 播放
// - 语音列表带内存缓存，避免每次都打桥接
//
// 依赖：VoiceStore (shared/voice-store.js)
//
// 暴露（通过 self.VoiceBridgeClient）：
//   checkHealth()                      → { ok, running, version }
//   listVoices(locale?)                → { ok, voices: [...] }
//   synthesizeSync(payload)            → { ok, blob } | { ok:false, error }
//   startAsyncSynth(payload)           → { ok, taskId } | { ok:false, error }
//   getStreamUrl(taskId)               → string (页面 <audio> 直接用)
//   clearTask(taskId)                  → { ok }
//   DEFAULT_VOICE

(function (global) {
  'use strict';

  const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

  // 健康检查 3 秒超时（快速失败）
  const HEALTH_TIMEOUT_MS = 3000;
  // 同步合成 60 秒超时（短文本不应超时，但保留兜底）
  const SYNC_TIMEOUT_MS = 60000;
  // 异步合成的 taskId 创建请求 10 秒超时
  const ASYNC_INIT_TIMEOUT_MS = 10000;

  let _cachedVoices = null;        // 内存缓存：[{ ShortName, ... }]
  let _cachedVoicesAt = 0;
  const VOICES_CACHE_TTL = 3600000; // 1 小时

  async function _getBaseUrl() {
    const settings = await VoiceStore.getSettings();
    return VoiceStore.getBridgeBaseUrl(settings.bridgePort);
  }

  /**
   * 检测桥接是否运行
   */
  async function checkHealth() {
    try {
      const base = await _getBaseUrl();
      const resp = await fetch(`${base}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      if (!resp.ok) return { ok: false, running: false };
      const data = await resp.json();
      return { ok: true, running: true, version: data.version };
    } catch (e) {
      return { ok: false, running: false, error: String(e && e.message || e) };
    }
  }

  /**
   * 获取语音列表（带内存缓存）
   * @param {string} locale  可选，如 'zh-CN'
   */
  async function listVoices(locale) {
    // 缓存命中
    const now = Date.now();
    if (_cachedVoices && (now - _cachedVoicesAt) < VOICES_CACHE_TTL) {
      return _filterVoicesByLocale(_cachedVoices, locale);
    }
    try {
      const base = await _getBaseUrl();
      const resp = await fetch(`${base}/voices?locale=${encodeURIComponent(locale || '')}`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      if (!resp.ok) return { ok: false, error: 'bridge_http_error', status: resp.status };
      const data = await resp.json();
      if (!data.ok) return { ok: false, error: data.error || 'unknown' };
      _cachedVoices = data.voices || [];
      _cachedVoicesAt = now;
      return { ok: true, voices: _filterVoicesByLocale(_cachedVoices, locale) };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  function _filterVoicesByLocale(voices, locale) {
    if (!locale) return voices;
    return voices.filter(v => v.Locale && v.Locale.toLowerCase().startsWith(locale.toLowerCase()));
  }

  /**
   * 同步合成（短文本，< asyncThreshold）
   * @param {Object} payload  { text, voice?, rate?, pitch?, volume? }
   * @returns { ok: true, blob } | { ok:false, error }
   */
  async function synthesizeSync(payload) {
    const text = (payload && payload.text) || '';
    if (!text) return { ok: false, error: 'empty_text' };

    const settings = await VoiceStore.getSettings();
    const body = {
      text,
      voice: (payload && payload.voice) || settings.defaultVoice || DEFAULT_VOICE,
      rate: (payload && payload.rate) || settings.rate || '+0%',
      pitch: (payload && payload.pitch) || settings.pitch || '+0Hz',
      volume: (payload && payload.volume) || settings.volume || '+0%'
    };

    try {
      const base = await _getBaseUrl();
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
      const resp = await fetch(`${base}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(tid);

      if (!resp.ok) {
        let err = `http_${resp.status}`;
        try {
          const j = await resp.json();
          if (j && j.error) err = j.error;
        } catch {}
        return { ok: false, error: err };
      }

      // 检查响应类型：流式 audio/mpeg 或 JSON 错误
      const ctype = resp.headers.get('Content-Type') || '';
      if (ctype.includes('application/json')) {
        // 桥接返回了 JSON（可能是错误）
        const j = await resp.json();
        return { ok: false, error: (j && j.error) || 'unknown' };
      }

      const blob = await resp.blob();
      return { ok: true, blob, size: blob.size };
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'AbortError') return { ok: false, error: 'timeout' };
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /**
   * 异步合成长文本（> asyncThreshold）
   * @param {Object} payload  { text, voice?, rate?, pitch?, volume? }
   * @returns { ok: true, taskId } | { ok:false, error }
   */
  async function startAsyncSynth(payload) {
    const text = (payload && payload.text) || '';
    if (!text) return { ok: false, error: 'empty_text' };

    const settings = await VoiceStore.getSettings();
    const body = {
      text,
      voice: (payload && payload.voice) || settings.defaultVoice || DEFAULT_VOICE,
      rate: (payload && payload.rate) || settings.rate || '+0%',
      pitch: (payload && payload.pitch) || settings.pitch || '+0Hz',
      volume: (payload && payload.volume) || settings.volume || '+0%'
    };

    try {
      const base = await _getBaseUrl();
      const resp = await fetch(`${base}/synthesize-async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ASYNC_INIT_TIMEOUT_MS)
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        return { ok: false, error: data.error || `http_${resp.status}` };
      }
      return { ok: true, taskId: data.taskId };
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'AbortError') return { ok: false, error: 'timeout' };
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /**
   * 构造流式播放 URL（页面 <audio> 元素直接用）
   */
  async function getStreamUrl(taskId) {
    const base = await _getBaseUrl();
    return `${base}/stream/${taskId}`;
  }

  /**
   * 清理任务
   */
  async function clearTask(taskId) {
    if (!taskId) return { ok: false, error: 'no_task_id' };
    try {
      const base = await _getBaseUrl();
      const resp = await fetch(`${base}/task/${taskId}`, { method: 'DELETE' });
      // 不强求成功，桥接侧 30 分钟也会自动清理
      return { ok: resp.ok };
    } catch {
      return { ok: false };
    }
  }

  global.VoiceBridgeClient = {
    DEFAULT_VOICE,
    checkHealth,
    listVoices,
    synthesizeSync,
    startAsyncSynth,
    getStreamUrl,
    clearTask
  };
})(self);
