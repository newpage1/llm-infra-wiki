#!/usr/bin/env node
/**
 * 扫 `flows/` 下的 `*.md`（支持一级子目录分组），
 * 1) 把缺的 front-matter 字段**推导出来写回文件**；2) 生成 `flows/manifest.json`。
 *
 *   node tools/build_flows.js           # 补 front-matter + 写清单
 *   node tools/build_flows.js --lint    # 只校验，不写任何文件（PR 上跑这个）
 *   node tools/build_flows.js --check   # 清单最新 && 没有待补的字段（main 上跑这个）
 *
 * 为什么写的人不用管元数据：站点是纯静态的、没有后端，Pages 不列目录，
 * 列表页必须读一个事先生成好的清单；而清单要的 title/author/date/summary
 * 全都能从**文件本身 + git 历史**推出来，没道理让人手写一遍。
 *
 * 字段来源（front-matter 里写了的以写的为准，其余自动补）：
 *   title     ← 正文第一个 `# 标题`，没有就用文件名
 *   author    ← git 里「添加这个文件」那次提交的作者
 *   date      ← 同一次提交的日期；文件还没提交时退回 mtime
 *   summary   ← 正文第一段（跳过标题、引用、表格、代码块），截到一句话
 *   direction ← **推不出来**，是内容判断；缺了先归到「待分类」
 *   tags      ← 不自动填
 *
 * 输出**刻意不含时间戳**：内容没变时字节不变，CI 才能靠「文件有没有变」决定要不要提交，
 * 否则每次构建都会产生一个空提交。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'flows');
const OUT = path.join(DIR, 'manifest.json');

/* front-matter 的规范顺序。写回文件时按这个顺序排，读的人看着一致。 */
const FIELDS = ['title', 'author', 'date', 'direction', 'tags', 'summary'];
/* 写了就必须是对的（不是必填——没写会推导） */
const VALIDATED = ['title', 'author', 'date', 'direction', 'summary'];

const PENDING = '待分类';

/* 二级分类：一篇分析属于哪个**技术方向**。
   这里是唯一来源——生成器按它校验 front-matter，也按这个顺序写进清单，
   列表页照单渲染分段，不在页面里再抄一份（抄了就会两边漂）。
   顺序即展示顺序；`待分类` 与 `写作示例` 放最后。 */
const DIRECTIONS = [
  ['KV 全链路', '一次 KV 的存与取，横跨哪几层、各段怎么接上'],
  ['传输与硬件后端', 'Transfer Engine 与昇腾 / 鲲鹏 / UB 这些硬件通路'],
  ['KV 存储与池化', '分布式 KV 池、多级缓存、对象存储'],
  ['KV 量化', '把 KV 压小：分层量化与它的代价'],
  ['框架集成', '把 A 接进 B：方案设计与取舍'],
  ['性能与容量', '时延、吞吐、容量怎么估'],
  ['社区与生态', 'PR 梳理、上游贡献、社区格局'],
  ['整体走读', '把一个项目从模块地图到热路径读一遍'],
  [PENDING, '还没归类。把 md 里那行 direction 改成一个方向名就挪走了'],
  ['写作示例', '投稿样板，不是调研内容'],
];
const DIR_NAMES = DIRECTIONS.map(d => d[0]);

/** 解析 front-matter。只支持 `key: value` 与 `tags: [a, b]`，不引入 YAML 依赖。 */
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { data: {}, keys: [], body: text, has: false };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, keys: [], body: text, has: false };
  const raw = text.slice(3, end).trim();
  const body = text.slice(text.indexOf('\n', end + 1) + 1).replace(/^\s*\n/, '');

  const data = {}, keys = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    data[k] = v;
    keys.push(k);
  }
  return { data, keys, body, has: true };
}

/* ---------- 推导 ---------- */

/** git 里「添加这个文件」那次的作者与日期；查不到就退回 mtime。
 *  `rel` 相对 `flows/`（和清单里的 file 字段一致），git 要的是相对仓库根的路径。 */
