/* app.js —— 渲染 + 交互（R35 点击换人 / R36 拖拽平移 / R37 滚轮缩放 / R38 搜索） */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const { CFG } = Core;
  const model = Core.buildModel(window.PEDIGREE_DATA);

  const svg = document.getElementById('canvas');
  const vp = document.getElementById('vp');
  const infoEl = document.getElementById('info');
  const searchEl = document.getElementById('search');
  const resultsEl = document.getElementById('results');
  const mergeUnknownEl = document.getElementById('merge-unknown');
  const toggleGrayBtn = document.getElementById('toggle-gray');
  const collapseAllEl = document.getElementById('collapse-all');

  let state = Core.defaultState();
  let focus = null;
  let view = null;
  let T = { x: 0, y: 0, k: 1 };

  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const stripName = name => (name ? name.replace(/[(（].*?[)）]/g, '') : '');

  /* ---------------------------------------------------------------- 渲染 */
  /* ------------------------------------------------ 展开/折叠的平滑过渡
     旧画面和新画面里"同一个东西"一起平滑地滑到新位置：
       · 卡片、小圆点、图标：按身份（人物/动作）对应，从旧位置滑到新位置
       · 线条：按形状和位置就近对应（一条线向旁边挪、变长变短，都是同一条线在动，不会先消失再出现）
       · 只有真正新增的才淡入、真正消失的才淡出 */
  const DUR = 520;
  const FAR = 520;                                        // 搬得比这还远的（如配偶搬回自己家族块）不再滑过去：原处淡出、新处淡入
  const dur = () => DUR * (window.__animScale || 1);       // 演示页用来放慢动画
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);          // 先慢、中间快、再慢
  const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let anim = null;
  const NUM = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
  const readT = n => { const m = (n.getAttribute('transform') || '').match(/translate\(\s*(-?[\d.e-]+)[ ,]+(-?[\d.e-]+)\s*\)/); return m ? { x: +m[1], y: +m[2] } : null; };
  function atomOf(n) {                                    // 线条/折线/关系词：取出"形状 + 数值"
    if (n.closest('.adoptpi')) return null;
    const tag = n.tagName.toLowerCase(), cls = n.getAttribute('class') || '';
    if (tag === 'line') {
      const v = ['x1', 'y1', 'x2', 'y2'].map(k => +n.getAttribute(k));
      return { n, v, kind: 'line|' + cls + '|' + (v[1] === v[3] ? 'h' : v[0] === v[2] ? 'v' : 'd') };
    }
    if (tag === 'path') { const d = n.getAttribute('d') || ''; const v = (d.match(NUM) || []).map(Number); return { n, v, kind: 'path|' + cls + '|' + v.length, d }; }
    if (tag === 'text') return { n, v: [+n.getAttribute('x'), +n.getAttribute('y')], kind: 'text|' + cls + '|' + n.textContent };
    return null;
  }
  function collectDom() {
    const cards = new Map(), chips = new Map(), icons = new Map(), atoms = [];
    const put = (map, key, rec) => { let i = 0; while (map.has(key + '#' + i)) i++; map.set(key + '#' + i, rec); };
    vp.querySelectorAll('[data-key]').forEach(n => { const t = readT(n); if (t) put(cards, n.getAttribute('data-id') || n.getAttribute('data-key'), { n, x: t.x, y: t.y }); });
    vp.querySelectorAll('[data-chip]').forEach(n => { const t = readT(n); if (t) put(chips, n.getAttribute('data-chip'), { n, x: t.x, y: t.y }); });
    vp.querySelectorAll('.icon[data-act]').forEach(n => put(icons, n.getAttribute('data-act'), { n, x: +n.getAttribute('data-ix'), y: +n.getAttribute('data-iy') }));
    const lines = vp.querySelector('#layer-lines');
    if (lines) lines.querySelectorAll('line, path, text').forEach(n => { const a = atomOf(n); if (a) atoms.push(a); });
    return { cards, chips, icons, atoms };
  }
  function fadeIn(n, delay) {
    const o = getComputedStyle(n).opacity;
    n.style.opacity = '0'; n.getBoundingClientRect();
    n.style.transition = `opacity ${Math.round(dur() * 0.8)}ms ease ${delay || 0}ms`; n.style.opacity = o;
    setTimeout(() => { n.style.opacity = ''; n.style.transition = ''; }, dur() + (delay || 0) + 80);
  }
  function matchAtoms(prev, cur) {                        // 同形状的线条，按"整体移动距离"从小到大一对一配对
    const byKind = new Map();
    cur.forEach((c, j) => { if (!byKind.has(c.kind)) byKind.set(c.kind, []); byKind.get(c.kind).push(j); });
    const pairs = [];
    prev.forEach((p, i) => (byKind.get(p.kind) || []).forEach(j => {
      const c = cur[j]; if (c.v.length !== p.v.length) return;
      let d = 0; for (let k = 0; k < p.v.length; k++) d += Math.abs(p.v[k] - c.v[k]);
      if (d <= 1800) pairs.push([d, i, j]);
    }));
    pairs.sort((x, y) => x[0] - y[0]);
    const usedP = new Set(), usedC = new Set(), out = [];
    pairs.forEach(([d, i, j]) => { if (usedP.has(i) || usedC.has(j)) return; usedP.add(i); usedC.add(j); out.push([i, j]); });
    return { out, usedP, usedC };
  }
  // 线条跟着卡片走：线的端点正对哪张卡片的中心，旧位置＝新位置减去那张卡片挪动的距离；没有正对的卡片（如夫妻中点）取左右两张的平均
  function matchLines(prev, cur, deltaAt) {
    const r1 = x => Math.round(x * 10);
    const keyOf = (kind, p, q) => { const s = [[r1(p[0]), r1(p[1])], [r1(q[0]), r1(q[1])]].sort((u, w) => u[0] - w[0] || u[1] - w[1]); return kind + '|' + s[0] + '|' + s[1]; };
    const near = (p, q) => Math.abs(p[0] - q[0]) < 1.5 && Math.abs(p[1] - q[1]) < 1.5;
    const orient = (p, oA, oB) => {                         // 把旧线的两端对到新线的两端；只有一端对得上也算（线变长/变短）
      const P1 = [p.v[0], p.v[1]], P2 = [p.v[2], p.v[3]];
      if (near(P1, oA) && near(P2, oB)) return [P1[0], P1[1], P2[0], P2[1]];
      if (near(P2, oA) && near(P1, oB)) return [P2[0], P2[1], P1[0], P1[1]];
      if (near(P1, oA)) return [P1[0], P1[1], P2[0], P2[1]];
      if (near(P2, oA)) return [P2[0], P2[1], P1[0], P1[1]];
      if (near(P1, oB)) return [P2[0], P2[1], P1[0], P1[1]];
      if (near(P2, oB)) return [P1[0], P1[1], P2[0], P2[1]];
      return null;
    };
    const idx = new Map();
    prev.forEach((p, i) => { if (!p.kind.startsWith('line|')) return; const k = keyOf(p.kind, [p.v[0], p.v[1]], [p.v[2], p.v[3]]); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(i); });
    const usedP = new Set(), usedC = new Set(), out = [];
    cur.forEach((c, j) => {
      if (!c.kind.startsWith('line|')) return;
      const A = [c.v[0], c.v[1]], B = [c.v[2], c.v[3]], dA = deltaAt(A[0], A[1]), dB = deltaAt(B[0], B[1]);
      if (!dA || !dB) return;                                // 挂在新出现的卡片上 → 当作新线条
      const oA = [A[0] - dA.x, A[1] - dA.y], oB = [B[0] - dB.x, B[1] - dB.y];
      let i = (idx.get(keyOf(c.kind, oA, oB)) || []).find(t => !usedP.has(t));
      let ov = null;
      if (i !== undefined) ov = orient(prev[i], oA, oB);
      if (!ov) { i = undefined; for (let t = 0; t < prev.length; t++) { if (usedP.has(t) || prev[t].kind !== c.kind) continue; const o = orient(prev[t], oA, oB); if (o) { i = t; ov = o; break; } } }
      if (i === undefined || !ov) return;
      usedP.add(i); usedC.add(j); out.push({ i, j, ov });
    });
    return { out, usedP, usedC };
  }
  function playTransition(old, pan) {
    if (anim) cancelAnimationFrame(anim);
    const now = collectDom();
    const ghosts = el('g', { 'pointer-events': 'none' });
    vp.insertBefore(ghosts, vp.firstChild);
    const items = [];
    const fadeOut = n => {
      ghosts.appendChild(n);
      const o = getComputedStyle(n).opacity;
      n.style.opacity = o; n.getBoundingClientRect();
      n.style.transition = `opacity ${Math.round(dur() * 0.6)}ms ease`; n.style.opacity = '0';
      setTimeout(() => n.remove(), dur());
    };
    // 卡片、小圆点：从旧位置滑到新位置
    [[now.cards, old.cards], [now.chips, old.chips]].forEach(([cur, prev]) => {
      cur.forEach((c, k) => {
        const p = prev.get(k);
        if (!p) { fadeIn(c.n, 100); return; }
        if (Math.hypot(c.x - p.x, c.y - p.y) > FAR) { c.far = true; fadeIn(c.n, 100); fadeOut(p.n); prev.delete(k); return; }   // 搬得太远：原处淡出、新处淡入，不让它穿过整个画布
        if (p.x !== c.x || p.y !== c.y) items.push(e => c.n.setAttribute('transform', `translate(${p.x + (c.x - p.x) * e},${p.y + (c.y - p.y) * e})`));
      });
      prev.forEach((p, k) => { if (!cur.has(k)) fadeOut(p.n); });
    });
    // 图标：同样按动作对应
    now.icons.forEach((c, k) => {
      const p = old.icons.get(k);
      if (!p) { fadeIn(c.n, 100); return; }
      if (Math.hypot(c.x - p.x, c.y - p.y) > FAR) { fadeIn(c.n, 100); fadeOut(p.n); old.icons.delete(k); return; }
      if (p.x !== c.x || p.y !== c.y) items.push(e => c.n.setAttribute('transform', `translate(${(p.x - c.x) * (1 - e)},${(p.y - c.y) * (1 - e)})`));
    });
    old.icons.forEach((p, k) => { if (!now.icons.has(k)) fadeOut(p.n); });
    // 线条：先按"挂在哪张卡片上"精确配对（跟着卡片一起挪），剩下的折线、文字再按形状就近配对；配不上的才淡入/淡出
    const cardList = [];
    now.cards.forEach((c, k) => { const p = old.cards.get(k); cardList.push({ x: c.x, y: c.y, d: (p && !c.far) ? { x: c.x - p.x, y: c.y - p.y } : null }); });
    const deltaAt = (x, y) => {
      let best = null, bd = 1e9;
      cardList.forEach(c => { if (Math.abs(c.x - x) < 3.5) { const dy = Math.abs(c.y - y); if (dy < 170 && dy < bd) { bd = dy; best = c; } } });
      if (best) return best.d;
      const nb = cardList.filter(c => Math.abs(c.y - y) < 170).sort((u, w) => Math.abs(u.x - x) - Math.abs(w.x - x)).slice(0, 2);
      if (!nb.length || nb.some(c => !c.d)) return null;
      return { x: (nb[0].d.x + nb[nb.length - 1].d.x) / 2, y: (nb[0].d.y + nb[nb.length - 1].d.y) / 2 };
    };
    const ml = matchLines(old.atoms, now.atoms, deltaAt);
    const restP = [], restC = [];
    old.atoms.forEach((p, i) => { if (!p.kind.startsWith('line|')) restP.push(i); });
    now.atoms.forEach((c, j) => { if (!c.kind.startsWith('line|')) restC.push(j); });
    const mr = matchAtoms(restP.map(i => old.atoms[i]), restC.map(j => now.atoms[j]));
    const pairsAll = ml.out.map(o => ({ i: o.i, j: o.j, pv: o.ov }));
    const m = { usedP: new Set(ml.usedP), usedC: new Set(ml.usedC) };
    mr.out.forEach(([ii, jj]) => { const i = restP[ii], j = restC[jj]; pairsAll.push({ i, j, pv: old.atoms[i].v }); m.usedP.add(i); m.usedC.add(j); });
    pairsAll.forEach(({ i, j, pv }) => {
      const p = { v: pv }, c = now.atoms[j];
      if (p.v.every((x, k) => Math.abs(x - c.v[k]) < 0.01)) return;
      items.push(e => {
        const v = p.v.map((x, k) => x + (c.v[k] - x) * e);
        const tag = c.n.tagName.toLowerCase();
        if (tag === 'line') { c.n.setAttribute('x1', v[0]); c.n.setAttribute('y1', v[1]); c.n.setAttribute('x2', v[2]); c.n.setAttribute('y2', v[3]); }
        else if (tag === 'path') { let q = 0; c.n.setAttribute('d', c.d.replace(NUM, () => v[q++])); }
        else { c.n.setAttribute('x', v[0]); c.n.setAttribute('y', v[1]); }
      });
    });
    now.atoms.forEach((c, j) => { if (!m.usedC.has(j)) fadeIn(c.n, 160); });
    old.atoms.forEach((p, i) => { if (!m.usedP.has(i)) fadeOut(p.n); });

    if (pan) items.push(e => { T = { k: pan.from.k + (pan.to.k - pan.from.k) * e, x: pan.from.x + (pan.to.x - pan.from.x) * e, y: pan.from.y + (pan.to.y - pan.from.y) * e }; applyT(); });
    if (!items.length) return;
    items.forEach(f => f(0));
    const t0 = performance.now();
    const step = t => {
      const e = ease(Math.min(1, (t - t0) / dur()));
      items.forEach(f => f(e));
      if (e < 1) anim = requestAnimationFrame(step); else anim = null;
    };
    anim = requestAnimationFrame(step);
  }

  function render(animate, panFn) {
    const old = (animate && !REDUCE && vp.firstChild) ? collectDom() : null;
    view = Core.buildView(model, focus, state);
    Core.commitPins(view, state);                              // 状态分层："块放左/右"第一次决定后记进意图，之后不再翻边
    const panTo = panFn ? panFn() : null;                      // 想让某个东西在屏幕上保持不动时，算出视角应该挪到哪
    vp.textContent = '';
    const gLines = el('g', { id: 'layer-lines' }, vp), gCards = el('g', {}, vp), gTop = el('g', {}, vp);

    view.lines.forEach(l => {
      if (l.double) {
        [-2.6, 2.6].forEach(o => el('line', {
          x1: l.x1 + o, y1: l.y1, x2: l.x2 + o, y2: l.y2,
          class: 'ln child' + (l.gray ? ' gray' : ''),
          'data-sig': `L${Math.round(l.x1 + o)},${Math.round(l.y1)},${Math.round(l.x2 + o)},${Math.round(l.y2)}${l.gray ? 'g' : ''}`
        }, gLines));
      } else {
        el('line', {
          x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
          class: 'ln ' + (l.kind === 'child' ? 'child' : l.style) + (l.gray ? ' gray' : ''),
          'data-sig': `L${Math.round(l.x1)},${Math.round(l.y1)},${Math.round(l.x2)},${Math.round(l.y2)}${l.kind === 'child' ? 'c' : l.style}${l.gray ? 'g' : ''}`
        }, gLines);
      }
    });
    view.pairLines.forEach(l => {
      const g = el('g', { class: 'pair' + (l.gray ? ' gray' : ''), 'data-act': l.action,
        'data-sig': `P${Math.round(l.x1)},${Math.round(l.y1)},${Math.round(l.x2)},${Math.round(l.y2)}${l.style}${l.action}` }, gLines);
      el('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, class: 'ln ' + l.style }, g);
      el('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, class: 'hit' }, g);
      el('title', {}, g).textContent = '点击婚姻线：收回这位联姻对象';
    });

    (view.kinLines || []).forEach(k => {          // 旁系连接线：⊓ 折线（亲兄弟实线；堂/表/再从虚线），线上标关系词
      const d = k.legs.map((x, i) => `M${x},${k.legY ? k.legY[i] : k.yCard}L${x},${k.top}`).join('') + `M${k.x1},${k.top}L${k.x2},${k.top}`;
      el('path', { d, class: 'kin' + (k.dash ? ' dash' : '') + (k.dot ? ' dot' : ''), 'data-sig': 'K' + d }, gLines);
      el('text', { x: (k.x1 + k.x2) / 2, y: k.top - 6, class: 'kinlbl', 'data-sig': `T${Math.round(k.x1)},${Math.round(k.top)}${k.label}` }, gLines).textContent = k.label;
    });

    view.cards.forEach(c => {
      if (c.id === undefined) console.warn('[render] 卡片缺少稳定 id（配对会失效）:', c.key, c.role, c.adoptedOut ? '|out' : '');
      const g = el('g', {
        class: 'card' + (c.gray ? ' gray' : '') + (c.clickable ? ' clickable' : ''),
        transform: `translate(${c.x},${c.y})`, 'data-key': c.key, 'data-id': c.id, 'data-x': c.x, 'data-y': c.y, 'data-uid': c.uid
      }, gCards);
      if (c.dbl) g.setAttribute('data-dblkey', c.key);
      if (c.clickable) g.setAttribute('data-act', 'focus:' + c.key);
      const r = el('rect', {
        x: -c.w / 2, y: -c.h / 2, width: c.w, height: c.h, fill: c.fill,
        class: 'box' + (c.selected ? ' sel' : '')
      }, g);
      if (c.gender === 'F') { r.setAttribute('rx', 21); r.setAttribute('ry', 21); }
      const two = !!c.zi;
      const t1 = el('text', { x: 0, y: two ? -6 : 1, class: 'nm', fill: c.text }, g);
      t1.textContent = trunc(stripName(c.name), 9);
      if (two) {
        const t2 = el('text', { x: 0, y: 14, class: 'zi', fill: c.text }, g);
        t2.textContent = trunc(c.zi, 12);
      }
      el('title', {}, g).textContent = stripName(c.name) + (c.zi ? '（' + c.zi + '）' : '') + (c.family && c.family !== '-' ? ' · ' + c.family : '');
    });

    (view.adoptLinks || []).forEach(a => {       // 过继的虚线 Π：平时隐藏，鼠标放在生父母名下那张卡上时显示
      const g = el('g', { class: 'adoptpi', 'data-bio': a.bioUid }, gLines);
      el('path', { d: `M${a.x1},${a.y1}L${a.x1},${a.top}L${a.x2},${a.top}L${a.x2},${a.y2}`, class: 'kin dash' }, g);
      el('text', { x: (a.x1 + a.x2) / 2, y: a.top - 6, class: 'kinlbl' }, g).textContent = a.label;
      const bioG = gCards.querySelector(`[data-uid="${a.bioUid}"]`), adoptRect = gCards.querySelector(`[data-uid="${a.adoptUid}"] rect`);
      if (bioG && adoptRect) {
        bioG.addEventListener('mouseenter', () => { g.classList.add('on'); adoptRect.classList.add('sel'); });
        bioG.addEventListener('mouseleave', () => { g.classList.remove('on'); if (!adoptRect.dataset.sel) adoptRect.classList.remove('sel'); });
        if (adoptRect.classList.contains('sel')) adoptRect.dataset.sel = '1';
      }
    });

    view.chips.forEach(c => {
      const g = el('g', { class: 'chip' + (c.gray ? ' gray' : ''), transform: `translate(${c.x},${c.y})`, 'data-act': c.action, 'data-chip': c.action, 'data-x': c.x, 'data-y': c.y, style: 'cursor:pointer;user-select:none;-webkit-user-select:none;' }, gTop);
      el('circle', { r: 24, style: 'fill:transparent;stroke:transparent;' }, g);
      if (c.shape === 'diamond') el('polygon', { points: '0,-13 13,0 0,13 -13,0', class: 'dia' }, g);   // 旁系亲属：小菱形
      else el('circle', { r: 12 }, g);
      el('text', { x: 0, y: 1 }, g).textContent = c.label;
      if (c.title) el('title', {}, g).textContent = c.title;
    });

    view.icons.forEach(i => {
      const g = el('g', { class: 'icon' + (i.gray ? ' gray' : ''), 'data-act': i.action, 'data-ix': i.x, 'data-iy': i.y }, gTop);
      if (i.dblKey) g.setAttribute('data-dblkey', i.dblKey);
      const s = i.size;
      if (i.shape === 'circle') el('circle', { cx: i.x + s / 2, cy: i.y + s / 2, r: s / 2, fill: i.fill }, g);
      else el('rect', { x: i.x, y: i.y, width: s, height: s, fill: i.fill }, g);
      el('title', {}, g).textContent = '联姻对象：' + i.title + '（点击展开）';
    });

    renderInfo();
    if (old) playTransition(old, panTo ? { from: { k: T.k, x: T.x, y: T.y }, to: { k: panTo.k === undefined ? T.k : panTo.k, x: panTo.x, y: panTo.y } } : null);
    else if (panTo) { T = { k: panTo.k === undefined ? T.k : panTo.k, x: panTo.x, y: panTo.y }; applyT(); }
  }

  function renderInfo() {
    const p = model.persons.get(focus);
    const bits = [stripName(p.name)];
    if (p.zi) bits.push(p.zi);
    if (p.family && p.family !== '-') bits.push(p.family);
    const life = [p.birth, p.death].filter(Boolean).join('–');
    if (life) bits.push(life);
    infoEl.textContent = '';
    const b = document.createElement('b'); b.textContent = bits[0]; infoEl.appendChild(b);
    if (bits.length > 1) infoEl.appendChild(document.createTextNode('　' + bits.slice(1).join(' · ')));
    if (view.virtual) {
      const d = document.createElement('div'); d.className = 'note'; d.textContent = '兄弟姐妹（来自旁系关系表，左长右幼；父母未录入；同父异母灰显）　本人的配偶与子女在下面一行';
      infoEl.appendChild(d);
    } else if (view.up) {
      const nameOf = k => k.startsWith('u:')
        ? (k.includes('庶母') ? '未知妾室' : '未知')
        : (model.persons.get(k) ? stripName(model.persons.get(k).name) : '未知');
      const parents = view.solo ? '母 ' + nameOf(view.coreKey) : '父 ' + nameOf(view.axis) + '　母 ' + nameOf(view.coreKey);
      const d = document.createElement('div'); d.className = 'note'; d.textContent = parents + '　（同父同母兄弟姐妹居中；同父异母灰显；本人的配偶与子女在下面一行）';
      infoEl.appendChild(d);
    }
    view.notes.forEach(t => { const d = document.createElement('div'); d.className = 'note'; d.textContent = t; infoEl.appendChild(d); });
    if (view.warnings.length) {
      const w = document.createElement('div'); w.className = 'warn'; w.textContent = '数据提示：' + view.warnings.join('；');
      infoEl.appendChild(w);
    }
  }

  /* ----------------------------------------------------------- 视口：平移/缩放 */
  const applyT = () => vp.setAttribute('transform', `translate(${T.x},${T.y}) scale(${T.k})`);

  function fitTarget() {                         // R14：核心区（正妻们及其子女）居中，其余允许伸出右边缘
    const r = svg.getBoundingClientRect();
    const cw = Math.max(view.core.maxX - view.core.minX, CFG.W);
    const k = Math.max(0.45, Math.min(1, (r.width * 0.9) / cw));
    const cx = (view.core.minX + view.core.maxX) / 2;
    const cy = (view.bounds.minY + view.bounds.maxY) / 2;
    return { k, x: r.width / 2 - cx * k, y: r.height / 2 - cy * k };
  }
  function fit() { T = fitTarget(); applyT(); }
  // 只动镜头（没有内容变化，如点\"回到中心\"）：镜头平滑地移过去
  let camAnim = null;
  function tweenCamera(to) {
    if (camAnim) cancelAnimationFrame(camAnim);
    if (REDUCE) { T = to; applyT(); return; }
    const from = { k: T.k, x: T.x, y: T.y }, t0 = performance.now();
    const step = t => { const e = ease(Math.min(1, (t - t0) / dur())); T = { k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }; applyT(); camAnim = e < 1 ? requestAnimationFrame(step) : null; };
    camAnim = requestAnimationFrame(step);
  }

  function zoomAt(px, py, factor) {
    const k = Math.max(0.2, Math.min(3, T.k * factor));
    const f = k / T.k;
    T = { k, x: px - (px - T.x) * f, y: py - (py - T.y) * f };
    applyT();
  }

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  let press = null, pendingClick = null;
  svg.addEventListener('pointerdown', e => {
    const tgt = e.target.closest('[data-act]');
    press = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y, act: tgt ? tgt.getAttribute('data-act') : null, dbl: (tgt && tgt.getAttribute('data-dblkey')) || null, moved: false, id: e.pointerId };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) > 15) { press.moved = true; svg.classList.add('dragging'); }
    if (press.moved) { T.x = press.tx + dx; T.y = press.ty + dy; applyT(); }
  });
  const endPress = e => {
    if (!press || e.pointerId !== press.id) return;
    const p = press; press = null;
    svg.classList.remove('dragging');
    if (p.moved) return;                          // 拖动 ≠ 点击
    // v2.0：联姻对象（相邻的卡片或左上角小图标）可以双击，把他的整个家族展开成左/右一大块（再双击收回）。单击原来的作用不变，所以这类目标的单击要等一小会儿，看有没有第二下
    if (pendingClick) {
      const q = pendingClick; pendingClick = null; clearTimeout(q.t);
      if (p.dbl && q.key === p.dbl) { act('blk:' + p.dbl); return; }
      act(q.act);                                 // 不是同一张卡：先把上一次单击补上
    }
    if (p.dbl && p.act) { pendingClick = { key: p.dbl, act: p.act, t: setTimeout(() => { const q = pendingClick; pendingClick = null; if (q) act(q.act); }, 260) }; return; }
    if (p.act) act(p.act);
  };
  svg.addEventListener('pointerup', endPress);
  svg.addEventListener('pointercancel', () => { press = null; svg.classList.remove('dragging'); });

  /* ------------------------------------------------------------------ 动作 */
  function setFocus(key) {
    const first = !view;
    focus = key;
    const mergeUnknown = state.mergeUnknown;
    const noGray = state.noGray;
    state = Core.defaultState();
    state.mergeUnknown = mergeUnknown;
    state.noGray = noGray;
    render(!first, () => fitTarget());              // 换人：留在画面里的人平滑滑到新位置，镜头同时移到新的核心区
  }
  // 镜头锚定：每次动作之前记下画面上每张卡片/小圆点的位置；动作之后按下面的顺序挑一个\"没怎么动\"的东西，
  // 把镜头反向挪一下，让它在屏幕上保持原位（所以点哪里、哪里就不动，内容腾出空间时不会整块滑走）：
  //   被点的小圆点/卡片 → 被点的人的配偶、父母 → 选中的人 → 都不行就取所有卡片位移的中位数（大多数东西保持不动）
  const snapLayout = () => {
    const m = new Map();
    view.cards.forEach(c => m.set('c:' + c.id, { x: c.x, y: c.y, key: c.key }));
    view.chips.forEach(c => { if (!m.has('h:' + c.action)) m.set('h:' + c.action, { x: c.x, y: c.y }); });
    return m;
  };
  const idsOfKey = (m, key) => [...m].filter(([id, v]) => id[0] === 'c' && v.key === key).map(([id]) => id);
  const relatedKeys = key => [].concat(model.spousesOf(key).map(x => x.key), (model.childrenByChild.get(key) || []).reduce((a, r) => a.concat([r.father, r.mother].filter(Boolean)), []));
  function anchorPan(before, clickedIds, clickedKeys) {
    const after = snapLayout();
    const disp = id => { const a = before.get(id), b = after.get(id); return a && b ? { a, b, d: Math.hypot(b.x - a.x, b.y - a.y) } : null; };
    const tryIds = ids => { for (const id of ids) { const r = disp(id); if (r && r.d <= FAR) return r; } return null; };
    let r = tryIds(clickedIds);
    if (!r) {
      const ks = []; clickedKeys.forEach(k => { ks.push(k); relatedKeys(k).forEach(x => ks.push(x)); }); ks.push(focus);
      const ids = []; ks.forEach(k => idsOfKey(after, k).forEach(id => ids.push(id)));
      r = tryIds(ids);
    }
    let dx, dy;
    if (r) { dx = r.b.x - r.a.x; dy = r.b.y - r.a.y; }
    else {
      const ds = [...after].filter(([id]) => id[0] === 'c' && before.has(id)).map(([id, b]) => ({ dx: b.x - before.get(id).x, dy: b.y - before.get(id).y })).filter(d => Math.hypot(d.dx, d.dy) <= FAR);
      if (!ds.length) return null;
      const med = arr => { const q = arr.slice().sort((p, w) => p - w); return q[Math.floor(q.length / 2)]; };
      dx = med(ds.map(d => d.dx)); dy = med(ds.map(d => d.dy));
    }
    return { x: T.x - dx * T.k, y: T.y - dy * T.k };
  }
  function anchored(change, ids, keys) {
    const before = snapLayout();
    change();
    render(true, () => anchorPan(before, ids, keys));
  }
  const keysOfArg = arg => arg.split('|').filter(x => x && x !== '*');
  // 点小圆点（\"+N\"/\"−\"）：被点的圆点钉在屏幕原位
  function keepChip(action, change) {
    const arg = action.slice(action.indexOf(':') + 1);
    const cardIds = idsOfKey(snapLayout(), keysOfArg(arg)[0] || '');
    anchored(change, ['h:' + action].concat(cardIds), keysOfArg(arg));
  }
  function act(a) {
    const i = a.indexOf(':'), type = a.slice(0, i), arg = a.slice(i + 1);
    if (type === 'focus') { if (arg !== focus) setFocus(arg); }
    else if (type === 'toggle') { keepChip(a, () => state.open.set(arg, !view.openMap[arg])); }
    else if (type === 'blk') {                    // v2.0：展开/收起一个人的整个家族块（双击卡片时展开前还没有\"−\"圆点，所以钉被点的那张卡；它搬得太远就钉它的配偶/父母）
      keepChip(a, () => { if (state.blocks.has(arg)) state.blocks.delete(arg); else state.blocks.add(arg); });
    }
    else if (type === 'up') {                     // R2.2：父/母卡片上方的"+N"——往上展开一代（祖辈+兄弟姐妹）
      keepChip(a, () => { if (state.upOpen.has(arg)) state.upOpen.delete(arg); else state.upOpen.add(arg); });
    }
    else if (type === 'rel') {                    // 小菱形：展开/收起旁系表里直接写的亲属
      keepChip(a, () => { if (state.relOpen.has(arg)) state.relOpen.delete(arg); else state.relOpen.add(arg); });
    }
    else if (type === 'kids') {                   // R2.2：点"+N"展开/收起这一组子女
      keepChip(a, () => {
        // 有些子女组默认就是展开的（如搬进自己家族行的丈夫名下的孩子）：收起时记在 kidShut 里，才收得回去
        const isOpen = ((view.chips.find(c => c.action === a)) || {}).label === '−';
        if (!state.kidShut) state.kidShut = new Set();
        if (isOpen) { state.kidOpen.delete(arg); state.kidShut.add(arg); } else { state.kidOpen.add(arg); state.kidShut.delete(arg); }
      });
    }
    else if (type === 'expand') {
      const [k, sp] = arg.split('|');
      anchored(() => {
        state.expSp.add(arg);
        if (state.kidOpen.has(k + '|*')) state.kidOpen.add(k + '|' + sp);   // 子女已经摊开的，展开配偶后继续摊开
      }, idsOfKey(snapLayout(), k), [k, sp]);
    }
    else if (type === 'collapse') {
      const [k, sp] = arg.split('|');
      anchored(() => {
        state.expSp.delete(arg); state.expSp.delete(sp + '|' + k);            // 两个方向都收回
        if (state.kidOpen.delete(k + '|' + sp)) state.kidOpen.add(k + '|*'); // 子女已经摊开的，收回配偶后继续摊开
      }, idsOfKey(snapLayout(), k), [k, sp]);
    }
  }

  /* ------------------------------------------------------------------ 搜索 */
  function showResults() {
    const list = Core.searchPersons(model, searchEl.value, 8);
    resultsEl.textContent = '';
    resultsEl.style.display = list.length ? 'block' : 'none';
    list.forEach(p => {
      const d = document.createElement('div');
      d.className = 'res';
      d.textContent = p.name + (p.zi ? '　' + p.zi : '') + (p.family && p.family !== '-' ? '　· ' + p.family : '');
      d.addEventListener('mousedown', ev => {
        ev.preventDefault();
        searchEl.value = ''; resultsEl.style.display = 'none';
        setFocus(p.key);
      });
      resultsEl.appendChild(d);
    });
  }
  searchEl.addEventListener('input', showResults);
  searchEl.addEventListener('blur', () => { resultsEl.style.display = 'none'; });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const list = Core.searchPersons(model, searchEl.value, 1);
      if (list.length) { searchEl.value = ''; resultsEl.style.display = 'none'; setFocus(list[0].key); }
    }
  });

  if (mergeUnknownEl) {
    mergeUnknownEl.addEventListener('change', () => {
      state.mergeUnknown = mergeUnknownEl.checked;
      render(true);                                // 切换这个开关时镜头保持不动，只有内容平滑重排
    });
  }
  if (toggleGrayBtn) {
    toggleGrayBtn.addEventListener('change', () => {
      state.noGray = toggleGrayBtn.checked;
      render(true);
    });
  }
  if (collapseAllEl) {
    let skipConfirm = localStorage.getItem('skipCollapseConfirm') === 'true';
    const modal = document.getElementById('collapse-modal');
    const doCollapse = () => {
      state.open.clear();
      state.expSp.clear();
      state.kidOpen.clear();
      if (state.kidShut) state.kidShut.clear();
      state.upOpen.clear();
      state.blocks.clear();
      state.relOpen.clear();
      render(true, () => fitTarget());
      setTimeout(() => { collapseAllEl.checked = false; }, 300);
    };
    collapseAllEl.addEventListener('change', () => {
      if (!collapseAllEl.checked) return;
      if (skipConfirm) {
        doCollapse();
      } else {
        modal.classList.add('active');
        document.getElementById('collapse-confirm').onclick = () => {
          if (document.getElementById('collapse-dont-ask').checked) {
            skipConfirm = true;
            localStorage.setItem('skipCollapseConfirm', 'true');
          }
          modal.classList.remove('active');
          doCollapse();
        };
        document.getElementById('collapse-cancel').onclick = () => {
          modal.classList.remove('active');
          setTimeout(() => { collapseAllEl.checked = false; }, 300);
        };
      }
    });
  }

  document.getElementById('zin').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); });
  document.getElementById('zout').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); });
  document.getElementById('zfit').addEventListener('click', () => tweenCamera(fitTarget()));
  window.addEventListener('resize', fit);

  /* ------------------------------------------------------------------ 启动 */
  const start = [...model.persons.values()].find(p => p.name === '司马炎') || model.persons.values().next().value;
  setFocus(start.key);
  window.__pedigree = { setFocus, act, model, get view() { return view; }, get state() { return state; }, get T() { return T; }, FAR };   // 便于调试和演示页
})();
