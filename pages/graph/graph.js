// ===== 知识图谱 · 主协调器 =====
// 负责:模式切换、工具栏绑定、背景粒子、数据加载调度、渲染器生命周期

// ===== DOM 引用 =====
const particleCanvas = document.getElementById('particleCanvas');
const pCtx = particleCanvas ? particleCanvas.getContext('2d') : null;
const backBtn = document.getElementById('backBtn');
const graphStats = document.getElementById('graphStats');
const graphEmpty = document.getElementById('graphEmpty');
const graphLoading = document.getElementById('graphLoading');
const hoverCard = document.getElementById('hoverCard');
const hoverTitle = document.getElementById('hoverTitle');
const hoverMeta = document.getElementById('hoverMeta');
const hoverTags = document.getElementById('hoverTags');
const graphLegend = document.getElementById('graphLegend');
const zoomLevelEl = document.getElementById('zoomLevel');

const clusterSelect = document.getElementById('clusterSelect');
const linkDomain = document.getElementById('linkDomain');
const linkTag = document.getElementById('linkTag');
const linkSimilar = document.getElementById('linkSimilar');
const resetViewBtn = document.getElementById('resetViewBtn');
const reLayoutBtn = document.getElementById('reLayoutBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const exportBtn = document.getElementById('exportBtn');
const modeSwitch = document.getElementById('modeSwitch');
const graphLoadingText = document.getElementById('graphLoadingText');
const clusterModeBadge = document.getElementById('clusterModeBadge');
const clusterModeText = document.getElementById('clusterModeText');

// 加载阶段文案(中文优先,i18n 兜底)
const PHASE_LABELS = {
  tags: '准备标签颜色…',
  edges: '构建关联边…',
  clusters: '计算聚类…',
  finalize: '应用样式…'
};

function setLoadingText(text) {
  if (graphLoadingText) graphLoadingText.textContent = text || '';
}

function setClusterBadge(visible, text) {
  if (!clusterModeBadge) return;
  if (visible) {
    if (text && clusterModeText) clusterModeText.textContent = text;
    clusterModeBadge.style.display = '';
  } else {
    clusterModeBadge.style.display = 'none';
  }
}

// ===== 状态 =====
let currentMode = '2d';          // '2d' | '3d'
let renderer = null;             // Graph2D | Graph3D 实例
let currentData = null;          // GraphCore.rebuild 返回的数据快照
let particleAnimId = null;
let searchTimer = null;

const canvasWrap = document.querySelector('.graph-canvas-wrap');

// ===== 模式切换 =====
async function loadModePreference() {
  try {
    const result = await chrome.storage.local.get('graphMode');
    return result.graphMode || '2d';
  } catch { return '2d'; }
}

async function saveModePreference(mode) {
  try { await chrome.storage.local.set({ graphMode: mode }); } catch {}
}

function setModeButtonActive(mode) {
  if (!modeSwitch) return;
  modeSwitch.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

async function switchMode(mode) {
  if (mode === currentMode && renderer) return;
  graphLoading.style.display = 'block';

  // 销毁旧渲染器
  if (renderer) {
    renderer.destroy();
    renderer = null;
  }

  currentMode = mode;
  setModeButtonActive(mode);
  await saveModePreference(mode);

  // 背景粒子:2D 模式显示,3D 模式隐藏(3D 有自己的星云背景)
  if (particleCanvas) {
    particleCanvas.style.display = mode === '2d' ? '' : 'none';
  }
  if (mode === '2d' && !particleAnimId) setupParticleCanvas(), animateParticles();
  if (mode === '3d' && particleAnimId) { cancelAnimationFrame(particleAnimId); particleAnimId = null; }

  // 用当前数据初始化新渲染器
  if (currentData) {
    renderer = mode === '2d' ? new Graph2D(canvasWrap) : new Graph3D(canvasWrap);
    bindRendererCallbacks(renderer);
    renderer.init(currentData);
    // 按图谱规模调整背景粒子特效质量
    applyParticleQuality();
    // 应用当前搜索
    performSearch();
    // 切换模式时同步徽章(仅 2D 大图显示)
    if (mode === '2d' && currentData && currentData.hugeGraph) {
      const clusterCount = currentData.clusters.size;
      setClusterBadge(true, `大图模式 · 已折叠为 ${clusterCount} 个聚类,点击展开`);
    } else {
      setClusterBadge(false);
    }
  }

  graphLoading.style.display = 'none';
}

// ===== 渲染器回调绑定 =====
function bindRendererCallbacks(r) {
  r.on('nodeClick', ({ url }) => {
    if (url) chrome.tabs.create({ url });
  });
  r.on('nodeHover', (info, mx, my) => {
    if (!info) { hoverCard.style.display = 'none'; return; }
    // 2D 模式有自己的 _showHoverCard 完整处理卡片内容和位置,不需要 showHoverCardFromInfo 覆盖
    if (currentMode === '2d') return;
    showHoverCardFromInfo(info, mx, my);
  });
  r.on('stats', (s) => {
    const { nodes, edges, clusters, clusterMode, expandedClusters, totalClusters } = s;
    graphStats.innerHTML = `
      <span>${nodes} ${i18n('graphNodes')}</span>
      <span>${edges} ${i18n('graphEdges')}</span>
      <span>${clusters} ${i18n('graphClusters')}</span>
    `;
    // 聚类模式徽章:展开/折叠后实时更新文案
    if (clusterMode && currentMode === '2d') {
      const expanded = expandedClusters || 0;
      const total = totalClusters || clusters || 0;
      const text = expanded > 0
        ? `大图模式 · ${expanded}/${total} 个聚类已展开`
        : `大图模式 · 已折叠为 ${total} 个聚类,点击展开`;
      setClusterBadge(true, text);
    }
  });
}

// 3D 模式专用:从节点信息显示 hover 卡片
function showHoverCardFromInfo(info, mx, my) {
  const data = info.data || info;
  hoverTitle.textContent = data.fullTitle || data.label || '(untitled)';
  hoverMeta.textContent = data.domain || '';
  hoverTags.innerHTML = '';
  const tags = data.tags || [];
  if (tags.length > 0) {
    tags.slice(0, 5).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'hover-card-tag';
      GraphCore.getTagColor(tag).then(color => {
        span.style.background = color + '22';
        span.style.color = color;
      });
      span.textContent = tag;
      hoverTags.appendChild(span);
    });
  }
  hoverCard.style.display = 'block';
  const wrap = canvasWrap.getBoundingClientRect();
  const cardWidth = 280;
  const cardHeight = hoverCard.offsetHeight;
  let posX = (mx !== undefined ? mx : wrap.width / 2) - wrap.left + 14;
  let posY = (my !== undefined ? my : wrap.height / 2) - wrap.top + 14;
  if (posX + cardWidth > wrap.width) posX = posX - cardWidth - 28;
  if (posY + cardHeight > wrap.height) posY = posY - cardHeight - 28;
  hoverCard.style.left = Math.max(8, posX) + 'px';
  hoverCard.style.top = Math.max(8, posY) + 'px';
}

