#!/usr/bin/env node
/**
 * 「AI 味」体检：数一遍正文里的固定腔调，给出可比较的数字。
 *
 *   node tools/style_audit.js              # 全站汇总 + 每个分析页一行
 *   node tools/style_audit.js vllm         # 只看一页，列出每个模块
 *   node tools/style_audit.js --json       # 机读
 *   node tools/style_audit.js --guard      # 只做「不许退化」检查（给 CI 用）
 *
 * 为什么要先有工具：改文风最容易变成「凭感觉改了一轮，说不清好在哪、也没法防止
 * 下一轮又写回去」。这里把要消掉的东西变成**可数的指标**，改之前存一份基线，
 * 改完对比；顺便在 CI 里挡住回退。
 *
 * 计数口径（很重要，不然数字没意义）：
 *   · 只数**正文**——代码围栏 ~~~ 与手绘 SVG 整段排除；
 *   · %%标识符%% 排除（那是代码名字，不是措辞）；
 *   · 路径:行号 排除（改了会破坏锚点）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'data', 'analyses.js'));

const TICS = [
  // [显示名, 正则, 说明]
  ['接缝', /接缝/g, '行话。多数场合「接口 / 边界 / 交界」更直白'],
  ['负责(公式化)', /\|\s*\*{0,2}不?负责\*{0,2}\s*\||^#{2,4}[^\n]*负责[^\n]*$|\*\*它不?负责什么\*\*[：:]/gm, '被当成模板的章节标题与表格标签；散文里的「引擎负责注册」不算'],
  ['一句话', /一句话/g, '千篇一律的开场套话'],
  ['值得注意', /值得注意(的是)?/g, '强调虚壳，后面跟的往往是常识'],
  ['真正的', /真正的/g, '强调虚壳，删掉通常不损失信息'],
  ['而是', /而是/g, '「不是…而是…」排比模板，密了就成腔'],
  ['这就是', /这就是/g, '金句式收尾'],
  ['这正是', /这正是/g, '金句式收尾'],
  ['本质上', /本质上/g, '模糊语气'],
  ['其实', /其实/g, '模糊语气'],
  ['综上/首先其次', /综上所述|总而言之|首先，|其次，/g, '八股连接词'],
  ['非常/十分/极其', /非常|十分|极其/g, '程度副词刷量'],
];

/* 正文提取：去掉围栏、SVG、行内代码、路径:行号 */
function prose(text) {
  return String(text)
    .replace(/~~~[a-z]*\n[\s\S]*?\n~~~/g, '')      // 代码围栏（逐字校验的，不算措辞）
    .replace(/<svg[\s\S]*?<\/svg>/g, '')           // 手绘 SVG
    .replace(/%%[^%]+%%/g, '')                     // 行内代码里的标识符
    .replace(/[\w./-]+\.(?:py|cpp|h|go|cu|cuh|js|ts|md|json|yaml|yml|sh|toml|rs|java|proto):\d+/g, '') // 路径:行号
    .replace(/:\d+(?=[\s，。、)）]|$)/g, '');       // 裸 :行号
}

function collectFields(node, out = []) {
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') {
        if (['summary', 'modulesLead', 'lead', 'html', 'title', 'subtitle'].includes(k)) out.push(v);
      } else collectFields(v, out);
    }
  } else if (Array.isArray(node)) node.forEach(x => collectFields(x, out));
  return out;
}

function audit(text) {
  const p = prose(text);
  const r = {};
  for (const [name, re] of TICS) {
    const m = p.match(re);
    r[name] = m ? m.length : 0;
  }
  r['_字数(千字)'] = +(p.replace(/\s/g, '').length / 1000).toFixed(1);
  r['_锚点(路径:行号)'] = (String(text).match(/[\w./-]+\.(?:py|cpp|h|go|cu|cuh|js|ts|md|json|yaml|yml|sh|toml|rs|java|proto):\d+/g) || []).length;
  return r;
}

function merge(a, b) {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
  return a;
}

const ANALYSES = global.window.WIKI_ANALYSES || [];
const only = process.argv.find(x => !x.startsWith('-') && x !== process.argv[0] && x !== process.argv[1] && ANALYSES.some(a => a.id === x));

const per = {}, total = {};
for (const a of ANALYSES) {
  if (only && a.id !== only) continue;
  const mods = {};
  for (const m of a.modules || []) {
    const r = audit(collectFields(m).join('\n'));
    mods[m.id] = r;
    merge(per[a.id] = per[a.id] || {}, r);
    merge(total, r);
  }
  per[a.id]._modules = mods;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, per }, null, 2));
  process.exit(0);
}

const TIC_NAMES = TICS.map(t => t[0]);
const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n);

if (only) {
  console.log(`\n${only} —— 逐模块（只列非零项）\n`);
  const mods = per[only]._modules;
  const w = Math.max(...Object.keys(mods).map(k => k.length), 12);
  console.log(pad('模块', w) + '  ' + TIC_NAMES.map(n => num(n, n.length > 4 ? 8 : 6)).join(''));
  for (const [id, r] of Object.entries(mods)) {
    const cells = TIC_NAMES.map(n => num(r[n] || 0, n.length > 4 ? 8 : 6));
    if (cells.every(c => c.trim() === '0')) continue;
    console.log(pad(id, w) + '  ' + cells.join(''));
  }
  console.log('');
}

console.log('\n全站汇总\n');
const w = Math.max(...TIC_NAMES.map(n => n.length));
for (const n of TIC_NAMES) {
  console.log('  ' + pad(n, w) + '  ' + num(total[n] || 0, 6) + '   ' +
    (TICS.find(t => t[0] === n)[2] || ''));
}
console.log('  ' + pad('正文规模', w) + '  ' + num(total['_字数(千字)'].toFixed(1) + ' 千字', 6));
console.log('  ' + pad('锚点总数', w) + '  ' + num(total['_锚点(路径:行号)'], 6) +
  '   ← 只许增不许减');

console.log('\n分页\n');
const pw = Math.max(...Object.keys(per).map(k => k.length));
console.log('  ' + pad('分析页', pw) + '  ' + TIC_NAMES.slice(0, 6).map(n => num(n, 7)).join('') + num('千字', 7));
for (const [id, r] of Object.entries(per)) {
  console.log('  ' + pad(id, pw) + '  ' + TIC_NAMES.slice(0, 6).map(n => num(r[n] || 0, 7)).join('') +
    num(r['_字数(千字)'].toFixed(1), 7));
}

/* --guard：与基线比，任何一项涨了就失败——给 CI 用 */
if (process.argv.includes('--guard')) {
  const bp = path.join(ROOT, 'tools', 'style-baseline.json');
  if (!fs.existsSync(bp)) {
    console.log('\n（还没有基线：先跑 node tools/style_audit.js --snapshot 生成）');
    process.exit(0);
  }
  const base = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const worse = [];
  for (const n of TIC_NAMES) {
    if ((total[n] || 0) > (base.total[n] || 0)) {
      worse.push(`${n}: ${base.total[n] || 0} → ${total[n]}`);
    }
  }
  if ((total['_锚点(路径:行号)'] || 0) < (base.total['_锚点(路径:行号)'] || 0)) {
    worse.push(`锚点变少了：${base.total['_锚点(路径:行号)']} → ${total['_锚点(路径:行号)']}`);
  }
  if (worse.length) {
    console.log('\n❌ 文风指标退化：');
    worse.forEach(x => console.log('   ' + x));
    process.exit(1);
  }
  console.log('\n✅ 文风指标没有退化');
}
