/* core.js —— 数据模型 + 布局引擎（不依赖 DOM，可在 Node 里测试）
 * 对应需求文档 v0.1：R01–R03 R07–R14 R16 R19(双竖线) R22–R25 D1 D6 D7
 */
(function (root) {
  'use strict';

  const CFG = {
    W: 136, H: 56,          // 卡片尺寸
    PITCH_GAP: 28,          // 同一行相邻卡片的最小间隙（婚姻线可见的长度）
    CHILD_GAP: 22,          // 子女卡片之间的间隙
    PAIR_GAP: 34, KID_OFFSET: 40,           // 子女与其联姻对象卡片之间的间隙
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
  // ---- v2.1 世代对齐：每个"支"（沿父亲 / 无父亲时沿母亲一路上溯到的最早一位）内部的辈分由亲子关系决定；
  // "世代对齐表"里同一行的人视为同一世代，据此算出不同支之间相差几代（带偏移的并查集）。互相矛盾的行不采用，记在 conflicts 里。
  function computeGenerations(model, aligns) {
    const parentOf = new Map();
    model.childrenByChild.forEach((rows, k) => {
      const r = rows.find(x => x.rel === '过继入') || rows[0];
      const pk = r && (r.father || r.mother);
      if (pk) parentOf.set(k, pk);
    });
    const rootDepth = k => { let d = 0; const seen = new Set(); while (parentOf.has(k) && !seen.has(k)) { seen.add(k); k = parentOf.get(k); d++; } return { root: k, depth: d }; };
    const dsu = new Map();                                   // 支 → { p: 上一级, d: o(本支) − o(上一级) }
    const find = t => { let d = 0; while (dsu.has(t) && dsu.get(t).p !== t) { d += dsu.get(t).d; t = dsu.get(t).p; } return { r: t, d }; };
    const conflicts = [];
    (aligns || []).forEach(a => {
      const ms = a.members.map(m => m.id).filter(id => model.persons.has(id));
      for (let i = 0; i + 1 < ms.length; i++) {
        const A = rootDepth(ms[i]), B = rootDepth(ms[i + 1]);
        const nm = k => model.persons.get(k).name.replace(/[(（].*?[)）]/g, '');
        if (A.root === B.root) {
          if (A.depth !== B.depth) conflicts.push(`世代对齐 ${a.id}：${nm(ms[i])} 和 ${nm(ms[i + 1])} 在同一支里，辈分由亲子关系决定，不能手动指定`);
          continue;
        }
        const fa = find(A.root), fb = find(B.root), need = (B.depth - A.depth) - fa.d + fb.d;
        if (fa.r === fb.r) { if (need !== 0) conflicts.push(`世代对齐 ${a.id}：与前面的行互相矛盾（${nm(ms[i])} 与 ${nm(ms[i + 1])}）`); }
        else dsu.set(fa.r, { p: fb.r, d: need });
      }
    });
    // of(k) → { comp: 同一组可以互相比较的支, gen: 在这一组里的世代号（越大越晚）}；没有亲子 / 对齐信息的人也有（自己一支）
    const of = k => { if (!k || !model.persons.has(k)) return null; const rd = rootDepth(k), f = find(rd.root); return { comp: f.r, gen: rd.depth + f.d, tree: rd.root }; };
    return { of, conflicts };
  }

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
          // 行内顺序＝左长右幼：i 在 j 前面，所以对 a 来说 b 是弟妹（younger），对 b 来说 a 是兄姐（elder）；seq＝行内位置，给多个人排序用
          push(collateralOf, a, Object.assign({ other: b, ord: 'younger', seq: j }, info)); push(collateralOf, b, Object.assign({ other: a, ord: 'elder', seq: i }, info));
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
    model.gen = computeGenerations(model, raw.alignments || []);
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
    return { open: new Map(), expSp: new Set(), kidOpen: new Set(), kidShut: new Set(), blockSide: new Map(), upOpen: new Set(), blocks: new Set(), relOpen: new Set(), mergeUnknown: true, noGray: false };
  }

  // R17：选中人物的"父母与兄弟姐妹"视图需要先找到他的父母
  // v2.4：同一行相邻单元（人物 + 联姻对象 + 下一代）怎么错开——
  //   · 第一行（人物卡片本身）只需要留正常间距；下一代展开后多出来的部分（溢出）可以伸到邻居上方的空位里，不必让邻居整个躲开；
  //   · 但也不能挨太近：留白随溢出的多少增加（溢出的 0.6 倍，最多 1.2 个卡片宽），下一代展开得越宽，两边让出的空白越大；
  //   · 相邻两个单元的下一代都展开时，按各自下一代的左右边界保证不重叠。
  // items：[{rowW, has, lo, hi}]，lo/hi 是该单元"下一代及以下"相对于它自己左边缘的左右边界；返回每个单元的左边缘与整行范围
  const comfortGap = ov => Math.min(ov * 0.6, CFG.W * 1.2);
  const rowLayout = items => {
    const G = CFG.CHILD_GAP, M = CFG.MARGIN, lefts = [];
    let runHi = -Infinity;
    items.forEach((it, i) => {
      let left = 0;
      if (i > 0) {
        const pv = items[i - 1];
        const oR = pv.has ? Math.max(0, pv.hi - pv.rowW) : 0, oL = it.has ? Math.max(0, -it.lo) : 0;
        left = lefts[i - 1] + pv.rowW + G + comfortGap(oR) + comfortGap(oL);
        if (it.has && runHi > -Infinity) left = Math.max(left, runHi + M - it.lo);
      }
      lefts.push(left);
      if (it.has) runHi = Math.max(runHi, left + it.hi);
    });
    const last = items.length - 1, span = last >= 0 ? lefts[last] + items[last].rowW : 0;
    let lo = 0, hi = span;
    items.forEach((it, i) => { if (it.has) { lo = Math.min(lo, lefts[i] + it.lo); hi = Math.max(hi, lefts[i] + it.hi); } });
    return { lefts, span, lo, hi };
  };
  // ============ 家庭单元（Family Unit）：全系统唯一一处回答"这几个孩子是不是同母所生" ============
  // 一位父亲名下的孩子，按"母亲组"分好。组的键：真实的母亲＝她的 key；记为"不详/庶母"的＝'u:不详' / 'u:庶母'。
  // 策略 model.mergeUnknown（"归并生母不详"）：开着时，父亲有正妻（没有则第一位继室）的话，生母"不详"的孩子并进她那一组。
  // 子女分组、buildUnit、往上展开的兄弟姐妹/同父异母、母亲的+N、选中人物的母亲判断，全部从这里取，不再各算各的。
  const mergeTargetOf = (model, f) => {
    const ms = (model.marriagesByHusband.get(f) || []).map(m => ({ key: m.w, type: m.type, order: m.order, idx: m.idx }));
    const pick = t => ms.filter(x => x.type === t).sort(cmpOrder)[0];
    const t = pick('妻') || pick('继室');
    return t ? t.key : null;
  };
  const unitCache = new WeakMap();                       // model（按策略分开的那一份）→ Map(父亲 → 家庭单元)
  function familyUnits(model, f) {
    let byF = unitCache.get(model);
    if (!byF) unitCache.set(model, byF = new Map());
    let u = byF.get(f);
    if (u) return u;
    const mt = model.mergeUnknown !== false ? mergeTargetOf(model, f) : null;
    const keyOf = c => c.mother || ((mt && c.motherLabel === '不详') ? mt : (c.motherLabel ? 'u:' + c.motherLabel : null));
    const groups = new Map();
    (model.childrenByFather.get(f) || []).forEach(c => { const k = keyOf(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    u = { father: f, mergeTarget: mt, keyOf, groups, rowsOf: k => groups.get(k) || [] };
    byF.set(f, u);
    return u;
  }
  const isUnknownGroup = k => typeof k === 'string' && k.startsWith('u:');
  // 这一行亲子记录的"有效母亲"（真实的人）；母亲组是"不详/庶母"时为 null
  const effMother = (model, c) => {
    if (!c.father) return c.mother;
    const k = familyUnits(model, c.father).keyOf(c);
    return isUnknownGroup(k) ? null : k;
  };
  // 某组子女在"+N"小圆点上显示的数字：整组人数，去掉选中人物自己（他已经在画面上）
  const kidCount = (rows, focus) => rows.length - (rows.some(r => r.child === focus) ? 1 : 0);
  // 策略（归并生母不详）绑在一份只读的 model 副本上，而不是写进共享的 model：同一份数据、不同策略各一份，互不影响
  const policyModels = new WeakMap();
  const withPolicy = (model, mergeUnknown) => {
    let m = policyModels.get(model);
    if (!m) policyModels.set(model, m = {});
    return m[mergeUnknown] || (m[mergeUnknown] = Object.assign(Object.create(model), { mergeUnknown }));
  };

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
    if (r.father) return { axis: r.father, solo: false, coreKey: effMother(model, r) || ('u:' + r.motherLabel + ':' + r.father), notes };
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

  // ============ 状态分层 ============
  // 意图（state，用户点出来的，可存可恢复）：open / expSp / kidOpen / kidShut / upOpen / blocks / relOpen / blockSide / mergeUnknown / noGray。
  //   排版代码只读它，从不改它。blockSide 是"块放左还是右"：第一次决定后由界面记下来（Core.commitPins），块收起时清掉。
  // 派生（dv，排版时由意图 + 数据算出来的，不存、可随时重算）：
  //   away 被搬回自己家族行的配偶；moveAxis 被搬走的丈夫；autoKids 默认展开的子女组；awaySide 搬走的人的块在哪一侧；
  //   twin 已在画面里的人（对方是联姻对象时只画长括线）；dupAdopt 过继造成的重复卡；groupShift 子女排相对本人的偏移（第二遍排版用）；
  //   expSp 派生时临时覆盖的"展开的联姻对象"；focusKey 当前选中的人。
  const EMPTY_DV = Object.freeze({ away: new Set(), moveAxis: null, autoKids: new Set(), awaySide: new Map(), twin: null, dupAdopt: null,
    groupShift: new Map(), expSp: null, focusKey: null });

  // R29：父母、兄弟姐妹（R17）与本人配偶、子女合并成一张图——
  // 先单独算出"本人这一段"（跟原来一样），再把它整体嵌进"父母与兄弟姐妹"视图里选中人物所在的位置
  function buildViewBase(model, focus, state, extra) {
    const P = model.persons.get(focus);
    if (!P) return null;
    state = state || defaultState();
    const groupShift = (extra && extra.groupShift) || new Map();
    const { W, H } = CFG;
    const upF = resolveParents(model, focus), ownO = ownOpts(model, focus);
    const stubOf = key => ({ cards: [plainCard(model, key, 0, 0, { role: 'child', selected: key === focus })], lines: [], pairLines: [], chips: [], icons: [], links: [], openMap: {},
      bounds: { minX: -W / 2, maxX: W / 2, minY: -H / 2, maxY: H / 2 } });
    const run = dv => {
      const up = resolveParents(model, focus);
      // 选中的是妻子、而她丈夫被双击展开了家族：丈夫搬进自己家族的兄弟姐妹行里，这里只剩她自己一张卡
      const own = (up && dv.moveAxis && dv.moveAxis === ownO.axis && ownO.coreKey === focus) ? stubOf(focus)
        : layoutFamily(model, Object.assign(ownOpts(model, focus), { final: !up }), state, dv);
      if (!up) return own;                           // 没有父母记录（如杨艳）：退回只显示本人这一段
      return layoutFamily(model, {
        focus, axis: up.axis, solo: up.solo, soloKey: up.soloKey, coreKey: up.coreKey,
        allOpen: true, up: true, final: true, notes: up.notes, focalChild: focus, focalOwnView: own
      }, state, dv);
    };
    // ---- 派生 1：第 1 遍不展开任何联姻对象，看看哪些人本来就在画面里 ----
    const probe = run(Object.assign({}, EMPTY_DV, { expSp: new Set(), groupShift }));
    const probeKeys = new Set(probe.cards.map(c => c.key));
    // v2.0：双击展开的其他家族——每个家族是一整块（父母 + 兄弟姐妹，按\"选中此人\"的标准），整块放在主视图的左边或右边，家族之间不穿插
    const blockKeys = [...(state.blocks || [])].filter(k => { const up = model.persons.has(k) && resolveParents(model, k); return up && !probeKeys.has(up.axis); });
    // v2.2：被展开家族的人如果本来是主视图里的配偶（选中人物的妻子/丈夫、父亲的其他妻子……），不再贴着丈夫/妻子——
    //   \"完整显示一个家族、按长幼显示兄弟姐妹\"优先于\"按顺序显示联姻对象\"：她/他回到自己家族的兄弟姐妹行里，婚姻用长括线连回来
    const roles = new Map();
    probe.cards.forEach(c => { if (!roles.has(c.key)) roles.set(c.key, new Set()); roles.get(c.key).add(c.role); });
    let moveAxis = null; const away = new Set();
    blockKeys.forEach(k => {
      const r = roles.get(k);
      if (!r) return;
      if (upF && !ownO.solo && ownO.coreKey === focus && ownO.axis === k && r.has('axis')) moveAxis = k;
      else if (r.has('spouse') && !r.has('axis') && !r.has('child')) away.add(k);
    });
    const autoKids = new Set(); if (moveAxis) autoKids.add(moveAxis + '|*');
    // 搬走的人的家族块放在左边还是右边：已经记在意图里（blockSide）的照记的；否则看他/她的配偶在主视图的哪一半，孩子的偏移方向也跟着定
    const pinned = k => (state.blockSide && state.blockSide.get(k)) || null;
    const awaySide = new Map();
    const centerP = (probe.bounds.minX + probe.bounds.maxX) / 2;
    [...away, ...(moveAxis ? [moveAxis] : [])].forEach(k => {
      const sps = [].concat((model.marriagesByHusband.get(k) || []).map(m => m.w), (model.marriagesByWife.get(k) || []).map(m => m.h));
      const pc = probe.cards.find(c => sps.includes(c.key));
      awaySide.set(k, pinned(k) || (pc && pc.x < centerP ? 'L' : 'R'));
    });
    const base = Object.assign({}, EMPTY_DV, { away, moveAxis, autoKids, awaySide, groupShift, focusKey: focus });
    // ---- 派生 2：块里的人 → twin（已在画面里的人，对方是联姻对象时只画长括线）----
    const bp = new Set();
    blockKeys.forEach(k => { const sv = blockLayout(model, k, state, Object.assign({}, base, { expSp: new Set(), twin: probeKeys })); if (sv) sv.cards.forEach(c => bp.add(c.key)); });
    const twin = new Set([...probeKeys, ...bp]);
    const cnt = new Map();
    probe.cards.forEach(c => cnt.set(c.key, (cnt.get(c.key) || 0) + 1));
    const dupAdopt = new Set([...cnt].filter(([k, n]) => n >= 2 && (model.childrenByChild.get(k) || []).some(r => r.rel === '过继入')).map(([k]) => k));
    // ---- 排版：主视图 → 并块 ----
    const main = run(Object.assign({}, base, { twin, dupAdopt }));
    const views = blockKeys.map(k => ({ X: k, S: blockLayout(model, k, state, Object.assign({}, base, { twin })), side: pinned(k) || awaySide.get(k) })).filter(b => b.S);
    if (model.gen && model.gen.conflicts.length) model.gen.conflicts.forEach(t => { if (!main.warnings.includes(t)) main.warnings.push(t); });
    // 旁系：每个区域各排各的（主视图先、各块在后），一个人只在第一个出现他的区域里处理
    const regions = [main].concat(views.map(v => v.S));
    const present = new Set(), owner = new Map();
    regions.forEach((r, i) => r.cards.forEach(c => { present.add(c.key); if (!owner.has(c.key)) owner.set(c.key, i); }));
    regions.forEach((r, i) => relMarkers(model, r, state, { focus, present, groupShift,
      foreign: new Set([...owner].filter(([, j]) => j !== i).map(([k]) => k)) }));
    return composeBlocks(model, main, views);
  }

  // 一个人的"家族块"：他的父母（含父亲的其他妻子，灰显）和兄弟姐妹（含同父异母，灰显），他自己的卡片放在兄弟姐妹里按长幼的位置上；他的配偶、子女不在这一块里
  function plainCard(model, key, x, y, extra) {
    const p = model.persons.get(key), st = styleOf(model, p);
    return Object.assign({ key, x, y, w: CFG.W, h: CFG.H, name: p.name, zi: p.zi || '', gender: p.gender, fill: st.fill, text: st.text,
      family: p.family, selected: false, gray: false, clickable: true }, extra || {});
  }
  function blockLayout(model, X, state, dv) {
    const up = resolveParents(model, X);
    if (!up) return null;
    const { W, H } = CFG;
    let stub = { cards: [plainCard(model, X, 0, 0, { role: 'child', blockOf: X })], lines: [], pairLines: [], chips: [], icons: [], links: [], openMap: {},
      bounds: { minX: -W / 2, maxX: W / 2, minY: -H / 2, maxY: H / 2 } };
    if (dv.moveAxis === X) {                       // 搬进来的丈夫：带着他的子女（统一挂在他正下方）和其他妻子的小图标；和选中的妻子之间是长括线
      const wives = model.spousesOf(X).map(x => x.key).filter(k => dv.twin && dv.twin.has(k));
      const dvU = Object.assign({}, dv, { expSp: new Set(wives.map(k => X + '|' + k)) });
      const sv = layoutFamily(model, { focus: dv.focusKey || X, axis: X, solo: false, soloKey: X, coreKey: null, allOpen: false, up: false, notes: [], unitOnly: X, unitGray: false }, state, dvU);
      if (sv.cards.length) { sv.cards[0].blockOf = X; sv.cards[0].role = 'child'; stub = sv; }
    }
    return layoutFamily(model, { focus: X, axis: up.axis, solo: up.solo, soloKey: up.soloKey, coreKey: up.coreKey, allOpen: true, up: true, notes: [],
      focalChild: X, focalOwnView: stub }, state, dv);
  }
  // ============ 统一的连线通道（路由）基础 ============
  // 所有\"找一条空的竖直通道\"\"同一行里横线分高度\"的逻辑都走下面两个函数，不再各写各的。
  // pickLane：blocked 是已经加好边距的被占用区间 [[lo,hi],…]，返回离 target 最近、不在任何区间里的 x
  const pickLane = (blocked, target) => {
    if (!blocked.length) return target;
    const iv = blocked.slice().sort((p, q) => p[0] - q[0]), m = [];
    iv.forEach(v => { if (m.length && v[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], v[1]); else m.push(v.slice()); });
    const cands = [m[0][0] - 12, m[m.length - 1][1] + 12];
    for (let k = 0; k + 1 < m.length; k++) if (m[k + 1][0] - m[k][1] >= 6) cands.push((m[k][1] + m[k + 1][0]) / 2);
    if (!m.some(v => target >= v[0] && target <= v[1])) cands.push(target);
    return cands.sort((p, q) => Math.abs(p - target) - Math.abs(q - target))[0];
  };
  const cardBlocks = cards => cards.map(c => [c.x - CFG.W / 2 - 10, c.x + CFG.W / 2 + 10]);
  // assignLevels：同一行里横向范围（加 margin）重叠的线放在不同高度；先排短的（原地排序），返回用了几层
  const assignLevels = (list, loOf, hiOf, margin) => {
    list.sort((p, q) => (hiOf(p) - loOf(p)) - (hiOf(q) - loOf(q)));
    const levels = [];
    list.forEach(it => {
      let lv = 0;
      while (levels[lv] && levels[lv].some(o => !(hiOf(it) + margin < loOf(o) || loOf(it) - margin > hiOf(o)))) lv++;
      (levels[lv] = levels[lv] || []).push(it);
      it.lv = lv;
    });
    return levels.length;
  };
  function freeLane(cards, lo, hi, target) {
    return pickLane(cardBlocks(cards.filter(c => c.y + CFG.H / 2 > lo + 0.5 && c.y - CFG.H / 2 < hi - 0.5)), target);
  }
  // 把家族块并到主视图旁边。行：按"块里的人和主视图里的人的婚姻"投票，让尽量多的联姻对象同辈（平票时取最靠近选中人物所在行的）；左右：放在被双击人物的丈夫/妻子更近的那一侧
  function composeBlocks(model, P, list) {
    P.sidesDecided = new Map();
    const { W, H } = CFG, GAP = 3 * CFG.MARGIN;
    const hasRef = X => { const g = model.gen && model.gen.of(X); return !!g && P.cards.some(c => { if (c.key === X) return false; const gc = model.gen.of(c.key); return gc && gc.comp === g.comp; }); };
    // 逐个并块，每并完一个再选下一个：先并"同一组世代里已经有人在画面上"的块，这样后面的块可以参照前面并进去的人
    const queue = list.slice();
    const takeNext = () => { let i = queue.findIndex(b => hasRef(b.X)); if (i < 0) i = 0; return queue.splice(i, 1)[0]; };
    while (queue.length) {
      const { X, S, side: forcedSide } = takeNext();
      const xc = S.cards.find(c => c.key === X && c.blockOf === X);
      if (!xc) continue;
      const byKey = new Map(); P.cards.forEach(c => { if (!byKey.has(c.key)) byKey.set(c.key, c); });
      const inMain = byKey.get(X) || null;                  // 他本人已经在主视图里了：不再复制他的卡片
      const spousesOf = k => [].concat((model.marriagesByHusband.get(k) || []).map(m => m.w), (model.marriagesByWife.get(k) || []).map(m => m.h));
      const yFocus = (byKey.get(P.focus) || { y: 0 }).y;
      const votes = new Map();
      S.cards.forEach(sc => { spousesOf(sc.key).forEach(sp => { const pc = byKey.get(sp); if (pc) { const dy = pc.y - sc.y; votes.set(dy, (votes.get(dy) || 0) + 1); } }); });
      let dy = yFocus - xc.y;
      if (votes.size) dy = [...votes].sort((a, b) => b[1] - a[1] || Math.abs(xc.y + a[0] - yFocus) - Math.abs(xc.y + b[0] - yFocus))[0][0];
      const gx = model.gen && model.gen.of(X);                // v2.1：世代对齐优先于婚姻投票
      if (gx) {
        const focusTree = (model.gen.of(P.focus) || {}).tree;
        let best = null, bs = -1;
        P.cards.forEach(c => {
          if (c.key === X) return;                              // 不能拿他自己当参照
          const gc = model.gen.of(c.key);
          if (!gc || gc.comp !== gx.comp) return;
          const sc = (gc.tree === focusTree ? 2 : 0) + (c.role === 'childSpouse' || c.role === 'relative' ? 0 : 1) + (c.gray ? 0 : 0.5);
          if (sc > bs) { bs = sc; best = { c, gc }; }
        });
        if (best) dy = best.c.y + (gx.gen - best.gc.gen) * CFG.ROW_GAP - xc.y;
      }
      let routed = false;
      if (inMain) {                                           // 他的兄弟姐妹默认排在他自己所在的这一行；世代对齐对不上这一行时，以世代对齐为准，再用折线连到他身上
        const same = inMain.y - xc.y;
        if (gx && Math.abs(dy - same) > 1 && P.cards.some(c => { if (c.key === X) return false; const gc = model.gen.of(c.key); return gc && gc.comp === gx.comp; })) routed = true; else dy = same;
      }
      const partner = inMain || spousesOf(X).map(k => byKey.get(k)).find(Boolean);
      const center = (P.bounds.minX + P.bounds.maxX) / 2;
      const left = forcedSide ? forcedSide === 'L' : (!!partner && partner.x < center);
      P.sidesDecided.set(X, left ? 'L' : 'R');            // 这一块最终放在哪一侧：由界面记进意图（commitPins），之后不再随画面变化而翻边
      // 并块按"每一行的轮廓"：块只需要让开自己所在各行里主视图已有的卡片（再留 GAP），不必让到整个画面的最外面；
      // 两边没有共同的行时，才退回按整体范围放。
      const rowOf = y => Math.round(y);
      const ext = (cards, dyy) => { const m = new Map(); cards.forEach(c => { const k = rowOf(c.y + dyy), e = m.get(k) || [Infinity, -Infinity]; e[0] = Math.min(e[0], c.x - W / 2); e[1] = Math.max(e[1], c.x + W / 2); m.set(k, e); }); return m; };
      const exP = ext(P.cards, 0), exS = ext(inMain ? S.cards.filter(c => c !== xc) : S.cards, dy);
      let dx = null;
      exS.forEach((e, k) => {
        const p = exP.get(k); if (!p) return;
        const need = left ? p[0] - GAP - e[1] : p[1] + GAP - e[0];
        dx = dx === null ? need : (left ? Math.min(dx, need) : Math.max(dx, need));
      });
      if (dx === null) dx = left ? P.bounds.minX - GAP - S.bounds.maxX : P.bounds.maxX + GAP - S.bounds.minX;
      const mv = (arr, target, keys) => arr.forEach(e => target.push(Object.assign({}, e, keys.reduce((a, kk) => (a[kk] = e[kk] + (kk[0] === 'x' ? dx : dy), a), {}))));
      if (inMain) {                                           // 把兄弟姐妹那一排里他的空位去掉，改成"从父母那条横线一路连到他本人的卡片顶上"
        const busY = xc.y - H / 2 - CFG.BUS_OFF;
        S.cards = S.cards.filter(c => c !== xc);
        S.lines = S.lines.filter(l => !(Math.abs(l.x1 - xc.x) < 0.5 && Math.abs(l.x2 - xc.x) < 0.5 && Math.abs(l.y1 - busY) < 0.5));
        const gr = inMain.gray, sx = xc.x + dx, by = busY + dy, push = (x1, y1, x2, y2) => { if (Math.abs(x1 - x2) > 0.5 || Math.abs(y1 - y2) > 0.5) P.lines.push({ kind: 'child', x1, y1, x2, y2, gray: gr }); };
        if (!routed) { push(Math.min(sx, inMain.x), by, Math.max(sx, inMain.x), by); push(inMain.x, by, inMain.x, inMain.y - H / 2); }
        else {                                                // 他不在这一行：先沿横线走到一条没有卡片的竖直通道，再接到他卡片的顶上（线可以穿过线，不穿过卡片）
          const sibY = by + H / 2 + CFG.BUS_OFF;                 // 兄弟姐妹那一行
          const below = inMain.y < sibY - 1;                      // 他所在的行比兄弟姐妹那一行更靠上：从他的卡片底部接进去；否则从顶部接进去
          const yc = below ? inMain.y + H / 2 + 22 : inMain.y - H / 2 - 22, endY = below ? inMain.y + H / 2 : inMain.y - H / 2;
          const all = P.cards.concat(S.cards.map(c => Object.assign({}, c, { x: c.x + dx, y: c.y + dy })));
          const xf = freeLane(all, Math.min(by, yc), Math.max(by, yc), inMain.x);
          push(Math.min(sx, xf), by, Math.max(sx, xf), by); push(xf, by, xf, yc); push(Math.min(xf, inMain.x), yc, Math.max(xf, inMain.x), yc); push(inMain.x, yc, inMain.x, endY);
        }
      }
      mv(S.cards, P.cards, ['x', 'y']); mv(S.lines, P.lines, ['x1', 'y1', 'x2', 'y2']); mv(S.pairLines, P.pairLines, ['x1', 'y1', 'x2', 'y2']);
      mv(S.chips, P.chips, ['x', 'y']); mv(S.icons, P.icons, ['x', 'y']);
      (S.links || []).forEach(l => { if (!P.links.some(z => z.k === l.k)) P.links.push(l); });
      for (const kk in S.openMap) if (!(kk in P.openMap)) P.openMap[kk] = S.openMap[kk];
      P.chips.push({ x: inMain ? inMain.x : xc.x + dx, y: (inMain ? inMain.y : xc.y + dy) - H / 2 - 26, label: '−', action: 'blk:' + X, gray: false });
      P.bounds = { minX: Math.min(P.bounds.minX, S.bounds.minX + dx), maxX: Math.max(P.bounds.maxX, S.bounds.maxX + dx),
        minY: Math.min(P.bounds.minY, S.bounds.minY + dy), maxY: Math.max(P.bounds.maxY, S.bounds.maxY + dy) };
    }
    return P;
  }

  // 过继入的养父/养母名字（用于生父母名下那张卡片的注释“出继xx”）
  function adoptiveName(model, key) {
    const r = (model.childrenByChild.get(key) || []).find(x => x.rel === '过继入');
    const k = r && (r.father || r.mother);
    const p = k && model.persons.get(k);
    return p ? p.name.replace(/[(（].*?[)）]/g, '') : '';
  }

  // 把这次排版里"需要稳定的决定"记进意图（界面每次渲染后调用一次）：块放左/右第一次决定后就记下来，块收起时清掉
  function commitPins(view, state) {
    if (!state.blockSide) state.blockSide = new Map();
    (view.sidesDecided || new Map()).forEach((side, k) => { if (!state.blockSide.has(k)) state.blockSide.set(k, side); });
    [...state.blockSide.keys()].forEach(k => { if (!(state.blocks && state.blocks.has(k))) state.blockSide.delete(k); });
  }
  function buildView(model, focus, state) {
    model = withPolicy(model, !state || state.mergeUnknown !== false);
    const build = (st, extra) => {
      const v = buildViewBase(model, focus, st, extra);
      if (v) { v.cards.forEach((c, i) => { c.uid = i; }); linkBrackets(model, v, st || defaultState()); markDbl(model, v, st || defaultState()); v.kinLines = kinLines(model, v); v.adoptLinks = adoptLinks(model, v); }
      return v;
    };
    let v = build(state);
    // 第二遍：长括线连着的夫妻，孩子最终偏在哪一侧是第一遍排完才知道的；把这个偏移告诉排版，让左右邻居按"孩子真正占的位置"来错开
    if (v && v.groupShift && Object.keys(v.groupShift).length) {
      v = build(state, { groupShift: new Map(Object.entries(v.groupShift)) });
    }
    return v;
  }

  // ---- 过继：生父母名下那张卡（灰显、注释“出继xx”）与过继入的那张之间的虚线 Π（鼠标悬停时才显示）
  function adoptLinks(model, view) {
    const { H } = CFG, out = [];
    const rowTops = y => Math.min(Infinity, ...(view.kinLines || []).filter(k => Math.abs(k.y - y) < 1).map(k => k.top));
    view.cards.filter(c => c.adoptedOut).forEach(bio => {
      const adopt = view.cards.find(c => c.key === bio.key && !c.adoptedOut);
      if (!adopt) return;
      const yTop = Math.min(bio.y, adopt.y) - H / 2;
      out.push({ key: bio.key, bioUid: bio.uid, adoptUid: adopt.uid, x1: bio.x + 24, x2: adopt.x + 24, y1: bio.y - H / 2, y2: adopt.y - H / 2, base: Math.min(yTop - 52, rowTops(Math.min(bio.y, adopt.y)) - 14), label: '过继' });
    });
    // 横向范围重叠的 Π 才错开高度（和联姻括线、旁系虚线共用 assignLevels），不再按出现顺序一律往上叠
    assignLevels(out, l => Math.min(l.x1, l.x2), l => Math.max(l.x1, l.x2), 30);
    out.forEach(l => { l.top = l.base - 14 * l.lv; delete l.base; delete l.lv; });
    return out;
  }

  // ---- 联姻括线（长）：夫妻两人各在自己的家族位置、都在画面里时，不复制卡片，用一条括线把两人连起来
  function linkBrackets(model, view, state) {
    const { H, W } = CFG;
    const grayFlag = v => state.noGray ? false : !!v;
    const cardBy = new Map();
    view.cards.forEach(c => { const o = cardBy.get(c.key); if (!o || o.role === 'childSpouse' || (o.adoptedOut && !c.adoptedOut)) cardBy.set(c.key, c); });
    // 夫妻都在画面里：同一行 → 括线在这一行的下面；不同行（跨代际）→ 横杠一律放在男方所在行的下面，女方用折线接过去。线可以穿过别的线，但不能穿过卡片
    const items = [], lanes = [];
    (view.links || []).forEach(l => {
      const a = cardBy.get(l.a), b = cardBy.get(l.b);
      if (!a || !b || a === b) return;
      const aIsH = (model.persons.get(l.a) || {}).gender === 'M', bIsH = (model.persons.get(l.b) || {}).gender === 'M';
      const h = (bIsH && !aIsH) ? b : a, w = h === a ? b : a;
      const it = { l, h, w, same: Math.abs(h.y - w.y) < 1 };
      if (it.same) it.xf = w.x;
      else {
        const ys = [...new Set(view.cards.map(c => Math.round(c.y)))];
        const rows = w.y < h.y ? ys.filter(y => y > w.y + 1 && y <= h.y + 1) : ys.filter(y => y > h.y + 1 && y < w.y - 1);
        // 女方的竖直通道：避开卡片，也避开前面几条长括线已经占用的通道（占用表 lanes），免得两条线重叠在同一条竖线上
        const yA = Math.min(w.y, h.y), yB = Math.max(w.y, h.y) + 84;
        it.xf = rows.length ? pickLane(cardBlocks(view.cards.filter(c => rows.some(y => Math.abs(c.y - y) < 1))).concat(lanes.filter(q => q.y0 < yB && q.y1 > yA).map(q => [q.x - 10, q.x + 10])), h.x) : w.x;
        lanes.push({ x: it.xf, y0: yA, y1: yB });
      }
      it.lo = Math.min(it.xf, h.x); it.hi = Math.max(it.xf, h.x);
      items.push(it);
    });
    const byRow = new Map();
    items.forEach(it => { const r = Math.round(it.h.y); it.rowId = r; if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(it); });
    byRow.forEach(list => assignLevels(list, it => it.lo, it => it.hi, 20));
    // 这位男性的孩子（统一挂在他名下的那一组）：婚姻线从 ≥2 张卡片下面绕过去＝远 → 孩子放在靠近男方一定距离、偏向女方的位置；
    // 否则（挨得近）→ 按常规方式，孩子放在夫妻两人的正中间下方
    // 每条长括线各自找自己的孩子组（一位男方有几条长括线都行）：
    //   · 被搬走的夫人：她自己的孩子组（标签 kg:男方|夫人）；
    //   · 其余情况：男方名下"统一那一组"（标签 kg:男方|*）不属于哪位夫人，只接在他跨度最短的那条长括线上。
    const phChip = it => view.chips.find(c => c.kgs && c.kgs.includes('kg:' + it.h.key + '|' + it.w.key) && c.action === 'toggle:' + it.w.key);
    const restOwner = new Map();
    items.filter(it => !phChip(it)).forEach(it => { const cur = restOwner.get(it.h.key); if (!cur || it.hi - it.lo < cur.hi - cur.lo) restOwner.set(it.h.key, it); });
    const linksOf = new Map(); items.forEach(it => linksOf.set(it.h.key, (linksOf.get(it.h.key) || 0) + 1));
    items.forEach(it => {
      const { h, w } = it;
      let tag, gchip = phChip(it);
      if (gchip) tag = 'kg:' + h.key + '|' + w.key;
      else if (restOwner.get(h.key) === it) { tag = 'kg:' + h.key + '|*'; gchip = view.chips.find(c => c.kgs && c.kgs.includes(tag) && c.action === 'kids:' + h.key + '|*'); }
      if (!gchip) return;
      const members = a => a.filter(e => e.kgs && e.kgs.includes(tag));
      const y0r = Math.min(h.y, w.y) - 1, y1r = Math.max(h.y, w.y) + 1;
      const between = view.cards.filter(c => c !== h && c !== w && c.y >= y0r && c.y <= y1r && c.x > it.lo + 1 && c.x < it.hi - 1 && !(c.kgs && c.kgs.includes(tag))).length;
      const dir = it.xf < h.x ? -1 : 1;
      let tx = between >= 2 ? h.x + dir * (W / 2 + CFG.KID_OFFSET) : (it.xf + h.x) / 2;
      it.groupTag = tag; it.groupChip = gchip;
      // 孩子这一排：整排以 tx 为中心（引出线落在这一排的正中间）；引出线与横括线重新接好
      const mem = members(view.cards), kidsY = Math.min(...mem.map(c => c.y));
      const direct = mem.filter(c => Math.abs(c.y - kidsY) < 1 && c.role !== 'childSpouse');
      if (!direct.length && !tag.endsWith('|*') && linksOf.get(h.key) > 1 && Math.abs(w.y - h.y) < 1) {
        // 收起的夫人名下的子女组：\"+N\"小圆点放在她自己的卡片旁边（紧贴卡片底部右侧），不再堆在男方那一侧
        gchip.x = w.x + 20; gchip.y = w.y + H / 2 + 26; it.wifeChip = true;
      }
      if (direct.length) {
        const cur = (Math.min(...direct.map(c => c.x)) + Math.max(...direct.map(c => c.x))) / 2;
        // 这位男方有好几条长括线时，孩子不再往某一位夫人那边挪（保持原位，免得把画面撑宽）；只保证引出线落在这条横杠的范围内
        if (linksOf.get(h.key) > 1) tx = (cur >= it.lo - 1 && cur <= it.hi + 1) ? cur : Math.min(Math.max(cur, it.lo + 4), it.hi - 4);
        const others = view.cards.filter(c => !(c.kgs && c.kgs.includes(tag)));
        const collides = d => mem.some(m => others.some(o => Math.abs(o.y - m.y) < 1 && Math.abs(o.x - (m.x + d)) < W + 10));
        // 一位男方有两条以上长括线（一夫多妻、夫人们各回各的家族）：每位夫人的孩子直接放在她自己卡片的正下方，
        // 孩子的引出线从她的卡片底部接下来；挪过去会压住别的卡片、或夫人和男方不在同一行时，才退回上面\"靠近男方\"的放法
        const isWifeGroup = !tag.endsWith('|*');
        if (isWifeGroup && linksOf.get(h.key) > 1 && Math.abs(w.y - h.y) < 1 && !collides(w.x - cur)) { tx = w.x; it.wifeMode = true; }
        else if (collides(tx - cur) && !collides(0)) tx = cur;       // 挪过去会压住别的卡片：就留在原位（引出线仍接在这一排的正中间）
        const dxs = tx - cur;
        const ownLines = view.lines.filter(e => e.kgOwn === tag), dropL = ownLines.find(e => e.kgRole === 'drop'), busL = ownLines.find(e => e.kgRole === 'bus');
        members(view.cards).forEach(e => { e.x += dxs; });
        members(view.lines).forEach(e => { e.x1 += dxs; e.x2 += dxs; });
        members(view.pairLines).forEach(e => { e.x1 += dxs; e.x2 += dxs; });
        members(view.chips).forEach(e => { e.x += dxs; });
        members(view.icons).forEach(e => { e.x += dxs; });
        const xsK = direct.map(c => c.x);
        if (busL) { busL.x1 = Math.min(tx, ...xsK); busL.x2 = Math.max(tx, ...xsK); }
        if (dropL) { dropL.x1 = tx; dropL.x2 = tx; }
        gchip.x = tx; it.finalTx = tx;
        members(view.cards).forEach(c => {                         // 挪动之后画面范围也要跟着扩
          view.bounds.minX = Math.min(view.bounds.minX, c.x - W / 2); view.bounds.maxX = Math.max(view.bounds.maxX, c.x + W / 2);
          view.bounds.minY = Math.min(view.bounds.minY, c.y - H / 2); view.bounds.maxY = Math.max(view.bounds.maxY, c.y + H / 2);
        });
      }
    });
    // 行距弹性：这位男方下面的横杠层数多了，就把下面各行整体往下挪一点，让最低一层横杠、它下面的圆点、子女母线之间不挤在一起
    // （只在需要时才挪：1~2 层横杠不需要，所以只有一夫三妻以上才会看到变化）
    const BUS_REL = CFG.ROW_GAP - H / 2 - CFG.BUS_OFF;               // 子女母线相对于男方卡片中心的距离
    const rowLv = new Map(); items.forEach(it => { const r = it.rowId; rowLv.set(r, Math.max(rowLv.has(r) ? rowLv.get(r) : 0, it.lv)); });
    [...rowLv].sort((p, q) => p[0] - q[0]).forEach(([r, mx]) => {
      const hItem = items.find(it => it.rowId === r); if (!hItem) return;
      const hy = hItem.h.y, barMax = H / 2 + 56 + 10 * mx, delta = Math.max(0, barMax + 24 + 11 + 6 - BUS_REL);
      if (!delta) return;
      const thr = hy + H / 2 + 50;
      const sh = e => { if (e.y > thr) e.y += delta; };
      view.cards.forEach(sh); view.chips.forEach(sh); view.icons.forEach(sh);
      [view.lines, view.pairLines].forEach(arr => arr.forEach(l => { if (l.y1 > thr) l.y1 += delta; if (l.y2 > thr) l.y2 += delta; }));
      view.bounds.maxY += delta;
    });
    const rowBarMax = new Map();                                      // 每个男方所在行最低一层横杠的 y（行距挪完之后）
    items.forEach(it => rowBarMax.set(it.rowId, it.h.y + H / 2 + 56 + 10 * rowLv.get(it.rowId)));
    view.groupShift = {};
    items.forEach(it => { if (it.finalTx !== undefined && it.groupTag && it.groupTag.endsWith('|*')) view.groupShift[it.h.key] = it.finalTx - it.h.x; });
    view.linkSegs = [];
    items.forEach(it => {
      const { h, w, l } = it, gray = grayFlag(h.gray && w.gray);
      const barY = h.y + H / 2 + 56 + 10 * it.lv;            // 放在各卡片底部的小圆点（+N）下面，避免压住
      if (it.groupTag) {                                       // 孩子的引出线从横杠上接下来（不是从男方卡片底部）
        const gx = it.groupChip.x;
        view.lines.forEach(e => { if (e.kgOwn === it.groupTag && e.kgRole === 'drop') e.y1 = it.wifeMode ? w.y + H / 2 : barY; });   // 夫人正下方的孩子：引出线从她的卡片底部接下来
      }
      const seg = (x1, y1, x2, y2) => { if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) < 0.5) return; view.lines.push({ kind: 'child', x1, y1, x2, y2, gray }); view.linkSegs.push([x1, y1, x2, y2]); };
      seg(h.x, h.y + H / 2, h.x, barY);                       // 男方的竖脚
      if (it.same) seg(w.x, w.y + H / 2, w.x, barY);
      else if (w.y < h.y) {                                   // 女方在上面：从她的底部下来 → 横着挪到空通道 → 一路下到横杠
        const yc = w.y + H / 2 + 84;
        seg(w.x, w.y + H / 2, w.x, yc); seg(w.x, yc, it.xf, yc); seg(it.xf, yc, it.xf, barY);
      } else {                                                // 女方在下面：从她的顶部上去 → 横着挪到空通道 → 一路上到横杠
        const yc = w.y - H / 2 - 22;
        seg(w.x, w.y - H / 2, w.x, yc); seg(w.x, yc, it.xf, yc); seg(it.xf, yc, it.xf, barY);
      }
      const lowBar = rowBarMax.get(it.rowId);                          // 这些圆点一律放在这一行最低一层横杠的下面
      view.chips.forEach(c => { if (c === it.groupChip && it.wifeChip) return; if ((c.action === 'kids:' + h.key + '|*' && (Math.abs(c.x - h.x) < 2 || c === it.groupChip)) || c === it.groupChip) c.y = Math.max(c.y, lowBar + 24); });   // 这位男性的孩子（不管是谁生的）统一挂在他下面，+N 在横杠下面
      // 孩子的引出点如果落在横杠的两端之外（挪不过去时会这样），就把横杠延长到引出点，保证引出线接得上
      let bx1 = it.xf, bx2 = h.x;
      if (it.groupTag) {
        const gx = it.groupChip.x, lo = Math.min(bx1, bx2), hi = Math.max(bx1, bx2);
        if (gx < lo - 0.5) { if (bx1 < bx2) bx1 = gx; else bx2 = gx; } else if (gx > hi + 0.5) { if (bx1 > bx2) bx1 = gx; else bx2 = gx; }
      }
      view.pairLines.push({ x1: bx1, y1: barY, x2: bx2, y2: barY, style: l.type === '妾' ? 'thin' : 'thick',
        action: 'collapse:' + l.a + '|' + l.b, gray });
      view.linkSegs.push([bx1, barY, bx2, barY]);
      view.bounds.maxY = Math.max(view.bounds.maxY, barY + 6);
    });
    // 同一位男方的几位夫人的子女组如果都是收起的，小圆点会挤在同一个位置：同一高度上圆心距至少 26，整体保持居中
    const gcs = items.filter(it => !it.wifeChip).map(it => it.groupChip).filter((c, i, a) => c && a.indexOf(c) === i);
    const byY = new Map(); gcs.forEach(c => { const k = Math.round(c.y); if (!byY.has(k)) byY.set(k, []); byY.get(k).push(c); });
    byY.forEach(list => {
      if (list.length < 2) return;
      const fixed = list.filter(c => c.label === '−'), moving = list.filter(c => c.label !== '−').sort((p, q) => p.x - q.x);   // 展开的那组圆点压在它的引出线上，不动；收起的往旁边让
      if (moving.length < 2 && !fixed.length) return;
      const before = moving.reduce((a, c) => a + c.x, 0);
      let prev = -Infinity;
      moving.forEach(c => {
        c.x = Math.max(c.x, prev + 26);
        for (let guard = 0; guard < 20 && fixed.some(f => Math.abs(f.x - c.x) < 26); guard++) c.x = Math.max(...fixed.filter(f => Math.abs(f.x - c.x) < 26).map(f => f.x)) + 26;
        prev = c.x;
      });
      if (!fixed.length && moving.length) { const shift = (before - moving.reduce((a, c) => a + c.x, 0)) / moving.length; moving.forEach(c => { c.x += shift; }); }
    });
  }

  // 可以"双击展开家族"的：画面上任何一个人（卡片，或联姻对象的小图标），只要他的（父系）家族还没有出现在画面里——也就是他的父亲不在画面上；
  // 已经展开成家族块的人也可以再双击收回。（父/母卡片上方本来就有"+N"的，用那个）
  function markDbl(model, view, state) {
    const pres = new Set(view.cards.map(c => c.key));
    const withChip = new Set(view.chips.filter(c => c.action.startsWith('up:')).map(c => c.action.slice(3)));
    const blocks = state.blocks || new Set();
    const can = k => {
      if (!k || !model.persons.has(k) || k === view.focus || withChip.has(k)) return false;
      const up = resolveParents(model, k);
      return !!up && !pres.has(up.axis);
    };
    view.cards.forEach(c => { c.dbl = blocks.has(c.key) || can(c.key); });
    view.icons.forEach(i => { i.dblKey = can(i.spouseKey) ? i.spouseKey : null; });
  }

  // ---- 旁系表里直接写的两人关系：卡片右上角的小菱形；点开后把对方以灰显卡片补进同一行的外侧（连线由 kinLines 画）
  // 旁系亲属（小菱形）：在各自所属的"区域"（主视图、或某个家族块）里先排好，再并块——这样块会给旁系让位，而不是旁系被甩到所有块的外面。
  // ctx：{ focus, present：所有区域里已有的人（会随新增更新）, foreign：别的区域里的人（这个区域不再处理他们）, groupShift }
  function relMarkers(model, view, state, ctx) {
    const { W, H } = CFG;
    const relOpen = state.relOpen || new Set();
    const presentKeys = () => ctx.present;
    // 把一组旁系亲属（已按行内顺序排好）补进画面：每人是一个\"单元\"（卡片 + 联姻小图标 + 子女\"+N\"），和兄弟姐妹的显示一致。
    // side：'L' 排在这一行的左外侧（整组靠左，组内左长右幼）；'R' 排在右外侧。ty：这一行的纵坐标。
    const placeGroup = (list, side, ty, anchorY) => {
      if (!list.length) return false;
      const pres = presentKeys();
      const units = [];
      list.forEach(r => {
        if (pres.has(r.other) || units.some(u => u.key === r.other)) return;
        const sv = layoutFamily(model, { focus: ctx.focus, axis: r.other, solo: false, soloKey: r.other, coreKey: null, allOpen: false, up: false, notes: [], unitOnly: r.other },
          state, Object.assign({}, EMPTY_DV, { groupShift: ctx.groupShift || new Map(), twin: new Set([...pres, ...units.map(u => u.key)]), dupAdopt: null }));
        if (sv.cards.length) sv.cards[0].role = 'relative';
        units.push({ key: r.other, sv });
      });
      if (!units.length) return false;
      const G = CFG.CHILD_GAP;
      const row = view.cards.filter(x => Math.abs(x.y - anchorY) < 1 || Math.abs(x.y - ty) < 1);
      const mn = Math.min(...row.map(x => x.x - W / 2)), mx = Math.max(...row.map(x => x.x + W / 2));
      const widths = units.map(u => u.sv.bounds.maxX - u.sv.bounds.minX);
      const total = widths.reduce((a, v) => a + v, 0) + (units.length - 1) * G;
      let start = side === 'L' ? mn - G - total : mx + G;
      const offsets = () => { let l = start; return units.map((u, i) => { const o = l; l += widths[i] + G; return o; }); };
      // 补出来的单元下面如果还有子女行，不能压到已有的卡片：有重叠就整组往外推
      for (let guard = 0; guard < 60; guard++) {
        let need = 0;
        const offs = offsets();
        units.forEach((u, i) => u.sv.cards.forEach(uc => {
          const x = offs[i] - units[i].sv.bounds.minX + uc.x, y = ty + uc.y;
          view.cards.forEach(e => {
            if (Math.abs(e.y - y) > 1) return;
            const ov = (W + 10) - Math.abs(e.x - x);
            if (ov > 0) need = Math.max(need, ov);
          });
        }));
        if (!need) break;
        start += side === 'L' ? -need : need;
      }
      const offs = offsets();
      units.forEach((u, i) => {
        const dx = offs[i] - u.sv.bounds.minX, dy = ty, sv = u.sv;
        const mv = (arr, target, keys) => arr.forEach(e => target.push(Object.assign({}, e, keys.reduce((a, kk) => (a[kk] = e[kk] + (kk[0] === 'x' ? dx : dy), a), {}))));
        sv.cards.forEach(c => ctx.present.add(c.key));
        mv(sv.cards, view.cards, ['x', 'y']); mv(sv.lines, view.lines, ['x1', 'y1', 'x2', 'y2']); mv(sv.pairLines, view.pairLines, ['x1', 'y1', 'x2', 'y2']);
        mv(sv.chips, view.chips, ['x', 'y']); mv(sv.icons, view.icons, ['x', 'y']);
        (sv.links || []).forEach(l => { if (!view.links.some(z => z.k === l.k)) view.links.push(l); });
        for (const kk in sv.openMap) if (!(kk in view.openMap)) view.openMap[kk] = sv.openMap[kk];
        sv.cards.forEach(uc => {
          view.bounds.minX = Math.min(view.bounds.minX, uc.x + dx - W / 2); view.bounds.maxX = Math.max(view.bounds.maxX, uc.x + dx + W / 2);
          view.bounds.minY = Math.min(view.bounds.minY, uc.y + dy - H / 2); view.bounds.maxY = Math.max(view.bounds.maxY, uc.y + dy + H / 2);
        });
      });
      return true;
    };
    for (let it = 0; it < 4; it++) {
      let added = false;
      [...view.cards].forEach(c => {
        if (!relOpen.has(c.key) || ctx.foreign.has(c.key)) return;
        const hid = (model.collateralOf.get(c.key) || []).filter(r => !presentKeys().has(r.other));
        if (!hid.length) return;
        // 同辈（堂/从/表/再从/族）：按旁系表里的行内顺序\"左长右幼\"——比 c 年长的排在这一行的左外侧，年幼的排在右外侧
        const bySeq = (p, q) => p.seq - q.seq;
        const elder = hid.filter(r => r.kind !== 'cross' && r.ord === 'elder').sort(bySeq);
        const younger = hid.filter(r => r.kind !== 'cross' && r.ord === 'younger').sort(bySeq);
        if (placeGroup(elder, 'L', c.y, c.y)) added = true;
        if (placeGroup(younger, 'R', c.y, c.y)) added = true;
        // 差一辈（从子等）：落在上一行 / 下一行，仍排在离 c 较近的那一侧
        ['down', 'up'].forEach(dir => {
          const list = hid.filter(r => r.kind === 'cross' && r.dir === dir);
          if (!list.length) return;
          const ty = c.y + (dir === 'down' ? CFG.ROW_GAP : -CFG.ROW_GAP);
          const row = view.cards.filter(x => Math.abs(x.y - c.y) < 1 || Math.abs(x.y - ty) < 1);
          const mn = Math.min(...row.map(x => x.x)), mx = Math.max(...row.map(x => x.x));
          if (placeGroup(list, c.x < (mn + mx) / 2 ? 'L' : 'R', ty, c.y)) added = true;
        });
      });
      if (!added) break;
    }
    const pres = presentKeys(), seen = new Set();
    view.cards.filter(c => !c.adoptedOut).concat(view.cards.filter(c => c.adoptedOut)).forEach(c => {
      if (seen.has(c.key) || ctx.foreign.has(c.key)) return;
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
      assignLevels(list, g => g.l, g => g.r, 30);
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

  function layoutFamily(model, o, state, dv) {
    const { focus, axis, solo, soloKey, coreKey } = o;
    dv = dv || EMPTY_DV;
    const openOv = state.open, expSp = dv.expSp || state.expSp, twin = dv.twin || null, dupAdopt = dv.dupAdopt || null;
    const awaySet = dv.away;           // 被双击展开家族、已经"搬"回自己家族兄弟姐妹行里的配偶：主视图里不再画她的卡片
    const autoKids = dv.autoKids, kidShut = state.kidShut || new Set();
    const groupShift = dv.groupShift;   // 第一遍排版得出的：某人名下那一排子女相对于他本人的水平偏移（见 buildView 的第二遍）
    const warnings = [];
    const grayFlag = value => state.noGray ? false : !!value;
    const { W, H } = CFG;
    const virtualRow = !!solo && isVirtual(soloKey);        // 兄弟行（来自旁系关系表）：共同母亲不画
    const pitch = W + CFG.PITCH_GAP;

    const fatherRows = solo ? (model.childrenByMother.get(soloKey) || []) : (model.childrenByFather.get(axis) || []);

    // ---- 2. 配偶清单 + 分类（R08、R16、D7）
    const units = solo ? null : familyUnits(model, axis);
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
      if (units.groups.has('u:不详'))                  // 有"不详"的孩子又没并进正妻：单独一个"未知"母亲
        sp.push({ key: 'u:不详:' + axis, placeholder: true, label: '不详', name: '未知', type: '', order: Infinity, idx: 9001, kind: 'unk' });
      if (units.groups.has('u:庶母'))
        sp.push({ key: 'u:庶母:' + axis, placeholder: true, label: '庶母', name: '未知妾室', type: '', order: Infinity, idx: 9002, kind: 'other' });
      sp.filter(s => s.kind === 'unk').sort(cmpOrder).forEach((s, i) => { s.kind = (!hasLegal && i === 0) ? 'first' : 'jishi'; });
    }
    // 搬走的配偶：不占位、不画卡片和婚姻线，只保留她的子女——统一挂在男方正下方（婚姻线很远，孩子是谁生的没那么重要）
    const awaySp = (!solo && awaySet.size) ? sp.filter(s => awaySet.has(s.key) && !s.placeholder) : [];
    if (awaySp.length) sp = sp.filter(s => !awaySp.includes(s));
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
      (model.childrenByFather.get(key) || []).forEach(r => rows.push({ r, other: effMother(model, r) }));
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
        if (rs && rs.length) groups.push({ gkey: key + '|' + x.key, kind: 'mar', idx: expIdx.get(x.key), count: rs.length, type: x.m.type,
          hasFocus: rs.some(r => r.child === focus),
          getRows: () => orderSiblings(rs, model, warnings) });
      });
      groups.forEach(g => {
        g.open = !frozen && depth < 8 && (kidOpenSet.has(g.gkey) || (autoKids.has(g.gkey) && !kidShut.has(g.gkey)));
        g.kids = g.open ? g.getRows().map(r => ({ row: r, unit: buildUnit(r.child, depth + 1, isOut(r)) })) : [];
      });
      // 宽度：本人 + 已展开配偶（第一行）；下一代展开后的左右边界单独记在 m 里（可以伸到邻居上方），错开方式见 rowLayout
      const own = W + expIdx.size * PW;
      let prevHi = -Infinity, lo = Infinity, hi = -Infinity;
      groups.forEach(g => {
        if (!g.open) return;
        g.row = rowLayout(g.kids.map(k => k.unit.m));
        const dc = g.kind === 'rest' ? W / 2 + (groupShift.get(key) || 0) : W / 2 + g.idx * PW + PW / 2;
        let left0 = dc - g.row.span / 2;
        if (prevHi > -Infinity) left0 = Math.max(left0, prevHi + CFG.MARGIN - g.row.lo);
        g.left = left0;
        prevHi = left0 + g.row.hi; lo = Math.min(lo, left0 + g.row.lo); hi = Math.max(hi, left0 + g.row.hi);
      });
      const has = hi > -Infinity, padL = has ? Math.max(0, -lo) : 0;
      // w / padL：给"整体排在外侧"的老用法（祖辈的兄弟姐妹）用的完整宽度与左侧留白
      return { key, p: model.persons.get(key), csp, groups, m: { rowW: own, has, lo: has ? lo : 0, hi: has ? hi : 0 }, padL, w: Math.max(own, has ? hi : 0) + padL };
    }

    // ---- 3. 每位配偶名下的子女（R12、D6）与折叠状态（R13）
    // R29：选中人物自己那个子女位，按他完整展开的"本人家庭"算：第一行是他本人这一行的卡片，下面的子女等记作"下一代"
    const focalM = sub => {
      const row = sub.cards.filter(c => Math.abs(c.y) < 1), b = sub.bounds;
      if (!row.length) return { rowW: Math.max(W, b.maxX - b.minX), origin: b.minX, has: false, lo: 0, hi: 0 };
      const rMin = Math.min(...row.map(c => c.x - W / 2)), rMax = Math.max(...row.map(c => c.x + W / 2));
      const low = sub.cards.filter(c => c.y > 1);
      return { rowW: rMax - rMin, origin: rMin, has: low.length > 0,
        lo: low.length ? Math.min(...low.map(c => c.x - W / 2)) - rMin : 0, hi: low.length ? Math.max(...low.map(c => c.x + W / 2)) - rMin : 0 };
    };
    const isFocalKid = k => o.focalChild && k.key === o.focalChild && o.focalOwnView;
    awaySp.forEach(s => { s.phantom = true; });
    const phSp = awaySp;
    allSp.concat(phSp).forEach(s => {
      const rows = s.solo ? fatherRows
        : s.placeholder ? units.rowsOf('u:' + s.label)
        : units.rowsOf(s.key);
      s.kids = orderSiblings(rows, model, warnings).map(r => ({
        row: r, key: r.child, p: model.persons.get(r.child),
        unit: (o.focalChild && r.child === o.focalChild && o.focalOwnView) ? null : buildUnit(r.child, 0, isOut(r))
      }));
      const dflt = o.allOpen || s.kind !== 'other' || s.solo || s.key === coreKey;
      s.defaultOpen = dflt;
      s.open = s.kids.length > 0 && (openOv.has(s.key) ? openOv.get(s.key) : dflt);
      if (s.open) {
        s.row = rowLayout(s.kids.map(k => isFocalKid(k) ? (k.fm = focalM(o.focalOwnView)) : k.unit.m));
        const c0 = s.row.span / 2;
        s.gw = 2 * Math.max(c0 - s.row.lo, s.row.hi - c0);            // 以子女这一排的中心为轴，对称地包住下一代的范围
      } else s.gw = 0;
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

    // 搬走的配偶的子女块：尽量放在男方正下方，不和别的子女块重叠
    {
      const placed = [];
      allSp.forEach(t => { if (t.open) placed.push([t.gcx - t.gw / 2, t.gcx + t.gw / 2]); });
      phSp.forEach(t => {
        // 孩子统一放在靠近男方一定距离的位置、偏向女方（她的家族块）那一侧；男方卡片靠女方的这一侧也留一点空白
        const tc = ((dv.awaySide && dv.awaySide.get(t.key)) === 'L' ? -1 : 1) * (W / 2 + CFG.KID_OFFSET);
        t.x = 0; t.dropAtMid = false; t.gcx = tc; t.dropX = tc;
        if (!t.open) return;
        const M = CFG.MARGIN, ok = c => placed.every(([lo, hi]) => c + t.gw / 2 + M <= lo || c - t.gw / 2 - M >= hi);
        const cands = [tc];
        placed.forEach(([lo, hi]) => { cands.push(hi + M + t.gw / 2); cands.push(lo - M - t.gw / 2); });
        t.gcx = cands.filter(ok).sort((p, q) => Math.abs(p - tc) - Math.abs(q - tc))[0];
        t.dropX = t.gcx;
        if (t.gcx === undefined) { t.gcx = Math.max(...placed.map(p => p[1])) + M + t.gw / 2; t.dropX = t.gcx; }
        placed.push([t.gcx - t.gw / 2, t.gcx + t.gw / 2]);
        rightEdge = Math.max(rightEdge, t.gcx + t.gw / 2);
      });
    }

    // ---- 5. 第二行：子女
    // 每个孩子单元的左边缘按 rowLayout 排好；这一排整体以 gcx 为中心
    const y0 = 0, y1 = CFG.ROW_GAP;
    allSp.concat(phSp).forEach(s => {
      if (!s.open) return;
      const left0 = s.gcx - s.row.span / 2;
      s.kids.forEach((k, i) => {
        const left = left0 + s.row.lefts[i];
        if (isFocalKid(k)) {
          const anchor = o.focalOwnView.cards.find(c => c.key === o.focalChild);
          k._dx = left - k.fm.origin;                      // 子图的"本人这一行"左边缘对齐 left
          k.x = k._dx + (anchor ? anchor.x : 0);            // 选中人物自己那张卡的最终位置
        } else {
          k.left = left;
          k.x = left + W / 2;
        }
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
    // 给"一组子女"整体打标签：这一组下面的所有卡片、线、标记都带上 kgs，后面（linkBrackets）可以整体左右挪动
    const cnt = () => [cards.length, lines.length, pairLines.length, chips.length, icons.length];
    const tagFrom = (n0, tag) => { [cards, lines, pairLines, chips, icons].forEach((arr, i) => { for (let j = n0[i]; j < arr.length; j++) arr[j].kgs = (arr[j].kgs || []).concat(tag); }); };
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
            action: 'expand:' + u.key + '|' + x.key, gray, out, spouseKey: x.key });
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
      const emitG = g => {
        const isConcubine = g.kind === 'mar' && g.type === '妾';
        const ax = g.kind === 'rest' ? kx : (isConcubine ? kx + (g.idx + 1) * PW : kx + g.idx * PW + PW / 2);
        const ay = g.kind === 'rest' ? y + H / 2 : (isConcubine ? y + H / 2 : y + barOff);
        const sibN = g.count - (g.hasFocus ? 1 : 0);   // 同 kidCount：整组去掉选中人物自己
        chips.push({ x: ax, y: g.kind === 'rest' ? y + H / 2 + 26 + (ne > 0 ? CFG.BRACKET + 4 : 0) : y + barOff + 22, label: g.open ? '−' : (sibN > 0 ? '+' + sibN : '+'), action: 'kids:' + g.gkey, gray, out });
        if (!g.open) return;
        const placed = g.kids.map((kd, i) => { const left = cx + g.left + g.row.lefts[i]; return { kd, left, x: left + W / 2 }; });
        const xs = placed.map(p => p.x);
        const own = g.kind === 'rest' ? { kgOwn: 'kg:' + u.key + '|*' } : {};      // 这一组自己的引出线/母线：直接标上角色，不靠坐标反查
        lines.push(Object.assign({ kind: 'child', x1: ax, y1: ay, x2: ax, y2: busN, gray }, own, g.kind === 'rest' ? { kgRole: 'drop' } : {}));
        lines.push(Object.assign({ kind: 'child', x1: Math.min(ax, ...xs), y1: busN, x2: Math.max(ax, ...xs), y2: busN, gray }, own, g.kind === 'rest' ? { kgRole: 'bus' } : {}));
        placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busN, x2: p.x, y2: yN - H / 2, double: p.kd.row.rel === '过继入', gray });
          emitUnit(p.kd.unit, p.left, yN, gray, p.kd.row);
        });
      };
      u.groups.forEach(g => { const n0 = cnt(); emitG(g); if (g.kind === 'rest') tagFrom(n0, 'kg:' + u.key + '|*'); });
    };
    if (o.unitOnly) {                                  // 只要"一个人 + 他的联姻图标 + 子女+N"这一单元（旁系亲属补出来时用，和兄弟姐妹的显示一致）
      const uu = buildUnit(o.unitOnly, 0, false);
      emitUnit(uu, uu.padL, 0, o.unitGray === false ? false : true, null);
      const xsU = cards.map(c => c.x), ysU = cards.map(c => c.y);
      return { cards, lines, pairLines, chips, icons, openMap, links, w: Math.max(W, uu.w),
        bounds: { minX: Math.min(...xsU) - W / 2, maxX: Math.max(...xsU) + W / 2, minY: Math.min(...ysU) - H / 2, maxY: Math.max(...ysU) + H / 2 } };
    }
    if (!solo) cards.push(mkCard(axis, 0, y0, model.persons.get(axis), { role: 'axis' }));

    allSp.forEach(s => {
      if (isVirtual(s.key)) { openMap[s.key] = s.open; return; }
      const p = s.placeholder ? { name: s.name, zi: '', gender: 'F', family: '-' } : model.persons.get(s.key);
      const gray = !!coreKey && s.key !== coreKey;
      cards.push(mkCard(s.key, s.x, y0, p, { role: 'spouse', gray, clickable: !s.placeholder, selected: s.key === focus }));
      openMap[s.key] = s.open;
    });
    phSp.forEach(s => {                                  // 搬走的配偶：不画卡片，只登记一条长括线（由 linkBrackets 画，她那一端在自己的家族块里）
      openMap[s.key] = s.open;
      const lk = [axis, s.key].sort().join('|');
      if (!links.some(l => l.k === lk)) links.push({ k: lk, a: axis, b: s.key, type: s.type || '' });
    });

    // 婚姻括线：沿这一行依次连接。每张卡片底部有一条细竖脚，竖脚下面是横杠（正妻粗、其他细）
    // 无任何配偶时整段跳过，避免焦点人物（axis）底部出现一条孤立短线（如司马干）
    if (!solo && allSp.length) {
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
    const drawKids = s => {
      if (!s.kids.length) return;
      const gray = !!coreKey && s.key !== coreKey;
      // R13：妾室等的子女默认折叠，卡片下方紧贴一个小圆点
      if ((s.kind === 'other' || s.phantom) && !s.solo) {
        const n = kidCount(s.kids.map(k => k.row), focus);
        chips.push({ x: s.phantom ? s.gcx : s.x, y: y0 + barOff + 22, label: s.open ? '−' : (n > 0 ? '+' + n : '+'), action: 'toggle:' + s.key });
      }
      if (!s.open) return;
      const startY = s.dropAtMid ? y0 + barOff : y0 + H / 2;
      const xs = s.kids.map(k => k.x);
      const kgTag = s.phantom ? { kgOwn: 'kg:' + axis + '|' + s.key } : {};
      if (!virtualRow) lines.push(Object.assign({ kind: 'child', x1: s.dropX, y1: startY, x2: s.dropX, y2: busY, gray, kgRole: 'drop' }, kgTag));   // 兄弟行：顶上不留向上的短竖线
      lines.push(Object.assign({ kind: 'child', x1: Math.min(...(virtualRow ? [] : [s.dropX]), ...xs), y1: busY, x2: Math.max(...(virtualRow ? [] : [s.dropX]), ...xs), y2: busY, gray, kgRole: 'bus' }, kgTag));
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
    };
    allSp.forEach(drawKids);
    phSp.forEach(s => { const n0 = cnt(); drawKids(s); tagFrom(n0, 'kg:' + axis + '|' + s.key); });   // 每位被搬走的夫人各有自己的标签

    // ---- 6b. 2.2 往上展开一代：父亲、母亲各有一个展开点（卡片上方"+N"）。
    // 展开后：这个人的父母（祖辈）出现在上一行；这个人的兄弟姐妹（伯叔姑/舅姨）出现在同一行，
    // 母亲那一侧放在母亲所在的一边，父亲那一侧放在另一边，都排在现有内容的外面，全部灰显。
    // ---- 6b. 往上展开一代：①父亲、母亲各有一个展开点（灰显）；②v2.0：双击其他家族的人物，按"选中此人"的标准展开他的父母和兄弟姐妹（正常颜色）
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
      const fu = up.solo ? null : familyUnits(model, up.axis);
      const ownKey = up.solo ? null : (isReal(up.coreKey) ? up.coreKey : up.coreKey.split(':').slice(0, 2).join(':'));   // 选中人物所在的"母亲组"
      const sibRows = (up.solo ? (model.childrenByMother.get(up.axis) || []) : fu.rowsOf(ownKey))
        .filter(c => !seen.has(c.child) && seen.add(c.child));
      const rows = model.childrenByChild.get(key) || [];
      const own = rows.find(r => r.rel === '过继入') || rows[0];
      let halfRows = [], halfLeftMothers = new Set();
      if (f && m) {                                    // 同父异母：父亲其他妻子生的孩子；母亲排在前面的放左边，排在后面的放右边
        const order = model.spousesOf(f).map(x => x.key), mi = order.indexOf(m);
        halfRows = (model.childrenByFather.get(f) || []).filter(c => fu.keyOf(c) !== ownKey && !seen.has(c.child) && seen.add(c.child));
        halfRows.forEach(r => { const em = effMother(model, r), oi = order.indexOf(em); if (oi >= 0 && oi < mi) halfLeftMothers.add(r.mother); });
      }
      return { f, m, sibRows, halfRows, halfLeftMothers, adopted: !!own && own.rel === '过继入', n: (f ? 1 : 0) + (m ? 1 : 0) + sibRows.length };
    };
    // 祖辈的兄弟姐妹：和子女行共用 rowLayout 排；排在"目标人物所在这一行"的外侧——只看这一行的卡片，不再让到整个画面的最外面。
    // 他们自己如果展开了子女，下面几行不能压住已有的卡片（含前一组还没画出来的占用，所以单独记在 reserved 里）。
    const reserved = { lo: Infinity, hi: -Infinity, low: [] };
    const M = CFG.MARGIN, YT = 0;
    const rowSpanNow = () => { let lo = reserved.lo, hi = reserved.hi; cards.forEach(c => { if (Math.abs(c.y - YT) < 1) { lo = Math.min(lo, c.x - W / 2); hi = Math.max(hi, c.x + W / 2); } }); return [lo, hi]; };
    const lowerBlocked = (a, b) => cards.some(c => c.y > YT + 1 && c.x + W / 2 + M > a && c.x - W / 2 - M < b) || reserved.low.some(([l, h]) => h + M > a && l - M < b);
    const layGroup = (us, side) => {
      if (!us.length) return [];
      const rl = rowLayout(us.map(u => u.unit.m)), [rowLo, rowHi] = rowSpanNow(), G = 2 * M;
      let left0 = side === 'L' ? (rowLo === Infinity ? 0 : rowLo - G - rl.span) : (rowHi === -Infinity ? 0 : rowHi + G);
      let lowLo = Infinity, lowHi = -Infinity;
      us.forEach((u, i) => { if (u.unit.m.has) { lowLo = Math.min(lowLo, rl.lefts[i] + u.unit.m.lo); lowHi = Math.max(lowHi, rl.lefts[i] + u.unit.m.hi); } });
      const hasLow = lowLo !== Infinity;
      if (hasLow) for (let guard = 0; guard < 120 && lowerBlocked(left0 + lowLo, left0 + lowHi); guard++) left0 += side === 'L' ? -CFG.CHILD_GAP : CFG.CHILD_GAP;
      reserved.lo = Math.min(reserved.lo, left0); reserved.hi = Math.max(reserved.hi, left0 + rl.span);
      if (hasLow) reserved.low.push([left0 + lowLo, left0 + lowHi]);
      return us.map((u, i) => ({ u, left: left0 + rl.lefts[i], x: left0 + rl.lefts[i] + W / 2, half: !!u.half }));
    };
    // 兄弟姐妹排在这一行的外侧：比目标人物年长的在左外侧，年幼的在右外侧（保持左长右幼）
    const placeSiblings = (tkey, info, withHalf) => {
      if (info.virtual) {
        const myRow = (model.childrenByChild.get(tkey) || []).find(r => r.virtual);
        const byIdx = info.sibRows.slice().sort((a, b) => a.idx - b.idx).map(r => ({ row: r, unit: buildUnit(r.child, 0, isOut(r)) }));
        const elder = byIdx.filter(u => myRow && u.row.idx < myRow.idx), younger = byIdx.filter(u => !(myRow && u.row.idx < myRow.idx));
        return layGroup(elder, 'L').concat(layGroup(younger, 'R'));
      }
      const ownRow = (model.childrenByChild.get(tkey) || []).find(r => !r.virtual && (r.father === info.f || effMother(model, r) === info.m));
      const full = orderSiblings(ownRow ? info.sibRows.concat([ownRow]) : info.sibRows, model, warnings);
      const myUnits = full.map(r => ({ row: r, unit: buildUnit(r.child, 0, isOut(r)) }));
      const myIdx = full.findIndex(r => r.child === tkey);
      let elder = myIdx > 0 ? myUnits.slice(0, myIdx) : [];
      let younger = myIdx >= 0 && myIdx < myUnits.length - 1 ? myUnits.slice(myIdx + 1) : [];
      if (withHalf && info.halfRows && info.halfRows.length) {      // 同父异母的兄弟姐妹：灰显，排在更外侧
        const hu = orderSiblings(info.halfRows, model, warnings).map(r => ({ row: r, half: true, unit: buildUnit(r.child, 0, isOut(r)) }));
        elder = hu.filter(u => info.halfLeftMothers.has(u.row.mother)).concat(elder);
        younger = younger.concat(hu.filter(u => !info.halfLeftMothers.has(u.row.mother)));
      }
      return layGroup(elder, 'L').concat(layGroup(younger, 'R'));
    };
    // 画出一组"祖辈 + 兄弟姐妹"：yT 是目标人物所在行的纵坐标；gray 决定是否灰显
    const emitBlock = b => {
      const yT = b.yT || 0, yA = yT - CFG.ROW_GAP, busA = yT - H / 2 - CFG.BUS_OFF, both = !!(b.info.f && b.info.m), gr = grayFlag(b.gray);
      const put = (key, x) => cards.push(mkCard(key, x, yA, model.persons.get(key), { role: 'ancestor', gray: b.gray }));
      if (b.info.virtual) {                          // 兄弟行：只有一条横括线把他和兄弟姐妹连起来，顶上不留向上的短竖线
        lines.push({ kind: 'child', x1: Math.min(...b.xs), y1: busA, x2: Math.max(...b.xs), y2: busA, gray: gr });
        lines.push({ kind: 'child', x1: b.t.x, y1: busA, x2: b.t.x, y2: yT - H / 2, gray: gr });
        b.placed.forEach(p => {
          lines.push({ kind: 'child', x1: p.x, y1: busA, x2: p.x, y2: yT - H / 2, gray: grayFlag(b.gray || p.half) });
          emitUnit(p.u.unit, p.left, yT, b.gray || p.half, p.u.row);
        });
        return;
      }
      if (both) {
        const mx = b.c - pitch / 2, fx = b.c + pitch / 2;
        put(b.info.m, mx); put(b.info.f, fx);
        const mar = (model.marriagesByHusband.get(b.info.f) || []).find(x => x.w === b.info.m);
        const barA = yA + barOff;
        lines.push({ kind: 'child', x1: mx, y1: yA + H / 2, x2: mx, y2: barA, gray: gr });
        lines.push({ kind: 'child', x1: fx, y1: yA + H / 2, x2: fx, y2: barA, gray: gr });
        lines.push({ kind: 'marry', style: mar && mar.type === '妾' ? 'thin' : 'thick', x1: mx, y1: barA, x2: fx, y2: barA, gray: gr });
      } else put(b.info.f || b.info.m, b.c);
      lines.push({ kind: 'child', x1: b.c, y1: both ? yA + barOff : yA + H / 2, x2: b.c, y2: busA, gray: gr });
      const all = b.xs.concat([b.c]);
      lines.push({ kind: 'child', x1: Math.min(...all), y1: busA, x2: Math.max(...all), y2: busA, gray: gr });
      lines.push({ kind: 'child', x1: b.t.x, y1: busA, x2: b.t.x, y2: yT - H / 2, double: b.info.adopted, gray: gr });
      b.placed.forEach(p => {
        lines.push({ kind: 'child', x1: p.x, y1: busA, x2: p.x, y2: yT - H / 2, double: p.u.row.rel === '过继入', gray: grayFlag(b.gray || p.half) });
        emitUnit(p.u.unit, p.left, yT, b.gray || p.half, p.u.row);
      });
    };
    const originalKeys = new Set();
    if (o.up) {
      const motherCard = (!solo && isReal(coreKey)) ? allSp.find(s => s.key === coreKey) : null;
      const targets = solo ? [{ key: soloKey, x: 0, mother: true }] : [{ key: axis, x: 0, mother: false }].concat(motherCard ? [{ key: coreKey, x: motherCard.x, mother: true }] : []);
      targets.forEach(t => originalKeys.add(t.key));
      const blocks = [];
      targets.forEach(t => {
        const info = ancestorInfo(t.key);
        if (!info) return;
        const open = upOpenSet.has(t.key);
        chips.push({ x: t.x, y: 0 - H / 2 - 26, label: open ? '−' : (info.sibRows.length > 0 ? '+' + info.sibRows.length : '+'), action: 'up:' + t.key });
        if (!open) return;
        const placed = placeSiblings(t.key, info);
        const xs = [t.x].concat(placed.map(p => p.x));
        blocks.push({ t, info, placed, xs, yT: 0, gray: true, c: (Math.min(...xs) + Math.max(...xs)) / 2, hw: (info.f && info.m) ? pitch / 2 + W / 2 : W / 2 });
      });
      const realBlocks = blocks.filter(b => !b.info.virtual);
      if (realBlocks.length === 2) {                   // 两侧的祖辈卡不能挤在一起（兄弟行没有祖辈卡，不参与）
        realBlocks.sort((a, b) => a.c - b.c);
        const need = (realBlocks[0].c + realBlocks[0].hw) + CFG.MARGIN - (realBlocks[1].c - realBlocks[1].hw);
        if (need > 0) { realBlocks[0].c -= need / 2; realBlocks[1].c += need / 2; }
      }
      blocks.forEach(emitBlock);
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

  const api = { CFG, kinLines, buildModel, buildView, commitPins, defaultState, searchPersons, orderSiblings, resolveParents, hasParents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
