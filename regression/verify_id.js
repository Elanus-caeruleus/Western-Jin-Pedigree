#!/usr/bin/env node
// 验证 core.js 的稳定 id 是否解决了动画配对错乱。
//   1) 每个画面内 id 唯一；
//   2) 卫恒 + 展开妻子王氏（王浑女，卫恒妻）→ toggle 卫玠：按 id 配对后位移卡应为 0，只有卫玠出现/消失；
//   3) 批量：对每个人物的默认画面，把画面里每个 kids:/toggle:/up: 小圆点各点一次，统计按 id 配对后位移的卡数（预期中位数 0）；
//   4) 列出"按 id 配对仍 ≥3 张卡位移"的转场（只报告，不改）。
'use strict';
const path = require('path');
const Core = require(path.resolve(__dirname, '../core.js'));
const raw = require(path.resolve(__dirname, '../data.json'));
const model = Core.buildModel(raw);

const byName = n => [...model.persons.values()].find(p => p.name === n);
const keyOf = n => { const p = byName(n); if (!p) throw new Error('找不到人物：' + n); return p.key; };

// —— 每个画面内 id 唯一性 ——
function checkUniq(views) {
  let bad = 0;
  views.forEach(v => {
    const seen = new Map();
    v.cards.forEach(c => {
      const k = c.id;
      if (seen.has(k)) { bad++; console.log('  [重复 id]', k, '出现于', seen.get(k), '和', c.key + '/' + (c.role || '') + (c.adoptedOut ? '|out' : '')); }
      else seen.set(k, c.key + '/' + (c.role || '') + (c.adoptedOut ? '|out' : ''));
    });
  });
  return bad;
}

// —— 按 id 配对统计位移（出现/消失的卡不算位移）——
const moved = (a, b) => {
  const m = new Map(); a.cards.forEach(c => m.set(c.id, c));
  const details = [];
  b.cards.forEach(c => {
    const o = m.get(c.id);
    if (o) { const d = Math.hypot(o.x - c.x, o.y - c.y); if (d > 1) details.push([c.id, Math.round(d * 10) / 10, c.key]); }
  });
  const appear = b.cards.filter(c => !m.has(c.id));
  const vanish = a.cards.filter(c => !b.cards.some(x => x.id === c.id));
  return { moved: details.length, details, appear: appear.length, vanish: vanish.length };
};

const TARGET = /^(kids:|toggle:|up:)/;

// —— id 唯一性：收集多个画面，检查重复 ——
const fs = require('fs');
const dupCollect = { count: 0, examples: [] };
function idUniq(v) {
  const seen = new Map();
  v.cards.forEach(c => { if (seen.has(c.id)) { dupCollect.count++; if (dupCollect.examples.length < 10) dupCollect.examples.push(c.id + ' ← ' + seen.get(c.id) + ' 与 ' + c.key + '/' + (c.role || '')); } else seen.set(c.id, c.key + '/' + (c.role || '')); });
}

// 卫恒专项
console.log('=== 卫恒 + 王氏（王浑女，卫恒妻），toggle 卫玠 ===');
{
  const focus = keyOf('卫恒');
  const st = Core.defaultState();
  st.blocks.add(keyOf('王氏（王浑女，卫恒妻）'));
  const v0 = Core.buildView(model, focus, st);
  idUniq(v0);
  const candidates = v0.chips.filter(c => TARGET.test(c.action));
  let hit = null;
  for (const ch of candidates) {
    const sb = Core.defaultState(); sb.blocks.add(keyOf('王氏（王浑女，卫恒妻）'));
    if (/^kids:/.test(ch.action)) sb.kidOpen.add(ch.action.slice(5));
    else if (/^up:/.test(ch.action)) sb.upOpen.add(ch.action.slice(3));
    else sb.open.set(ch.action.slice(7), !v0.openMap[ch.action.slice(7)]);
    const vb = Core.buildView(model, focus, sb);
    const hasWJ0 = v0.cards.some(c => c.key === keyOf('卫玠'));
    const hasWJ1 = vb.cards.some(c => c.key === keyOf('卫玠'));
    if (hasWJ0 !== hasWJ1) { hit = { ch: ch.action, res: moved(v0, vb), a: hasWJ0, b: hasWJ1 }; break; }
  }
  if (!hit) console.log('  未找到能让卫玠出现/消失的小圆点（请人工确认卫玠在此画面的显示逻辑）');
  else {
    console.log(`  小圆点 ${hit.ch}：卫玠 ${hit.a ? '有→' : '无→'}${hit.b ? '有' : '无'}`);
    console.log(`  按 id 配对后位移卡数 = ${hit.res.moved}（应=0）; 出现 ${hit.res.appear} 张, 消失 ${hit.res.vanish} 张`);
    if (hit.res.details.length) console.log('  位移明细:', JSON.stringify(hit.res.details));
  }
}

