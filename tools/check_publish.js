#!/usr/bin/env node
/**
 * 发布前体检：用**真实的渲染器**跑一遍所有内容，抓「写对了但页面会漏字」的问题。
 *
 *   node tools/check_publish.js         # 检查，有错 exit 1
 *   node tools/check_publish.js -v      # 连通过项也打印
 *
 * 为什么必须跑真渲染器：早期版本用正则去数 `%%` 配没配对，结果**两个合法 span
 * 之间的一次误配**会被算成问题（假阳性），而真正的泄漏（`%%a % b%%` 这种
 * 中间带 `%` 的）反而可能被漏掉。渲染器是 `%%([^%]+)%%` 的全局 replace，
 * 唯一的判据就是「渲染完之后还有没有残留的字面量」。
 *
 * 检查项：
 *   ① data/*.js 能载入（语法）
 *   ② 渲染后不留 %% / ** / ~~~ 字面量（代码块内除外）
 *   ③ 走 esc() 的字段里不能有 markdown——那部分不解析，会漏字面量
 *   ④ SVG 里不能出现 ** / %% / ~~~ / markdown 链接
 *   ⑤ 分析页的 component 必须在 catalog 里有对应组件
 *   ⑥ designSymbols 提示（不是错误：有些模块有意不上总体设计图）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = { red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
            yellow: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

global.window = {};
require(path.join(ROOT, 'assets', 'js', 'markdown.js'));
require(path.join(ROOT, 'data', 'catalog.js'));
require(path.join(ROOT, 'data', 'analyses.js'));
require(path.join(ROOT, 'data', 'details.js'));

const md = global.window.md;
const ANALYSES = global.window.WIKI_ANALYSES || [];
const DETAILS = global.window.WIKI_DETAILS || {};
const COMPONENTS = global.window.WIKI_COMPONENTS || [];

const errs = [], warns = [], noSymbol = [];

/* 走 esc() 的字段——写 markdown 会漏成字面量。
   判据来源：assets/js/app.js 里这几个字段外面套的是 esc()。 */
const PLAIN_ANALYSIS = ['id', 'component', 'title', 'subtitle', 'repo', 'revision', 'date'];
const PLAIN_MODULE = ['id', 'title', 'subtitle', 'files'];
const PLAIN_DETAIL_MODULE = ['id', 'name', 'summary'];
const MD_MARKERS = ['%%', '**', '~~~', '](#'];
const hasMd = s => MD_MARKERS.filter(m => s.includes(m));

/* 渲染后的 HTML 里，代码块内部的 ** 是合法内容——剥掉再判 */
function stripCode(html) {
  return String(html)
    .replace(/<pre[\s\S]*?<\/pre>/g, '')
    .replace(/<code[\s\S]*?<\/code>/g, '');
}

function checkRendered(where, text) {
  if (typeof text !== 'string' || !text) return;
  let html;
  try { html = md(text).html; }
  catch (e) { errs.push(`② ${where} 渲染抛异常：${e.message}`); return; }
  const body = stripCode(html);
  for (const [pat, why] of [['%%', '行内代码没配对（中间可能有 % 字符）'],
                            ['**', '粗体没配对'],
                            ['~~~', '围栏没配对']]) {
    if (body.includes(pat)) {
      const i = body.indexOf(pat);
      errs.push(`② ${where} 渲染后残留 ${pat} —— ${why}：…${body.slice(Math.max(0, i - 60), i + 40).replace(/\n/g, ' ')}…`);
      break;
    }
  }
}

const SVG_BAD = [
  [/\*\*/, '** 会被当成正文粗体语法'],
  [/%%/, '%% 会被当成行内代码定界符'],
  [/~~~/, '~~~ 会被当成围栏'],
  [/\]\(#/, 'markdown 链接'],
];

/* 遍历对象里所有字符串 */
function* walk(node, p = '') {
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      yield* walk(node[k], `${p}.${k}`);
    }
  } else if (typeof node === 'string') {
    yield [p, node];
  }
}

const catalogIds = new Set(COMPONENTS.map(c => c.id));

