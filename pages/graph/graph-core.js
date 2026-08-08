// ===== 知识图谱 · 共享数据层 =====
// 提供给 2D/3D 渲染器共用的:数据加载、关联分析、聚类计算、搜索、状态管理
// 渲染器只需实现统一接口,数据层无感知

const GraphCore = (() => {

// ===== 状态 =====
let bookmarks = [];
let clusterMap = new Map();
let tagColorCache = new Map();
let currentClusterBy = 'domain';

// ===== 主题检测 =====
function applyThemeClass(theme) {
  const isDark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-dark', isDark);
  document.body.classList.toggle('theme-light', !isDark);
}

async function detectTheme() {
  const result = await chrome.storage.local.get('theme');
  applyThemeClass(result.theme || 'system');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) applyThemeClass(changes.theme.newValue || 'system');
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
  const result = await chrome.storage.local.get('theme');
  if ((result.theme || 'system') === 'system') applyThemeClass('system');
});

// ===== 工具函数 =====
function isDarkTheme() {
  return document.body.classList.contains('theme-dark');
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const URL_STOP_WORDS = new Set(['http', 'https', 'www', 'com', 'cn', 'org', 'net', 'io']);

function tokenize(text) {
  if (!text) return new Set();
  const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, ' ');
  const tokens = new Set();
  cleaned.split(/\s+/).forEach(w => {
    if (w.length >= 2 && typeof STOP_WORDS !== 'undefined' && !STOP_WORDS.has(w) && !URL_STOP_WORDS.has(w)) tokens.add(w);
    else if (w.length >= 2 && typeof STOP_WORDS === 'undefined' && !URL_STOP_WORDS.has(w)) tokens.add(w);
  });
  const cjk = cleaned.match(/[\u4e00-\u9fa5]+/g) || [];
  cjk.forEach(seg => {
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.substring(i, i + 2));
    for (let i = 0; i < seg.length; i++) tokens.add(seg[i]);
  });
  return tokens;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  const smaller = setA.size < setB.size ? setA : setB;
  const larger = setA.size < setB.size ? setB : setA;
  for (const item of smaller) { if (larger.has(item)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function cosineSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  const smaller = setA.size < setB.size ? setA : setB;
  const larger = setA.size < setB.size ? setB : setA;
  for (const item of smaller) { if (larger.has(item)) intersection++; }
  return intersection / Math.sqrt(setA.size * setB.size);
}

function urlPathSimilarity(urlA, urlB) {
  if (!urlA || !urlB) return 0;
  try {
    const segA = new URL(urlA).pathname.split('/').filter(s => s.length > 0);
    const segB = new URL(urlB).pathname.split('/').filter(s => s.length > 0);
    if (segA.length === 0 || segB.length === 0) return 0;
    let common = 0;
    const minLen = Math.min(segA.length, segB.length);
    for (let i = 0; i < minLen; i++) { if (segA[i] === segB[i]) common++; else break; }
    return common / Math.max(segA.length, segB.length);
  } catch { return 0; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== 颜色生成 =====
const CLUSTER_PALETTE = [
  '#4263eb', '#e8590c', '#2f9e44', '#f08c00', '#9c36b5',
  '#0c8599', '#c92a2a', '#5c940d', '#e64980', '#1864ab',
  '#d9480f', '#087f5b', '#6741d9', '#e67700', '#364fc7',
  '#c2255c', '#5a9e6f', '#d6336c', '#3b5bdb', '#ae3ec9'
];

// 边分组颜色
const EDGE_GROUP_COLORS = {
  domain: '#a0b3dc',
  tag: '#90e190',
  similar: '#f6c384'
};

function colorForCluster(key, index) {
  if (index < CLUSTER_PALETTE.length) return CLUSTER_PALETTE[index];
  let hash = 0;
  for (let i = 0; i < key.length; i++) { hash = ((hash << 5) - hash) + key.charCodeAt(i); hash |= 0; }
  return `hsl(${Math.abs(hash) % 360}, 65%, 50%)`;
}

function hexToRgb(hex) {
  if (!hex) return [107, 114, 128];
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ===== 大图阈值(成本模型 × 时间预算 动态推导) =====
// 业界通用做法:阈值不硬编码,而是"单次操作成本 × 允许的时间预算"反推节点规模。
// 数据量变化时分级自动适配,无需手工调参。
const FULL_CONNECT_LIMIT = 12;   // 小组(< 此数)直接全连接
const KNN_K = 6;                 // KNN 每节点保留的连接数

// 成本估算(单次操作,μs 级;基于本机实测校准,可按需调整)
const COST = {
  SIM_OP_US: 1,             // 单次 token 相似度(jaccard/cosine)比较
  NODE_LAYOUT_ITER_US: 2,   // 布局中单个节点单次迭代
  EDGE_LAYOUT_ITER_US: 1,   // 布局中单条边单次迭代
  NODE_RENDER_US: 2         // 单帧渲染单个节点
};

// 时间预算(ms)
const BUDGET = {
  SIM_FULL_MODE_MS: 2000,   // 全量 linkBySimilar 的数据准备预算(超出即降级)
  GROUP_KNN_MS: 8,          // 单个大组 KNN 预算(约半帧)
  LAYOUT_MS: 1800,          // 布局总预算
  RENDER_FRAME_MS: 10       // 静态全帧渲染预算
};

const LAYOUT_ITER_MIN = 150;  // 布局迭代下限(保证收敛质量)
const LAYOUT_ITER_MAX = 500;  // 布局迭代上限
const SIM_PAIR_BUDGET = 150000;  // 中等图 linkBySimilar 候选配对上限(防止阈值前爆量)

// 按节点数计算各级阈值与资源预算
function computeGraphThresholds(nodeCount) {
  // 1) 全量相似模式阈值:配对成本按最坏情况 N²/2 建模,
  //    N²/2 × SIM_OP_US ≤ SIM_FULL_MODE_MS → N ≤ sqrt(2·BUDGET·1000/COST)
  const largeGraphThreshold = Math.floor(Math.sqrt(2 * BUDGET.SIM_FULL_MODE_MS * 1000 / COST.SIM_OP_US));
  // 2) 超大图阈值:全量节点渲染成本 N × NODE_RENDER_US ≤ RENDER_FRAME_MS 时折叠聚类
  const hugeGraphThreshold = Math.floor(BUDGET.RENDER_FRAME_MS * 1000 / COST.NODE_RENDER_US);
  // 3) 中等图阈值:largeGraph 的 1/5(更早开启节流)
  const mediumGraphThreshold = Math.max(150, Math.floor(largeGraphThreshold / 5));
  // 4) 大组采样阈值:KNN 成本 g²/2 × SIM_OP_US ≤ GROUP_KNN_MS → g ≤ sqrt(2·BUDGET·1000/COST)
  const sampleGroupLimit = Math.floor(Math.sqrt(2 * BUDGET.GROUP_KNN_MS * 1000 / COST.SIM_OP_US));
  // 5) 大组采样连接数:随规模对数增长(更大图需更密的组内连接维持盘丝错节),封顶防膨胀
  const sampleK = Math.min(6, Math.max(3, Math.round(Math.log2(nodeCount) - 6)));
  // 6) 布局迭代数:numIter × N × NODE_LAYOUT_ITER_US ≤ LAYOUT_MS
  const numIter = Math.min(LAYOUT_ITER_MAX, Math.max(LAYOUT_ITER_MIN, Math.round(BUDGET.LAYOUT_MS * 1000 / (nodeCount * COST.NODE_LAYOUT_ITER_US))));
  // 7) 边预算(双约束取小):
  //    视觉约束:平均度随规模对数增长(稀疏图经验) → N × avgDegreeCap/2
  //    计算约束:numIter × E × EDGE_LAYOUT_ITER_US ≤ LAYOUT_MS(保证布局不超时)
  const avgDegreeCap = Math.min(8, Math.max(3, Math.log2(nodeCount) - 6));
  const densityEdgeCap = Math.round(nodeCount * avgDegreeCap / 2);
  const layoutEdgeCap = Math.floor(BUDGET.LAYOUT_MS * 1000 / (numIter * COST.EDGE_LAYOUT_ITER_US));
  const edgeBudget = Math.max(6000, Math.min(densityEdgeCap, layoutEdgeCap));

  const largeGraph = nodeCount >= largeGraphThreshold;
  const hugeGraph = nodeCount >= hugeGraphThreshold;
  const mediumGraph = nodeCount >= mediumGraphThreshold;
  return {
    largeGraph, hugeGraph, mediumGraph,
    largeGraphThreshold, hugeGraphThreshold, mediumGraphThreshold,
    edgeBudget, sampleGroupLimit, sampleK, numIter
  };
}

// ===== 关联分析引擎 =====
function buildGraphElements(bookmarks, options) {
  const { linkByDomain, linkByTag, linkBySimilar, hugeGraph, largeGraph, edgeBudget, sampleGroupLimit, sampleK } = options;
  const elements = [];
  const tokenCache = new Map();
  const nodeIndex = new Map();

  for (const b of bookmarks) {
    const domain = b.domain || extractDomain(b.url);
    const node = {
      id: b.id,
      title: b.title || b.url || '',
      url: b.url,
      domain,
      tags: b.tags || [],
      folder: b.folderName || '',
      cluster: ''
    };
    nodeIndex.set(b.id, node);
    // 大图模式下 token 仅用于聚类显示,不再用于相似度计算 → 跳过以省内存
    if (!hugeGraph) {
      tokenCache.set(b.id, tokenize(node.title + ' ' + node.domain));
    }

    elements.push({
      data: {
        id: b.id,
        label: node.title.length > 20 ? node.title.substring(0, 20) + '...' : node.title,
        fullTitle: node.title,
        url: node.url,
        domain,
        tags: node.tags,
        folder: node.folder,
        weight: 1
      }
    });
  }

  const edgeMap = new Map();
  const addEdge = (a, b, w, group) => {
    if (a.id === b.id) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const prev = edgeMap.get(key);
    if (prev) {
      prev.weight += w;
      prev.groups.add(group);
    } else {
      edgeMap.set(key, { weight: w, groups: new Set([group]) });
    }
  };

  const domainGroups = new Map();
  const tagGroups = new Map();
  for (const node of nodeIndex.values()) {
    if (node.domain) {
      if (!domainGroups.has(node.domain)) domainGroups.set(node.domain, []);
      domainGroups.get(node.domain).push(node);
    }
    for (const tag of node.tags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag).push(node);
    }
  }

  // 简单确定性伪随机(基于 id 哈希),保证相同输入产生相同采样结果
  const hashPick = (idStr, salt, mod) => {
    let h = salt | 0;
    for (let i = 0; i < idStr.length; i++) { h = ((h << 5) - h) + idStr.charCodeAt(i); h |= 0; }
    return ((h >>> 0) % mod);
  };

  const connectGroup = (group, weight, groupType) => {
    if (group.length <= 1) return;
    // 大图 + 大组:O(n) 哈希采样,避免 O(g²) KNN(基于 id 哈希,确定性结果)
    if ((hugeGraph || largeGraph) && group.length > sampleGroupLimit) {
      const n = group.length;
      for (let i = 0; i < n; i++) {
        const a = group[i];
        for (let k = 0; k < sampleK; k++) {
          // 基于 a.id + k 哈希选目标,避免 Math.random 导致结果不稳定
          const j = hashPick(a.id, k + 1, n);
          if (j === i) continue;
          addEdge(a, group[j], weight, groupType);
        }
      }
      return;
    }
    // 超大图模式 tokenCache 为空,中/小组直接全连接(不能走 KNN 分支);
    // 普通图/大图的小组(≤12)直接全连接,开销可控
    if (hugeGraph || group.length <= FULL_CONNECT_LIMIT) {
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) addEdge(group[i], group[j], weight, groupType);
    } else {
      for (let i = 0; i < group.length; i++) {
        const tokensI = tokenCache.get(group[i].id);
        const scored = [];
        for (let j = 0; j < group.length; j++) {
          if (i === j) continue;
          const sim = jaccardSimilarity(tokensI, tokenCache.get(group[j].id));
          if (sim > 0) scored.push({ node: group[j], sim });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const k = Math.min(KNN_K, scored.length);
        for (let m = 0; m < k; m++) addEdge(group[i], scored[m].node, weight * (0.5 + scored[m].sim * 0.5), groupType);
      }
    }
  };

  if (linkByDomain) for (const [, group] of domainGroups) connectGroup(group, 3, 'domain');
  if (linkByTag) for (const [, group] of tagGroups) connectGroup(group, 2, 'tag');

  // 大图(2000+)跳过 linkBySimilar:全量倒排配对在 2k-5k 节点规模下仍是 O(n²) 量级,
  // 会产生数万条弱相似边,直接拖垮数据准备、布局与渲染。盘丝错节的网状效果由 domain/tag 边保证
  if (linkBySimilar && !hugeGraph && !largeGraph) {
    const invertedIndex = new Map();
    for (const node of nodeIndex.values()) {
      const tokens = tokenCache.get(node.id);
      for (const token of tokens) {
        if (!invertedIndex.has(token)) invertedIndex.set(token, []);
        invertedIndex.get(token).push(node);
      }
    }
    const candidatePairs = new Set();
    // 配对预算:候选对达到上限即停止收集,防止 1k-2k 节点下仍出现配对爆炸
    let pairBudget = SIM_PAIR_BUDGET;
    outer:
    for (const [, list] of invertedIndex) {
      if (list.length > 100) continue;
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          if (--pairBudget <= 0) break outer;
          const key = list[i].id < list[j].id ? `${list[i].id}|${list[j].id}` : `${list[j].id}|${list[i].id}`;
          candidatePairs.add(key);
        }
    }
    for (const key of candidatePairs) {
      const [idA, idB] = key.split('|');
      const nodeA = nodeIndex.get(idA);
      const nodeB = nodeIndex.get(idB);
      if (!nodeA || !nodeB) continue;
      const jaccard = jaccardSimilarity(tokenCache.get(idA), tokenCache.get(idB));
      const cosine = cosineSimilarity(tokenCache.get(idA), tokenCache.get(idB));
      const sim = Math.max(jaccard, cosine);
      if (sim >= 0.2) {
        const pathSim = urlPathSimilarity(nodeA.url, nodeB.url);
        addEdge(nodeA, nodeB, sim * 5 + pathSim * 2, 'similar');
      }
    }
  }

  // 大图边预算封顶(边稀疏化):按权重保留最强 edgeBudget 条边,控制总边数
  // 与布局/渲染开销;被裁剪到孤立(度为 0)的节点回连其最强边,避免大量断联节点
  if (largeGraph && edgeMap.size > edgeBudget) {
    const sortedEntries = Array.from(edgeMap.entries()).sort((a, b) => b[1].weight - a[1].weight);
    const kept = new Map(sortedEntries.slice(0, edgeBudget));
    const keptDegree = new Map();
    for (const [key] of kept) {
      const [a, b] = key.split('|');
      keptDegree.set(a, (keptDegree.get(a) || 0) + 1);
      keptDegree.set(b, (keptDegree.get(b) || 0) + 1);
    }
    // 为孤立节点补回权重最高的 1 条边
    const reconnects = new Map();
    for (const [key, info] of edgeMap) {
      if (kept.has(key)) continue;
      const [a, b] = key.split('|');
      if (!keptDegree.has(a) && (!reconnects.has(a) || reconnects.get(a)[1].weight < info.weight)) reconnects.set(a, [key, info]);
      if (!keptDegree.has(b) && (!reconnects.has(b) || reconnects.get(b)[1].weight < info.weight)) reconnects.set(b, [key, info]);
    }
    for (const [key, info] of reconnects.values()) kept.set(key, info);
    edgeMap.clear();
    for (const [k, v] of kept) edgeMap.set(k, v);
  }

  const edgeWeights = [];
  for (const [, info] of edgeMap) edgeWeights.push(info.weight);
  const maxEdgeWeight = Math.max(1, ...edgeWeights);
  const minEdgeWeight = Math.min(...edgeWeights);
  const edgeWeightRange = Math.max(1, maxEdgeWeight - minEdgeWeight);

  let edgeIdx = 0;
  for (const [key, info] of edgeMap) {
    const [a, b] = key.split('|');
    const normalizedWeight = 1 + Math.round((info.weight - minEdgeWeight) / edgeWeightRange * 9);
    const primaryGroup = info.groups.values().next().value || 'similar';
    elements.push({
      data: {
        id: `e${edgeIdx++}`,
        source: a,
        target: b,
        weight: normalizedWeight,
        group: primaryGroup
      }
    });
  }

  const nodeDegree = new Map();
  const nodeWeightedDegree = new Map();
  for (const [key, info] of edgeMap) {
    const [a, b] = key.split('|');
    nodeDegree.set(a, (nodeDegree.get(a) || 0) + 1);
    nodeDegree.set(b, (nodeDegree.get(b) || 0) + 1);
    nodeWeightedDegree.set(a, (nodeWeightedDegree.get(a) || 0) + info.weight);
    nodeWeightedDegree.set(b, (nodeWeightedDegree.get(b) || 0) + info.weight);
  }
  const maxWeightedDeg = Math.max(1, ...nodeWeightedDegree.values());
  const maxDeg = Math.max(1, ...nodeDegree.values());
  for (const el of elements) {
    if (!el.data.source) {
      const deg = nodeDegree.get(el.data.id) || 0;
      const wDeg = nodeWeightedDegree.get(el.data.id) || 0;
      const score = deg > 0 ? (deg / maxDeg) * 0.4 + (wDeg / maxWeightedDeg) * 0.6 : 0;
      el.data.weight = Math.max(1, Math.round(score * 10));
    }
  }

  return { elements, nodeIndex };
}

// ===== 聚类分析 =====
async function computeClusters(clusterBy, nodeIndex) {
  clusterMap.clear();
  const groups = new Map();

  for (const node of nodeIndex.values()) {
    let key = '';
    if (clusterBy === 'domain') key = node.domain || '(unknown)';
    else if (clusterBy === 'tag') key = node.tags[0] || '(untagged)';
    else if (clusterBy === 'folder') key = node.folder || '(root)';
    node.cluster = key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }

  const sorted = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
  const TOP = 20;
  let otherCount = 0;

  if (clusterBy === 'tag') {
    for (let idx = 0; idx < sorted.length; idx++) {
      const [key, group] = sorted[idx];
      if (idx < TOP) {
        let color = '#9aa0a6';
        if (key !== '(untagged)') {
          try { color = await getTagColor(key); } catch { color = colorForCluster(key, idx); }
        }
        clusterMap.set(key, { color, label: key, count: group.length });
      } else { otherCount += group.length; }
    }
  } else {
    sorted.forEach((entry, idx) => {
      const [key, group] = entry;
      if (idx < TOP) clusterMap.set(key, { color: colorForCluster(key, idx), label: key, count: group.length });
      else otherCount += group.length;
    });
  }

  if (otherCount > 0) {
    clusterMap.set('__other__', { color: '#9aa0a6', label: 'Other', count: otherCount });
    for (const node of nodeIndex.values()) {
      if (!clusterMap.has(node.cluster)) node.cluster = '__other__';
    }
  }
}

// ===== 标签颜色 =====
async function getTagColor(tag) {
  if (tagColorCache.has(tag)) return tagColorCache.get(tag);
  try {
    const result = await chrome.storage.local.get('tagColors');
    const colors = result.tagColors || {};
    if (colors[tag]) {
      tagColorCache.set(tag, colors[tag]);
      return colors[tag];
    }
  } catch {}
  const color = colorForCluster(tag, Math.floor(Math.random() * CLUSTER_PALETTE.length));
  tagColorCache.set(tag, color);
  return color;
}

async function preloadTagColors() {
  const allTags = new Set();
  for (const b of bookmarks) { if (b.tags) b.tags.forEach(t => allTags.add(t)); }
  if (allTags.size === 0) return;
  // 批量读取一次 storage,避免每个 tag 一次 chrome.storage.local.get(数百次串行调用阻塞加载)
  let colors = {};
  try { const result = await chrome.storage.local.get('tagColors'); colors = result.tagColors || {}; } catch {}
  for (const tag of allTags) {
    if (tagColorCache.has(tag)) continue;
    tagColorCache.set(tag, colors[tag] || colorForCluster(tag, Math.floor(Math.random() * CLUSTER_PALETTE.length)));
  }
}

// ===== 数据加载 =====
async function loadData() {
  const response = await chrome.runtime.sendMessage({ action: 'getBookmarks' });
  if (!response || !response.success) throw new Error('Failed to load bookmarks');
  bookmarks = response.bookmarks || [];
  return bookmarks;
}

// ===== 重建数据(渲染器无关) =====
// 返回完整的渲染数据快照:{ elements, nodeIndex, clusters, clusterBy }
// onProgress(phase, info) 可选,用于 UI 显示分阶段进度
async function rebuild(options, onProgress) {
  const { clusterBy, linkByDomain, linkByTag, linkBySimilar } = options;
  currentClusterBy = clusterBy;

  // 按当前书签数动态计算分级阈值与预算
  const t = computeGraphThresholds(bookmarks.length);
  const hugeGraph = t.hugeGraph;
  const largeGraph = t.largeGraph;

  const report = (phase, info) => { try { onProgress && onProgress(phase, info); } catch {} };

  report('tags', { hugeGraph, largeGraph });
  await preloadTagColors();
  // 让出主线程:preloadTagColors 内有多次 chrome.storage.local.get,可能已让出,
  // 但显式 yield 确保 UI 有机会更新加载提示
  await new Promise(r => setTimeout(r, 0));

  report('edges', { hugeGraph, largeGraph });
  const { elements, nodeIndex } = buildGraphElements(bookmarks, {
    linkByDomain, linkByTag, linkBySimilar,
    hugeGraph, largeGraph,
    edgeBudget: t.edgeBudget, sampleGroupLimit: t.sampleGroupLimit, sampleK: t.sampleK
  });
  // buildGraphElements 是同步重活(尤其非大图路径),完成后让出一次
  await new Promise(r => setTimeout(r, 0));

  report('clusters', { hugeGraph, largeGraph });
  await computeClusters(currentClusterBy, nodeIndex);
  await new Promise(r => setTimeout(r, 0));

  // 写入聚类信息和颜色到元素数据
  report('finalize', { hugeGraph, largeGraph });
  for (const el of elements) {
    if (el.data && el.data.id && !el.data.source) {
      const node = nodeIndex.get(el.data.id);
      if (node) {
        el.data.cluster = node.cluster;
        const info = clusterMap.get(node.cluster);
        el.data.color = info ? info.color : '#9aa0a6';
        el.data.clusterType = currentClusterBy;
      }
    }
  }

  return {
    elements,
    nodeIndex,
    clusters: new Map(clusterMap),
    clusterBy: currentClusterBy,
    totalNodes: elements.filter(e => !e.data.source).length,
    totalEdges: elements.filter(e => e.data.source).length,
    hugeGraph,
    largeGraph,
    thresholds: t
  };
}

// ===== 星系划分(3D 多星系模式) =====
// 构建簇间连接图并按社区发现将簇划分为多个星系。
// 返回每个簇的星系归属 + 星系列表 + 簇间邻接权重。
// 原理:簇间边权重反映语义关联,社区发现自然将关联紧密的域分到同一星系,
// 关联稀疏的域分到不同星系 → 在 3D 空间中形成视觉分离的"星系团"。
function buildGalaxyGraph(nodeElements, edgeElements, clusterMap, options) {
  const opts = options || {};
  const TARGET_PER_GALAXY = opts.targetPerGalaxy || 300;
  const MAX_GALAXY_RATIO = opts.maxGalaxyRatio || 1.8;

  // 1) 构建 nodeId → clusterKey 索引 + 簇大小表
  const nodeIdToCluster = new Map();
  const clusterSizes = new Map();
  for (const el of nodeElements) {
    const ck = el.data.cluster || '__other__';
    nodeIdToCluster.set(el.data.id, ck);
    clusterSizes.set(ck, (clusterSizes.get(ck) || 0) + 1);
  }

  // 2) 构建簇间邻接权重(聚合跨簇边)
  const clusterAdj = new Map();  // "A|B" → totalWeight (A < B)
  for (const el of edgeElements) {
    const srcC = nodeIdToCluster.get(el.data.source);
    const tgtC = nodeIdToCluster.get(el.data.target);
    if (!srcC || !tgtC || srcC === tgtC) continue;
    const key = srcC < tgtC ? `${srcC}|${tgtC}` : `${tgtC}|${srcC}`;
    clusterAdj.set(key, (clusterAdj.get(key) || 0) + (el.data.weight || 1));
  }

  // 3) Union-Find 星系合并
  const clusterList = Array.from(clusterMap.keys());
  const parent = new Map();
  const galaxySize = new Map();  // root → totalNodes
  for (const c of clusterList) {
    parent.set(c, c);
    galaxySize.set(c, clusterSizes.get(c) || 0);
  }

  function find(x) {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // 路径压缩
    let curr = x;
    while (curr !== r) {
      const next = parent.get(curr);
      parent.set(curr, r);
      curr = next;
    }
    return r;
  }

  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    const sa = galaxySize.get(ra), sb = galaxySize.get(rb);
    if (sa < sb) { parent.set(ra, rb); galaxySize.set(rb, sa + sb); }
    else { parent.set(rb, ra); galaxySize.set(ra, sa + sb); }
    return true;
  }

  // 4) 贪心合并:按簇间边权重降序,合并节点数最小的相邻星系
  const sortedEdges = Array.from(clusterAdj.entries())
    .map(([key, w]) => { const [a, b] = key.split('|'); return { a, b, w }; })
    .sort((x, y) => y.w - x.w);

  const totalNodes = clusterList.reduce((s, c) => s + (clusterSizes.get(c) || 0), 0);
  const targetCount = Math.max(1, Math.round(totalNodes / TARGET_PER_GALAXY));
  const maxPerGalaxy = Math.round(TARGET_PER_GALAXY * MAX_GALAXY_RATIO);

  for (const { a, b } of sortedEdges) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    if (galaxySize.get(ra) + galaxySize.get(rb) > maxPerGalaxy) continue;
    union(a, b);
  }

  // 5) 收集星系结果
  const galaxyRoots = new Map();  // root → { id, clusters[], totalNodes }
  const galaxyAssignments = new Map();  // clusterKey → galaxyId
  let gid = 0;
  for (const c of clusterList) {
    const root = find(c);
    if (!galaxyRoots.has(root)) {
      galaxyRoots.set(root, { id: gid, clusters: [], totalNodes: 0 });
      gid++;
    }
    const g = galaxyRoots.get(root);
    g.clusters.push(c);
    g.totalNodes += clusterSizes.get(c) || 0;
    galaxyAssignments.set(c, g.id);
  }

  const galaxies = Array.from(galaxyRoots.values())
    .sort((a, b) => b.totalNodes - a.totalNodes);

  // 6) 统计星系间边(用于 3D 星系布局)
  const interGalaxyEdges = [];
  const galaxyEdgeMap = new Map();  // "gA|gB" → weight
  for (const [key, w] of clusterAdj) {
    const [ca, cb] = key.split('|');
    const ga = galaxyAssignments.get(ca);
    const gb = galaxyAssignments.get(cb);
    if (ga === undefined || gb === undefined || ga === gb) continue;
    const gk = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
    galaxyEdgeMap.set(gk, Math.max(galaxyEdgeMap.get(gk) || 0, w));
  }
  for (const [gk, w] of galaxyEdgeMap) {
    const [a, b] = gk.split('|').map(Number);
    interGalaxyEdges.push({ s: a, t: b, w });
  }

  return {
    galaxyAssignments,   // Map<clusterKey, galaxyId>
    galaxies,            // [{ id, clusters:[clusterKey], totalNodes }]
    interGalaxyEdges,    // [{ s:galaxyId, t:galaxyId, w }]
    clusterSizes,        // Map<clusterKey, nodeCount>
    totalGalaxies: galaxies.length
  };
}