// ===== 数据重建 =====
async function rebuild() {
  graphLoading.style.display = 'block';
  graphEmpty.style.display = 'none';
  setLoadingText(PHASE_LABELS.tags);

  try {
    currentData = await GraphCore.rebuild({
      clusterBy: clusterSelect.value,
      linkByDomain: linkDomain.checked,
      linkByTag: linkTag.checked,
      linkBySimilar: linkSimilar.checked
    }, (phase) => {
      // 大图模式各阶段让出主线程后,UI 已有机会重绘加载文案
      if (PHASE_LABELS[phase]) setLoadingText(PHASE_LABELS[phase]);
    });

    if (renderer) renderer.destroy();
    renderer = currentMode === '2d' ? new Graph2D(canvasWrap) : new Graph3D(canvasWrap);
    bindRendererCallbacks(renderer);
    // 大图布局(力导向)在 init 内同步计算,先告知用户当前阶段
    setLoadingText('计算布局…');
    renderer.init(currentData);
    // 按图谱规模调整背景粒子特效质量
    applyParticleQuality();

    // 大图聚类模式徽章提示(仅 2D 模式有聚类折叠)
    if (currentMode === '2d' && currentData.hugeGraph) {
      const clusterCount = currentData.clusters.size;
      setClusterBadge(true, `大图模式 · 已折叠为 ${clusterCount} 个聚类,点击展开`);
    } else {
      setClusterBadge(false);
    }

    renderLegend();
    performSearch();
    graphLoading.style.display = 'none';
    setLoadingText('');
  } catch (err) {
    console.error('重建图谱失败:', err);
    graphLoading.style.display = 'none';
    setLoadingText('');
  }
}