// 卫恒专项（补充：对整个卫恒画面所有转场都看一遍，报告所有 ≥3 位移的）
{
  const focus = keyOf('卫恒');
  const st = Core.defaultState(); st.blocks.add(keyOf('王氏（王浑女，卫恒妻）'));
  const v0 = Core.buildView(model, focus, st);
  console.log(`\n=== 卫恒 全部 ${v0.chips.filter(c => TARGET.test(c.action)).length} 个小圆点转场，≥3 张位移者 ===`);
  const bad = [];
  v0.chips.filter(c => TARGET.test(c.action)).forEach(ch => {
    const sb = Core.defaultState(); sb.blocks.add(keyOf('王氏（王浑女，卫恒妻）'));
    if (/^kids:/.test(ch.action)) sb.kidOpen.add(ch.action.slice(5));
    else if (/^up:/.test(ch.action)) sb.upOpen.add(ch.action.slice(3));
    else sb.open.set(ch.action.slice(7), !v0.openMap[ch.action.slice(7)]);
    const vb = Core.buildView(model, focus, sb);
    const r = moved(v0, vb);
    if (r.moved >= 3) bad.push({ ch: ch.action, n: r.moved, who: r.details });
  });
  if (!bad.length) console.log('  （无）');
  bad.forEach(b => console.log(`  ${b.ch}  位移 ${b.n} 张: ${JSON.stringify(b.who)}`));
}

// 批量
console.log('\n=== 批量：每个默认画面点开/点关每个小圆点，按 id 配对统计位移 ===');
{
  const all = [];
  for (const p of model.persons.values()) {
    const focus = p.key;
    const st0 = Core.defaultState();
    let v0;
    try { v0 = Core.buildView(model, focus, st0); } catch (e) { continue; }
    const targets = v0.chips.filter(c => TARGET.test(c.action));
    for (const ch of targets) {
      const sb = Core.defaultState();
      if (/^kids:/.test(ch.action)) sb.kidOpen.add(ch.action.slice(5));
      else if (/^up:/.test(ch.action)) sb.upOpen.add(ch.action.slice(3));
      else sb.open.set(ch.action.slice(7), !v0.openMap[ch.action.slice(7)]);
      let vb;
      try { vb = Core.buildView(model, focus, sb); } catch (e) { continue; }
      idUniq(v0); idUniq(vb);
      const r = moved(v0, vb);
      all.push({ focus: p.name, ch: ch.action, moved: r.moved, details: r.details, appear: r.appear, vanish: r.vanish });
    }
  }
  const nums = all.map(x => x.moved).sort((a, b) => a - b);
  const median = nums.length ? nums[Math.floor(nums.length / 2)] : 0;
  const over0 = all.filter(x => x.moved > 0).length;
  const ge3 = all.filter(x => x.moved >= 3);
  console.log(`转场总数 ${all.length}`);
  console.log(`位移卡数中位数 ${median}（应=0）；>0 的转场 ${over0} 个；≥3 的转场 ${ge3.length} 个`);
  console.log(`画面内 id 重复：${dupCollect.count} 处` + (dupCollect.examples.length ? '\n  例: ' + dupCollect.examples.join(' | ') : ''));
  if (ge3.length) {
    const lines = ge3.map(g => `- [${g.focus}] ${g.ch}  位移 ${g.moved} 张  出现${g.appear}/消失${g.vanish}\n  ${g.details.map(d => d[2] + '→' + d[1] + 'px').join(', ')}`);
    const report = `# 按 id 配对仍 ≥3 张卡位移的转场（共 ${ge3.length} / ${all.length}）\n\n这些是排版本身的真实位移（展开/折叠子女后左右邻居被真实推开），非 id 配对错误。\n\n` + lines.join('\n') + '\n';
    fs.writeFileSync(path.join(__dirname, 'id_motion_report.md'), report, 'utf8');
    console.log(`\n完整报告已写入 regression/id_motion_report.md`);
    console.log('\n— 前 20 个 ≥3 张卡位移的转场 —');
    ge3.slice(0, 20).forEach(g => console.log(`  [${g.focus}] ${g.ch}  位移 ${g.moved} 张: ${JSON.stringify(g.details.map(d => d[2] + '→' + d[1] + 'px'))}  出现${g.appear}/消失${g.vanish}`));
  } else console.log('（无 ≥3 的转场）');
}
