#!/usr/bin/env node
// 西晋谱系图 · 布局回归脚本（重构路线图第 1 步：安全网）
//
//   node regress.js                 对比基线（baseline.json），有变差就以退出码 1 结束
//   node regress.js --strict        在上面的基础上，布局指纹（位置/文字/线条）只要有任何变化也判失败——纯重构、不应改变任何视觉时用
//   node regress.js --update        用当前结果覆盖基线（只在确认"变好了"之后才用）
//   node regress.js --svg out/      把命名场景画成 SVG 存到 out/（用于肉眼复查）
//   node regress.js --only A_       只跑名字以 A_ 开头的场景（调试用）
//   CORE=./old_core.js node regress.js   拿另一个版本的 core.js 来跑
//
// 数据与排版核心默认读同目录的 data.json / core.js。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dir = __dirname;
const Core = require(path.resolve(process.env.CORE || path.join(dir, 'core.js')));
const raw = JSON.parse(fs.readFileSync(path.resolve(process.env.DATA || path.join(dir, 'data.json')), 'utf8'));
const model = Core.buildModel(raw);
const { W, H } = Core.CFG;
const BASELINE = path.join(dir, 'baseline.json');

/* ------------------------------------------------------------------ 指标 */
const segsOf = v => [].concat(v.lines || [], v.pairLines || []).filter(l => [l.x1, l.y1, l.x2, l.y2].every(Number.isFinite));
const distPtSeg = (px, py, s) => {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / L)) : 0;
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
};
// 线段穿过卡片内部（内缩 2px，贴着边的不算）
const crossesRect = (s, c) => {
  const x0 = c.x - W / 2 + 2, x1 = c.x + W / 2 - 2, y0 = c.y - H / 2 + 2, y1 = c.y + H / 2 - 2;
  let t0 = 0, t1 = 1; const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  for (const [p, q] of [[-dx, s.x1 - x0], [dx, x1 - s.x1], [-dy, s.y1 - y0], [dy, y1 - s.y1]]) {
    if (p === 0) { if (q < 0) return false; } else { const r = q / p; if (p < 0) { if (r > t1) return false; t0 = Math.max(t0, r); } else { if (r < t0) return false; t1 = Math.min(t1, r); } }
  }
  return t1 - t0 > 1e-6;
};
const metrics = v => {
  const cards = v.cards, segs = segsOf(v);
  // 1) 同一行卡片重叠
  let overlap = 0;
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++)
    if (Math.abs(cards[i].y - cards[j].y) < 1 && Math.abs(cards[i].x - cards[j].x) < W + 2) overlap++;
  // 2) 同一个人出现两张卡（过继出/入、子女配偶这几种本来就成对的不算）
  const seen = new Map(); let dup = 0;
  cards.forEach(c => { const k = c.key + (c.adoptedOut ? 'o' : '') + (c.role === 'childSpouse' ? 's' : ''); if (seen.has(k)) dup++; else seen.set(k, 1); });
  // 3) 悬空线端点：既不贴卡片边、也不在圆点/图标上、又没接到别的线上
  let dangling = 0;
  const touches = (px, py, self) => {
    if (cards.some(c => Math.abs(px - c.x) <= W / 2 + 3 && Math.abs(py - c.y) <= H / 2 + 3)) return true;
    if ((v.chips || []).some(c => Math.hypot(px - c.x, py - c.y) <= 14)) return true;
    if ((v.icons || []).some(c => Math.hypot(px - c.x, py - c.y) <= 12)) return true;
    return segs.some(s => s !== self && distPtSeg(px, py, s) <= 1.5);
  };
  segs.forEach(s => { if (!touches(s.x1, s.y1, s)) dangling++; if (!touches(s.x2, s.y2, s)) dangling++; });
  // 4) 线穿卡片
  let throughCard = 0;
  segs.forEach(s => { if (cards.some(c => crossesRect(s, c))) throughCard++; });
  // 5) 线与线垂直交叉（仅记录；规则允许线穿线，所以只告警不判错）
  let crossings = 0;
  const hs = segs.filter(s => Math.abs(s.y1 - s.y2) < 0.5 && Math.abs(s.x1 - s.x2) > 1), vs = segs.filter(s => Math.abs(s.x1 - s.x2) < 0.5 && Math.abs(s.y1 - s.y2) > 1);
  hs.forEach(h => vs.forEach(w => {
    const hx0 = Math.min(h.x1, h.x2), hx1 = Math.max(h.x1, h.x2), wy0 = Math.min(w.y1, w.y2), wy1 = Math.max(w.y1, w.y2);
    if (w.x1 > hx0 + 1 && w.x1 < hx1 - 1 && h.y1 > wy0 + 1 && h.y1 < wy1 - 1) crossings++;
  }));
  // 布局指纹：卡片、圆点、图标、线条的位置与文字全部取整后做哈希；只要有一个像素级的变化，指纹就不同
  const r = x => Math.round(x * 2) / 2;
  const sigStr = [
    cards.map(c => [c.key, c.role, r(c.x), r(c.y), c.gray ? 1 : 0].join(',')).join(';'),
    (v.chips || []).map(c => [c.action, c.label, r(c.x), r(c.y)].join(',')).join(';'),
    (v.icons || []).map(c => [c.action, r(c.x), r(c.y)].join(',')).join(';'),
    segs.map(s => [r(s.x1), r(s.y1), r(s.x2), r(s.y2)].join(',')).join(';'),
  ].join('|');
  const sig = crypto.createHash('md5').update(sigStr).digest('hex').slice(0, 10);
  return { overlap, dup, dangling, throughCard, crossings, cards: cards.length, width: Math.round(v.bounds.maxX - v.bounds.minX), sig };
};