// ===== 搜索 =====
function setupSearch() {
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(performSearch, 200);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      performSearch();
      searchInput.blur();
    }
  });
}

function performSearch() {
  if (!searchInput || !renderer) return;
  const query = searchInput.value.trim();
  const { matchedIds, total } = GraphCore.searchNodes(query);

  renderer.search(matchedIds, total);

  if (!query) {
    searchCount.style.display = 'none';
    return;
  }
  searchCount.textContent = `${total}`;
  searchCount.style.display = 'inline';
}

// ===== 图例 =====
function renderLegend() {
  if (!graphLegend) return;
  graphLegend.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'legend-title';
  title.textContent = clusterSelect.value === 'domain' ? 'Domains'
    : clusterSelect.value === 'tag' ? 'Tags' : 'Folders';
  graphLegend.appendChild(title);

  const clusters = GraphCore.getClusters();
  const sorted = Array.from(clusters.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [key, info] of sorted) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `
      <span class="legend-dot" style="background:${info.color}"></span>
      <span class="legend-label">${GraphCore.escapeHtml(info.label)}</span>
      <span class="legend-count">${info.count}</span>
    `;
    item.addEventListener('click', () => {
      if (!renderer) return;
      renderer.highlightCluster(key);
    });
    graphLegend.appendChild(item);
  }
}

// ===== 工具栏交互 =====
if (zoomInBtn) zoomInBtn.addEventListener('click', () => renderer && renderer.zoomIn());
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => renderer && renderer.zoomOut());
if (resetViewBtn) resetViewBtn.addEventListener('click', () => renderer && renderer.resetView());
if (reLayoutBtn) reLayoutBtn.addEventListener('click', () => renderer && renderer.relayout());

if (clusterSelect) clusterSelect.addEventListener('change', rebuild);
if (linkDomain) linkDomain.addEventListener('change', rebuild);
if (linkTag) linkTag.addEventListener('change', rebuild);
if (linkSimilar) linkSimilar.addEventListener('change', rebuild);

if (backBtn) backBtn.addEventListener('click', () => {
  if (window.history.length > 1) history.back();
  else window.close();
});

// 模式切换
if (modeSwitch) {
  modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (btn && btn.dataset.mode !== currentMode) {
      switchMode(btn.dataset.mode);
    }
  });
}

// ===== 导出 =====
if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (!renderer) return;
    const snapshot = renderer.exportStaticHTML();
    if (!snapshot) return;
    if (snapshot.is3D) exportStaticHTML3D(snapshot);
    else exportStaticHTML2D(snapshot);
  });
}

function exportStaticHTML2D(s) {
  const html = generate2DExportHTML(s);
  downloadHTML(html, `bookmark-graph-2d-${new Date().toISOString().slice(0, 10)}.html`);
}

function exportStaticHTML3D(s) {
  const html = generate3DExportHTML(s);
  downloadHTML(html, `bookmark-graph-3d-${new Date().toISOString().slice(0, 10)}.html`);
}

function downloadHTML(html, filename) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function generate2DExportHTML(s) {
  const { nodesData, edgesData, legendData, width, height, minX, minY, bgColor, textColor, dark, clusterBy } = s;
  const edgeColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bookmark Knowledge Graph - 2D Export</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: ${bgColor}; font-family: -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; }
