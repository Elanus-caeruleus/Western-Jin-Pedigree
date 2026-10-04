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
     卡片和小圆点：原来就有的平滑移到新位置，新出现的淡入；线和图标：没变的保持不动，新的淡入，消失的淡出 */
  const DUR = 420, EASE = 'cubic-bezier(.33,.7,.25,1)';
  const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function collectDom() {
    const cards = new Map(), chips = new Map(), sigs = [];
    const put = (map, key, rec) => { let i = 0; while (map.has(key + '#' + i)) i++; map.set(key + '#' + i, rec); };
    vp.querySelectorAll('[data-key]').forEach(n => put(cards, n.getAttribute('data-key'), { n, x: +n.getAttribute('data-x'), y: +n.getAttribute('data-y') }));
    vp.querySelectorAll('[data-chip]').forEach(n => put(chips, n.getAttribute('data-chip'), { n, x: +n.getAttribute('data-x'), y: +n.getAttribute('data-y') }));
    vp.querySelectorAll('[data-sig]').forEach(n => sigs.push([n.getAttribute('data-sig'), n]));
    return { cards, chips, sigs };
  }
  function fadeIn(n, delay) {
    const o = getComputedStyle(n).opacity;
    n.style.opacity = '0'; n.getBoundingClientRect();
    n.style.transition = `opacity ${DUR}ms ease ${delay || 0}ms`; n.style.opacity = o;
    setTimeout(() => { n.style.opacity = ''; n.style.transition = ''; }, DUR + (delay || 0) + 60);
  }
  function glide(n, from, to) {
    n.style.transition = 'none'; n.style.transform = `translate(${from.x}px,${from.y}px)`; n.getBoundingClientRect();
    n.style.transition = `transform ${DUR}ms ${EASE}`; n.style.transform = `translate(${to.x}px,${to.y}px)`;
    setTimeout(() => { n.style.transition = ''; n.style.transform = ''; }, DUR + 60);
  }
  function playTransition(old) {
    const now = collectDom();
    const ghosts = el('g', { 'pointer-events': 'none' });
    vp.insertBefore(ghosts, vp.firstChild);
    const fadeOut = n => {
      ghosts.appendChild(n);
      const o = getComputedStyle(n).opacity;
      n.style.opacity = o; n.getBoundingClientRect();
      n.style.transition = `opacity ${Math.round(DUR * 0.7)}ms ease`; n.style.opacity = '0';
      setTimeout(() => n.remove(), DUR);
    };
    [[now.cards, old.cards], [now.chips, old.chips]].forEach(([cur, prev]) => {
      cur.forEach((c, k) => {
        const p = prev.get(k);
        if (!p) fadeIn(c.n, 60);
        else if (p.x !== c.x || p.y !== c.y) glide(c.n, p, c);
      });
      prev.forEach((p, k) => { if (!cur.has(k)) fadeOut(p.n); });
    });
    const oldSigs = new Set(old.sigs.map(s => s[0])), newSigs = new Set(now.sigs.map(s => s[0]));
    now.sigs.forEach(([sig, n]) => { if (!oldSigs.has(sig)) fadeIn(n, 120); });
    old.sigs.forEach(([sig, n]) => { if (!newSigs.has(sig)) fadeOut(n); });
  }

  function render(animate) {
    const old = (animate && !REDUCE && vp.firstChild) ? collectDom() : null;
    view = Core.buildView(model, focus, state);
    vp.textContent = '';
    const gLines = el('g', {}, vp), gCards = el('g', {}, vp), gTop = el('g', {}, vp);

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
      const g = el('g', {
        class: 'card' + (c.gray ? ' gray' : '') + (c.clickable ? ' clickable' : ''),
        transform: `translate(${c.x},${c.y})`, 'data-key': c.key, 'data-x': c.x, 'data-y': c.y, 'data-uid': c.uid
      }, gCards);
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
      const g = el('g', { class: 'icon' + (i.gray ? ' gray' : ''), 'data-act': i.action, 'data-sig': `I${i.action}@${Math.round(i.x)},${Math.round(i.y)}` }, gTop);
      const s = i.size;
      if (i.shape === 'circle') el('circle', { cx: i.x + s / 2, cy: i.y + s / 2, r: s / 2, fill: i.fill }, g);
      else el('rect', { x: i.x, y: i.y, width: s, height: s, fill: i.fill }, g);
      el('title', {}, g).textContent = '联姻对象：' + i.title + '（点击展开）';
    });

    renderInfo();
    if (old) playTransition(old);
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

  function fit() {                               // R14：核心区（正妻们及其子女）居中，其余允许伸出右边缘
    const r = svg.getBoundingClientRect();
    const cw = Math.max(view.core.maxX - view.core.minX, CFG.W);
    const k = Math.max(0.45, Math.min(1, (r.width * 0.9) / cw));
    const cx = (view.core.minX + view.core.maxX) / 2;
    const cy = (view.bounds.minY + view.bounds.maxY) / 2;
    T = { k, x: r.width / 2 - cx * k, y: r.height / 2 - cy * k };
    applyT();
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

  let press = null;
  svg.addEventListener('pointerdown', e => {
    const tgt = e.target.closest('[data-act]');
    press = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y, act: tgt ? tgt.getAttribute('data-act') : null, moved: false, id: e.pointerId };
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
    if (!p.moved && p.act) act(p.act);            // 没拖动 = 点击
  };
  svg.addEventListener('pointerup', endPress);
  svg.addEventListener('pointercancel', () => { press = null; svg.classList.remove('dragging'); });

  /* ------------------------------------------------------------------ 动作 */
  function setFocus(key) {
    focus = key;
    const mergeUnknown = state.mergeUnknown;
    const noGray = state.noGray;
    state = Core.defaultState();
    state.mergeUnknown = mergeUnknown;
    state.noGray = noGray;
    render(); fit();
  }
  // R2.2：展开/收起后画面不自动居中、不缩放；只把被点的那个"+N"钉在屏幕原位，避免内容因腾出空间而滑走
  function keepChip(action, change) {
    const pick = () => view.chips.find(c => c.action === action && !c.out) || view.chips.find(c => c.action === action && !c.gray) || view.chips.find(c => c.action === action);
    const before = pick();
    change();
    render(true);
    const after = before && pick();
    if (after) { T.x += (before.x - after.x) * T.k; T.y += (before.y - after.y) * T.k; applyT(); }
  }
  function act(a) {
    const i = a.indexOf(':'), type = a.slice(0, i), arg = a.slice(i + 1);
    if (type === 'focus') { if (arg !== focus) setFocus(arg); }
    else if (type === 'toggle') { keepChip(a, () => state.open.set(arg, !view.openMap[arg])); }
    else if (type === 'up') {                     // R2.2：父/母卡片上方的"+N"——往上展开一代（祖辈+兄弟姐妹）
      keepChip(a, () => { if (state.upOpen.has(arg)) state.upOpen.delete(arg); else state.upOpen.add(arg); });
    }
    else if (type === 'rel') {                    // 小菱形：展开/收起旁系表里直接写的亲属
      keepChip(a, () => { if (state.relOpen.has(arg)) state.relOpen.delete(arg); else state.relOpen.add(arg); });
    }
    else if (type === 'kids') {                   // R2.2：点"+N"展开/收起这一组子女
      keepChip(a, () => { if (state.kidOpen.has(arg)) state.kidOpen.delete(arg); else state.kidOpen.add(arg); });
    }
    else if (type === 'expand') {
      const [k, sp] = arg.split('|');
      state.expSp.add(arg);
      if (state.kidOpen.has(k + '|*')) state.kidOpen.add(k + '|' + sp);   // 子女已经摊开的，展开配偶后继续摊开
      render(true);
    }
    else if (type === 'collapse') {
      const [k, sp] = arg.split('|');
      state.expSp.delete(arg); state.expSp.delete(sp + '|' + k);            // 两个方向都收回
      if (state.kidOpen.delete(k + '|' + sp)) state.kidOpen.add(k + '|*'); // 子女已经摊开的，收回配偶后继续摊开
      render(true);
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
      render(); fit();
    });
  }
  if (toggleGrayBtn) {
    toggleGrayBtn.addEventListener('change', () => {
      state.noGray = toggleGrayBtn.checked;
      render();
    });
  }
  if (collapseAllEl) {
    let skipConfirm = localStorage.getItem('skipCollapseConfirm') === 'true';
    const modal = document.getElementById('collapse-modal');
    const doCollapse = () => {
      state.open.clear();
      state.expSp.clear();
      state.kidOpen.clear();
      state.upOpen.clear();
      state.relOpen.clear();
      render();
      fit();
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
  document.getElementById('zfit').addEventListener('click', fit);
  window.addEventListener('resize', fit);

  /* ------------------------------------------------------------------ 启动 */
  const start = [...model.persons.values()].find(p => p.name === '司马炎') || model.persons.values().next().value;
  setFocus(start.key);
  window.__pedigree = { setFocus, act, model, get view() { return view; } };   // 便于调试
})();
