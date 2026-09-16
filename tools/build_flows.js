#!/usr/bin/env node
/**
 * 扫 `flows/` 下的 `*.md`（支持一级子目录分组），从文件里**读出**元数据，
 * 生成 `flows/manifest.json`。**不修改任何 md。**
 *
 *   node tools/build_flows.js           # 写清单
 *   node tools/build_flows.js --lint    # 只校验，不写任何东西（PR 上跑这个）
 *   node tools/build_flows.js --check   # 清单是不是最新的（main 上跑这个）
 *
 * 为什么需要它：站点是纯静态的、没有后端，Pages 不列目录，列表页必须读一个
 * 事先生成好的清单。
 *
 * 为什么元数据要「捞」而不是让人写：清单要的 title/author/date/summary
 * 本来就都在文件里或 git 历史里，没道理让人再抄一遍。所以 md 可以没有
 * front-matter；front-matter 退化成**可选的覆盖项**——写了以写的为准，
 * 但这份工具**只读不写**，不会去改动谁的 md。
 *
 * 各字段从哪来：
 *   title     ← front-matter，否则正文第一个 `# 标题`，再否则文件名
 *   author    ← front-matter，否则 git 里「添加这个文件」那次提交的作者
 *   date      ← front-matter，否则同一次提交的日期（没提交时退回 mtime）
 *   summary   ← front-matter，否则正文第一段（跳过标题、引用、表格、代码块）
 *   tags      ← front-matter，没写就是空
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

/* 写了就必须是对的（都不是必填——没写会从 md 或 git 里捞） */
const VALIDATED = ['title', 'author', 'date', 'summary'];

/** 解析 front-matter。只支持 `key: value` 与 `tags: [a, b]`，不引入 YAML 依赖。 */
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(text.indexOf('\n', end + 1) + 1).replace(/^\s*\n/, '');

  const data = {};
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
  }
  return { data, body };
}

/* ---------- 从 md 与 git 里把元数据捞出来 ---------- */

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
  // 文件还没提交（本地刚写下、或 CI 上还没进历史）时，作者与日期都问不出来。
  // 日期退回 mtime；作者退回本地 git 身份——否则清单里会是一串空作者，
  // 而 CI 上文件一旦提交，`--diff-filter=A` 就找得到真正的作者了。
  if (!out.author) out.author = git(['config', 'user.name']);
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
    if (/^[>|]/.test(line)) continue;              // 引用 / 表格
    // 列表项要求标记后跟空格——否则 `**加粗开头的段落**` 会被当成无序列表，
    // 摘要就会跳过它去挑下一句（实际踩过：挑中的是「做法是…：」这种引导语）
    if (/^[-*+]\s/.test(line)) continue;
    if (/^\d+[.)]\s/.test(line)) continue;         // 有序列表
    if (/^<!--/.test(line)) continue;              // 注释
    if (/^!\[/.test(line)) continue;               // 光是一张图
    if (/^---/.test(line)) continue;
    const t = plain(line);
    if (!t) continue;
    // 截到第一句，再兜一个长度上限——摘要只是列表页卡片上的一行
    const one = t.split(/(?<=[。！？；.!?;])\s*/)[0] || t;
    return one.length > 150 ? one.slice(0, 148).replace(/[\s，,、]+$/, '') + '…' : one;
  }
  return '';
}

/** 一份 md 的最终元数据：front-matter 写了的优先，其余从 md / git 捞。 */
function extract(slug, text, origin) {
  const { data, body } = parseFrontMatter(text);
  const have = k => {
    const v = data[k];
    return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  };
  const derived = [];
  const fromFm = Object.keys(data);        // 写进 front-matter 的字段，校验只看这些
  const pick = (k, fn) => {
    if (have(k)) return data[k];
    derived.push(k);
    return fn();
  };
  return {
    fromFm,
    data: {
      title: pick('title', () => deriveTitle(body, slug)),
      author: pick('author', () => origin.author),
      date: pick('date', () => origin.date),
      summary: pick('summary', () => deriveSummary(body)),
      tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
    },
    derived,
  };
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

function collect() {
  if (!fs.existsSync(DIR)) return { flows: [], problems: [], derived: [] };
  const problems = [], flows = [], derived = [];
  const seen = new Map();

  for (const [group, fn] of entries()) {
    const rel = group ? `${group}/${fn}` : fn;
    const slug = fn.replace(/\.md$/, '');
    // slug 是 URL 里那一段，全站必须唯一（`#/f/<slug>` 不带分组）
    if (seen.has(slug)) { problems.push(`slug 重复：${rel} 与 ${seen.get(slug)}`); continue; }
    seen.set(slug, rel);

    const text = fs.readFileSync(path.join(DIR, rel), 'utf8');
    const origin = gitOrigin(rel);
    const { data, derived: got, fromFm } = extract(slug, text, origin);

    // 只校验**front-matter 里写了的**字段：没写的会自己去捞，捞不出来也不是错误
    // （新文件还没提交时作者与日期问不出来，那是正常状态，不是格式问题）
    const bad = [];
    if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
      bad.push(`date 要写 YYYY-MM-DD，现在是「${data.date}」`);
    }
    for (const k of VALIDATED) {
      if (fromFm.includes(k) && !String(data[k] == null ? '' : data[k]).trim()) {
        bad.push(`front-matter 里的 ${k} 是空的，删掉这行或填上`);
      }
    }
    if (bad.length) { problems.push(`${rel}：${bad.join('；')}`); continue; }
    if (got.length) derived.push(`${rel}（捞了 ${got.join('、')}）`);

    flows.push({
      slug,
      group,                 // 子目录名，页面当标签显示；空串=没分组
      title: String(data.title),
      author: String(data.author || ''),
      date: String(data.date),
      tags: data.tags,
      summary: String(data.summary || ''),
      updated: origin.date,
      file: rel,             // 相对 flows/ 的路径，app.js 直接拿它去 fetch
    });
  }

  // 日期倒序；同日期按 slug，保证顺序稳定（内容不变则字节不变）
  flows.sort((a, b) => (b.date.localeCompare(a.date)) || a.slug.localeCompare(b.slug));
  return { flows, problems, derived };
}

function main() {
  const check = process.argv.includes('--check');
  const lint = process.argv.includes('--lint');
  const { flows, problems, derived } = collect();

  if (problems.length) {
    console.error('❌ flows/ 里有问题：');
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
  }

  if (lint) {
    console.log(`✅ flows/ 校验通过（${flows.length} 篇` +
      (derived.length ? `，其中 ${derived.length} 篇的元数据要从 md / git 里捞` : '') + '）');
    return 0;
  }

  const text = JSON.stringify({ version: 1, flows }, null, 2) + '\n';
  const stale = !fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== text;

  if (check) {
    if (stale) {
      console.error('❌ flows/manifest.json 不是最新的——跑 `node tools/build_flows.js` 重建');
      process.exit(1);
    }
    console.log(`✅ flows/manifest.json 是最新的（${flows.length} 篇）`);
    return 0;
  }

  fs.writeFileSync(OUT, text);
  console.log(`✅ 已写入 flows/manifest.json（${flows.length} 篇）；md 一个字节都没动`);
  if (derived.length) {
    console.log(`   其中 ${derived.length} 篇的元数据是从 md / git 里捞的：`);
    derived.forEach(d => console.log('     ' + d));
  }
  for (const f of flows) {
    console.log(`   ${f.date}  ${(f.group ? f.group + '/' : '') + f.slug}`.padEnd(50) + f.title);
  }
  return 0;
}

process.exit(main());
