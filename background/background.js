// 引入 AI 增强层（需在 smart-tagger.js 之前加载，供其调用 classifyWithAI）
importScripts('../shared/ai-tagger.js');
// 引入 AI 辅助分类日志
importScripts('../shared/ai-logger.js');
// 引入智能分类引擎
importScripts('../shared/smart-tagger.js');
// 引入网页预览提取 (Mozilla Readability)
importScripts('vendor/Readability.js');
importScripts('preview-extractor.js');

// ===== 正文内容提取 =====
async function extractActiveTabContent(tabId, url) {
  if (!tabId || !url) return null;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('file:')) return null;

  try {
    const cached = await getCachedContent(url);
    if (cached) return cached;
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['background/vendor/Readability.js', 'content/content-extractor.js'],
      world: 'ISOLATED'
    });
    const data = await chrome.tabs.sendMessage(tabId, { action: 'extractContent' });
    if (data && data.textContent) {
      await setCachedContent(url, data);
      return data;
    }
  } catch (err) {
    console.warn('Content extraction failed:', err);
  }
  return null;
}

// ===== 数据管理 =====
const STORAGE_KEY = 'bookmark_timeline_data';
const STORAGE_KEY_TOMBSTONES = 'bookmark_tombstones';
const STORAGE_KEY_SETTINGS = 'app_settings';
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 7;
const TOMBSTONE_RETENTION_OPTIONS = [7, 15, 30, 60];

async function getStoredBookmarks() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function setStoredBookmarks(bookmarks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: bookmarks });
}

async function getTombstones() {
  const result = await chrome.storage.local.get(STORAGE_KEY_TOMBSTONES);
  return result[STORAGE_KEY_TOMBSTONES] || [];
}

async function setTombstones(tombstones) {
  await chrome.storage.local.set({ [STORAGE_KEY_TOMBSTONES]: tombstones });
}

async function getAppSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
  return { tombstoneRetentionDays: DEFAULT_TOMBSTONE_RETENTION_DAYS, ...(result[STORAGE_KEY_SETTINGS] || {}) };
}

async function setAppSettings(patch) {
  const current = await getAppSettings();
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: { ...current, ...patch } });
}

async function pruneTombstones(tombstones, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  return tombstones.filter(t => (t.deletedAt || 0) >= cutoff);
}

// ===== 健康度评分收藏 =====
const HEALTH_SCORE_FAVORITES_KEY = 'health_score_favorites';

async function getHealthScoreFavorites() {
  const result = await chrome.storage.local.get(HEALTH_SCORE_FAVORITES_KEY);
  return result[HEALTH_SCORE_FAVORITES_KEY] || [];
}

async function saveHealthScoreFavorite(record) {
  const favorites = await getHealthScoreFavorites();
  const item = {
    id: record.id || 'hsf_' + Date.now(),
    score: record.score,
    level: record.level,
    details: record.details || [],
    range: record.range || null,
    note: record.note || '',
    createdAt: record.createdAt || Date.now()
  };
  // 去重：同一天同一分数不重复收藏
  const sameDay = favorites.find(f => {
    const sameDate = new Date(f.createdAt).toDateString() === new Date(item.createdAt).toDateString();
    return sameDate && f.score === item.score;
  });
  if (sameDay) return { success: false, error: 'already_exists' };
  favorites.unshift(item);
  // 最多保留 50 条
  if (favorites.length > 50) favorites.length = 50;
  await chrome.storage.local.set({ [HEALTH_SCORE_FAVORITES_KEY]: favorites });
  return { success: true, favorite: item };
}

async function deleteHealthScoreFavorite(id) {
  const favorites = await getHealthScoreFavorites();
  const filtered = favorites.filter(f => f.id !== id);
  await chrome.storage.local.set({ [HEALTH_SCORE_FAVORITES_KEY]: filtered });
  return { success: true };
}

async function getEffectiveRetentionDays() {
  const settings = await getAppSettings();
  return TOMBSTONE_RETENTION_OPTIONS.includes(settings.tombstoneRetentionDays)
    ? settings.tombstoneRetentionDays
    : DEFAULT_TOMBSTONE_RETENTION_DAYS;
}

async function addTombstone(item) {
  if (!item || !item.url) return;
  const retentionDays = await getEffectiveRetentionDays();
  const tombstones = await pruneTombstones(await getTombstones(), retentionDays);
  const key = item.url + '_' + item.dateAdded;
  if (tombstones.some(t => (t.url + '_' + t.dateAdded) === key)) {
    return;
  }
  tombstones.push({ ...item, deletedAt: Date.now() });
  await setTombstones(tombstones);
}

// ===== 工具函数 =====
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 并发池：限制同时运行的任务数量，避免瞬时大量 IO
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ===== 书签处理 =====
function bookmarkToItem(bookmark, folderName, folderPath) {
  return {
    id: bookmark.id,
    parentId: bookmark.parentId || '',
    title: bookmark.title || '',
    url: bookmark.url || '',
    domain: extractDomain(bookmark.url || ''),
    dateAdded: bookmark.dateAdded || Date.now(),
    formattedTime: formatTime(bookmark.dateAdded || Date.now()),
    syncedAt: Date.now(),
    folderName: folderName || '',
    folderPath: folderPath || '',
    tags: [],
    tagsAuto: [],
    pinned: false,
    pinnedAt: null,
    clickCount: 0,
    lastClickedAt: null
  };
}

// 递归遍历所有书签（带文件夹信息）
async function collectAllBookmarks(nodes, folderPath = '', folderName = '') {
  let results = [];
  for (const node of nodes) {
    const currentPath = folderPath ? `${folderPath}/${node.title}` : node.title;
    if (node.url) {
      results.push(bookmarkToItem(node, folderName, folderPath));
    }
    if (node.children) {
      results = results.concat(await collectAllBookmarks(node.children, currentPath, node.title));
    }
  }
  return results;
}

// 增量合并（去重，保留已有标签）
function mergeBookmarks(existing, incoming) {
  const urlMap = new Map();
  
  // 索引已有的（保留用户手动标签）
  for (const item of existing) {
    const key = item.url + '_' + item.dateAdded;
    urlMap.set(key, item);
  }
  
  // 合并新的（如果已有则保留原有标签）
  let added = 0;
  for (const item of incoming) {
    const key = item.url + '_' + item.dateAdded;
    if (!urlMap.has(key)) {
      urlMap.set(key, item);
      added++;
    }
    // 已有的保留原有 tags，不覆盖
  }
  
  return { merged: Array.from(urlMap.values()), added };
}