/* ------------------------------------------------------------------ 场景 */
const byName = n => { const p = [...model.persons.values()].find(p => p.name === n) || [...model.persons.values()].find(p => p.name.startsWith(n)); if (!p) throw new Error('找不到人物：' + n); return p.key; };
const mk = (focus, f) => { const st = Core.defaultState(); if (f) f(st); return { focus, st }; };
const named = {
  // 来自你的截图与讨论的场景
  S1_王氏裴楷妻_双击裴楷: () => mk(byName('王氏（王浑女，裴楷妻）'), st => st.blocks.add(byName('裴楷'))),
  S2_裴楷_双击王氏裴楷妻: () => mk(byName('裴楷'), st => st.blocks.add(byName('王氏（王浑女，裴楷妻）'))),
  S3_司马炎_双击杨芷: () => mk(byName('司马炎'), st => st.blocks.add(byName('杨芷'))),
  S4_司马昭_双击王元姬: () => mk(byName('司马昭'), st => st.blocks.add(byName('王元姬'))),
  S5_司马懿_展开司马昭与王元姬: () => mk(byName('司马懿'), st => { const z = byName('司马昭'), y = byName('王元姬'); st.blocks.add(y); st.expSp.add(z + '|' + y); st.kidOpen.add(z + '|*'); }),
  S6_常山公主_双击王元姬: () => mk(byName('常山公主'), st => st.blocks.add(byName('王元姬'))),
  S7_司马炎_选中看王元姬上方加号: () => mk(byName('司马炎'), st => { }),
  // 极端场景
  A_司马炎_三位夫人家族块全开: () => mk(byName('司马炎'), st => ['杨艳', '杨芷', '赵粲'].forEach(n => st.blocks.add(byName(n)))),
  C_司马炎_十三个孩子全展开: () => { const sc = mk(byName('司马炎')); const v = Core.buildView(model, sc.focus, sc.st); v.chips.filter(c => /^kids:|^toggle:/.test(c.action)).forEach(c => { if (/^kids:/.test(c.action)) sc.st.kidOpen.add(c.action.slice(5)); else sc.st.open.set(c.action.slice(7), true); }); return sc; },
  D_卫玠_两位夫人家族块全开: () => mk(byName('卫玠'), st => { (model.marriagesByHusband.get(byName('卫玠')) || []).forEach(m => st.blocks.add(m.w)); }),
};
const sweeps = [];     // 每个人 × 若干种操作 × 两种"归并生母不详"策略
const openUp = (key, st, rounds) => {   // 把画面上所有"往上展开"的小圆点都点开
  let v = Core.buildView(model, key, st);
  for (let r = 0; r < rounds; r++) {
    v.chips.filter(c => /^up:/.test(c.action) && c.label !== '−').forEach(c => st.upOpen.add(c.action.slice(3)));
    v = Core.buildView(model, key, st);
  }
};
for (const p of model.persons.values()) {
  const key = p.key;
  for (const mu of [true, false]) {
    const tag = mu ? '' : '(不归并)';
    const M = f => () => { const sc = f(); sc.st.mergeUnknown = mu; return sc; };
    sweeps.push([`P:${key}:默认${tag}`, M(() => mk(key))]);
    sweeps.push([`P:${key}:往上展开${tag}`, M(() => { const sc = mk(key); sc.st.mergeUnknown = mu; openUp(key, sc.st, 2); return sc; })]);
    sweeps.push([`P:${key}:展开子女与配偶${tag}`, M(() => {
      const sc = mk(key); sc.st.mergeUnknown = mu; let v = Core.buildView(model, key, sc.st);
      for (let r = 0; r < 2; r++) {
        v.chips.filter(c => /^kids:/.test(c.action) && c.label !== '−').slice(0, 6).forEach(c => sc.st.kidOpen.add(c.action.slice(5)));
        v.icons.slice(0, 4).forEach(i => sc.st.expSp.add(i.action.slice(7)));
        v = Core.buildView(model, key, sc.st);
      }
      return sc;
    })]);
    if (mu) {   // 双击家族块两种操作只在默认策略下跑（和之前一致）
      sweeps.push([`P:${key}:双击一个家族`, () => { const sc = mk(key); const v = Core.buildView(model, key, sc.st); const c = v.cards.filter(c => c.dbl).map(c => c.key)[0]; if (c) sc.st.blocks.add(c); return sc; }]);
      sweeps.push([`P:${key}:双击全部家族`, () => { const sc = mk(key); const v = Core.buildView(model, key, sc.st); v.cards.filter(c => c.dbl).forEach(c => sc.st.blocks.add(c.key)); return sc; }]);
    } else {
      sweeps.push([`P:${key}:双击全部家族${tag}`, () => { const sc = mk(key); sc.st.mergeUnknown = false; const v = Core.buildView(model, key, sc.st); v.cards.filter(c => c.dbl).forEach(c => sc.st.blocks.add(c.key)); return sc; }]);
    }
  }
}

