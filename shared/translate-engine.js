// shared/translate-engine.js
// 网页翻译业务层
// - 复用 ai-tagger.js 的 resolveProvider / _doFetch / 并发锁（_acquireAISlot）
// - 提供 AI 翻译 / Google Translate 两种引擎
// - 批量段落翻译、单段翻译、智能摘要、脑图生成、智能问答
// - 自动应用词汇本（glossary）注入 prompt
// - 缓存查询由调用方（translate-channel.js）控制，本层只负责 Prompt 构建与解析
//
// 翻译机制（参考沉浸式翻译 immersive-translate）：
//   - 段落分隔符：\n\n%%\n\n（多段拼接为单次请求，响应按 %% 拆分）
//   - HTML 占位符保护：{0}{1} 替换法，避免 AI 改写标签
//   - AI 批量大小：4 段/批（避免 token 超限）
//   - 流式输出：stream:true，SSE 解析
//   - 请求间隔限流：AI 1000ms / Google 200ms
//   - 上下文注入：页面标题 + 词汇本（含 context）
//   - 划词字典增强：单词返回字典 JSON，句子返回纯译文
//   - 错误回复过滤：ignoreResRegexs / removeResRegexs
//
// 依赖（需先 importScripts）：
//   shared/ai-tagger.js   → resolveProvider, _doFetch, _acquireAISlot, getAIConfig
//   shared/translate-store.js → translateStore
// 暴露：self.translateEngine = {...}

