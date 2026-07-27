// background/translate-channel.js
// 网页翻译消息处理通道
// - 接收来自父页面（translate-overlay.js，运行在 standalone.html）的 chrome.runtime.sendMessage
// - 调用 translate-engine 执行翻译/摘要/脑图
// - 维护缓存（translate-store）与统计
//
// 依赖（需先 importScripts）：
//   shared/translate-store.js → translateStore
//   shared/translate-engine.js → translateEngine
//   shared/ai-tagger.js       → resolveProvider, _doFetch, _acquireAISlot, getAIConfig
//
// 消息通道（所有 action 以 'translate' 前缀）：
//   translateGetConfig / translateSetConfig
//   translateParagraphs        批量段落翻译（含缓存+词汇本）
//   translateSingle            单段翻译
//   translateSelection         划词翻译
//   translateGenerateSummary   AI 智能摘要
//   translateGenerateMindmap   AI 脑图生成
//   translateGenerateQA        AI 智能问答
//   translateClearCache / translateGetHistory / translateClearHistory
//   translateGetGlossary / translateAddGlossary / translateRemoveGlossary
//   translateGetStats

(function (global) {
  'use strict';

  // 批次大小按引擎区分（参考沉浸式翻译 maxTextGroupLength）
  // - AI 引擎：12 段/批（Agnes-2.0-Flash 上下文 512K，可承载大批量；请求数降至 1/3，降低 429 风险）
  // - Google：50 段/批（免费端点支持大批量）
  // - 微软：3 段/批（小批次串行，每批返回立即推送 partial，营造流式感）
  const BATCH_SIZE_AI = 12;
  const BATCH_SIZE_GOOGLE = 50;
  const BATCH_SIZE_MICROSOFT = 3;

  // ===== 批量翻译入口（含缓存查询 + 分批调用引擎）=====
  async function handleTranslateParagraphs(message) {
    const { texts, url, targetLang: overrideLang, sourceLang: overrideSourceLang, pageTitle } = message;
    if (!Array.isArray(texts) || !texts.length) {
      return { success: false, error: 'No texts provided' };
    }

    const config = await translateStore.getConfig();
    if (!config.enabled) return { success: false, error: 'Translation disabled' };

    // 微软引擎：设置整页翻译锁，阻止划词翻译并发请求
    const _isMsBatch = config.engine === 'microsoft';
    if (_isMsBatch) _microsoftTranslating = true;
    try {
      return await _doTranslateParagraphs(message, config);
    } finally {
      if (_isMsBatch) _microsoftTranslating = false;
    }
  }

  async function _doTranslateParagraphs(message, config) {
    const { texts, url, targetLang: overrideLang, sourceLang: overrideSourceLang, pageTitle } = message;
    const targetLang = overrideLang || config.targetLang || 'zh-CN';
    const sourceLang = overrideSourceLang || config.sourceLang || 'auto';
    const useCache = config.cacheEnabled !== false;
    const glossaryTerms = config.glossaryEnabled ? await translateStore.getGlossary() : [];
    const isGoogle = config.engine === 'google';
    const isMicrosoft = config.engine === 'microsoft';
    const batchSize = isGoogle ? BATCH_SIZE_GOOGLE
      : (isMicrosoft ? BATCH_SIZE_MICROSOFT : BATCH_SIZE_AI);

    // 解析 AI 配置用于缓存 key（含 model）
    let aiConfig = null;
    if (!isGoogle && !isMicrosoft) {
      aiConfig = await translateEngine._resolveAIConfig(config);
    }
    const cacheEngine = config.engine;
    const cacheModel = (aiConfig && aiConfig.model) || (aiConfig && aiConfig.provider) || 'default';

    // 1. 查缓存，拆分命中/未命中（cache key 含 engine+model，避免切换引擎命中旧译文）
    const results = new Array(texts.length);
    const missedIdx = [];
    let cacheHits = 0;
    if (useCache) {
      for (let i = 0; i < texts.length; i++) {
        const cached = await translateStore.getCache(texts[i], targetLang, cacheEngine, cacheModel);
        if (cached) {
          results[i] = { idx: i, translation: cached, cached: true };
          cacheHits++;
        } else {
          missedIdx.push(i);
        }
      }
    } else {
      for (let i = 0; i < texts.length; i++) missedIdx.push(i);
    }

    // 2. 分批调用引擎翻译未命中部分
    let successCount = 0;
    let failCount = 0;
    let totalLatency = 0;

    for (let batchStart = 0; batchStart < missedIdx.length; batchStart += batchSize) {
      const batchIdx = missedIdx.slice(batchStart, batchStart + batchSize);
      const batchTexts = batchIdx.map(i => texts[i]);

      let result;
      if (isGoogle) {
        result = await translateEngine.translateGoogle(batchTexts, targetLang, sourceLang);
      } else if (isMicrosoft) {
        result = await translateEngine.translateMicrosoft(batchTexts, targetLang, sourceLang);
      } else {
        // 默认 AI 引擎（注入 pageTitle 作为上下文）
        result = await translateEngine.translateBatchAI(batchTexts, {
          translateConfig: config,
          glossaryTerms,
          targetLang,
          sourceLang,
          pageTitle
        });
      }

      if (result.ok && result.results) {
        for (const r of result.results) {
          const globalIdx = batchIdx[r.idx];
          const translation = r.translation || '';
          results[globalIdx] = { idx: globalIdx, translation, cached: false };
          if (translation) successCount++;
          // 写缓存
          if (useCache && translation) {
            await translateStore.setCache(texts[globalIdx], targetLang, translation, cacheEngine, cacheModel).catch(() => {});
          }
        }
        if (result.latency) totalLatency += result.latency;
      } else {
        // 失败降级策略：
        // - 限流/服务器错误（429/5xx）：不重试，直接放弃（避免加剧限流）
        // - 解析失败（PARSE_FAILED）：逐段重试（可能是批量 prompt 过长导致）
        // - 其他错误：直接放弃
        const errStr = String(result.error || '');
        const isRateLimit = /429|rate\s*limit|too\s*many|HTTP\s*5\d\d|HTTP\s*429/i.test(errStr);
        const isParseFail = /PARSE_FAILED/i.test(errStr);

        if (!isGoogle && !isMicrosoft && batchIdx.length > 1 && isParseFail && !isRateLimit) {
          // 仅解析失败时逐段重试
          for (const i of batchIdx) {
            const singleResult = await translateEngine.translateSingleAI(texts[i], {
              translateConfig: config,
              glossaryTerms,
              targetLang,
              sourceLang,
              pageTitle
            });
            if (singleResult.ok && singleResult.translation) {
              results[i] = { idx: i, translation: singleResult.translation, cached: false };
              successCount++;
              if (useCache) {
                await translateStore.setCache(texts[i], targetLang, singleResult.translation, cacheEngine, cacheModel).catch(() => {});
              }
              if (singleResult.latency) totalLatency += singleResult.latency;
            } else {
              failCount++;
              results[i] = { idx: i, translation: '', cached: false, error: singleResult.error || result.error };
            }
          }
        } else {
          failCount += batchIdx.length;
          // 失败时填充空结果
          for (const i of batchIdx) {
            if (!results[i]) results[i] = { idx: i, translation: '', cached: false, error: result.error };
          }
          // 限流严重时中断整个翻译流程，避免雪崩（_callLLM 内部已重试 2 次仍失败）
          if (isRateLimit) {
            for (let j = batchStart + batchSize; j < missedIdx.length; j++) {
              const i = missedIdx[j];
              if (!results[i]) results[i] = { idx: i, translation: '', cached: false, error: 'SKIPPED_RATE_LIMIT' };
              failCount++;
            }
            break;
          }
        }
      }
    }

    // 3. 统计
    await translateStore.updateStats({
      totalRequests: 1,
      successCount: successCount > 0 ? 1 : 0,
      failCount: failCount > 0 && successCount === 0 ? 1 : 0,
      cacheHits,
      latencyMs: totalLatency
    });

    // 4. 写历史（仅记录一次，避免历史爆炸）
    if (url && successCount > 0) {
      await translateStore.addHistory({
        url,
        action: 'translateParagraphs',
        count: texts.length,
        targetLang,
        engine: config.engine,
        cacheHits
      }).catch(() => {});
    }

    return {
      success: true,
      results: results.filter(Boolean),
      cacheHits,
      stats: { successCount, failCount }
    };
  }

  // ===== 流式批量翻译（通过 port 推送 partial）=====
  // port: chrome.runtime.Port，用于实时推送 {type:'partial', idx, translation} 和最终 {type:'complete', results}
  async function handleTranslateParagraphsStream(message, port) {
    const { texts, url, targetLang: overrideLang, sourceLang: overrideSourceLang, pageTitle } = message;
    if (!Array.isArray(texts) || !texts.length) {
      port.postMessage({ type: 'complete', success: false, error: 'No texts provided' });
      return;
    }

    const config = await translateStore.getConfig();
    if (!config.enabled) {
      port.postMessage({ type: 'complete', success: false, error: 'Translation disabled' });
      return;
    }

    // 微软引擎：设置整页翻译锁，阻止划词翻译并发请求
    const _isMsBatch = config.engine === 'microsoft';
    if (_isMsBatch) _microsoftTranslating = true;
    try {
      await _doTranslateParagraphsStream(message, port, config);
    } finally {
      if (_isMsBatch) _microsoftTranslating = false;
    }
  }

  async function _doTranslateParagraphsStream(message, port, config) {
    const { texts, url, targetLang: overrideLang, sourceLang: overrideSourceLang, pageTitle } = message;
    const targetLang = overrideLang || config.targetLang || 'zh-CN';
    const sourceLang = overrideSourceLang || config.sourceLang || 'auto';
    const useCache = config.cacheEnabled !== false;
    const glossaryTerms = config.glossaryEnabled ? await translateStore.getGlossary() : [];
    const isGoogle = config.engine === 'google';
    const isMicrosoft = config.engine === 'microsoft';
    const batchSize = isGoogle ? BATCH_SIZE_GOOGLE
      : (isMicrosoft ? BATCH_SIZE_MICROSOFT : BATCH_SIZE_AI);

    let aiConfig = null;
    if (!isGoogle && !isMicrosoft) {
      aiConfig = await translateEngine._resolveAIConfig(config);
    }
    const cacheEngine = config.engine;
    const cacheModel = (aiConfig && aiConfig.model) || (aiConfig && aiConfig.provider) || 'default';

    // 1. 查缓存，拆分命中/未命中
    const results = new Array(texts.length);
    const missedIdx = [];
    let cacheHits = 0;
    if (useCache) {
      for (let i = 0; i < texts.length; i++) {
        const cached = await translateStore.getCache(texts[i], targetLang, cacheEngine, cacheModel);
        if (cached) {
          results[i] = { idx: i, translation: cached, cached: true };
          cacheHits++;
          // 缓存命中也推送 partial（让 injector 立即渲染）
          port.postMessage({ type: 'partial', idx: i, translation: cached, cached: true });
        } else {
          missedIdx.push(i);
        }
      }
    } else {
      for (let i = 0; i < texts.length; i++) missedIdx.push(i);
    }

    // 2. 分批调用引擎翻译未命中部分
    let successCount = 0;
    let failCount = 0;
    let totalLatency = 0;

    for (let batchStart = 0; batchStart < missedIdx.length; batchStart += batchSize) {
      const batchIdx = missedIdx.slice(batchStart, batchStart + batchSize);
      const batchTexts = batchIdx.map(i => texts[i]);

      let result;
      if (isGoogle) {
        result = await translateEngine.translateGoogle(batchTexts, targetLang, sourceLang);
        // Google 不支持流式，直接推送完整结果
        if (result.ok && result.results) {
          for (const r of result.results) {
            const globalIdx = batchIdx[r.idx];
            port.postMessage({ type: 'partial', idx: globalIdx, translation: r.translation || '' });
          }
        }
      } else if (isMicrosoft) {
        result = await translateEngine.translateMicrosoft(batchTexts, targetLang, sourceLang);
        // 微软不支持流式，但小批次(3段/批)串行 + 立即推送，营造流式感
        if (result.ok && result.results) {
          for (const r of result.results) {
            const globalIdx = batchIdx[r.idx];
            port.postMessage({ type: 'partial', idx: globalIdx, translation: r.translation || '' });
          }
        }
      } else {
        // AI 引擎：流式翻译，通过 onPartial 实时推送
        const batchGlobalIdx = batchIdx;
        result = await translateEngine.translateBatchAI(batchTexts, {
          translateConfig: config,
          glossaryTerms,
          targetLang,
          sourceLang,
          pageTitle,
          stream: true,
          onPartial: (localIdx, partialText) => {
            const globalIdx = batchGlobalIdx[localIdx];
            port.postMessage({ type: 'partial', idx: globalIdx, translation: partialText });
          },
          onRetry: (attempt, waitMs, reason) => {
            // 推送限流重试状态到 overlay
            port.postMessage({ type: 'retry', attempt, waitMs, reason });
          }
        });
      }

      if (result.ok && result.results) {
        for (const r of result.results) {
          const globalIdx = batchIdx[r.idx];
          const translation = r.translation || '';
          results[globalIdx] = { idx: globalIdx, translation, cached: false };
          if (translation) successCount++;
          if (useCache && translation) {
            await translateStore.setCache(texts[globalIdx], targetLang, translation, cacheEngine, cacheModel).catch(() => {});
          }
          // 推送最终完整结果（覆盖 partial）
          port.postMessage({ type: 'partial', idx: globalIdx, translation, final: true });
        }
        if (result.latency) totalLatency += result.latency;
      } else {
        const errStr = String(result.error || '');
        const isRateLimit = /429|rate\s*limit|too\s*many|HTTP\s*5\d\d|HTTP\s*429/i.test(errStr);
        const isParseFail = /PARSE_FAILED/i.test(errStr);

        if (!isGoogle && !isMicrosoft && batchIdx.length > 1 && isParseFail && !isRateLimit) {
          for (const i of batchIdx) {
            const singleResult = await translateEngine.translateSingleAI(texts[i], {
              translateConfig: config,
              glossaryTerms,
              targetLang,
              sourceLang,
              pageTitle
            });
            if (singleResult.ok && singleResult.translation) {
              results[i] = { idx: i, translation: singleResult.translation, cached: false };
              successCount++;
              if (useCache) {
                await translateStore.setCache(texts[i], targetLang, singleResult.translation, cacheEngine, cacheModel).catch(() => {});
              }
              if (singleResult.latency) totalLatency += singleResult.latency;
              port.postMessage({ type: 'partial', idx: i, translation: singleResult.translation, final: true });
            } else {
              failCount++;
              results[i] = { idx: i, translation: '', cached: false, error: singleResult.error || result.error };
            }
          }
        } else {
          failCount += batchIdx.length;
          for (const i of batchIdx) {
            if (!results[i]) results[i] = { idx: i, translation: '', cached: false, error: result.error };
          }
          // 推送失败信息
          port.postMessage({ type: 'batchError', error: result.error, count: batchIdx.length });

          // 限流严重时中断整个翻译流程，避免雪崩（_callLLM 内部已重试 2 次仍失败）
          if (isRateLimit) {
            // 标记剩余批次为跳过
            for (let j = batchStart + batchSize; j < missedIdx.length; j++) {
              const i = missedIdx[j];
              if (!results[i]) results[i] = { idx: i, translation: '', cached: false, error: 'SKIPPED_RATE_LIMIT' };
              failCount++;
            }
            break; // 跳出批次循环
          }
        }
      }
    }

    // 3. 统计 + 历史
    await translateStore.updateStats({
      totalRequests: 1,
      successCount: successCount > 0 ? 1 : 0,
      failCount: failCount > 0 && successCount === 0 ? 1 : 0,
      cacheHits,
      latencyMs: totalLatency
    }).catch(() => {});

    if (url && successCount > 0) {
      await translateStore.addHistory({
        url,
        action: 'translateParagraphs',
        count: texts.length,
        targetLang,
        engine: config.engine,
        cacheHits
      }).catch(() => {});
    }

    // 4. 推送完成信号
    port.postMessage({
      type: 'complete',
      success: true,
      results: results.filter(Boolean),
      cacheHits,
      stats: { successCount, failCount }
    });
  }

  // ===== 单段翻译（用于悬停翻译）=====
  async function handleTranslateSingle(message) {
    const { text, targetLang: overrideLang, pageTitle } = message;
    if (!text) return { success: false, error: 'No text provided' };

    const config = await translateStore.getConfig();
    if (!config.enabled) return { success: false, error: 'Translation disabled' };

    const targetLang = overrideLang || config.targetLang || 'zh-CN';
    const isGoogle = config.engine === 'google';
    const isMicrosoft = config.engine === 'microsoft';

    // 解析 AI 配置用于缓存 key
    let aiConfig = null;
    if (!isGoogle && !isMicrosoft) {
      aiConfig = await translateEngine._resolveAIConfig(config);
    }
    const cacheEngine = config.engine;
    const cacheModel = (aiConfig && aiConfig.model) || (aiConfig && aiConfig.provider) || 'default';

    // 查缓存
    if (config.cacheEnabled) {
      const cached = await translateStore.getCache(text, targetLang, cacheEngine, cacheModel);
      if (cached) {
        await translateStore.updateStats({ totalRequests: 1, cacheHits: 1 });
        return { success: true, translation: cached, cached: true };
      }
    }

    const glossaryTerms = config.glossaryEnabled ? await translateStore.getGlossary() : [];
    let result;
    if (isGoogle) {
      result = await translateEngine.translateGoogle([text], targetLang);
      if (result.ok) {
        result.translation = result.results[0]?.translation || '';
      }
    } else if (isMicrosoft) {
      result = await translateEngine.translateMicrosoft([text], targetLang, config.sourceLang || 'auto');
      if (result.ok) {
        result.translation = result.results[0]?.translation || '';
      }
    } else {
      result = await translateEngine.translateSingleAI(text, {
        translateConfig: config,
        glossaryTerms,
        targetLang,
        pageTitle
      });
    }

    if (!result.ok) {
      await translateStore.updateStats({ totalRequests: 1, failCount: 1 });
      return { success: false, error: result.error };
    }

    // 写缓存
    if (config.cacheEnabled && result.translation) {
      await translateStore.setCache(text, targetLang, result.translation, cacheEngine, cacheModel).catch(() => {});
    }

    await translateStore.updateStats({
      totalRequests: 1,
      successCount: 1,
      latencyMs: result.latency
    });

    return { success: true, translation: result.translation, cached: false };
  }

  // ===== 划词翻译 =====
  // 微软引擎下复用整页翻译的缓存（避免重复请求触发 QPS 限流）
  // 微软引擎下整页翻译进行中时拒绝划词请求（避免并发突破 QPS 限制）
  let _microsoftTranslating = false; // 微软整页翻译进行中的全局锁

  async function handleTranslateSelection(message) {
    const { text, contextBefore, contextAfter, targetLang: overrideLang, pageTitle } = message;
    if (!text) return { success: false, error: 'No text provided' };

    const config = await translateStore.getConfig();
    if (!config.enabled) return { success: false, error: 'Translation disabled' };

    const targetLang = overrideLang || config.targetLang || 'zh-CN';

    // 划词翻译不查缓存（每次上下文不同）
    if (config.engine === 'google') {
      const r = await translateEngine.translateGoogle([text], targetLang);
      if (!r.ok) return { success: false, error: r.error };
      return { success: true, translation: r.results[0]?.translation || '', isWord: false };
    }

    // 微软翻译引擎：先查整页翻译缓存（避免重复请求触发 QPS 限流）
    if (config.engine === 'microsoft') {
      // 整页翻译进行中时拒绝划词请求（避免并发突破 QPS 限制）
      if (_microsoftTranslating) {
        return { success: false, error: 'MS_BATCH_IN_PROGRESS' };
      }
      // 查缓存（复用整页翻译的缓存 key）
      if (config.cacheEnabled !== false) {
        const cached = await translateStore.getCache(text, targetLang, 'microsoft', 'default');
        if (cached) {
          await translateStore.updateStats({ totalRequests: 1, cacheHits: 1 });
          return { success: true, translation: cached, cached: true, isWord: false };
        }
      }
      const r = await translateEngine.translateMicrosoft([text], targetLang, config.sourceLang || 'auto');
      if (!r.ok) return { success: false, error: r.error };
      const translation = r.results[0]?.translation || '';
      // 写缓存
      if (config.cacheEnabled !== false && translation) {
        await translateStore.setCache(text, targetLang, translation, 'microsoft', 'default').catch(() => {});
      }
      await translateStore.updateStats({ totalRequests: 1, successCount: 1, latencyMs: r.latency });
      return { success: true, translation, isWord: false };
    }

    const result = await translateEngine.translateSelectionAI(text, contextBefore, contextAfter, {
      translateConfig: config,
      targetLang,
      pageTitle
    });

    if (!result.ok) return { success: false, error: result.error };
    await translateStore.updateStats({ totalRequests: 1, successCount: 1, latencyMs: result.latency });
    // 单词翻译返回字典数据
    const resp = { success: true, translation: result.translation };
    if (result.dictionary) resp.dictionary = result.dictionary;
    if (result.isWord !== undefined) resp.isWord = result.isWord;
    return resp;
  }

  // ===== 智能摘要 =====
  async function handleGenerateSummary(message) {
    const { content, url } = message;
    if (!content) return { success: false, error: 'No content provided' };

    const config = await translateStore.getConfig();
    const result = await translateEngine.generateSummary(content, {
      translateConfig: config,
      targetLang: config.targetLang
    });

    if (!result.ok) return { success: false, error: result.error };

    await translateStore.updateStats({ totalRequests: 1, successCount: 1, latencyMs: result.latency });
    if (url) {
      await translateStore.addHistory({
        url,
        action: 'summary',
        targetLang: config.targetLang,
        engine: config.engine
      }).catch(() => {});
    }

    return {
      success: true,
      summary: result.summary,
      keyPoints: result.keyPoints,
      tags: result.tags
    };
  }

  // ===== 脑图生成 =====
  async function handleGenerateMindmap(message) {
    const { content, url } = message;
    if (!content) return { success: false, error: 'No content provided' };

    const config = await translateStore.getConfig();
    const result = await translateEngine.generateMindmap(content, {
      translateConfig: config,
      targetLang: config.targetLang
    });

    if (!result.ok) return { success: false, error: result.error };

    await translateStore.updateStats({ totalRequests: 1, successCount: 1, latencyMs: result.latency });
    if (url) {
      await translateStore.addHistory({
        url,
        action: 'mindmap',
        targetLang: config.targetLang,
        engine: config.engine
      }).catch(() => {});
    }

    return { success: true, mindmap: result.mindmap };
  }

  // ===== 智能问答 =====
  async function handleGenerateQA(message) {
    const { content, question } = message;
    if (!content || !question) return { success: false, error: 'No content or question' };

    const config = await translateStore.getConfig();
    const result = await translateEngine.generateQA(content, question, {
      translateConfig: config,
      targetLang: config.targetLang
    });

    if (!result.ok) return { success: false, error: result.error };
    await translateStore.updateStats({ totalRequests: 1, successCount: 1, latencyMs: result.latency });
    return { success: true, answer: result.answer };
  }

  // ===== 消息路由表 =====
  global.translateChannel = {
    async handle(action, message) {
      switch (action) {
        case 'translateGetConfig':
          return { success: true, config: await translateStore.getConfig() };

        case 'translateSetConfig':
          return { success: true, config: await translateStore.setConfig(message.config || {}) };

        case 'translateParagraphs':
          return await handleTranslateParagraphs(message);

        case 'translateSingle':
          return await handleTranslateSingle(message);

        case 'translateSelection':
          return await handleTranslateSelection(message);

        case 'translateGenerateSummary':
          return await handleGenerateSummary(message);

        case 'translateGenerateMindmap':
          return await handleGenerateMindmap(message);

        case 'translateGenerateQA':
          return await handleGenerateQA(message);

        case 'translateClearCache':
          await translateStore.clearCache();
          return { success: true };

        case 'translateGetHistory':
          return { success: true, history: await translateStore.getHistory(message.limit || 100, message.url) };

        case 'translateClearHistory':
          await translateStore.clearHistory();
          return { success: true };

        case 'translateGetGlossary':
          return { success: true, terms: await translateStore.getGlossary() };

        case 'translateAddGlossary':
          return { success: true, term: await translateStore.addGlossaryTerm(message.term || {}) };

        case 'translateRemoveGlossary':
          await translateStore.removeGlossaryTerm(message.id);
          return { success: true };

        case 'translateGetStats':
          return { success: true, stats: await translateStore.getStats() };

        default:
          return { success: false, error: `Unknown translate action: ${action}` };
      }
    },

    // 流式翻译入口（供 background.js 的 onConnect 调用）
    async handleStream(message, port) {
      return await handleTranslateParagraphsStream(message, port);
    }
  };
})(self);
