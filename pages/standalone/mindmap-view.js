// pages/standalone/mindmap-view.js
// 脑图渲染视图（基于 SVG，自实现，无第三方库依赖）
// - 支持放射布局（radial）与树状布局（tree）
// - 交互：滚轮缩放、按住空白拖拽、点击节点折叠/展开子树
// - 暴露 window.MindmapView = { show(container, data, opts), hide() }
//
// 数据结构（来自 translate-engine.parseMindmap）：
//   { title: string, children: [ { title, children: [...] }, ... ] }

(function () {
  'use strict';

  // ===== 默认选项 =====
  const DEFAULT_OPTS = {
    layout: 'radial',      // 'radial' | 'tree'
    maxDepth: 3,
    nodeColor: '#4299e1',
    rootColor: '#553c9a',
    leafColor: '#48bb78',
    textColor: '#2d3748',
    lineColor: '#cbd5e0',
    nodeFontSize: 12,
    rootFontSize: 14,
    initialScale: 1.0
  };

  // ===== 状态 =====
  let _container = null;
  let _svg = null;
  let _svgContent = null;     // <g> 用于变换
  let _data = null;
  let _opts = { ...DEFAULT_OPTS };
  let _collapsed = new Set(); // 折叠节点的路径 key
  let _scale = 1;
  let _tx = 0;
  let _ty = 0;
  let _isDragging = false;
  let _dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

  // ===== 节点路径 key（用于折叠标识）=====
  function _nodeKey(path) {
    return path.join('/');
  }

  // ===== 计算节点数量（用于布局尺寸估算）=====
  function _countNodes(node, depth = 0, path = []) {
    const key = _nodeKey(path);
    if (_collapsed.has(key) || depth >= _opts.maxDepth) {
      return { nodes: 1, maxDepth: depth };
    }
    let nodes = 1;
    let maxDepth = depth;
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      const sub = _countNodes(children[i], depth + 1, [...path, i]);
      nodes += sub.nodes;
      if (sub.maxDepth > maxDepth) maxDepth = sub.maxDepth;
    }
    return { nodes, maxDepth };
  }

  // ===== 树状布局：横向层级展开（左→右）=====
  // 返回 [{ node, path, x, y, depth }]
  function _layoutTree(root, width, height) {
    const positions = [];
    const hGap = 180;  // 水平间距
    const vGap = 36;   // 垂直最小间距
    let yCursor = 0;

    function layout(node, depth, path) {
      const key = _nodeKey(path);
      const isCollapsed = _collapsed.has(key) || depth >= _opts.maxDepth;
      const children = (isCollapsed ? [] : (node.children || []));
      const x = depth * hGap;

      if (children.length === 0) {
        const y = yCursor;
        positions.push({ node, path, x, y, depth, hasChildren: (node.children && node.children.length > 0) && !isCollapsed });
        yCursor += vGap;
        return { x, y, height: vGap };
      }

      const childResults = [];
      let totalHeight = 0;
      for (let i = 0; i < children.length; i++) {
        const childPath = [...path, i];
        const r = layout(children[i], depth + 1, childPath);
        childResults.push(r);
        totalHeight += r.height;
      }
      const y = childResults[0].y + (childResults[childResults.length - 1].y - childResults[0].y) / 2;
      positions.push({ node, path, x, y, depth, hasChildren: true });
      return { x, y, height: totalHeight };
    }

    layout(root, 0, []);
    return positions;
  }

  // ===== 放射布局：根节点居中，子节点按角度分布 =====
  function _layoutRadial(root, width, height) {
    const positions = [];
    const cx = width / 2;
    const cy = height / 2;
    const minDim = Math.min(width, height);
    const radiusStep = Math.max(80, minDim / 8);

    function layout(node, depth, path, angle, angleSpan, radius) {
      const key = _nodeKey(path);
      const isCollapsed = _collapsed.has(key) || depth >= _opts.maxDepth;
      const children = (isCollapsed ? [] : (node.children || []));
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      positions.push({ node, path, x, y, depth, hasChildren: (node.children && node.children.length > 0) && !isCollapsed });

      if (children.length === 0) return;

      const childRadius = radius + radiusStep;
      const childAngleSpan = angleSpan;
      const angleStart = angle - childAngleSpan / 2;
      const step = children.length > 1 ? childAngleSpan / (children.length - 1) : 0;
      for (let i = 0; i < children.length; i++) {
        const childAngle = children.length === 1 ? angle : angleStart + step * i;
        // 子节点角度跨度收窄
        const subSpan = Math.min(childAngleSpan / children.length, Math.PI / 3);
        layout(children[i], depth + 1, [...path, i], childAngle, subSpan, childRadius);
      }
    }

    layout(root, 0, [], 0, Math.PI * 2, 0);
    // 根节点居中
    if (positions.length > 0) {
      positions[0].x = cx;
      positions[0].y = cy;
    }
    return positions;
  }

  // ===== 估算 SVG 画布尺寸 =====
  function _estimateCanvas(positions) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 80;
    return {
      width: Math.max(400, maxX - minX + pad * 2),
      height: Math.max(300, maxY - minY + pad * 2),
      offsetX: -minX + pad,
      offsetY: -minY + pad
    };
  }

  // ===== 渲染 SVG =====
  function _render() {
    if (!_data || !_container) return;

    const isRadial = _opts.layout === 'radial';
    // 先用临时大画布布局
    const tmpW = 1600;
    const tmpH = 1000;
    const positions = isRadial
      ? _layoutRadial(_data, tmpW, tmpH)
      : _layoutTree(_data, tmpW, tmpH);

    const canvas = _estimateCanvas(positions);

    // 清空内容
    _svgContent.innerHTML = '';

    // 应用平移偏移
    _svgContent.setAttribute('transform', `translate(${_tx + canvas.offsetX}, ${_ty + canvas.offsetY}) scale(${_scale})`);

    // 绘制连线（先画线，后画节点，使节点覆盖线）
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (p.depth === 0) continue;
      // 找父节点：父路径
      const parentPath = p.path.slice(0, -1);
      const parent = positions.find(pp => pp.path.length === parentPath.length && pp.path.every((v, idx) => v === parentPath[idx]));
      if (!parent) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = isRadial
        ? `M ${parent.x} ${parent.y} Q ${(parent.x + p.x) / 2} ${(parent.y + p.y) / 2} ${p.x} ${p.y}`
        : `M ${parent.x} ${parent.y} C ${parent.x + 60} ${parent.y}, ${p.x - 60} ${p.y}, ${p.x} ${p.y}`;
      line.setAttribute('d', d);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', _opts.lineColor);
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('opacity', '0.7');
      _svgContent.appendChild(line);
    }

    // 绘制节点
    for (const p of positions) {
      const isRoot = p.depth === 0;
      const isLeaf = !p.hasChildren;
      const color = isRoot ? _opts.rootColor : (isLeaf ? _opts.leafColor : _opts.nodeColor);
      const fontSize = isRoot ? _opts.rootFontSize : _opts.nodeFontSize;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${p.x}, ${p.y})`);
      g.style.cursor = 'pointer';

      // 节点背景（圆角矩形）
      const text = String(p.node.title || '');
      const textWidth = Math.max(40, text.length * fontSize * 0.7);
      const rectW = textWidth + 16;
      const rectH = fontSize + 12;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', -rectW / 2);
      rect.setAttribute('y', -rectH / 2);
      rect.setAttribute('width', rectW);
      rect.setAttribute('height', rectH);
      rect.setAttribute('rx', 6);
      rect.setAttribute('ry', 6);
      rect.setAttribute('fill', color);
      rect.setAttribute('opacity', '0.12');
      rect.setAttribute('stroke', color);
      rect.setAttribute('stroke-width', '1.5');
      g.appendChild(rect);

      // 文字
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', 0);
      t.setAttribute('y', 0);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('fill', _opts.textColor);
      t.setAttribute('font-size', fontSize);
      t.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif');
      t.setAttribute('font-weight', isRoot ? '600' : '400');
      t.textContent = text;
      g.appendChild(t);

      // 折叠/展开标识（小三角）
      if (p.node.children && p.node.children.length > 0) {
        const tri = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tri.setAttribute('x', rectW / 2 - 4);
        tri.setAttribute('y', -rectH / 2 + 4);
        tri.setAttribute('text-anchor', 'end');
        tri.setAttribute('font-size', 10);
        tri.setAttribute('fill', color);
        tri.textContent = _collapsed.has(_nodeKey(p.path)) ? '+' : '−';
        g.appendChild(tri);
      }

      // 点击：折叠/展开
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = _nodeKey(p.path);
        if (_collapsed.has(key)) {
          _collapsed.delete(key);
        } else {
          _collapsed.add(key);
        }
        _render();
      });

      _svgContent.appendChild(g);
    }
  }

  // ===== 缩放（以鼠标为中心）=====
  function _onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.3, Math.min(3, _scale * delta));
    _scale = newScale;
    _render();
  }

  // ===== 拖拽平移 =====
  function _onMouseDown(e) {
    if (e.target.tagName === 'g' || e.target.tagName === 'text' || e.target.tagName === 'rect') return;
    _isDragging = true;
    _dragStart = { x: e.clientX, y: e.clientY, tx: _tx, ty: _ty };
    document.body.style.cursor = 'grabbing';
  }

  function _onMouseMove(e) {
    if (!_isDragging) return;
    _tx = _dragStart.tx + (e.clientX - _dragStart.x);
    _ty = _dragStart.ty + (e.clientY - _dragStart.y);
    _render();
  }

  function _onMouseUp() {
    _isDragging = false;
    document.body.style.cursor = '';
  }

  // ===== 显示脑图 =====
  function show(container, data, opts = {}) {
    if (!container || !data) return;
    _container = container;
    _data = data;
    _opts = { ...DEFAULT_OPTS, ...opts };
    _collapsed = new Set();
    _scale = _opts.initialScale || 1;
    _tx = 0;
    _ty = 0;

    // 清空容器
    container.innerHTML = '';
    container.classList.add('mindmap-view-container');

    // 工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'mindmap-toolbar';
    toolbar.innerHTML = `
      <span class="mindmap-toolbar-title">🧠 ${i18n('translateMindmapTitle')}</span>
      <div class="mindmap-toolbar-actions">
        <button class="mindmap-btn" data-mm-action="zoomIn" title="${i18n('translateMindmapZoomIn')}">+</button>
        <button class="mindmap-btn" data-mm-action="zoomOut" title="${i18n('translateMindmapZoomOut')}">−</button>
        <button class="mindmap-btn" data-mm-action="reset" title="${i18n('translateMindmapReset')}">↺</button>
        <button class="mindmap-btn" data-mm-action="expandAll" title="${i18n('translateMindmapExpandAll')}">⊕</button>
        <button class="mindmap-btn" data-mm-action="collapseAll" title="${i18n('translateMindmapCollapseAll')}">⊖</button>
        <button class="mindmap-btn mindmap-btn--close" data-mm-action="close" title="${i18n('translateMindmapClose')}">✕</button>
      </div>
    `;
    container.appendChild(toolbar);

    // SVG 容器
    const svgWrap = document.createElement('div');
    svgWrap.className = 'mindmap-svg-wrap';
    container.appendChild(svgWrap);

    _svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    _svg.setAttribute('width', '100%');
    _svg.setAttribute('height', '100%');
    _svg.style.display = 'block';
    svgWrap.appendChild(_svg);

    _svgContent = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    _svg.appendChild(_svgContent);

    // 事件
    _svg.addEventListener('wheel', _onWheel, { passive: false });
    _svg.addEventListener('mousedown', _onMouseDown);
    document.addEventListener('mousemove', _onMouseMove);
    document.addEventListener('mouseup', _onMouseUp);

    // 工具栏按钮
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mm-action]');
      if (!btn) return;
      const action = btn.dataset.mmAction;
      switch (action) {
        case 'zoomIn':
          _scale = Math.min(3, _scale * 1.2);
          _render();
          break;
        case 'zoomOut':
          _scale = Math.max(0.3, _scale * 0.8);
          _render();
          break;
        case 'reset':
          _scale = 1;
          _tx = 0;
          _ty = 0;
          _collapsed = new Set();
          _render();
          break;
        case 'expandAll':
          _collapsed = new Set();
          _render();
          break;
        case 'collapseAll': {
          // 折叠所有 depth=1 节点
          _collapsed = new Set();
          function walk(node, depth, path) {
            if (depth >= 1 && node.children && node.children.length > 0) {
              _collapsed.add(_nodeKey(path));
            }
            const children = node.children || [];
            for (let i = 0; i < children.length; i++) {
              walk(children[i], depth + 1, [...path, i]);
            }
          }
          walk(_data, 0, []);
          _render();
          break;
        }
        case 'close':
          hide();
          break;
      }
    });

    _render();
  }

  // ===== 隐藏 =====
  function hide() {
    if (_svg) {
      _svg.removeEventListener('wheel', _onWheel);
      _svg.removeEventListener('mousedown', _onMouseDown);
      _svg = null;
    }
    document.removeEventListener('mousemove', _onMouseMove);
    document.removeEventListener('mouseup', _onMouseUp);
    if (_container) {
      _container.innerHTML = '';
      _container.classList.remove('mindmap-view-container');
    }
    _container = null;
    _data = null;
    _svgContent = null;
  }

  // ===== 暴露 API =====
  window.MindmapView = {
    show,
    hide
  };
})();
