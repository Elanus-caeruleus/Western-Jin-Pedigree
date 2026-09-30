/* core.js —— 数据模型 + 布局引擎（不依赖 DOM，可在 Node 里测试）
 * 对应需求文档 v0.1：R01–R03 R07–R14 R16 R19(双竖线) R22–R25 D1 D6 D7
 */
(function (root) {
  'use strict';

  const CFG = {
    W: 136, H: 56,          // 卡片尺寸
    PITCH_GAP: 28,          // 同一行相邻卡片的最小间隙（婚姻线可见的长度）
    CHILD_GAP: 22,          // 子女卡片之间的间隙
    PAIR_GAP: 34,           // 子女与其联姻对象卡片之间的间隙
    MARGIN: 26,             // 相邻两组子女之间的最小间隙
    ROW_GAP: 200,           // 配偶行与子女行的垂直距离
    BUS_OFF: 34,            // 分叉横线距子女卡片顶部的距离
    ICON: 22                // 联姻对象小图标的直径
  };

  const isValidId = v => !!v && v !== '-';
  const isLabel = s => /^（.*）$/.test(s || '');
  const parseOrder = v => { const n = parseFloat(v); return isNaN(n) ? Infinity : n; };
  function cmpOrder(a, b) {
    const oa = a.order, ob = b.order;
    if (oa !== ob) return oa < ob ? -1 : 1;
    return a.idx - b.idx;
  }

  /* ------------------------------------------------------------------ 模型 */
  function buildModel(raw) {
    const persons = new Map();
    for (const p of raw.persons) {
      if (!isValidId(p.id)) continue;                       // D1
      persons.set(p.id, {
        key: p.id, name: p.name, zi: p.zi, family: p.family, pseudo: false,
        gender: p.gender === '男' ? 'M' : p.gender === '女' ? 'F' : '?',
        birth: p.birth, death: p.death
      });
    }
    // 没有人物ID、只有姓名的人（如审美人、刘蕃）：按姓名建"临时人物"
    const ensure = (id, name, g) => {
      if (isValidId(id)) {
        if (!persons.has(id)) persons.set(id, { key: id, name: name || id, zi: '', family: '-', gender: g, pseudo: true });
        return id;
      }
      if (name && name !== '-' && !isLabel(name)) {
        const key = 'n:' + name;
        if (!persons.has(key)) persons.set(key, { key, name, zi: '', family: '-', gender: g, pseudo: true });
        return key;
      }
      return null;
    };

    const marriages = raw.marriages.map((m, i) => ({
      id: m.id, h: ensure(m.husbandId, m.husbandName, 'M'), w: ensure(m.wifeId, m.wifeName, 'F'),
      type: m.type, order: parseOrder(m.order), idx: i
    })).filter(m => m.h && m.w);

    const children = raw.children.map((c, i) => {
      const child = ensure(c.childId, c.childName, '?');
      const father = ensure(c.fatherId, c.fatherName, 'M');
      const mother = ensure(c.motherId, c.motherName, 'F');
      return {
        id: c.id, child, father, mother,
        motherLabel: mother ? null : (c.motherName === '（庶母）' ? '庶母' : '不详'),
        rel: c.rel, rank: c.rank, idx: i
      };
    }).filter(c => c.child);

    const families = new Map();
    for (const f of raw.families) if (f.hex) families.set(f.name, { hex: f.hex, text: f.text || '#000000' });

    const push = (map, k, v) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    const marriagesByHusband = new Map(), marriagesByWife = new Map();
    marriages.forEach(m => { push(marriagesByHusband, m.h, m); push(marriagesByWife, m.w, m); });
    const childrenByFather = new Map(), childrenByMother = new Map(), childrenByChild = new Map();
    children.forEach(c => { push(childrenByFather, c.father, c); push(childrenByMother, c.mother, c); push(childrenByChild, c.child, c); });

    const model = { persons, marriages, children, families, marriagesByHusband, marriagesByWife, childrenByFather, childrenByMother, childrenByChild };
    model.spousesOf = key => {
      const out = [];
      (marriagesByHusband.get(key) || []).forEach(m => out.push({ key: m.w, m }));
      (marriagesByWife.get(key) || []).forEach(m => out.push({ key: m.h, m }));
      return out.sort((a, b) => cmpOrder(a.m, b.m));
    };
    return model;
  }

  function styleOf(model, p) {
    const f = p && model.families.get(p.family);
    return f ? { fill: f.hex, text: f.text } : { fill: '#EEEEEE', text: '#000000' };   // R03
  }

  /* -------------------------------------------- D6：同母核心组内的左右顺序 */
  function orderSiblings(rows, model, warnings) {
    if (rows.length <= 1) return rows.slice();
    const items = rows.slice().sort((a, b) => a.idx - b.idx).map(r => ({ r, num: null, cons: null }));
    items.forEach(it => {
      const s = String(it.r.rank || '').trim();
      if (/^\d+$/.test(s)) it.num = +s;
      else if (/^[<>]/.test(s)) it.cons = { dir: s[0], name: s.slice(1).trim() };
      else { const ds = s.match(/\d+/g); if (ds) it.num = ds.map(Number).reduce((a, b) => a + b, 0) / ds.length; }
    });
    // 数字排行：只在"有数字的人占据的位置"里按数字升序重排，其余人保持表行顺序
    const slots = items.map((_, i) => i).filter(i => items[i].num !== null);
    const numbered = slots.map(i => items[i]).sort((a, b) => a.num - b.num);
    const order = items.slice();
    slots.forEach((slot, k) => { order[slot] = numbered[k]; });
    // 半序约束：">X" = 比X年长（在X左边）；"<X" = 比X年幼（在X右边）
    const pos = new Map(order.map((it, i) => [it, i]));
    const byName = new Map();
    order.forEach(it => byName.set(model.persons.get(it.r.child).name, it));
    const succ = new Map(order.map(it => [it, []])), indeg = new Map(order.map(it => [it, 0]));
    const edge = (a, b) => { succ.get(a).push(b); indeg.set(b, indeg.get(b) + 1); };
    order.forEach(it => {
      if (!it.cons) return;
      const t = byName.get(it.cons.name);
      if (!t || t === it) return;          // 引用的人不在同一组：本版不跨母排序
      if (it.cons.dir === '>') edge(it, t); else edge(t, it);
    });
    const done = [], avail = order.filter(it => indeg.get(it) === 0);
    while (avail.length) {
      avail.sort((a, b) => pos.get(a) - pos.get(b));
      const it = avail.shift(); done.push(it);
      succ.get(it).forEach(n => { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) avail.push(n); });
    }
    if (done.length !== order.length) {
      warnings.push('兄弟姐妹排行约束出现矛盾（环），已按表行顺序排列：' + order.map(it => model.persons.get(it.r.child).name).join('、'));
      return order.map(it => it.r);
    }
    return done.map(it => it.r);
  }

  /* ------------------------------------------------------------------ 视图 */
  function defaultState() {
    return { open: new Map(), expSp: new Set(), kidOpen: new Set(), upOpen: new Set(), mergeUnknown: true, noGray: false };
  }

  // R17：选中人物的"父母与兄弟姐妹"视图需要先找到他的父母
  function resolveParents(model, X) {
    const rows = model.childrenByChild.get(X) || [];
    if (!rows.length) return null;
    const adopt = rows.find(r => r.rel === '过继入');          // R20：过继者挂在养父母名下
    const r = adopt || rows[0];
    const notes = [];
    if (adopt) {
      const bio = rows.filter(x => x !== adopt).map(x => [x.father, x.mother].filter(Boolean).map(k => model.persons.get(k).name).join('、'));
      if (bio.length) notes.push('过继入：已画在养父母名下；生父母（' + bio.join('；') + '）本块暂不画');
    }
    if (r.father) return { axis: r.father, solo: false, coreKey: r.mother || ('u:' + r.motherLabel + ':' + r.father), notes };
    if (r.mother) return { axis: r.mother, solo: true, soloKey: r.mother, coreKey: r.mother, notes };
    return null;
  }
  const hasParents = (model, X) => !!resolveParents(model, X);

  function ownOpts(model, focus) {                  // 选中人物自己的配偶/子女那一段的参数（R08–R16）
    const P = model.persons.get(focus);
    const asH = model.marriagesByHusband.get(focus) || [];
    const asW = model.marriagesByWife.get(focus) || [];
    let axis = focus, coreKey = null, solo = false;
    if (!asH.length && asW.length) { axis = asW.slice().sort(cmpOrder)[0].h; coreKey = focus; }   // R09
    else if (!asH.length && P.gender === 'F') solo = true;
    return { focus, axis, solo, soloKey: focus, coreKey, allOpen: false, up: false, notes: [] };
  }

  // R29：父母、兄弟姐妹（R17）与本人配偶、子女合并成一张图——
  // 先单独算出"本人这一段"（跟原来一样），再把它整体嵌进"父母与兄弟姐妹"视图里选中人物所在的位置
  function buildView(model, focus, state) {
    const P = model.persons.get(focus);
    if (!P) return null;
    state = state || defaultState();
    const own = layoutFamily(model, ownOpts(model, focus), state);
    const up = resolveParents(model, focus);
    if (!up) return own;                             // 没有父母记录（如杨艳）：退回只显示本人这一段
    return layoutFamily(model, {
      focus, axis: up.axis, solo: up.solo, soloKey: up.soloKey, coreKey: up.coreKey,
      allOpen: true, up: true, notes: up.notes, focalChild: focus, focalOwnView: own
    }, state);
  }

  function layoutFamily(model, o, state) {
    const { focus, axis, solo, soloKey, coreKey } = o;
    const openOv = state.open, expSp = state.expSp;
    const mergeUnknown = state.mergeUnknown !== false;
    const warnings = [];
    const grayFlag = value => state.noGray ? false : !!value;
    const { W, H } = CFG;
    const pitch = W + CFG.PITCH_GAP;

    const fatherRows = solo ? (model.childrenByMother.get(soloKey) || []) : (model.childrenByFather.get(axis) || []);

    // ---- 2. 配偶清单 + 分类（R08、R16、D7）
    let sp = [];
    let hasLegal = false;
    if (solo) {
      sp.push({ key: soloKey, kind: 'other', idx: 0, order: Infinity, type: '', solo: true });
    } else {
      (model.marriagesByHusband.get(axis) || []).forEach(m => sp.push({ key: m.w, type: m.type, order: m.order, idx: m.idx }));
      const known = new Set(sp.map(s => s.key));
      let ii = 5000;
      fatherRows.forEach(c => {                       // 亲子表里出现、婚姻表里没有的母亲
        if (c.mother && !known.has(c.mother)) { known.add(c.mother); sp.push({ key: c.mother, type: '', order: Infinity, idx: ii++ }); }
      });
      sp.forEach(s => { s.kind = s.type === '妻' ? 'first' : s.type === '继室' ? 'jishi' : s.type === '妾' ? 'other' : 'unk'; });
      sp.filter(s => s.kind === 'first').sort(cmpOrder).slice(1).forEach(s => { s.kind = 'jishi'; });
      hasLegal = sp.some(s => s.kind === 'first' || s.kind === 'jishi');
      if (fatherRows.some(c => !c.mother && c.motherLabel === '不详') && !(mergeUnknown && hasLegal))
        sp.push({ key: 'u:不详:' + axis, placeholder: true, label: '不详', name: '未知', type: '', order: Infinity, idx: 9001, kind: 'unk' });
      if (fatherRows.some(c => !c.mother && c.motherLabel === '庶母'))
        sp.push({ key: 'u:庶母:' + axis, placeholder: true, label: '庶母', name: '未知妾室', type: '', order: Infinity, idx: 9002, kind: 'other' });
      sp.filter(s => s.kind === 'unk').sort(cmpOrder).forEach((s, i) => { s.kind = (!hasLegal && i === 0) ? 'first' : 'jishi'; });
    }
    const firsts = sp.filter(s => s.kind === 'first').sort(cmpOrder);
    const leftSp = firsts[0] || null;
    const jishi = sp.filter(s => s.kind === 'jishi').concat(firsts.slice(1)).sort(cmpOrder);
    const others = sp.filter(s => s.kind === 'other')
      .sort((a, b) => (a.placeholder ? 1 : 0) - (b.placeholder ? 1 : 0) || cmpOrder(a, b));
    const rightList = jishi.concat(others);
    const allSp = (leftSp ? [leftSp] : []).concat(rightList);

    // ---- 2.2：通用"+N"标记 + 逐代往下展开
    // 一个"单元" = 一个人 + 他已展开的联姻对象 + 他的子女分组。
    //   分组规则：已展开的每位配偶各自一组（标记贴在婚姻线下方）；
    //            其余所有子女（配偶折叠的、没有配偶记录的、母亲/父亲不详的）合成一组（标记贴在本人卡片下方）。
    //   分组的展开状态存在 state.kidOpen，键：'人物|配偶' 或 '人物|*'。
    const kidOpenSet = state.kidOpen || new Set();
    const PW = W + CFG.PAIR_GAP;
    const pushTo = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    function buildUnit(key, depth) {
      const csp = [], seen = new Set();
      model.spousesOf(key).forEach(x => {
        if (seen.has(x.key) || !model.persons.has(x.key)) return;      // 同一对夫妻在婚姻表里重复出现时只算一次
        seen.add(x.key);
        csp.push({ key: x.key, m: x.m, exp: expSp.has(key + '|' + x.key) });
      });
      const expIdx = new Map();
      csp.forEach(x => { if (x.exp) expIdx.set(x.key, expIdx.size); });
      const spOrder = new Map(csp.map((x, i) => [x.key, i]));
      const mar = new Map(), rest = new Map();
      const rows = [];
      (model.childrenByFather.get(key) || []).forEach(r => rows.push({ r, other: r.mother }));
      (model.childrenByMother.get(key) || []).forEach(r => rows.push({ r, other: r.father }));
      rows.forEach(x => {
        if (x.other && expIdx.has(x.other)) pushTo(mar, x.other, x.r);
        else pushTo(rest, x.other || '', x.r);
      });
      const groups = [];
      const restCount = [...rest.values()].reduce((a, v) => a + v.length, 0);
      if (restCount) {
        const restRows = [...rest.values()].flat();
        groups.push({ gkey: key + '|*', kind: 'rest', idx: 0, count: restCount,
          hasFocus: restRows.some(r => r.child === focus),
          getRows: () => [...rest.keys()]
          .sort((a, b) => (spOrder.has(a) ? spOrder.get(a) : 1e9) - (spOrder.has(b) ? spOrder.get(b) : 1e9))
          .reduce((acc, k) => acc.concat(orderSiblings(rest.get(k), model, warnings)), []) });
      }
      csp.filter(x => x.exp).forEach(x => {
        const rs = mar.get(x.key);
        if (rs && rs.length) groups.push({ gkey: key + '|' + x.key, kind: 'mar', idx: expIdx.get(x.key), count: rs.length,
          hasFocus: rs.some(r => r.child === focus),
          getRows: () => orderSiblings(rs, model, warnings) });
      });
      groups.forEach(g => {
        g.open = depth < 8 && kidOpenSet.has(g.gkey);
        g.kids = g.open ? g.getRows().map(r => ({ row: r, unit: buildUnit(r.child, depth + 1) })) : [];
      });
      // 宽度：本人 + 已展开配偶；下面若有展开的子女，取两者较宽者。各组尽量在自己的引出点正下方，放不下就往右推。
      const own = W + expIdx.size * PW;
      let prevRight = -Infinity;
      groups.forEach(g => {
        if (!g.open) return;
        g.gw = g.kids.reduce((a, k) => a + k.unit.w, 0) + (g.kids.length - 1) * CFG.CHILD_GAP;
        const dc = g.kind === 'rest' ? W / 2 : W / 2 + g.idx * PW + PW / 2;
        const c = Math.max(dc, g.gw / 2, prevRight + CFG.MARGIN + g.gw / 2);
        g.left = c - g.gw / 2;
        prevRight = c + g.gw / 2;
      });
      return { key, p: model.persons.get(key), csp, groups, w: Math.max(own, prevRight === -Infinity ? 0 : prevRight) };
    }

    // ---- 3. 每位配偶名下的子女（R12、D6）与折叠状态（R13）
    // R29：选中人物自己那个子女位，宽度按他完整展开的"本人家庭"算，而不是一张普通卡片
    const unitW = k => (o.focalChild && k.key === o.focalChild && o.focalOwnView)
      ? Math.max(W, o.focalOwnView.bounds.maxX - o.focalOwnView.bounds.minX)
      : k.unit.w;
    allSp.forEach(s => {
      const rows = s.solo ? fatherRows
        : s.placeholder ? fatherRows.filter(c => !c.mother && c.motherLabel === s.label)
        : fatherRows.filter(c => c.mother === s.key ||
          (mergeUnknown && hasLegal && s === leftSp && !c.mother && c.motherLabel === '不详'));
      s.kids = orderSiblings(rows, model, warnings).map(r => ({
        row: r, key: r.child, p: model.persons.get(r.child),
        unit: (o.focalChild && r.child === o.focalChild && o.focalOwnView) ? null : buildUnit(r.child, 0)
      }));
      const dflt = o.allOpen || s.kind !== 'other' || s.solo || s.key === coreKey;
      s.defaultOpen = dflt;
      s.open = s.kids.length > 0 && (openOv.has(s.key) ? openOv.get(s.key) : dflt);
      s.gw = s.open ? s.kids.reduce((a, k) => a + unitW(k), 0) + (s.kids.length - 1) * CFG.CHILD_GAP : 0;
    });

    // ---- 4. 第一行 x 坐标（同一代同一水平线，卡片不重叠，R06 R07）
    let rightEdge = -Infinity;
    let d = pitch;
    if (!solo) {
      const wl = leftSp && leftSp.open ? leftSp.gw : 0;
      const wr = jishi[0] && jishi[0].open ? jishi[0].gw : 0;
      if (wl && wr) d = Math.max(pitch, (wl + wr) / 2 + CFG.MARGIN);
      if (leftSp) {
        leftSp.x = -d; leftSp.dropAtMid = true; leftSp.dropX = -d / 2; leftSp.gcx = -d / 2;
        if (leftSp.open) rightEdge = leftSp.gcx + leftSp.gw / 2;
      }
    }
    let prevX = 0;
    rightList.forEach((s, i) => {
      let x;
      if (solo) { x = 0; s.dropAtMid = false; s.dropX = 0; s.gcx = 0; }
      else if (i === 0 && s.kind !== 'other') {      // 紧邻丈夫右侧的继室：子女从婚姻线中点引出
        x = d; s.dropAtMid = true; s.dropX = x / 2; s.gcx = x / 2;
      } else {                                        // 妾室等（以及第 2 位起的继室）：子女从她本人卡片引出
        x = prevX + pitch;
        if (s.open) x = Math.max(x, rightEdge + CFG.MARGIN + s.gw / 2);
        s.dropAtMid = false; s.dropX = x; s.gcx = x;
      }
      s.x = x;
      if (s.open) rightEdge = Math.max(rightEdge, s.gcx + s.gw / 2);
      prevX = x;
    });

    // ---- 5. 第二行：子女
    // 每个孩子的卡片左边对齐到 cx（跟旁边普通孩子一致），宽出来的部分（展开的联姻对象、或 R29 选中人物自己的一整段）
    // 都往右边接，cx 往前推的量＝unitW，这样无论宽多少，下一个孩子都不会被压到
    const y0 = 0, y1 = CFG.ROW_GAP;
    allSp.forEach(s => {
      if (!s.open) return;
      let cx = s.gcx - s.gw / 2;
      s.kids.forEach(k => {
        if (o.focalChild && k.key === o.focalChild && o.focalOwnView) {
          const sub = o.focalOwnView;
          const anchor = sub.cards.find(c => c.key === o.focalChild);
          k._dx = cx - sub.bounds.minX;                    // 子图左边界对齐 cx
          k.x = k._dx + (anchor ? anchor.x : 0);            // 选中人物自己那张卡的最终位置
        } else {
          k.left = cx;
          k.x = cx + W / 2;
        }
        cx += unitW(k) + CFG.CHILD_GAP;
      });
    });

    // ---- 6. 输出：卡片、线、圆点、图标
    const cards = [], lines = [], pairLines = [], chips = [], icons = [], openMap = {};
    const mkCard = (key, x, y, p, extra) => {
      const st = styleOf(model, p);
      const card = Object.assign({
        key, x, y, w: W, h: H, name: p.name, zi: p.zi || '', gender: p.gender,
        fill: st.fill, text: st.text, family: p.family,
        selected: key === focus, gray: false, clickable: true
      }, extra || {});
      card.gray = grayFlag(card.gray);
      return card;
    };
    // 输出一个单元（人物卡 + 联姻对象 + "+N"标记 + 展开后的下一代），可递归
    const emitUnit = (u, cx, y, gray) => {
      gray = grayFlag(gray);
      const kx = cx + W / 2;
      cards.push(mkCard(u.key, kx, y, u.p, { role: 'child', gray }));
      // R22–R25：联姻对象默认折叠成左上角小图标；点击展开，点婚姻线收回
      let ni = 0, ne = 0;
      u.csp.forEach(x => {
        const sp2 = model.persons.get(x.key);
        if (!sp2) return;
        if (!x.exp) {
          const st = styleOf(model, sp2);
          icons.push({ x: kx - W / 2 + 6 + ni * (CFG.ICON + 5), y: y - H / 2 + 2, shape: sp2.gender === 'M' ? 'square' : 'circle',
            fill: st.fill, size: CFG.ICON, title: sp2.name + (sp2.family && sp2.family !== '-' ? '（' + sp2.family + '）' : ''),
            action: 'expand:' + u.key + '|' + x.key, gray });
          ni++;
        } else {
          const px = kx + ne * PW, sx = kx + (ne + 1) * PW;
          pairLines.push({ x1: px + W / 2, y1: y, x2: sx - W / 2, y2: y, style: x.m.type === '妾' ? 'thin' : 'thick', action: 'collapse:' + u.key + '|' + x.key, gray });
          cards.push(mkCard(x.key, sx, y, sp2, { role: 'childSpouse', gray }));
          ne++;
        }
      });
      // 2.2：子女标记。已展开配偶 → 标记在婚姻线下方；其余子女 → 标记在本人卡片下方
      const yN = y + CFG.ROW_GAP, busN = yN - H / 2 - CFG.BUS_OFF;
      u.groups.forEach(g => {
        const ax = g.kind === 'rest' ? kx : kx + g.idx * PW + PW / 2;
        const ay = g.kind === 'rest' ? y + H / 2 : y;
        const sibN = g.count - (g.hasFocus ? 1 : 0);
        chips.push({ x: ax, y: g.kind === 'rest' ? y + H / 2 + 26 : y + 22, label: g.open ? '−' : (sibN > 0 ? '+' + sibN : '+'), action: 'kids:' + g.gkey, gray });
        if (!g.open) return;
        let left = cx + g.left;
        const placed = g.kids.map(kd => { const p = { kd, left, x: left + W / 2 }; left += kd.unit.w + CFG.CHILD_GAP; return p; });
        const xs = placed.map(p => p.x);
        lines.push({ kind: 'child', x1: ax, y1: ay, x2: ax, y2: busN, gray });
        lines.push({ kind: 'child', x1: Math.min(ax, ...xs), y1: busN, x2: Math.max(ax, ...xs), y2: busN, gray });
        placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busN, x2: p.x, y2: yN - H / 2, double: p.kd.row.rel === '过继入', gray });
          emitUnit(p.kd.unit, p.left, yN, gray);
        });
      });
    };
    if (!solo) cards.push(mkCard(axis, 0, y0, model.persons.get(axis), { role: 'axis' }));

    allSp.forEach(s => {
      const p = s.placeholder ? { name: s.name, zi: '', gender: 'F', family: '-' } : model.persons.get(s.key);
      const gray = !!coreKey && s.key !== coreKey;
      cards.push(mkCard(s.key, s.x, y0, p, { role: 'spouse', gray, clickable: !s.placeholder, selected: s.key === focus }));
      openMap[s.key] = s.open;
    });

    // 婚姻线：沿这一行依次连接（左侧粗线；右侧按目标配偶类别粗/细）
    if (!solo) {
      if (leftSp) lines.push({
        kind: 'marry', style: 'thick', x1: leftSp.x + W / 2, y1: y0, x2: -W / 2, y2: y0,
        gray: grayFlag(!!coreKey && leftSp.key !== coreKey)
      });
      let px = W / 2;
      rightList.forEach(s => {
        lines.push({
          kind: 'marry', style: s.kind === 'other' ? 'thin' : 'thick',
          x1: px, y1: y0, x2: s.x - W / 2, y2: y0,
          gray: grayFlag(!!coreKey && s.key !== coreKey)
        });
        px = s.x + W / 2;
      });
    }

    const busY = y1 - H / 2 - CFG.BUS_OFF;
    allSp.forEach(s => {
      if (!s.kids.length) return;
      const gray = !!coreKey && s.key !== coreKey;
      // R13：妾室等的子女默认折叠，卡片下方紧贴一个小圆点
      if (s.kind === 'other' && !s.solo) {
        const n = s.kids.length - (s.kids.some(k => k.row.child === focus) ? 1 : 0);
        chips.push({ x: s.x, y: y0 + H / 2 + 26, label: s.open ? '−' : (n > 0 ? '+' + n : '+'), action: 'toggle:' + s.key });
      }
      if (!s.open) return;
      const startY = s.dropAtMid ? y0 : y0 + H / 2;
      lines.push({ kind: 'child', x1: s.dropX, y1: startY, x2: s.dropX, y2: busY, gray });
      const xs = s.kids.map(k => k.x);
      lines.push({ kind: 'child', x1: Math.min(s.dropX, ...xs), y1: busY, x2: Math.max(s.dropX, ...xs), y2: busY, gray });
      s.kids.forEach(k => {
        lines.push({ kind: 'child', x1: k.x, y1: busY, x2: k.x, y2: y1 - H / 2, double: k.row.rel === '过继入', gray });
        // R29：选中的人——把他"自己的配偶＋子女"那张子图，整体挪到他在兄弟姐妹行里的位置上
        if (o.focalChild && k.key === o.focalChild && o.focalOwnView) {
          const sub = o.focalOwnView;
          const dx = k._dx, dy = y1 - 0;
          const mv = (arr, target, keys) => arr.forEach(e => target.push(Object.assign({}, e, keys.reduce((a, kk) => (a[kk] = e[kk] + (kk[0] === 'x' ? dx : dy), a), {}))));
          mv(sub.cards, cards, ['x', 'y']);
          mv(sub.lines, lines, ['x1', 'y1', 'x2', 'y2']);
          mv(sub.pairLines, pairLines, ['x1', 'y1', 'x2', 'y2']);
          mv(sub.chips, chips, ['x', 'y']);
          mv(sub.icons, icons, ['x', 'y']);
          for (const kk in sub.openMap) if (!(kk in openMap)) openMap[kk] = sub.openMap[kk];   // 本人这一段的妾室开合状态也要带上，否则点"−"收不回去
          return;
        }

        emitUnit(k.unit, k.left, y1, gray);
      });
    });

    // ---- 6b. 2.2 往上展开一代：父亲、母亲各有一个展开点（卡片上方"+N"）。
    // 展开后：这个人的父母（祖辈）出现在上一行；这个人的兄弟姐妹（伯叔姑/舅姨）出现在同一行，
    // 母亲那一侧放在母亲所在的一边，父亲那一侧放在另一边，都排在现有内容的外面，全部灰显。
    if (o.up) {
      const upOpenSet = state.upOpen || new Set();
      const isReal = k => !!k && !String(k).startsWith('u:') && model.persons.has(k);
      const ancestorInfo = key => {
        if (!isReal(key)) return null;
        const up = resolveParents(model, key);
        if (!up) return null;
        const m = up.solo ? up.axis : (isReal(up.coreKey) ? up.coreKey : null);
        const f = up.solo ? null : up.axis;
        const seen = new Set([key]);
        const sibRows = (up.solo ? (model.childrenByMother.get(up.axis) || [])
          : (model.childrenByFather.get(up.axis) || []).filter(c => m ? c.mother === m : !c.mother))
          .filter(c => !seen.has(c.child) && seen.add(c.child));
        const rows = model.childrenByChild.get(key) || [];
        const own = rows.find(r => r.rel === '过继入') || rows[0];
        return { f, m, sibRows, adopted: !!own && own.rel === '过继入', n: (f ? 1 : 0) + (m ? 1 : 0) + sibRows.length };
      };
      const motherCard = (!solo && isReal(coreKey)) ? allSp.find(s => s.key === coreKey) : null;
      const targets = solo ? [{ key: soloKey, x: 0, mother: true }] : [{ key: axis, x: 0, mother: false }].concat(motherCard ? [{ key: coreKey, x: motherCard.x, mother: true }] : []);
      const mSide = (!solo && motherCard && motherCard.x > 0) ? 'R' : 'L';
      let xMinC = Infinity, xMaxC = -Infinity;
      cards.forEach(c => { xMinC = Math.min(xMinC, c.x - W / 2); xMaxC = Math.max(xMaxC, c.x + W / 2); });
      const blocks = [];
      targets.forEach(t => {
        const info = ancestorInfo(t.key);
        if (!info) return;
        const open = upOpenSet.has(t.key);
        chips.push({ x: t.x, y: 0 - H / 2 - 26, label: open ? '−' : (info.sibRows.length > 0 ? '+' + info.sibRows.length : '+'), action: 'up:' + t.key });
        if (!open) return;
        const side = t.mother ? mSide : (mSide === 'L' ? 'R' : 'L');
        const units = orderSiblings(info.sibRows, model, warnings).map(r => ({ row: r, unit: buildUnit(r.child, 0) }));
        const totalW = units.reduce((a, u) => a + u.unit.w, 0) + Math.max(0, units.length - 1) * CFG.CHILD_GAP;
        let left = side === 'R' ? xMaxC + 2 * CFG.MARGIN : xMinC - 2 * CFG.MARGIN - totalW;
        const placed = units.map(u => { const p = { u, left, x: left + W / 2 }; left += u.unit.w + CFG.CHILD_GAP; return p; });
        const xs = [t.x].concat(placed.map(p => p.x));
        blocks.push({ t, info, placed, xs, c: (Math.min(...xs) + Math.max(...xs)) / 2, hw: (info.f && info.m) ? pitch / 2 + W / 2 : W / 2 });
      });
      if (blocks.length === 2) {                       // 两侧的祖辈卡不能挤在一起
        blocks.sort((a, b) => a.c - b.c);
        const need = (blocks[0].c + blocks[0].hw) + CFG.MARGIN - (blocks[1].c - blocks[1].hw);
        if (need > 0) { blocks[0].c -= need / 2; blocks[1].c += need / 2; }
      }
      blocks.forEach(b => {
        const yA = -CFG.ROW_GAP, busA = 0 - H / 2 - CFG.BUS_OFF, both = !!(b.info.f && b.info.m);
        const put = (key, x) => cards.push(mkCard(key, x, yA, model.persons.get(key), { role: 'ancestor', gray: true }));
        if (both) {
          const mx = b.c - pitch / 2, fx = b.c + pitch / 2;
          put(b.info.m, mx); put(b.info.f, fx);
          const mar = (model.marriagesByHusband.get(b.info.f) || []).find(x => x.w === b.info.m);
          lines.push({ kind: 'marry', style: mar && mar.type === '妾' ? 'thin' : 'thick', x1: mx + W / 2, y1: yA, x2: fx - W / 2, y2: yA });
        } else put(b.info.f || b.info.m, b.c);
        lines.push({ kind: 'child', x1: b.c, y1: both ? yA : yA + H / 2, x2: b.c, y2: busA, gray: grayFlag(true) });
        const all = b.xs.concat([b.c]);
        lines.push({ kind: 'child', x1: Math.min(...all), y1: busA, x2: Math.max(...all), y2: busA, gray: grayFlag(true) });
        lines.push({ kind: 'child', x1: b.t.x, y1: busA, x2: b.t.x, y2: 0 - H / 2, double: b.info.adopted, gray: grayFlag(true) });
        b.placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busA, x2: p.x, y2: 0 - H / 2, double: p.u.row.rel === '过继入', gray: grayFlag(true) });
          emitUnit(p.u.unit, p.left, 0, true);
        });
      });
    }

    // ---- 7. 范围（core = 正妻们及其子女，初始居中用）
    const span = arr => arr.reduce((a, [l, r]) => [Math.min(a[0], l), Math.max(a[1], r)], [Infinity, -Infinity]);
    const parts = [[-W / 2, W / 2]];
    const coreSp = (o.up && coreKey) ? allSp.filter(s => s.key === coreKey) : (leftSp ? [leftSp] : []).concat(jishi.slice(0, 1));
    (coreSp.length ? coreSp : others.slice(0, 1)).forEach(s => {
      parts.push([s.x - W / 2, s.x + W / 2]);
      if (s.open) parts.push([s.gcx - s.gw / 2, s.gcx + s.gw / 2]);
    });
    if (solo) parts.length = 0, parts.push([allSp[0].gcx - Math.max(W, allSp[0].gw) / 2, allSp[0].gcx + Math.max(W, allSp[0].gw) / 2]);
    if (o.focalChild && o.focalOwnView) {              // R29：核心区还要包住选中人物自己展开的那一段
      for (const s of allSp) { const k = s.kids.find(x => x.key === o.focalChild); if (k) { const dx = k._dx; parts.push([o.focalOwnView.bounds.minX + dx, o.focalOwnView.bounds.maxX + dx]); break; } }
    }
    const [cMin, cMax] = span(parts);
    const [bMinX, bMaxX] = span(cards.map(c => [c.x - W / 2, c.x + W / 2]));
    const [bMinY, bMaxY] = span(cards.map(c => [c.y - H / 2, c.y + H / 2]));
    return {
      focus, axis, coreKey, solo, up: !!o.up, notes: o.notes || [], cards, lines, pairLines, chips, icons, openMap, warnings,
      core: { minX: cMin, maxX: cMax },
      bounds: { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY }
    };
  }

  function searchPersons(model, q, limit) {
    q = (q || '').trim();
    if (!q) return [];
    const out = [];
    for (const p of model.persons.values()) {
      if (p.name.includes(q) || (p.zi && p.zi.includes(q))) out.push(p);
      if (out.length >= (limit || 8)) break;
    }
    return out;
  }

  const api = { CFG, buildModel, buildView, defaultState, searchPersons, orderSiblings, resolveParents, hasParents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