canvas { display: block; cursor: grab; }
canvas:active { cursor: grabbing; }
.legend { position: fixed; bottom: 20px; left: 20px; background: ${dark ? 'rgba(22,25,34,0.85)' : 'rgba(255,255,255,0.85)'}; backdrop-filter: blur(12px); border: 1px solid ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}; border-radius: 12px; padding: 12px 16px; font-size: 11px; max-height: 300px; overflow-y: auto; }
.legend-title { font-size: 10px; font-weight: 600; color: ${dark ? '#6b7280' : '#868e96'}; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.legend-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.legend-label { color: ${dark ? '#a8b0bd' : '#495057'}; }
.legend-count { color: ${dark ? '#6b7280' : '#868e96'}; font-size: 10px; margin-left: auto; }
.tooltip { position: fixed; background: ${dark ? 'rgba(22,25,34,0.92)' : 'rgba(255,255,255,0.92)'}; backdrop-filter: blur(16px); border: 1px solid ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}; border-radius: 12px; padding: 12px 16px; font-size: 12px; pointer-events: none; z-index: 100; max-width: 280px; display: none; }
.tooltip-title { font-weight: 500; color: ${textColor}; margin-bottom: 4px; word-break: break-word; }
.tooltip-meta { color: ${dark ? '#6b7280' : '#868e96'}; font-size: 11px; font-family: monospace; }
.stats { position: fixed; top: 16px; right: 20px; color: ${dark ? '#6b7280' : '#868e96'}; font-size: 11px; font-family: monospace; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div class="legend"><div class="legend-title">${clusterBy === 'domain' ? 'Domains' : clusterBy === 'tag' ? 'Tags' : 'Folders'}</div>${legendData.map(l => `<div class="legend-item"><span class="legend-dot" style="background:${l.color}"></span><span class="legend-label">${l.label}</span><span class="legend-count">${l.count}</span></div>`).join('')}</div>
<div class="tooltip" id="tip"><div class="tooltip-title" id="tipTitle"></div><div class="tooltip-meta" id="tipMeta"></div></div>
<div class="stats">${nodesData.length} nodes · ${edgesData.length} edges</div>
<script>
const nodes = ${JSON.stringify(nodesData)};
const edges = ${JSON.stringify(edgesData)};
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const tip = document.getElementById('tip');
const tipTitle = document.getElementById('tipTitle');
const tipMeta = document.getElementById('tipMeta');
let scale = 1, offX = 0, offY = 0, dragging = false, lastX = 0, lastY = 0;
function resize() { canvas.width = innerWidth; canvas.height = innerHeight; draw(); }
function fitView() { const sx = canvas.width / ${width}; const sy = canvas.height / ${height}; scale = Math.min(sx, sy) * 0.9; offX = (canvas.width - ${width} * scale) / 2 - ${minX} * scale; offY = (canvas.height - ${height} * scale) / 2 - ${minY} * scale; }
function draw() { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save(); ctx.translate(offX, offY); ctx.scale(scale, scale); const nodeMap = {}; nodes.forEach(n => nodeMap[n.id] = n); for (const e of edges) { const a = nodeMap[e.source], b = nodeMap[e.target]; if (!a || !b) continue; const w = e.weight; if (w >= 6) { const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y); g.addColorStop(0, a.color + 'B3'); g.addColorStop(1, b.color + 'B3'); ctx.strokeStyle = g; ctx.lineWidth = 1.6; } else if (w >= 3) { const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y); g.addColorStop(0, a.color + '73'); g.addColorStop(1, b.color + '73'); ctx.strokeStyle = g; ctx.lineWidth = 1.1; } else { ctx.strokeStyle = '${edgeColor}'; ctx.lineWidth = 0.7; } ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, Math.PI * 2); ctx.fillStyle = n.color; ctx.fill(); ctx.strokeStyle = '${dark ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.8)'}'; ctx.lineWidth = 1; ctx.stroke(); } ctx.restore(); }
canvas.addEventListener('wheel', e => { e.preventDefault(); const d = e.deltaY > 0 ? 0.9 : 1.1; const ns = Math.max(0.1, Math.min(10, scale * d)); const mx = e.clientX, my = e.clientY; offX = mx - (mx - offX) * (ns / scale); offY = my - (my - offY) * (ns / scale); scale = ns; draw(); }, { passive: false });
canvas.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
canvas.addEventListener('mousemove', e => { if (dragging) { offX += e.clientX - lastX; offY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; draw(); } const wx = (e.clientX - offX) / scale, wy = (e.clientY - offY) / scale; let found = null; for (const n of nodes) { if ((n.x - wx) ** 2 + (n.y - wy) ** 2 < 100) { found = n; break; } } if (found) { tip.style.display = 'block'; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; tipTitle.textContent = found.fullTitle; tipMeta.textContent = found.domain; } else { tip.style.display = 'none'; } });
canvas.addEventListener('mouseup', () => dragging = false);
canvas.addEventListener('mouseleave', () => { dragging = false; tip.style.display = 'none'; });
canvas.addEventListener('click', e => { const wx = (e.clientX - offX) / scale, wy = (e.clientY - offY) / scale; for (const n of nodes) { if ((n.x - wx) ** 2 + (n.y - wy) ** 2 < 100 && n.url) { window.open(n.url, '_blank'); break; } } });
window.addEventListener('resize', resize); resize(); fitView(); draw();
<\/script>
</body>
</html>`;
}

function generate3DExportHTML(s) {
  const { nodesData, edgesData, legendData, dark, clusterBy } = s;
  const bg = dark ? '#02030a' : '#0a1628';
  const textColor = dark ? '#e4e6eb' : '#a8b0bd';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bookmark Galaxy - 3D Export</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: ${bg}; font-family: -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; }
canvas { display: block; cursor: grab; } canvas:active { cursor: grabbing; }
.legend { position: fixed; bottom: 20px; left: 20px; background: rgba(22,25,34,0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px 16px; font-size: 11px; max-height: 300px; overflow-y: auto; color: ${textColor}; }
.legend-title { font-size: 10px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.legend-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
.legend-label { color: ${textColor}; } .legend-count { color: #6b7280; font-size: 10px; margin-left: auto; }
.tooltip { position: fixed; background: rgba(22,25,34,0.92); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px 16px; font-size: 12px; pointer-events: none; z-index: 100; max-width: 280px; display: none; color: ${textColor}; }
.tooltip-title { font-weight: 500; margin-bottom: 4px; word-break: break-word; }
.tooltip-meta { color: #6b7280; font-size: 11px; font-family: monospace; }
.stats { position: fixed; top: 16px; right: 20px; color: #6b7280; font-size: 11px; font-family: monospace; }
.tip { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); color: #4b5563; font-size: 11px; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div class="legend"><div class="legend-title">${clusterBy === 'domain' ? 'Domains' : clusterBy === 'tag' ? 'Tags' : 'Folders'}</div>${legendData.map(l => `<div class="legend-item"><span class="legend-dot" style="background:${l.color};color:${l.color}"></span><span class="legend-label">${l.label}</span><span class="legend-count">${l.count}</span></div>`).join('')}</div>
<div class="tooltip" id="tip"><div class="tooltip-title" id="tipTitle"></div><div class="tooltip-meta" id="tipMeta"></div></div>
<div class="stats">${nodesData.length} stars · ${edgesData.length} links</div>
<div class="tip">左键拖拽旋转 · 滚轮缩放 · 双击打开书签</div>
<script>
const nodes = ${JSON.stringify(nodesData)};
const edges = ${JSON.stringify(edgesData)};
const nodeMap = {}; nodes.forEach((n, i) => nodeMap[n.id] = i);
const canvas = document.getElementById('c'); const ctx = canvas.getContext('2d');
const tip = document.getElementById('tip'); const tipTitle = document.getElementById('tipTitle'); const tipMeta = document.getElementById('tipMeta');
let W, H, cx, cy; function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; cx = W/2; cy = H/2; } resize(); addEventListener('resize', resize);
let rotX = 0.5, rotY = 0, camZ = 0, targetCamZ = 0, dragging = false, lastX = 0, lastY = 0, time = 0;
const focal = 500;
function project(x, y, z) { const x1 = x*Math.cos(rotY)-z*Math.sin(rotY); const z1 = x*Math.sin(rotY)+z*Math.cos(rotY); const y1 = y*Math.cos(rotX)-z1*Math.sin(rotX); const z2 = y*Math.sin(rotX)+z1*Math.cos(rotX); const depth = z2+camZ+300; const scale = focal/(focal+depth); return { sx: cx+x1*scale, sy: cy+y1*scale, scale, depth }; }
canvas.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mousemove', e => { if (dragging) { rotY += (e.clientX-lastX)*0.006; rotX += (e.clientY-lastY)*0.006; rotX = Math.max(-1.4, Math.min(1.4, rotX)); lastX = e.clientX; lastY = e.clientY; tip.style.display = 'none'; } else { let best = null, bestD = 12; for (const n of nodes) { const p = project(n.x, n.y, n.z); if (p.scale <= 0.2) continue; const r = n.size*p.scale; const d = Math.sqrt((p.sx-e.clientX)**2 + (p.sy-e.clientY)**2); if (d < Math.max(r+4, 8) && d < bestD) { best = n; bestD = d; } } if (best) { tip.style.display = 'block'; tip.style.left = (e.clientX+14)+'px'; tip.style.top = (e.clientY+14)+'px'; tipTitle.textContent = best.fullTitle; tipMeta.textContent = best.domain; } else { tip.style.display = 'none'; } } });
addEventListener('mouseup', () => dragging = false);
canvas.addEventListener('wheel', e => { e.preventDefault(); targetCamZ += e.deltaY*0.5; targetCamZ = Math.max(-200, Math.min(500, targetCamZ)); }, { passive: false });
canvas.addEventListener('dblclick', e => { let best = null, bestD = 12; for (const n of nodes) { const p = project(n.x, n.y, n.z); if (p.scale <= 0.2) continue; const r = n.size*p.scale; const d = Math.sqrt((p.sx-e.clientX)**2 + (p.sy-e.clientY)**2); if (d < Math.max(r+4, 8) && d < bestD) { best = n; bestD = d; } } if (best && best.url) window.open(best.url, '_blank'); });
function draw() { time += 0.016; if (!dragging) rotY += 0.0015; camZ += (targetCamZ-camZ)*0.08; ctx.fillStyle = '${bg}'; ctx.fillRect(0, 0, W, H); const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W,H)*0.6); bgGrad.addColorStop(0, 'rgba(30,20,60,0.15)'); bgGrad.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H); const eProj = []; for (const e of edges) { const ai = nodeMap[e.source], bi = nodeMap[e.target]; if (ai === undefined || bi === undefined) continue; const a = nodes[ai], b = nodes[bi]; const pa = project(a.x, a.y, a.z), pb = project(b.x, b.y, b.z); if (pa.scale <= 0 || pb.scale <= 0) continue; eProj.push({ pa, pb, depth: (pa.depth+pb.depth)/2, rgb: a.rgb }); } eProj.sort((a, b) => b.depth-a.depth); for (const e of eProj) { if (eProj.indexOf(e) > 5000) break; const a = Math.min(0.25, 0.25*e.pa.scale*e.pb.scale); ctx.strokeStyle = 'rgba('+e.rgb[0]+','+e.rgb[1]+','+e.rgb[2]+','+a+')'; ctx.lineWidth = 0.6*e.pa.scale; ctx.beginPath(); ctx.moveTo(e.pa.sx, e.pa.sy); ctx.lineTo(e.pb.sx, e.pb.sy); ctx.stroke(); } const nProj = []; for (const n of nodes) { const p = project(n.x, n.y, n.z); if (p.scale <= 0) continue; const tw = (0.7+0.3*Math.sin(time*2+n.phase)); nProj.push({ n, p, tw, depth: p.depth }); } nProj.sort((a, b) => b.depth-a.depth); for (const item of nProj) { const { n, p, tw } = item; const r = n.size*p.scale*tw; if (r < 0.3) continue; const [r0, g0, b0] = n.rgb; const glowR = r*(n.isHub ? 5 : 3.5); const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowR); grad.addColorStop(0, 'rgba('+r0+','+g0+','+b0+','+(0.5*tw)+')'); grad.addColorStop(0.4, 'rgba('+r0+','+g0+','+b0+','+(0.15*tw)+')'); grad.addColorStop(1, 'rgba('+r0+','+g0+','+b0+',0)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.sx, p.sy, glowR, 0, 6.28); ctx.fill(); ctx.fillStyle = 'rgba('+Math.min(255, r0+60)+','+Math.min(255, g0+60)+','+Math.min(255, b0+60)+','+tw+')'; ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, 6.28); ctx.fill(); if (n.isHub && r > 2) { ctx.strokeStyle = 'rgba('+r0+','+g0+','+b0+','+(0.4*tw)+')'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(p.sx-r*3, p.sy); ctx.lineTo(p.sx+r*3, p.sy); ctx.moveTo(p.sx, p.sy-r*3); ctx.lineTo(p.sx, p.sy+r*3); ctx.stroke(); } } requestAnimationFrame(draw); }
draw();
<\/script>
</body>
</html>`;
}