(function (global) {
  'use strict';

  // ===== 语言代码显示名（用于 prompt）=====
  const LANG_NAMES = {
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'fr': 'French',
    'de': 'German',
    'es': 'Spanish',
    'ru': 'Russian'
  };

  function _langName(code) {
    return LANG_NAMES[code] || code;
  }

  // ===== 多段分隔符（参考沉浸式翻译 translationTextSeparator）=====
  const PARAGRAPH_SEPARATOR = '\n\n%%\n\n';

  // ===== AI 回复过滤正则（参考沉浸式翻译 ignoreResRegexs / removeResRegexs）=====
  // 命中后整段丢弃（AI 拒绝回复）
  const IGNORE_RES_REGEXS = [
    /^抱歉.*要求/i, /^抱歉.*请求/i, /^抱歉.*翻译/i, /^很抱歉.*翻译/i,
    /^我很抱歉.*翻译/i, /^对不起，我无法直接翻译/i, /^抱歉.*我无法/i,
    /^I'm sorry, but I cannot/i, /^I'm sorry, but I cannot provide/i,
    /^I'm sorry, I can't assist with that/i,
    /^这句话的内容不适合在此平台上讨论/, /^这句话不适合在公共场合讨论/,
    /地道的翻译引擎，你只返回译文，不含任何解释/
  ];
  // 命中后移除匹配部分（如 <think>...</think> 思考标签）
  const REMOVE_RES_REGEXS = [
    /<think>[\s\S]*?<\/think>/g, /<\/think>/g
  ];

  // ===== 请求间隔限流（参考沉浸式翻译 interval）=====
  // 每次 API 调用前确保距离上次调用至少 interval ms
  // AI 2000ms（保守，免费用户友好）；Google 200ms（免费端点宽松）
  // 微软 1500ms（0.67 QPS，edge 端点免费层 QPS 限制严格，避免触发 429001 限流）
  const AI_INTERVAL_MS = 2000;
  const GOOGLE_INTERVAL_MS = 200;
  const MICROSOFT_INTERVAL_MS = 1500;
  let _lastAICallTs = 0;
  let _lastGoogleCallTs = 0;
  let _lastMicrosoftCallTs = 0;
  // 串行锁：确保 _throttle + _markCall 原子执行，避免并发请求同时通过限流检查
  let _aiThrottlePromise = Promise.resolve();
  let _msThrottlePromise = Promise.resolve();

  // 串行化 AI 限流：每次调用排队等待，确保间隔
  function _throttleAITask() {
    const prev = _aiThrottlePromise;
    let resolve;
    _aiThrottlePromise = new Promise(r => { resolve = r; });
    return prev.then(async () => {
      const elapsed = Date.now() - _lastAICallTs;
      if (elapsed < AI_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, AI_INTERVAL_MS - elapsed));
      }
      _lastAICallTs = Date.now();
      resolve();
    });
  }

  // 串行化微软限流：每次调用排队等待，确保间隔
  function _throttleMicrosoftTask() {
    const prev = _msThrottlePromise;
    let resolve;
    _msThrottlePromise = new Promise(r => { resolve = r; });
    return prev.then(async () => {
      const elapsed = Date.now() - _lastMicrosoftCallTs;
      if (elapsed < MICROSOFT_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MICROSOFT_INTERVAL_MS - elapsed));
      }
      _lastMicrosoftCallTs = Date.now();
      resolve();
    });
  }

  function _throttle(engine) {
    if (engine === 'google') {
      const elapsed = Date.now() - _lastGoogleCallTs;
      if (elapsed < GOOGLE_INTERVAL_MS) {
        return new Promise(resolve => setTimeout(resolve, GOOGLE_INTERVAL_MS - elapsed));
      }
      return Promise.resolve();
    }
    if (engine === 'microsoft') {
      return _throttleMicrosoftTask();
    }
    return _throttleAITask();
  }

  function _markCall(engine) {
    // AI 的 _markCall 已在 _throttleAITask 内完成（原子），微软同理在 _throttleMicrosoftTask 内完成
    // 这里仅处理 Google
    if (engine === 'google') _lastGoogleCallTs = Date.now();
  }

  // ===== 解析 AI 配置（reuse 模式复用 ai_classifier_config，custom 模式用 translate_config.aiConfig）=====
  async function _resolveAIConfig(translateConfig) {
    if (translateConfig.aiMode === 'custom' && translateConfig.aiConfig) {
      return translateConfig.aiConfig;
    }
    if (typeof getAIConfig === 'function') {
      return await getAIConfig();
    }
    return null;
  }

  // ===== 构建 LLM 请求体（支持 system+user 双消息 + stream）=====
  // 本层独立构造 body，不依赖 ai-tagger.js 的 buildBody（其仅支持单 user 消息）
  function _buildLLMBody(format, systemPrompt, userPrompt, model, options = {}) {
    const stream = options.stream === true;
    if (format === 'anthropic') {
      const body = {
        model,
        max_tokens: options.maxTokens || 4096,
        messages: [{ role: 'user', content: userPrompt }]
      };
      if (systemPrompt) body.system = systemPrompt;
      if (stream) body.stream = true;
      return body;
    }
    if (format === 'google') {
      // Gemini: system instruction 字段 + contents
      const body = {
        contents: [{ parts: [{ text: userPrompt }] }]
      };
      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
      if (stream) {
        // Gemini 流式通过 alt=sse 查询参数，body 不变
      }
      return body;
    }
    // 默认 OpenAI Chat Completions 兼容格式
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
    const body = {
      model,
      messages,
      temperature: 0.2
    };
    if (stream) body.stream = true;
    return body;
  }

  // ===== 构建流式请求的 URL（Gemini 需要 alt=sse）=====
  function _buildStreamEndpoint(endpoint, format, stream) {
    if (!stream) return endpoint;
    if (format === 'google') {
      return endpoint + (endpoint.includes('?') ? '&' : '?') + 'alt=sse';
    }
    return endpoint;
  }

  // ===== 流式 SSE 解析（OpenAI / Anthropic / Gemini 三种格式）=====
  // onChunk(chunkText): 每收到一个文本 chunk 实时回调（用于增量渲染）
  async function _parseSSEStream(resp, format, model, onChunk) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let anthropicBlock = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          let chunk = '';
          if (format === 'anthropic') {
            if (json.type === 'content_block_start') {
              anthropicBlock = json.index;
            } else if (json.type === 'content_block_delta' && json.delta?.text) {
              chunk = json.delta.text;
            }
          } else if (format === 'google') {
            chunk = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          } else {
            chunk = json.choices?.[0]?.delta?.content || '';
          }
          if (chunk) {
            fullText += chunk;
            if (onChunk) onChunk(chunk);
          }
        } catch {}
      }
    }
    return { ok: true, raw: fullText, model };
  }

  // ===== 通用 LLM 调用（支持流式 + 非流式 + 429 指数退避重试）=====
  // 429/5xx/网络错误时自动重试（最多 2 次），指数退避 3s/6s
  // 429 时优先读取 Retry-After 响应头（仅流式模式可用），按服务器要求等待
  // opts.onRetry(attempt, waitMs, reason): 重试回调（用于状态栏提示）
  async function _callLLM(aiConfig, systemPrompt, userPrompt, opts = {}) {
    if (!aiConfig || !aiConfig.enabled || !aiConfig.apiKey) {
      return { ok: false, error: 'AI_NOT_ENABLED' };
    }
    const resolved = (typeof resolveProvider === 'function') ? resolveProvider(aiConfig) : null;
    if (!resolved) return { ok: false, error: 'INVALID_PROVIDER' };

    const format = _getProviderFormat(aiConfig);
    if (!format) return { ok: false, error: 'UNKNOWN_FORMAT' };

    const useStream = opts.stream === true;
    const body = _buildLLMBody(format, systemPrompt, userPrompt, resolved.model, {
      stream: useStream,
      maxTokens: opts.maxTokens
    });
    const endpoint = _buildStreamEndpoint(resolved.endpoint, format, useStream);
    const timeoutMs = Math.max(3000, ((opts.timeout || aiConfig.timeout || 8)) * 1000);

    const MAX_RETRIES = 2;
    // 退避基数 3000ms（适配 Agnes 免费层 QPS 限制，给限流窗口更多恢复时间）
    // 实际等待 = BASE_BACKOFF_MS * 2^attempt（3s / 6s），429 时优先用 Retry-After 头
    const BASE_BACKOFF_MS = 3000;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // 限流等待
      await _throttle('ai');
      _markCall('ai');

      const release = (typeof _acquireAISlot === 'function') ? await _acquireAISlot() : null;
      try {
        const result = await _doSingleCall(resolved, format, endpoint, body, aiConfig.apiKey, useStream, timeoutMs, opts);
        if (result.ok) {
          result.latency = Date.now() - startTime;
          return result;
        }

        // 判断是否可重试（429/5xx/网络错误）
        const errStr = String(result.error || '');
        const isRateLimit = /429|rate\s*limit|too\s*many/i.test(errStr);
        const isServerErr = /HTTP\s*5\d\d/.test(errStr);
        const isNetworkErr = result.error === 'TIMEOUT' || /fetch|network|ECONNRESET/i.test(errStr);
        const canRetry = (isRateLimit || isServerErr || isNetworkErr) && attempt < MAX_RETRIES;

        if (canRetry) {
          // 退避策略：429 时优先用 Retry-After 头（服务器明确要求），否则指数退避 3s / 6s
          let waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          if (isRateLimit && result.retryAfterMs) {
            waitMs = Math.max(waitMs, result.retryAfterMs);
          }
          const reason = isRateLimit ? 'rate_limit' : (isServerErr ? 'server_error' : 'network_error');
          if (opts.onRetry) opts.onRetry(attempt + 1, waitMs, reason);
          await new Promise(r => setTimeout(r, waitMs));
          continue; // 重试
        }

        // 不可重试或重试次数用尽
        result.latency = Date.now() - startTime;
        return result;
      } catch (err) {
        const isTimeout = err.name === 'AbortError';
        const errMsg = isTimeout ? 'TIMEOUT' : (err.message || 'UNKNOWN');
        const canRetry = (isTimeout || /fetch|network/i.test(errMsg)) && attempt < MAX_RETRIES;
        if (canRetry) {
          const waitMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          if (opts.onRetry) opts.onRetry(attempt + 1, waitMs, 'network_error');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { ok: false, error: errMsg, latency: Date.now() - startTime };
      } finally {
        if (release) release();
      }
    }
    return { ok: false, error: 'MAX_RETRIES_EXCEEDED', latency: Date.now() - startTime };
  }

  // ===== 单次 LLM 调用（不含重试逻辑）=====
  // 429 时返回 retryAfter（秒），供上层按服务器要求等待
  async function _doSingleCall(resolved, format, endpoint, body, apiKey, useStream, timeoutMs, opts) {
    if (useStream) {
      // 流式调用
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...resolved.buildHeaders(apiKey) },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        console.log('[TranslateEngine] stream POST sent, model=%s, stream=true, body.tokens≈%d', resolved.model, (JSON.stringify(body).length / 4) | 0);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          const result = { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
          // 429 时优先读取 Retry-After 头（秒数或 HTTP date）
          if (resp.status === 429) {
            const retryAfter = resp.headers.get('Retry-After');
            if (retryAfter) {
              if (/^\d+$/.test(retryAfter)) {
                result.retryAfterMs = parseInt(retryAfter, 10) * 1000;
              } else {
                const date = new Date(retryAfter).getTime();
                if (!isNaN(date)) result.retryAfterMs = Math.max(0, date - Date.now());
              }
            }
          }
          return result;
        }
        const result = await _parseSSEStream(resp, format, resolved.model, opts.onChunk);
        return { ok: true, raw: result.raw, model: resolved.model };
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      // 非流式调用（复用 ai-tagger 的 _doFetch，无法读取响应头，429 时使用默认退避）
      const { ok, status, text } = await _doFetch(
        resolved.endpoint,
        resolved.buildHeaders(apiKey),
        body,
        timeoutMs
      );
      if (!ok) {
        return { ok: false, error: `HTTP ${status}: ${text.slice(0, 200)}` };
      }
      let json;
      try { json = JSON.parse(text); } catch { return { ok: false, error: 'INVALID_JSON' }; }
      const raw = resolved.parseResponse(json);
      return { ok: true, raw, model: json.model || resolved.model };
    }
  }

  // ===== 从 AI_PROVIDERS 推断 format（openai/anthropic/google）=====
  function _getProviderFormat(aiConfig) {
    if (typeof AI_PROVIDERS === 'undefined') return 'openai';
    const providerDef = AI_PROVIDERS[aiConfig.provider];
    if (!providerDef) return aiConfig.customFormat || 'openai';
    return providerDef.format || 'openai';
  }

  // ===== AI 回复过滤（ignoreResRegexs / removeResRegexs）=====
  function _filterAIResponse(raw) {
    if (!raw) return '';
    let text = String(raw);
    // 1. 移除匹配部分（如 <think>...</think>）
    for (const re of REMOVE_RES_REGEXS) {
      text = text.replace(re, '');
    }
    text = text.trim();
    if (!text) return '';
    // 2. 整段丢弃检查（AI 拒绝回复）
    for (const re of IGNORE_RES_REGEXS) {
      if (re.test(text)) return '';
    }
    return text;
  }

  // ===== HTML 占位符保护（参考沉浸式翻译 placeholderDelimiters）=====
  // 将文本中的 HTML 标签替换为 {0}{1}... 占位符，避免 AI 改写标签
  function _encodeHtmlPlaceholders(text) {
    const map = [];
    // 匹配 HTML 标签（开标签、闭标签、自闭合）
    const tagRegex = /<\/?[a-zA-Z][^>]*>/g;
    const encoded = text.replace(tagRegex, (match) => {
      const idx = map.length;
      map.push(match);
      return `{${idx}}`;
    });
    return { text: encoded, map };
  }

  function _decodeHtmlPlaceholders(text, map) {
    if (!map || !map.length) return text;
    let decoded = text;
    for (let i = 0; i < map.length; i++) {
      // 替换 {i} 占位符（注意转义大括号）
      decoded = decoded.replace(new RegExp('\\{' + i + '\\}', 'g'), map[i]);
    }
    return decoded;
  }

  // ===== 构建词汇本片段（注入 prompt，含 context）=====
  function _buildGlossarySection(terms) {
    if (!terms || !terms.length) return '';
    const lines = terms
      .filter(t => t.source && t.target)
      .slice(0, 50)
      .map(t => {
        const ctx = t.context ? ` [context: ${t.context}]` : '';
        return `- ${t.source} → ${t.target}${ctx}`;
      });
    if (!lines.length) return '';
    return `\n\nRequired Terminology (apply strictly, override other translation logic):\n${lines.join('\n')}\n`;
  }

  // ===== 构建上下文片段（页面标题，参考沉浸式翻译 title_prompt）=====
  function _buildContextSection(pageTitle) {
    if (!pageTitle) return '';
    return `\n\n## Context Awareness\nDocument Title: ${pageTitle.slice(0, 200)}`;
  }

  // ===== 批量段落翻译 System Prompt（参考沉浸式翻译 ai.systemPrompt）=====
  // sourceLang: 'auto' 时不指定源语言；其他值时显式声明以提升翻译质量与稳定性
  function buildBatchSystemPrompt(targetLang, glossaryTerms, pageTitle, sourceLang) {
    const termsPrompt = _buildGlossarySection(glossaryTerms);
    const contextPrompt = _buildContextSection(pageTitle);
    const fromClause = (sourceLang && sourceLang !== 'auto')
      ? `Translate from ${_langName(sourceLang)} into ${_langName(targetLang)}.`
      : `Translate into ${_langName(targetLang)}.`;
    return `You are a professional ${_langName(targetLang)} native translator who needs to fluently translate text into ${_langName(targetLang)}.

## Task
${fromClause}

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output${contextPrompt}${termsPrompt}

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations

## Examples
### Multi-paragraph Input:
Paragraph A

%% 

Paragraph B

### Multi-paragraph Output:
Translation A

%% 

Translation B`;
  }

  // ===== 批量段落翻译 User Prompt（多段用 %% 拼接）=====
  function buildBatchUserPrompt(texts) {
    if (texts.length === 1) {
      return `Translate to target language (output translation only):\n\n${texts[0]}`;
    }
    return `Translate to target language:\n\n${texts.join(PARAGRAPH_SEPARATOR)}`;
  }

  // ===== 单段翻译 Prompt（向后兼容，保留旧接口）=====
  function buildSingleTranslationPrompt(text, targetLang, glossaryTerms) {
    const glossary = _buildGlossarySection(glossaryTerms);
    return `Translate the following text to ${_langName(targetLang)}.${glossary}
Return ONLY the translated text, no explanation, no quotes, no markdown fences:

${text}`;
  }

  // ===== 划词翻译 Prompt（带上下文 + 字典增强）=====
  // 单词（≤2词且无标点）返回字典 JSON，句子返回纯译文
  function buildSelectionPrompt(text, contextBefore, contextAfter, targetLang, sourceLang) {
    const isWord = _isSingleWord(text);
    let ctx = '';
    if (contextBefore) ctx += `Context before: ...${contextBefore.slice(-200)}\n`;
    if (contextAfter) ctx += `Context after: ${contextAfter.slice(0, 200)}...\n`;

    if (isWord) {
      // 字典模式（参考沉浸式翻译 selectionSystemPrompt）
      const from = sourceLang || 'auto';
      return `# Role Definition
You are a professional multilingual translation engine translating from ${from} into ${_langName(targetLang)}.

# Core Capabilities
1. Input Type Recognition: Single word input → Provide dictionary functions
2. Context Analysis:
【Current Context】: "${ctx || 'No context'}"

# Translation Rules
1. For word input:
   - Return complete dictionary information
   - Group definitions by part of speech (use ${_langName(targetLang)} language)
   - Provide contextual analysis
   - Include natural context examples
2. Format Specifications:
   - Strictly follow example JSON structure
   - No Markdown code blocks
   - The "phonetic" field must describe the pronunciation of the source word

# Output Example (Word):
{
  "phonetic": "/həˈloʊ/",
  "definitions": [
    {
      "pos": "adj.",
      "meaning": "hello",
      "example": {
        "source": "Hello, how are you",
        "target": "你好啊，最近怎么样"
      }
    }
  ],
  "translation": "你好",
  "contextual_analysis": "Analysis of the word's meaning within the provided context"
}

# Strict Prohibitions
- Unrequested additional information
- Language system mixing

Word to translate: ${text}`;
    }
    // 句子模式
    return `Translate the selected text to ${_langName(targetLang)}.
${ctx}
Return ONLY the translated text, no explanation:

Selected: ${text}`;
  }

  // ===== 判断是否为单词（用于字典增强）=====
  function _isSingleWord(text) {
    const t = (text || '').trim();
    if (!t) return false;
    // 含标点（除连字符和撇号）视为句子
    if (/[.,;:!?()。；：！？]/.test(t)) return false;
    // 单词数 ≤ 2 且总长 ≤ 30
    const words = t.split(/\s+/);
    return words.length <= 2 && t.length <= 30;
  }

  // ===== 智能摘要 Prompt =====
  function buildSummaryPrompt(content, opts) {
    const lengthDesc = { short: 'concise (around 100 words)', medium: 'medium (around 200-300 words)', long: 'detailed (around 400-500 words)' }[opts.length || 'medium'];
    const lang = opts.lang === 'follow' ? _langName(opts.targetLang) : (opts.lang === 'original' ? 'the same language as the content' : _langName(opts.targetLang));
    const maxKP = opts.maxKeyPoints || 5;
    return `Read the following webpage content and generate a ${lengthDesc} summary in ${lang}.

Return JSON only, no markdown fences:
{
  "summary": "the summary text",
  "keyPoints": ["key point 1", "key point 2", ...],
  "tags": ["tag1", "tag2", ...]
}

Constraints:
- keyPoints: at most ${maxKP} items, each ≤ 30 chars
- tags: 3-5 topic tags

Content:
${content.slice(0, 12000)}`;
  }

  // ===== 脑图生成 Prompt =====
  function buildMindmapPrompt(content, opts) {
    const lang = _langName(opts.targetLang);
    const maxDepth = opts.maxDepth || 3;
    return `Analyze the following content and generate a hierarchical mind map in ${lang}.

Return JSON only, no markdown fences:
{
  "title": "central topic (≤ 20 chars)",
  "children": [
    {
      "title": "branch title (≤ 20 chars)",
      "children": [
        { "title": "sub-branch", "children": [...] }
      ]
    }
  ]
}

Constraints:
- Max depth: ${maxDepth} levels
- Each node title ≤ 20 chars
- 3-7 children per node
- Capture the main structure, not details

Content:
${content.slice(0, 12000)}`;
  }

  // ===== 智能问答 Prompt =====
  function buildQAPrompt(content, question, targetLang) {
    return `You are an assistant answering questions based on the following webpage content.
Answer in ${_langName(targetLang)}. If the answer is not in the content, say "页面中未找到相关内容".

Content:
${content.slice(0, 12000)}

Question: ${question}`;
  }

  // ===== 解析翻译结果（按 %% 拆分，fallback 到 JSON 数组）=====
  function parseTranslationArray(raw, expectedCount) {
    if (!raw) return null;
    // 1. 先过滤 AI 回复
    let text = _filterAIResponse(raw);
    if (!text) return null;
    // 去除 markdown 代码块
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // 2. 优先按 %% 拆分（沉浸式翻译兼容）
    if (text.includes('%%')) {
      // 按 \n\n%%\n\n 或 \n%%\n 或 %% 拆分
      const parts = text.split(/\n*%%\n*/).map(s => s.trim()).filter(Boolean);
      if (parts.length === expectedCount) {
        return parts.map(String);
      }
      // 数量匹配但有多余，截断；不足，补空
      if (parts.length > 0) {
        while (parts.length < expectedCount) parts.push('');
        return parts.slice(0, expectedCount).map(String);
      }
    }

    // 3. Fallback: JSON 数组解析（向后兼容旧 prompt）
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const arr = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(arr)) {
          while (arr.length < expectedCount) arr.push('');
          return arr.slice(0, expectedCount).map(x => String(x));
        }
      } catch {}
    }

    // 4. Fallback: 按行分割（去除序号前缀）
    const lines = text.split('\n').map(l => l.replace(/^\s*\d+\.\s*/, '').trim()).filter(Boolean);
    if (lines.length >= expectedCount) return lines.slice(0, expectedCount);
    return null;
  }

  function parseTranslationSingle(raw) {
    if (!raw) return '';
    let text = _filterAIResponse(raw);
    if (!text) return '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // 去掉首尾引号
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      try { return JSON.parse(text); } catch { return text.slice(1, -1); }
    }
    return text;
  }

  // ===== 解析字典响应（单词划词翻译）=====
  function parseDictionaryResponse(raw) {
    if (!raw) return null;
    let text = _filterAIResponse(raw);
    if (!text) return null;
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj.translation === 'string') {
          return {
            phonetic: String(obj.phonetic || ''),
            definitions: Array.isArray(obj.definitions) ? obj.definitions.map(d => ({
              pos: String(d.pos || ''),
              meaning: String(d.meaning || ''),
              example: d.example ? { source: String(d.example.source || ''), target: String(d.example.target || '') } : null
            })) : [],
            translation: String(obj.translation),
            contextual_analysis: String(obj.contextual_analysis || '')
          };
        }
      } catch {}
    }
    return null;
  }

  function parseSummary(raw) {
    if (!raw) return null;
    let text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        return {
          summary: String(obj.summary || ''),
          keyPoints: Array.isArray(obj.keyPoints) ? obj.keyPoints.map(String) : [],
          tags: Array.isArray(obj.tags) ? obj.tags.map(String) : []
        };
      } catch {}
    }
    return { summary: text, keyPoints: [], tags: [] };
  }

  function parseMindmap(raw) {
    if (!raw) return null;
    let text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj.title === 'string') return obj;
      } catch {}
    }
    return null;
  }

  // ===== 对外入口：批量段落翻译（AI 引擎）=====
  // 返回 { ok, results:[{idx, translation, cached}], error? }
  // opts: { translateConfig, glossaryTerms, targetLang, sourceLang, pageTitle, stream, onPartial }
  //   onPartial(idx, partialText): 流式时每段译文的局部文本实时回调（已还原 HTML 占位符）
  async function translateBatchAI(texts, opts) {
    const { translateConfig, glossaryTerms, pageTitle, onPartial } = opts;
    const targetLang = opts.targetLang || translateConfig.targetLang || 'zh-CN';
    const sourceLang = opts.sourceLang || translateConfig.sourceLang || 'auto';
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    // HTML 占位符保护
    const encoded = texts.map(t => _encodeHtmlPlaceholders(t));

    const systemPrompt = buildBatchSystemPrompt(targetLang, glossaryTerms, pageTitle, sourceLang);
    const userPrompt = buildBatchUserPrompt(encoded.map(e => e.text));

    // 限流
    await _throttle('ai');
    _markCall('ai');

    const useStream = opts.stream !== false && translateConfig.stream !== false;

    // 流式增量推送：按 %% 拆分 buffer，对每段已完成的 partial 调用 onPartial
    let streamBuffer = '';
    let lastPushedIdx = -1; // 已推送 partial 的最大段索引
    const onChunk = useStream && onPartial ? (chunk) => {
      streamBuffer += chunk;
      // 按 %% 拆分，前面已完成的段落（有 %% 分隔）可以推送 partial
      const parts = streamBuffer.split(/\n*%%\n*/);
      // parts[0..parts.length-2] 是已确定的段落（后面有 %%），parts[最后一项] 是进行中的段落
      for (let i = 0; i < parts.length - 1; i++) {
        if (i > lastPushedIdx && i < texts.length) {
          const decoded = _decodeHtmlPlaceholders(parts[i].trim(), encoded[i].map);
          onPartial(i, decoded);
          lastPushedIdx = i;
        }
      }
      // 推送当前进行中的段落（最后一项）
      const currentIdx = parts.length - 1;
      if (currentIdx < texts.length && parts[currentIdx]) {
        const decoded = _decodeHtmlPlaceholders(parts[currentIdx].trim(), encoded[currentIdx].map);
        onPartial(currentIdx, decoded);
      }
    } : null;

    const result = await _callLLM(aiConfig, systemPrompt, userPrompt, {
      timeout: aiConfig.timeout,
      stream: useStream,
      maxTokens: 4096,
      onChunk,
      onRetry: opts.onRetry
    });
    if (!result.ok) return { ok: false, error: result.error };

    const translations = parseTranslationArray(result.raw, texts.length);
    if (!translations) return { ok: false, error: 'PARSE_FAILED', raw: result.raw };

    // 还原 HTML 占位符（final 结果）
    const finalResults = translations.map((t, i) => {
      const decoded = _decodeHtmlPlaceholders(t, encoded[i].map);
      return { idx: i, translation: decoded, cached: false };
    });

    return {
      ok: true,
      results: finalResults,
      latency: result.latency,
      model: result.model
    };
  }

  // ===== 对外入口：单段翻译（AI 引擎）=====
  async function translateSingleAI(text, opts) {
    const { translateConfig, glossaryTerms } = opts;
    const targetLang = opts.targetLang || translateConfig.targetLang || 'zh-CN';
    const sourceLang = opts.sourceLang || translateConfig.sourceLang || 'auto';
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    // HTML 占位符保护
    const { text: encodedText, map } = _encodeHtmlPlaceholders(text);

    const systemPrompt = buildBatchSystemPrompt(targetLang, glossaryTerms, opts.pageTitle, sourceLang);
    const userPrompt = `Translate to target language (output translation only):\n\n${encodedText}`;

    await _throttle('ai');
    _markCall('ai');

    const result = await _callLLM(aiConfig, systemPrompt, userPrompt, {
      timeout: aiConfig.timeout,
      stream: opts.stream !== false && translateConfig.stream !== false
    });
    if (!result.ok) return { ok: false, error: result.error };

    const raw = parseTranslationSingle(result.raw);
    const decoded = _decodeHtmlPlaceholders(raw, map);
    return { ok: true, translation: decoded, latency: result.latency };
  }

  // ===== 划词翻译（AI 引擎，含字典增强）=====
  async function translateSelectionAI(text, contextBefore, contextAfter, opts) {
    const { translateConfig } = opts;
    const targetLang = opts.targetLang || translateConfig.targetLang || 'zh-CN';
    const sourceLang = opts.sourceLang || 'auto';
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    const isWord = _isSingleWord(text);
    const prompt = buildSelectionPrompt(text, contextBefore, contextAfter, targetLang, sourceLang);

    await _throttle('ai');
    _markCall('ai');

    const result = await _callLLM(aiConfig, null, prompt, {
      timeout: aiConfig.timeout,
      stream: false, // 划词翻译不用流式
      maxTokens: isWord ? 1024 : 2048
    });
    if (!result.ok) return { ok: false, error: result.error };

    // 单词返回字典 JSON，句子返回纯译文
    if (isWord) {
      const dict = parseDictionaryResponse(result.raw);
      if (dict) {
        return { ok: true, translation: dict.translation, dictionary: dict, isWord: true, latency: result.latency };
      }
      // 字典解析失败，降级为纯译文
      return { ok: true, translation: parseTranslationSingle(result.raw), isWord: false, latency: result.latency };
    }
    return { ok: true, translation: parseTranslationSingle(result.raw), isWord: false, latency: result.latency };
  }

  // ===== Google Translate（免费端点，无需 Key）=====
  // sourceLang: 'auto' 自动检测；其他值（如 'en'）显式指定源语言
  async function translateGoogle(texts, targetLang, sourceLang) {
    await _throttle('google');
    _markCall('google');
    // Google 端点：用 \n@@SEP@@\n 分隔多段（Google 会保留换行）
    const SEPARATOR = '\n@@SEP@@\n';
    const joined = texts.join(SEPARATOR);
    const sl = (sourceLang && sourceLang !== 'auto') ? sourceLang : 'auto';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(joined)}`;
    try {
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const data = await resp.json();
      const chunks = (data[0] || []).map(c => c[0] || '').join('');
      const parts = chunks.split(/@@SEP@@/).map(s => s.trim());
      const results = [];
      for (let i = 0; i < texts.length; i++) {
        results.push({ idx: i, translation: parts[i] || '', cached: false });
      }
      return { ok: true, results };
    } catch (err) {
      return { ok: false, error: err.message || 'UNKNOWN' };
    }
  }

  // ===== 微软翻译（Edge 浏览器内置免费端点，需动态 Bearer token）=====
  // 与沉浸式翻译/EdgeTranslate 使用同一通道，无需订阅密钥
  // Token 缓存 8 分钟（官方约 10 分钟过期），过期自动刷新
  let _msToken = null;
  let _msTokenExpireAt = 0;
  async function _getMicrosoftToken() {
    const now = Date.now();
    if (_msToken && now < _msTokenExpireAt) return _msToken;
    const resp = await fetch('https://edge.microsoft.com/translate/auth', {
      method: 'GET'
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`TOKEN_HTTP_${resp.status}: ${text.slice(0, 200)}`);
    }
    const token = (await resp.text()).trim();
    if (!token) throw new Error('TOKEN_EMPTY');
    _msToken = token;
    _msTokenExpireAt = now + 8 * 60 * 1000; // 8 分钟
    return token;
  }

  // 微软语种映射：我们内部用的 code → 微软 code
  // zh-CN → zh-Hans, zh-TW → zh-Hant, 其他保持
  function _msLangCode(lang) {
    if (lang === 'zh-CN') return 'zh-Hans';
    if (lang === 'zh-TW') return 'zh-Hant';
    return lang;
  }

  // texts: string[], 返回 { ok, results: [{idx, translation}], latency } | { ok:false, error }
  // 含 429/429001 限流自动退避重试（最多 2 次，1s/3s）
  // 请求格式对齐沉浸式翻译插件（body 用 { Text: ... }，含完整浏览器 headers 避免 edge 端点限流）
  async function translateMicrosoft(texts, targetLang, sourceLang) {
    if (!Array.isArray(texts) || !texts.length) {
      return { ok: false, error: 'No texts' };
    }
    const startTime = Date.now();
    const to = _msLangCode(targetLang);
    // 沉浸式翻译的 URL 格式：from 留空表示自动检测，includeSentenceLength=true
    const from = (sourceLang && sourceLang !== 'auto') ? _msLangCode(sourceLang) : '';
    const fromParam = from ? `from=${encodeURIComponent(from)}&` : '';
    const url = `https://api-edge.cognitive.microsofttranslator.com/translate?${fromParam}to=${encodeURIComponent(to)}&api-version=3.0&includeSentenceLength=true`;

    const MAX_RETRIES = 2;
    const BASE_BACKOFF_MS = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // 限流：每次调用前确保间隔 500ms（2 QPS），串行化避免并发突破 QPS 限制
      await _throttle('microsoft');

      try {
        const token = await _getMicrosoftToken();
        // body 字段名必须用 Text（首字母大写），沉浸式翻译同款
        const body = JSON.stringify(texts.map(t => ({ Text: t })));
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'accept': '*/*',
            'accept-language': 'zh-TW,zh;q=0.9,ja;q=0.8,zh-CN;q=0.7,en-US;q=0.6,en;q=0.5',
            'authorization': `Bearer ${token}`,
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            'pragma': 'no-cache',
            'sec-ch-ua': '"Microsoft Edge";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'cross-site',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
          },
          body
        });

        if (resp.status === 401) {
          // token 失效，清除缓存重试
          _msToken = null;
          _msTokenExpireAt = 0;
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * Math.pow(3, attempt)));
            continue;
          }
          const text = await resp.text().catch(() => '');
          return { ok: false, error: `MS_AUTH_401: ${text.slice(0, 200)}`, latency: Date.now() - startTime };
        }

        if (resp.status === 429 || !resp.ok) {
          const text = await resp.text().catch(() => '');
          // 429 状态码或限流错误码：退避重试
          const isRateLimit = resp.status === 429 || /429\d{3}|rate\s*limit|too\s*many/i.test(text);
          if (isRateLimit && attempt < MAX_RETRIES) {
            // 指数退避：1s / 3s
            await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * Math.pow(3, attempt)));
            continue;
          }
          return { ok: false, error: `MS_HTTP_${resp.status}: ${text.slice(0, 200)}`, latency: Date.now() - startTime };
        }

        const data = await resp.json();
        // 严格校验响应结构：微软成功响应必须是数组，且长度与请求一致
        // 错误响应形如 { error: { code: 429001, message: "..." } }
        if (!Array.isArray(data)) {
          const errCode = data && data.error && data.error.code;
          const errMsg = (data && data.error && data.error.message)
            ? `${errCode || ''} ${data.error.message}`
            : JSON.stringify(data).slice(0, 200);
          // 429xxx 系列错误码：限流，退避重试
          const isRateLimitCode = (typeof errCode === 'number' && Math.floor(errCode / 1000) === 429)
            || (typeof errCode === 'string' && /429\d{3}/.test(errCode));
          if (isRateLimitCode && attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * Math.pow(3, attempt)));
            continue;
          }
          return { ok: false, error: `MS_RESPONSE_NOT_ARRAY: ${errMsg}`, latency: Date.now() - startTime };
        }
        if (data.length !== texts.length) {
          return { ok: false, error: `MS_LENGTH_MISMATCH: expected ${texts.length}, got ${data.length}`, latency: Date.now() - startTime };
        }
        const results = [];
        for (let i = 0; i < texts.length; i++) {
          const item = data[i] || {};
          // 单段失败时微软会返回 { error: { code, message } } 而非 translations
          if (item.error) {
            results.push({ idx: i, translation: '', cached: false, error: `MS_ITEM_${item.error.code || 'ERR'}` });
            continue;
          }
          const translation = (item.translations && item.translations[0])
            ? item.translations[0].text : '';
          results.push({ idx: i, translation, cached: false });
        }
        return { ok: true, results, latency: Date.now() - startTime };
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * Math.pow(3, attempt)));
          continue;
        }
        return { ok: false, error: err.message || 'UNKNOWN', latency: Date.now() - startTime };
      }
    }
    // 不应到达
    return { ok: false, error: 'MS_UNKNOWN_EXIT', latency: Date.now() - startTime };
  }

  // ===== 智能摘要 =====
  async function generateSummary(content, opts) {
    const { translateConfig } = opts;
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    const promptOpts = {
      length: translateConfig.summary?.length || 'medium',
      lang: translateConfig.summary?.lang || 'follow',
      maxKeyPoints: translateConfig.summary?.maxKeyPoints || 5,
      targetLang: opts.targetLang || translateConfig.targetLang || 'zh-CN'
    };
    const prompt = buildSummaryPrompt(content, promptOpts);
    const result = await _callLLM(aiConfig, null, prompt, { timeout: Math.max(aiConfig.timeout || 8, 20), stream: false });
    if (!result.ok) return { ok: false, error: result.error };

    const parsed = parseSummary(result.raw);
    if (!parsed) return { ok: false, error: 'PARSE_FAILED', raw: result.raw };

    return { ok: true, ...parsed, latency: result.latency };
  }

  // ===== 脑图生成 =====
  async function generateMindmap(content, opts) {
    const { translateConfig } = opts;
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    const promptOpts = {
      maxDepth: translateConfig.mindmap?.maxDepth || 3,
      targetLang: opts.targetLang || translateConfig.targetLang || 'zh-CN'
    };
    const prompt = buildMindmapPrompt(content, promptOpts);
    const result = await _callLLM(aiConfig, null, prompt, { timeout: Math.max(aiConfig.timeout || 8, 25), stream: false });
    if (!result.ok) return { ok: false, error: result.error };

    const parsed = parseMindmap(result.raw);
    if (!parsed) return { ok: false, error: 'PARSE_FAILED', raw: result.raw };

    return { ok: true, mindmap: parsed, latency: result.latency };
  }

  // ===== 智能问答 =====
  async function generateQA(content, question, opts) {
    const { translateConfig } = opts;
    const aiConfig = await _resolveAIConfig(translateConfig);
    if (!aiConfig) return { ok: false, error: 'AI config not available' };

    const targetLang = opts.targetLang || translateConfig.targetLang || 'zh-CN';
    const prompt = buildQAPrompt(content, question, targetLang);
    const result = await _callLLM(aiConfig, null, prompt, { timeout: Math.max(aiConfig.timeout || 8, 20), stream: false });
    if (!result.ok) return { ok: false, error: result.error };

    return { ok: true, answer: parseTranslationSingle(result.raw), latency: result.latency };
  }

  global.translateEngine = {
    translateBatchAI,
    translateSingleAI,
    translateSelectionAI,
    translateGoogle,
    translateMicrosoft,
    generateSummary,
    generateMindmap,
    generateQA,
    // 暴露 prompt 构建与解析（供测试）
    buildBatchSystemPrompt,
    buildBatchUserPrompt,
    buildSingleTranslationPrompt,
    buildSelectionPrompt,
    buildSummaryPrompt,
    buildMindmapPrompt,
    buildQAPrompt,
    parseTranslationArray,
    parseTranslationSingle,
    parseDictionaryResponse,
    parseSummary,
    parseMindmap,
    _resolveAIConfig,
    _encodeHtmlPlaceholders,
    _decodeHtmlPlaceholders,
    _filterAIResponse,
    _isSingleWord,
    _throttle,
    _buildLLMBody
  };
})(self);