// ===== 同步操作 =====
async function syncAllBookmarks() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const allBookmarks = await collectAllBookmarks(tree);
    const existing = await getStoredBookmarks();

    // 索引已有项，保留 pinned / 手动标签
    const existingByKey = new Map();
    for (const item of existing) {
      const key = item.url + '_' + item.dateAdded;
      existingByKey.set(key, item);
    }

    // 合并：保留已有 pinned 状态和手动标签
    let added = 0;
    const merged = [];
    const currentKeys = new Set();
    for (const item of allBookmarks) {
      const key = item.url + '_' + item.dateAdded;
      const prev = existingByKey.get(key);
      currentKeys.add(key);
      if (prev) {
        item.pinned = !!prev.pinned;
        item.pinnedAt = prev.pinnedAt || null;
        item.clickCount = prev.clickCount || 0;
        item.lastClickedAt = prev.lastClickedAt || null;
        if (prev.tags && prev.tags.length > 0) {
          // 合并：用户手动标签优先
          const auto = new Set(item.tags || []);
          const manual = new Set(prev.tags);
          item.tags = Array.from(new Set([...manual, ...auto]));
        }
      } else {
        added++;
      }
      merged.push(item);
    }

    // 检测删除：existing 中存在但 currentKeys 中不存在的项写入 tombstones
    const settings = await getAppSettings();
    const retentionDays = TOMBSTONE_RETENTION_OPTIONS.includes(settings.tombstoneRetentionDays)
      ? settings.tombstoneRetentionDays
      : DEFAULT_TOMBSTONE_RETENTION_DAYS;
    const prevTombstones = await pruneTombstones(await getTombstones(), retentionDays);
    const existingTombstoneKeys = new Set(prevTombstones.map(t => t.url + '_' + t.dateAdded));
    const newTombstones = [...prevTombstones];
    for (const item of existing) {
      const key = item.url + '_' + item.dateAdded;
      if (!currentKeys.has(key) && !existingTombstoneKeys.has(key) && item.url) {
        newTombstones.push({ ...item, deletedAt: Date.now() });
      }
    }
    if (newTombstones.length !== prevTombstones.length) {
      await setTombstones(newTombstones);
    }

    // 为没有标签的书签自动打标签（并发池，仅更新通用文档频率，避免污染标签语料）
    const needsTag = merged.filter(item => !item.tags || item.tags.length === 0);
    const taggedResults = await autoTagBookmarks(needsTag, 10);
    let taggedCount = 0;
    taggedResults.forEach((res, i) => {
      const tags = res.tags || [];
      needsTag[i].tags = tags;
      needsTag[i].tagsAuto = tags;
      taggedCount++;
    });

    // 从 Chrome 历史记录获取真实点击次数
    await enrichClickCounts(merged, 10);

    // 排序：置顶在前，再按时间倒序
    merged.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.dateAdded - a.dateAdded;
    });

    await setStoredBookmarks(merged);
    return { total: merged.length, added, tagged: taggedCount };
  } catch (err) {
    console.error('全量同步失败:', err);
    throw err;
  }
}

// 暂存一键收藏的标签/文件夹信息，供 onCreated → addSingleBookmark 消费
// key: url, value: { tags, folderName, folderPath }
const pendingQuickBookmarks = new Map();

async function addSingleBookmark(id) {
  try {
    const bookmark = await chrome.bookmarks.get(id);
    if (!bookmark || !bookmark[0] || !bookmark[0].url) return null;

    const b = bookmark[0];
    // 消费 pending 的快速收藏信息（标签 + 文件夹）
    const pending = pendingQuickBookmarks.get(b.url);
    if (pending) {
      pendingQuickBookmarks.delete(b.url);
    }

    const item = bookmarkToItem(b, pending?.folderName, pending?.folderPath);
    if (pending?.tags && pending.tags.length > 0) {
      item.tags = pending.tags;
      item.tagsAuto = pending.tags;
    }

    const existing = await getStoredBookmarks();

    // 查重
    const duplicate = existing.some(
      (bm) => bm.url === item.url && bm.dateAdded === item.dateAdded
    );
    if (duplicate) return null;

    existing.unshift(item);
    await setStoredBookmarks(existing);

    // AI 异步回填：对规则引擎不确定的快速收藏书签，在保存后调用云端 AI
    if (pending && typeof getAIConfig === 'function' && typeof classifyWithAI === 'function') {
      maybeBackfillAIForItem(item, pending).catch(() => {});
    }

    // 桌面通知：一键收藏成功后，根据用户设置弹出系统通知
    if (pending) {
      const settings = await chrome.storage.local.get(['notificationEnabled']);
      if (settings.notificationEnabled) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: item.title || 'Bookmark Saved',
          message: (item.tags && item.tags.length > 0)
            ? `已保存到 Markline，标签：${item.tags.join(', ')}`
            : '已保存到 Markline'
        }).catch(() => {});
      }
    }

    return item;
  } catch (err) {
    console.error('增量同步失败:', err);
    return null;
  }
}

// ===== AI 异步回填 =====
// 在书签已保存后，对低置信样本调用云端 AI，将结果与规则标签融合并更新存储
async function maybeBackfillAIForItem(item, context) {
  const startTime = Date.now();
  _logIfReady({
    type: 'backfill_start',
    provider: 'unknown',
    url: item?.url,
    success: true,
    details: { title: item?.title }
  });
  try {
    const config = await getAIConfig();
    if (!config.enabled || !config.apiKey) return;

    const bookmark = {
      title: item.title,
      url: item.url,
      domain: item.domain,
      contentText: context?.contentText || '',
      metaDesc: context?.metaDesc || '',
      excerpt: context?.excerpt || ''
    };

    const ruleTags = context?.ruleTags || [];
    const candidateTags = ruleTags.slice(0, 5).map(t => ({
      tag: t.tag,
      score: t.score,
      signals: t.signals || []
    }));
    const signals = {};
    for (const t of ruleTags) {
      signals[t.tag] = t.signals || [];
    }

    const aiTags = await classifyWithAI(bookmark, candidateTags, signals, {});
    if (!aiTags || aiTags.length === 0) {
      _logIfReady({
        type: 'backfill_skip',
        provider: config.provider,
        url: item.url,
        duration: Date.now() - startTime,
        success: true,
        details: { reason: 'no_ai_result' }
      });
      return;
    }

    const merged = mergeAITags(ruleTags, aiTags, 3).map(t => t.tag);
    if (JSON.stringify(merged) === JSON.stringify(item.tags || [])) {
      _logIfReady({
        type: 'backfill_skip',
        provider: config.provider,
        url: item.url,
        duration: Date.now() - startTime,
        success: true,
        details: { reason: 'no_change' }
      });
      return;
    }

    const bookmarks = await getStoredBookmarks();
    const stored = bookmarks.find(b => b.id === item.id || (b.url === item.url && b.dateAdded === item.dateAdded));
    if (!stored) {
      _logIfReady({
        type: 'backfill_fail',
        provider: config.provider,
        url: item.url,
        duration: Date.now() - startTime,
        success: false,
        error: 'Stored bookmark not found'
      });
      return;
    }

    stored.tags = merged;
    stored.tagsAuto = merged;
    await setStoredBookmarks(bookmarks);

    _logIfReady({
      type: 'backfill_success',
      provider: config.provider,
      url: item.url,
      duration: Date.now() - startTime,
      success: true,
      details: {
        beforeTags: item.tags || [],
        afterTags: merged,
        aiTags: aiTags.map(t => t.tag)
      }
    });

    // 将 AI 辅助分类结果加入主动学习待确认队列
    // 由于 handleQuickBookmark 可能已提前把低置信度规则项加入队列，
    // 这里强制移除同 URL 的规则项，确保 AI 项覆盖旧项。
    if (typeof loadReviewQueue === 'function' && typeof saveReviewQueue === 'function') {
      const avgConfidence = aiTags.length > 0
        ? aiTags.reduce((sum, t) => sum + (t.confidence || 0), 0) / aiTags.length
        : 0.7;
      const avgScore = aiTags.length > 0
        ? (aiTags.reduce((sum, t) => sum + (t.confidence || 0), 0) / aiTags.length) * 100
        : 70;
      const queue = await loadReviewQueue();
      const filtered = queue.filter(q => q.url !== item.url);
      filtered.unshift({
        id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        url: item.url,
        title: item.title,
        domain: item.domain,
        suggestedTags: merged,
        confidence: avgConfidence,
        score: avgScore,
        reason: 'ai_assisted',
        source: 'ai',
        excerpt: context?.excerpt || item.excerpt || '',
        createdAt: Date.now()
      });
      if (filtered.length > 50) filtered.pop();
      await saveReviewQueue(filtered);
    }

    chrome.runtime.sendMessage({
      action: 'tagsUpdated',
      bookmarkId: stored.id,
      tags: merged
    }).catch(() => {});
  } catch (err) {
    console.warn('AI backfill failed:', err);
    _logIfReady({
      type: 'backfill_fail',
      url: item?.url,
      duration: Date.now() - startTime,
      success: false,
      error: err.message || 'Unknown error'
    });
  }
}