// ===== 背景粒子系统(仅 2D 模式) =====
let particles = [];
let particleLowPower = false;  // 大图时降级粒子特效,节省主线程预算

function setupParticleCanvas() {
  if (!particleCanvas || !pCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = particleCanvas.getBoundingClientRect();
  particleCanvas.width = rect.width * dpr;
  particleCanvas.height = rect.height * dpr;
  pCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  initParticles(rect.width, rect.height);
}

function initParticles(w, h) {
  // 大图:数量减半、密度下限放宽,避免背景动画与图谱交互抢主线程
  const target = particleLowPower ? 32 : 80;
  const minCount = particleLowPower ? 8 : 20;
  const density = particleLowPower ? 30000 : 12000;
  const count = Math.min(target, Math.max(minCount, Math.floor((w * h) / density)));
  particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.08, vy: (Math.random() - 0.5) * 0.08,
      size: Math.random() * 1.8 + 0.6,
      phase: Math.random() * Math.PI * 2,
      phaseSpeed: 0.004 + Math.random() * 0.008,
      baseAlpha: 0.25 + Math.random() * 0.35
    });
  }
}

// 按图谱规模调整粒子特效质量(大图降级,小图恢复)
function applyParticleQuality() {
  particleLowPower = currentMode === '2d' && !!(currentData && currentData.largeGraph);
  if (currentMode === '2d') setupParticleCanvas();
}

