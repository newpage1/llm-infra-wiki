#!/usr/bin/env node
/**
 * 扫 `notes/*.md`，生成 `notes/manifest.json`。
 *
 *   node tools/build_notes.js            # 写盘
 *   node tools/build_notes.js --lint     # 只校验 front-matter，不碰清单（PR 上跑这个）
 *   node tools/build_notes.js --check    # 清单是不是最新的（main 上跑这个，不写盘）
 *
 * 为什么要这个文件：站点是纯静态的，**没有后端**，Pages 不会列出目录里有什么。
 * 列表页要显示「有哪些笔记」，就必须有人事先把清单写成一个文件。
 * 这里选的是「CI 扫目录重建清单并提交」（方案 B）——同事只管加 md，不用管清单。
 *
 * 输出**刻意不含时间戳**：内容没变时字节不变，CI 才能靠「文件有没有变」决定要不要提交，
 * 否则每次构建都会产生一个空提交。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'notes');
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
  if (!fs.existsSync(DIR)) return { notes: [], problems: [] };
  const problems = [];
  const notes = [];
  for (const fn of fs.readdirSync(DIR).sort()) {
    if (!fn.endsWith('.md') || fn.startsWith('_')) continue;   // _template.md 之类不进清单
    const file = path.join(DIR, fn);
    const text = fs.readFileSync(file, 'utf8');
    const { data, err } = parseFrontMatter(text, file);
    if (err) { problems.push(`${fn}：${err}`); continue; }
    const missing = REQUIRED.filter(k => !data[k]);
    if (missing.length) { problems.push(`${fn}：front-matter 缺 ${missing.join(' / ')}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) {
      problems.push(`${fn}：date 要写 YYYY-MM-DD，现在是「${data.date}」`);
      continue;
    }
    notes.push({
      slug: fn.replace(/\.md$/, ''),
      title: String(data.title),
      author: String(data.author),
      date: String(data.date),
      tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
      summary: String(data.summary),
      updated: lastTouched(file),
      file: fn,
    });
  }
  // 日期倒序；同日期按 slug，保证顺序稳定（内容不变则字节不变）
  notes.sort((a, b) => (b.date.localeCompare(a.date)) || a.slug.localeCompare(b.slug));
  return { notes, problems };
}

function main() {
  const check = process.argv.includes('--check');
  const lint = process.argv.includes('--lint');
  const { notes, problems } = collect();

  if (problems.length) {
    console.error('❌ notes/ 里有格式问题：');
    problems.forEach(p => console.error('   ' + p));
    process.exit(1);
  }

  if (lint) {
    console.log(`✅ notes/ front-matter 合规（${notes.length} 篇）`);
    return 0;
  }

  const manifest = { version: 1, notes };
  const text = JSON.stringify(manifest, null, 2) + '\n';

  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (check) {
    if (old === text) {
      console.log(`✅ notes/manifest.json 是最新的（${notes.length} 篇）`);
      return 0;
    }
    console.error('❌ notes/manifest.json 不是最新的——跑 `node tools/build_notes.js` 重建');
    process.exit(1);
  }
  fs.writeFileSync(OUT, text);
  console.log(`✅ 已写入 notes/manifest.json（${notes.length} 篇）`);
  for (const n of notes) console.log(`   ${n.date}  ${n.slug.padEnd(28)} ${n.author}  ${n.title}`);
  return 0;
}

process.exit(main());
