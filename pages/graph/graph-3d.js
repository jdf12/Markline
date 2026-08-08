// ===== 知识图谱 · 3D 星系渲染器(Canvas 2D 伪 3D) =====
// 基于 demo-galaxy 改造,实现统一渲染器接口
// 接口:init / search / highlightCluster / resetView / relayout / destroy / on

class Graph3D {
  constructor(container) {
    this.container = container;
    this.canvas = null;
    this.ctx = null;
    this.rafId = null;
    this.W = 0; this.H = 0; this.cx = 0; this.cy = 0;

    this.nodes = [];      // 3D 节点 { id, x, y, z, rgb, size, weight, isHub, phase, tw, url, label, fullTitle, domain, tags, cluster }
    this.edges = [];      // { a, b, rgb }
    this.stars = [];      // 远处微星
    this.nebula = [];     // 星云粒子
    this.coreClouds = []; // 核心动态云团(L4)
    this.time = 0;        // 全局时间(湍流/脉动用)

    // 相机(俯视角度,凸显星系盘形态)
    this.rotX = 0.5; this.rotY = 0; this.autoRot = 0.0015;
    this.camZ = 0; this.targetCamZ = 0;
    this.focal = 500;
    // 屏幕空间缩放(独立于透视,可均匀放大到看清密集节点)
    this.zoom = 1; this.targetZoom = 1;
    // 平移偏移(配合缩放,围绕鼠标点放大)
    this.panX = 0; this.panY = 0;

    // 交互
    this.dragging = false; this.panning = false;
    this.lastX = 0; this.lastY = 0;
    this.mouseDown = null; // { x, y, t } 用于判断点击 vs 拖拽
    this.hoverNode = null;
    this.lastAutoRotTime = 0;

    // 搜索/高亮
    this.matchedIds = null;     // Set
    this.highlightClusterKey = null;

    // 飞行动画
    this.flyTarget = null;      // { rotX, rotY, camZ }
    this.flyProgress = 1;

    this.callbacks = { nodeClick: null, nodeHover: null, stats: null };
    this.currentData = null;
    this.time = 0;

    // 性能限流
    this._lastTwinkle = 0;
    this._lastHoverPick = 0;
  }

  // ===== 初始化 =====
  init(data) {
    this.currentData = data;
    this._ensureCanvas();
    this._buildScene(data);
    this._bindEvents();
    this._emitStats();
    this._loop();
  }