function animateParticles() {
  if (!particleCanvas || !pCtx || currentMode === '3d') return;
  const dpr = window.devicePixelRatio || 1;
  const w = particleCanvas.width / dpr;
  const h = particleCanvas.height / dpr;
  pCtx.clearRect(0, 0, w, h);

  const dark = GraphCore.isDarkTheme();
  const baseColor = dark ? '180, 200, 240' : '100, 130, 200';

  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.phase += p.phaseSpeed;
    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) p.y = h + 10;
    if (p.y > h + 10) p.y = -10;
    const flicker = (Math.sin(p.phase) + 1) / 2;
    const alpha = p.baseAlpha * (0.4 + flicker * 0.6);
    pCtx.beginPath();
    pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    pCtx.fillStyle = `rgba(${baseColor}, ${alpha})`;
    pCtx.fill();
    if (p.size > 1) {
      const gradient = pCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4);
      gradient.addColorStop(0, `rgba(${baseColor}, ${alpha * 0.3})`);
      gradient.addColorStop(1, `rgba(${baseColor}, 0)`);
      pCtx.fillStyle = gradient;
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2);
      pCtx.fill();
    }
  }

  // 大图降级:跳过粒子间连线计算(O(p²)),只保留漂浮圆点
  if (!particleLowPower) {
    const CONNECT_DIST = 120;
    const CONNECT_DIST_SQ = CONNECT_DIST * CONNECT_DIST;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < CONNECT_DIST_SQ) {
          const dist = Math.sqrt(distSq);
          const alpha = (1 - dist / CONNECT_DIST) * 0.08;
          pCtx.strokeStyle = `rgba(${baseColor}, ${alpha})`;
          pCtx.lineWidth = 0.5;
          pCtx.beginPath();
          pCtx.moveTo(a.x, a.y); pCtx.lineTo(b.x, b.y);
          pCtx.stroke();
        }
      }
    }
  }
  particleAnimId = requestAnimationFrame(animateParticles);
}

