// ===== 知识图谱 · 2D 渲染器(Cytoscape) =====
// 封装原 Cytoscape 渲染逻辑,实现统一渲染器接口
// 接口:init / update / search / highlightCluster / resetView / relayout / destroy / on

class Graph2D {
  constructor(container) {
    this.container = container;
    this.cy = null;
    this.zoomLevelEl = document.getElementById('zoomLevel');
    this.hoverCard = document.getElementById('hoverCard');
    this.hoverTitle = document.getElementById('hoverTitle');
    this.hoverMeta = document.getElementById('hoverMeta');
    this.hoverTags = document.getElementById('hoverTags');
    this.callbacks = { nodeClick: null, nodeHover: null, stats: null };
    this.currentData = null;
    this._isInteracting = false;   // 拖拽/缩放交互中,抑制 hover 重活
    this._prevHighlightSet = null; // 上次高亮集合,增量清理避免全图扫描
  }

  // ===== Cytoscape 样式 =====
  getCyStyle() {
    const dark = GraphCore.isDarkTheme();
    // 大图:节点缩小防"实心圆圈",但连线需足够可见(盘丝错节 = 丝线清晰交织)
    const nodeSize = this.largeGraph ? 'mapData(weight, 1, 10, 5, 16)' : 'mapData(weight, 1, 10, 10, 36)';
    const edgeOpacity = this.largeGraph ? 0.45 : 0.4;
    const edgeWidth = this.largeGraph ? 'mapData(weight, 1, 10, 0.6, 2.4)' : 'mapData(weight, 1, 10, 0.5, 4)';
    // 大图分组边颜色更鲜明,保证丝网可辨
    const groupDomain = dark ? (this.largeGraph ? 'rgba(160,179,220,0.75)' : 'rgba(160,179,220,0.5)') : (this.largeGraph ? 'rgba(66,99,235,0.6)' : 'rgba(66,99,235,0.35)');
    const groupTag = dark ? (this.largeGraph ? 'rgba(144,225,144,0.75)' : 'rgba(144,225,144,0.5)') : (this.largeGraph ? 'rgba(47,158,68,0.6)' : 'rgba(47,158,68,0.35)');
    const groupSimilar = dark ? (this.largeGraph ? 'rgba(246,195,132,0.75)' : 'rgba(246,195,132,0.5)') : (this.largeGraph ? 'rgba(232,89,12,0.6)' : 'rgba(232,89,12,0.35)');
    // 中等图+:去掉 transition,避免 hover 时全图元素同时过渡导致每帧重绘卡顿
    const nodeTransition = this.mediumGraph ? 'none' : 'background-color, border-color, border-width, opacity, text-opacity';
    const nodeDuration = this.mediumGraph ? '0s' : '0.15s';
    const edgeTransition = this.mediumGraph ? 'none' : 'line-color, opacity, width';
    const edgeDuration = this.mediumGraph ? '0s' : '0.15s';
    return [
      { selector: 'core', style: {
        'selection-box-color': '#AAD8FF', 'selection-box-border-color': '#8BB0D0', 'selection-box-opacity': 0.5
      }},
      { selector: 'node', style: {
        'label': 'data(label)', 'text-valign': 'bottom', 'text-halign': 'center',
        'font-size': '9px', 'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'color': dark ? 'rgba(228,228,239,0.9)' : 'rgba(32,33,36,0.9)',
        'text-outline-color': dark ? 'rgba(30,30,46,0.9)' : 'rgba(255,255,255,0.9)',
        'text-outline-width': 2, 'text-wrap': 'ellipsis', 'text-max-width': '80px',
        'width': nodeSize, 'height': nodeSize,
        'shape': 'ellipse', 'border-width': 1.5,
        'border-color': dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.12)', 'border-opacity': 1,
        'background-color': 'data(color)', 'background-opacity': 0.9, 'text-opacity': 0,
        'overlay-padding': '6px', 'z-index': 10,
        'transition-property': nodeTransition, 'transition-duration': nodeDuration
      }},
      { selector: 'node:active', style: { 'overlay-opacity': 0.05 }},
      { selector: 'node:grabbed', style: {
        'text-opacity': 1, 'border-width': 2.5,
        'border-color': dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)'
      }},
      // 悬停/高亮:标签加背景色块(芯片),在密集节点中保证标题可读
      { selector: 'node.hovered', style: {
        'text-opacity': 1, 'font-size': '11px', 'text-outline-width': 3,
        'text-background-color': dark ? '#1c2028' : '#ffffff',
        'text-background-opacity': 0.85, 'text-background-padding': '4px',
        'text-background-shape': 'roundrectangle',
        'border-width': 2.5,
        'border-color': dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.25)', 'z-index': 999
      }},
      { selector: 'node.highlighted', style: {
        'border-width': 3, 'border-color': '#AAD8FF', 'border-opacity': 0.6,
        'text-opacity': 1, 'font-size': '11px', 'text-outline-width': 3,
        'text-background-color': dark ? '#1c2028' : '#ffffff',
        'text-background-opacity': 0.85, 'text-background-padding': '4px',
        'text-background-shape': 'roundrectangle',
        'z-index': 999
      }},
      // 大图 hover 的邻居:只加边框高亮,不显示标题(避免密集区标题互相淹没)
      { selector: 'node.neighbor', style: {
        'border-width': 2, 'border-color': '#AAD8FF', 'border-opacity': 0.5, 'z-index': 100
      }},
      { selector: 'node.unhighlighted', style: { 'opacity': 0.15, 'text-opacity': 0 }},
      { selector: 'node.search-match', style: {
        'border-width': 3, 'border-color': '#f59e0b', 'text-opacity': 1, 'font-size': '11px',
        'text-background-color': dark ? '#1c2028' : '#ffffff',
        'text-background-opacity': 0.85, 'text-background-padding': '4px',
        'text-background-shape': 'roundrectangle',
        'z-index': 998
      }},
      { selector: 'edge', style: {
        'width': edgeWidth,
        'line-color': dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
        'curve-style': 'haystack', 'haystack-radius': 0.5, 'opacity': edgeOpacity,
        'overlay-padding': '3px',
        'transition-property': edgeTransition, 'transition-duration': edgeDuration
      }},
      { selector: 'edge[group="domain"]', style: { 'line-color': groupDomain }},
      { selector: 'edge[group="tag"]', style: { 'line-color': groupTag }},
      { selector: 'edge[group="similar"]', style: { 'line-color': groupSimilar }},
      // hover 高亮边:变粗幅度收敛(2-6 → 1.5-4),粗线重绘面积大,hover 频繁触发时更易卡顿
      { selector: 'edge.highlighted', style: { 'width': 'mapData(weight, 1, 10, 1.5, 4)', 'opacity': 0.9, 'z-index': 500 }},
      { selector: 'edge.unhighlighted', style: { 'opacity': 0.03 }}
    ];
  }

  // ===== 初始化 =====
  init(data) {
    this.currentData = data;
    this._ensureContainer();

    if (this.cy) { this.cy.destroy(); this.cy = null; }

    // 节点数分级,决定布局与交互策略
    // 阈值优先取自数据层(成本模型推导,与边生成逻辑保持一致),缺省时动态计算
    const nodeCount = data.elements.filter(e => !e.data.source).length;
    const t = data.thresholds || GraphCore.computeGraphThresholds(nodeCount);
    this.mediumGraph = t.mediumGraph;   // 中等图:降迭代、关动画、节流 hover
    this.largeGraph = t.largeGraph;
    this.hugeGraph = t.hugeGraph;

    // 大图启用聚类折叠:9k 节点 → 21 个超级节点,点击展开
    if (this.hugeGraph && !data.isClustered) {
      this.expandedClusters = new Set();
      const clustered = GraphCore.buildClusteredView(data, this.expandedClusters);
      this._initWithClustered(clustered);
      return;
    }

    this._initWithData(data);
  }

  // 聚类折叠模式初始化
  _initWithClustered(clusteredData) {
    this.isClusteredMode = true;
    this.clusteredData = clusteredData;

    // 预缓存标签颜色(原数据)
    this._precacheTagColors(this.currentData);

    // 样式增加 compound 父节点支持 + 聚类节点美化
    const dark = GraphCore.isDarkTheme();
    const style = this.getCyStyle();
    style.push(
      // ===== 未展开超级节点:圆形,聚类色实心,带数量徽章 =====
      { selector: 'node[?isCluster][!isExpanded]', style: {
        'shape': 'ellipse',
        'background-color': 'data(color)',
        'background-opacity': 0.9,
        'background-blacken': dark ? -0.15 : 0,
        'width': 'mapData(clusterCount, 1, 500, 28, 70)',
        'height': 'mapData(clusterCount, 1, 500, 28, 70)',
        'border-width': 2,
        'border-color': dark ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.7)',
        'border-opacity': 1,
        'font-size': '10px',
        'font-weight': 600,
        'color': dark ? 'rgba(240,240,250,0.95)' : 'rgba(20,20,35,0.9)',
        'text-outline-color': dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.95)',
        'text-outline-width': 3,
        'text-opacity': 1, 'text-valign': 'bottom', 'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'ellipsis', 'text-max-width': '110px',
        'label': 'data(label)',
        'overlay-padding': '8px', 'z-index': 100,
        'transition-property': 'border-width, background-opacity, width, height',
        'transition-duration': '0.18s'
      }},
      // 未展开超级节点 hover:加粗边框 + 提亮
      { selector: 'node[?isCluster][!isExpanded].hovered', style: {
        'border-width': 3.5,
        'background-opacity': 1,
        'border-color': dark ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.9)',
        'z-index': 999
      }},
      // 未展开超级节点 selected
      { selector: 'node[?isCluster][!isExpanded]:selected', style: {
        'border-width': 3, 'border-color': '#f59e0b', 'border-opacity': 0.9
      }},

      // ===== 已展开父节点:淡色虚线容器,仅作视觉分组 =====
      { selector: 'node[?isCluster][?isExpanded]', style: {
        'shape': 'round-rectangle',
        'background-color': 'data(color)',
        'background-opacity': dark ? 0.1 : 0.07,
        'background-blacken': 0,
        'border-width': 1.5,
        'border-color': 'data(color)',
        'border-opacity': 0.45,
        'font-size': '9px',
        'font-weight': 500,
        'color': dark ? 'rgba(200,210,230,0.7)' : 'rgba(60,70,90,0.7)',
        'text-outline-width': 0,
        'text-opacity': 0.8, 'text-valign': 'top', 'text-halign': 'center',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis', 'text-max-width': '140px',
        'label': 'data(label)',
        'padding': '30px',
        'compound-sizing-wrt-labels': 'exclude',
        'z-index': 1,
        'transition-property': 'background-opacity, border-opacity',
        'transition-duration': '0.2s'
      }},
      // 已展开父节点 hover:容器微亮
      { selector: 'node[?isCluster][?isExpanded].hovered', style: {
        'background-opacity': dark ? 0.16 : 0.12,
        'border-opacity': 0.7,
        'border-width': 2
      }},

      // ===== 展开后内部子节点:继承聚类色,圆形 =====
      { selector: '$node > node', style: {
        'shape': 'ellipse',
        'background-color': 'data(color)',
        'background-opacity': 0.85,
        'width': 'mapData(weight, 1, 10, 8, 24)',
        'height': 'mapData(weight, 1, 10, 8, 24)',
        'border-width': 1,
        'border-color': dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)',
        'border-opacity': 0.8,
        'font-size': '8px',
        'color': dark ? 'rgba(228,228,239,0.9)' : 'rgba(32,33,36,0.9)',
        'text-outline-color': dark ? 'rgba(30,30,46,0.9)' : 'rgba(255,255,255,0.9)',
        'text-outline-width': 2,
        'text-opacity': 0, 'text-valign': 'bottom', 'text-halign': 'center',
        'text-wrap': 'ellipsis', 'text-max-width': '70px',
        'z-index': 10
      }},

      // ===== 聚类间边:淡色连接 =====
      { selector: 'edge[?isClusterEdge]', style: {
        'line-color': dark ? 'rgba(160,170,200,0.25)' : 'rgba(100,110,140,0.2)',
        'width': 'mapData(weight,1,10,1,3)',
        'opacity': 0.4,
        'curve-style': 'bezier'
      }}
    );

    this.cy = cytoscape({
      container: document.getElementById('cy'),
      elements: clusteredData.elements,
      style,
      layout: {
        name: 'cose', animate: true, animationDuration: 600,
        randomize: true, fit: true, padding: 40,
        nodeRepulsion: 800000, idealEdgeLength: 150, nodeOverlap: 30,
        refresh: 20, componentSpacing: 120, gravity: 50,
        numIter: 500, initialTemp: 200, coolingFactor: 0.95, minTemp: 1.0
      },
      minZoom: 0.2, maxZoom: 5,
      boxSelectionEnabled: false, selectionType: 'single',
      hideEdgesOnViewport: true, textureOnViewport: true, pixelRatio: 1,
      // 交互平滑:拖拽/缩放时启用运动模糊渲染,显著降低卡顿感
      motionBlur: true, motionBlurOpacity: 0.15
    });

    this._bindEvents();
    this._bindClusterEvents();

    this.cy.on('layoutstop', () => {
      this.cy.fit(undefined, 40);
      this._updateZoomLevel();
    });
    this.cy.on('zoom', () => {
      this._updateZoomLevel();
      this._scheduleLabelVisibility();
    });

    this._emitStats();
  }

  // 聚类模式:点击超级节点展开/折叠
  _bindClusterEvents() {
    this.cy.on('tap', 'node[?isCluster]', (evt) => {
      const node = evt.target;
      const clusterKey = node.data('clusterKey');
      if (this.expandedClusters.has(clusterKey)) {
        // 已展开 → 折叠
        this.expandedClusters.delete(clusterKey);
      } else {
        // 展开
        this.expandedClusters.add(clusterKey);
      }
      // 用新数据重建
      const clustered = GraphCore.buildClusteredView(this.currentData, this.expandedClusters);
      this.clusteredData = clustered;
      this.cy.destroy();
      this.cy = null;
      this._initWithClustered(clustered);
    });
  }

  // 普通模式初始化(原有逻辑)
  _initWithData(data) {
    this.isClusteredMode = false;
    this._precacheTagColors(data);

    let layout;
    if (this.hugeGraph) {
      layout = {
        name: 'concentric', animate: false, fit: true, padding: 30,
        concentric: n => n.data('weight') || 1,
        levelWidth: () => 3, minNodeSpacing: 12
      };
    } else if (this.largeGraph) {
      // 大图(2000-5000):cose 力导向对 O(n²) 节点计算实测 ~8s 阻塞主线程,
      // 改为 concentric 即时出图(O(n) ~50ms),力导向布局随后在主线程 rAF 时间切片渐进成型
      layout = {
        name: 'concentric', animate: false, fit: true, padding: 30,
        concentric: n => n.data('weight') || 1,
        levelWidth: () => 3, minNodeSpacing: 12
      };
    } else if (this.mediumGraph) {
      // 中等图(400-2000):降迭代、关动画,避免布局期间持续重绘卡顿
      layout = {
        name: 'cose',
        animate: false,
        randomize: false, fit: true, padding: 30,
        nodeRepulsion: 400000, idealEdgeLength: 100, nodeOverlap: 20,
        refresh: 50,
        componentSpacing: 100, edgeElasticity: 100, nestingFactor: 5, gravity: 80,
        numIter: 500, initialTemp: 200, coolingFactor: 0.95, minTemp: 1.0
      };
    } else {
      layout = {
        name: 'cose',
        animate: true,
        animationDuration: 800,
        animationEasing: 'ease-in-out-cubic',
        randomize: false, fit: true, padding: 30,
        nodeRepulsion: 400000, idealEdgeLength: 100, nodeOverlap: 20,
        refresh: 20,
        componentSpacing: 100, edgeElasticity: 100, nestingFactor: 5, gravity: 80,
        numIter: 1000, initialTemp: 200, coolingFactor: 0.95, minTemp: 1.0
      };
    }

    this.cy = cytoscape({
      container: document.getElementById('cy'),
      elements: data.elements,
      style: this.getCyStyle(),
      layout,
      minZoom: 0.2, maxZoom: 5,
      boxSelectionEnabled: false, selectionType: 'single',
      // 中等图+ 开启视口优化:缩放/平移时隐藏边、使用纹理缓存
      hideEdgesOnViewport: this.mediumGraph,
      textureOnViewport: this.mediumGraph,
      pixelRatio: 1,
      // 交互平滑:拖拽/缩放时启用运动模糊渲染,显著降低卡顿感
      motionBlur: this.mediumGraph, motionBlurOpacity: 0.15
    });

    this._bindEvents();

    // 大图:concentric 布局在 cytoscape() 构造内同步完成(animate:false),
    // layoutstop 不会在构造后触发,因此直接在此启动簇网布局(确定性,非环形)
    if (this.largeGraph) this._startFRLayout(false);

    this.cy.on('layoutstop', () => {
      if (this.cy.zoom() > 1) {
        this.cy.fit(undefined, 30);
        if (this.cy.zoom() > 1) this.cy.zoom(1);
      }
      this._updateZoomLevel();
    });

    this.cy.on('zoom', () => {
      this._updateZoomLevel();
      this._scheduleLabelVisibility();
    });

    this._emitStats();
  }

  // ===== 大图簇网布局(主线程 rAF 时间切片) =====
  // 主线程用 concentric 即时出图后,用 GraphLayout.createClusterWebLayout 计算分层簇网:
  // 簇中心有机散布 + 成员按簇大小撒成团 → 盘丝错节。Phase 1 分帧计算,位置经 rAF 应用。
  _startFRLayout(relayout) {
    if (!this.cy || !this.cy.nodes().length) return;
    this._stopFRLayout();
    const nodes = this.cy.nodes();
    const edges = this.cy.edges();
    // 边转为索引对,减少布局内字符串匹配开销;w=边权重(domain 结构边全量、tag/similar 边降权降雾化)
    const idToIdx = new Map();
    nodes.forEach((n, i) => idToIdx.set(n.id(), i));
    const edgeList = edges.map(e => {
      const grp = e.data('group');
      return { s: idToIdx.get(e.source().id()), t: idToIdx.get(e.target().id()), w: grp === 'domain' ? 1 : 0.5 };
    });
    // 按域名家族分组(布局专用):space.bilibili.com + bilibili.com 归入同一布局簇,
    // 避免同一站点的两个域簇在图上形成两个独立"大圆圈"(用户反馈"两个内环的圆圈")
    const layoutDomain = (d) => {
      if (!d || d === '(unknown)') return d;
      // 仅剥离常见的"栏目子域"前缀,合并到主域;非栏目型子域(如 github.io)保持独立
      for (const p of ['www.', 'space.', 'zhuanlan.', 'bbs.', 'v.', 'i.', 't.', 'm.', 'blog.', 'music.', 'live.', 'tieba.']) {
        if (d.length > p.length && d.startsWith(p) && d.indexOf('.', p.length) > 0) return d.slice(p.length);
      }
      return d;
    };
    const clusterIdx = new Map();
    const clusterOf = new Int32Array(nodes.length);
    nodes.forEach((n, i) => {
      const dom = layoutDomain(n.data('domain') || '(unknown)');
      if (!clusterIdx.has(dom)) clusterIdx.set(dom, clusterIdx.size);
      clusterOf[i] = clusterIdx.get(dom);
    });

    this._layoutCancelled = false;
    this._userPanned = false;   // 布局成型期间用户是否动过视图(结束时不覆盖)
    this._applyIdx = 0;         // 分帧应用游标(每次布局重置,避免残留旧值)
    this._layoutPositions = null;
    // 分层簇网布局:簇中心有机散布 + 成员按簇大小撒成团,确定性、非环形
    // relayout 时换随机 seed,得到新的排布
    let layout;
    try {
      layout = GraphLayout.createClusterWebLayout(
        nodes.map(n => ({ id: n.id() })),
        edgeList,
        clusterOf,
        { iterations: 200, heavyRepel: 3, seed: relayout ? Math.floor(Math.random() * 1e6) : 0 }
      );
    } catch (err) {
      console.error('[graph] 簇网布局计算失败:', err);
      return;
    }
    this._layoutStepper = layout;
    const self = this;
    const tick = () => {
      if (!self.cy || self._layoutCancelled) { self._layoutStepper = null; return; }
      if (!self._layoutPositions) {
        // Phase 1:分片计算布局(每帧 ≤4ms)
        const done = layout.step(4);
        const p = layout.getPositions();
        if (p) self._layoutPositions = p;      // Phase 2 完成,拿到最终位置 → 进入分帧应用
        else if (done) { self._layoutStepper = null; return; }
        else { requestAnimationFrame(tick); return; }
      }
      // Phase 2:分帧应用位置。一次全量应用 3500+ 个 position + 后续 fit 在同帧会造成
      // 200ms+ 长任务(rAF Violation),改为每帧一批、fit 放独立帧,把卡顿均摊到多帧
      const total = self.cy.nodes().length;
      const BATCH = 1200;
      const from = self._applyIdx || 0;
      const end = Math.min(total, from + BATCH);
      self._applyLayoutPositions(self._layoutPositions, from, end);
      self._applyIdx = end;
      if (end >= total) {
        self._layoutStepper = null;
        self._layoutPositions = null;
        requestAnimationFrame(() => {
          if (self.cy && !self._userPanned) self.cy.fit(undefined, 30);
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _stopFRLayout() {
    this._layoutCancelled = true;
    this._layoutStepper = null;
    this._layoutPositions = null;
    this._applyIdx = 0;
  }

  // 应用布局位置;带 [from, to) 范围时仅更新该区间节点(分帧应用,避免单帧长任务)
  _applyLayoutPositions(positions, from, to) {
    if (!this.cy) return;
    const nodes = this.cy.nodes();
    const start = from === undefined ? 0 : from;
    const end = to === undefined ? nodes.length : Math.min(to, nodes.length);
    this.cy.batch(() => {
      for (let i = start; i < end; i++) {
        // 必须用对象形式 position({x,y}):position(x,y) 双数字在 cytoscape 中是静默 no-op,
        // 会导致簇网布局从未应用、一直显示初始 concentric 圆环("环状大圆圈"根因)
        nodes[i].position({ x: positions[i * 2], y: positions[i * 2 + 1] });
      }
    });
  }

  // 预缓存标签颜色:扫描所有节点的 tags,批量查颜色后写入 node data 的 _tagColors
  _precacheTagColors(data) {
    const allTags = new Set();
    for (const el of data.elements) {
      if (el.data.tags && Array.isArray(el.data.tags)) {
        for (const t of el.data.tags) allTags.add(t);
      }
    }
    // 异步预查,完成后写入 cy 节点(若 cy 已存在)
    if (typeof GraphCore !== 'undefined' && GraphCore.getTagColor) {
      const colorMap = {};
      const tasks = Array.from(allTags).map(async t => {
        const c = await GraphCore.getTagColor(t);
        colorMap[t] = c;
      });
      Promise.all(tasks).then(() => {
        this._tagColorCache = colorMap;
        if (this.cy) {
          this.cy.batch(() => {
            this.cy.nodes().forEach(n => {
              const tags = n.data('tags') || [];
              const colors = tags.map(t => colorMap[t] || '#9aa0a6');
              n.data('_tagColors', colors);
            });
          });
        }
      });
    }
  }

  _ensureContainer() {
    let cyEl = document.getElementById('cy');
    if (!cyEl) {
      cyEl = document.createElement('div');
      cyEl.id = 'cy';
      cyEl.className = 'cy-container';
      this.container.appendChild(cyEl);
    } else {
      cyEl.style.display = '';
    }
  }

  // ===== 事件绑定 =====
  _bindEvents() {
    // 拖拽/缩放交互期间抑制 hover 重活:平移时节点在光标下滑过会连续触发 mouseover,
    // 若每次都做全图 addClass 或 renderedBoundingBox 布局计算,拖拽会明显卡顿
    this.cy.on('panstart', () => { this._isInteracting = true; this._userPanned = true; });
    this.cy.on('panend', () => {
      this._isInteracting = false;
      if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
      this._clearAllHighlights();
    });
    // 滚轮缩放同样会移动节点到光标下,用防抖标记交互期抑制 hover 重活
    this.cy.on('zoom', () => {
      this._isInteracting = true;
      this._userPanned = true;
      if (this._zoomInteractTimer) clearTimeout(this._zoomInteractTimer);
      this._zoomInteractTimer = setTimeout(() => {
        this._zoomInteractTimer = null;
        this._isInteracting = false;
        this._clearAllHighlights();
      }, 200);
    });

    this.cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      // 拖拽中:仅隐藏悬浮卡片,不做高亮与卡片定位
      if (this._isInteracting) {
        if (this.hoverCard) this.hoverCard.style.display = 'none';
        return;
      }
      const isCluster = node.data('isCluster');

      // 超级节点:用 .hovered class,不扩散邻居
      if (isCluster) {
        node.addClass('hovered');
      } else if (this.largeGraph) {
        // 大图:节流邻居扩散,只增量高亮 O(degree) 集合,不做全图 addClass
        this._scheduleHoverHighlight(node);
      } else if (this.mediumGraph) {
        // 中等图:节流邻居扩散,避免快速移动时全图 addClass 堆积
        this._scheduleHoverHighlight(node);
      } else {
        const connected = node.connectedEdges().connectedNodes();
        this.cy.elements().addClass('unhighlighted');
        node.removeClass('unhighlighted').addClass('highlighted');
        connected.removeClass('unhighlighted').addClass('highlighted');
        node.connectedEdges().removeClass('unhighlighted').addClass('highlighted');
      }
      // 记录当前悬停节点:标题芯片是 80ms 防抖后才渲染,防抖回调需据此重新定位卡片
      this._hoverNodeId = node.id();
      this._showHoverCard(node, evt.originalEvent);
      if (this.callbacks.nodeHover) this.callbacks.nodeHover({ id: node.id(), data: node.data() });
    });

    this.cy.on('mouseout', 'node', (evt) => {
      const node = evt.target;
      this._hoverNodeId = null; // 悬停结束,防抖回调不再重新定位卡片
      if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
      // 卡片立即隐藏;高亮清理延迟到下一帧——否则鼠标移出的瞬间会同步触发
      // 大规模 removeClass + 整帧重绘(3500 节点图上单次重绘开销大),与卡片消失叠加成掉帧
      if (this.hoverCard) this.hoverCard.style.display = 'none';
      if (this._pendingClearRaf) cancelAnimationFrame(this._pendingClearRaf);
      this._pendingClearRaf = requestAnimationFrame(() => {
        this._pendingClearRaf = null;
        // 若已快速移到另一节点(mouseover 已重设 _hoverNodeId),清理交给新节点的高亮流程,
        // 跳过"清旧+亮新"的中间态,避免两次重绘
        if (this._hoverNodeId) return;
        if (node.data('isCluster')) {
          node.removeClass('hovered');
        } else if (this.largeGraph) {
          // 增量清理上次高亮集合,避免全图扫描
          this._clearHoverHighlight();
        } else {
          this.cy.elements().removeClass('unhighlighted').removeClass('highlighted');
        }
      });
    });

    this.cy.on('tap', 'node', (evt) => {
      const url = evt.target.data('url');
      if (url && this.callbacks.nodeClick) this.callbacks.nodeClick({ url, id: evt.target.id() });
    });

    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.cy.elements().removeClass('unhighlighted').removeClass('highlighted');
      }
    });

    this._updateLabelVisibility();
  }

  // 标签可见性节流(zoom 高频触发,避免每次都 batch 全图)
  _scheduleLabelVisibility() {
    if (this._labelVisTimer) return;
    this._labelVisTimer = setTimeout(() => {
      this._labelVisTimer = null;
      this._updateLabelVisibility();
    }, 120);
  }

  // hover 邻居扩散节流:节点多+边多,快速划过时只处理最后一个节点
  _scheduleHoverHighlight(node) {
    this._pendingHoverNode = node;
    if (this._hoverTimer) return;
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = null;
      const n = this._pendingHoverNode;
      if (!n || !this.cy || this._isInteracting) return;
      if (this.largeGraph) {
        // 大图:只增量高亮邻居集合(O(degree)),不做全图 addClass('unhighlighted');
        // 高亮预算分级:粗边路径重绘是最大开销,超大 hub(度>100)不重绘边本身,
        // 只取其 top 24 边对应的邻居做边框高亮,否则单帧重绘上百条粗边会明显卡顿
        this.cy.batch(() => {
          if (this._prevHighlightSet) this._prevHighlightSet.removeClass('highlighted').removeClass('neighbor');
          const edgesAll = n.connectedEdges();
          const degree = edgesAll.length;
          const MAX_EDGES = degree > 100 ? 24 : 60;
          let edges = edgesAll;
          if (degree > MAX_EDGES) {
            const ranked = edgesAll.map(e => ({ e, w: e.data('weight') || 0 }))
              .sort((a, b) => b.w - a.w).slice(0, MAX_EDGES).map(x => x.e);
            edges = this.cy.collection(ranked);
          }
          // 邻居排除悬停节点自身,避免其边框样式被 neighbor 类(2px)覆盖 highlighted(3px)
          const neighbors = edges.connectedNodes().difference(n);
          // 悬停节点:标题芯片;邻居:仅边框高亮不显示标题,避免密集区互相淹没
          n.addClass('highlighted');
          neighbors.addClass('neighbor');
          if (degree <= 100) edges.addClass('highlighted');   // 超大 hub 不重绘边
          let set = n.union(neighbors);
          if (degree <= 100) set = set.union(edges);
          this._prevHighlightSet = set;
        });
        // 此刻标题芯片已渲染,bbox 含标签 → 重新定位卡片到标题正下方/正上方
        if (this._hoverNodeId === n.id()) this._positionHoverCard(n);
      } else {
        // 用 batch 合并 style 操作,减少重绘次数
        this.cy.batch(() => {
          const connected = n.connectedEdges().connectedNodes();
          this.cy.elements().addClass('unhighlighted');
          n.removeClass('unhighlighted').addClass('highlighted');
          connected.removeClass('unhighlighted').addClass('highlighted');
          n.connectedEdges().removeClass('unhighlighted').addClass('highlighted');
        });
        // 标题芯片渲染后再定位卡片,避开标题
        if (this._hoverNodeId === n.id()) this._positionHoverCard(n);
      }
    }, 80);
  }

  // 清理高亮:优先只清理上次高亮集合(增量),再做一次全图兜底
  _clearHoverHighlight() {
    if (this._prevHighlightSet) {
      this._prevHighlightSet.removeClass('highlighted').removeClass('neighbor');
      this._prevHighlightSet = null;
    }
  }

  // 全量清理:交互结束/失焦时一次性兜底,清掉所有 highlight/unhighlight class
  _clearAllHighlights() {
    this._clearHoverHighlight();
    if (this.cy) this.cy.elements().removeClass('unhighlighted').removeClass('highlighted').removeClass('neighbor');
  }

  _updateLabelVisibility() {
    if (!this.cy) return;
    const zoom = this.cy.zoom();
    this.cy.batch(() => {
      // 大图:不启用"放大全显标签"——3563 节点全部出标题会互相淹没,
      // 标签只由 hover/search 的 class 控制(单节点标题)
      if (this.largeGraph) return;
      if (zoom > 1.5) this.cy.nodes().style('text-opacity', 1);
      else this.cy.nodes().style('text-opacity', 0);
    });
  }

  _updateZoomLevel() {
    if (this.zoomLevelEl && this.cy) this.zoomLevelEl.textContent = Math.round(this.cy.zoom() * 100) + '%';
  }

  _emitStats() {
    if (this.callbacks.stats && this.cy) {
      const expandedCount = this.expandedClusters ? this.expandedClusters.size : 0;
      const totalClusters = this.currentData ? this.currentData.clusters.size : 0;
      this.callbacks.stats({
        nodes: this.cy.nodes().length,
        edges: this.cy.edges().length,
        clusters: totalClusters,
        // 聚类模式附加信息:供 UI 更新徽章
        clusterMode: !!this.isClusteredMode,
        expandedClusters: expandedCount,
        totalClusters
      });
    }
  }

  // ===== 悬浮卡片 =====
  _showHoverCard(node, event) {
    if (!this.hoverCard) return;
    const isCluster = node.data('isCluster');

    if (isCluster) {
      // 超级节点:显示聚类名 + 数量 + 操作提示
      const label = node.data('label') || '';
      const count = node.data('clusterCount') || 0;
      const expanded = node.data('isExpanded');
      const clusterType = node.data('clusterType') || 'domain';
      const typeLabel = clusterType === 'domain' ? '域名' : (clusterType === 'tag' ? '标签' : '文件夹');
      this.hoverTitle.textContent = label;
      this.hoverMeta.innerHTML = `<span style="color:${node.data('color')};font-weight:600;">●</span> ${count} 个书签 · 按${typeLabel}聚类`;
      this.hoverTags.innerHTML = '';
      // 操作提示徽章
      const hint = document.createElement('span');
      hint.className = 'hover-card-tag';
      hint.style.background = expanded ? 'rgba(95,150,95,0.15)' : 'rgba(66,99,235,0.12)';
      hint.style.color = expanded ? '#3a7a3a' : '#4263eb';
      hint.textContent = expanded ? '点击折叠' : '点击展开内部节点';
      this.hoverTags.appendChild(hint);
    } else {
      this.hoverTitle.textContent = node.data('fullTitle') || node.data('label') || '(untitled)';
      this.hoverMeta.textContent = node.data('domain') || '';
      this.hoverTags.innerHTML = '';
      const tags = node.data('tags') || [];
      if (tags.length > 0) {
        const cachedColors = node.data('_tagColors') || [];
        tags.slice(0, 5).forEach((tag, i) => {
          const span = document.createElement('span');
          span.className = 'hover-card-tag';
          const color = cachedColors[i] || (this._tagColorCache && this._tagColorCache[tag]) || '#9aa0a6';
          span.style.background = color + '22';
          span.style.color = color;
          span.textContent = tag;
          this.hoverTags.appendChild(span);
        });
      }
    }
    this.hoverCard.style.display = 'block';
    this._positionHoverCard(node);
  }

  // 卡片定位:对齐悬停节点中心,垂直放在标题芯片正下方;下方空间不足时翻转到正上方。
  // bbox 默认含标签(includeLabels: true),标题芯片渲染后调用即可避开标题
  _positionHoverCard(node) {
    if (!this.hoverCard || this.hoverCard.style.display === 'none') return;
    if (node.removed()) return; // 节点已被移除(如聚类展开),不再定位
    const container = document.getElementById('cy').getBoundingClientRect();
    // 用卡片实际宽度(而非固定 280):max-width 280 下实际宽度随内容变化,
    // 若用固定值计算,窄卡片会整体偏左,中心对不齐标题
    const cardWidth = this.hoverCard.offsetWidth;
    const cardHeight = this.hoverCard.offsetHeight;
    const bbox = node.renderedBoundingBox();
    // 水平:卡片中心对齐节点中心
    let posX = bbox.x1 + bbox.w / 2 - cardWidth / 2;
    // 垂直:标题下方留 8px 间距
    let posY = bbox.y2 + 8;
    // 下方空间不足:改到标题上方
    if (posY + cardHeight > container.height) {
      posY = bbox.y1 - cardHeight - 8;
    }
    // 水平溢出:贴边
    if (posX + cardWidth > container.width - 8) posX = container.width - cardWidth - 8;
    if (posX < 8) posX = 8;
    // 垂直边界兜底
    if (posY < 8) posY = 8;
    if (posY + cardHeight > container.height - 8) posY = container.height - cardHeight - 8;
    this.hoverCard.style.left = Math.max(8, posX) + 'px';
    this.hoverCard.style.top = Math.max(8, posY) + 'px';
  }

  // ===== 搜索 =====
  search(matchedIds, total) {
    if (!this.cy) return;
    this.cy.nodes().removeClass('search-match');
    if (!matchedIds || matchedIds.size === 0) {
      this.cy.elements().removeClass('unhighlighted');
      return;
    }
    const matched = this.cy.nodes().filter(n => matchedIds.has(n.id()));
    matched.addClass('search-match');
    this.cy.elements().removeClass('unhighlighted');
    this.cy.elements().not(matched).not(matched.connectedEdges()).addClass('unhighlighted');
    // 大图不自动 fit(fit 计算开销大),只 fit 少量匹配
    if (matched.length > 0 && matched.length <= 20 && !this.hugeGraph) this.cy.fit(matched, 60);
  }

  // ===== 高亮聚类 =====
  highlightCluster(key) {
    if (!this.cy) return;
    const clusterNodes = this.cy.nodes().filter(n => n.data('cluster') === key);
    this.cy.elements().removeClass('unhighlighted').removeClass('highlighted');
    if (clusterNodes.length > 0) {
      this.cy.elements().addClass('unhighlighted');
      clusterNodes.removeClass('unhighlighted').addClass('highlighted');
      if (!this.largeGraph) {
        clusterNodes.connectedEdges().removeClass('unhighlighted').addClass('highlighted');
      }
      if (!this.hugeGraph) this.cy.fit(clusterNodes, 60);
    }
  }

  // ===== 重置视图 =====
  resetView() {
    if (this.cy) {
      this.cy.fit(undefined, 40);
      this.cy.elements().removeClass('unhighlighted').removeClass('highlighted').removeClass('search-match');
    }
    if (this.zoomLevelEl) this.zoomLevelEl.textContent = '100%';
  }

  // ===== 重布局 =====
  relayout() {
    if (!this.cy) return;
    let layout;
    if (this.hugeGraph) {
      layout = {
        name: 'concentric', animate: false, fit: true, padding: 30,
        concentric: n => n.data('weight') || 1, levelWidth: () => 3, minNodeSpacing: 12
      };
    } else if (this.largeGraph) {
      // 大图:主线程跑 cose 会阻塞 ~8s,改用簇网布局(重排,随机 seed)
      this._startFRLayout(true);
      return;
    } else {
      layout = {
        name: 'cose', randomize: false,
        animate: !this.largeGraph, animationDuration: this.largeGraph ? 0 : 800,
        animationEasing: 'ease-in-out-cubic', fit: true, padding: 30,
        nodeRepulsion: 400000, idealEdgeLength: 100, nodeOverlap: 20,
        refresh: this.largeGraph ? 100 : 20,
        componentSpacing: 100, edgeElasticity: 100, nestingFactor: 5, gravity: 80,
        numIter: this.largeGraph ? 300 : 1000, initialTemp: 200, coolingFactor: 0.95, minTemp: 1.0
      };
    }
    this.cy.layout(layout).run();
  }

  // ===== 缩放 =====
  zoomIn() { if (this.cy) this.cy.zoom(Math.min(5, this.cy.zoom() * 1.3)); }
  zoomOut() { if (this.cy) this.cy.zoom(Math.max(0.2, this.cy.zoom() / 1.3)); }

  // ===== 销毁 =====
  destroy() {
    this._stopFRLayout();
    if (this.cy) { this.cy.destroy(); this.cy = null; }
    if (this.hoverCard) this.hoverCard.style.display = 'none';
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = 'none';
  }

  // ===== 事件订阅 =====
  on(event, callback) {
    if (event === 'nodeClick') this.callbacks.nodeClick = callback;
    else if (event === 'nodeHover') this.callbacks.nodeHover = callback;
    else if (event === 'stats') this.callbacks.stats = callback;
  }

  // ===== 主题更新 =====
  updateTheme() {
    if (this.cy) this.cy.style(this.getCyStyle()).update();
  }

  // ===== 导出静态 HTML =====
  exportStaticHTML() {
    if (!this.cy) return null;
    const dark = GraphCore.isDarkTheme();
    const bgColor = dark ? '#0f1117' : '#fafbfc';
    const textColor = dark ? '#e4e6eb' : '#1a1d23';

    const nodesData = [];
    this.cy.nodes().forEach(node => {
      const pos = node.position();
      const cluster = node.data('cluster');
      const info = this.currentData.clusters.get(cluster);
      nodesData.push({
        id: node.id(), x: pos.x, y: pos.y,
        label: node.data('label') || '', fullTitle: node.data('fullTitle') || '',
        url: node.data('url') || '', color: info ? info.color : '#9aa0a6',
        tags: node.data('tags') || [], domain: node.data('domain') || ''
      });
    });

    const edgesData = [];
    this.cy.edges().forEach(edge => {
      edgesData.push({ source: edge.source().id(), target: edge.target().id(), weight: edge.data('weight') || 1 });
    });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodesData) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    const padding = 60;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;

    const legendData = [];
    const sorted = Array.from(this.currentData.clusters.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [key, info] of sorted) legendData.push({ color: info.color, label: info.label, count: info.count });

    return { nodesData, edgesData, legendData, width, height, minX: minX - padding, minY: minY - padding, bgColor, textColor, dark, clusterBy: this.currentData.clusterBy };
  }
}

window.Graph2D = Graph2D;