  _ensureCanvas() {
    // 隐藏 2D 容器
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = 'none';

    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.id = 'graph3dCanvas';
      this.canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;cursor:grab;';
      this.container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
    } else {
      this.canvas.style.display = '';
    }
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.container.getBoundingClientRect();
    this.W = rect.width;
    this.H = rect.height;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cx = this.W / 2;
    this.cy = this.H / 2;
  }

  // ===== 构建 3D 场景 =====
  // 多星系阈值:簇数 ≥ MULTI_GALAXY_MIN 时启用多星系模式,
  // 将语义关联紧密的域名簇聚合为独立星系,在 3D 空间中散布。
  // 小于阈值时走原单星系螺旋布局(小数据量无需分群)。
  _buildScene(data) {
    this.nodes = [];
    this.edges = [];
    this.isMultiGalaxy = false;
    this.galaxies = null;
    this.galaxyCenters = null;
    this.spaceR = 0;

    const clusters = Array.from(data.clusters.entries())
      .filter(([k]) => k !== '__other__')
      .sort((a, b) => b[1].count - a[1].count);
    const otherInfo = data.clusters.get('__other__');
    const clusterCount = clusters.length;

    const nodeElements = data.elements.filter(e => !e.data.source);
    const edgeElements = data.elements.filter(e => e.data.source);
    const totalNodes = nodeElements.length;

    // adaptive threshold: small datasets stay single-galaxy for visual cohesion
    const MULTI_GALAXY_MIN = Math.max(12, Math.ceil(200 / Math.sqrt(Math.max(1, totalNodes))));
    if (clusterCount >= MULTI_GALAXY_MIN) {
      this._buildMultiGalaxyScene(data, clusters, otherInfo, nodeElements, edgeElements);
    } else {
      this._buildSingleGalaxyScene(data, clusters, otherInfo, nodeElements, edgeElements);
    }
  }

  // ===== Single-galaxy mode =====
  _buildSingleGalaxyScene(data, clusters, otherInfo, nodeElements, edgeElements) {
    const totalNodes = nodeElements.length;
    const isSmall = totalNodes < 100;
    const clusterCount = clusters.length;
    // nodes placed outside core region — center glows unobstructed
    this.galaxyR = isSmall ? (160 + clusterCount * 10) : (200 + clusterCount * 12);
    this._coreGlowDamp = 1.0;
    const galaxyR = this.galaxyR;
    const diskThickness = galaxyR * 0.08;
    const armCount = Math.min(4, Math.max(2, Math.ceil(clusterCount / 6)));
    const armWinding = 2.8;
    const clusterCenters = new Map();

    clusters.forEach(([key, info], idx) => {
      const armIdx = idx % armCount;
      const posInArm = Math.floor(idx / armCount) + 1;
      const armLen = Math.ceil(clusterCount / armCount);
      const t = posInArm / Math.max(1, armLen);
      const minRadius = isSmall ? galaxyR * 0.35 : galaxyR * 0.3;
      const radius = minRadius + Math.pow(t, 0.7) * (galaxyR - minRadius);
      const baseAngle = armIdx * (Math.PI * 2 / armCount);
      const spiralAngle = baseAngle + t * Math.PI * 2 * armWinding;
      const jitter = 22;
      const cx = Math.cos(spiralAngle) * radius + (Math.random() - 0.5) * jitter;
      const cz = Math.sin(spiralAngle) * radius + (Math.random() - 0.5) * jitter;
      const cy = (Math.random() - 0.5) * diskThickness;
      clusterCenters.set(key, { x: cx, y: cy, z: cz, info, galaxyR, diskThickness });
    });

    if (otherInfo) {
      const otherR = isSmall ? galaxyR * 0.55 : galaxyR * 0.5;
      const otherAngle = Math.random() * 6.28;
      clusterCenters.set('__other__', { x: Math.cos(otherAngle) * otherR, y: 0, z: Math.sin(otherAngle) * otherR, info: otherInfo, isOther: true, galaxyR, diskThickness });
    }

    const { nodeMap } = this._placeAllNodes(clusterCenters, nodeElements, galaxyR, diskThickness);
    this._buildEdges(edgeElements, nodeMap);
    this._buildSingleGalaxyEffects(galaxyR, diskThickness, armCount, armWinding, totalNodes);
    this._buildDeepSpaceElements(totalNodes);
  }

  // ===== 多星系模式(簇数 ≥ 12) =====
  _buildMultiGalaxyScene(data, clusters, otherInfo, nodeElements, edgeElements) {
    this.isMultiGalaxy = true;
    this._coreGlowDamp = 1.0;

    // Phase 1: galaxy partition
    const galaxyResult = GraphCore.buildGalaxyGraph(nodeElements, edgeElements, data.clusters, {
      targetPerGalaxy: 300,
      maxGalaxyRatio: 1.8
    });
    const { galaxyAssignments, galaxies, interGalaxyEdges, clusterSizes } = galaxyResult;

    // add __other__ to smallest galaxy
    if (otherInfo && galaxies.length > 0) {
      const smallest = galaxies.reduce((a, b) => a.totalNodes <= b.totalNodes ? a : b);
      galaxyAssignments.set('__other__', smallest.id);
      smallest.totalNodes += otherInfo.count;
      smallest.clusters.push('__other__');
    }

    // adapt layout to dataset size: small datasets → closer galaxies, larger nodes
    const totalNodes = nodeElements.length;
    const adaptiveSep = Math.max(120, Math.min(450, totalNodes * 3.5));
    const nodeScale = totalNodes < 200 ? Math.max(1.3, (200 - totalNodes) / 120 + 1.3) : 1.0;

    // Phase 2: galaxy 3D positioning
    const layoutResult = GraphLayout.create3DGalaxyLayout(galaxies, interGalaxyEdges, {
      idealSep: adaptiveSep, iterations: 120, seed: this._relayoutSeed || 0
    });
    this.galaxies = galaxies;
    this.galaxyCenters = layoutResult.centers;
    this.spaceR = layoutResult.spaceR;
    this.galaxyR = 0;  // 多星系无全局 galaxyR

    // Phase 3: 按星系计算簇中心(局部螺旋臂 + 世界偏移)
    const clusterCenters = new Map();
    const clusterToGalaxy = new Map();
    for (const g of galaxies) {
      const gCenter = layoutResult.centers[g.id];
      const gClusters = g.clusters.filter(c => c !== '__other__');
      // 按大小排:clusters 已预排,但需过滤后重排
      const sortedGC = gClusters.sort((a, b) => {
        const sa = clusterSizes.get(a) || 0;
        const sb = clusterSizes.get(b) || 0;
        return sb - sa;
      });

      // galaxy radius proportional to sqrt(node count), with firm minimum for visibility
      const galaxyR = Math.max(100, 40 + Math.sqrt(g.totalNodes) * 22);
      const diskThickness = galaxyR * 0.08;
      const armCount = Math.min(3, Math.max(1, Math.ceil(sortedGC.length / 5)));
      const armWinding = 1.8 + (sortedGC.length / 15);  // 小星系旋臂更松

      sortedGC.forEach((key, idx) => {
        const armIdx = idx % armCount;
        const posInArm = Math.floor(idx / armCount) + 1;
        const armLen = Math.ceil(Math.max(1, sortedGC.length) / armCount);
        const t = posInArm / Math.max(1, armLen);
        const radius = 15 + Math.pow(t, 0.7) * galaxyR;
        const baseAngle = armIdx * (Math.PI * 2 / armCount);
        const spiralAngle = baseAngle + t * Math.PI * 2 * armWinding;
        const jitter = Math.max(8, galaxyR * 0.08);
        // 局部坐标(相对星系质心)
        const lx = Math.cos(spiralAngle) * radius + (Math.random() - 0.5) * jitter;
        const lz = Math.sin(spiralAngle) * radius + (Math.random() - 0.5) * jitter;
        const ly = (Math.random() - 0.5) * diskThickness;
        // 世界坐标
        clusterCenters.set(key, {
          x: gCenter.x + lx, y: gCenter.y + ly, z: gCenter.z + lz,
          galaxyR, diskThickness, galaxyId: g.id,
          galaxyCenter: gCenter
        });
        clusterToGalaxy.set(key, g.id);
      });

      // __other__ 散布在该星系外围
      if (g.clusters.includes('__other__')) {
        const otherR = galaxyR * 1.1 + Math.random() * galaxyR * 0.4;
        const otherT = Math.random() * 6.28;
        clusterCenters.set('__other__', {
          x: gCenter.x + Math.cos(otherT) * otherR,
          y: gCenter.y + (Math.random() - 0.5) * diskThickness * 1.5,
          z: gCenter.z + Math.sin(otherT) * otherR,
          galaxyR, diskThickness, galaxyId: g.id,
          galaxyCenter: gCenter, isOther: true
        });
        clusterToGalaxy.set('__other__', g.id);
      }

      // 存储星系元数据(供渲染使用)
      g._galaxyR = galaxyR;
      g._diskThickness = diskThickness;
      g._armCount = armCount;
      g._armWinding = armWinding;
    }

    // Phase 4: place nodes and edges (shared, with node scale for small datasets)
    const { nodeMap } = this._placeAllNodes(clusterCenters, nodeElements, undefined, undefined, nodeScale);
    this._buildEdges(edgeElements, nodeMap);

    // 给每个节点标记所属星系(用于 LOD / 导航)
    for (const n of this.nodes) {
      const gid = clusterToGalaxy.get(n.cluster);
      if (gid !== undefined) n.galaxyId = gid;
    }

    // Phase 5: multi-galaxy visual effects
    this._buildMultiGalaxyEffects();
    this._buildDeepSpaceElements(totalNodes);
  }

  // ===== Place all nodes (shared) =====
  // clusterCenters: Map<clusterKey, {x,y,z, galaxyR, diskThickness, isOther?, galaxyCenter?}>
  // nodeScale: boost factor for small datasets (default 1.0)
  // Returns { nodeMap }
  _placeAllNodes(clusterCenters, nodeElements, defaultGalaxyR, defaultDiskThickness, nodeScale = 1.0) {
    const nodeMap = new Map();
    const clusterNodes = new Map();
    for (const el of nodeElements) {
      const cluster = el.data.cluster || '__other__';
      if (!clusterNodes.has(cluster)) clusterNodes.set(cluster, []);
      clusterNodes.get(cluster).push(el);
    }

    let nodeIdx = 0;
    for (const [clusterKey, els] of clusterNodes) {
      const center = clusterCenters.get(clusterKey);
      if (!center) continue;

      els.sort((a, b) => (b.data.weight || 1) - (a.data.weight || 1));
      const hubEl = els[0];
      const galaxyR = center.galaxyR || defaultGalaxyR || 400;
      const diskThickness = center.diskThickness || defaultDiskThickness || 32;
      const gCenter = center.galaxyCenter || { x: 0, y: 0, z: 0 };

      els.forEach((el) => {
        const isHub = el === hubEl;
        const weight = el.data.weight || 1;
        let rgb = GraphCore.hexToRgb(el.data.color || '#9aa0a6');

        let x, y, z, distFromCore;
        if (center.isOther) {
          const r = galaxyR * 1.1 + Math.random() * galaxyR * 0.4;
          const t = Math.random() * 6.28;
          x = center.x + (Math.random() - 0.5) * galaxyR * 0.3;
          z = center.z + (Math.random() - 0.5) * galaxyR * 0.3;
          y = center.y + (Math.random() - 0.5) * diskThickness * 1.5;
          distFromCore = Math.sqrt(
            (x - gCenter.x) * (x - gCenter.x) + (z - gCenter.z) * (z - gCenter.z)
          );
        } else {
          const localR = 25 + Math.sqrt(els.length) * 8;
          if (isHub) {
            x = center.x; y = center.y; z = center.z;
          } else {
            const armAngle = Math.atan2(center.z - gCenter.z, center.x - gCenter.x);
            const tangentAngle = armAngle + Math.PI / 2 + 0.6;
            const along = (Math.random() - 0.5) * localR * 2.5;
            const across = (Math.random() - 0.5) * localR * 0.8;
            x = center.x + Math.cos(tangentAngle) * along + Math.cos(armAngle) * across;
            z = center.z + Math.sin(tangentAngle) * along + Math.sin(armAngle) * across;
            y = center.y + (Math.random() - 0.5) * diskThickness * 0.5;
          }
          distFromCore = Math.sqrt(
            (x - gCenter.x) * (x - gCenter.x) + (z - gCenter.z) * (z - gCenter.z)
          );
          // push non-hub nodes outside the bright core region
          if (!isHub) {
            const coreMin = (center.galaxyR || defaultGalaxyR || 400) * 0.28;
            if (distFromCore < coreMin && distFromCore > 0.01) {
              const dx = x - gCenter.x;
              const dz = z - gCenter.z;
              x = gCenter.x + (dx / distFromCore) * coreMin;
              z = gCenter.z + (dz / distFromCore) * coreMin;
              distFromCore = coreMin;
            }
          }
        }

        // 颜色按距所属星系核心距离渐变
        const distRatio = Math.min(1, distFromCore / Math.max(1, galaxyR));
        let tintRgb;
        if (distRatio < 0.25) {
          tintRgb = [255, 225, 160];
        } else if (distRatio < 0.6) {
          tintRgb = [240, 230, 220];
        } else {
          tintRgb = [130, 165, 230];
        }
        const tintStrength = 0.55;
        rgb = [
          Math.round(rgb[0] * (1 - tintStrength) + tintRgb[0] * tintStrength),
          Math.round(rgb[1] * (1 - tintStrength) + tintRgb[1] * tintStrength),
          Math.round(rgb[2] * (1 - tintStrength) + tintRgb[2] * tintStrength)
        ];

        const node = {
          idx: nodeIdx, id: el.data.id, x, y, z, rgb,
          size: (isHub ? 6 : (1 + weight * 0.3)) * nodeScale,
          weight, isHub,
          phase: Math.random() * 6.28,
          tw: 0.5 + Math.random() * 0.5,
          url: el.data.url, label: el.data.label, fullTitle: el.data.fullTitle,
          domain: el.data.domain, tags: el.data.tags || [], cluster: clusterKey
        };
        this.nodes.push(node);
        nodeMap.set(el.data.id, nodeIdx);
        nodeIdx++;
      });
    }
    return { nodeMap };
  }

  // ===== 构建边(共享) =====
  _buildEdges(edgeElements, nodeMap) {
    for (const el of edgeElements) {
      const a = nodeMap.get(el.data.source);
      const b = nodeMap.get(el.data.target);
      if (a === undefined || b === undefined) continue;
      const nodeA = this.nodes[a];
      const nodeB = this.nodes[b];
      // 多星系模式:标记跨星系边
      const isInterGalaxy = this.isMultiGalaxy && nodeA.galaxyId !== undefined &&
        nodeB.galaxyId !== undefined && nodeA.galaxyId !== nodeB.galaxyId;
      this.edges.push({
        a, b, rgb: nodeA.rgb, weight: el.data.weight || 1,
        isInterGalaxy
      });
    }
  }

  // ===== Single-galaxy visual effects =====
  _buildSingleGalaxyEffects(galaxyR, diskThickness, armCount, armWinding, totalNodes = 500) {
    const isSmall = totalNodes < 100;
    // small datasets: more particles (richness) but lower individual alpha (don't drown nodes)
    const sizeBoost = isSmall ? 1.4 : 1.0;
    const alphaDamp = isSmall ? 0.55 : 1.0;  // key fix: reduce per-particle opacity

    this.stars = [];
    const starCount = isSmall ? 400 : (this.nodes.length > 30000 ? 300 : (this.nodes.length > 10000 ? 600 : 1200));
    for (let i = 0; i < starCount; i++) {
      const r = 600 + Math.random() * 600;
      const t = Math.random() * 6.28, p = Math.acos(2 * Math.random() - 1);
      this.stars.push({
        x: r * Math.sin(p) * Math.cos(t), y: r * Math.sin(p) * Math.sin(t), z: r * Math.cos(p),
        b: (0.3 + Math.random() * 0.5) * (isSmall ? 1.2 : 1)
      });
    }

    this.nebula = [];
    this.coreClouds = [];
    if (this.nodes.length <= 30000) {
      // more particles but each fainter → rich texture without drowning nodes
      const nebulaCount = isSmall ? 650 : 500;
      for (let i = 0; i < nebulaCount; i++) {
        let x, y, z, rgb, size, a, arm = 0, spiralT = 0;
        const roll = Math.random();
        if (roll < (isSmall ? 0.28 : 0.35)) {
          const r = Math.pow(Math.random(), 0.5) * 60;
          const t = Math.random() * 6.28;
          const p = Math.acos(2 * Math.random() - 1);
          x = r * Math.sin(p) * Math.cos(t);
          y = r * Math.sin(p) * Math.sin(t) * 0.7;
          z = r * Math.cos(p);
          rgb = [180, 140, 90];
          size = (12 + Math.random() * 25) * sizeBoost;
          a = (0.025 + Math.random() * 0.025) * alphaDamp;
        } else {
          const r = 60 + Math.pow(Math.random(), 0.6) * galaxyR * 1.1;
          arm = Math.floor(Math.random() * armCount);
          spiralT = (r - 60) / galaxyR;
          const angle = arm * (Math.PI * 2 / armCount) + spiralT * Math.PI * 2 * armWinding
                       + (Math.random() - 0.5) * 0.8;
          x = Math.cos(angle) * r + (Math.random() - 0.5) * 30;
          z = Math.sin(angle) * r + (Math.random() - 0.5) * 30;
          y = (Math.random() - 0.5) * diskThickness * 0.8;
          rgb = spiralT < 0.5 ? [90, 70, 150] : [60, 80, 140];
          size = (15 + Math.random() * 28) * sizeBoost;
          a = (0.015 + Math.random() * 0.02) * alphaDamp;
        }
        this.nebula.push({
          x, y, z, rgb, size, a,
          ox: x, oy: y, oz: z,
          drift: roll >= (isSmall ? 0.28 : 0.35),
          arm, spiralT,
          phase: Math.random() * 6.28,
          driftSpeed: 0.3 + Math.random() * 0.4,
          driftR: 3 + Math.random() * 4
        });
      }
      // core clouds: slightly more but much fainter
      const coreCloudCount = isSmall ? 30 : 25;
      for (let i = 0; i < coreCloudCount; i++) {
        const r = 20 + Math.pow(Math.random(), 0.6) * 70;
        const t = Math.random() * 6.28;
        const x = Math.cos(t) * r;
        const z = Math.sin(t) * r;
        const y = (Math.random() - 0.5) * diskThickness * 0.5;
        const colorRoll = Math.random();
        const rgb = colorRoll < 0.5 ? [230, 160, 100] : [250, 200, 130];
        const size = (18 + Math.random() * 17) * sizeBoost;
        const a = (0.02 + Math.random() * 0.02) * alphaDamp;
        this.coreClouds.push({
          x, y, z, rgb, size, a,
          ox: x, oy: y, oz: z,
          phase: Math.random() * 6.28,
          orbitR: r,
          orbitT: t,
          orbitSpeed: 0.05 + Math.random() * 0.08,
          wobbleR: 6 + Math.random() * 4
        });
      }
    }
  }

  // ===== 多星系视觉效果 =====
  _buildMultiGalaxyEffects() {
    const G = this.galaxies.length;
    const spaceR = this.spaceR;

    // 深空远星:分布在整个多星系空间中
    this.stars = [];
    const starCount = Math.min(3000, 800 + G * 150);
    for (let i = 0; i < starCount; i++) {
      const r = spaceR * 0.4 + Math.random() * spaceR * 1.1;
      const t = Math.random() * 6.28, p = Math.acos(2 * Math.random() - 1);
      this.stars.push({
        x: r * Math.sin(p) * Math.cos(t),
        y: r * Math.sin(p) * Math.sin(t),
        z: r * Math.cos(p),
        b: 0.2 + Math.random() * 0.4
      });
    }

    // 星云:按星系数比例分配,每个星系有独立的旋臂云雾
    this.nebula = [];
    this.coreClouds = [];
    if (this.nodes.length > 30000) return;

    const totalNebula = Math.min(1200, 200 + G * 80);
    for (const g of this.galaxies) {
      const gCenter = this.galaxyCenters[g.id];
      const galaxyR = g._galaxyR || 200;
      const diskThickness = g._diskThickness || 16;
      const armCount = g._armCount || 2;
      const armWinding = g._armWinding || 2.0;
      // 按节点数分配星云粒子
      const nebulaShare = Math.max(30, Math.round(totalNebula * g.totalNodes / this.nodes.length));

      for (let i = 0; i < nebulaShare; i++) {
        let lx, ly, lz, rgb, size, a, arm = 0, spiralT = 0;
        const roll = Math.random();
        if (roll < 0.3) {
          // 星系核云团
          const r = Math.pow(Math.random(), 0.5) * galaxyR * 0.25;
          const t = Math.random() * 6.28;
          const p = Math.acos(2 * Math.random() - 1);
          lx = r * Math.sin(p) * Math.cos(t);
          ly = r * Math.sin(p) * Math.sin(t) * 0.6;
          lz = r * Math.cos(p);
          rgb = [180, 140, 90];
          size = 10 + Math.random() * 20;
          a = 0.02 + Math.random() * 0.02;
        } else {
          // 旋臂云雾
          const r = galaxyR * 0.2 + Math.pow(Math.random(), 0.6) * galaxyR * 0.95;
          arm = Math.floor(Math.random() * armCount);
          spiralT = (r - galaxyR * 0.2) / galaxyR;
          const angle = arm * (Math.PI * 2 / armCount) + spiralT * Math.PI * 2 * armWinding
                       + (Math.random() - 0.5) * 0.6;
          lx = Math.cos(angle) * r + (Math.random() - 0.5) * galaxyR * 0.08;
          lz = Math.sin(angle) * r + (Math.random() - 0.5) * galaxyR * 0.08;
          ly = (Math.random() - 0.5) * diskThickness * 0.7;
          rgb = spiralT < 0.5 ? [85, 65, 145] : [55, 75, 135];
          size = 12 + Math.random() * 24;
          a = 0.012 + Math.random() * 0.018;
        }
        this.nebula.push({
          x: gCenter.x + lx, y: gCenter.y + ly, z: gCenter.z + lz,
          rgb, size, a,
          ox: gCenter.x + lx, oy: gCenter.y + ly, oz: gCenter.z + lz,
          drift: roll >= 0.3,
          arm, spiralT, galaxyId: g.id,
          phase: Math.random() * 6.28,
          driftSpeed: 0.2 + Math.random() * 0.35,
          driftR: 2 + Math.random() * 4
        });
      }

      // 每个星系的核心动态云团
      const coreCloudCount = Math.max(5, Math.round(18 * g.totalNodes / 500));
      for (let i = 0; i < coreCloudCount; i++) {
        const r = galaxyR * 0.05 + Math.pow(Math.random(), 0.6) * galaxyR * 0.32;
        const t = Math.random() * 6.28;
        const lx = Math.cos(t) * r;
        const lz = Math.sin(t) * r;
        const ly = (Math.random() - 0.5) * diskThickness * 0.4;
        const colorRoll = Math.random();
        const rgb = colorRoll < 0.5 ? [225, 155, 95] : [245, 195, 125];
        const size = 14 + Math.random() * 14;
        const a = 0.015 + Math.random() * 0.018;
        this.coreClouds.push({
          x: gCenter.x + lx, y: gCenter.y + ly, z: gCenter.z + lz,
          rgb, size, a,
          ox: gCenter.x + lx, oy: gCenter.y + ly, oz: gCenter.z + lz,
          phase: Math.random() * 6.28,
          orbitR: r, orbitT: t, galaxyId: g.id,
          orbitSpeed: 0.04 + Math.random() * 0.07,
          wobbleR: 4 + Math.random() * 4
        });
      }
    }
  }

  // ===== Deep space elements: halos, dust lanes, deep star field =====
  // totalNodes: used to scale elements — small datasets get minimal deep space so nodes stay focal
  _buildDeepSpaceElements(totalNodes = 500) {
    const spaceR = this.spaceR || 600;
    // scale factor: 0 at 0 nodes → 1.0 at 500+ nodes
    const ds = Math.max(0, Math.min(1, totalNodes / 500));

    // -- Galactic halos: large faint spherical glows around each galaxy --
    this.halos = [];
    if (this.isMultiGalaxy && this.galaxies && this.galaxyCenters) {
      for (const g of this.galaxies) {
        const gc = this.galaxyCenters[g.id];
        const gR = g._galaxyR || 200;
        // halo radius ~2.5x galaxy radius, very faint
        this.halos.push({
          x: gc.x, y: gc.y, z: gc.z,
          r: gR * 2.5,
          rgb: [200, 150, 100],
          alpha: (0.008 + Math.random() * 0.006) * ds
        });
      }
    } else if (!this.isMultiGalaxy) {
      const gR = this.galaxyR || 400;
      this.halos.push({
        x: 0, y: 0, z: 0,
        r: gR * 2.5,
        rgb: [200, 150, 100],
        alpha: 0.01 * ds
      });
    }

    // -- Interstellar dust lanes: skip for small datasets (ds < 0.15) --
    this.dustLanes = [];
    if (ds >= 0.15) {
      const dustCount = Math.round((this.isMultiGalaxy ? Math.min(60, 15 + (this.galaxies ? this.galaxies.length * 3 : 0)) : 15) * ds);
      const dustSpace = Math.max(spaceR * 1.2, 800);
      for (let i = 0; i < dustCount; i++) {
        let dx, dy, dz;
        if (this.isMultiGalaxy && this.galaxies && this.galaxies.length >= 2 && i < dustCount * 0.6) {
          const ga = this.galaxies[Math.floor(Math.random() * this.galaxies.length)];
          let gb = this.galaxies[Math.floor(Math.random() * this.galaxies.length)];
          while (gb === ga && this.galaxies.length > 1) gb = this.galaxies[Math.floor(Math.random() * this.galaxies.length)];
          const ca = this.galaxyCenters[ga.id], cb = this.galaxyCenters[gb.id];
          const t = 0.25 + Math.random() * 0.5;
          dx = ca.x + (cb.x - ca.x) * t + (Math.random() - 0.5) * 300;
          dy = ca.y + (cb.y - ca.y) * t + (Math.random() - 0.5) * 200;
          dz = ca.z + (cb.z - ca.z) * t + (Math.random() - 0.5) * 300;
        } else {
          const r = dustSpace * 0.3 + Math.random() * dustSpace * 0.8;
          const theta = Math.random() * 6.28;
          const phi = Math.acos(2 * Math.random() - 1);
          dx = r * Math.sin(phi) * Math.cos(theta);
          dy = r * Math.sin(phi) * Math.sin(theta) * 0.4;
          dz = r * Math.cos(phi);
        }
        const blobs = [];
        const blobCount = 2 + Math.floor(Math.random() * 3);
        for (let j = 0; j < blobCount; j++) {
          blobs.push({
            ox: (Math.random() - 0.5) * 180,
            oy: (Math.random() - 0.5) * 80,
            oz: (Math.random() - 0.5) * 180,
            r: 40 + Math.random() * 160,
            a: 0.005 + Math.random() * 0.02
          });
        }
        this.dustLanes.push({
          x: dx, y: dy, z: dz,
          blobs,
          rgb: [20, 10, 30],
          alpha: 0.008 + Math.random() * 0.015
        });
      }
    }

    // -- Deep star field: scaled by dataset size --
    this.deepStars = [];
    const deepStarCount = Math.round((this.isMultiGalaxy ? Math.min(1500, 400 + (this.galaxies ? this.galaxies.length * 60 : 0)) : 500) * ds);
    const deepShell = Math.max(spaceR * 1.5, 1000);
    for (let i = 0; i < deepStarCount; i++) {
      const r = deepShell * 0.6 + Math.random() * deepShell;
      const theta = Math.random() * 6.28;
      const phi = Math.acos(2 * Math.random() - 1);
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta) * 0.4;
      const z = r * Math.cos(phi);
      // brighter and larger than regular field stars
      const brightness = 0.3 + Math.random() * 0.7;
      const isBright = Math.random() < 0.12; // 12% are "bright stars" with cross diffraction
      this.deepStars.push({
        x, y, z,
        b: brightness,
        size: isBright ? 2.0 + Math.random() * 1.5 : 1.2 + Math.random() * 0.8,
        rgb: isBright ? [220, 210, 255] : [180, 195, 230],
        isBright,
        twinkle: Math.random() * 6.28
      });
    }
  }

  // ===== 投影(含屏幕空间缩放 + 平移,渲染和拾取统一使用) =====
  _project(x, y, z) {
    const x1 = x * Math.cos(this.rotY) - z * Math.sin(this.rotY);
    const z1 = x * Math.sin(this.rotY) + z * Math.cos(this.rotY);
    const y1 = y * Math.cos(this.rotX) - z1 * Math.sin(this.rotX);
    const z2 = y * Math.sin(this.rotX) + z1 * Math.cos(this.rotX);
    const depth = z2 + this.camZ + 300;
    const baseScale = this.focal / (this.focal + depth);
    // 屏幕空间均匀缩放(围绕屏幕中心)+ 平移
    const scale = baseScale * this.zoom;
    const sx = (x1 * baseScale) * this.zoom + this.cx + this.panX;
    const sy = (y1 * baseScale) * this.zoom + this.cy + this.panY;
    return { sx, sy, scale, depth };
  }

  // ===== 事件 =====
  _bindEvents() {
    this._onMouseDown = (e) => {
      // 右键(button=2)或 Shift+左键 = 平移;普通左键 = 旋转(始终可用)
      this.dragging = true;
      this.panning = (e.button === 2 || e.shiftKey);
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.mouseDown = { x: e.clientX, y: e.clientY, t: Date.now() };
      this.canvas.style.cursor = this.panning ? 'move' : 'grabbing';
    };
    this._onMouseMove = (e) => {
      if (this.dragging) {
        if (this.panning) {
          // 平移
          this.panX += (e.clientX - this.lastX);
          this.panY += (e.clientY - this.lastY);
        } else {
          // 旋转(始终可用,放大状态下也能上下翻转)
          this.rotY += (e.clientX - this.lastX) * 0.006;
          this.rotX += (e.clientY - this.lastY) * 0.006;
          this.rotX = Math.max(-1.4, Math.min(1.4, this.rotX));
        }
        this.lastX = e.clientX; this.lastY = e.clientY;
        this.lastAutoRotTime = Date.now();
        if (this.hoverNode && this.callbacks.nodeHover) {
          this.callbacks.nodeHover(null);
          this.hoverNode = null;
        }
      } else {
        // hover 拾取(限流)
        const now = Date.now();
        if (now - this._lastHoverPick > 50) {
          this._lastHoverPick = now;
          this._pickHover(e.clientX, e.clientY);
        }
      }
    };
    this._onMouseUp = (e) => {
      this.dragging = false;
      this.panning = false;
      this.canvas.style.cursor = 'grab';
      // 判定点击 vs 拖拽(仅左键且未平移时)
      if (this.mouseDown && Date.now() - this.mouseDown.t < 300 && e.button === 0) {
        const dx = e.clientX - this.mouseDown.x;
        const dy = e.clientY - this.mouseDown.y;
        if (Math.sqrt(dx * dx + dy * dy) < 4) {
          this._pickClick(e.clientX, e.clientY);
        }
      }
      this.mouseDown = null;
    };
    this._onWheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const oldZoom = this.zoom;
      // 向下滚缩小,向上滚放大
      const factor = e.deltaY > 0 ? 0.82 : 1.22;
      const newZoom = Math.max(0.3, Math.min(8, oldZoom * factor));
      if (newZoom === oldZoom) return;
      // 围绕鼠标点缩放:保持鼠标对应的 3D 点屏幕位置不变
      // mx = (sx0 - cx) * oldZoom + cx + panX  =>  sx0 = (mx - cx - panX)/oldZoom + cx
      const sx0 = (mx - this.cx - this.panX) / oldZoom + this.cx;
      const sy0 = (my - this.cy - this.panY) / oldZoom + this.cy;
      // 新的 panX: mx = (sx0 - cx) * newZoom + cx + newPanX
      this.panX = mx - (sx0 - this.cx) * newZoom - this.cx;
      this.panY = my - (sy0 - this.cy) * newZoom - this.cy;
      this.zoom = newZoom;
      this.targetZoom = newZoom;
    };
    this._onDblClick = (e) => {
      this._pickClick(e.clientX, e.clientY, true);
    };

    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this._onDblClick);
    // 阻止右键菜单(右键用于平移)
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ===== 拾取(优先选深度最靠前的节点,解决密集区误选) =====
  _pickHover(mx, my) {
    const rect = this.canvas.getBoundingClientRect();
    const px = mx - rect.left, py = my - rect.top;
    let best = null, bestScore = Infinity;
    for (const n of this.nodes) {
      const p = this._project(n.x, n.y, n.z);
      if (p.scale <= 0.2) continue;
      const r = n.size * p.scale * n.tw;
      const dx = p.sx - px, dy = p.sy - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.max(r + 4, 8);
      if (d < threshold) {
        // 综合评分:距离 + 深度(深度越小越靠前,优先选)
        // depth 越小越好,用 depth 作为主排序键,距离作为次序
        const score = p.depth + d * 0.5;
        if (score < bestScore) { best = n; bestScore = score; }
      }
    }
    if (best !== this.hoverNode) {
      this.hoverNode = best;
      if (this.callbacks.nodeHover) {
        this.callbacks.nodeHover(best ? { id: best.id, data: { fullTitle: best.fullTitle, domain: best.domain, tags: best.tags, url: best.url } } : null, mx, my);
      }
    }
  }

  _pickClick(mx, my, isDouble = false) {
    const rect = this.canvas.getBoundingClientRect();
    const px = mx - rect.left, py = my - rect.top;
    let best = null, bestScore = Infinity;
    for (const n of this.nodes) {
      const p = this._project(n.x, n.y, n.z);
      if (p.scale <= 0.2) continue;
      const r = n.size * p.scale * n.tw;
      const dx = p.sx - px, dy = p.sy - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.max(r + 4, 8);
      if (d < threshold) {
        const score = p.depth + d * 0.5;
        if (score < bestScore) { best = n; bestScore = score; }
      }
    }
    if (best && this.callbacks.nodeClick) {
      this.callbacks.nodeClick({ url: best.url, id: best.id, isDouble });
    }
  }

  // ===== 渲染循环 =====
  _loop() {
    this.time += 0.016;

    // 飞行动画
    if (this.flyProgress < 1) {
      this.flyProgress = Math.min(1, this.flyProgress + 0.02);
      const t = this._easeInOut(this.flyProgress);
      if (this.flyTarget) {
        this.rotX += (this.flyTarget.rotX - this.rotX) * t * 0.1;
        this.rotY += (this.flyTarget.rotY - this.rotY) * t * 0.1;
        this.camZ += (this.flyTarget.camZ - this.camZ) * t * 0.1;
      }
    }

    // 自动旋转(松手 2s 后;放大时减速但不停止,保持生命感)
    if (!this.dragging && Date.now() - this.lastAutoRotTime > 2000) {
      // zoom 越大旋转越慢,但不停(zoom=1 全速,zoom=8 时降到 1/8)
      const rotSpeed = this.autoRot / Math.max(1, this.zoom);
      this.rotY += rotSpeed;
    }
    this.camZ += (this.targetCamZ - this.camZ) * 0.08;
    this.zoom += (this.targetZoom - this.zoom) * 0.2;

    // 帧率节流:大图降到 30fps,减少渲染开销
    const now = performance.now();
    const minFrameTime = this.nodes.length > 10000 ? 33 : 0;  // 30fps
    if (minFrameTime > 0 && this._lastFrameTime && (now - this._lastFrameTime) < minFrameTime) {
      this.rafId = requestAnimationFrame(() => this._loop());
      return;
    }
    this._lastFrameTime = now;

    this._draw();
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

  _draw() {
    const dark = GraphCore.isDarkTheme();
    const ctx = this.ctx;

    // 重置合成模式(上一帧可能用了 lighter)
    ctx.globalCompositeOperation = 'source-over';

    // 背景
    const bg = dark ? '#02030a' : '#0a1628';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.W, this.H);
    const bgGrad = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, Math.max(this.W, this.H) * 0.6);
    bgGrad.addColorStop(0, dark ? 'rgba(30,20,60,0.15)' : 'rgba(40,30,80,0.2)');
    bgGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, this.W, this.H);

    // -- Interstellar dust lanes: large faint irregular patches --
    if (this.dustLanes && this.dustLanes.length > 0) {
      ctx.globalCompositeOperation = 'source-over';
      for (const d of this.dustLanes) {
        const p = this._project(d.x, d.y, d.z);
        if (p.scale <= 0.02) continue;
        for (const blob of d.blobs) {
          const bx = p.sx + blob.ox * p.scale;
          const by = p.sy + blob.oy * p.scale;
          const br = blob.r * p.scale;
          if (br < 2) continue;
          const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
          grad.addColorStop(0, `rgba(${d.rgb[0]},${d.rgb[1]},${d.rgb[2]},${blob.a * p.scale * 1.5})`);
          grad.addColorStop(1, `rgba(${d.rgb[0]},${d.rgb[1]},${d.rgb[2]},0)`);
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.28); ctx.fill();
        }
      }
    }

    // -- Deep star field: bright distant stars beyond main space --
    if (this.deepStars && this.deepStars.length > 0) {
      for (const s of this.deepStars) {
        const p = this._project(s.x, s.y, s.z);
        if (p.scale <= 0) continue;
        const a = s.b * Math.min(1, p.scale * 1.5);
        const sz = s.size * p.scale;
        if (sz < 0.4) continue;
        ctx.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${a})`;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, sz, 0, 6.28); ctx.fill();
        // bright stars get subtle cross diffraction
        if (s.isBright && sz > 1.2) {
          const twinkleA = 0.5 + 0.5 * Math.sin(this.time * 1.3 + s.twinkle);
          ctx.strokeStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${a * 0.4 * twinkleA})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(p.sx - sz * 3, p.sy); ctx.lineTo(p.sx + sz * 3, p.sy);
          ctx.moveTo(p.sx, p.sy - sz * 3); ctx.lineTo(p.sx, p.sy + sz * 3);
          ctx.stroke();
        }
      }
    }

    // regular field stars
    for (const s of this.stars) {
      const p = this._project(s.x, s.y, s.z);
      if (p.scale <= 0) continue;
      const a = s.b * Math.min(1, p.scale * 2);
      ctx.fillStyle = `rgba(200,210,240,${a})`;
      ctx.fillRect(p.sx, p.sy, 1.2, 1.2);
    }

    // ===== 星系核心辉光 =====
    // LOD pre-compute: per-galaxy projected scale -> tier
    const galaxyLOD = new Map();
    if (this.isMultiGalaxy && this.galaxies && this.galaxyCenters) {
      for (const g of this.galaxies) {
        const gc = this.galaxyCenters[g.id];
        if (!gc) continue;
        const gp = this._project(gc.x, gc.y, gc.z);
        const s = gp.scale;
        const tier = s > 0.35 ? 0 : (s > 0.12 ? 1 : 2);
        galaxyLOD.set(g.id, { tier, scale: s });
      }
    }

    // L1-L5: per-galaxy core glow (multi) or single core (single)
    if (this.isMultiGalaxy && this.galaxies && this.galaxyCenters) {
      this._drawMultiCoreGlow(ctx, galaxyLOD);
    } else {
      this._drawSingleCoreGlow(ctx);
    }

    // -- Galactic halos: large faint spherical glows around each galaxy --
    if (this.halos && this.halos.length > 0) {
      ctx.globalCompositeOperation = 'lighter';
      for (const h of this.halos) {
        const p = this._project(h.x, h.y, h.z);
        if (p.scale <= 0.01) continue;
        const hr = h.r * p.scale;
        if (hr < 5) continue;
        const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, hr);
        grad.addColorStop(0, `rgba(${h.rgb[0]},${h.rgb[1]},${h.rgb[2]},${h.alpha * p.scale * 2})`);
        grad.addColorStop(1, `rgba(${h.rgb[0]},${h.rgb[1]},${h.rgb[2]},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, hr, 0, 6.28); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // L4: core cloud rendering + turbulence (LOD: skip tier>0)
    if (this.coreClouds.length > 0) {
      ctx.globalCompositeOperation = 'lighter';
      for (const c of this.coreClouds) {
        // LOD skip: distant galaxy clouds not visible anyway
        if (c.galaxyId !== undefined) {
          const lod = galaxyLOD.get(c.galaxyId);
          if (lod && lod.tier > 0) continue;
        }
        // orbit drift (L4 turbulence)
        const orbitAngle = c.orbitT + this.time * c.orbitSpeed;
        const wobble = Math.sin(this.time * 0.8 + c.phase) * c.wobbleR;
        // 多星系模式:ox/oy/oz 已是世界坐标,偏移量需累加上去
        c.x = c.ox + Math.cos(orbitAngle) * (c.orbitR + wobble * 0.3) - Math.cos(c.orbitT) * c.orbitR;
        c.z = c.oz + Math.sin(orbitAngle) * (c.orbitR + wobble * 0.3) - Math.sin(c.orbitT) * c.orbitR;
        c.y = c.oy + Math.cos(this.time * 0.6 + c.phase) * 3;

        const p = this._project(c.x, c.y, c.z);
        if (p.scale <= 0) continue;
        const r = c.size * p.scale;
        if (r < 0.5) continue;
        const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r);
        grad.addColorStop(0, `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${c.a * p.scale * 3})`);
        grad.addColorStop(1, `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, 6.28); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // nebula spiral cloud rendering (LOD: tier2 skip all, tier1 every-other, tier0 full)
    ctx.globalCompositeOperation = 'lighter';
    let nebSkipCounter = 0;
    for (const n of this.nebula) {
      // LOD culling
      if (n.galaxyId !== undefined) {
        const lod = galaxyLOD.get(n.galaxyId);
        if (lod && lod.tier >= 2) continue;
        if (lod && lod.tier >= 1 && (nebSkipCounter++ % 2 === 0)) continue;
      }
      // tangential drift (L7)
      if (n.drift) {
        const driftT = this.time * n.driftSpeed + n.phase;
        const dx = Math.cos(driftT) * n.driftR;
        const dz = Math.sin(driftT) * n.driftR;
        n.x = n.ox + dx;
        n.z = n.oz + dz;
        n.y = n.oy + Math.sin(driftT * 0.7) * 2;
      }
      const p = this._project(n.x, n.y, n.z);
      if (p.scale <= 0) continue;
      const r = n.size * p.scale;
      if (r < 0.5) continue;
      const grad = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r);
      grad.addColorStop(0, `rgba(${n.rgb[0]},${n.rgb[1]},${n.rgb[2]},${n.a * p.scale * 3})`);
      grad.addColorStop(1, `rgba(${n.rgb[0]},${n.rgb[1]},${n.rgb[2]},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, 6.28);
      ctx.fill();
    }

    // reset composite after nebula to avoid edge over-bright
    ctx.globalCompositeOperation = 'source-over';

    // check search/highlight state
    const hasFocus = (this.matchedIds && this.matchedIds.size > 0) || this.highlightClusterKey;

    // ===== 投影缓存:每帧只投影一次,节点和边共用 =====
    // 视锥剔除:屏幕外 ±200px 或 scale<=0.05 的节点跳过
    const nodeProjCache = new Array(this.nodes.length);
    const visMargin = 200;
    const wMin = -visMargin, wMax = this.W + visMargin;
    const hMin = -visMargin, hMax = this.H + visMargin;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const p = this._project(n.x, n.y, n.z);
      nodeProjCache[i] = p;
    }

    // 边(按深度排序,远的先画)— 用缓存投影
    const edgeProj = [];
    const interGalaxyEdges = [];
    for (const e of this.edges) {
      const pa = nodeProjCache[e.a];
      const pb = nodeProjCache[e.b];
      if (pa.scale <= 0.05 || pb.scale <= 0.05) continue;
      if ((pa.sx < wMin && pb.sx < wMin) || (pa.sx > wMax && pb.sx > wMax) ||
          (pa.sy < hMin && pb.sy < hMin) || (pa.sy > hMax && pb.sy > hMax)) continue;
      const item = { pa, pb, depth: (pa.depth + pb.depth) / 2, rgb: e.rgb, weight: e.weight, isInterGalaxy: e.isInterGalaxy,
        aIdx: e.a, bIdx: e.b,  // keep node indices for hover-connected edge boost
        // view-angle attenuation: edges parallel to screen (face-on) → thinner, pointing at camera → normal
        viewFactor: Math.max(0.04, Math.min(1, ((pa.scale + pb.scale) / 2 * 10) / Math.max(0.5, Math.sqrt((pb.sx - pa.sx) ** 2 + (pb.sy - pa.sy) ** 2)))) };
      if (e.isInterGalaxy) {
        interGalaxyEdges.push(item);
      } else {
        edgeProj.push(item);
      }
    }
    edgeProj.sort((a, b) => b.depth - a.depth);
    interGalaxyEdges.sort((a, b) => b.depth - a.depth);

    // inter-galaxy edges: subtle curved bridges, boosted when hover-connected
    const maxInterEdges = this.nodes.length > 10000 ? 400 : 1200;
    const interLimit = Math.min(interGalaxyEdges.length, maxInterEdges);
    const hvNode = this.hoverNode;
    for (let i = 0; i < interLimit; i++) {
      const e = interGalaxyEdges[i];
      const isHoverEdge = hvNode && (this.nodes[e.aIdx].id === hvNode.id || this.nodes[e.bIdx].id === hvNode.id);
      const hasAnyHover = !!hvNode;
      // hover-connected: boosted; others dimmed; no hover: normal
      let a = Math.min(0.04, 0.04 * e.pa.scale * e.pb.scale) * e.viewFactor;
      if (isHoverEdge) { a = Math.min(0.2, 0.2 * e.pa.scale * e.pb.scale) * e.viewFactor; }
      else if (hasAnyHover) { a *= 0.15; }
      if (hasFocus) a *= 0.2;
      ctx.strokeStyle = `rgba(100,95,160,${a})`;
      let lw = 0.08 * Math.min(e.pa.scale, e.pb.scale) * e.viewFactor;
      if (isHoverEdge) { lw = 0.28 * Math.min(e.pa.scale, e.pb.scale) * e.viewFactor; }
      else if (hasAnyHover) { lw *= 0.3; }
      ctx.lineWidth = Math.min(lw, isHoverEdge ? 1.5 : 0.8);
      ctx.beginPath();
      const mx = (e.pa.sx + e.pb.sx) / 2;
      const my = (e.pa.sy + e.pb.sy) / 2 - 15 * Math.min(e.pa.scale, e.pb.scale);
      ctx.moveTo(e.pa.sx, e.pa.sy);
      ctx.quadraticCurveTo(mx, my, e.pb.sx, e.pb.sy);
      ctx.stroke();
    }

    // intra-galaxy edges: view-angle attenuated, hover-connected boost
    const maxEdges = this.nodes.length > 30000 ? 1500 : (this.nodes.length > 10000 ? 3000 : 99999);
    const edgeLimit = Math.min(edgeProj.length, maxEdges);
    for (let i = 0; i < edgeLimit; i++) {
      const e = edgeProj[i];
      const isHoverEdge = hvNode && (this.nodes[e.aIdx].id === hvNode.id || this.nodes[e.bIdx].id === hvNode.id);
      const hasAnyHover = !!hvNode;
      let a = Math.min(0.25, 0.25 * e.pa.scale * e.pb.scale);
      if (isHoverEdge) { a = Math.min(0.7, 0.7 * e.pa.scale * e.pb.scale); }
      else if (hasAnyHover) { a *= 0.15; }
      if (hasFocus) a *= 0.3;
      ctx.strokeStyle = `rgba(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]},${a})`;
      let lw = 0.6 * e.pa.scale * e.viewFactor;
      if (isHoverEdge) { lw *= 2.0; }
      else if (hasAnyHover) { lw *= 0.3; }
      ctx.lineWidth = Math.min(lw, isHoverEdge ? 3.5 : 2.5);
      ctx.beginPath();
      ctx.moveTo(e.pa.sx, e.pa.sy);
      ctx.lineTo(e.pb.sx, e.pb.sy);
      ctx.stroke();
    }

    // nodes (depth-sorted, far first) — with projection cache
    const nodeProj = [];
    const updateTwinkle = (this._frameCount % 3) === 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const p = nodeProjCache[i];
      if (p.scale <= 0.05) continue;
      if (p.sx < wMin || p.sx > wMax || p.sy < hMin || p.sy > hMax) continue;
      // LOD: skip low-weight nodes in distant galaxies
      if (n.galaxyId !== undefined) {
        const lod = galaxyLOD.get(n.galaxyId);
        if (lod && lod.tier >= 2 && n.weight < 4) continue;
        if (lod && lod.tier >= 1 && n.weight < 2) continue;
      }
      if (updateTwinkle || !n._cachedTw) {
        n._cachedTw = n.tw * (0.7 + 0.3 * Math.sin(this.time * 2 + n.phase));
      }
      nodeProj.push({ n, p, tw: n._cachedTw, depth: p.depth });
    }
    nodeProj.sort((a, b) => b.depth - a.depth);
    this._frameCount = (this._frameCount || 0) + 1;

    const zoomPercent = Math.round(this.zoom * 100);
    const zoomEl = document.getElementById('zoomLevel');
    if (zoomEl) zoomEl.textContent = Math.max(10, Math.min(800, zoomPercent)) + '%';

    // 渐变缓存:相同颜色 + 相近半径的发光用缓存,避免每节点 createRadialGradient
    const glowCache = new Map();
    const getGlow = (rgb, r) => {
      // 半径量化到 4px 步长,颜色用 rgb 拼接
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}|${Math.round(r / 4)}`;
      let g = glowCache.get(key);
      if (!g) {
        const gr = Math.round(r / 4) * 4;
        g = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
        g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.7)`);
        g.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.22)`);
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        glowCache.set(key, g);
      }
      return g;
    };

    for (const item of nodeProj) {
      const { n, p, tw } = item;
      const r = n.size * p.scale * tw;
      if (r < 0.3) continue;

      const [r0, g0, b0] = n.rgb;

      // 焦点状态判断
      let focusBoost = 1;
      let dim = 1;
      if (this.matchedIds && this.matchedIds.size > 0) {
        if (this.matchedIds.has(n.id)) { focusBoost = 1.5; dim = 1; }
        else dim = 0.25;
      } else if (this.highlightClusterKey) {
        if (n.cluster === this.highlightClusterKey) { focusBoost = 1.3; dim = 1; }
        else dim = 0.25;
      }

      // node outer glow (cached gradient); damped near core in single-galaxy mode
      let glowR = r * (n.isHub ? 5 : 3.5) * focusBoost;
      let glowAlpha = dim;
      if (!this.isMultiGalaxy && this.galaxyR) {
        const coreDist = Math.sqrt(n.x * n.x + n.z * n.z);
        const coreFade = Math.max(0, Math.min(1, coreDist / (this.galaxyR * 0.35)));
        glowR *= coreFade;
        glowAlpha *= coreFade;
      }
      if (glowR > 1) {
        ctx.save();
        ctx.translate(p.sx, p.sy);
        ctx.fillStyle = getGlow(n.rgb, glowR);
        ctx.globalAlpha = glowAlpha;
        ctx.beginPath();
        ctx.arc(0, 0, glowR, 0, 6.28);
        ctx.fill();
        ctx.restore();
      }

      // 核心(适度亮度,避免叠加糊成一片)
      const coreR = Math.min(255, r0 + 70), coreG = Math.min(255, g0 + 70), coreB = Math.min(255, b0 + 70);
      ctx.fillStyle = `rgba(${coreR},${coreG},${coreB},${Math.min(1, tw * dim * 0.85)})`;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r * focusBoost, 0, 6.28);
      ctx.fill();

      // hub cross rays (LOD: skip for distant galaxies)
      if (n.isHub && r > 2) {
        let skipHub = false;
        if (n.galaxyId !== undefined) {
          const lod = galaxyLOD.get(n.galaxyId);
          if (lod && lod.tier > 0) skipHub = true;
        }
        if (!skipHub) {
          ctx.strokeStyle = `rgba(${r0},${g0},${b0},${0.4 * tw * dim})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(p.sx - r * 3, p.sy); ctx.lineTo(p.sx + r * 3, p.sy);
          ctx.moveTo(p.sx, p.sy - r * 3); ctx.lineTo(p.sx, p.sy + r * 3);
          ctx.stroke();
        }
      }

      // 搜索匹配脉冲环(用 source-over 保证可见)
      if (this.matchedIds && this.matchedIds.has(n.id) && r > 1) {
        ctx.globalCompositeOperation = 'source-over';
        const pulseR = r * (2.5 + Math.sin(this.time * 4) * 0.5);
        ctx.strokeStyle = `rgba(245,158,11,${0.6 + Math.sin(this.time * 4) * 0.2})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, pulseR, 0, 6.28);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
      }

      // hover 高亮(用 source-over 保证白环可见)
      if (this.hoverNode === n && r > 1) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 4, 0, 6.28);
        ctx.stroke();
      }
    }
  }

  // ===== 单星系核心辉光(原逻辑) =====
  _drawSingleCoreGlow(ctx) {
    let coreSumX = 0, coreSumY = 0, coreSumZ = 0, coreCnt = 0;
    const gR = this.galaxyR || 400;
    for (const n of this.nodes) {
      const d = Math.sqrt(n.x * n.x + n.z * n.z);
      if (d < gR * 0.55) { coreSumX += n.x; coreSumY += n.y; coreSumZ += n.z; coreCnt++; }
    }
    if (coreCnt > 0) {
      this._drawCoreGlowAt(ctx, coreSumX / coreCnt, coreSumY / coreCnt, coreSumZ / coreCnt);
    }
  }

  // ===== 多星系核心辉光:每个星系独立绘制 =====
  _drawMultiCoreGlow(ctx, galaxyLOD) {
    const galaxyNodes = new Map();
    for (const g of this.galaxies) {
      galaxyNodes.set(g.id, { sumX: 0, sumY: 0, sumZ: 0, cnt: 0 });
    }
    for (const n of this.nodes) {
      const gid = n.galaxyId;
      if (gid === undefined) continue;
      const acc = galaxyNodes.get(gid);
      if (!acc) continue;
      const g = this.galaxies.find(gg => gg.id === gid);
      const gR = g ? (g._galaxyR || 200) : 200;
      const gCenter = this.galaxyCenters ? this.galaxyCenters[gid] : { x: 0, y: 0, z: 0 };
      const dx = n.x - gCenter.x, dz = n.z - gCenter.z;
      if (Math.sqrt(dx * dx + dz * dz) < gR * 0.4) {
        acc.sumX += n.x; acc.sumY += n.y; acc.sumZ += n.z; acc.cnt++;
      }
    }
    for (const [gid, acc] of galaxyNodes) {
      if (acc.cnt > 0) {
        const lod = galaxyLOD.get(gid);
        this._drawCoreGlowAt(ctx, acc.sumX / acc.cnt, acc.sumY / acc.cnt, acc.sumZ / acc.cnt, lod ? lod.tier : 0);
      }
    }
  }

  // draw single core glow (shared, LOD-aware)
  // tier 0: full 4-layer glow + diffraction + dust band
  // tier 1: 2-layer simplified glow, no diffraction, no dust
  // tier 2: 1-layer minimal glow point
  _drawCoreGlowAt(ctx, wx, wy, wz, tier = 0) {
    const coreProj = this._project(wx, wy, wz);
    if (coreProj.scale <= 0) return;

    ctx.globalCompositeOperation = 'lighter';
    const pulse = (0.85 + 0.15 * Math.sin(this.time * 0.5))
                * (0.97 + 0.03 * Math.sin(this.time * 1.7));
    const cx = coreProj.sx, cy = coreProj.sy, sc = coreProj.scale;
    // damp core glow for small datasets so nodes aren't drowned
    const d = this._coreGlowDamp != null ? this._coreGlowDamp : 1.0;

    if (tier <= 1) {
      const r4 = 230 * sc * pulse;
      const g4 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r4);
      g4.addColorStop(0, `rgba(180,110,80,${(tier === 0 ? 0.015 : 0.008) * d})`);
      g4.addColorStop(1, 'rgba(180,110,80,0)');
      ctx.fillStyle = g4;
      ctx.beginPath(); ctx.arc(cx, cy, r4, 0, 6.28); ctx.fill();

      const r2 = 60 * sc * pulse;
      const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
      g2.addColorStop(0, `rgba(255,215,160,${(tier === 0 ? 0.05 : 0.025) * d})`);
      g2.addColorStop(1, 'rgba(250,200,150,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(cx, cy, r2, 0, 6.28); ctx.fill();
    }

    if (tier === 0) {
      const r3 = 130 * sc * pulse;
      const g3 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r3);
      g3.addColorStop(0, `rgba(240,170,110,${0.035 * d})`);
      g3.addColorStop(0.6, `rgba(220,150,95,${0.015 * d})`);
      g3.addColorStop(1, 'rgba(200,130,85,0)');
      ctx.fillStyle = g3;
      ctx.beginPath(); ctx.arc(cx, cy, r3, 0, 6.28); ctx.fill();

      const r1 = 25 * sc * pulse;
      const g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1);
      g1.addColorStop(0, `rgba(255,245,220,${0.04 * d})`);
      g1.addColorStop(1, 'rgba(255,235,200,0)');
      ctx.fillStyle = g1;
      ctx.beginPath(); ctx.arc(cx, cy, r1, 0, 6.28); ctx.fill();

      // L2: cross diffraction rays
      const rayLen = 200 * sc * pulse;
      const drawRay = (x1, y1, x2, y2) => {
        const rg = ctx.createLinearGradient(x1, y1, x2, y2);
        rg.addColorStop(0, `rgba(255,235,200,${0.06 * d})`);
        rg.addColorStop(1, 'rgba(255,235,200,0)');
        ctx.strokeStyle = rg;
        ctx.lineWidth = 1.5 * sc;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      };
      drawRay(cx - rayLen, cy, cx + rayLen, cy);
      drawRay(cx, cy - rayLen, cx, cy + rayLen);

      // L5: dark dust band
      const bandW = 140 * sc;
      const bandH = 10 * sc;
      const bandGrad = ctx.createLinearGradient(cx, cy - bandH, cx, cy + bandH);
      bandGrad.addColorStop(0, 'rgba(10,5,15,0)');
      bandGrad.addColorStop(0.5, 'rgba(10,5,15,0.15)');
      bandGrad.addColorStop(1, 'rgba(10,5,15,0)');
      ctx.fillStyle = bandGrad;
      ctx.fillRect(cx - bandW / 2, cy - bandH, bandW, bandH * 2);
    }

    ctx.globalCompositeOperation = 'source-over';
  }
  search(matchedIds, total) {
    this.matchedIds = matchedIds && matchedIds.size > 0 ? matchedIds : null;
    if (!this.matchedIds || this.matchedIds.size === 0 || this.matchedIds.size > 50) return;

    let sx = 0, sy = 0, sz = 0, count = 0;
    for (const n of this.nodes) {
      if (this.matchedIds.has(n.id)) { sx += n.x; sy += n.y; sz += n.z; count++; }
    }
    if (count === 0) return;
    const tx = sx / count, ty = sy / count, tz = sz / count;
    const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);

    const targetRotY = -Math.atan2(tx, tz);
    const horizDist = Math.sqrt(tx * tx + tz * tz);
    const targetRotX = Math.atan2(ty, horizDist);
    // camZ = dist - 240 so target stays at comfortable depth ~60 after rotation
    const camDist = Math.max(this.isMultiGalaxy ? 60 : 30, Math.min(this.isMultiGalaxy ? 800 : 400, dist - 240));
    this._flyTo(targetRotY, targetRotX, camDist);
  }

  // ===== 高亮聚类(相机飞向星团所在星系) =====
  highlightCluster(key) {
    this.highlightClusterKey = key;
    let sx = 0, sy = 0, sz = 0, count = 0;
    for (const n of this.nodes) {
      if (n.cluster === key) { sx += n.x; sy += n.y; sz += n.z; count++; }
    }
    if (count === 0) return;
    const tx = sx / count, ty = sy / count, tz = sz / count;
    const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const targetRotY = -Math.atan2(tx, tz);
    const horizDist = Math.sqrt(tx * tx + tz * tz);
    const targetRotX = Math.atan2(ty, horizDist);
    // camZ computed from actual distance so target lands at comfortable depth
    const camDist = Math.max(this.isMultiGalaxy ? 50 : 20, Math.min(this.isMultiGalaxy ? 800 : 400, dist - 240));
    this._flyTo(targetRotY, targetRotX, camDist);
  }

  _flyTo(rotY, rotX, camZ) {
    this.flyTarget = { rotX, rotY, camZ };
    this.flyProgress = 0;
    this.lastAutoRotTime = Date.now() + 3000; // 飞行期间暂停自动旋转
  }

  // ===== 重置视图 =====
  resetView() {
    this.matchedIds = null;
    this.highlightClusterKey = null;
    this.zoom = 1; this.targetZoom = 1;
    this.panX = 0; this.panY = 0;
    // 多星系:拉远视角展示全星系团全景
    if (this.isMultiGalaxy && this.spaceR > 0) {
      const overviewDist = Math.round(this.spaceR * 0.6);
      this.targetCamZ = overviewDist - 300;
      this._flyTo(0, 0.55, Math.max(0, overviewDist - 300));
    } else {
      this.targetCamZ = 0;
      this._flyTo(0, 0.5, 0);
    }
  }

  // ===== 重布局(重排星系位置 + 内部节点) =====
  relayout() {
    if (!this.currentData) return;
    // 换随机 seed → 星系 3D 位置和内部螺旋排布均变化
    if (this._relayoutSeed === undefined) this._relayoutSeed = 1;
    else this._relayoutSeed++;
    this._buildScene(this.currentData);
    this.zoom = 1; this.targetZoom = 1;
    this.panX = 0; this.panY = 0;
    if (this.isMultiGalaxy && this.spaceR > 0) {
      const overviewDist = Math.round(this.spaceR * 0.6);
      this.targetCamZ = overviewDist - 300;
      this._flyTo(0, 0.55, Math.max(0, overviewDist - 300));
    } else {
      this.targetCamZ = 0;
      this._flyTo(0, 0.5, 0);
    }
  }

  // ===== 缩放(屏幕空间,围绕屏幕中心) =====
  zoomIn() {
    const newZoom = Math.min(8, this.zoom * 1.3);
    this.panX *= (newZoom / this.zoom);
    this.panY *= (newZoom / this.zoom);
    this.zoom = newZoom; this.targetZoom = newZoom;
  }
  zoomOut() {
    const newZoom = Math.max(0.3, this.zoom / 1.3);
    this.panX *= (newZoom / this.zoom);
    this.panY *= (newZoom / this.zoom);
    this.zoom = newZoom; this.targetZoom = newZoom;
  }

  // ===== 销毁 =====
  destroy() {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.canvas) {
      this.canvas.removeEventListener('mousedown', this._onMouseDown);
      this.canvas.removeEventListener('wheel', this._onWheel);
      this.canvas.removeEventListener('dblclick', this._onDblClick);
      window.removeEventListener('mousemove', this._onMouseMove);
      window.removeEventListener('mouseup', this._onMouseUp);
      this.canvas.style.display = 'none';
    }
    if (this.hoverCard) this.hoverCard.style.display = 'none';
  }

  // ===== 事件订阅 =====
  on(event, callback) {
    if (event === 'nodeClick') this.callbacks.nodeClick = callback;
    else if (event === 'nodeHover') this.callbacks.nodeHover = callback;
    else if (event === 'stats') this.callbacks.stats = callback;
  }

  // ===== 主题更新 =====
  updateTheme() {
    // Canvas 每帧重绘,主题自动生效
  }

  _emitStats() {
    if (this.callbacks.stats && this.currentData) {
      this.callbacks.stats({
        nodes: this.currentData.totalNodes,
        edges: this.currentData.totalEdges,
        clusters: this.currentData.clusters.size,
        // 多星系模式附加信息
        galaxyMode: !!this.isMultiGalaxy,
        galaxyCount: this.galaxies ? this.galaxies.length : 1
      });
    }
  }

  // ===== 窗口大小变化 =====
  resize() {
    if (this.canvas) this._resize();
  }

  // ===== 导出静态 HTML =====
  exportStaticHTML() {
    if (!this.currentData) return null;
    const dark = GraphCore.isDarkTheme();

    // 收集当前可见节点和边的快照
    const nodesData = this.nodes.map(n => ({
      id: n.id, x: n.x, y: n.y, z: n.z,
      rgb: n.rgb, size: n.size, isHub: n.isHub,
      fullTitle: n.fullTitle, domain: n.domain, url: n.url,
      phase: n.phase
    }));
    const edgesData = this.edges.map(e => ({
      source: this.nodes[e.a].id, target: this.nodes[e.b].id, weight: e.weight
    }));
    const legendData = [];
    const sorted = Array.from(this.currentData.clusters.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [key, info] of sorted) legendData.push({ color: info.color, label: info.label, count: info.count });

    return { nodesData, edgesData, legendData, dark, clusterBy: this.currentData.clusterBy, is3D: true };
  }
}

window.Graph3D = Graph3D;