/* ------------------------------------------------------------------ 运行 */
const only = opt('--only');
const svgDir = opt('--svg');
const svgOf = svgDir ? require('./render.js') : null;
if (svgDir) fs.mkdirSync(svgDir, { recursive: true });
const results = {}, errors = [];
const run = (name, make, isNamed) => {
  if (only && !name.startsWith(only)) return;
  try {
    const sc = make(); const v = Core.buildView(model, sc.focus, sc.st);
    results[name] = metrics(v);
    if (svgDir && isNamed) fs.writeFileSync(path.join(svgDir, name + '.svg'), svgOf(v, name));
  } catch (e) { errors.push(name + '：' + e.message); results[name] = { error: 1 }; }
};
Object.entries(named).forEach(([n, f]) => run(n, f, true));
sweeps.forEach(([n, f]) => run(n, f, false));


/* ------------------------------------------------------------------ 语义不变量：小圆点上的 +N 必须等于点开后真正多出来的人数 */
const invariants = () => {
  let checked = 0; const miss = [];
  const keyOfCard = c => c.key + '|' + c.role + '|' + (c.adoptedOut ? 1 : 0);
  for (const mu of [true, false]) for (const p of model.persons.values()) {
    const st0 = Core.defaultState(); st0.mergeUnknown = mu;
    const v = Core.buildView(model, p.key, st0), before = new Set(v.cards.map(keyOfCard));
    v.chips.forEach(ch => {
      const up = /^up:/.test(ch.action), kid = /^kids:|^toggle:/.test(ch.action);
      if ((!up && !kid) || ch.label === '−' || !/^\+\d*$/.test(ch.label)) return;
      const n = ch.label === '+' ? 0 : parseInt(ch.label.slice(1));
      const st = Core.defaultState(); st.mergeUnknown = mu;
      if (up) st.upOpen.add(ch.action.slice(3)); else if (/^kids:/.test(ch.action)) st.kidOpen.add(ch.action.slice(5)); else st.open.set(ch.action.slice(7), true);
      const v2 = Core.buildView(model, p.key, st);
      const added = v2.cards.filter(c => !before.has(keyOfCard(c)) && (up ? (c.role !== 'ancestor' && c.role !== 'childSpouse') : c.role === 'child')).length;
      checked++; if (added !== n) miss.push(`${p.name}(${mu ? '归并' : '不归并'}) ${ch.action} 显示 ${ch.label}，实际 +${added}`);
    });
  }
  return { checked, miss };
};