ANALYSES.forEach(a => {
  // ⑤ component 必须在 catalog 里，否则深度分析入口按钮不出现
  if (!catalogIds.has(a.component)) {
    errs.push(`⑤ 分析页 ${a.id} 的 component=${JSON.stringify(a.component)} 在 catalog 里不存在`);
  }
  PLAIN_ANALYSIS.forEach(k => {
    const v = a[k];
    if (typeof v === 'string') {
      const hit = hasMd(v);
      if (hit.length) errs.push(`③ ${a.id}.${k} 是纯文本字段（esc()），却含 ${hit.join('')}：${v.slice(0, 70)}`);
    }
  });
  (a.modules || []).forEach(m => {
    PLAIN_MODULE.forEach(k => {
      const v = m[k];
      if (typeof v === 'string') {
        const hit = hasMd(v);
        if (hit.length) errs.push(`③ ${a.id}/${m.id}.${k} 是纯文本字段（esc()），却含 ${hit.join('')}：${v.slice(0, 70)}`);
      }
    });
    if (!m.designSymbols || !m.designSymbols.length) noSymbol.push(`${a.id}/${m.id}`);
  });
  // ② / ④ 逐字符串：SVG 单独判，其余跑真渲染器
  for (const [p, text] of walk(a)) {
    if (/\.svg$/.test(p)) {
      for (const [re, why] of SVG_BAD) {
        if (re.test(text)) { errs.push(`④ ${a.id}${p} 的 SVG 里出现 ${why}`); break; }
      }
      continue;
    }
    if (p === '.summary' || p === '.modulesLead' || /\.(lead|html)$/.test(p) ||
        /\.scope\[\d+\]$/.test(p) || /\.notCovered\[\d+\]$/.test(p)) {
      checkRendered(`${a.id}${p}`, text);
    }
  }
});

/* details.js 的纯文本字段 + overview 跑渲染器 */
Object.entries(DETAILS).forEach(([cid, d]) => {
  checkRendered(`details[${cid}].overview`, d.overview || '');
  (d.modules || []).forEach(m => {
    PLAIN_DETAIL_MODULE.forEach(k => {
      const v = m[k];
      if (typeof v === 'string') {
        const hit = hasMd(v);
        if (hit.length) errs.push(`③ details[${cid}]/${m.id}.${k} 是纯文本字段（esc()），却含 ${hit.join('')}：${v.slice(0, 70)}`);
      }
    });
    (m.files || []).forEach(f => {
      if (typeof f === 'string') {
        const hit = hasMd(f);
        if (hit.length) errs.push(`③ details[${cid}]/${m.id}.files 是纯文本字段（esc()），却含 markdown：${f.slice(0, 70)}`);
      }
    });
    (m.flow || []).forEach((t, i) => checkRendered(`details[${cid}]/${m.id}.flow[${i}]`, t));
    (m.points || []).forEach((t, i) => checkRendered(`details[${cid}]/${m.id}.points[${i}]`, t));
  });
});

/* ⑥ 汇总成一行：有些模块有意不上总体设计图（设计图只画主线），
   这条只作提醒——真正的判据是 `--design`（图里的方框必须有主，模块的声明必须有框）。 */
if (noSymbol.length) {
  warns.push(`⑥ ${noSymbol.length} 个模块没有 designSymbols（不上总体设计图）：${noSymbol.join('、')}`);
}

const verbose = process.argv.includes('-v');
if (verbose || !errs.length) {
  console.log(C.green(`✅ 载入 ${ANALYSES.length} 个分析页 / ${Object.keys(DETAILS).length} 个组件详情 / ${COMPONENTS.length} 个编目组件`));
  if (!errs.length) console.log(C.green('✅ 渲染后无残留字面量，纯文本字段干净，SVG 干净，component 全部可解析'));
}
warns.forEach(w => console.log(C.yellow('⚠️  ' + w)));
errs.forEach(e => console.log(C.red('❌ ' + e)));
console.log(`\n合计：${errs.length} 个错误，${warns.length} 个提示`);
process.exit(errs.length ? 1 : 0);