// ===== 聚类折叠视图(大图降采样:9k 节点 → 21 个超级节点) =====
// 业界标准方案:每个聚类折叠为一个 compound 父节点,边聚合为聚类间边
// expandedClusters: Set<clusterKey> 已展开的聚类(展开后显示内部节点)
function buildClusteredView(fullData, expandedClusters) {
  const { elements, nodeIndex, clusters, clusterBy } = fullData;
  expandedClusters = expandedClusters || new Set();
  const clusterParents = new Map();  // clusterKey -> parentId
  const newElements = [];
  const newNodeIndex = new Map();
  const interClusterEdges = new Map();  // "a|b" -> { weight, groups }

  // 1. 创建聚类父节点(超级节点)
  for (const [key, info] of clusters) {
    const parentId = `cluster:${key}`;
    clusterParents.set(key, parentId);
    const isExpanded = expandedClusters.has(key);
    newElements.push({
      group: 'nodes',
      data: {
        id: parentId,
        label: `${info.label}`,
        subLabel: `${info.count} bookmarks`,
        fullTitle: `${info.label} · ${info.count} bookmarks`,
        color: info.color,
        cluster: key,
        clusterType: clusterBy,
        weight: Math.min(10, Math.ceil(info.count / 10) + 3),  // 按节点数映射权重
        isCluster: true,
        isExpanded,
        clusterKey: key,
        clusterCount: info.count,
        tags: [],
        domain: key,
        url: ''
      }
    });
    newNodeIndex.set(parentId, {
      id: parentId, cluster: key, isCluster: true,
      weight: Math.min(10, Math.ceil(info.count / 10) + 3)
    });
  }

  // 2. 遍历原节点:展开的聚类加入内部节点,未展开的跳过(用父节点代表)
  for (const el of elements) {
    if (el.data && el.data.source) continue;  // 跳过边
    const node = nodeIndex.get(el.data.id);
    if (!node) continue;
    const clusterKey = node.cluster;
    if (expandedClusters.has(clusterKey)) {
      // 已展开:加入原节点,设置 parent
      newElements.push({
        group: 'nodes',
        data: { ...el.data, parent: clusterParents.get(clusterKey) }
      });
      newNodeIndex.set(el.data.id, node);
    }
  }

  // 3. 处理边:展开聚类的内部边保留;未展开的聚类的边聚合为聚类间边
  for (const el of elements) {
    if (!el.data || !el.data.source) continue;
    const srcNode = nodeIndex.get(el.data.source);
    const tgtNode = nodeIndex.get(el.data.target);
    if (!srcNode || !tgtNode) continue;
    const srcCluster = srcNode.cluster;
    const tgtCluster = tgtNode.cluster;

    if (srcCluster === tgtCluster) {
      // 同聚类边:仅当该聚类展开时保留
      if (expandedClusters.has(srcCluster)) {
        newElements.push({ group: 'edges', data: { ...el.data } });
      }
    } else {
      // 跨聚类边:展开两个聚类时保留原边,否则聚合
      if (expandedClusters.has(srcCluster) && expandedClusters.has(tgtCluster)) {
        newElements.push({ group: 'edges', data: { ...el.data } });
      } else {
        // 聚合为聚类间边
        const edgeKey = [srcCluster, tgtCluster].sort().join('|');
        if (!interClusterEdges.has(edgeKey)) {
          interClusterEdges.set(edgeKey, { weight: 0, groups: new Set(), src: srcCluster, tgt: tgtCluster });
        }
        const agg = interClusterEdges.get(edgeKey);
        agg.weight += el.data.weight || 1;
        if (el.data.group) agg.groups.add(el.data.group);
      }
    }
  }

  // 4. 加入聚合的聚类间边
  let edgeIdx = 0;
  for (const [key, agg] of interClusterEdges) {
    const srcParent = clusterParents.get(agg.src);
    const tgtParent = clusterParents.get(agg.tgt);
    if (!srcParent || !tgtParent) continue;
    const normalizedWeight = Math.min(10, Math.ceil(agg.weight / 5) + 1);
    const primaryGroup = agg.groups.values().next().value || 'similar';
    newElements.push({
      group: 'edges',
      data: {
        id: `ce${edgeIdx++}`,
        source: srcParent,
        target: tgtParent,
        weight: normalizedWeight,
        group: primaryGroup,
        isClusterEdge: true
      }
    });
  }

  return {
    elements: newElements,
    nodeIndex: newNodeIndex,
    clusters,
    clusterBy,
    totalNodes: newElements.filter(e => !e.data.source && !e.data.isCluster).length,
    totalEdges: newElements.filter(e => e.data.source).length,
    totalClusters: clusters.size,
    isClustered: true,
    expandedClusters
  };
}

