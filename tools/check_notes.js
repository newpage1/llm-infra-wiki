#!/usr/bin/env node
/**
 * 校验 `notes/*.md`：front-matter 合规、图片存在、站内笔记链接可解析、
 * 清单条目没有指向空气，以及**引用的 `路径:行号` 是否落在文件范围内**。
 *
 *   node tools/check_notes.js
 *   node tools/check_notes.js --root /path/to/checkouts   # 顺便核行号（默认 ../codex）
 *
 * 为什么要它：笔记是自由形式的，没有深度分析页那套 checker 兜底。
 * 但「自由形式」不等于「什么都能写」——下面这几条错了读者就会看到坏链接、
 * 坏图、或者指向不存在行的锚点：
 *   · front-matter 少了字段 → 列表页没有标题/作者（规则以 build_notes.js 为准，这里只调用它）
 *   · 图片路径写错 → 图裂
 *   · `路径:行号` 对不上 → 读者按图索骥找不到
 *
 * 清单是否最新**不在这里管**：那是 main 上 CI 的职责，PR 上查会误报
 * （同事刚加了 md、清单还没重建，属于正常状态）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'notes');

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const BASE = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1])
  : path.resolve(ROOT, '..', 'codex');

/* 检出目录名 → 用它来核行号；找不到就跳过（笔记可以引用本站没分析过的仓库） */
const CHECKOUTS = ['sglang-review', 'vllm-review', 'vllm-ascend-review',
  'lmcache-review', 'lmcache-ascend-combined', 'mooncake-review'];

const problems = [];
const warns = [];
if (!fs.existsSync(DIR)) {
  console.log('（还没有 notes/ 目录）');
  process.exit(0);
}

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort();
const slugs = new Set(files.map(f => f.replace(/\.md$/, '')));

/* 1) front-matter —— 规则只有一份，在 build_notes.js 里 */
try {
  execFileSync('node', [path.join(__dirname, 'build_notes.js'), '--lint'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  // 把子进程的「❌ notes/ 里有格式问题：」表头去掉，只留具体条目
  String((e.stdout || '') + (e.stderr || '')).split('\n')
    .map(l => l.trim()).filter(Boolean)
    .filter(l => !/^❌ notes\/ 里有格式问题/.test(l))
    .forEach(l => problems.push(l.replace(/^❌\s*/, '')));
}

/* 2) 图片引用 + 站内笔记链接 */
const IMG = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const NOTE_LINK = /\]\(#\/n\/([\w-]+)\)/g;
for (const fn of files) {
  const text = fs.readFileSync(path.join(DIR, fn), 'utf8');
  for (const m of text.matchAll(IMG)) {
    const src = m[1];
    if (/^(https?:|data:)/.test(src)) {
      problems.push(`${fn}：图片用了外链 ${src}——本站不依赖外部资源，图必须跟着仓库走`);
      continue;
    }
    const p = path.join(DIR, src.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) problems.push(`${fn}：图片不存在 → ${src}`);
  }
  for (const m of text.matchAll(NOTE_LINK)) {
    if (!slugs.has(m[1])) problems.push(`${fn}：链接指向不存在的笔记 → #/n/${m[1]}`);
  }
}

/* 3) `路径:行号` 的范围核对（检出不存在就跳过） */
const ANCHOR = /([\w./+-]+\.(?:py|cpp|cc|h|hpp|cu|cuh|go|rs)):(\d+)/g;
const roots = CHECKOUTS.map(d => path.join(BASE, d)).filter(d => fs.existsSync(d));
let anchors = 0, checked = 0;
if (roots.length) {
  for (const fn of files) {
    const text = fs.readFileSync(path.join(DIR, fn), 'utf8');
    for (const m of text.matchAll(ANCHOR)) {
      anchors++;
      const rel = m[1], ln = +m[2];
      const hits = roots.filter(r => fs.existsSync(path.join(r, rel)));
      if (!hits.length) continue;                      // 不在本站分析范围内，跳过
      checked++;
      const n = fs.readFileSync(path.join(hits[0], rel), 'utf8').split('\n').length;
      if (ln < 1 || ln > n) {
        problems.push(`${fn}：行号越界 ${rel}:${ln}（${path.basename(hits[0])} 只有 ${n} 行）`);
      }
    }
  }
} else {
  warns.push(`没找到检出（${BASE}），跳过了锚点行号核对`);
}

/* 4) 清单自身的完整性。
 * 不等价于「清单是最新的」——main 上的 CI 负责重建（方案 B），PR 上清单落后于
 * 目录是正常状态。这里只挡「清单里有指向空气的条目」：那种条目在列表页就是一张
 * 点不开的卡片，而重建前的清单正好容易留下这种残渣（同事删了笔记、改了 slug）。 */
const MF = path.join(DIR, 'manifest.json');
if (fs.existsSync(MF)) {
  let mf = null;
  try { mf = JSON.parse(fs.readFileSync(MF, 'utf8')); }
  catch (e) { problems.push(`manifest.json 不是合法 JSON：${e.message}`); }
  if (mf) {
    if (!Array.isArray(mf.notes)) problems.push('manifest.json 缺少 notes 数组');
    else {
      const seen = new Set();
      for (const n of mf.notes) {
        if (!n || !n.slug || !n.title || !n.author || !n.date || !n.file) {
          problems.push(`manifest.json 有条目缺字段：${JSON.stringify(n && n.slug || n)}`);
          continue;
        }
        if (!fs.existsSync(path.join(DIR, n.file))) {
          problems.push(`manifest.json 指向不存在的文件 → ${n.file}`);
        }
        if (seen.has(n.slug)) problems.push(`manifest.json 里 slug 重复 → ${n.slug}`);
        seen.add(n.slug);
      }
    }
  }
} else if (files.length) {
  problems.push('有笔记但没有 notes/manifest.json——跑 `node tools/build_notes.js` 生成');
}

console.log(`笔记 ${files.length} 篇 · 引用的路径锚点 ${anchors} 个` +
  (roots.length ? `（其中 ${checked} 个落在本站分析过的仓库里，已核行号）` : ''));
warns.forEach(w => console.log('  ⚠️  ' + w));
if (problems.length) {
  console.log(`\n❌ ${problems.length} 个问题：`);
  problems.forEach(p => console.log('   ' + p));
  process.exit(1);
}
console.log('✅ 笔记检查通过');
