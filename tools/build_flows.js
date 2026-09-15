#!/usr/bin/env node
/**
 * 扫 `flows/` 下的 `*.md`（支持一级子目录分组），生成 `flows/manifest.json`。
 *
 *   node tools/build_flows.js           # 写盘
 *   node tools/build_flows.js --lint    # 只校验 front-matter，不碰清单（PR 上跑这个）
 *   node tools/build_flows.js --check   # 清单是不是最新的（main 上跑这个，不写盘）
 *
 * 为什么要这个文件：站点是纯静态的，**没有后端**，Pages 不会列出目录里有什么。
 * 列表页要显示「有哪些联动分析」，就必须有人事先把清单写成一个文件。
 * 这里选的是「CI 扫目录重建清单并提交」（方案 B）——写的人只管加 md，不用管清单。
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

const REQUIRED = ['title', 'author', 'date', 'summary'];

/** 解析 front-matter。只支持 `key: value` 与 `tags: [a, b]`，不引入 YAML 依赖。 */
function parseFrontMatter(text, file) {
  if (!text.startsWith('---')) return { data: null, body: text, err: '文件开头没有 front-matter（应以 --- 起）' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: null, body: text, err: 'front-matter 没有闭合的 ---' };
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
  return { data, body, err: null };
}

/** 该文件最后一次被改动的时间（取 git 记录，拿不到就退回文件 mtime）。 */
function lastTouched(file) {
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', path.relative(ROOT, file)],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    if (d) return d;
  } catch (e) { /* 不是 git 仓库或没有历史 */ }
  const st = fs.statSync(file);
  return st.mtime.toISOString().slice(0, 10);
}

function collect() {
  if (!fs.existsSync(DIR)) return { flows: [], problems: [] };
  const problems = [];
  const flows = [];

  /* 只认两种位置：`flows/x.md` 和 `flows/<组>/x.md`。
     更深的层级不收——分组是给读者看的标签，不是目录树。 */
  const entries = [];
  for (const e of fs.readdirSync(DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    if (e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(DIR, e.name)).sort()) {
        if (f.endsWith('.md') && !f.startsWith('_')) entries.push([e.name, f]);
      }
    } else if (e.name.endsWith('.md')) {
      entries.push(['', e.name]);
    }
  }

  const seen = new Map();
  for (const [group, fn] of entries) {
    const rel = group ? `${group}/${fn}` : fn;
    const file = path.join(DIR, rel);
    const text = fs.readFileSync(file, 'utf8');
    const { data, err } = parseFrontMatter(text, file);
    if (err) { problems.push(`${rel}：${err}`); continue; }
    const missing = REQUIRED.filter(k => !data[k]);
    if (missing.length) { problems.push(`${rel}：front-matter 缺 ${missing.join(' / ')}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
      problems.push(`${rel}：date 要写 YYYY-MM-DD，现在是「${data.date}」`);
      continue;
    }
    const slug = fn.replace(/\.md$/, '');
    // slug 是 URL 里那一段，全站必须唯一（`#/f/<slug>` 不带分组）
    if (seen.has(slug)) { problems.push(`slug 重复：${rel} 与 ${seen.get(slug)}`); continue; }
    seen.set(slug, rel);
    flows.push({
      slug,
      group,
      title: String(data.title),
      author: String(data.author),
      date: String(data.date),
      tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
      summary: String(data.summary),
      updated: lastTouched(file),
      file: rel,          // 相对 flows/ 的路径，app.js 直接拿它去 fetch
    });
  }
  // 日期倒序；同日期按 slug，保证顺序稳定（内容不变则字节不变）
  flows.sort((a, b) => (b.date.localeCompare(a.date)) || a.slug.localeCompare(b.slug));
  return { flows, problems };
}

function main() {
  const check = process.argv.includes('--check');
  const lint = process.argv.includes('--lint');
  const { flows, problems } = collect();

  if (problems.length) {
    console.error('❌ flows/ 里有格式问题：');
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
  }

  if (lint) {
    console.log(`✅ flows/ front-matter 合规（${flows.length} 篇）`);
    return 0;
  }

  const manifest = { version: 1, flows };
  const text = JSON.stringify(manifest, null, 2) + '\n';

  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (check) {
    if (old === text) {
      console.log(`✅ flows/manifest.json 是最新的（${flows.length} 篇）`);
      return 0;
    }
    console.error('❌ flows/manifest.json 不是最新的——跑 `node tools/build_flows.js` 重建');
    process.exit(1);
  }
  fs.writeFileSync(OUT, text);
  console.log(`✅ 已写入 flows/manifest.json（${flows.length} 篇）`);
  for (const f of flows) {
    console.log(`   ${f.date}  ${(f.group ? f.group + '/' : '') + f.slug}`.padEnd(46) +
      `${f.author}  ${f.title}`);
  }
  return 0;
}

process.exit(main());
