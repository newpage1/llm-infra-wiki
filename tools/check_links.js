#!/usr/bin/env node
/**
 * 站内链接校验：把 wiki 里所有 `#/...` 链接按**路由规则**解一遍，看目标是否存在。
 *
 *   node tools/check_links.js
 *   node tools/check_links.js -v        # 顺带列出正常链接
 *
 * 路由（见 assets/js/app.js 的 router）：
 *   #/                     首页
 *   #/flows                联动分析列表
 *   #/f/<flowId>           联动分析详情
 *   #/c/<componentId>      组件详情
 *   #/a/<pageId>                        分析页首页
 *   #/a/<pageId>/<moduleId>             模块页
 *   #/a/<pageId>/s/<sectionId>          分析页的**页面级小节**
 *   #/a/<pageId>/<moduleId>/s/<section> 模块页里的小节
 *
 * 为什么需要它：分析页的正文里到处都是 `[X](#/a/<page>/<module>)` 形式的互链，
 * 但它们**没有任何工具在查**。`#/a/<page>/<section>` 少了那个 `s` 是最容易犯的错——
 * 路由会把它当成模块 id，读者点进去看到「未找到该模块」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
for (const f of ['catalog.js', 'analyses.js', 'details.js', 'details-ascend.js',
                 'details-nvidia.js', 'details-outline.js', 'flows.js']) {
  delete require.cache[require.resolve(path.join(ROOT, 'data', f))];
  require(path.join(ROOT, 'data', f));
}
const W = global.window;

/* ── 建立"存在的目标"集合 ─────────────────────────────── */
const pages = new Map();          // pageId -> { modules:Set, sections:Set }
for (const a of W.WIKI_ANALYSES || []) {
  pages.set(a.id, {
    modules: new Set((a.modules || []).map(m => m.id)),
    sections: new Set((a.sections || []).map(s => s.id)),
  });
}
const components = new Set(Object.keys(W.WIKI_DETAILS || {}));
const catalogIds = new Set(W.WIKI_ALL_IDS || []);
const flows = new Set((W.WIKI_FLOWS || []).map(f => f.id));

function collectStrings(n, out = []) {
  if (n && typeof n === 'object') for (const k of Object.keys(n)) collectStrings(n[k], out);
  else if (Array.isArray(n)) n.forEach(x => collectStrings(x, out));
  else if (typeof n === 'string') out.push(n);
  return out;
}

/* 链接出现在哪：数据文件 + 页面模板 */
const SOURCES = [
  ['data/analyses.js', W.WIKI_ANALYSES],
  ['data/details.js', W.WIKI_DETAILS],
  ['data/details-ascend.js', W.WIKI_DETAILS],
  ['data/details-nvidia.js', W.WIKI_DETAILS],
  ['data/details-outline.js', W.WIKI_DETAILS],
  ['data/flows.js', W.WIKI_FLOWS],
  ['data/catalog.js', [W.WIKI_LAYERS, W.WIKI_COMPONENTS, W.WIKI_SUBSTRATES,
                       W.WIKI_STACKS, W.WIKI_INTERACTIONS, W.WIKI_FLOW]],
];

const LINK = /#\/[A-Za-z0-9/_\-.]*/g;

function why(u) {
  const parts = u.replace(/^#\//, '').split('/').filter(x => x !== '');
  if (!parts.length) return null;                       // #/ 首页
  if (parts[0] === 'flows') return null;
  if (parts[0] === 'f') return flows.has(parts[1]) ? null : `没有这条联动分析：${parts[1]}`;
  if (parts[0] === 'c') return (components.has(parts[1]) || catalogIds.has(parts[1]))
    ? null : `没有这个组件：${parts[1]}`;
  if (parts[0] !== 'a') return `未知路由段：${parts[0]}`;
  const pg = pages.get(parts[1]);
  if (!pg) return `没有这个分析页：${parts[1]}`;
  if (!parts[2]) return null;                           // 页首页
  if (parts[2] === 's') return pg.sections.has(parts[3]) ? null : `没有这个页面级小节：${parts[1]}/s/${parts[3]}`;
  if (!pg.modules.has(parts[2])) {
    // 最常见的错法：忘了那个 `s`
    if (pg.sections.has(parts[2])) return `少写了 /s/（${parts[2]} 是页面级小节，不是模块）`;
    return `没有这个模块：${parts[1]}/${parts[2]}`;
  }
  if (parts[3] && parts[3] !== 's') return `模块路径后面应是 /s/<section>，实为 ${parts[3]}`;
  return null;
}

let total = 0, bad = 0;
const verbose = process.argv.includes('-v');
for (const [file, data] of SOURCES) {
  const rows = [];
  for (const [i, s] of collectStrings(data, []).entries()) {
    for (const m of String(s).matchAll(LINK)) {
      const u = m[0].replace(/[.,;:]+$/, '');
      if (u === '#/' || u === '#') continue;
      total++;
      const w = why(u);
      if (w) { bad++; rows.push(`  ✗ ${u}\n      ${w}`); }
      else if (verbose) rows.push(`  · ${u}`);
    }
  }
  if (rows.length) { console.log(`\n${file}`); console.log(rows.slice(0, 40).join('\n')); 
    if (rows.length > 40) console.log(`  …另有 ${rows.length - 40} 条`); }
}
console.log(`\n站内链接 ${total} 条，其中坏链 ${bad} 条${bad ? ' ❌' : ' ✅'}`);
process.exit(bad ? 1 : 0);
