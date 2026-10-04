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
    BRACKET: 18,            // 婚姻括线的横杠距卡片底部的距离
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

    // 旁系关系表里的"亲兄弟姐妹"行：给每一组挂一位看不见的共同母亲（键以 'v:' 开头，不是真人，不画卡片、不画向上的线）。
    // 这样整套现有逻辑（核心家庭居中、选中人物自己的配偶子女展开、+N、点卡片换人）都自动适用。
    // 只收没有真实父母记录的人（有父母记录的以亲子表为准）；行内顺序＝左长右幼；共用同一个人的行自动并成一组。
    {
      const SIB_TERMS = new Set(['兄弟', '姐妹', '兄妹', '姐弟', '兄弟姐妹']);
      const HALF_TERMS = new Set(['异母兄弟', '异母姐妹', '异母兄妹', '异母姐弟', '异母兄弟姐妹']);   // 同父异母：同组、但灰显
      const groups = [], fullEdges = [];
      (raw.collaterals || []).filter(c => SIB_TERMS.has(c.term) || HALF_TERMS.has(c.term)).forEach(c => {
        const ids = c.members.map(m => m.id).filter(id => persons.has(id) && !childrenByChild.has(id));
        if (ids.length < 2) return;
        if (SIB_TERMS.has(c.term)) fullEdges.push(ids);
        const hit = groups.filter(g => ids.some(id => g.includes(id)));
        const merged = [];
        hit.forEach(g => g.forEach(id => { if (!merged.includes(id)) merged.push(id); }));
        ids.forEach(id => { if (!merged.includes(id)) merged.push(id); });
        hit.forEach(g => groups.splice(groups.indexOf(g), 1));
        groups.push(merged);
      });
      const comp = new Map();                           // 亲兄弟小组：只有"亲"行把人连在一起，异母行不连
      const find = x => { while (comp.has(x) && comp.get(x) !== x) x = comp.get(x); return x; };
      fullEdges.forEach(ids => ids.forEach(id => { if (!comp.has(id)) comp.set(id, id); }));
      fullEdges.forEach(ids => ids.slice(1).forEach(id => comp.set(find(id), find(ids[0]))));
      groups.forEach((g, gi) => {
        const vk = 'v:S' + gi;
        g.forEach((id, i) => {
          const row = { id: vk + '#' + i, child: id, father: null, mother: vk, motherLabel: null, rel: '亲生', rank: '', idx: 100000 + gi * 100 + i, virtual: true, fullComp: comp.has(id) ? find(id) : id };
          children.push(row); push(childrenByMother, vk, row); push(childrenByChild, id, row);
        });
      });
    }

    // 旁系关系表里直接写的同辈关系（堂/从/表/再从/族）：两人一条记录；跨辈（从子等）暂不画
    const collateralPairs = new Map(), collateralOf = new Map(), crossList = [];
    {
      const relKind = t => /^再从/.test(t) ? 'zc' : /^堂/.test(t) ? 'tang' : /^从(兄弟|姐妹|兄妹|姐弟)/.test(t) ? 'tang' : /^表(兄弟|姐妹|兄妹|姐弟)/.test(t) ? 'biao' : /^族(兄弟|姐妹|兄妹|姐弟)/.test(t) ? 'zu' : null;
      const crossRe = /^(从父子|从父女|从子|从女|堂侄|堂侄女|侄|侄女|外甥|外甥女)$/;       // 差一辈：第1位＝长辈，第2位＝晚辈
      (raw.collaterals || []).forEach(c => {
        const term = String(c.term || '');
        if (crossRe.test(term)) {
          const ids = c.members.map(m => m.id).filter(id => persons.has(id));
          ids.slice(1).forEach(y => {
            crossList.push({ elder: ids[0], younger: y, term, rowId: c.id });
            push(collateralOf, ids[0], { other: y, kind: 'cross', dir: 'down', term, rowId: c.id });
            push(collateralOf, y, { other: ids[0], kind: 'cross', dir: 'up', term, rowId: c.id });
          });
          return;
        }
        const kind = relKind(term);
        if (!kind) return;
        const ids = c.members.map(m => m.id).filter(id => persons.has(id));
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j];
          if (collateralPairs.has(a + '|' + b)) continue;
          const info = { kind, rowId: c.id, term: c.term };
          collateralPairs.set(a + '|' + b, info); collateralPairs.set(b + '|' + a, info);
          push(collateralOf, a, Object.assign({ other: b }, info)); push(collateralOf, b, Object.assign({ other: a }, info));
        }
      });
    }

    const model = { persons, marriages, children, families, marriagesByHusband, marriagesByWife, childrenByFather, childrenByMother, childrenByChild, collateralPairs, collateralOf, crossList };
    model.spousesOf = key => {
      const out = [];
      (marriagesByHusband.get(key) || []).forEach(m => out.push({ key: m.w, m }));
      (marriagesByWife.get(key) || []).forEach(m => out.push({ key: m.h, m }));
      return out.sort((a, b) => cmpOrder(a.m, b.m));
    };
    return model;
  }

  const isVirtual = k => String(k || '').startsWith('v:');

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
    return { open: new Map(), expSp: new Set(), kidOpen: new Set(), upOpen: new Set(), relOpen: new Set(), mergeUnknown: true, noGray: false };
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
  function buildViewBase(model, focus, state) {
    const P = model.persons.get(focus);
    if (!P) return null;
    state = state || defaultState();
    const run = st => {
      const own = layoutFamily(model, ownOpts(model, focus), st);
      const up = resolveParents(model, focus);
      if (!up) return own;                           // 没有父母记录（如杨艳）：退回只显示本人这一段
      return layoutFamily(model, {
        focus, axis: up.axis, solo: up.solo, soloKey: up.soloKey, coreKey: up.coreKey,
        allOpen: true, up: true, notes: up.notes, focalChild: focus, focalOwnView: own
      }, st);
    };
    // 第 1 遍：不展开任何联姻对象，看看哪些人本来就在画面里；第 2 遍：这些人如果又是别人的联姻对象，就不再复制卡片
    const probe = run(Object.assign({}, state, { expSp: new Set(), twin: null }));
    const twin = new Set(probe.cards.map(c => c.key));
    const cnt = new Map();
    probe.cards.forEach(c => cnt.set(c.key, (cnt.get(c.key) || 0) + 1));
    const dupAdopt = new Set([...cnt].filter(([k, n]) => n >= 2 && (model.childrenByChild.get(k) || []).some(r => r.rel === '过继入')).map(([k]) => k));
    return run(Object.assign({}, state, { twin, dupAdopt }));
  }

  // 过继入的养父/养母名字（用于生父母名下那张卡片的注释“出继xx”）
  function adoptiveName(model, key) {
    const r = (model.childrenByChild.get(key) || []).find(x => x.rel === '过继入');
    const k = r && (r.father || r.mother);
    const p = k && model.persons.get(k);
    return p ? p.name.replace(/[(（].*?[)）]/g, '') : '';
  }

  function buildView(model, focus, state) {
    const v = buildViewBase(model, focus, state);
    if (v) { v.cards.forEach((c, i) => { c.uid = i; }); linkBrackets(model, v, state || defaultState()); relMarkers(model, v, state || defaultState()); v.kinLines = kinLines(model, v); v.adoptLinks = adoptLinks(model, v); }
    return v;
  }

  // ---- 过继：生父母名下那张卡（灰显、注释“出继xx”）与过继入的那张之间的虚线 Π（鼠标悬停时才显示）
  function adoptLinks(model, view) {
    const { H } = CFG, out = [];
    const rowTops = y => Math.min(Infinity, ...(view.kinLines || []).filter(k => Math.abs(k.y - y) < 1).map(k => k.top));
    view.cards.filter(c => c.adoptedOut).forEach((bio, i) => {
      const adopt = view.cards.find(c => c.key === bio.key && !c.adoptedOut);
      if (!adopt) return;
      const yTop = Math.min(bio.y, adopt.y) - H / 2;
      const top = Math.min(yTop - 52, rowTops(Math.min(bio.y, adopt.y)) - 14) - 14 * i;
      out.push({ key: bio.key, bioUid: bio.uid, adoptUid: adopt.uid, x1: bio.x + 24, x2: adopt.x + 24, y1: bio.y - H / 2, y2: adopt.y - H / 2, top, label: '过继' });
    });
    return out;
  }

  // ---- 联姻括线（长）：夫妻两人各在自己的家族位置、都在画面里时，不复制卡片，用一条括线把两人连起来
  function linkBrackets(model, view, state) {
    const { H } = CFG;
    const grayFlag = v => state.noGray ? false : !!v;
    const cardBy = new Map();
    view.cards.forEach(c => { const o = cardBy.get(c.key); if (!o || o.role === 'childSpouse' || (o.adoptedOut && !c.adoptedOut)) cardBy.set(c.key, c); });
    const items = [];
    (view.links || []).forEach(l => {
      const a = cardBy.get(l.a), b = cardBy.get(l.b);
      if (a && b && a !== b) items.push({ l, a, b, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
    });
    const byRow = new Map();
    items.forEach(it => { const r = Math.round(it.y); if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(it); });
    byRow.forEach(list => {
      list.sort((p, q) => (p.hi - p.lo) - (q.hi - q.lo));
      const levels = [];
      list.forEach(it => {
        let lv = 0;
        while (levels[lv] && levels[lv].some(o => !(it.hi + 20 < o.lo || it.lo - 20 > o.hi))) lv++;
        (levels[lv] = levels[lv] || []).push(it);
        it.lv = lv;
      });
    });
    items.forEach(it => {
      const barY = it.y + H / 2 + 56 + 10 * it.lv;            // 放在各卡片底部的小圆点（+N）下面，避免压住
      const gray = grayFlag(it.a.gray && it.b.gray);
      [it.a, it.b].forEach(c => view.lines.push({ kind: 'child', x1: c.x, y1: c.y + H / 2, x2: c.x, y2: barY, gray }));
      view.pairLines.push({ x1: it.a.x, y1: barY, x2: it.b.x, y2: barY, style: it.l.type === '妾' ? 'thin' : 'thick',
        action: 'collapse:' + it.l.a + '|' + it.l.b, gray });
      view.bounds.maxY = Math.max(view.bounds.maxY, barY + 6);
    });
  }

  // ---- 旁系表里直接写的两人关系：卡片右上角的小菱形；点开后把对方以灰显卡片补进同一行的外侧（连线由 kinLines 画）
  function relMarkers(model, view, state) {
    const { W, H } = CFG;
    const relOpen = state.relOpen || new Set();
    const gray = state.noGray ? false : true;
    const presentKeys = () => new Set(view.cards.map(c => c.key));
    for (let it = 0; it < 4; it++) {
      let added = false;
      [...view.cards].forEach(c => {
        if (!relOpen.has(c.key)) return;
        (model.collateralOf.get(c.key) || []).forEach(r => {
          if (presentKeys().has(r.other)) return;
          const ty = c.y + (r.kind === 'cross' ? (r.dir === 'down' ? CFG.ROW_GAP : -CFG.ROW_GAP) : 0);
          const row = view.cards.filter(x => Math.abs(x.y - c.y) < 1 || Math.abs(x.y - ty) < 1);
          const mn = Math.min(...row.map(x => x.x)), mx = Math.max(...row.map(x => x.x));
          const x = c.x < (mn + mx) / 2 ? mn - (W + CFG.CHILD_GAP) : mx + (W + CFG.CHILD_GAP);
          const p = model.persons.get(r.other), st = styleOf(model, p);
          view.bounds.minY = Math.min(view.bounds.minY, ty - H / 2); view.bounds.maxY = Math.max(view.bounds.maxY, ty + H / 2);
          view.cards.push({ key: r.other, x, y: ty, w: W, h: H, name: p.name, zi: p.zi || '', gender: p.gender, fill: st.fill, text: st.text,
            family: p.family, selected: r.other === view.focus, gray, clickable: true, role: 'relative' });
          view.bounds.minX = Math.min(view.bounds.minX, x - W / 2); view.bounds.maxX = Math.max(view.bounds.maxX, x + W / 2);
          added = true;
        });
      });
      if (!added) break;
    }
    const pres = presentKeys(), seen = new Set();
    view.cards.filter(c => !c.adoptedOut).concat(view.cards.filter(c => c.adoptedOut)).forEach(c => {
      if (seen.has(c.key)) return;
      seen.add(c.key);
      const rels = model.collateralOf.get(c.key) || [];
      if (!rels.length) return;
      const hidden = new Set(rels.map(r => r.other).filter(o => !pres.has(o)));
      const open = relOpen.has(c.key);
      if (!hidden.size && !open) return;
      view.chips.push({ x: c.x + W / 2 - 4, y: c.y - H / 2 + 4, label: open ? '−' : String(hidden.size), action: 'rel:' + c.key, shape: 'diamond', gray: c.gray,
        title: '旁系亲属：' + rels.map(r => model.persons.get(r.other).name.replace(/[(（].*?[)）]/g, '') + '（' + (r.kind === 'cross' && r.dir === 'up' ? '长辈' : r.term) + '）').join('、') });
    });
  }

  // ---- 旁系关系连接线（v0.1 R30–R33）：只用亲子表推出；两人都在视图里、但共同长辈这条路没被画全时，才画 ⊓ 折线
  function kinLines(model, view) {
    const { H } = CFG;
    const cards = [], seen = new Set();
    view.cards.filter(c => !c.adoptedOut).concat(view.cards.filter(c => c.adoptedOut)).forEach(c => {
      if (String(c.key).startsWith('u:') || !model.persons.has(c.key) || seen.has(c.key)) return;
      seen.add(c.key); cards.push(c);
    });
    const present = new Set(cards.map(c => c.key));
    const gender = k => (model.persons.get(k) || {}).gender;
    const cache = new Map();
    const upAt = (x, d) => {                                   // 恰好往上 d 代的所有祖先；path = 第1代…第d代
      const ck = x + '#' + d;
      if (cache.has(ck)) return cache.get(ck);
      let cur = [{ node: x, path: [] }];
      for (let i = 0; i < d; i++) {
        const next = [];
        cur.forEach(c => (model.childrenByChild.get(c.node) || []).forEach(r => {
          [r.father, r.mother].forEach(pk => { if (pk && (model.persons.has(pk) || isVirtual(pk))) next.push({ node: pk, path: c.path.concat(pk) }); });   // 旁系关系表里的隐形共同长辈也算一代
        }));
        cur = next;
      }
      cache.set(ck, cur);
      return cur;
    };
    const parentSet = (x, f) => new Set((model.childrenByChild.get(x) || []).map(r => r[f]).filter(Boolean));
    const inter = (a, b) => [...a].some(v => b.has(v));
    const connect = (a, b) => {                                // 最近的共同祖先（最多到第 3 代）
      for (let d = 1; d <= 3; d++) {
        const A = upAt(a, d), B = upAt(b, d), conns = [];
        A.forEach(pa => B.forEach(pb => {
          if (pa.node !== pb.node) return;
          const mids = pa.path.slice(0, -1).concat(pb.path.slice(0, -1));
          conns.push({ d, anc: pa.node, mids, female: mids.some(m => gender(m) === 'F') });
        }));
        if (conns.length) return conns;
      }
      return null;
    };
    const rows = new Map();
    cards.forEach(c => { const r = Math.round(c.y); if (!rows.has(r)) rows.set(r, []); rows.get(r).push(c); });
    const groups = new Map();
    rows.forEach((cs, ry) => {
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i].key, b = cs[j].key, conns = connect(a, b);
        const tp = model.collateralPairs && model.collateralPairs.get(a + '|' + b);       // 旁系关系表里直接写的两人关系
        if (!conns && !tp) continue;
        if (conns && conns.some(c => (isVirtual(c.anc) || present.has(c.anc)) && c.mids.every(m => present.has(m)))) continue;   // 已经被亲子线（或兄弟括线）连通
        let c0 = null, kind, gk;
        if (tp) { kind = tp.kind; gk = ry + '|tbl|' + tp.rowId; c0 = { female: kind === 'biao' }; }
        else {
          conns.sort((x, y) => x.female - y.female);
          c0 = conns[0];
          kind = c0.d === 1 ? 'sib' : c0.d === 2 ? (c0.female ? 'biao' : 'tang') : 'zc';
          gk = ry + '|' + kind + '|' + c0.anc;
        }
        if (!groups.has(gk)) {
          let tag = '';
          if (kind === 'sib') {
            const fs = inter(parentSet(a, 'father'), parentSet(b, 'father')), ms = inter(parentSet(a, 'mother'), parentSet(b, 'mother'));
            if (fs && !ms && parentSet(a, 'mother').size && parentSet(b, 'mother').size) tag = '异母';
            else if (ms && !fs && parentSet(a, 'father').size && parentSet(b, 'father').size) tag = '异父';
          }
          groups.set(gk, { ry, kind, tag, female: c0.female, members: new Set() });
        }
        groups.get(gk).members.add(cs[i]); groups.get(gk).members.add(cs[j]);
      }
    });
    // 差一辈的旁系（如从子）：Π 折线，一脚短（接长辈）一脚长（落到下一行的晚辈）；横线在长辈这一行的上方
    const cardOf = new Map(cards.map(c => [c.key, c]));
    (model.crossList || []).forEach(x => {
      const ec = cardOf.get(x.elder), yc = cardOf.get(x.younger);
      if (!ec || !yc) return;
      groups.set('x|' + x.rowId + '|' + x.younger, { ry: Math.round(ec.y), kind: 'cross', term: x.term, members: new Set([ec, yc]) });
    });
    // 分层：同一行里横向范围重叠的线放在不同高度；每个人的竖脚错开，避免叠在一起
    const out = [], legUse = new Map(), byRow = new Map();
    groups.forEach(g => { if (!byRow.has(g.ry)) byRow.set(g.ry, []); byRow.get(g.ry).push(g); });
    byRow.forEach(list => {
      list.forEach(g => { g.ms = [...g.members].sort((p, q) => p.x - q.x); g.l = g.ms[0].x; g.r = g.ms[g.ms.length - 1].x; });
      list.sort((p, q) => (p.r - p.l) - (q.r - q.l));
      const levels = [];
      list.forEach(g => {
        let lv = 0;
        while (levels[lv] && levels[lv].some(o => !(g.r + 30 < o.l || g.l - 30 > o.r))) lv++;
        (levels[lv] = levels[lv] || []).push(g);
        g.lv = lv;
      });
      list.forEach(g => {
        if (g.kind === 'cross') {
          const legs = g.ms.map(c => { const n = legUse.get(c.key) || 0; legUse.set(c.key, n + 1); return c.x + 24 + 8 * n; });
          out.push({ kind: 'cross', dash: true, label: g.term, y: g.ry, yCard: g.ry - H / 2, legY: g.ms.map(c => c.y - H / 2),
            top: g.ry - H / 2 - 52 - 14 * g.lv, legs, x1: Math.min(...legs), x2: Math.max(...legs) });
          return;
        }
        const gs = g.ms.map(c => gender(c.key)), allM = gs.every(x => x === 'M'), allF = gs.every(x => x === 'F');
        const word = allM ? '兄弟' : allF ? '姐妹' : '兄弟姐妹';
        const prefix = g.kind === 'sib' ? g.tag : g.kind === 'tang' ? '堂' : g.kind === 'biao' ? '表' : g.kind === 'zu' ? '族' : (g.female ? '再从表' : '再从');
        const legs = g.ms.map(c => { const n = legUse.get(c.key) || 0; legUse.set(c.key, n + 1); return c.x + 24 + 8 * n; });
        out.push({ kind: g.kind, dash: g.kind !== 'sib', dot: g.kind === 'zu', label: prefix + word, y: g.ry, yCard: g.ry - H / 2,
          top: g.ry - H / 2 - 52 - 14 * g.lv, legs, x1: Math.min(...legs), x2: Math.max(...legs) });
      });
    });
    return out;
  }

  function layoutFamily(model, o, state) {
    const { focus, axis, solo, soloKey, coreKey } = o;
    const openOv = state.open, expSp = state.expSp, twin = state.twin || null, dupAdopt = state.dupAdopt || null;
    const mergeUnknown = state.mergeUnknown !== false;
    const warnings = [];
    const grayFlag = value => state.noGray ? false : !!value;
    const { W, H } = CFG;
    const virtualRow = !!solo && isVirtual(soloKey);        // 兄弟行（来自旁系关系表）：共同母亲不画
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
    const isOut = r => !!(dupAdopt && r && dupAdopt.has(r.child) && r.rel !== '过继入');   // 生父母名下那张
    function buildUnit(key, depth, frozen) {
      const csp = [], seen = new Set();
      model.spousesOf(key).forEach(x => {
        if (seen.has(x.key) || !model.persons.has(x.key)) return;      // 同一对夫妻在婚姻表里重复出现时只算一次
        seen.add(x.key);
        const link = !!twin && twin.has(x.key) && x.key !== key;                       // 对方本来就在画面里
        const exp = !frozen && (expSp.has(key + '|' + x.key) || (link && expSp.has(x.key + '|' + key)));   // 任意一方点开，双方都算展开；灰显那张不跟着变
        csp.push({ key: x.key, m: x.m, exp, link });
      });
      const expIdx = new Map();
      csp.forEach(x => { if (x.exp && !x.link) expIdx.set(x.key, expIdx.size); });
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
      csp.filter(x => x.exp && !x.link).forEach(x => {
        const rs = mar.get(x.key);
        if (rs && rs.length) groups.push({ gkey: key + '|' + x.key, kind: 'mar', idx: expIdx.get(x.key), count: rs.length,
          hasFocus: rs.some(r => r.child === focus),
          getRows: () => orderSiblings(rs, model, warnings) });
      });
      groups.forEach(g => {
        g.open = !frozen && depth < 8 && kidOpenSet.has(g.gkey);
        g.kids = g.open ? g.getRows().map(r => ({ row: r, unit: buildUnit(r.child, depth + 1, isOut(r)) })) : [];
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
        unit: (o.focalChild && r.child === o.focalChild && o.focalOwnView) ? null : buildUnit(r.child, 0, isOut(r))
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
    const cards = [], lines = [], pairLines = [], chips = [], icons = [], openMap = {}, links = [];
    const barOff = H / 2 + CFG.BRACKET;                 // 括线横杠相对卡片中心的下移量
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
    const emitUnit = (u, cx, y, gray, row) => {
      const out = !!(dupAdopt && row && dupAdopt.has(u.key) && row.rel !== '过继入');   // 本人出现两次，这是生父母名下的那一张
      gray = grayFlag(gray || out);
      const kx = cx + W / 2;
      cards.push(mkCard(u.key, kx, y, u.p, Object.assign({ role: 'child', gray }, out ? { adoptedOut: true, zi: '出继' + adoptiveName(model, u.key) } : {})));
      // R22–R25：联姻对象默认折叠成左上角小图标；点击展开，点婚姻线收回
      let ni = 0, ne = 0;
      u.csp.forEach(x => {
        const sp2 = model.persons.get(x.key);
        if (!sp2) return;
        if (!x.exp) {
          const st = styleOf(model, sp2);
          icons.push({ x: kx - W / 2 + 6 + ni * (CFG.ICON + 5), y: y - H / 2 + 2, shape: sp2.gender === 'M' ? 'square' : 'circle',
            fill: st.fill, size: CFG.ICON, title: sp2.name + (sp2.family && sp2.family !== '-' ? '（' + sp2.family + '）' : ''),
            action: 'expand:' + u.key + '|' + x.key, gray, out });
          ni++;
        } else if (x.link) {                                // 对方本来就在画面别处：不复制卡片，登记成长括线（画在最后，见 linkBrackets）
          const lk = [u.key, x.key].sort().join('|');
          if (!links.some(l => l.k === lk)) links.push({ k: lk, a: u.key, b: x.key, type: x.m.type });
        } else {
          const px = kx + ne * PW, sx = kx + (ne + 1) * PW, barK = y + barOff;
          lines.push({ kind: 'child', x1: px, y1: y + H / 2, x2: px, y2: barK, gray });
          lines.push({ kind: 'child', x1: sx, y1: y + H / 2, x2: sx, y2: barK, gray });
          pairLines.push({ x1: px, y1: barK, x2: sx, y2: barK, style: x.m.type === '妾' ? 'thin' : 'thick', action: 'collapse:' + u.key + '|' + x.key, gray });
          cards.push(mkCard(x.key, sx, y, sp2, { role: 'childSpouse', gray }));
          ne++;
        }
      });
      // 2.2：子女标记。已展开配偶 → 标记在婚姻线下方；其余子女 → 标记在本人卡片下方
      const yN = y + CFG.ROW_GAP, busN = yN - H / 2 - CFG.BUS_OFF;
      u.groups.forEach(g => {
        const ax = g.kind === 'rest' ? kx : kx + g.idx * PW + PW / 2;
        const ay = g.kind === 'rest' ? y + H / 2 : y + barOff;
        const sibN = g.count - (g.hasFocus ? 1 : 0);
        chips.push({ x: ax, y: g.kind === 'rest' ? y + H / 2 + 26 + (ne > 0 ? CFG.BRACKET + 4 : 0) : y + barOff + 22, label: g.open ? '−' : (sibN > 0 ? '+' + sibN : '+'), action: 'kids:' + g.gkey, gray, out });
        if (!g.open) return;
        let left = cx + g.left;
        const placed = g.kids.map(kd => { const p = { kd, left, x: left + W / 2 }; left += kd.unit.w + CFG.CHILD_GAP; return p; });
        const xs = placed.map(p => p.x);
        lines.push({ kind: 'child', x1: ax, y1: ay, x2: ax, y2: busN, gray });
        lines.push({ kind: 'child', x1: Math.min(ax, ...xs), y1: busN, x2: Math.max(ax, ...xs), y2: busN, gray });
        placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busN, x2: p.x, y2: yN - H / 2, double: p.kd.row.rel === '过继入', gray });
          emitUnit(p.kd.unit, p.left, yN, gray, p.kd.row);
        });
      });
    };
    if (!solo) cards.push(mkCard(axis, 0, y0, model.persons.get(axis), { role: 'axis' }));

    allSp.forEach(s => {
      if (isVirtual(s.key)) { openMap[s.key] = s.open; return; }
      const p = s.placeholder ? { name: s.name, zi: '', gender: 'F', family: '-' } : model.persons.get(s.key);
      const gray = !!coreKey && s.key !== coreKey;
      cards.push(mkCard(s.key, s.x, y0, p, { role: 'spouse', gray, clickable: !s.placeholder, selected: s.key === focus }));
      openMap[s.key] = s.open;
    });

    // 婚姻括线：沿这一行依次连接。每张卡片底部有一条细竖脚，竖脚下面是横杠（正妻粗、其他细）
    if (!solo) {
      const barY = y0 + barOff;
      const leg = (x, gray) => lines.push({ kind: 'child', x1: x, y1: y0 + H / 2, x2: x, y2: barY, gray: grayFlag(gray) });
      leg(0, false);
      if (leftSp) {
        const g = !!coreKey && leftSp.key !== coreKey;
        leg(leftSp.x, g);
        lines.push({ kind: 'marry', style: 'thick', x1: leftSp.x, y1: barY, x2: 0, y2: barY, gray: grayFlag(g) });
      }
      let px = 0;
      rightList.forEach(s => {
        const g = !!coreKey && s.key !== coreKey;
        leg(s.x, g);
        lines.push({ kind: 'marry', style: s.kind === 'other' ? 'thin' : 'thick', x1: px, y1: barY, x2: s.x, y2: barY, gray: grayFlag(g) });
        px = s.x;
      });
    }

    const busY = y1 - H / 2 - CFG.BUS_OFF;
    const focusComp = virtualRow ? ((model.childrenByChild.get(focus) || []).find(r => r.virtual) || {}).fullComp : null;
    const halfGray = k => !!focusComp && !!k.row.virtual && k.row.fullComp !== focusComp;   // 异母兄弟姐妹：整体灰显
    allSp.forEach(s => {
      if (!s.kids.length) return;
      const gray = !!coreKey && s.key !== coreKey;
      // R13：妾室等的子女默认折叠，卡片下方紧贴一个小圆点
      if (s.kind === 'other' && !s.solo) {
        const n = s.kids.length - (s.kids.some(k => k.row.child === focus) ? 1 : 0);
        chips.push({ x: s.x, y: y0 + barOff + 22, label: s.open ? '−' : (n > 0 ? '+' + n : '+'), action: 'toggle:' + s.key });
      }
      if (!s.open) return;
      const startY = s.dropAtMid ? y0 + barOff : y0 + H / 2;
      const xs = s.kids.map(k => k.x);
      if (!virtualRow) lines.push({ kind: 'child', x1: s.dropX, y1: startY, x2: s.dropX, y2: busY, gray });   // 兄弟行：顶上不留向上的短竖线
      lines.push({ kind: 'child', x1: Math.min(...(virtualRow ? [] : [s.dropX]), ...xs), y1: busY, x2: Math.max(...(virtualRow ? [] : [s.dropX]), ...xs), y2: busY, gray });
      s.kids.forEach(k => {
        lines.push({ kind: 'child', x1: k.x, y1: busY, x2: k.x, y2: y1 - H / 2, double: k.row.rel === '过继入', gray: grayFlag(gray || halfGray(k)) });
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
          (sub.links || []).forEach(l => { if (!links.some(z => z.k === l.k)) links.push(l); });
          for (const kk in sub.openMap) if (!(kk in openMap)) openMap[kk] = sub.openMap[kk];   // 本人这一段的妾室开合状态也要带上，否则点"−"收不回去
          return;
        }

        emitUnit(k.unit, k.left, y1, gray || halfGray(k), k.row);
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
        if (isVirtual(up.axis)) {                      // 没有父母记录、但在旁系关系表里有亲兄弟姐妹：只展开这些兄弟姐妹，不画祖辈卡
          const seenV = new Set([key]);
          const sibV = (model.childrenByMother.get(up.axis) || []).filter(c => !seenV.has(c.child) && seenV.add(c.child));
          return sibV.length ? { f: null, m: null, virtual: true, sibRows: sibV, adopted: false } : null;
        }
        if (isVirtual(up.coreKey)) return null;
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
        const widthOf = us => us.reduce((a, u) => a + u.unit.w, 0) + Math.max(0, us.length - 1) * CFG.CHILD_GAP;
        const lay = (us, left0) => { let left = left0; return us.map(u => { const p = { u, left, x: left + W / 2 }; left += u.unit.w + CFG.CHILD_GAP; return p; }); };
        let placed;
        if (info.virtual) {
          // 旁系关系表的兄弟姐妹：保持"左长右幼"——比他年长的排在整个视图的左外侧，比他年幼的排在右外侧
          const myRow = (model.childrenByChild.get(t.key) || []).find(r => r.virtual);
          const byIdx = info.sibRows.slice().sort((a, b) => a.idx - b.idx).map(r => ({ row: r, unit: buildUnit(r.child, 0, isOut(r)) }));
          const elder = byIdx.filter(u => myRow && u.row.idx < myRow.idx), younger = byIdx.filter(u => !(myRow && u.row.idx < myRow.idx));
          placed = lay(elder, xMinC - 2 * CFG.MARGIN - widthOf(elder)).concat(lay(younger, xMaxC + 2 * CFG.MARGIN));
        } else {
          const units = orderSiblings(info.sibRows, model, warnings).map(r => ({ row: r, unit: buildUnit(r.child, 0, isOut(r)) }));
          placed = lay(units, side === 'R' ? xMaxC + 2 * CFG.MARGIN : xMinC - 2 * CFG.MARGIN - widthOf(units));
        }
        if (placed.length) {                             // 记下已占用的范围，避免父、母两边的兄弟姐妹互相压住
          xMinC = Math.min(xMinC, ...placed.map(p => p.left));
          xMaxC = Math.max(xMaxC, ...placed.map(p => p.left + p.u.unit.w));
        }
        const xs = [t.x].concat(placed.map(p => p.x));
        blocks.push({ t, info, placed, xs, c: (Math.min(...xs) + Math.max(...xs)) / 2, hw: (info.f && info.m) ? pitch / 2 + W / 2 : W / 2 });
      });
      const realBlocks = blocks.filter(b => !b.info.virtual);
      if (realBlocks.length === 2) {                   // 两侧的祖辈卡不能挤在一起（兄弟行没有祖辈卡，不参与）
        realBlocks.sort((a, b) => a.c - b.c);
        const need = (realBlocks[0].c + realBlocks[0].hw) + CFG.MARGIN - (realBlocks[1].c - realBlocks[1].hw);
        if (need > 0) { realBlocks[0].c -= need / 2; realBlocks[1].c += need / 2; }
      }
      blocks.forEach(b => {
        const yA = -CFG.ROW_GAP, busA = 0 - H / 2 - CFG.BUS_OFF, both = !!(b.info.f && b.info.m);
        const put = (key, x) => cards.push(mkCard(key, x, yA, model.persons.get(key), { role: 'ancestor', gray: true }));
        if (b.info.virtual) {                          // 兄弟行：只有一条横括线把他和兄弟姐妹连起来，顶上不留向上的短竖线
          lines.push({ kind: 'child', x1: Math.min(...b.xs), y1: busA, x2: Math.max(...b.xs), y2: busA, gray: grayFlag(true) });
          lines.push({ kind: 'child', x1: b.t.x, y1: busA, x2: b.t.x, y2: 0 - H / 2, gray: grayFlag(true) });
          b.placed.forEach(p => {
            lines.push({ kind: 'child', x1: p.x, y1: busA, x2: p.x, y2: 0 - H / 2, gray: grayFlag(true) });
            emitUnit(p.u.unit, p.left, 0, true, p.u.row);
          });
          return;
        }
        if (both) {
          const mx = b.c - pitch / 2, fx = b.c + pitch / 2;
          put(b.info.m, mx); put(b.info.f, fx);
          const mar = (model.marriagesByHusband.get(b.info.f) || []).find(x => x.w === b.info.m);
          const barA = yA + barOff;
          lines.push({ kind: 'child', x1: mx, y1: yA + H / 2, x2: mx, y2: barA, gray: grayFlag(true) });
          lines.push({ kind: 'child', x1: fx, y1: yA + H / 2, x2: fx, y2: barA, gray: grayFlag(true) });
          lines.push({ kind: 'marry', style: mar && mar.type === '妾' ? 'thin' : 'thick', x1: mx, y1: barA, x2: fx, y2: barA, gray: grayFlag(true) });
        } else put(b.info.f || b.info.m, b.c);
        lines.push({ kind: 'child', x1: b.c, y1: both ? yA + barOff : yA + H / 2, x2: b.c, y2: busA, gray: grayFlag(true) });
        const all = b.xs.concat([b.c]);
        lines.push({ kind: 'child', x1: Math.min(...all), y1: busA, x2: Math.max(...all), y2: busA, gray: grayFlag(true) });
        lines.push({ kind: 'child', x1: b.t.x, y1: busA, x2: b.t.x, y2: 0 - H / 2, double: b.info.adopted, gray: grayFlag(true) });
        b.placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busA, x2: p.x, y2: 0 - H / 2, double: p.u.row.rel === '过继入', gray: grayFlag(true) });
          emitUnit(p.u.unit, p.left, 0, true, p.u.row);
        });
      });
    }

    if (virtualRow) {                                  // 共同母亲那一行是空的：整体上移一行，让兄弟行成为第一行
      const sh = -y1;
      cards.forEach(c => { c.y += sh; });
      lines.forEach(l => { l.y1 += sh; l.y2 += sh; });
      pairLines.forEach(l => { l.y1 += sh; l.y2 += sh; });
      chips.forEach(c => { c.y += sh; });
      icons.forEach(i => { i.y += sh; });
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
      focus, axis, coreKey, solo, virtual: virtualRow, up: !!o.up, notes: o.notes || [], cards, lines, pairLines, chips, icons, openMap, warnings, links,
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

  const api = { CFG, kinLines, buildModel, buildView, defaultState, searchPersons, orderSiblings, resolveParents, hasParents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