/* ------------------------------------------------------------------ 状态分层不变量 */
// 1) 纯度：同一份意图重复渲染、中间穿插渲染别的画面，结果指纹必须完全相同；buildView 不得修改意图
// 2) 块的左右稳定：依次双击几个家族、中间展开别处的子女与配偶，已经定下的块不许翻边（对照：不记忆时会翻几次，仅供参考）
const snapState = st => JSON.stringify({ open: [...st.open], expSp: [...st.expSp], kidOpen: [...st.kidOpen], kidShut: [...(st.kidShut || [])], upOpen: [...st.upOpen], blocks: [...st.blocks], relOpen: [...st.relOpen], blockSide: [...(st.blockSide || [])], mu: st.mergeUnknown, ng: st.noGray });
const sigOf = v => metrics(v).sig;
const stateLayer = () => {
  const out = { purityChecked: 0, impure: [], mutated: [], sequences: 0, flipsPinned: 0, flipsUnpinned: 0 };
  const keys = [...model.persons.keys()];
  keys.forEach((key, i) => {
    if (i % 4 === 0) {                                   // 纯度：每 4 个人抽 1 个，用一份带双击家族的意图
      const sc = mk(key); let v = Core.buildView(model, key, sc.st); v.cards.filter(c => c.dbl).slice(0, 2).forEach(c => sc.st.blocks.add(c.key));
      const before = snapState(sc.st);
      const s1 = sigOf(Core.buildView(model, key, sc.st));
      Core.buildView(model, keys[(i + 7) % keys.length], Core.defaultState());           // 中间穿插渲染别人的画面
      const s2 = sigOf(Core.buildView(model, key, sc.st));
      out.purityChecked++;
      if (s1 !== s2) out.impure.push(model.persons.get(key).name);
      if (snapState(sc.st) !== before) out.mutated.push(model.persons.get(key).name);
    }
    for (const pin of [true, false]) {
      const st = Core.defaultState();
      let v = Core.buildView(model, key, st); const cand = v.cards.filter(c => c.dbl).map(c => c.key).slice(0, 3);
      if (cand.length < 2) continue;
      if (pin) out.sequences++;
      const sides = new Map(); let flips = 0;
      cand.forEach(k => {
        st.blocks.add(k);
        for (let step = 0; step < 2; step++) {
          v = Core.buildView(model, key, st); if (pin) Core.commitPins(v, st);
          v.sidesDecided.forEach((sd, j) => { if (sides.has(j) && sides.get(j) !== sd) flips++; if (!sides.has(j)) sides.set(j, sd); });
          if (step === 0) { v.chips.filter(c => /^kids:/.test(c.action) && c.label !== '−').slice(0, 6).forEach(c => st.kidOpen.add(c.action.slice(5))); v.icons.slice(0, 4).forEach(c => st.expSp.add(c.action.slice(7))); }
        }
      });
      if (pin) out.flipsPinned += flips; else out.flipsUnpinned += flips;
    }
  });
  return out;
};

/* ------------------------------------------------------------------ 汇总 */
const names = Object.keys(results).filter(n => !results[n].error);
const sum = k => names.reduce((a, n) => a + results[n][k], 0);
const nz = k => names.filter(n => results[n][k] > 0).length;
const p95 = k => { const a = names.map(n => results[n][k]).sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)] || 0; };
const agg = {
  scenarios: names.length, errors: errors.length,
  overlap: sum('overlap'), dup: sum('dup'), dangling: sum('dangling'), throughCard: sum('throughCard'), crossings: sum('crossings'),
  scenariosWithOverlap: nz('overlap'), scenariosWithDup: nz('dup'), scenariosWithDangling: nz('dangling'), scenariosWithThroughCard: nz('throughCard'),
  widthP95: p95('width'), widthMax: Math.max(...names.map(n => results[n].width)),
};
console.log('— 当前结果 —');
console.log(`场景数 ${agg.scenarios}（报错 ${agg.errors}）`);
console.log(`卡片重叠        合计 ${agg.overlap}    涉及场景 ${agg.scenariosWithOverlap}`);
console.log(`重复卡片        合计 ${agg.dup}    涉及场景 ${agg.scenariosWithDup}`);
console.log(`悬空线端点      合计 ${agg.dangling}    涉及场景 ${agg.scenariosWithDangling}`);
console.log(`线穿卡片        合计 ${agg.throughCard}    涉及场景 ${agg.scenariosWithThroughCard}`);
console.log(`线线交叉(仅记录) 合计 ${agg.crossings}`);
console.log(`画面宽度        P95 ${agg.widthP95}px   最大 ${agg.widthMax}px`);
const inv = only ? null : invariants();
const sl = only ? null : stateLayer();
if (sl) console.log(`状态分层  纯度检查 ${sl.purityChecked}（不纯 ${sl.impure.length}，意图被修改 ${sl.mutated.length}）；块左右稳定 ${sl.sequences} 条序列，翻边 ${sl.flipsPinned} 次（对照：不记忆时翻边 ${sl.flipsUnpinned} 次）`);
if (inv) console.log(`+N 与实际展开人数一致  检查 ${inv.checked} 个小圆点，不一致 ${inv.miss.length}`);
console.log('— 命名场景 —');
Object.keys(named).forEach(n => { const r = results[n]; if (r && !r.error) console.log(`  ${n.padEnd(28)} 重叠${r.overlap} 重复${r.dup} 悬空${r.dangling} 穿卡${r.throughCard} 交叉${r.crossings} 宽${r.width}`); else if (r) console.log('  ' + n + '  报错'); });
errors.slice(0, 5).forEach(e => console.log('  报错：' + e));

