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
/* 分析页与组件详情页都要数。曾经只数 analyses.js，于是 details.js 里的行话
   （例如「接缝」）从来没进过指标，--guard 也拦不住——这是工具的盲区，不是内容的。
   WIKI_ANALYSES 是隔离改写用的临时单页副本；设了就只量它，别把全站混进来。
   （原先还数 flows.js，联动分析那一块拆掉后就不再需要了。） */
const ISOLATED = process.env.WIKI_ANALYSES;
const FILES = ISOLATED
  ? [ISOLATED]
  : ['analyses.js', 'details.js', 'details-ascend.js',
     'details-nvidia.js', 'details-outline.js']
      .map(f => path.join(ROOT, 'data', f));
for (const f of FILES) require(f);

const TICS = [
  // [显示名, 正则, 说明]
  ['接缝', /接缝/g, '行话。多数场合「接口 / 边界 / 交界」更直白'],
  ['负责(公式化)', /\|\s*\*{0,2}不?负责\*{0,2}\s*\||^#{2,4}[^\n]*负责[^\n]*$|\*\*它不?负责什么\*\*[：:]/gm, '被当成模板的章节标题与表格标签；散文里的「引擎负责注册」不算'],
  ['一句话', /(?<![成用有是的])一句话(?:定位|概括|总结)|(?<![成用有是的])一句话[：:]/g,
   '当成标题或开场套话。前面是「写成 / 用 / 有」的**叙述句**不算——'
   + '例如「它的 docstring 把它写成一句话：…」说的是别人写了什么，不是自己在起标题'],
  ['值得注意', /值得注意(的是)?/g, '强调虚壳，后面跟的往往是常识'],
  ['真正的', /真正的/g, '强调虚壳，删掉通常不损失信息'],
  ['而是', /而是/g, '「不是…而是…」排比模板，密了就成腔'],
  ['这就是', /这就是/g, '金句式收尾'],
  ['这正是', /这正是/g, '金句式收尾'],
  ['本质上', /本质上/g, '模糊语气'],
  ['其实', /其实/g, '模糊语气'],
  ['综上/首先其次', /综上所述|总而言之|首先，|其次，/g, '八股连接词'],
  ['非常/十分/极其', /非常|十分|极其/g, '程度副词刷量'],
  ['这也解释了', /这(也)?解释了/g, '「这解释了为什么…」的推论腔'],
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
        // a/why/from/to/name 是详情页表格的锚点与表头字段：本身没有措辞，
        // 但带着路径:行号，收进来锚点总数才完整（prose() 会把路径剥掉）。
        if (['summary', 'modulesLead', 'lead', 'html', 'title', 'subtitle', 'h3',
             'caption', 'note', 't', 'group', 'a', 'why', 'from', 'to', 'name',
             'reading', 'overview', 'scope', 'notCovered'].includes(k)) out.push(v);
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
  const chars = p.replace(/\s/g, '').length || 1;
  r['_字数(千字)'] = +(chars / 1000).toFixed(1);
  // 密度指标：de-slopify 与 Wikipedia 都把「破折号过量」列为文档类写作的第一号 AI 标志，
  // 「粗体机械强调」单列一节。绝对值没意义（页面大小不同），所以按千字归一。
  // 先累加分子分母，密度在全部合并完之后再算——直接把每个模块的密度相加是错的
  r['_破折号数'] = (p.match(/——/g) || []).length;
  r['_粗体数'] = (p.match(/\*\*/g) || []).length / 2;
  r['_正文字数'] = chars;
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

/* 组件详情页同样在读者面前，指标必须一起算。
   per 的键加前缀，免得和同名的分析页（例如 vllm）互相覆盖。 */
if (!ISOLATED) {
  for (const [cid, d] of Object.entries(global.window.WIKI_DETAILS || {})) {
    merge(total, merge(per['详情:' + cid] = per['详情:' + cid] || {},
      audit(collectFields(d).join('\n'))));
  }
}

const TIC_NAMES = TICS.map(t => t[0]);

/* 密度指标不能逐模块相加，要由总量算 */
function finishDensity(o) {
  const c = o['_正文字数'] || 1;
  o['_破折号/千字'] = +((o['_破折号数'] || 0) / c * 1000).toFixed(2);
  o['_粗体/千字'] = +((o['_粗体数'] || 0) / c * 1000).toFixed(2);
  return o;
}

/* 密度必须在这里算完——--snapshot 与 --guard 都要读它 */
finishDensity(total);
Object.values(per).forEach(finishDensity);

/* --snapshot：把当前指标存成基线，之后 --guard 据它判断有没有退化 */
if (process.argv.includes('--snapshot')) {
  const bp = path.join(ROOT, 'tools', 'style-baseline.json');
  fs.writeFileSync(bp, JSON.stringify({ savedAt: new Date().toISOString(), total }, null, 2));
  console.log(`已写入基线 ${path.relative(ROOT, bp)}`);
  for (const n of TIC_NAMES) console.log(`  ${n}: ${total[n] || 0}`);
  console.log(`  锚点: ${total['_锚点(路径:行号)']}`);
  process.exit(0);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, per }, null, 2));
  process.exit(0);
}

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
for (const n of ['_破折号/千字', '_粗体/千字']) {
  console.log('  ' + pad(n.replace(/^_/, ''), w) + '  ' + num(total[n].toFixed(2), 6) +
    '   ← 密度，只许降不许升（de-slopify / Wikipedia 列为文档类首号标志）');
}

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
  for (const n of ['_破折号/千字', '_粗体/千字']) {
    const b = (base.total[n] ?? 0), c = (total[n] ?? 0);
    if (c > b + 0.02) worse.push(`${n.replace(/^_/, '')} 密度涨了：${b} → ${c}`);
  }
  if (worse.length) {
    console.log('\n❌ 文风指标退化：');
    worse.forEach(x => console.log('   ' + x));
    process.exit(1);
  }
  console.log('\n✅ 文风指标没有退化');
}