async function updateBookmark(id, changes) {
  try {
    const existing = await getStoredBookmarks();
    const index = existing.findIndex((b) => b.id === id);
    if (index === -1) {
      // 可能是 id 变了，通过 url 匹配
      const bookmark = await chrome.bookmarks.get(id).catch(() => null);
      if (!bookmark || !bookmark[0]) return;
      const item = bookmarkToItem(bookmark[0]);
      const idx = existing.findIndex((b) => b.url === item.url);
      if (idx !== -1) {
        existing[idx] = { ...existing[idx], ...item };
      }
    } else {
      existing[index] = {
        ...existing[index],
        title: changes.title || existing[index].title,
        url: changes.url || existing[index].url,
        domain: changes.url ? extractDomain(changes.url) : existing[index].domain
      };
    }
    await setStoredBookmarks(existing);
  } catch (err) {
    console.error('更新书签失败:', err);
  }
}

// ===== 从 Chrome 历史记录获取真实点击次数 =====
async function enrichClickCounts(bookmarks, concurrency = 5) {
  const updated = [];
  await runWithConcurrency(bookmarks, concurrency, async (item) => {
    if (!item.url) return;
    try {
      const visits = await chrome.history.getVisits({ url: item.url });
      const count = visits ? visits.length : 0;
      if (count !== (item.clickCount || 0)) {
        item.clickCount = count;
        item.lastClickedAt = count > 0 ? Date.now() : item.lastClickedAt;
        updated.push(item);
      }
    } catch (e) {
      // 某些 URL（如 chrome://）不支持 history API，静默忽略
    }
  });
  return updated;
}

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'syncAll':
      syncAllBookmarks().then((result) => {
        sendResponse({ success: true, ...result });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // 保持通道打开

    case 'getBookmarks':
      (async () => {
        let bookmarks = await getStoredBookmarks();
        // 尝试从历史记录刷新点击次数（不阻塞返回）
        enrichClickCounts(bookmarks, 5).then(updated => {
          if (updated.length > 0) setStoredBookmarks(bookmarks);
        }).catch(() => {});
        sendResponse({ success: true, bookmarks });
      })();
      return true;

    case 'deleteBookmark':
      (async () => {
        // 从 Chrome 书签中真正删除
        const bookmarks = await getStoredBookmarks();
        const target = bookmarks.find((b) => b.id === message.id || (message.url && b.url === message.url));
        if (message.id) {
          try {
            await chrome.bookmarks.remove(message.id);
          } catch (err) {
            console.warn('删除 Chrome 书签失败:', err.message);
          }
        }
        const filtered = bookmarks.filter((b) => b.id !== message.id && b.url !== message.url);
        if (filtered.length !== bookmarks.length) {
          await setStoredBookmarks(filtered);
        }
        if (target) {
          await addTombstone(target);
        }
        sendResponse({ success: true, total: filtered.length });
      })();
      return true;

    case 'clearAll':
      (async () => {
        // 从 Chrome 书签中真正删除所有
        const bookmarks = await getStoredBookmarks();
        for (const b of bookmarks) {
          if (b.id) {
            try {
              await chrome.bookmarks.remove(b.id);
            } catch (err) {
              console.warn('删除 Chrome 书签失败:', err.message);
            }
          }
        }
        const existingTombstones = await pruneTombstones(await getTombstones(), await getEffectiveRetentionDays());
        const merged = [...existingTombstones];
        const keys = new Set(merged.map(t => t.url + '_' + t.dateAdded));
        for (const item of bookmarks) {
          if (item.url) {
            const key = item.url + '_' + item.dateAdded;
            if (!keys.has(key)) {
              merged.push({ ...item, deletedAt: Date.now() });
              keys.add(key);
            }
          }
        }
        await setTombstones(merged);
        await setStoredBookmarks([]);
        sendResponse({ success: true });
      })();
      return true;

    case 'updateBookmark':
      (async () => {
        const { id, title, url, tags } = message;
        // 更新 Chrome 书签
        if (id) {
          try {
            const changes = {};
            if (title !== undefined) changes.title = title;
            if (url !== undefined) changes.url = url;
            await chrome.bookmarks.update(id, changes);
          } catch (err) {
            console.error('更新 Chrome 书签失败:', err);
            sendResponse({ success: false, error: err.message });
            return;
          }
        }
        // 更新本地存储
        const bookmarks = await getStoredBookmarks();
        const item = bookmarks.find((b) => b.id === id);
        if (item) {
          if (title !== undefined) item.title = title;
          if (url !== undefined) {
            item.url = url;
            item.domain = extractDomain(url);
          }
          // 更新标签
          if (tags !== undefined) {
            item.tags = tags;
          }
          await setStoredBookmarks(bookmarks);
        }
        sendResponse({ success: true });
      })();
      return true;

    case 'scheduleChecker':
      scheduleCheckerAlarm().then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'checkUrl':
      (async () => {
        const { url, timeout } = message;
        const result = await checkUrlFromBackground(url, timeout || 10000);
        sendResponse({ success: true, result });
      })();
      return true;

    case 'togglePin':
      (async () => {
        const bookmarks = await getStoredBookmarks();
        const item = bookmarks.find((b) => b.id === message.id);
        if (item) {
          item.pinned = !item.pinned;
          if (item.pinned && !item.pinnedAt) item.pinnedAt = Date.now();
          if (!item.pinned) item.pinnedAt = null;
          await setStoredBookmarks(bookmarks);
          sendResponse({ success: true, pinned: item.pinned });
        } else {
          sendResponse({ success: false, error: 'Bookmark not found' });
        }
      })();
      return true;

    case 'bulkUpdate':
      (async () => {
        const { ids, tags, addTags, removeTags, action } = message;
        if (!Array.isArray(ids) || ids.length === 0) {
          sendResponse({ success: false, error: 'No IDs provided' });
          return;
        }
        const bookmarks = await getStoredBookmarks();
        const idSet = new Set(ids);
        let updated = 0;
        for (const item of bookmarks) {
          if (!idSet.has(item.id)) continue;
          if (action === 'addTag' && addTags) {
            item.tags = Array.from(new Set([...(item.tags || []), ...addTags]));
            updated++;
          } else if (action === 'removeTag' && removeTags) {
            item.tags = (item.tags || []).filter(t => !removeTags.includes(t));
            updated++;
          } else if (action === 'setTags' && tags) {
            item.tags = [...tags];
            updated++;
          } else if (action === 'pin') {
            item.pinned = true;
            item.pinnedAt = Date.now();
            updated++;
          } else if (action === 'unpin') {
            item.pinned = false;
            item.pinnedAt = null;
            updated++;
          }
        }
        await setStoredBookmarks(bookmarks);
        sendResponse({ success: true, updated });
      })();
      return true;

    case 'bulkDelete':
      (async () => {
        const { ids } = message;
        if (!Array.isArray(ids) || ids.length === 0) {
          sendResponse({ success: false, error: 'No IDs provided' });
          return;
        }
        const idSet = new Set(ids);
        // 从 Chrome 书签中删除
        for (const id of ids) {
          try { await chrome.bookmarks.remove(id); } catch (e) {}
        }
        const bookmarks = await getStoredBookmarks();
        const remaining = bookmarks.filter((b) => !idSet.has(b.id));
        await setStoredBookmarks(remaining);
        sendResponse({ success: true, removed: ids.length, total: remaining.length });
      })();
      return true;

    case 'exportData':
      (async () => {
        const bookmarks = await getStoredBookmarks();
        sendResponse({ success: true, bookmarks });
      })();
      return true;

    case 'importData':
      (async () => {
        const { bookmarks: incoming, mode } = message;
        if (!Array.isArray(incoming) || incoming.length === 0) {
          sendResponse({ success: false, error: 'No bookmarks to import' });
          return;
        }
        const existing = await getStoredBookmarks();
        const result = mode === 'merge'
          ? mergeBookmarks(existing, incoming)
          : { merged: incoming, added: incoming.length };
        // 并发池打标签（仅更新通用文档频率，避免污染标签语料）
        const needsTag = result.merged.filter(item => !item.tags || item.tags.length === 0);
        let tagged = 0;
        try {
          const taggedResults = await autoTagBookmarks(needsTag, 10);
          taggedResults.forEach((res, i) => {
            const tags = res.tags || [];
            needsTag[i].tags = tags;
            needsTag[i].tagsAuto = tags;
          });
          tagged = needsTag.length;
        } catch (e) {
          // 批量打标签失败时保持空标签，不阻塞导入流程
        }
        for (const item of result.merged) {
          if (typeof item.pinned !== 'boolean') item.pinned = false;
        }
        result.merged.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.dateAdded - a.dateAdded);
        await setStoredBookmarks(result.merged);
        sendResponse({ success: true, total: result.merged.length, added: result.added, tagged });
      })();
      return true;

    case 'getTombstones':
      (async () => {
        const retentionDays = await getEffectiveRetentionDays();
        const tombstones = await pruneTombstones(await getTombstones(), retentionDays);
        await setTombstones(tombstones);
        const settings = await getAppSettings();
        sendResponse({ success: true, tombstones, retentionDays, retentionOptions: TOMBSTONE_RETENTION_OPTIONS });
      })();
      return true;

    case 'restoreTombstone':
      (async () => {
        const tombstones = await getTombstones();
        const idx = tombstones.findIndex(t => t.url === message.url && t.dateAdded === message.dateAdded);
        if (idx < 0) {
          sendResponse({ success: false, error: 'Tombstone not found' });
          return;
        }
        const item = tombstones[idx];
        try {
          await chrome.bookmarks.create({
            title: item.title || item.url,
            url: item.url
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
          return;
        }
        tombstones.splice(idx, 1);
        await setTombstones(tombstones);
        sendResponse({ success: true });
      })();
      return true;

    case 'purgeTombstone':
      (async () => {
        const tombstones = await getTombstones();
        const next = tombstones.filter(t => !(t.url === message.url && t.dateAdded === message.dateAdded));
        await setTombstones(next);
        sendResponse({ success: true, total: next.length });
      })();
      return true;

    case 'clearTombstones':
      (async () => {
        await setTombstones([]);
        sendResponse({ success: true });
      })();
      return true;

    case 'getAppSettings':
      (async () => {
        const settings = await getAppSettings();
        sendResponse({ success: true, settings, retentionOptions: TOMBSTONE_RETENTION_OPTIONS });
      })();
      return true;

    case 'updateAppSettings':
      (async () => {
        const { patch } = message;
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'tombstoneRetentionDays')) {
          const days = Number(patch.tombstoneRetentionDays);
          if (!TOMBSTONE_RETENTION_OPTIONS.includes(days)) {
            sendResponse({ success: false, error: 'Invalid retention days' });
            return;
          }
          await setAppSettings({ tombstoneRetentionDays: days });
          // 立即裁剪过期 tombstone
          const tombstones = await getTombstones();
          const pruned = await pruneTombstones(tombstones, days);
          if (pruned.length !== tombstones.length) {
            await setTombstones(pruned);
          }
        } else {
          await setAppSettings(patch || {});
        }
        sendResponse({ success: true });
      })();
      return true;

    case 'getPreview': {
      (async () => {
        const { url, forceRefresh } = message;
        try {
          const result = await getPreview(url, { forceRefresh: !!forceRefresh });
          sendResponse({ success: true, result });
        } catch (e) {
          sendResponse({ success: false, error: String(e && e.message || e) });
        }
      })();
      return true;
    }

    case 'setPreviewCache': {
      (async () => {
        const { url, preview } = message;
        try {
          await setPreviewCache(url, preview);
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: String(e && e.message || e) });
        }
      })();
      return true;
    }

    case 'getPreviewSettings': {
      (async () => {
        const settings = await getPreviewSettings();
        sendResponse({ success: true, settings });
      })();
      return true;
    }

    case 'updatePreviewSettings': {
      (async () => {
        const { patch } = message || {};
        const settings = await setPreviewSettings(patch || {});
        sendResponse({ success: true, settings });
      })();
      return true;
    }

    case 'clearPreviewCache': {
      (async () => {
        await clearPreviewCache();
        sendResponse({ success: true });
      })();
      return true;
    }

    case 'getPreviewCacheStats': {
      (async () => {
        const stats = await getPreviewCacheStats();
        sendResponse({ success: true, stats });
      })();
      return true;
    }

    // ===== AI 增强设置 =====
    case 'getAIConfig': {
      (async () => {
        try {
          const config = await getAIConfig();
          sendResponse({ success: true, config });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'setAIConfig': {
      (async () => {
        try {
          const config = await setAIConfig(message.config || {});
          sendResponse({ success: true, config });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'testAIConnection': {
      (async () => {
        try {
          const result = await testAIConnection(message.config || {});
          sendResponse({ success: true, ...result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'getAIStats': {
      (async () => {
        try {
          const stats = await getAIStats();
          sendResponse({ success: true, stats });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'clearAICache': {
      (async () => {
        try {
          await clearAICache();
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'getAILogs': {
      (async () => {
        try {
          const logs = await getAILogs(message.limit || 50);
          const stats = await getAILogStats();
          sendResponse({ success: true, logs, stats });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'clearAILogs': {
      (async () => {
        try {
          await clearAILogs();
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'recordClick': {
      (async () => {
        const { url } = message;
        if (!url) { sendResponse({ success: false, error: 'No URL' }); return; }
        const bookmarks = await getStoredBookmarks();
        const normalizedUrl = url.replace(/\/+$/, '');
        let found = false;
        for (const item of bookmarks) {
          if (item.url && item.url.replace(/\/+$/, '') === normalizedUrl) {
            item.clickCount = (item.clickCount || 0) + 1;
            item.lastClickedAt = Date.now();
            found = true;
            break;
          }
        }
        if (found) {
          await setStoredBookmarks(bookmarks);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Bookmark not found' });
        }
      })();
      return true;
    }

    case 'refreshClickCounts': {
      (async () => {
        const bookmarks = await getStoredBookmarks();
        const updated = await enrichClickCounts(bookmarks, 10);
        if (updated.length > 0) {
          await setStoredBookmarks(bookmarks);
        }
        sendResponse({ success: true, updated: updated.length });
      })();
      return true;
    }

    case 'suggestFolder': {
      (async () => {
        const { url, title } = message;
        const tempItem = { url: url || '', title: title || '', domain: extractDomain(url || '') };
        const tagResults = autoTagBookmarkSync(tempItem);
        const tags = tagResults.map(t => t.tag);
        const result = await suggestBookmarkFolder(url, title, tags);
        sendResponse({ success: true, folder: result });
      })();
      return true;
    }

    case 'quickBookmark': {
      (async () => {
        await handleQuickBookmark();
        sendResponse({ success: true });
      })();
      return true;
    }

    case 'getCommands': {
      (async () => {
        try {
          const commands = await chrome.commands.getAll();
          sendResponse({ success: true, commands });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ===== 动态规则管理（供 popup 设置页调用） =====
    case 'getDynamicRules': {
      (async () => {
        try {
          const rules = typeof getDynamicRules === 'function'
            ? await getDynamicRules()
            : { domainRules: [], urlPathRules: [], keywordRules: {}, stopWords: [], learnedDomainTag: {} };
          sendResponse({ success: true, rules });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'addDynamicDomainRule': {
      (async () => {
        try {
          const { domains, tag, color } = message;
          if (typeof addDynamicDomainRule === 'function') {
            await addDynamicDomainRule(domains, tag, color);
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'addDynamicKeyword': {
      (async () => {
        try {
          const { tag, keyword } = message;
          if (typeof addDynamicKeyword === 'function') {
            await addDynamicKeyword(tag, keyword);
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'addDynamicStopWord': {
      (async () => {
        try {
          const { word } = message;
          if (typeof addDynamicStopWord === 'function') {
            await addDynamicStopWord(word);
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'removeDynamicDomainRule': {
      (async () => {
        try {
          const { tag } = message;
          if (typeof removeDynamicDomainRule === 'function') {
            await removeDynamicDomainRule(tag);
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'clearLearnedDomainTags': {
      (async () => {
        try {
          if (typeof clearLearnedDomainTags === 'function') {
            await clearLearnedDomainTags();
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'saveDynamicRules': {
      (async () => {
        try {
          const { rules } = message;
          if (typeof saveDynamicRules === 'function') {
            await saveDynamicRules(rules);
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // ===== 主动学习（Active Learning）消息处理 =====
    case 'getReviewQueue': {
      (async () => {
        try {
          const queue = typeof getReviewQueue === 'function'
            ? await getReviewQueue()
            : [];
          sendResponse({ success: true, queue });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'confirmTagReview': {
      (async () => {
        try {
          const { queueItem, confirmedTags, reviewAction } = message;
          if (typeof onUserConfirmTag === 'function') {
            await onUserConfirmTag(queueItem, confirmedTags, reviewAction);
          }

          // 同步更新已保存书签的 tags，确保插件主页显示最新标签
          if (queueItem && queueItem.url && confirmedTags && confirmedTags.length > 0) {
            try {
              const stored = await getStoredBookmarks();
              let updated = false;
              for (const item of stored) {
                if (item.url && item.url === queueItem.url) {
                  item.tags = [...confirmedTags];
                  item.tagsAuto = [...confirmedTags];
                  updated = true;
                }
              }
              if (updated) {
                await setStoredBookmarks(stored);
                chrome.runtime.sendMessage({
                  action: 'bookmarksUpdated',
                  bookmarks: stored
                }).catch(() => {});
              }
            } catch (e) {
              // 静默失败，不影响确认流程
            }
          }

          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'ignoreTagReview': {
      (async () => {
        try {
          const { queueItem } = message;
          if (typeof onUserConfirmTag === 'function') {
            await onUserConfirmTag(queueItem, [], 'ignored');
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'getLearningStats': {
      (async () => {
        try {
          const stats = typeof getLearningStats === 'function'
            ? await getLearningStats()
            : { totalReviewed: 0, totalAccepted: 0, totalModified: 0, totalIgnored: 0 };
          sendResponse({ success: true, stats });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'getLearningTrend': {
      (async () => {
        try {
          const trend = typeof getLearningTrend === 'function'
            ? await getLearningTrend(message.days || 30)
            : [];
          sendResponse({ success: true, trend });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'getHealthScoreFavorites': {
      (async () => {
        try {
          const favorites = await getHealthScoreFavorites();
          sendResponse({ success: true, favorites });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'saveHealthScoreFavorite': {
      (async () => {
        try {
          const result = await saveHealthScoreFavorite(message.record);
          sendResponse(result);
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'deleteHealthScoreFavorite': {
      (async () => {
        try {
          const result = await deleteHealthScoreFavorite(message.id);
          sendResponse(result);
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'clearReviewQueue': {
      (async () => {
        try {
          if (typeof clearReviewQueue === 'function') {
            await clearReviewQueue();
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
  }
});

// ===== 书签事件监听 =====
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  if (bookmark.url) {
    addSingleBookmark(id).then((item) => {
      if (item) {
        chrome.runtime.sendMessage({
          action: 'bookmarkAdded',
          bookmark: item
        }).catch(() => {}); // popup 可能未打开
      }
    });
  }
});

chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  updateBookmark(id, changeInfo);
});

// 监听书签移动：用户手动将书签移入某目录时，自动学习"域名→目录名(标签)"映射
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  (async () => {
    try {
      const bookmark = await chrome.bookmarks.get(id);
      if (!bookmark || !bookmark[0] || !bookmark[0].url) return;
      const b = bookmark[0];
      // 获取新的父目录名
      const parent = await chrome.bookmarks.get(moveInfo.parentId);
      if (!parent || !parent[0] || !parent[0].title) return;
      const folderName = parent[0].title;
      // 跳过根目录（书签栏/其他书签等），只学习有意义的子目录
      const rootNames = ['书签栏', '其他书签', 'Other bookmarks', 'Bookmarks bar', ''];
      if (rootNames.includes(folderName)) return;

      const domain = extractDomain(b.url);
      if (!domain) return;

      // 学习域名→标签映射（动态规则层）
      if (typeof learnDomainTag === 'function') {
        await learnDomainTag(domain, folderName);
      }
    } catch (e) {
      // 静默失败，不影响书签移动
    }
  })();
});

chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  // 从存储中移除并写入 tombstone
  getStoredBookmarks().then(async (bookmarks) => {
    const target = bookmarks.find((b) => b.id === id);
    const filtered = bookmarks.filter((b) => b.id !== id);
    if (filtered.length !== bookmarks.length) {
      await setStoredBookmarks(filtered);
      if (target) await addTombstone(target);
    } else if (removeInfo && removeInfo.node && removeInfo.node.url && target) {
      // 已经被过滤了也要写 tombstone
      await addTombstone(target);
    }
  });
});

// ===== 定时检测失效书签 =====
const CHECKER_ALARM_PREFIX = 'bookmark_checker_';

// ===== 失效检测 - 后台绕过 CORS =====
//
// 检测策略：
//   1) 总超时预算（timeoutMs）控制单 URL 总耗时，避免拖慢整批。
//   2) 先 HEAD 探测：2xx/3xx 立即返回；4xx/5xx 也降级 GET（部分服务器 HEAD 405/501）。
//   3) GET 失败按"瞬时 vs 业务"分类：仅瞬时错误（Timeout/Failed to fetch/net::/ERR_*）
//      和 5xx 触发重试；4xx 等业务错误直接判定 broken，不再重试。
//   4) 指数退避 + 抖动（full jitter），防雪崩。
//   5) 单次请求也受 perAttemptMs 上限约束，绝不超过剩余预算。
//
// 旧调用方式 `checkUrlFromBackground(url, timeoutMs)` 仍可用（timeoutMs 作为总预算）。

// 判定是否为可重试的瞬时错误
function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true; // 超时
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('err_name') ||           // DNS 解析失败
    msg.includes('err_internet') ||       // 离线
    msg.includes('err_connection') ||      // 连接被重置/拒绝
    msg.includes('err_timed_out') ||
    msg.includes('err_ssl') ||            // TLS 握手失败
    msg.includes('err_aborted') ||
    msg.includes('net::')                 // 旧 Chromium 错误前缀
  );
}

// HTTP 状态码是否值得重试：0=无响应、5xx、429/408/425
function isRetryableHttpStatus(status) {
  if (!status) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

// 业务错误（4xx）：不重试，直接判定
function isBusinessError(status) {
  return status >= 400 && status < 500;
}

// 指数退避 + 抖动（full jitter）
function backoffMs(attempt, baseMs, maxMs) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * (exp + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 发起单次请求；受 deadline + perAttempt 双重约束
async function fetchOnce(url, method, deadlineMs, perAttemptMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    const e = new Error('deadline exceeded');
    e.name = 'AbortError';
    return { ok: false, error: e };
  }
  const controller = new AbortController();
  const timeout = Math.min(perAttemptMs, remaining);
  const tid = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(tid);
    return { ok: true, status: response.status };
  } catch (err) {
    clearTimeout(tid);
    return { ok: false, error: err };
  }
}

// HTTP 状态码 → 检测结果
function classifyByStatus(status) {
  if (status >= 200 && status < 400) {
    return { status: 'ok', statusCode: status, message: `HTTP ${status}` };
  }
  if (status === 404) {
    return { status: 'broken', statusCode: status, message: '404 Not Found' };
  }
  if (status >= 400 && status < 500) {
    return { status: 'broken', statusCode: status, message: `HTTP ${status} - Client Error` };
  }
  if (status >= 500) {
    return { status: 'broken', statusCode: status, message: `HTTP ${status} - Server Error` };
  }
  return { status: 'ok', statusCode: status, message: `HTTP ${status}` };
}

/**
 * 检测单个 URL 是否失效
 * @param {string} url
 * @param {number|object} [timeoutOrOptions] - 兼容旧调用：直接传总超时（ms）
 *   options: {
 *     timeoutMs,      // 总预算（默认 10000）
 *     perAttemptMs,   // 单次请求上限（默认 5000）
 *     retries,        // GET 失败时额外重试次数（默认 2）
 *     baseDelayMs,    // 退避基准（默认 800）
 *     maxDelayMs      // 退避上限（默认 3000）
 *   }
 */
async function checkUrlFromBackground(url, timeoutOrOptions) {
  const opts = (typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null)
    ? timeoutOrOptions
    : { timeoutMs: timeoutOrOptions };
  const {
    timeoutMs = 10000,
    perAttemptMs = 5000,
    retries = 2,
    baseDelayMs = 800,
    maxDelayMs = 3000,
  } = opts;

  const deadline = Date.now() + timeoutMs;

  // ---- 1) HEAD 探测 ----
  const head = await fetchOnce(url, 'HEAD', deadline, perAttemptMs);
  if (head.ok) {
    // 2xx/3xx 直接成功
    if (head.status < 400) return classifyByStatus(head.status);
    // 4xx 业务错误：仍尝试一次 GET（HEAD 405/501 时 GET 可能正常）
    // 5xx 也降级 GET（服务器短暂不可用，GET 或许能拿到不同结果）
  } else if (!isTransientError(head.error)) {
    // 非瞬时错误（如 TypeError 编程错误）：再尝试一次 GET
  }
  // 其余情况（HEAD 瞬时错误 / HEAD 4xx-5xx）→ 走 GET 重试链

  // ---- 2) GET 重试链 ----
  let attempts = 0;
  let lastError = null; // { type: 'http'|'network', status?, error? }

  while (true) {
    // 预算已耗尽
    if (Date.now() >= deadline) {
      return { status: 'warning', statusCode: 0, message: 'Total timeout' };
    }

    if (attempts > 0) {
      const wait = backoffMs(attempts - 1, baseDelayMs, maxDelayMs);
      const remaining = deadline - Date.now();
      if (wait >= remaining) {
        return { status: 'warning', statusCode: 0, message: 'Total timeout' };
      }
      await sleep(wait);
    }

    const get = await fetchOnce(url, 'GET', deadline, perAttemptMs);
    if (get.ok) {
      // 2xx/3xx / 4xx 业务错误 → 立即返回
      if (get.status < 400 || isBusinessError(get.status)) {
        return classifyByStatus(get.status);
      }
      // 5xx → 可重试
      lastError = { type: 'http', status: get.status };
    } else {
      const err = get.error;
      // 整体超时（被 deadline 截断的 AbortError）
      if (err.name === 'AbortError' && Date.now() >= deadline) {
        return { status: 'warning', statusCode: 0, message: 'Total timeout' };
      }
      // 非瞬时错误：直接返回 warning，不重试
      if (!isTransientError(err)) {
        return { status: 'warning', statusCode: 0, message: 'Network Error' };
      }
      // 瞬时错误 → 可重试
      lastError = { type: 'network', error: err };
    }

    attempts++;
    if (attempts > retries) break;
  }

  // ---- 3) 重试耗尽：返回最终结果 ----
  if (lastError && lastError.type === 'http') {
    return classifyByStatus(lastError.status);
  }
  const msg = ((lastError && lastError.error && lastError.error.message) || '').toLowerCase();
  if (
    msg.includes('failed to fetch') ||
    msg.includes('err_name') ||
    msg.includes('err_internet') ||
    msg.includes('err_connection') ||
    msg.includes('net::')
  ) {
    return { status: 'broken', statusCode: 0, message: 'DNS/Network Error' };
  }
  return { status: 'warning', statusCode: 0, message: 'Network Error' };
}

async function getCheckSettings() {
  const defaults = {
    checkerTimeout: 10000,
    checkerFrequency: 'never',
    checkerConcurrency: 5,
    checkerTime: '03:00',
    checkerAutoDelete: false,
    checkerRetries: 2,
    checkerBackoffBase: 800,
    checkerBackoffMax: 3000
  };
  const result = await chrome.storage.local.get(Object.keys(defaults));
  return { ...defaults, ...result };
}

async function scheduleCheckerAlarm() {
  // 清除所有现有检测闹钟
  const existingAlarms = await chrome.alarms.getAll();
  for (const alarm of existingAlarms) {
    if (alarm.name.startsWith(CHECKER_ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  const settings = await getCheckSettings();
  const frequency = settings.checkerFrequency;

  if (frequency === 'never') return;

  // 解析用户设定的检测时间，默认 03:00
  const checkTime = settings.checkerTime || '03:00';
  const [hours, minutes] = checkTime.split(':').map(Number);

  // 计算距离下次目标时间的分钟数
  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  if (frequency === 'daily') {
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
  } else if (frequency === 'weekly') {
    const dayOfWeek = Number(settings.checkerDayOfWeek ?? 1);
    const currentDay = target.getDay();
    const diff = (dayOfWeek - currentDay + 7) % 7;
    target.setDate(target.getDate() + diff);
    if (target <= now) {
      target.setDate(target.getDate() + 7);
    }
  } else if (frequency === 'monthly') {
    const dayOfMonth = Math.max(1, Number(settings.checkerDayOfMonth ?? 1));
    const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(dayOfMonth, daysInMonth));
    if (target <= now) {
      target.setMonth(target.getMonth() + 1);
      const nextDaysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(dayOfMonth, nextDaysInMonth));
    }
  }

  let periodInMinutes;
  switch (frequency) {
    case 'daily': periodInMinutes = 24 * 60; break;
    case 'weekly': periodInMinutes = 7 * 24 * 60; break;
    case 'monthly': periodInMinutes = 30 * 24 * 60; break;
    default: return;
  }

  const delayInMinutes = Math.max(1, Math.round((target - now) / 60000));

  await chrome.alarms.create(CHECKER_ALARM_PREFIX + frequency, {
    delayInMinutes: delayInMinutes,
    periodInMinutes: periodInMinutes
  });
}

// 闹钟触发时执行后台检测
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(CHECKER_ALARM_PREFIX)) return;

  const settings = await getCheckSettings();
  const timeout = settings.checkerTimeout || 10000;
  const concurrency = settings.checkerConcurrency || 5;

  const bookmarks = await getStoredBookmarks();
  if (bookmarks.length === 0) return;

  let index = 0;
  const results = [];

  // 共享检测配置：总预算来自用户设置，perAttempt 限制为预算的一半避免单次吃光
  const checkOptions = {
    timeoutMs: timeout,
    perAttemptMs: Math.max(2000, Math.floor(timeout / 2)),
    retries: settings.checkerRetries ?? 2,
    baseDelayMs: settings.checkerBackoffBase ?? 800,
    maxDelayMs: settings.checkerBackoffMax ?? 3000
  };

  async function processNext() {
    while (index < bookmarks.length) {
      const currentIndex = index++;
      const bm = bookmarks[currentIndex];
      const checkResult = await checkUrlFromBackground(bm.url, checkOptions);
      results.push({ bookmark: bm, status: checkResult.status, message: checkResult.message });
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(processNext());
  }
  await Promise.all(workers);

  // 保存检测结果
  const summary = {
    timestamp: Date.now(),
    total: results.length,
    ok: results.filter(r => r.status === 'ok').length,
    broken: results.filter(r => r.status === 'broken').length,
    warning: results.filter(r => r.status === 'warning').length,
    brokenUrls: results.filter(r => r.status === 'broken').map(r => ({
      id: r.bookmark.id,
      title: r.bookmark.title,
      url: r.bookmark.url,
      message: r.message
    }))
  };
  await chrome.storage.local.set({ checkerLastResult: summary });

  // 自动删除失效书签（需用户开启）
  const autoDelete = settings.checkerAutoDelete;
  if (autoDelete && summary.broken > 0) {
    for (const item of results.filter(r => r.status === 'broken')) {
      try {
        await chrome.bookmarks.remove(item.bookmark.id);
      } catch (e) {
        // 书签可能已被手动删除
      }
    }
    // 从本地存储中同步移除
    const storedBookmarks = await getStoredBookmarks();
    const brokenIds = new Set(results.filter(r => r.status === 'broken').map(r => r.bookmark.id));
    const remaining = storedBookmarks.filter(b => !brokenIds.has(b.id));
    await setStoredBookmarks(remaining);

    // 更新检测结果（已删除）
    summary.autoDeleted = summary.broken;
    summary.broken = 0;
    summary.brokenUrls = [];
    await chrome.storage.local.set({ checkerLastResult: summary });

    chrome.notifications?.create({
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: 'Markline',
      message: `已自动删除 ${summary.autoDeleted} 个失效书签`
    });
  } else if (summary.broken > 0) {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: 'Markline',
      message: `检测到 ${summary.broken} 个失效书签，点击查看详情`
    });
  }
});

// ===== 扩展安装/启动时自动同步 =====
chrome.runtime.onInstalled.addListener(() => {
  syncAllBookmarks();
  scheduleCheckerAlarm();
  // 预加载智能标签缓存（使 autoTagBookmarkSync 可同步运行）
  if (typeof preloadSmartTaggerCaches === 'function') {
    preloadSmartTaggerCaches();
  }

  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'bookmark-this-page',
    title: '为当前页面添加书签',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'remove-bookmark-this-page',
    title: '移除当前页面书签',
    contexts: ['page']
  });
});

// 右键菜单点击处理
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'bookmark-this-page' && tab && tab.url) {
    // 复用一键收藏的智能标签 + 目录建议逻辑
    await handleQuickBookmark(tab);
    return;
  }
  
  // 处理移除书签
  if (info.menuItemId === 'remove-bookmark-this-page' && tab && tab.url) {
    try {
      // 查找当前页面的书签
      const existing = await chrome.bookmarks.search({ url: tab.url });
      
      if (existing.length === 0) {
        chrome.notifications?.create({
          type: 'basic',
          iconUrl: '../icons/icon48.png',
          title: 'Markline',
          message: '该页面未在书签中'
        });
        return;
      }

      // 删除所有匹配的书签（可能有重复）
      for (const bookmark of existing) {
        await chrome.bookmarks.remove(bookmark.id);
      }

      // 从时间轴存储中删除
      const stored = await getStoredBookmarks();
      const filtered = stored.filter(b => b.url !== tab.url);
      await setStoredBookmarks(filtered);

      // 通知 popup 刷新
      chrome.runtime.sendMessage({
        action: 'bookmarksDeleted',
        urls: [tab.url]
      }).catch(() => {});

      // 显示成功通知
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: 'Markline',
        message: `已移除: ${tab.title || tab.url}`
      });
    } catch (err) {
      console.error('右键移除书签失败:', err);
    }
  }
});

// ===== 点击计数追踪：监听标签页导航 =====
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome-extension://')) {
    const normalizedUrl = tab.url.replace(/\/+$/, '');
    getStoredBookmarks().then(bookmarks => {
      for (const item of bookmarks) {
        if (item.url && item.url.replace(/\/+$/, '') === normalizedUrl) {
          item.clickCount = (item.clickCount || 0) + 1;
          item.lastClickedAt = Date.now();
          setStoredBookmarks(bookmarks).catch(() => {});
          break;
        }
      }
    }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncAllBookmarks();
  scheduleCheckerAlarm();
  // 预加载智能标签缓存（使 autoTagBookmarkSync 可同步运行）
  if (typeof preloadSmartTaggerCaches === 'function') {
    preloadSmartTaggerCaches();
  }
});

// ===== 全局快捷键：打开命令面板 / 弹窗 / 一键收藏 =====
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-command-palette') {
    // 命令面板：打开或聚焦 popup
    try {
      await chrome.action.openPopup();
    } catch (e) {
      // openPopup 不可用时回退
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/popup/popup.html') });
    }
    // 通知 popup 打开命令面板
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'openCommandPalette' }).catch(() => {});
    }, 50);
  } else if (command === 'open-popup') {
    try {
      await chrome.action.openPopup();
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('pages/popup/popup.html') });
    }
  } else if (command === 'quick-bookmark') {
    await handleQuickBookmark();
  }
});

// ===== 一键收藏：自动建议目录 =====
// activeTab: 可选，由调用方（如右键菜单）传入已知的 tab，避免重复查询
async function handleQuickBookmark(activeTab) {
  try {
    const tab = activeTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    const { notificationEnabled } = await chrome.storage.local.get(['notificationEnabled']);

    // 检查是否已收藏
    const existing = await chrome.bookmarks.search({ url: tab.url });
    if (existing.length > 0) {
      if (notificationEnabled) {
        chrome.notifications?.create({
          type: 'basic',
          iconUrl: '../icons/icon48.png',
          title: 'Markline',
          message: '该页面已在书签中'
        });
      }
      return;
    }

    // 提取当前页正文（失败也不阻塞收藏）
    const contentData = (tab.id && tab.url) ? await extractActiveTabContent(tab.id, tab.url) : null;

    // 预计算标签（同步，缓存已预加载）——只调用一次，避免竞态
    const tempItem = {
      url: tab.url,
      title: tab.title,
      domain: extractDomain(tab.url),
      contentText: contentData?.textContent || '',
      metaDesc: contentData?.metaDesc || '',
      excerpt: contentData?.excerpt || contentData?.metaDesc || ''
    };
    const tags = autoTagBookmarkSync(tempItem);
    const tagNames = tags.map(t => t.tag);

    // 智能建议目录（复用上面计算的标签，保证标签与目录一致）
    const suggestedFolder = await suggestBookmarkFolder(tab.url, tab.title, tagNames);

    // 暂存标签和文件夹信息，供 onCreated → addSingleBookmark 消费（唯一写入路径）
    pendingQuickBookmarks.set(tab.url, {
      tags: tagNames,
      folderName: suggestedFolder?.title || '',
      folderPath: suggestedFolder?.path || '',
      ruleTags: tags,
      contentText: contentData?.textContent || '',
      metaDesc: contentData?.metaDesc || '',
      excerpt: tempItem.excerpt || ''
    });

    // 创建书签到建议目录（触发 onCreated → addSingleBookmark 写入本地存储）
    const createOpts = {
      title: tab.title || tab.url,
      url: tab.url
    };
    if (suggestedFolder && suggestedFolder.id) {
      createOpts.parentId = suggestedFolder.id;
    }
    const createdBookmark = await chrome.bookmarks.create(createOpts);

    // 增量更新通用文档频率（TF-IDF 用，不依赖标签，可安全 fire-and-forget）
    const dfText = `${tab.title || ''} ${contentData?.textContent?.slice(0, 1000) || ''} ${tab.url || ''}`;
    if (typeof updateDocFrequency === 'function') {
      updateDocFrequency(dfText, tab.url); // fire-and-forget，带 URL 去重
    }

    // 主动学习：判断是否需要人工确认
    if (typeof needsHumanReview === 'function' && typeof addToReviewQueue === 'function') {
      const review = needsHumanReview(tags, tempItem);
      if (review.need) {
        addToReviewQueue({
          id: createdBookmark.id,
          url: tab.url,
          title: tab.title || tab.url,
          domain: tempItem.domain,
          suggestedTags: tagNames,
          confidence: tags[0]?.confidence || 0,
          score: tags[0]?.score || 0,
          reason: review.reason,
          excerpt: tempItem.excerpt || '',
          createdAt: Date.now()
        }); // fire-and-forget
      }
    }

    // 标记该域名已被系统见过，避免 new_domain 反复触发
    if (typeof markDomainSeen === 'function' && tempItem.domain) {
      markDomainSeen(tempItem.domain).catch(() => {});
    }

    // 成功通知统一在 addSingleBookmark 中根据 notificationEnabled 发送
  } catch (err) {
    console.error('快捷键收藏失败:', err);
  }
}

// ===== 智能建议目录 =====
// suggestedTags: 已由调用方通过 autoTagBookmarkSync 计算好的标签数组
async function suggestBookmarkFolder(url, title, suggestedTags) {
  try {
    // 没有标签 → 放到 Chrome 书签默认目录（书签栏根目录）
    if (!suggestedTags || suggestedTags.length === 0) return null;

    // 2. 优先按主标签名查找或创建同名目录（有则放入，无则创建）
    //    避免 folderScore 被历史误存的路径（如"新建文件夹"）污染
    const primaryTag = suggestedTags[0];
    const folderInfo = await findOrCreateFolder(primaryTag);
    if (folderInfo) {
      return { id: folderInfo.id, title: primaryTag, path: folderInfo.path };
    }

    // 3. 创建失败 → 按已有书签的同标签目录分布后备匹配
    const stored = await getStoredBookmarks();
    const folderScore = new Map(); // folderPath -> { count, folderName, folderPath }

    for (const item of stored) {
      if (!item.tags || item.tags.length === 0 || !item.folderPath) continue;
      const overlap = item.tags.filter(t => suggestedTags.includes(t)).length;
      if (overlap > 0) {
        const key = item.folderPath;
        if (!folderScore.has(key)) {
          folderScore.set(key, { count: 0, folderName: item.folderName, folderPath: item.folderPath });
        }
        folderScore.get(key).count += overlap;
      }
    }

    // 4. 有匹配的目录，返回得分最高的
    if (folderScore.size > 0) {
      const sorted = [...folderScore.values()].sort((a, b) => b.count - a.count);
      const best = sorted[0];
      // 查找对应的 Chrome 书签文件夹 ID
      const folderId = await findFolderIdByPath(best.folderPath);
      return { id: folderId, title: best.folderName, path: best.folderPath };
    }

    // 5. 都没有，返回 null → 保存到默认目录
    return null;
  } catch (err) {
    console.error('建议目录失败:', err);
    return null;
  }
}

// 在整棵书签树中递归查找指定名称的文件夹，返回 { node, path }
function findFolderInTree(nodes, name, path = '') {
  if (!nodes) return null;
  for (const node of nodes) {
    const currentPath = path ? `${path}/${node.title}` : node.title;
    if (node.title === name && !node.url) {
      return { node, path: currentPath };
    }
    if (node.children) {
      const found = findFolderInTree(node.children, name, currentPath);
      if (found) return found;
    }
  }
  return null;
}

// 根据路径查找 Chrome 书签文件夹 ID
async function findFolderIdByPath(path) {
  try {
    const tree = await chrome.bookmarks.getTree();
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    // 1. 先尝试精确路径匹配（从根节点逐层向下）
    let nodes = tree[0].children || [];
    let result = null;
    for (const part of parts) {
      const found = nodes.find(n => n.title === part && n.children);
      if (!found) { result = null; break; }
      nodes = found.children || [];
      if (part === parts[parts.length - 1]) result = found;
    }
    if (result) return result.id;

    // 2. 精确匹配失败，按最后一层目录名在整棵树中递归查找
    //    （兼容仅含文件夹名的相对路径，如 "AI"）
    const lastName = parts[parts.length - 1];
    const found = findFolderInTree(tree, lastName);
    return found ? found.node.id : null;
  } catch {
    return null;
  }
}

// 查找或创建一级子目录（优先在整棵书签树中查找同名文件夹）
async function findOrCreateFolder(name) {
  try {
    const tree = await chrome.bookmarks.getTree();

    // 1. 在整棵书签树中递归查找已有同名文件夹（书签栏 / 其他书签等均覆盖）
    const existing = findFolderInTree(tree, name);
    if (existing) {
      return { id: existing.node.id, path: existing.path };
    }

    // 2. 未找到，在书签栏下创建新文件夹
    const bookmarkBar = tree[0].children?.[0]; // 书签栏
    if (!bookmarkBar) return null;

    const folder = await chrome.bookmarks.create({
      parentId: bookmarkBar.id,
      title: name
    });
    return { id: folder.id, path: `${bookmarkBar.title}/${name}` };
  } catch {
    return null;
  }
}

// ===== 地址栏 Omni 搜索 =====
chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({
    description: '搜索 Markline 书签...'
  });
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  if (!text || !text.trim()) {
    suggest([]);
    return;
  }

  getStoredBookmarks().then(bookmarks => {
    const query = text.trim().toLowerCase();
    const results = [];

    for (const item of bookmarks) {
      const titleMatch = (item.title || '').toLowerCase().includes(query);
      const urlMatch = (item.url || '').toLowerCase().includes(query);
      const domainMatch = (item.domain || '').toLowerCase().includes(query);
      const tagMatch = (item.tags || []).some(t => t.toLowerCase().includes(query));

      if (titleMatch || urlMatch || domainMatch || tagMatch) {
        // 评分：标题 > 标签 > 域名 > URL
        let score = 0;
        if (titleMatch) score += 100;
        if (tagMatch) score += 60;
        if (domainMatch) score += 30;
        if (urlMatch) score += 20;

        results.push({ item, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 6);

    suggest(top.map(({ item }) => ({
      content: item.url,
      description: `<url>${escapeXml(item.domain)}</url> · <match>${escapeXml(item.title || item.url)}</match>${item.tags && item.tags.length ? ' · ' + item.tags.slice(0, 3).map(t => '#' + escapeXml(t)).join(' ') : ''}`
    })));
  }).catch(() => suggest([]));
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  // text 可能是选中的建议 URL，也可能是用户直接输入的搜索词
  const url = text.startsWith('http') ? text : `https://www.google.com/search?q=${encodeURIComponent(text)}`;

  switch (disposition) {
    case 'currentTab':
      chrome.tabs.update({ url });
      break;
    case 'newForegroundTab':
      chrome.tabs.create({ url });
      break;
    case 'newBackgroundTab':
      chrome.tabs.create({ url, active: false });
      break;
  }
});

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}