// ===== 数据加载 =====
async function loadData() {
  graphLoading.style.display = 'block';
  graphEmpty.style.display = 'none';

  try {
    const bookmarks = await GraphCore.loadData();
    if (bookmarks.length === 0) {
      graphLoading.style.display = 'none';
      graphEmpty.style.display = 'block';
      return;
    }
    graphLoading.style.display = 'none';
    await rebuild();
    if (zoomLevelEl) zoomLevelEl.textContent = '100%';
  } catch (err) {
    console.error('加载图谱数据失败:', err);
    graphLoading.style.display = 'none';
    graphEmpty.style.display = 'block';
  }
}

// ===== 窗口大小变化 =====
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (renderer && currentMode === '3d' && renderer.resize) renderer.resize();
    if (currentMode === '2d') setupParticleCanvas();
  }, 150);
});

// ===== 初始化 =====
async function init() {
  await GraphCore.detectTheme();
  currentMode = await loadModePreference();
  setModeButtonActive(currentMode);

  if (currentMode === '2d') {
    setupParticleCanvas();
    animateParticles();
  } else {
    if (particleCanvas) particleCanvas.style.display = 'none';
  }

  setupSearch();
  loadData();
}

if (typeof initI18n === 'function') {
  initI18n().then(init);
} else {
  init();
}