// ===== 搜索匹配(纯数据,返回匹配的节点 id 集合) =====
function searchNodes(query) {
  if (!query) return { matchedIds: new Set(), total: 0 };
  const q = query.trim().toLowerCase();
  const matchedIds = new Set();
  for (const b of bookmarks) {
    const title = (b.title || '').toLowerCase();
    const domain = (extractDomain(b.url) || '').toLowerCase();
    const url = (b.url || '').toLowerCase();
    const tags = (b.tags || []).join(' ').toLowerCase();
    if (title.includes(q) || domain.includes(q) || url.includes(q) || tags.includes(q)) {
      matchedIds.add(b.id);
    }
  }
  return { matchedIds, total: matchedIds.size };
}

// ===== 数据快照 =====
function getSnapshot() {
  return {
    bookmarks: bookmarks.slice(),
    clusters: new Map(clusterMap),
    clusterBy: currentClusterBy,
    tagColorCache: new Map(tagColorCache)
  };
}

function getBookmarks() { return bookmarks; }
function getClusters() { return new Map(clusterMap); }
function getClusterBy() { return currentClusterBy; }

return {
  // 状态
  getBookmarks, getClusters, getClusterBy,
  // 数据
  loadData, rebuild, buildClusteredView, searchNodes, getSnapshot,
  // 星系
  buildGalaxyGraph,
  // 阈值
  computeGraphThresholds,
  // 标签
  preloadTagColors, getTagColor,
  // 工具
  extractDomain, escapeHtml, hexToRgb, colorForCluster,
  isDarkTheme, detectTheme,
  // 常量
  CLUSTER_PALETTE, EDGE_GROUP_COLORS
};
})();

window.GraphCore = GraphCore;