function gitOrigin(rel) {
  const repoRel = path.posix.join('flows', rel);
  const out = { author: '', date: '' };
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (e) { return ''; }          // 不是 git 仓库，或没有历史
  };
  const added = git(['log', '--diff-filter=A', '-1', '--format=%an%x09%cs', '--', repoRel]);
  if (added) { const [a, d] = added.split('\t'); out.author = a || ''; out.date = d || ''; }
  if (!out.date) out.date = git(['log', '-1', '--format=%cs', '--', repoRel]);
  if (!out.date) {
    out.date = fs.statSync(path.join(DIR, rel)).mtime.toISOString().slice(0, 10);
  }
  return out;
}

/** 正文第一个 `# 标题`；没有就退回文件名（去掉连字符、首字母大写）。 */
function deriveTitle(body, slug) {
  const m = body.match(/^#[ \t]+(.+?)[ \t]*$/m);
  if (m) return m[1].trim();
  return slug.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
}

/** 去掉行内标记，留下能读的纯文本。 */
function plain(s) {
  return s
    .replace(/%%([^%]*)%%/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .trim();
}

/** 正文第一段能当摘要的话：跳过标题、引用、表格、列表、代码块与空行。 */
function deriveSummary(body) {
  let inFence = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;          // 标题
    if (/^[>|\-*+]/.test(line)) continue;           // 引用 / 表格 / 列表
    if (/^\d+[.)]\s/.test(line)) continue;          // 有序列表
    if (/^<!--/.test(line)) continue;               // 注释
    if (/^!\[/.test(line)) continue;                // 光是一张图
    if (/^---/.test(line)) continue;
    const t = plain(line);
    if (!t) continue;
    // 截到第一句，再兜一个长度上限——摘要只是列表页卡片上的一行
    const one = t.split(/(?<=[。！？；.!?;])\s*/)[0] || t;
    return one.length > 150 ? one.slice(0, 148).replace(/[\s，,、]+$/, '') + '…' : one;
  }
  return '';
}

/** 一个值写成 `key: value` 时要不要加引号——以 `[` 开头的会被当成数组。 */
function emit(key, v) {
  const s = String(v == null ? '' : v).replace(/\s*\n\s*/g, ' ').trim();
  if (Array.isArray(s)) return `${key}: [${s.join(', ')}]`;
  return /^[\["']|:\s|#$/.test(s) ? `${key}: "${s.replace(/"/g, '\\"')}"` : `${key}: ${s}`;
}

/**
 * 补齐一份 md 的 front-matter。已写的值一律不动。
 * 返回新的全文；没东西可补时返回 null（调用方据此判断「字节没变」）。
 */
function normalize(rel, slug, text, origin) {
  const { data, keys, body } = parseFrontMatter(text);
  const filled = {};

  const have = k => {
    const v = data[k];
    return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  };
  if (!have('title')) filled.title = deriveTitle(body, slug);
  if (!have('author')) filled.author = origin.author || '';
  if (!have('date')) filled.date = origin.date;
  if (!have('direction')) filled.direction = PENDING;
  if (!have('summary')) filled.summary = deriveSummary(body);

  const merged = Object.assign({}, data, filled);
  const order = FIELDS.filter(k => merged[k] !== undefined && merged[k] !== '')
    .concat(keys.filter(k => !FIELDS.includes(k)));          // 作者自带的额外字段留着
  const lines = order.map(k => emit(k, merged[k]));

  const head = '---\n' + lines.join('\n') + '\n---\n\n';
  const next = head + body.replace(/^\s*\n/, '');
  if (next === text) return { text, filled: [], data: merged };
  return { text: next, filled: Object.keys(filled), data: merged };
}

/* ---------- 收集 ---------- */

function entries() {
  const out = [];
  for (const e of fs.readdirSync(DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(DIR, e.name)).sort()) {
        if (f.endsWith('.md') && !f.startsWith('_')) out.push([e.name, f]);
      }
    } else if (e.name.endsWith('.md')) {
      out.push(['', e.name]);
    }
  }
  return out;
}

function collect({ write }) {
  if (!fs.existsSync(DIR)) return { flows: [], problems: [], filled: [], todos: [] };
  const problems = [], flows = [], filled = [], todos = [];
  const seen = new Map();

  for (const [group, fn] of entries()) {
    const rel = group ? `${group}/${fn}` : fn;
    const abs = path.join(DIR, rel);
    const slug = fn.replace(/\.md$/, '');
    if (seen.has(slug)) { problems.push(`slug 重复：${rel} 与 ${seen.get(slug)}`); continue; }
    seen.set(slug, rel);

    const text = fs.readFileSync(abs, 'utf8');
    const origin = gitOrigin(rel);
    const { text: next, filled: got, data } = normalize(rel, slug, text, origin);

    // 只校验**写了**的字段：没写会推导，不是错误
    const bad = [];
    if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
      bad.push(`date 要写 YYYY-MM-DD，现在是「${data.date}」`);
    }
    if (data.direction && !DIR_NAMES.includes(String(data.direction))) {
      bad.push(`direction 写的是「${data.direction}」，只能是这 ${DIR_NAMES.length} 个之一：` +
        DIR_NAMES.join(' / '));
    }
    for (const k of VALIDATED) {
      if (data[k] !== undefined && !String(data[k]).trim()) bad.push(`${k} 是空的，删掉这行或填上`);
    }
    if (bad.length) { problems.push(`${rel}：${bad.join('；')}`); continue; }

    if (got.length) {
      filled.push(`${rel}（补了 ${got.join('、')}）`);
      if (write) fs.writeFileSync(abs, next);
    }
    if (String(data.direction) === PENDING) {
      todos.push(rel);
    }

    flows.push({
      slug,
      group,
      direction: String(data.direction),
      title: String(data.title),
      author: String(data.author || ''),
      date: String(data.date),
      tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
      summary: String(data.summary || ''),
      updated: origin.date,
      file: rel,          // 相对 flows/ 的路径，app.js 直接拿它去 fetch
    });
  }

  // 先按方向（照 DIRECTIONS 的顺序），方向内日期倒序，同日期按 slug——
  // 顺序完全确定，内容不变则字节不变
  const rank = new Map(DIR_NAMES.map((n, i) => [n, i]));
  flows.sort((a, b) =>
    (rank.get(a.direction) - rank.get(b.direction)) ||
    b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return { flows, problems, filled, todos };
}

function main() {
  const check = process.argv.includes('--check');
  const lint = process.argv.includes('--lint');
  const { flows, problems, filled, todos } = collect({ write: !lint && !check });

  if (problems.length) {
    console.error('❌ flows/ 里有问题：');
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
  }

  if (todos.length) {
    console.log(`⚠️  ${todos.length} 篇还是「${PENDING}」——把文件里那行 direction 改成` +
      `一个方向名就归位了：`);
    todos.forEach(t => console.log('     ' + t));
  }

  if (lint) {
    console.log(filled.length
      ? `✅ flows/ 校验通过（${flows.length} 篇；其中 ${filled.length} 篇缺字段，` +
        '合进 main 后由 CI 自动补上）'
      : `✅ flows/ 校验通过（${flows.length} 篇，元数据齐全）`);
    return 0;
  }

  // 方向清单随清单一起下发，列表页就不必自己维护一份顺序
  const manifest = {
    version: 2,
    directions: DIRECTIONS.map(([name, blurb]) => ({ name, blurb })),
    flows,
  };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const stale = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') !== text : true;

  if (check) {
    if (stale || filled.length) {
      console.error('❌ 还不是最新的——跑 `node tools/build_flows.js` 重建' +
        (filled.length ? `（有 ${filled.length} 篇待补 front-matter）` : '（清单要重建）'));
      filled.forEach(f => console.error('   ' + f));
      process.exit(1);
    }
    console.log(`✅ flows/ 与清单都是最新的（${flows.length} 篇）`);
    return 0;
  }

  fs.writeFileSync(OUT, text);
  if (filled.length) {
    console.log(`✍️  补了 ${filled.length} 篇的 front-matter：`);
    filled.forEach(f => console.log('   ' + f));
  }
  console.log(`✅ 已写入 flows/manifest.json（${flows.length} 篇）`);
  for (const f of flows) {
    console.log(`   ${f.date}  ${f.direction.padEnd(12)}` +
      `${(f.group ? f.group + '/' : '') + f.slug}`.padEnd(50) + f.title);
  }
  return 0;
}

process.exit(main());
