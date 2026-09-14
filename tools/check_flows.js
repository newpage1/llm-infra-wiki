#!/usr/bin/env node
/**
 * 联动分析（data/flows.js）的锚点校验。
 *
 *   node tools/check_flows.js --root /path/to/checkouts
 *   node tools/check_flows.js --root .anchor-cache
 *
 * 为什么单独一个工具：`tools/verify-anchors.sh` 只对 data/analyses.js 逐页跑
 * check_module.js，**flows.js 从来没被校验过**。于是联动分析里的 `路径:行号`
 * 可以随便写——这跟「联动分析也要有代码依据」是矛盾的。
 *
 * 做法：把每个锚点的路径拿去各个检出里找，找到就核行号是否落在文件范围内，
 * 并打印那一行让人核对。多个检出都有同名路径时全部列出，不猜。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'data', 'flows.js'));

/* 检出目录名 → 仓库根。顺序有意义：先试更具体的。 */
const DEFAULT_ROOTS = [
  'lmcache-ascend-combined',
  'vllm-ascend-review',
  'vllm-review',
  'lmcache-latest-review',
  'lmcache-review',
  'mooncake-review',
];

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const BASE = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1])
  : path.resolve(ROOT, '..', 'codex');
const verbose = argv.includes('-v');

const ANCHOR = /([\w./+-]+\.(?:py|cpp|cc|h|hpp|cu|cuh|go|rs|proto|cmake|sh|md)):(\d+)/g;

/* 把所有字符串字段摊平，顺便记下它属于哪个 flow / 哪条腿，报错时能定位 */
function walk(node, at, out) {
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) walk(node[k], at + '.' + k, out);
  } else if (Array.isArray(node)) {
    node.forEach((x, i) => walk(x, at + '[' + i + ']', out));
  } else if (typeof node === 'string') {
    out.push([at, node]);
  }
}

const roots = DEFAULT_ROOTS
  .map(d => path.join(BASE, d))
  .filter(d => fs.existsSync(d));

if (!roots.length) {
  console.log(`\n⚠️  在 ${BASE} 下没找到任何检出，无法校验。`);
  console.log('   用 --root 指到放检出的目录。\n');
  process.exit(0);
}

let total = 0, bad = 0, ambiguous = 0, missing = 0;
const flows = global.window.WIKI_FLOWS || [];

for (const f of flows) {
  const texts = [];
  walk(f, 'flow:' + f.id, texts);
  const seen = new Set();
  const rows = [];
  for (const [at, s] of texts) {
    for (const m of String(s).matchAll(ANCHOR)) {
      const key = m[1] + ':' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([key, m[1], +m[2], at]);
    }
  }
  let fbad = 0, fmiss = 0, famb = 0;
  const lines = [];
  for (const [key, rel, ln, at] of rows) {
    total++;
    const hits = roots.filter(r => fs.existsSync(path.join(r, rel)));
    if (!hits.length) {
      missing++; fmiss++;
      lines.push(`  ✗ 找不到文件  ${key}   (${at})`);
      continue;
    }
    if (hits.length > 1) {
      ambiguous++; famb++;
      if (verbose) {
        lines.push(`  ? 多个检出都有 ${key}：${hits.map(h => path.basename(h)).join(', ')}`);
      }
    }
    const r = hits[0];
    const n = fs.readFileSync(path.join(r, rel), 'utf8').split('\n').length;
    if (ln < 1 || ln > n) {
      bad++; fbad++;
      lines.push(`  ✗ 行号越界  ${key}  （${path.basename(r)} 只有 ${n} 行）  (${at})`);
    } else if (verbose) {
      const src = fs.readFileSync(path.join(r, rel), 'utf8').split('\n')[ln - 1];
      lines.push(`  · ${key.padEnd(58)} ${src.trim().slice(0, 70)}`);
    }
  }
  const mark = fbad || fmiss ? '❌' : '✅';
  // 联动分析的价值在于「每一步都能指到代码」。只写文件名不写行号的步骤，
  // 读的人没法核，也说明作者没真去读那一段。
  const bare = [];
  for (const leg of (f.legs || [])) {
    (leg.steps || []).forEach((st, i) => {
      const a = String(st.a || '');
      if (a === '同上' || /^同上:/.test(a)) return;      // 承前，允许
      if (!/:\d+/.test(a)) bare.push(`${leg.id}[${i}] ${a || '(空)'}`);
    });
  }
  console.log(`${mark} ${f.id.padEnd(18)} 锚点 ${String(rows.length).padStart(4)}  ` +
    `越界 ${fbad}  缺文件 ${fmiss}  多检出 ${famb}  无行号步骤 ${bare.length}`);
  if (bare.length) console.log('     无行号的步骤：' + bare.slice(0, 6).join(' | ') +
    (bare.length > 6 ? ` …另有 ${bare.length - 6} 个` : ''));
  if (lines.length) console.log(lines.join('\n'));
}

console.log(`\n合计：${total} 个锚点 · 行号越界 ${bad} · 找不到文件 ${missing} · 多检出 ${ambiguous}`);
if (missing) {
  console.log('（找不到文件的锚点，要么路径写错，要么那条腿引的仓库不在 --root 下）');
}
process.exit(bad || missing ? 1 : 0);
