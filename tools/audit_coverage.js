#!/usr/bin/env node
/**
 * 覆盖审计：一个分析页声明覆盖的代码里，哪些目录**从没被引用过**。
 *
 *   node tools/audit_coverage.js vllm
 *   node tools/audit_coverage.js vllm vllm-ascend
 *
 * 做法：把页面所有模块里出现的路径 token 收集起来（`%%…%%`、代码围栏里的路径、
 * `files` 字段），拿它去比对仓库里真实存在的 .py 文件，按目录汇总算出「被引用的文件数 / 总文件数」。
 *
 * 为什么需要它：模块是按「逻辑职责」切的，而代码是按目录放的，两者未必对齐。
 * 一个 `parallel` 模块可能顺带把 `distributed/eplb/` 也讲了，也可能只提了它的名字——
 * 光看模块列表看不出来。这个脚本给出的是「按目录的覆盖率」。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'data', 'analyses.js'));

const CHECKOUTS = {
  mooncake: '/Users/hexiaoying/workspace/codex/mooncake-review',
  lmcache: '/Users/hexiaoying/workspace/codex/lmcache-review',
  'lmcache-ascend': '/Users/hexiaoying/workspace/codex/lmcache-ascend-combined',
  vllm: '/Users/hexiaoying/workspace/codex/vllm-review',
  'vllm-ascend': '/Users/hexiaoying/workspace/codex/vllm-ascend-review',
  sglang: '/Users/hexiaoying/workspace/codex/sglang-review',
};

/* 明确不覆盖的目录（用户口径：benchmark / CI / test）。 */
const SKIP = /(^|\/)(tests?|benchmarks?|examples?|docs?|scripts?|docker|\.github|third_party)(\/|$)/;

function collectStrings(n, out = []) {
  if (n && typeof n === 'object') for (const k of Object.keys(n)) collectStrings(n[k], out);
  else if (Array.isArray(n)) n.forEach(x => collectStrings(x, out));
  else if (typeof n === 'string') out.push(n);
  return out;
}

const ids = process.argv.slice(2).filter(x => !x.startsWith('-'));
for (const id of ids) {
  const page = global.window.WIKI_ANALYSES.find(a => a.id === id);
  const repo = CHECKOUTS[id];
  if (!page || !repo) { console.log(`跳过 ${id}（没有页或没有检出映射）`); continue; }

  const texts = collectStrings(page, []);
  const blob = texts.join('\n');
  // 路径 token：带 .py 后缀的相对路径
  const cited = new Set();
  for (const m of blob.matchAll(/[\w./+-]+\.py\b/g)) {
    let t = m[0].replace(/^\.\//, '');
    cited.add(t);
    // 也收后缀匹配用的 basename，便于「模块内相对路径」的写法
    cited.add(t.split('/').pop());
  }

  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(f => f.endsWith('.py') && !SKIP.test(f));

  const byDir = new Map();
  let hit = 0;
  for (const f of files) {
    const d = path.dirname(f);
    const base = f.split('/').pop();
    const ok = cited.has(f) || cited.has(base);
    if (ok) hit++;
    const e = byDir.get(d) || { n: 0, hit: 0, samples: [] };
    e.n++;
    if (ok) e.hit++;
    else if (e.samples.length < 3) e.samples.push(base);
    byDir.set(d, e);
  }

  const total = files.length;
  console.log(`\n=== ${id}  ${hit}/${total} 个 .py 文件被引用（${(hit / total * 100).toFixed(1)}%）`);
  const rows = [...byDir.entries()]
    .filter(([, e]) => e.n >= 3)
    .map(([d, e]) => ({ d, ...e, rate: e.hit / e.n }))
    .sort((a, b) => a.rate - b.rate || b.n - a.n);
  console.log('  目录'.padEnd(62) + '被引/总'.padStart(10) + '  覆盖率');
  for (const r of rows.slice(0, 24)) {
    const mark = r.rate === 0 ? '❌' : r.rate < 0.2 ? '⚠️ ' : '  ';
    console.log(`  ${mark}${r.d.padEnd(60)}${String(r.hit + '/' + r.n).padStart(9)}  ${(r.rate * 100).toFixed(0).padStart(4)}%   ${r.samples.join(', ')}`);
  }
}
