#!/usr/bin/env node
/**
 * 校验 `flows/` 下的 md（含一级子目录）：front-matter 合规、图片存在、
 * 站内互链可解析、清单条目没有指向空气，以及
 * **引用的 `路径:行号` 是否落在文件范围内**。
 *
 *   node tools/check_flows.js
 *   node tools/check_flows.js --root /path/to/checkouts   # 顺便核行号（默认 ../codex）
 *
 * 为什么要它：联动分析是自由形式的，没有深度分析页那套 checker 兜底。
 * 但「自由形式」不等于「什么都能写」——下面这几条错了读者就会看到坏链接、
 * 坏图、或者指向不存在行的锚点：
 *   · front-matter 少了字段 → 列表页没有标题/作者（规则以 build_flows.js 为准，这里只调用它）
 *   · 图片路径写错 → 图裂
 *   · `路径:行号` 对不上 → 读者按图索骥找不到
 *
 * 清单是否最新**不在这里管**：那是 main 上 CI 的职责，PR 上查会误报
 * （刚加了 md、清单还没重建，属于正常状态）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'flows');

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
  console.log('（还没有 flows/ 目录）');
  process.exit(0);
}

/* 只认 `flows/x.md` 与 `flows/<组>/x.md`——和 build_flows.js 的口径一致 */
const files = [];
for (const e of fs.readdirSync(DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
  if (e.isDirectory()) {
    for (const f of fs.readdirSync(path.join(DIR, e.name)).sort()) {
      if (f.endsWith('.md') && !f.startsWith('_')) files.push(`${e.name}/${f}`);
    }
  } else if (e.name.endsWith('.md')) files.push(e.name);
}
const slugs = new Set(files.map(f => path.basename(f).replace(/\.md$/, '')));

/* 1) front-matter —— 规则只有一份，在 build_flows.js 里 */
try {
  execFileSync('node', [path.join(__dirname, 'build_flows.js'), '--lint'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  // 把子进程的「❌ flows/ 里有格式问题：」表头去掉，只留具体条目
  String((e.stdout || '') + (e.stderr || '')).split('\n')
    .map(l => l.trim()).filter(Boolean)
    .filter(l => !/^❌ flows\/ 里有格式问题/.test(l))
    .forEach(l => problems.push(l.replace(/^❌\s*/, '')));
}

/* 2) 图片引用 + 站内互链 */
const IMG = /!\[[^\]]*\]\(([^)\s]+)\)/g;
const FLOW_LINK = /\]\(#\/f\/([\w-]+)\)/g;
for (const fn of files) {
  const text = fs.readFileSync(path.join(DIR, fn), 'utf8');
  const dir = path.dirname(path.join(DIR, fn));   // 图是相对「这篇 md 所在的目录」引的
  for (const m of text.matchAll(IMG)) {
    const src = m[1];
    if (/^(https?:|data:)/.test(src)) {
      problems.push(`${fn}：图片用了外链 ${src}——本站不依赖外部资源，图必须跟着仓库走`);
      continue;
    }
    if (!fs.existsSync(path.join(dir, src.replace(/^\.\//, '')))) {
      problems.push(`${fn}：图片不存在 → ${src}`);
    }
  }
  for (const m of text.matchAll(FLOW_LINK)) {
    if (!slugs.has(m[1])) problems.push(`${fn}：链接指向不存在的分析 → #/f/${m[1]}`);
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

/* 4) 页内目录锚点。这些长文基本都带目录，链接是作者按 **GitHub 的锚点规则**写的。
 * 用真实渲染器跑一遍，确认每个 `](#xxx)` 都落得到某个标题的 id 上——
 * 改了标题却忘了改目录链接，在网页上就是点不动的死链，而且很难自己发现。
 * （`assets/js/markdown.js` 的 slug() 刻意与 github-slugger 对齐，两边才会一致。） */
global.window = {};
require(path.join(ROOT, 'assets/js/markdown.js'));
function stripFrontMatter(text) {
  let body = text;
  if (/^---\r?\n/.test(body)) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1);
  }
  return body.replace(/^\s*\n/, '').replace(/^#\s+[^\n]*\n+/, '');
}
let tocLinks = 0;
for (const rel of files) {
  const html = global.window.md(stripFrontMatter(
    fs.readFileSync(path.join(DIR, rel), 'utf8'))).html;
  const ids = new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map(m => m[1]));
  for (const m of html.matchAll(/href="#([^"]+)"/g)) {
    if (m[1].startsWith('/')) continue;              // 站内路由，归 check_links.js 管
    tocLinks++;
    if (!ids.has(m[1])) problems.push(`${rel}：目录锚点对不上 → #${m[1]}`);
  }
}

/* 5) 清单自身的完整性。
 * 注意这里**不报**「清单落后于目录」——main 上的 CI 负责重建（方案 B），
 * PR 上清单落后是正常状态：**删掉或改名一篇之后，清单必然还指着旧文件**，
 * 报成错误就会让一个完全正当的 PR 红掉（实测踩过）。
 * 所以缺文件只提示，交给 main 上那次重建收尾。
 * 真正该硬报的是「清单本身坏了」：JSON 不合法、条目缺字段、slug 重复——
 * 那些要么是手改了清单，要么是生成器坏了。 */
const MF = path.join(DIR, 'manifest.json');
const stale = [];
if (fs.existsSync(MF)) {
  let mf = null;
  try { mf = JSON.parse(fs.readFileSync(MF, 'utf8')); }
  catch (e) { problems.push(`manifest.json 不是合法 JSON：${e.message}`); }
  if (mf) {
    if (!Array.isArray(mf.flows)) problems.push('manifest.json 缺少 flows 数组');
    else {
      const seen = new Set();
      for (const n of mf.flows) {
        if (!n || !n.slug || !n.title || !n.author || !n.date || !n.file) {
          problems.push(`manifest.json 有条目缺字段：${JSON.stringify(n && n.slug || n)}`);
          continue;
        }
        if (!fs.existsSync(path.join(DIR, n.file))) {
          stale.push(n.file);
        }
        if (seen.has(n.slug)) problems.push(`manifest.json 里 slug 重复 → ${n.slug}`);
        seen.add(n.slug);
      }
    }
  }
} else if (files.length) {
  problems.push('有分析但没有 flows/manifest.json——跑 `node tools/build_flows.js` 生成');
}

if (stale.length) {
  warns.push(`清单里有 ${stale.length} 条指向已不存在的文件（${stale.slice(0, 3).join('、')}` +
    `${stale.length > 3 ? ' 等' : ''}）——合进 main 后由 CI 重建清单，` +
    '如果是删掉或改名了一篇，忽略这条');
}

console.log(`联动分析 ${files.length} 篇 · 页内目录锚点 ${tocLinks} 个 · 路径锚点 ${anchors} 个` +
  (roots.length ? `（其中 ${checked} 个落在本站分析过的仓库里，已核行号）` : ''));
warns.forEach(w => console.log('  ⚠️  ' + w));
if (problems.length) {
  console.log(`\n❌ ${problems.length} 个问题：`);
  problems.forEach(p => console.log('   ' + p));
  process.exit(1);
}
console.log('✅ 联动分析检查通过');
