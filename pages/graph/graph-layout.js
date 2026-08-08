// ===== 大图力导向布局(带簇质心力的 FR 变体,主线程 rAF 时间切片) =====
// 2000+ 节点不再用 cytoscape cose(实测 O(n²) 在 3500 节点阻塞 ~8s)。
// 力模型(Fruchterman-Reingold 变体 + 社区分组力):
//   1. 节点间斥力(随机对抽样 O(n·samples))
//   2. 沿边引力 O(E)
//   3. 簇质心吸引:每个节点被拉向所属簇(按域名分组)的质心 → 同域节点聚成团(盘丝错节的基础)
//   4. 簇质心互斥:各簇质心互相排斥 → 打散 concentric 初始的环形宏观结构
//   5. 弱重力:防整体漂移
// 配合 requestAnimationFrame 时间切片:每帧只算少量迭代并应用位置,页面始终可交互。
// 关键教训:
//   - 必须随机起点 + 簇质心互斥,否则簇团会保持在 concentric 的环形排布上(用户反复反馈"大圆圈带内环")
//   - 零距离兜底必须保证位移非零,否则 d=0 → 力=Infinity → NaN 污染整个布局
(function (root) {
  'use strict';

  function hash32(x) {
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  }

  // 创建布局状态机;每次调用 step(maxMs) 推进一批迭代(限时),返回是否全部完成
  // nodes: [{id}], edges: [{s,t} 索引对], clusterOf: Int32Array 每节点所属簇索引(0..K-1)
  function createFRLayout(nodes, edges, clusterOf, options) {
    const N = nodes.length;
    const K = clusterOf ? Math.max(0, ...clusterOf) + 1 : 0;
    const k = options.idealLength || 26;                       // 节点间理想距离(px)
    const area = N * k * k * 2.0;                              // 布局盒面积(留余量,防边界夹紧)
    const W = options.width || Math.round(Math.sqrt(area * 4 / 3));
    const H = options.height || Math.round(Math.sqrt(area * 3 / 4));
    const samples = options.samples || 32;                     // 每节点斥力抽样数
    const iterations = options.iterations || 200;
    const gravity = options.gravity !== undefined ? options.gravity : 0.02;
    const centAttract = options.centAttract || 0.08;           // 簇质心吸引力
    const centRepelScale = options.centRepelScale || 0.05;     // 簇质心互斥力传递到成员的比例
    const massAvg = options.massAvg || 1;                      // 质量加权斥力(大团排斥更强,防巨型圆盘重叠)
    const temp0 = options.initialTemp || 60;
    const cooling = options.cooling !== undefined ? options.cooling : 0.97;   // 冷却率(小=停得早)

    // 确定性伪随机起点(seed 可换 → 重布局得到新排布;同 seed 结果稳定)
    const seed = options.seed || 0;
    const pos = new Float64Array(N * 2);
    for (let i = 0; i < N; i++) {
      pos[i * 2] = (hash32(i + 1 + seed * 7919) % 10000) / 10000 * W;
      pos[i * 2 + 1] = (hash32(i + 7919 + seed * 104729) % 10000) / 10000 * H;
    }
    const disp = new Float64Array(N * 2);
    const cent = new Float64Array(K * 2);
    const centCount = new Int32Array(K);
    const centRep = new Float64Array(K * 2);
    const cx = W / 2, cy = H / 2;

    let it = 0;

    // 大团互斥名单:质量≥HEAVY_MIN 的伪节点(大域碎片)。随机斥力抽样几乎抽不到其他大团,
    // 若无此力,星座碎片会被簇内边拉成圆球("大圆圈")。大团数量少,完整两两斥力开销可忽略。
    // HEAVY_REPEL:互斥增强倍数 → 大域星座由紧凑球铺开成松散有机网络(盘丝错节)。
    const HEAVY_MIN = 10;
    const HEAVY_REPEL = options.heavyRepel || 2.5;
    const heavyIdx = [];
    for (let i = 0; i < N; i++) if ((nodes[i].mass || 1) >= HEAVY_MIN) heavyIdx.push(i);

    function step(maxMs) {
      const start = performance.now();
      while (it < iterations && performance.now() - start < maxMs) {
        const temp = temp0 * Math.pow(cooling, it);
        disp.fill(0);

        // 节点间斥力(随机对抽样,确定性序列)
        for (let i = 0; i < N; i++) {
          const xi = pos[i * 2], yi = pos[i * 2 + 1];
          for (let s = 0; s < samples; s++) {
            const j = hash32(i * samples + s + it * 31) % N;
            if (j === i) continue;
            let dx = xi - pos[j * 2];
            let dy = yi - pos[j * 2 + 1];
            let d2 = dx * dx + dy * dy;
            if (d2 < 1e-6) {
              // 零距离兜底:确保位移非零(否则 d=0 → 力=Infinity → NaN)
              dx = (((hash32(i) % 7) - 3) * 0.1) || 0.1;
              dy = (((hash32(j) % 7) - 3) * 0.1) || 0.1;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            let f = (k * k) / d;                               // FR 斥力:k²/d
            if (massAvg > 1) {                                 // 质量加权:大团排斥更强(防重叠)
              const mi = nodes[i].mass || 1, mj = nodes[j].mass || 1;
              f *= Math.sqrt(mi * mj) / massAvg;
            }
            const fx = (dx / d) * f, fy = (dy / d) * f;
            disp[i * 2] += fx; disp[i * 2 + 1] += fy;
            disp[j * 2] -= fx; disp[j * 2 + 1] -= fy;
          }
        }

        // 大团完整两两斥力(质量加权,HEAVY_REPEL 增强):保证大域碎片互相推开、星座铺开成有机形状
        if (heavyIdx.length > 1) {
          for (let hi = 0; hi < heavyIdx.length; hi++) {
            const i = heavyIdx[hi];
            const xi = pos[i * 2], yi = pos[i * 2 + 1];
            for (let hj = hi + 1; hj < heavyIdx.length; hj++) {
              const j = heavyIdx[hj];
              let dx = xi - pos[j * 2], dy = yi - pos[j * 2 + 1];
              let d2 = dx * dx + dy * dy;
              if (d2 < 1e-6) { dx = 0.1; dy = 0.1; d2 = 0.02; }
              const d = Math.sqrt(d2);
              const f = (k * k) / d * Math.sqrt(nodes[i].mass * nodes[j].mass) / massAvg * HEAVY_REPEL;
              const fx = (dx / d) * f, fy = (dy / d) * f;
              disp[i * 2] += fx; disp[i * 2 + 1] += fy;
              disp[j * 2] -= fx; disp[j * 2 + 1] -= fy;
            }
          }
        }

        // 沿边引力(FR 引力 d²/k,按边权重缩放:domain 结构边全量、tag/similar 边降权降雾化)
        for (let e = 0; e < edges.length; e++) {
          const a = edges[e].s, b = edges[e].t;
          const w = edges[e].w || 1;
          const ax = pos[a * 2], ay = pos[a * 2 + 1];
          const bx = pos[b * 2], by = pos[b * 2 + 1];
          let dx = ax - bx, dy = ay - by;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1e-6) { dx = 0.01; dy = 0.01; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const f = w * (d * d) / k;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          disp[a * 2] -= fx; disp[a * 2 + 1] -= fy;
          disp[b * 2] += fx; disp[b * 2 + 1] += fy;
        }

        // 簇质心力(K > 1 时启用)
        if (K > 1) {
          // 计算各簇质心
          cent.fill(0); centCount.fill(0);
          for (let i = 0; i < N; i++) {
            const c = clusterOf[i];
            cent[c * 2] += pos[i * 2];
            cent[c * 2 + 1] += pos[i * 2 + 1];
            centCount[c]++;
          }
          for (let c = 0; c < K; c++) {
            const n = centCount[c] || 1;
            cent[c * 2] /= n; cent[c * 2 + 1] /= n;
          }
          // 簇质心互斥:打散 concentric 的环形宏观结构
          centRep.fill(0);
          for (let c = 0; c < K; c++) {
            const cxj = cent[c * 2], cyj = cent[c * 2 + 1];
            for (let s2 = 0; s2 < 24; s2++) {
              const c2 = hash32(c * 24 + s2 + it * 17) % K;
              if (c2 === c) continue;
              let dx = cxj - cent[c2 * 2];
              let dy = cyj - cent[c2 * 2 + 1];
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) { dx = 0.1; dy = 0.1; d2 = 0.02; }
              const d = Math.sqrt(d2);
              const f = (k * k * 4) / d;
              centRep[c * 2] += (dx / d) * f;
              centRep[c * 2 + 1] += (dy / d) * f;
            }
          }
          // 质心吸引(簇内聚拢) + 质心斥力(簇间分离)传递到成员
          for (let i = 0; i < N; i++) {
            const c = clusterOf[i];
            disp[i * 2] += (cent[c * 2] - pos[i * 2]) * centAttract;
            disp[i * 2 + 1] += (cent[c * 2 + 1] - pos[i * 2 + 1]) * centAttract;
            disp[i * 2] += centRep[c * 2] * centRepelScale;
            disp[i * 2 + 1] += centRep[c * 2 + 1] * centRepelScale;
          }
        }

        // 弱重力:防整体漂移
        if (gravity > 0) {
          for (let i = 0; i < N; i++) {
            disp[i * 2] += (cx - pos[i * 2]) * gravity;
            disp[i * 2 + 1] += (cy - pos[i * 2 + 1]) * gravity;
          }
        }

        // 应用位移(温度限幅 → 后期收敛;边界夹紧兜底)
        for (let i = 0; i < N; i++) {
          let dx = disp[i * 2], dy = disp[i * 2 + 1];
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const move = Math.min(temp, d);
          pos[i * 2] = Math.max(0, Math.min(W, pos[i * 2] + (dx / d) * move));
          pos[i * 2 + 1] = Math.max(0, Math.min(H, pos[i * 2 + 1] + (dy / d) * move));
        }

        it++;
      }
      return it >= iterations;
    }

    return {
      step,
      getPositions: () => pos,
      getClusterCentroids: () => cent
    };
  }

  // ===== 分层"簇网"布局(确定性,保证盘丝错节而非环形/均匀点阵/巨型圆盘) =====
  // 关键改进(修复"两个内环的大圆圈"根因):
  //   1. 大簇碎片化:超过 MAX_GROUP 成员的域簇切成多个子团(≤28 成员),
  //      单域最多形成 ~80px 小团,不再出现 300px+ 的巨型圆盘(大圆盘内部边网 = "内环")
  //   2. 盒尺寸按 组数×理想间距 比例计算:原 width=K*20 对 2851 簇是 57020px
  //      (超出需要 10 倍),导致簇中心被推到边界夹紧成环
  //   3. 组间斥力按大小加权:大子团排斥更强,星座之间不重叠、不吞没孤岛
  // Phase 1:把 G 个"布局组"当作伪节点跑一次 FR(组间边引力 + 大小加权斥力)。
  // Phase 2:每个组的成员按组大小撒成"填充小圆盘"(≤28 成员 → 半径 ≤~80px)。
  //         同域子团靠组间边聚成星座 = 盘丝错节。整过程 O(n + G·samples·iter)。
  function createClusterWebLayout(nodes, edges, clusterOf, options) {
    const N = nodes.length;
    const k = options.idealLength || 26;                       // 节点间距(px)
    const iterations = options.iterations || 200;
    const K = clusterOf ? Math.max(0, ...clusterOf) + 1 : 0;
    const MAX_GROUP = 12;                                      // 单团最大成员数(防巨型圆盘;越细碎片 → 星座越松散成网)

    // ---- Step 1: 按簇收集成员,再碎片化 ---- 
    const mCount = new Int32Array(K);
    for (let i = 0; i < N; i++) mCount[clusterOf[i]]++;
    const mStart = new Int32Array(K);
    let acc = 0;
    for (let c = 0; c < K; c++) { mStart[c] = acc; acc += mCount[c]; }
    const members = new Int32Array(N);
    {
      const fill = mStart.slice();
      for (let i = 0; i < N; i++) members[fill[clusterOf[i]]++] = i;
    }
    // 簇内邻接(仅用于大簇碎片化):沿簇内边 BFS 生长子团,尽量把边留在团内,
    // 减少跨团边 → 大域星座由松耦合子团铺开,而不是被密集内部边拉成圆球("大圆圈")
    const intraAdj = new Map();
    for (let e = 0; e < edges.length; e++) {
      const a = edges[e].s, b = edges[e].t;
      if (clusterOf[a] === clusterOf[b]) {
        if (!intraAdj.has(a)) intraAdj.set(a, []);
        if (!intraAdj.has(b)) intraAdj.set(b, []);
        intraAdj.get(a).push(b); intraAdj.get(b).push(a);
      }
    }
    // 碎片化:大簇沿簇内边切成 ≤MAX_GROUP 的子团;groupOfNode=成员→子团, groupDomain=子团→域簇
    const groupOfNode = new Int32Array(N);
    const groupDomain = [];
    const groupSize = [];
    for (let c = 0; c < K; c++) {
      const n = mCount[c];
      if (n <= 0) continue;
      const subs = Math.max(1, Math.ceil(n / MAX_GROUP));
      if (subs === 1) {
        // 单团:全部成员一个子团
        const g = groupDomain.length; groupDomain.push(c); groupSize.push(0);
        for (let m = 0; m < n; m++) { const v = members[mStart[c] + m]; groupOfNode[v] = g; groupSize[g]++; }
        continue;
      }
      // 多团:BFS 沿簇内边生长,尽量把边留在团内
      const remaining = new Set();
      for (let m = 0; m < n; m++) remaining.add(members[mStart[c] + m]);
      let guard = 0;
      while (remaining.size > 0 && guard++ < 5000) {
        const g = groupDomain.length; groupDomain.push(c); groupSize.push(0);
        let seed = -1;
        for (const v of remaining) { seed = v; if (intraAdj.has(v)) break; }
        const queue = [seed];
        while (queue.length > 0 && groupSize[g] < MAX_GROUP) {
          const v = queue.shift();
          if (!remaining.has(v)) continue;               // 已被其他子团取走/重复入队
          remaining.delete(v);
          groupOfNode[v] = g; groupSize[g]++;
          const nbrs = intraAdj.get(v);
          if (nbrs) {
            for (let q = 0; q < nbrs.length && groupSize[g] < MAX_GROUP; q++) {
              const nb = nbrs[q];
              if (remaining.has(nb)) queue.push(nb);     // 未分配才入队;团满则留给下一团
            }
          }
          // BFS 队列耗尽但子团未满 → 从剩余成员中补一个继续生长(不删除,赋值时再删)
          if (queue.length === 0 && groupSize[g] < MAX_GROUP && remaining.size > 0) {
            let nx = -1;
            for (const v2 of remaining) { nx = v2; break; }
            queue.push(nx);
          }
        }
      }
    }
    const G = groupDomain.length;

    // ---- Step 2: 组间边(去重,取最大权重) + 同域子团聚合边 ----
    const groupEdges = [];
    if (G > 1) {
      const edgeBest = new Map();                              // key -> {s,t,w}
      for (let e = 0; e < edges.length; e++) {
        const a = groupOfNode[edges[e].s], b = groupOfNode[edges[e].t];
        if (a === b) continue;
        const key = a < b ? a * G + b : b * G + a;
        const w = edges[e].w || 1;
        const prev = edgeBest.get(key);
        if (prev) { if (w > prev.w) prev.w = w; }
        else edgeBest.set(key, { s: a, t: b, w });
      }
      // 同域相邻子团加"星座边",保证大域碎片聚拢成团(即使簇内边不足);权重降为 0.5,
      // 只提供松散聚合 → 大域星座铺开成有机网络而非被拉成圆球
      const lastGroupOf = new Int32Array(K).fill(-1);
      for (let g = 0; g < G; g++) {
        const c = groupDomain[g];
        const prev = lastGroupOf[c];
        if (prev >= 0) {
          const key = prev * G + g;
          if (!edgeBest.has(key)) edgeBest.set(key, { s: prev, t: g, w: 0.5 });
        }
        lastGroupOf[c] = g;
      }
      for (const [, v] of edgeBest) groupEdges.push(v);
    }

    // ---- Phase 1: 组中心 FR(大小加权斥力,防大团重叠/巨型圆盘) ----
    const centerNodes = [];
    for (let g = 0; g < G; g++) centerNodes.push({ id: g, mass: groupSize[g] });
    // 组中心理想间距:随组密度自适应(组多→间距小)
    const centLen = Math.max(k * 2, Math.round(k * Math.sqrt(Math.max(1, N / Math.max(1, G)) * 2)));
    // 盒尺寸 ≈ 组数×间距 所需面积(余量 ~5x:簇团之间留空白,防边界夹紧成环)
    const boxSide = Math.round(Math.sqrt(Math.max(1, G)) * centLen * 2.2);
    const centerOpts = {
      idealLength: centLen,
      width: boxSide, height: Math.round(boxSide * 0.92),
      iterations, samples: 24, gravity: 0.02, seed: options.seed || 0,
      initialTemp: 80, cooling: 0.98,                          // 走得更远,避免中心坍缩/带状未收敛
      heavyRepel: options.heavyRepel || 2.5,                   // 大团互斥增强(星座铺开)
      massAvg: Math.max(0.3, (N / Math.max(1, G)) * 0.4)       // 大团斥力权重更强 → 星座铺开不圆球;孤岛也更散 → 结构可见
    };
    const centerLayout = createFRLayout(centerNodes, groupEdges, null, centerOpts);
    const centerPos = centerLayout.getPositions();             // G*2,盒坐标(Phase 1 分片推进后填入)

    // ---- Phase 2: 成员撒入各自子团的填充小圆盘(确定性哈希;seed 换则重排) ----
    const seed = options.seed || 0;
    const blobR = new Float64Array(G);
    for (let g = 0; g < G; g++) blobR[g] = k * Math.sqrt(Math.max(1, groupSize[g]) / Math.PI);
    const pos = new Float64Array(N * 2);

    // 状态机:step(maxMs) 先分片跑 Phase 1 组中心 FR,完成后一次性撒成员(Phase 2,O(n) 快)
    // → 3000+ 组的计算不阻塞主线程(每帧 ≤maxMs),同时保留"渐进成型"观感
    let phase = 1;                                             // 1=组中心FR, 2=撒成员
    let phase2Done = false;

    // Phase 1.5: 打破大族碎片的均匀圆周分布。FR 平衡态是"碎片等角距绕质心排成环"
    // → 视觉上的"环状大圆圈"。按确定性哈希对每个碎片做角度/半径不规则扰动,
    // 变成有机团块(盘丝错节),而非标准圆环。
    function breakFamilyRings() {
      const famGroups = new Map();
      for (let g = 0; g < G; g++) {
        const c = groupDomain[g];
        if (!famGroups.has(c)) famGroups.set(c, []);
        famGroups.get(c).push(g);
      }
      for (const [, gs] of famGroups) {
        if (gs.length < 2) continue;
        let cx = 0, cy = 0;
        for (let i = 0; i < gs.length; i++) { cx += centerPos[gs[i] * 2]; cy += centerPos[gs[i] * 2 + 1]; }
        cx /= gs.length; cy /= gs.length;
        let r = 0;
        for (let i = 0; i < gs.length; i++) {
          const dx = centerPos[gs[i] * 2] - cx, dy = centerPos[gs[i] * 2 + 1] - cy;
          r += Math.sqrt(dx * dx + dy * dy);
        }
        r /= Math.max(1, gs.length);
        for (let i = 0; i < gs.length; i++) {
          const g = gs[i];
          const dx = centerPos[g * 2] - cx, dy = centerPos[g * 2 + 1] - cy;
          const curR = Math.sqrt(dx * dx + dy * dy) || r;
          const ang = Math.atan2(dy, dx);
          const jAng = ((hash32(g * 7 + 5) % 2000) / 2000 - 0.5) * 2.6;   // ±1.3 rad 角度扰动
          const jR = 0.45 + (hash32(g * 13 + 11) % 1000) / 1000 * 1.1;     // 0.45-1.55 半径扰动
          const nr = Math.max(curR * jR, r * 0.35);
          centerPos[g * 2] = cx + Math.cos(ang + jAng) * nr;
          centerPos[g * 2 + 1] = cy + Math.sin(ang + jAng) * nr;
        }
      }
    }

    function scatterMembers() {
      for (let i = 0; i < N; i++) {
        const g = groupOfNode[i];
        const cx2 = centerPos[g * 2], cy2 = centerPos[g * 2 + 1];
        const u = (hash32(i + 1 + seed * 7) % 10000) / 10000;  // 0..1
        const v = (hash32(i + 7919 + seed * 13) % 10000) / 10000;
        const ang = v * Math.PI * 2;
        const rad = blobR[g] * Math.sqrt(u);                   // 填充圆盘(非环)
        pos[i * 2] = cx2 + Math.cos(ang) * rad;
        pos[i * 2 + 1] = cy2 + Math.sin(ang) * rad;
      }
      phase2Done = true;
    }

    return {
      step: (maxMs) => {
        if (phase2Done) return true;
        if (phase === 1) {
          if (!centerLayout.step(maxMs)) return false;         // Phase 1 未完成,下帧继续
          breakFamilyRings();                                   // 打破家族碎片的圆环平衡态
          phase = 2;
        }
        scatterMembers();                                       // Phase 2 一次性(≈2ms)
        return true;
      },
      // Phase 1 尚未完成时返回 null,调用方跳过位置应用(避免全 0 位置闪屏)
      getPositions: () => (phase2Done ? pos : null)
    };
  }

  // ===== 3D 星系空间布局(多星系模式) =====
  // 将 G 个星系置于 3D 空间。每个星系作为带质量的球体：
  //   - 星系间斥力(质量加权)：防止重叠
  //   - 跨星系边引力：关联紧密的星系靠近
  //   - 弱重力：防止漂移
  // 星系数量通常 ≤30,全同步计算(< 5ms),无需分片。
  function create3DGalaxyLayout(galaxies, interEdges, options) {
    const G = galaxies.length;
    const opts = options || {};
    const idealSep = opts.idealSep || 450;       // 星系理想间距
    const iterations = opts.iterations || 120;
    const seed = opts.seed || 0;

    // 球体空间的半径:按星系总数等比例
    const spaceR = idealSep * Math.sqrt(Math.max(1, G)) * 0.9;

    // 确定性初始化(3D 球内随机撒点)
    const pos = new Float64Array(G * 3);
    for (let i = 0; i < G; i++) {
      pos[i * 3]     = ((hash32(i + 1 + seed * 7919) % 10000) / 10000 - 0.5) * spaceR * 2;
      pos[i * 3 + 1] = ((hash32(i + 7919 + seed * 104729) % 10000) / 10000 - 0.5) * spaceR * 2;
      pos[i * 3 + 2] = ((hash32(i + 104729 + seed * 17389) % 10000) / 10000 - 0.5) * spaceR * 2;
    }

    const disp = new Float64Array(G * 3);
    const temp0 = spaceR * 0.5;
    const cooling = 0.95;

    for (let it = 0; it < iterations; it++) {
      const temp = temp0 * Math.pow(cooling, it);
      disp.fill(0);

      // 星系间斥力(质量加权,全对 —— G 小,全量 O(G²) 快速)
      for (let i = 0; i < G; i++) {
        const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
        const mi = galaxies[i].totalNodes || 1;
        for (let j = i + 1; j < G; j++) {
          const dx = xi - pos[j * 3];
          const dy = yi - pos[j * 3 + 1];
          const dz = zi - pos[j * 3 + 2];
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1e-6) { d2 = 1e-6; }
          const d = Math.sqrt(d2);
          const mj = galaxies[j].totalNodes || 1;
          const f = (idealSep * idealSep) / d * Math.sqrt(mi * mj) * 0.3;
          const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
          disp[i * 3] += fx;     disp[i * 3 + 1] += fy;     disp[i * 3 + 2] += fz;
          disp[j * 3] -= fx;     disp[j * 3 + 1] -= fy;     disp[j * 3 + 2] -= fz;
        }
      }

      // 跨星系边引力
      for (let e = 0; e < interEdges.length; e++) {
        const a = interEdges[e].s, b = interEdges[e].t;
        const w = interEdges[e].w || 1;
        const dx = pos[a * 3] - pos[b * 3];
        const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
        const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) { d2 = 1e-6; }
        const d = Math.sqrt(d2);
        const f = w * (d * d) / idealSep * 0.15;
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        disp[a * 3] -= fx;     disp[a * 3 + 1] -= fy;     disp[a * 3 + 2] -= fz;
        disp[b * 3] += fx;     disp[b * 3 + 1] += fy;     disp[b * 3 + 2] += fz;
      }

      // 中心弱重力
      for (let i = 0; i < G; i++) {
        disp[i * 3]     -= pos[i * 3] * 0.005;
        disp[i * 3 + 1] -= pos[i * 3 + 1] * 0.005;
        disp[i * 3 + 2] -= pos[i * 3 + 2] * 0.005;
      }

      // 应用位移(温度限幅)
      for (let i = 0; i < G; i++) {
        let dx = disp[i * 3], dy = disp[i * 3 + 1], dz = disp[i * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const move = Math.min(temp, d);
        pos[i * 3]     += (dx / d) * move;
        pos[i * 3 + 1] += (dy / d) * move;
        pos[i * 3 + 2] += (dz / d) * move;
      }
    }

    // 返回星系的 3D 中心坐标数组
    const centers = [];
    for (let i = 0; i < G; i++) {
      centers.push({ x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] });
    }
    return { centers, spaceR };
  }

  root.GraphLayout = { createFRLayout, createClusterWebLayout, create3DGalaxyLayout };
})(typeof self !== 'undefined' ? self : this);
