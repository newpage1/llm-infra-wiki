#!/usr/bin/env node
/**
 * 把 module-template.md 的铁律变成可执行的检查。
 *
 * 用法：
 *   node check_module.js <analyses.js> <analysis-id> <module-id>
 *   node check_module.js data/analyses.js lmcache engine
 *   node check_module.js data/analyses.js lmcache --all
 */
const fs = require('fs');
const path = require('path');

const ORDER = ['position', 'structure', 'interface', 'flow', 'impl', 'data', 'files', 'deps'];

/* 仓库读取带缓存——--all 时每个模块都重读一遍整个仓库会把命令拖到超时。 */
const REPO_CACHE = new Map();
function repoData(repo) {
  if (REPO_CACHE.has(repo)) return REPO_CACHE.get(repo);
  const { execFileSync } = require('child_process');
  const fsx = require('fs');
  const pathx = require('path');
  const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  let listing = [], texts = {};
  try {
    listing = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    // 后缀表**必须和 verifyPaths 用的 FILE_EXT 一致**。这里早先是一份手写的小表，
    // 漏了 .cu/.cuh/.c/.rst/.js 等，于是「标识符核对」看不到 CUDA 源码里的名字——
    // lmcache 的 csrc 模块引 `PhaseTimer`（真实存在，在 csrc/cuda/mp_mem_kernels.cu:544）
    // 却被报成「仓库里搜不到」。FILE_EXT 在文件后面才定义，但 repoData 是运行时才调用，
    // 那时它已经初始化了。
    listing.filter(f => FILE_EXT.test(f)).forEach(f => {
      // 优先读工作树——每个文件 spawn 一次 git show 会把 --all 拖到几分钟
      const wt = pathx.join(repo, f);
      try {
        if (fsx.existsSync(wt)) { texts[f] = fsx.readFileSync(wt, 'utf8'); return; }
      } catch (e) { /* 落到 git show */ }
      try { texts[f] = git(['show', 'HEAD:' + f]); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* 不是 git 仓库 */ }
  const d = { listing, texts };
  REPO_CACHE.set(repo, d);
  return d;
}

// 「关键流程」里列出的主要路径条数：数编号列表 ①②③… 或 '### ①' 之类的出现
function countPaths(sec) {
  const txt = sec ? String(sec.html || '') : '';
  const circled = txt.match(/[①②③④⑤⑥⑦⑧⑨]/g) || [];
  const uniq = new Set(circled);
  return uniq.size;
}

// 节上的图数：puml(1) + svg(1) + blocks 里各自的
function figs(sec) {
  if (!sec) return 0;
  let n = 0;
  if (sec.puml || sec.svg) n += 1;
  if (Array.isArray(sec.blocks)) {
    sec.blocks.forEach(b => { if (b.puml || b.svg) n += 1; });
  }
  return n;
}

/* 站内链接：每个 #/... 都要能落到真实目标上。
   目标集合来自同一份数据文件（analyses）以及同目录的 components。 */
function buildLinkTargets(file) {
  const pathx = require('path');
  const fsx = require('fs');
  const dir = pathx.dirname(pathx.resolve(file));
  const ids = new Set();
  const load = (f, pick) => {
    const fp = pathx.join(dir, f);
    if (!fsx.existsSync(fp)) return;
    try {
      delete require.cache[require.resolve(fp)];
      require(fp);
    } catch (e) { return; }
    pick();
  };
  (global.WIKI_ANALYSES || []).forEach(a => {
    ids.add('#/a/' + a.id);
    (a.modules || []).forEach(x => ids.add('#/a/' + a.id + '/' + x.id));
    (a.sections || []).forEach(sec => {
      if (sec.id) ids.add('#/a/' + a.id + '/s/' + sec.id);
    });
  });
  load('components.js', () => {
    (global.WIKI_COMPONENTS || []).forEach(c => ids.add('#/c/' + c.id));
  });
  ids.add('#/'); ids.add('#/n'); ids.add('#/about');
  return ids;
}

function check(m, linkTargets) {
  const errs = [], warns = [], notes = [];
  const secs = m.sections || [];
  const byId = {};
  secs.forEach(s => { byId[s.id] = s; });

  // ① 节顺序
  const ids = secs.map(s => s.id);
  if (ids.length !== ORDER.length || !ORDER.every((w, i) => ids[i] === w)) {
    errs.push(`节顺序不符：${ids.join(',')}\n     期望：${ORDER.join(',')}`);
  }

  // ② 公开 API 只讲对外
  const api = byId.interface;
  if (!api) errs.push('缺「公开 API 与入口」节');
  else {
    const h = String(api.html || '');
    const priv = [...new Set([...h.matchAll(/%%_([a-z][a-z0-9_]*)%%/g)].map(x => '_' + x[1]))];
    if (priv.length) errs.push(`「公开 API」含内部件：${priv.join(', ')}`);
  }

  // ③ 关键流程必须有图
  const flow = byId.flow;
  if (!flow) errs.push('缺「关键流程」节');
  else if (!flow.puml && !flow.svg && !(flow.blocks || []).some(b => b.puml || b.svg))
    errs.push('「关键流程」没有配图（铁律：必须配流程图）');

  // ④ 关键实现：一图一议
  const impl = byId.impl;
  const nPaths = countPaths(flow);
  if (!impl) errs.push('缺「关键实现」节');
  else {
    const nImplFigs = figs(impl);
    if (nPaths && nImplFigs < nPaths)
      warns.push(`「关键流程」列了 ${nPaths} 条主要路径，「关键实现」只有 ${nImplFigs} 张图（铁律：一条路径一张图）`);
    if (nImplFigs === 0) errs.push('「关键实现」没有配图');
    // 每个带图的块都应有解读
    (impl.blocks || []).forEach((b, i) => {
      if (b.puml || b.svg) {
        const has = /读图|图中|这张图/.test(String(b.html || ''));
        if (!has) warns.push(`「关键实现」第 ${i + 1} 块（${b.h3 || '?'}）图后缺少解读段`);
      }
    });
  }

  // ⑤ 关键数据结构要有真实结构体定义
  const data = byId.data;
  if (!data) errs.push('缺「关键数据结构」节');
  else {
    // 数据节的内容可能放在 html，也可能放在 blocks[].html 里——
    // 只看 html 的话，用 blocks 组织的模块会全部误报"缺代码围栏"。
    const h = String(data.html || '') +
      (data.blocks || []).map(b => String(b.html || '')).join('');
    const hasFence = /~~~|\x60\x60\x60/.test(h);
    if (!hasFence) errs.push('「关键数据结构」没有抄出真实结构体定义（缺代码围栏）');
  }

  // ⑥ 关键文件是精读路线
  const files = byId.files;
  if (!files) errs.push('缺「关键文件」节');
  else {
    // 提示语自己说的是「先读什么、为什么」，词表里却只有「优先/第一/第二/精读」——
    // 于是按提示语写的「### 先读什么、为什么」反而判不过（同 §10.21 那一族）。
    // `files` 节的内容也可能放在 blocks 里，一并收齐（同上面 data 节的做法）。
    const h = String(files.html || '') +
      (files.blocks || []).map(b => String(b.html || '')).join('');
    if (!/优先|第一|第二|精读|先读/.test(h))
      warns.push('「关键文件」看不出优先级分档（应当写"先读什么、为什么"）');
  }

  // ⑦ 基于代码：是否有 file:line 引用
  const all = secs.map(s => String(s.html || '') +
    (s.blocks || []).map(b => String(b.html || '')).join('')).join('\n');
  const refs = [...new Set(all.match(/[\w./-]+\.(py|cpp|cc|h|hpp|rs|go|java|ts):\d+/g) || [])];
  const lineRefs = refs.length;
  if (lineRefs === 0) warns.push('全文没有 file:line 引用（铁律：每句话要指得到某一行）');
  else notes.push(`file:line 引用 ${lineRefs} 处`);

  // ⑧ 节名引用：跨节引用必须指向真实存在的一节
  const TITLES = new Set(secs.map(x => x.title));
  const STALE = ['参与的流程', '具体实现', '详细设计',
                 '实现细节', '关键接口', '模块详细实现'];
  const staleHit = STALE.filter(t =>
    all.includes('「' + t + '」') && !TITLES.has(t));
  if (staleHit.length)
    errs.push(`引用了不存在的节名：${staleHit.map(t => '「' + t + '」').join('、')}` +
              `\n     本模块的节是：${[...TITLES].join(' / ')}`);

  // ⑨ 站内链接必须能落地
  if (linkTargets) {
    const allText = secs.map(x => String(x.html || '') +
      (x.blocks || []).map(b => String(b.html || '')).join('')).join('\n') +
      '\n' + (m.notCovered || []).join('\n');
    const dead = [...new Set(allText.match(/#\/[A-Za-z0-9/_-]+/g) || [])]
      .filter(l => !linkTargets.has(l));
    if (dead.length) errs.push(`站内链接指向不存在的目标：${dead.join('、')}`);
  }

  // ⑩ 围栏内的 %%：代码块不经过行内渲染，%% 会原样显示出来
  const inFence = [];
  secs.forEach(x => {
    const scan = (tag, h) => {
      const lines = String(h || '').split('\n');
      let f = false;
      lines.forEach((l, i) => {
        if (l.trim().startsWith('~~~')) { f = !f; return; }
        if (f && l.includes('%%')) inFence.push(`${tag} 第${i + 1}行：${l.trim().slice(0, 60)}`);
      });
    };
    scan(x.id, x.html);
    (x.blocks || []).forEach(b => scan(x.id + '/' + (b.h3 || '').slice(0, 12), b.html));
  });
  if (inFence.length)
    errs.push(`代码块里出现了 %%——围栏内不走行内渲染，会原样显示：\n       ` +
              inFence.join('\n       ') +
              `\n     （围栏内的代码标记应当用反引号，由 fix_fences 去掉）`);

  // ⑪ 模糊措辞：读者看不懂的词
  // `形状` 不在此列：在张量/布局语境里它是**精确的技术名词**（tensor shape），
  // 比如「读形状」「按形状分」「枚举名就是形状」——要求作者改掉它只会让文字变差。
  // 真正含糊的是「这个形状说明…」那种**当"结构/节奏"用**的写法；
  // 这类已在内容侧统一改成「结构 / 节奏 / 模式」（见 SKILL.md §10.28）。
  const VAGUE = ['大概', '大约', '一些', '若干', '等等', '之类',
                 '差不多', '相当', '比较多', '若干个'];
  const hits = [];
  VAGUE.forEach(v => {
    const n = (all.match(new RegExp(v, 'g')) || []).length;
    if (n) hits.push(`${v}×${n}`);
  });
  // 「约 N」这种不可验证的量词
  // 只查"说不清的量"，**不查行数估计**：`4 文件 · 约 6000 行` 是在讲规模，
  // 不是在指代码位置——把它算作模糊措辞，等于逼作者给文件组去求和，
  // 而那个数字每次改动都会漂。规则的原意是"读者能否据此定位代码"。
  const approx = (all.match(/约\s*\d[\d,\.]*(?!\s*万?\s*行)/g) || []);
  if (approx.length) hits.push(`约N×${approx.length}`);
  if (hits.length)
    warns.push(`模糊措辞（读者无法据此在代码里定位）：${hits.join(', ')}`);

  // ⑫ %% 必须成对：单个 %% 会让后面的配对全乱，页面上直接漏出 %% 字面量
  const unpaired = [];
  secs.forEach(x => {
    const scan = (tag, h) => {
      const n = (String(h || '').match(/%%/g) || []).length;
      if (n % 2) unpaired.push(`${tag}（${n} 个，奇数）`);
    };
    scan(x.id, x.html);
    (x.blocks || []).forEach(b => scan(x.id + '/' + (b.h3 || '').slice(0, 12), b.html));
  });
  if (unpaired.length)
    errs.push(`%% 标记没成对（页面会漏出字面量 %%）：${unpaired.join('、')}`);

  // ⑬ 围栏必须带语言标记：带标记的才逐字比对，
  //     裸 ~~~ 会被当成"作者自己的记号"跳过——等于自己放行了引用错误。
  const untagged = [];
  secs.forEach(x => {
    const scan = (tag, h) => {
      const t = String(h || '');
      const re = /~~~([a-z]*)\n/g;
      let m;
      const marks = [];
      while ((m = re.exec(t))) marks.push({ lang: m[1] });
      marks.forEach((mk, i) => { if (i % 2 === 0 && !mk.lang) untagged.push(tag); });
    };
    scan(x.id, x.html);
    (x.blocks || []).forEach(b => scan(x.id + '/' + (b.h3 || '').slice(0, 12), b.html));
  });
  if (untagged.length)
    warns.push(`有 ${untagged.length} 个代码围栏没写语言标记（裸 ~~~）——` +
               `它们不会被逐字校验：${[...new Set(untagged)].join('、')}`);

  // ⑬ 跨节重复的事实：同一个 file:line 出现在多个节里，
  //     改一处要记得改其余——这是"改一半"最容易发生的地方。
  const refHome = new Map();
  secs.forEach(x => {
    const texts = [String(x.html || ''),
                   ...(x.blocks || []).map(b => String(b.html || ''))];
    const here = new Set();
    texts.forEach(t => {
      (t.match(/[\w./-]+\.(py|cpp|cc|h|hpp|rs|go|java|ts):\d+/g) || [])
        .forEach(r => here.add(r));
    });
    here.forEach(r => {
      if (!refHome.has(r)) refHome.set(r, []);
      refHome.get(r).push(x.id);
    });
  });
  const shared = [...refHome.entries()].filter(([, v]) => v.length >= 2);

  // ⑬ 页内重复的行：同一句话出现两次以上，多半是复制粘贴留下的冗余
  const lineCount = new Map();
  secs.forEach(x => {
    const texts = [String(x.html || ''),
                   ...(x.blocks || []).map(b => String(b.html || ''))];
    texts.forEach(t => String(t)
      .replace(/~~~[a-z]*\n[\s\S]*?\n\s*~~~/g, '')     // 围栏里的源码不算
      .split('\n').forEach(l => {
        const k = l.trim();
        if (k.length < 24) return;               // 太短的不算
        if (/^[|>#~`\-]/.test(k)) return;        // 表格/引用/标题不算
        lineCount.set(k, (lineCount.get(k) || 0) + 1);
      }));
  });
  const dupes = [...lineCount.entries()].filter(([, n]) => n >= 2).map(([k]) => k);

  // ⑮ lead 里声称的条数 vs 实际的块数：
  //     加了新块却忘了改 lead 里的数字，是"改一处忘改其余"的典型。
  //     只认**明确在枚举**的写法：「下面 / 分 / 共 / 按 + N + 可数对象」。
  //     早先只匹配裸的「N条」，会把「控制面上的每一条命令」误判成块计数；
  //     改成「N+可数对象」之后又误伤了「各一块」「四条路径各有一张图」
  //     这类正常句子，所以再收紧到必须带枚举引导词。
  const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
               '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const countClaims = [];
  secs.forEach(x => {
    if (!x.lead) return;
    // 「N 步」不算块计数——它说的是流程里的步骤，而块是「一张图 + 它的解析」。
    // kvpool 的 flow lead「共六步」只有 1 个块，早先把这两个概念混在一起报了假警。
    const m = String(x.lead).match(/(?:下面|分为?|共|一共|按)([一二三四五六七八九十])(?:条腿|块|张图|个小节)/);
    if (!m) return;
    const claimed = CN[m[1]];
    const actual = (x.blocks && x.blocks.length) ? x.blocks.length : 0;
    if (actual && claimed !== actual)
      countClaims.push(`${x.id} 的 lead 说「${m[1]}条」，实际有 ${actual} 块`);
  });
  if (countClaims.length)
    warns.push(`lead 里的条数与实际不符：${countClaims.join('；')}`);

  // ⑯ 图总数
  const total = secs.reduce((a, s) => a + figs(s), 0);
  notes.push(`图 ${total} 张`);

  return { errs, warns, notes, refs, shared, dupes };
}

/* 核对引用块（> "..."）里的原文摘录。
   docstring 的引文不在代码围栏里，之前的检查完全没覆盖到——
   结果"FFFFFTTTTTT"这种抄错的字面量藏了十轮才被肉眼发现。
   做法：把引文去掉 markdown 标记、折叠空白，到仓库里找；
   允许长引文逐词缩短后再试，避免因换行差异误报。 */
function verifyQuotes(repo, secs) {
  const { texts } = repoData(repo);
  const files = Object.keys(texts).filter(f => !/^tests\//.test(f));
  if (!files.length) return { err: '无法读取仓库' };
  // docstring 里常带 RST 标记（:class:`X`、``X``），正文引用时一般会剥掉。
  // 这是排版选择、不是事实错误，所以比对前先归一化，避免误报。
  const stripRst = (x) => x
    .replace(/:[a-z]+:(?=``?)/g, '')          // :class: / :param: 之类的前缀
    .replace(/``([^`]+)``/g, '$1')            // 双反引号
    // RST 的**角色**语法用单反引号：:class:`X` / :meth:`X` / :attr:`X`。
    // 上面那行只吃双反引号，于是 :class:`KVFormatSpec` 剥完还是 `KVFormatSpec`——
    // 语料里留着一对反引号，而正文引用时不会写它们，匹配必然失败。
    .replace(/`([^`]+)`/g, '$1')              // 单反引号（RST 角色）
    .replace(/(?<![`\w])`([^`]+)`(?![`\w])/g, '$1')  // 单反引号
    // 语料侧也要剥 markdown 强调——**归一化必须对称**。
    // 页面侧一直在剥 `*`/`**`（见 flush()），语料侧却不剥，
    // 于是设计文档里写成 `- **The master node** centrally manages …` 的句子，
    // 正文规规矩矩引用「The master node centrally manages …」反而永远匹配不上。
    // 同样只剥 `*` 不剥 `_`（下划线是标识符的一部分）。
    .replace(/\*\*/g, '').replace(/\*/g, '')
    // C/C++ 的 `//` 注释标记：正文引用一段注释时，**保留 `//` 才是忠实的**
    // （读者要能看出这是源码注释），但那样每行开头的 `//` 会插进词与词之间，
    // 从句匹配必然失败。两侧对称地把它当空白，引用就既能保留标记、又能匹配上。
    .replace(/\/\//g, ' ')
    // 引号也必须两侧对称：页面侧一直在剥 `"` `“` `”`，
    // 语料里 `"rdma,hip"` 的引号却留着 —— 于是引用 `(e.g. "rdma,hip")`
    // 会被切成 `hip): …`（`"` 没了）而语料里是 `hip"): …`，永远对不上。
    .replace(/[“”"]/g, '');
  const norm = (x) => stripRst(x).replace(/\s+/g, ' ').trim();
  const corpus = norm(files.map(f => texts[f]).join('\n'));

  // 词边界匹配：单纯 includes 查不出"少抄一个字符"——
  // 因为短串本来就是长串的前缀（FFFFFTTTTTT ⊂ FFFFFTTTTTTT）。
  // 所以要求匹配之后紧跟的字符不是字母/数字/下划线。
  const hasWord = (hay, needle) => {
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
      const after = hay[i + needle.length];
      if (after === undefined || !/[A-Za-z0-9_]/.test(after)) return true;
    }
    return false;
  };

  const bad = [];
  let checked = 0;
  secs.forEach(x => {
    const scan = (tag, h) => {
      const lines = String(h || '').split('\n');
      let buf = [];
      const flush = () => {
        if (buf.length < 2) { buf = []; return; }   // 太短的不查
        // 去掉 markdown 标记
        let q = buf.join(' ')
          // 只去 markdown 的**强调**标记：* 与 **。
          // 不能连 `_` 一起去——下划线是标识符的一部分，
          // 剥掉之后 csrc/engine_kv_format.h 会变成 csrc/enginekvformat.h、
          // get_spec_class 会变成 getspecclass，必然匹配失败。
          .replace(/%%/g, '').replace(/\*\*/g, '').replace(/\*/g, '')
          .replace(/\/\//g, ' ')   // 与语料侧对称：见 stripRst 里的说明
          .replace(/[“”"]/g, '').trim();
        if (q.length < 24) { buf = []; return; }
        checked++;
        // 按标点切成子句，每段够长的子句都必须能在仓库里找到。
        // 不能只看"最长匹配前缀"——那样引文中段抄错一个字就查不出来。
        const clauses = norm(q).split(/[,;.\u3002\uff0c\uff1b]+/).map(c => c.trim())
          .filter(c => c.split(' ').length >= 4);
        const miss = clauses.filter(c => !hasWord(corpus, c));
        if (miss.length) bad.push({ tag, text: miss[0].slice(0, 72) });
        buf = [];
      };
      lines.forEach(l => {
        if (/^\s*>/.test(l)) buf.push(l.replace(/^\s*>\s?/, ''));
        else flush();
      });
      flush();
    };
    scan(x.id, x.html);
    (x.blocks || []).forEach(b => scan(x.id + '/' + (b.h3 || '').slice(0, 12), b.html));
  });
  return { checked, bad };
}

/* 核对正文里出现的文件路径是否真实存在、以及是否会产生歧义。
   这是"凭空写出一个路径"这类错误的检查——本项目犯过三次。
   规则：
     · 只查围栏外的正文（围栏里是引用的源码）
     · 跳过 wiki 内部锚点（#/...、a/...）
     · 裸文件名若在仓库里有多个同名 → 报歧义，要求写清相对路径 */
// 被当作"文件"（而非目录）的后缀集合。原先只有 py/cpp/h/hpp，
// 于是 `.md` 设计文档、`.js`/`.rst` 等全被误判成目录名（见 verifyPaths）。
const FILE_EXT = /\.(py|cpp|cc|cxx|h|hpp|hh|c|cu|cuh|md|rst|js|ts|json|yaml|yml|toml|sh|proto|java|go|rs)$/;
// 会被写成 `a/b` 的**散文词组**（不是目录）。见 verifyPaths 里的用法。
const SLASH_WORDS = new Set(['try', 'except', 'finally', 'send', 'recv', 'read', 'write',
  'get', 'set', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'for', 'while', 'return',
  'yield', 'with', 'as', 'import', 'from', 'class', 'def', 'pass', 'break', 'continue',
  'load', 'store', 'put', 'push', 'pull', 'open', 'close', 'start', 'stop', 'lock', 'unlock']);

function verifyPaths(repo, pageTexts) {
  const { listing } = repoData(repo);
  if (!listing.length) return { err: '无法读取仓库' };

  // 目录前缀集合（用于 dir/ 形式的检查）
  const dirs = new Set();
  listing.forEach(f => {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  });
  const byBase = {};
  listing.forEach(f => {
    const b = f.split('/').pop();
    (byBase[b] = byBase[b] || []).push(f);
  });

  const clean = pageTexts.map(t => String(t).replace(/~~~[a-z]*\n[\s\S]*?\n\s*~~~/g, ''));

  const missing = [], ambiguous = [];
  const seen = new Set();
  clean.forEach(t => {
    // 只取 %%...%% 里的路径样式 token
    (t.match(/%%[^%]*%%/g) || []).forEach(span => {
      const tok = span.replace(/%%/g, '').trim();
      if (seen.has(tok)) return;
      seen.add(tok);
      if (/^[#a]\//.test(tok) || tok.includes('#/')) return;      // wiki 锚点
      // 通配不是路径：`devdax_*.py` / `*_l2_adapter.py` 是描述"一类文件"的写法，
      // 拿它去仓库里找具体文件必然找不到。
      // 花括号展开（`naive_serde/{a,b,c}.py`）同理——它是"这几个文件"的简写。
      if (/[*?\[\]{}]/.test(tok)) return;
      // `try/except`、`send/recv` 这类是**散文里的斜杠词组**，不是目录。
      // 判据：每一段都是语言关键字/常见动作词（而不是真实目录名）。
      const segs = tok.split('/');
      if (segs.length >= 2 && segs.every(x => SLASH_WORDS.has(x.toLowerCase()))) return;
      // 后缀表要够全：`.md`/`.rst`/`.js` 这些**文档与脚本**也是被引用的文件。
      // 漏掉它们时，`docs/source/design/architecture.md` 会掉进下面的
      // "目录形式"分支，被要求是个目录——于是真实存在的文件被报成"路径不存在"。
      if (!FILE_EXT.test(tok) && !/^[\w-]+(\/[\w.-]+)+$/.test(tok)) return;
      const base = tok.split('/').pop();

      if (FILE_EXT.test(tok)) {
        const cands = byBase[base] || [];
        if (!cands.length) { missing.push(tok); return; }
        if (cands.length > 1 && !tok.includes('/')) ambiguous.push([tok, cands.length]);
        else if (cands.length > 1 && !cands.some(c => c.endsWith(tok))) missing.push(tok);
      } else {
        // 目录形式：**可以是仓库根相对，也可以是组件内相对**。
        // Mooncake 这类 monorepo 有 mooncake-store/、mooncake-transfer-engine/ 等子工程，
        // 页面按子工程写 `src/transport/rdma_transport` 才是人读的写法；
        // 只认 `startsWith(tok + '/')` 会把这种正确写法全判成"路径不存在"。
        // 判据：`<tok>/` 出现在某个仓库路径的**任意层级**，或它本身就是文件/目录。
        const hit = listing.some(f => f.startsWith(tok + '/') || f === tok
                                   || f.includes('/' + tok + '/') || f.endsWith('/' + tok))
                 || dirs.has(tok);
        if (!hit) missing.push(tok);
      }
    });
  });
  return { missing, ambiguous };
}

/* %%...%% 里的标识符必须能在仓库里搜到。
   只查三类够具体的：CamelCase 类名、_私有名、xxx() 方法名——
   通用词（True / key / mask）和概念词（chunk）不查，否则全是噪声。 */
/* 一页的**全部**文字。原先把 verifyIdentifiers / verifyPaths 的输入限制成
   section.html 与 blocks[].html——于是模块级 lead、分析级 summary/scope
   成了检查盲区（两处真实的"宿主写插件"泄漏就落在这里）。
   凡是出现在页面上的字，都该被查。 */
function allStrings(a, m) {
  const out = [];
  const push = v => { if (typeof v === 'string' && v) out.push(v); };
  const secs = (m ? m.sections : a.sections) || [];
  if (m) {
    push(m.title); push(m.subtitle); push(m.files); push(m.lead);
    (m.notCovered || []).forEach(push);
    (m.designSymbols || []).forEach(push);
  } else {
    push(a.title); push(a.subtitle); push(a.summary); push(a.modulesLead);
    push(a.notCoveredSummary); push(a.host && a.host.name);
    (a.scope || []).forEach(push);
    (a.notCovered || []).forEach(push);
    (a.designUncovered || []).forEach(x => push(x.where));
    (a.designUncovered || []).forEach(x => push(x.sym));
  }
  secs.forEach(s => {
    push(s.title); push(s.lead); push(s.html);
    (s.blocks || []).forEach(b => { push(b.h3); push(b.lead); push(b.html); });
    if (s.table) {
      (s.table.head || []).forEach(push);
      (s.table.rows || []).forEach(r => r.forEach(push));
    }
    (s.chain || []).forEach(c => { push(c.t); push(c.note); });
    if (s.puml) push(s.puml.caption);
  });
  return out;
}

function verifyIdentifiers(repo, pageTexts) {
  const { texts } = repoData(repo);
  const files = Object.keys(texts);
  if (!files.length) return { err: '无法读取仓库' };
  const corpus = files.map(f => texts[f]).join('\n');

  const spans = new Set();
  pageTexts.forEach(t => {
    // 围栏里是引用的源码，不查
    const clean = String(t).replace(/~~~[a-z]*\n[\s\S]*?\n\s*~~~/g, '');
    (clean.match(/%%[^%]+%%/g) || []).forEach(m => spans.add(m.slice(2, -2).trim()));
  });

  const suspicious = [...spans].filter(x =>
    /^([A-Z][A-Za-z0-9]{4,}|_[a-z][a-z0-9_]{3,})$/.test(x) ||
    /^[a-z_][a-z0-9_]{3,}\(\)$/.test(x));
  const missing = suspicious.filter(x => {
    const k = x.replace(/\(\)$/, '').replace(/\./g, '.').split('.')[0];
    return !corpus.includes(k);
  });
  return { checked: suspicious.length, missing };
}

/* 公开方法完整性：模块主类里"有外部调用方"的公开方法，页面必须提到。
   从 mod.files 里解析主文件，取方法最多的那个类当主类。 */
function verifyMethodCoverage(repo, mod, secs, notCovered) {
  const { texts } = repoData(repo);
  const filesField = String(mod.files || '');
  const m = filesField.match(/[\w./-]+\.py/);
  if (!m) return { err: '模块没写主要文件，跳过' };
  const key = Object.keys(texts).find(f => f.endsWith(m[0])) ||
              Object.keys(texts).find(f => f.endsWith(m[0].split('/').pop()));
  if (!key) return { err: '找不到 ' + m[0] };
  const src = texts[key];

  // 找方法最多的类
  const classes = [];
  // `\Z` 不是 JS 的锚点——它会被当成**字面字符 Z**。
  // 于是 `(?=^class |\Z)` 变成「下一处是 class 行、或者有个大写 Z」：
  //  · 类体里出现大写 Z → 类体被提前截断，后面的方法全丢；
  //  · 文件最后一个类之后既没有 class 行也没有 Z → 整个类根本没被捕获；
  //  · 只有一个类的文件就报「主文件里没找到类」（本工具曾在 proxy_memory_obj.py 上如此）。
  // JS 里表达「到输入末尾」应当用 (?! [\s\S])。
  const reC = /^class (\w+)[^\n]*:\n([\s\S]*?)(?=^class |(?![\s\S]))/gm;
  let c;
  while ((c = reC.exec(src))) {
    const body = c[2];
    const ms = [...body.matchAll(/^    def ([a-z]\w*)\(/gm)].map(x => x[1]);
    classes.push({ name: c[1], methods: ms });
  }
  if (!classes.length) return { err: '主文件里没找到类' };
  classes.sort((x, y) => y.methods.length - x.methods.length);
  const main = classes[0];

  // 全部源码，判断"有没有外部调用方"
  const all = Object.keys(texts).map(f => texts[f]).join('\n');
  const pageText = secs.map(x => String(x.html || '') +
    (x.blocks || []).map(b => String(b.html || '')).join('')).join('\n') +
    '\n' + (notCovered || []).join('\n');

  const missing = [], noCaller = [];
  main.methods.forEach(name => {
    if (!/^[a-z]/.test(name)) return;                       // 只看公开
    if (pageText.includes(name)) return;                     // 页面提过
    const callers = (all.match(new RegExp('\\.' + name + '\\(', 'g')) || []).length;
    if (callers > 0) missing.push(name);
    else noCaller.push(name);
  });
  return { cls: main.name, total: main.methods.length, missing, noCaller };
}

/* 核对正文里引用的代码片段。
   做法不再是"每行去全仓库搜"——那样会匹配到别处的无关代码。
   改成：先给整个片段找一个落点，再在那个窗口内逐行验。 */
function verifySnippets(repo, secs) {
  const { texts } = repoData(repo);
  // 代码片段只跟**源码**比对——`.md` 里也有代码示例，
  // 若一并纳入，抄错源码的片段可能恰好命中文档而蒙混过关。
  const files = Object.keys(texts).filter(f => !/^tests\//.test(f) && !/\.md$/.test(f));
  if (!files.length) return { checked: 0, bad: [], err: '无法读取仓库' };
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const corpus = norm(files.map(f => texts[f]).join('\n'));

  const htmls = [];
  secs.forEach(x => {
    htmls.push(String(x.html || ''));
    (x.blocks || []).forEach(b => htmls.push(String(b.html || '')));
  });

  const bad = [], nonContig = [];
  let checked = 0, skippedFences = 0;
  // 这些标记表示"不是源码"，不逐字比对。
  const NON_CODE_LANGS = new Set(['text', 'txt', 'plain', 'plaintext', 'ascii', 'log', 'output']);
  // 注释标记随语言变：Python 是 `#`，C/C++/CUDA 是 `//`。
  // 只剥 `#` 会把 C++ 里的**作者标注行**（`// src/master_service.cpp:252 ——`）
  // 和**行尾标注**（`MASTER_FAILED, // ← 失败态`）当成源码去比对，
  // 于是整页成片报"仓库里找不到"——其实那些行本来就不是源码。
  // 同 §10.14 / §10.21：成片的同一类错，先怀疑检查本身。
  const C_FAMILY = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cu', 'cuh',
                            'java', 'js', 'ts', 'go', 'rust', 'rs', 'proto']);

  htmls.forEach(h => {
    // 只校验"引用的源码"围栏。
    // · 未标记的（~~~）是作者自己的记号（编号清单、结构速写）——
    //   这是本工具最初的约定，snippet 节开头就写明了。
    // · ~~~text 同理：markdown 里 text 的语义就是"这是纯文本、不是代码"。
    //   页面上大量 ASCII 示意图（▼ 按 chunk_size 切 / h0 h1 h2）都放在这里，
    //   它们本来就不该、也不可能在仓库里找到——以前一律当源码比对，
    //   结果 35 个模块里约 200 行示意图被误报成"片段存疑"。
    const re = /~~~([a-z]+)\n([\s\S]*?)\n\s*~~~/g;
    let m;
    while ((m = re.exec(h))) {
      if (NON_CODE_LANGS.has(m[1])) { skippedFences++; continue; }
      const raw = m[2];
      const elided = raw.includes('...');
      // 参与比对的"实体行"
      const bodies = [];
      raw.split('\n').forEach(line => {
        const t = line.trim();
        if (!t || t.includes('...')) return;
        // 按语言剥注释。`//` 不能无脑切：`"http://…"` 里的前一个字符是 `:`，跳过。
        let raw = t;
        if (C_FAMILY.has(m[1])) {
          for (let at = raw.indexOf('//'); at >= 0; at = raw.indexOf('//', at + 1)) {
            if (raw[at - 1] !== ':') { raw = raw.slice(0, at); break; }
          }
        }
        const b = raw.split('#')[0].trim();
        if (b.length >= 8) bodies.push(b);
      });
      if (!bodies.length) continue;
      checked += bodies.length;

      // 给整个片段找落点：拿每一行当锚点，选"窗口内命中最多"的那个
      let best = null;
      bodies.forEach(anchor => {
        // 以这一行为起点：从它的每一处出现都试一次
        const a = norm(anchor);
        for (let at = corpus.indexOf(a); at >= 0; at = corpus.indexOf(a, at + 1)) {
          let p = at - 1, hits = 0, first = at;
          for (const b of bodies) {
            const seg = corpus.indexOf(norm(b), p + 1);
            if (seg >= 0 && seg - first < 4000) { p = seg; hits++; }
          }
          const span = p - first;
          // 命中数优先；同分时取窗口最紧的——这样能避开"锚到别处恰好也命中"的情况
          if (!best || hits > best.hits || (hits === best.hits && span < best.span))
            best = { anchor, first, hits, span };
          if (best.hits === bodies.length && best.span < 600) break;
        }
      });

      // 只有当片段自身就找不到落点时，才逐行全仓库报缺失
      if (best && best.hits === bodies.length) {
        if (!elided) { /* 命中且连续，无事 */ }
        continue;
      }
      // 落点不完整：报出在窗口里找不到的那些行
      const missing = [];
      if (best && best.first >= 0) {
        let p = best.first - 1;
        bodies.forEach(b => {
          const seg = corpus.indexOf(norm(b), p + 1);
          if (seg >= 0 && seg - best.first < 4000) { p = seg; return; }
          if (!corpus.includes(norm(b))) missing.push(b);   // 全仓库都没有 → 确实不存在
        });
      } else {
        bodies.forEach(b => { if (!corpus.includes(norm(b))) missing.push(b); });
      }
      if (missing.length) missing.forEach(b => bad.push({ line: b.slice(0, 78) }));
      else if (!elided && best && best.first >= 0)
        nonContig.push(`${bodies[0].slice(0, 50)}  [命中 ${best.hits}/${bodies.length}，窗口 ${best.span} 字符]`);
    }
  });

  return { checked, bad, nonContig: [...new Set(nonContig)] };
}

/* 把 file:line 拿到仓库里核对：行号是否越界、同名文件是否歧义。
   repo 用 git show HEAD:<path> 读，因为工作树可能被删过文件。 */
function verifyRefs(repo, refs) {
  const { listing, texts } = repoData(repo);
  if (!listing.length) return [{ ref: '-', msg: '无法读取仓库（需要在 git 仓库里）' }];

  const byBase = {};
  listing.forEach(p => {
    const b = p.split('/').pop();
    (byBase[b] = byBase[b] || []).push(p);
  });

  const out = [];
  refs.forEach(ref => {
    const m = ref.match(/^(.*):(\d+)$/);
    const given = m[1], ln = parseInt(m[2], 10);
    const base = given.split('/').pop();
    const cands = byBase[base] || [];
    if (!cands.length) { out.push({ ref, msg: '仓库里找不到这个文件名' }); return; }
    // 只有一个候选：直接用它
    // 给了带目录的路径：按后缀唯一匹配
    // 只给 basename 且有多个同名：**报歧义**，不要瞎猜
    let hit = null;
    if (cands.length === 1) hit = cands[0];
    else if (given.includes('/')) {
      const suf = cands.filter(c => c.endsWith(given) || c.endsWith('/' + given));
      if (suf.length === 1) hit = suf[0];
      else { out.push({ ref, msg: `路径片段匹配到 ${suf.length} 个：${suf.slice(0,3).join(', ')}` }); return; }
    } else {
      out.push({ ref, msg: `只写了文件名，仓库里有 ${cands.length} 个同名文件，无法确定是哪个：\n` +
                          cands.slice(0, 4).map(c => '                  · ' + c).join('\n') +
                          '\n                  → 正文里请写清相对路径' });
      return;
    }
    const body = texts[hit];
    if (body === undefined) { out.push({ ref, msg: '读取失败' }); return; }
    const lines = body.split('\n');
    if (ln < 1 || ln > lines.length) {
      out.push({ ref, msg: `行号越界：${hit} 只有 ${lines.length} 行` });
    } else {
      out.push({ ref, ok: true, file: hit, text: (lines[ln - 1] || '').trim().slice(0, 60) });
    }
  });
  return out;
}

/* ── 总分结构：总体设计图 ↔ 关键模块 ─────────────────────────────
   本项目反复犯的错：总体设计的图里画了一个方框（类名 / 目录），
   而「关键模块」里没有它的家——读者顺着图往下找，找不到。

   判据是**声明式**的，不用启发式（启发式试过，误报太多）：
     · 图里的**方框标题**（svg 里 class 含 t-title-sm 的 <text>）是符号全集
     · 每个模块用 designSymbols: [...] 显式认领它讲的方框
     · 认领不到、又确实还没写的，在 analysis.designUncovered 里登记
   三种违规：
     · 方框无人认领、也没登记                    → 错误
     · 一个方框被两个以上模块认领                → 错误（读者不知道去哪看）
     · 模块认领了图里根本没有的符号              → 提示（声明已过期）
*/
function designBoxLabels(analysis) {
  const out = new Map();                       // label -> 它出现在哪个小节
  const svgs = [];
  (analysis.sections || []).forEach(s => {
    if (s.svg) svgs.push([s.id, String(s.svg)]);
    (s.blocks || []).forEach(b => { if (b.svg) svgs.push([s.id, String(b.svg)]); });
  });
  svgs.forEach(([sid, svg]) => {
    const re = /<text[^>]*class="[^"]*t-title-sm[^"]*"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(svg))) {
      const label = m[1].replace(/<[^>]*>/g, '').trim();
      if (label && !out.has(label)) out.set(label, sid);
    }
  });
  return out;
}

/* 图里的**层带标签**（class 含 t-band 的 <text>）。
   为什么单独抽：有些模块是"一层"而不是"一个方框"——
   比如 Integration 对应的是「INTEGRATION · 集成层」这个带，
   而它认领的方框是层内的 integration/vllm/ 与 integration/sglang/。
   只读方框的话，这种模块名在图上"看不见"，但其实是有的。 */
function designBandLabels(analysis) {
  const out = new Set(), svgs = [];
  (analysis.sections || []).forEach(s => {
    if (s.svg) svgs.push(String(s.svg));
    (s.blocks || []).forEach(b => { if (b.svg) svgs.push(String(b.svg)); });
  });
  svgs.forEach(svg => {
    const re = /<text[^>]*class="[^"]*t-band[^"]*"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(svg))) {
      const t = m[1].replace(/<[^>]*>/g, '').trim();
      if (t) out.add(t);
    }
  });
  return out;
}

/* 模块名是不是落在某个层带上（而不是方框上）。 */
function titleOnBand(title, bands) {
  const norm = x => String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const t = norm(title);
  if (!t) return null;
  for (const b of bands) if (norm(b).includes(t)) return b;
  return null;
}

/* 符号必须作为**独立 token** 出现在方框标签里——
   P2P 不该匹配到 P2PController，否则一个声明会认领两个框。 */
function labelClaims(label, sym) {
  if (!sym) return false;
  const isWord = c => /[A-Za-z0-9_]/.test(c);
  let i = label.indexOf(sym);
  while (i >= 0) {
    const before = i === 0 ? '' : label[i - 1];
    const after = label[i + sym.length] || '';
    if (!isWord(before) && !isWord(after)) return true;
    i = label.indexOf(sym, i + 1);
  }
  return false;
}

function verifyDesignCoverage(analysis) {
  const labels = designBoxLabels(analysis);
  if (!labels.size)
    return { err: '总体设计里没找到带 t-title-sm 的方框——图没按约定写？' };

  const claims = new Map();                    // sym -> [moduleId]
  (analysis.modules || []).forEach(m => {
    (m.designSymbols || []).forEach(sym => {
      if (!claims.has(sym)) claims.set(sym, []);
      claims.get(sym).push(m.id);
    });
  });
  const reg = new Map();                       // sym -> where，已登记未覆盖
  (analysis.designUncovered || []).forEach(x => reg.set(x.sym, x.where || ''));
  // 属于**别的组件或宿主**的方框：本页画了它，但它的家在别处。
  // 这与 designUncovered（"本该有页但还没写"）是两回事，所以分开登记——
  // 混在一起会让"还欠多少页"这个数虚高。
  const ext = new Map();                       // sym -> of，归属分析 id
  (analysis.designExternal || []).forEach(x => ext.set(x.sym, x.of || ''));

  const orphan = [], dup = [], stale = [], hit = new Set(), regHit = [], extHit = [];
  const labelOwner = new Map();      // label -> 'claim' | 'ext'（reg 不算归属）
  labels.forEach((sid, label) => {
    const owners = [];
    claims.forEach((mods, sym) => {
      if (labelClaims(label, sym)) { owners.push(...mods); hit.add(sym); }
    });
    const uniq = [...new Set(owners)];
    if (uniq.length > 1) { dup.push([label, uniq]); return; }
    if (uniq.length === 1) { labelOwner.set(label, 'claim'); return; }
    const e = [...ext.keys()].filter(s => labelClaims(label, s));
    if (e.length) { labelOwner.set(label, 'ext'); e.forEach(s => { hit.add(s); extHit.push([label, ext.get(s)]); }); return; }
    const r = [...reg.keys()].filter(s => labelClaims(label, s));
    if (r.length) { r.forEach(s => { hit.add(s); regHit.push([label, reg.get(s)]); }); return; }
    orphan.push([label, sid]);
  });
  claims.forEach((mods, sym) => { if (!hit.has(sym)) stale.push([sym, mods]); });
  // 登记了、但已经有模块认领 —— **旧账没销**。
  // 这里必须报出来：下面（以及页面上那块提示）都只对"没被认领"的方框去查 designUncovered，
  // 所以一条过时登记会被静默忽略 —— 校验器报 0 错误，而页面上那块提示却多数一个。
  const staleReg = [];
  reg.forEach((_, sym) => {
    // 过时 = 这个登记符号所对应的方框，已经被某个模块（或 designExternal）认领了。
    // 不能用 hit.has(sym)：登记自己生效时也会进 hit，那样会把正常账目误报成过时。
    const labels_ = [...labels.keys()].filter(l => labelClaims(l, sym));
    if (labels_.some(l => labelOwner.has(l))) staleReg.push(sym);
  });
  // 模块名落在层带上、且没有任何方框认领它 —— 这是合法的（它是"一层"），
  // 但必须报出来，否则读者在方框里找不到这个名字，会以为图漏了。
  const bands = designBandLabels(analysis);
  const onBand = [];
  (analysis.modules || []).forEach(m => {
    // 判据是「这个模块的认领符号有没有落在某个方框上」——
    // 而不是「模块名有没有出现在某个符号里」。后者问反了：
    // Integration 的符号 integration/vllm/ 本来就是方框，它不该被列进来。
    const syms = m.designSymbols || [];
    const hasBox = syms.some(sym => labels.has(sym)) ||
                   syms.some(sym => [...labels.keys()].some(l => labelClaims(l, sym)));
    if (hasBox) return;
    const b = titleOnBand(m.title, bands);
    if (b) onBand.push([m.title, b]);
  });
  return { labels, orphan, dup, stale, regHit, extHit, staleReg, bands, onBand };
}

/* ── 宿主不写插件（SKILL.md §3.0.00 的落地检查）──────────────────
   规则是单向的：宿主页**一处都不提**插件（连"另见"也不要），插件页可以大段援引宿主。
   判据：宿主源码里有没有任何一行知道插件存在。多数情况没有，所以宿主页不该出现它。

   做法：插件在自己的分析对象上声明 pluginOf 与 aliasNames；
   宿主侧不需要改任何东西。然后拿这些名字去宿主的**全页文字**里扫（含 lead / summary / scope——
   这两处真实的泄漏原先就在检查盲区里）。
*/
function verifyCrossReferences(analyses) {
  const out = [];
  const textsOf = new Map();
  // **必须带上模块页**——模块级 lead 与模块小节同样是宿主页的一部分
  // （第一版漏了这里，于是 TokensHash / cost_model 两处没被抓到）
  analyses.forEach(a => textsOf.set(a.id,
    allStrings(a, null).concat(
      (a.modules || []).flatMap(m => allStrings(a, m))
    ).join('\n')));
  analyses.forEach(host => {
    const ht = textsOf.get(host.id) || '';
    analyses.filter(p => p.pluginOf === host.id).forEach(p => {
      const names = [...new Set([p.id, p.title, p.repo, ...(p.aliasNames || [])])]
        .filter(n => typeof n === 'string' && n.length >= 4);
      names.forEach(n => {
        let i = ht.indexOf(n);
        while (i >= 0) {
          out.push({
            host: host.id, plugin: p.id, name: n,
            ctx: ht.slice(Math.max(0, i - 55), i + n.length + 55).replace(/\s+/g, ' '),
          });
          i = ht.indexOf(n, i + 1);
        }
      });
    });
  });
  return out;
}

function load(file) {
  const abs = path.resolve(file);
  global.window = global;
  delete require.cache[abs];
  require(abs);
  return global.WIKI_ANALYSES || [];
}

const argv = process.argv.slice(2);
let repo = null;
const ri = argv.indexOf('--repo');
if (ri >= 0) { repo = argv[ri + 1]; argv.splice(ri, 2); }
const di = argv.indexOf('--design');
const designMode = di >= 0;
if (designMode) argv.splice(di, 1);
const xi = argv.indexOf('--cross');
const crossMode = xi >= 0;
if (crossMode) argv.splice(xi, 1);
const [file, aid, mid] = argv;
if (!file || (!crossMode && !aid) || (!designMode && !crossMode && !mid)) {
  console.error('用法：node check_module.js <analyses.js> <analysis-id> <module-id|--all> [--repo <path>]\n' +
                '      node check_module.js <analyses.js> <analysis-id> --design [--repo <path>]\n' +
                '      node check_module.js <analyses.js> --cross      # 宿主不写插件（§3.0.00）');
  process.exit(2);
}
if (crossMode) {
  const all = load(file);
  const v = verifyCrossReferences(all);
  console.log('跨组件引用：宿主页不得提到插件（SKILL.md §3.0.00）');
  const rel = all.filter(a => a.pluginOf);
  if (!rel.length) console.log('     （没有分析声明 pluginOf，跳过）');
  rel.forEach(p => console.log(`     已声明：${p.id} 建立在 ${p.pluginOf} 之上（别名 ${(p.aliasNames || []).length} 个）`));
  if (v.length) {
    console.log(`\n     错误：${v.length} 处宿主写了插件——宿主页应一处都不提：`);
    v.forEach(x => console.log(`       ✗ ${x.host} 提到「${x.name}」（属于 ${x.plugin}）\n         …${x.ctx}…`));
  } else console.log('\n     ✓ 没有宿主页提到它的插件');
  console.log(`\n合计：${v.length} 个错误，0 个提示`);
  process.exit(v.length ? 1 : 0);
}

const analysis = load(file).find(a => a.id === aid);
if (!analysis) { console.error('找不到分析：' + aid); process.exit(2); }

if (designMode) {
  const d = verifyDesignCoverage(analysis);
  let dbad = 0, dwarn = 0;
  console.log(`总分结构：${analysis.id} —— 总体设计图里的方框 ↔ 关键模块`);
  if (d.err) { console.log('     ' + d.err); process.exit(2); }
  console.log(`     方框 ${d.labels.size} 个 · 认领声明 ${(analysis.modules || [])
    .reduce((n, m) => n + (m.designSymbols || []).length, 0)} 条 · 登记未覆盖 ${(analysis.designUncovered || []).length} 条`
    + (d.bands && d.bands.size ? ` · 层带标签 ${d.bands.size} 个（也读，见下）` : ''));
  if (d.orphan.length) {
    console.log(`\n     错误：${d.orphan.length} 个方框没有任何模块认领（读者顺着图往下找不到）：`);
    d.orphan.forEach(([l, sid]) => console.log(`       ✗ ${l.padEnd(46)} （画在「${sid}」）`));
    console.log('       → 三条出路：给它建模块 / 从图里删掉 / 登记进 designUncovered');
    dbad += d.orphan.length;
  }
  if (d.dup.length) {
    console.log(`\n     错误：${d.dup.length} 个方框被多个模块同时认领（读者不知道去哪看）：`);
    d.dup.forEach(([l, ms]) => console.log(`       ✗ ${l.padEnd(46)} 认领者：${ms.join('、')}`));
    dbad += d.dup.length;
  }
  if (d.stale.length) {
    console.log(`\n     提示：${d.stale.length} 条认领声明在图上找不到对应方框（声明过期？）：`);
    d.stale.forEach(([sym, ms]) => console.log(`       · ${sym.padEnd(46)} 声明者：${ms.join('、')}`));
    dwarn += d.stale.length;
  }
  if (d.extHit.length) {
    console.log(`\n     属于别处的方框 ${d.extHit.length} 个（本页只援引，不展开）：`);
    d.extHit.forEach(([l, of]) => console.log(`       · ${l.padEnd(46)} 属于 ${of}`));
  }
  if (d.regHit.length) {
    console.log(`\n     登记在案的未覆盖方框 ${d.regHit.length} 个（不算错误，但它们在图上仍是"找不到家"）：`);
    d.regHit.forEach(([l, w]) => console.log(`       · ${l.padEnd(46)} ${w}`));
  }
  if (d.staleReg.length) {
    console.log(`\n     提示：${d.staleReg.length} 条 designUncovered 登记已经有模块认领了（该销账）：`);
    d.staleReg.forEach(x => console.log(`       · ${x}`));
    dwarn += d.staleReg.length;
  }
  if (d.onBand.length) {
    console.log(`\n     模块名在「层带标签」上而不在方框里 ${d.onBand.length} 个（合法——它们是"层"）：`);
    d.onBand.forEach(([t, b]) => console.log(`       · ${t.padEnd(34)} ↔ 层带「${b}」`));
  }
  if (!d.orphan.length && !d.dup.length)
    console.log('\n     ✓ 图上每个方框都有家：要么有模块，要么在 designUncovered 里登记');
  console.log(`\n合计：${dbad} 个错误，${dwarn} 个提示`);
  process.exit(dbad ? 1 : 0);
}

const mods = mid && mid !== '--all'
  ? (analysis.modules || []).filter(m => m.id === mid)
  : (analysis.modules || []);
if (!mods.length) { console.error('找不到模块：' + mid); process.exit(2); }

const linkTargets = buildLinkTargets(file);
let bad = 0, warn = 0;
mods.forEach(m => {
  const res = check(m, linkTargets);
  const { errs, warns, notes, shared, dupes } = res;
  const tag = errs.length ? '❌' : (warns.length ? '⚠️ ' : '✅');
  console.log(`${tag} ${m.id}  (${notes.join(' · ')})`);
  errs.forEach(e => console.log('     错误：' + e));
  warns.forEach(w => console.log('     提示：' + w));
  if (shared && shared.length) {
    console.log(`     跨节重复的事实 ${shared.length} 条（改一处记得改其余）：`);
    shared.slice(0, 6).forEach(([r, where]) =>
      console.log(`       ${r.padEnd(44)} 出现在：${where.join('、')}`));
    if (shared.length > 6) console.log(`       …另有 ${shared.length - 6} 条`);
  }
  if (dupes && dupes.length) {
    console.log(`     页内重复的行 ${dupes.length} 处（多半是复制粘贴留下的冗余）：`);
    dupes.slice(0, 4).forEach(d => console.log(`       ${d.slice(0, 76)}`));
    if (dupes.length > 4) console.log(`       …另有 ${dupes.length - 4} 处`);
    warn += dupes.length;
  }
  bad += errs.length; warn += warns.length;
  if (repo) {
    const vr = verifyRefs(repo, res.refs);
    const badRefs = vr.filter(x => !x.ok);
    if (badRefs.length) {
      badRefs.forEach(x => console.log('     行号存疑：' + x.ref + ' → ' + x.msg));
      bad += badRefs.length;
    } else {
      console.log(`     行号核对：${vr.length} 处全部在范围内；读到的源码行如下——`);
      console.log('                （请自己确认每一行确实是你想引用的那一行）');
      vr.forEach(x => console.log(`       ${x.ref.padEnd(46)} ${x.text || ''}`));
    }
    // 公开方法完整性
    const vm = verifyMethodCoverage(repo, m, m.sections || [], m.notCovered || []);
    if (vm.err) console.log('     方法覆盖：' + vm.err);
    else if (vm.missing.length) {
      console.log(`     方法未覆盖（${vm.cls} 里这些公开方法有调用方，但页面没提）：`);
      vm.missing.forEach(x => console.log('       ' + x));
      bad += vm.missing.length;
    } else {
      console.log(`     方法覆盖：${vm.cls} 的公开方法都提到过` +
                  (vm.noCaller.length ? `（${vm.noCaller.length} 个无调用方，未提也合理）` : ''));
    }

    // %%...%% 里的标识符
    const vi = verifyIdentifiers(repo, allStrings(analysis, m));
    if (vi.err) console.log('     标识符核对：' + vi.err);
    else if (vi.missing.length) {
      console.log(`     标识符存疑（${vi.missing.length} 处，仓库里搜不到）：`);
      vi.missing.forEach(x => console.log('       ' + x));
      bad += vi.missing.length;
    } else console.log(`     标识符核对：${vi.checked} 个名字都能在仓库里搜到`);

    // 引用块的原文摘录
    const vq = verifyQuotes(repo, m.sections || []);
    if (vq.err) console.log('     引文核对：' + vq.err);
    else if (vq.bad.length) {
      console.log(`     引文存疑（${vq.bad.length} 处，仓库里找不到这段原文）：`);
      vq.bad.forEach(b => console.log(`       [${b.tag}] ${b.text}…`));
      bad += vq.bad.length;
    } else console.log(`     引文核对：${vq.checked} 段摘录与仓库原文一致`);

    // 路径存在性与歧义
    const vp = verifyPaths(repo, allStrings(analysis, m));
    if (vp.err) console.log('     路径核对：' + vp.err);
    else {
      if (vp.missing.length) {
        console.log(`     路径不存在（${vp.missing.length} 处，仓库里找不到）：`);
        vp.missing.forEach(x => console.log('       ' + x));
        bad += vp.missing.length;
      }
      if (vp.ambiguous.length) {
        console.log(`     路径有歧义（${vp.ambiguous.length} 处，同名文件不止一个，请写相对路径）：`);
        vp.ambiguous.forEach(([x, n]) => console.log(`       ${x}  —— 有 ${n} 个同名`));
        bad += vp.ambiguous.length;
      }
      if (!vp.missing.length && !vp.ambiguous.length)
        console.log('     路径核对：文中出现的每个路径都唯一存在');
    }

    // 引用片段的保真度：正文里的每一行代码，仓库里必须有
    const vs = verifySnippets(repo, m.sections || []);
    if (vs.err) console.log('     片段核对：' + vs.err);
    else if (vs.bad.length) {
      console.log(`     片段存疑：核对 ${vs.checked} 行，${vs.bad.length} 行在仓库里找不到——`);
      vs.bad.forEach(b => console.log(`       ${b.line}`));
      bad += vs.bad.length;
    } else {
      console.log(`     片段核对：${vs.checked} 行代码全部与仓库原文一致`);
    }
    if (vs.nonContig && vs.nonContig.length) {
      console.log(`     片段不连续（无省略号，但各行在源码里并不相邻）${vs.nonContig.length} 处：`);
      vs.nonContig.forEach(x => console.log(`       ${x}`));
    }
  }
});
console.log(`\n合计：${bad} 个错误，${warn} 个提示（共 ${mods.length} 个模块）`);
process.exit(bad ? 1 : 0);