if (flag('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify({ note: '由 regress.js --update 生成；只在确认变好之后更新', agg, results }, null, 0));
  console.log('\n已写入基线：' + BASELINE);
  process.exit(0);
}
if (!fs.existsSync(BASELINE)) { console.log('\n还没有基线：先运行 node regress.js --update'); process.exit(2); }

/* ------------------------------------------------------------------ 对比 */
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).results;
const FAIL = ['overlap', 'dup', 'dangling', 'throughCard'];      // 变多＝变差，直接判失败
const WARN = ['crossings'];                                      // 变多只提醒
const bad = [], warn = [], better = [], changed = [];
if (inv) inv.miss.forEach(m => bad.push('+N 不一致：' + m));
if (sl) { sl.impure.forEach(n => bad.push('同一意图重复渲染结果不同：' + n)); sl.mutated.forEach(n => bad.push('buildView 修改了意图：' + n)); if (sl.flipsPinned) bad.push('块翻边（已记忆仍翻）：' + sl.flipsPinned + ' 次'); }
Object.keys(results).forEach(n => {
  const c = results[n], b = base[n];
  if (!b) { warn.push(n + '：基线里没有这个场景（新增）'); return; }
  if (c.error && !b.error) { bad.push(n + '：新增报错'); return; }
  if (c.error || b.error) return;
  if (b.sig && c.sig !== b.sig) changed.push(n);
  FAIL.forEach(k => { if (c[k] > b[k]) bad.push(`${n}：${k} ${b[k]} → ${c[k]}`); else if (c[k] < b[k]) better.push(`${n}：${k} ${b[k]} → ${c[k]}`); });
  WARN.forEach(k => { if (c[k] > b[k]) warn.push(`${n}：${k} ${b[k]} → ${c[k]}`); else if (c[k] < b[k]) better.push(`${n}：${k} ${b[k]} → ${c[k]}`); });
  if (c.width > b.width * 1.05 + 20) warn.push(`${n}：宽度 ${b.width} → ${c.width}`);
  else if (c.width < b.width * 0.95 - 20) better.push(`${n}：宽度 ${b.width} → ${c.width}`);
});
Object.keys(base).forEach(n => { if (!(n in results) && !only) warn.push(n + '：基线里有、这次没跑到'); });
const show = (title, a) => { if (a.length) { console.log(`\n${title}（${a.length}）`); a.slice(0, 15).forEach(x => console.log('  ' + x)); if (a.length > 15) console.log(`  …还有 ${a.length - 15} 条`); } };
if (flag('--strict')) changed.forEach(n => bad.push(n + '：布局指纹变了（--strict：纯重构不应有任何视觉变化）'));
if (changed.length) console.log(`\n布局指纹有变化的场景：${changed.length} / ${Object.keys(results).length}${flag('--strict') ? '' : '（加 --strict 可当作失败）'}`);
show('变差（必须修）', bad); show('提醒', warn); show('变好（确认无误后可 --update 更新基线）', better);
if (!bad.length) console.log(`\n通过：没有指标变差${better.length ? '，另有 ' + better.length + ' 项变好' : ''}。`);
process.exit(bad.length ? 1 : 0);
