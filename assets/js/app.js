/* ============================================================
   LLM Infra Wiki — 应用逻辑（hash 路由 / 渲染 / 搜索 / TOC）
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const view = $('#view');
  const LAYERS = window.WIKI_LAYERS;
  const COMPS = window.WIKI_COMPONENTS;
  const BY = window.WIKI_BY_ID;
  const DETAILS = window.WIKI_DETAILS;

  const layerOf = id => window.WIKI_LAYER_BY_ID[id];
  const layerInfoOf = c => window.layerInfoOf(c);   // 兼容底座组件
  const SUBSTRATES = window.WIKI_SUBSTRATES || [];
  const STACKS = window.WIKI_STACKS || [];
  const RUNS = window.WIKI_RUNS || {};
  const PORTS = window.WIKI_PORTS || {};

  /* ---------------- 栈视角 ----------------
     默认昇腾栈。切换不隐藏任何组件，只改变排序、强调与全链路的实现脉络注解。 */
  let STACK = (function () {
    try { return localStorage.getItem('wiki-stack') || 'ascend'; } catch (e) { return 'ascend'; }
  })();

  const stackMeta = id => STACKS.find(s => s.id === id) || { id: id, name: id, en: id };
  const otherStack = () => (STACK === 'ascend' ? 'nvidia' : 'ascend');
  const runsOf = c => c.runs || [];

  /* 排序权重：0 = 仅当前栈 · 1 = 双栈 · 2 = 仅另一条栈 */
  function ecoRank(c) {
    const cur = runsOf(c).includes(STACK), oth = runsOf(c).includes(otherStack());
    if (cur && !oth) return 0;
    if (cur && oth) return 1;
    return 2;
  }
  /* 卡片角标：专属显示栈名，两条栈都支持显示「双栈」——一律用绝对名称，不用「本栈/另一栈」 */
  function runsBadge(c) {
    const cur = runsOf(c).includes(STACK), oth = runsOf(c).includes(otherStack());
    const portName = (PORTS[c.port] || {}).name || '';
    if (cur && oth) return { text: '双栈', color: 'var(--muted)',
      title: ['两条栈都有官方或主线落地', portName].filter(Boolean).join(' · ') };
    const only = runsOf(c)[0] || otherStack();
    const m = RUNS[only] || { name: only, color: '#8a7a67' };
    return { text: m.name, color: m.color,
      title: [m.name + '专属', portName].filter(Boolean).join(' · ') };
  }

  function setStack(id) {
    STACK = id;
    try { localStorage.setItem('wiki-stack', id); } catch (e) { /* file:// 下可能不可用 */ }
    syncStackButtons();
    route();
  }

  function syncStackButtons() {
    document.querySelectorAll('#stackswitch button').forEach(b => {
      const on = b.dataset.stack === STACK;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /* ---------------------------------------------------- helpers */
  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* 图的外壳：滚动容器 + 「点图放大」提示。
     窄屏下 .diagram 保留 min-width（见 style.css 末尾），靠这个容器横滑——
     否则 1200 宽的架构图会被压到 300 多 px，10.5px 的标注实际只有 3px。 */
  function figCanvas(svg) {
    const fig = el('figure', { class: 'fig' });
    fig.appendChild(el('div', { class: 'flow-canvas' }, svg));
    fig.appendChild(el('figcaption', { class: 'fig-hint' }, '点图放大 · 窄屏可左右滑动'));
    return fig;
  }

  function detailOf(id) { return DETAILS[id] || null; }

  /* ============================================================
     首页
     ============================================================ */
  function renderHome() {
    const deep = COMPS.filter(c => (detailOf(c.id) || {}).draft !== true).length;
    const mods = COMPS.reduce((n, c) => {
      const d = detailOf(c.id);
      return n + (d && d.modules ? d.modules.length : 0);
    }, 0);

    const wrap = el('div', { class: 'fade-in' });

    /* ---- hero ---- */
    const subComps = window.componentsOfLayer('substrate');
    wrap.appendChild(el('section', { class: 'hero' }, `
      <div class="wrap">
        <p class="eyebrow">Layered Reference · 2026</p>
        <h1>把大模型推理<br><span class="hl">拆成四层来看</span></h1>

        <p class="lede">
          一个按技术栈分层整理的大模型推理基础设施知识库。
          每个组件都讲清三件事——<strong>它解决什么问题</strong>、
          <strong>关键抽象落在哪几个文件里</strong>、
          <strong>一次请求在它内部怎么流动</strong>，
          并标注昇腾与 NVIDIA 两条栈各自由谁实现。
        </p>

        <div class="stats">
          <div class="stat"><b>${LAYERS.length}</b><span>Layers 层级</span></div>
          <div class="stat stat-sub"><b>${subComps.length}</b><span>Substrates 底座</span></div>
          <div class="stat"><b>${COMPS.length}</b><span>Components 组件</span></div>
          <div class="stat"><b>${mods}</b><span>Modules 模块走读</span></div>
          <div class="stat"><b>${deep}</b><span>Deep Dives 完整走读</span></div>
        </div>

        <p class="usage">
          <span class="usage-label">怎么用</span>
          <a href="#/l/scheduling">按层浏览组件</a>
          <a href="#" data-focus-search>搜到具体模块</a>
          <a href="#" data-switch-stack>切换栈视角做对比</a>
          <span class="usage-plain">展开折叠看某层在链路中承担什么</span>
        </p>
      </div>
    `));

    /* ---- 部署拓扑：先给一张图，建立直观概念 ---- */
    wrap.appendChild(buildTopology());

    /* ---- 技术栈分层：层内展开 + 层间交互带 ---- */
    const stack = el('section', { class: 'stack' }, `
      <div class="wrap">
        <div class="stack-head">
          <h2>技术栈分层</h2>
          <p>一个请求进来，在层内做什么、在层间传什么</p>
        </div>
        <p class="stack-note">${window.md(window.WIKI_FLOW.note || '').html.replace(/^<p>|<\/p>$/g, '')}</p>
      </div>
    `);
    const stackWrap = $('.wrap', stack);

    LAYERS.forEach((L, idx) => {
      if (idx > 0) stackWrap.appendChild(buildXBand(L.id, LAYERS[idx - 1]));

      /* L3 是 fabric，不是顺序中的一环：用不同的形态表达 */
      if (L.id === 'transport') {
        stackWrap.appendChild(buildFabricBand(L, idx));
        return;
      }

      const rail = el('div', {
        class: 'rail', id: 'layer-' + L.id,
        style: `--c:${L.color};--c-dim:${L.colorDim};--cw:${L.wash};--i:${idx}`
      });

      rail.appendChild(el('div', { class: 'rail-id' }, `
        <span class="rail-num">${L.num} / ${esc(L.en).toUpperCase()}</span>
        <h3 class="rail-name">${esc(L.name)}</h3>
        <span class="rail-en">${esc(L.en)}</span>
        <p class="rail-tag">${esc(L.tagline)}</p>
      `));

      const body = el('div', { class: 'rail-body' });

      /* 本层组件 —— 主内容，放最前 */
      const comps = window.componentsOfLayer(L.id).slice();
      const other = otherStack();
      const nCur = comps.filter(c => runsOf(c).includes(STACK) && !runsOf(c).includes(other)).length;
      const nBoth = comps.filter(c => runsOf(c).includes(STACK) && runsOf(c).includes(other)).length;
      const nOther = comps.length - nCur - nBoth;
      const mix = [
        nCur ? `${esc(stackMeta(STACK).name)} ${nCur}` : '',
        nBoth ? `双栈 ${nBoth}` : '',
        nOther ? `${esc(stackMeta(other).name)} ${nOther}` : ''
      ].filter(Boolean).join(' · ');
      const cs = el('div', { class: 'rail-block rail-block-main' });
      cs.appendChild(el('div', { class: 'rail-label' },
        `本层组件 · ${comps.length}<em class="rail-mix">${mix}</em>`));
      const chips = el('div', { class: 'chips' });
      comps.forEach(c => chips.appendChild(chip(c)));
      cs.appendChild(chips);
      body.appendChild(cs);

      /* 本层要回答的问题 */
      const qs = el('div', { class: 'rail-block' });
      qs.appendChild(el('div', { class: 'rail-label' }, '本层要回答的问题'));
      L.questions.forEach(q => qs.appendChild(el('div', { class: 'rail-q' }, esc(q))));
      body.appendChild(qs);

      /* 链路步骤：默认折叠，放在最后 */
      const stepsEl = buildRailSteps(L.id, true);
      if (stepsEl) body.appendChild(stepsEl);

      rail.appendChild(body);
      stackWrap.appendChild(rail);
    });

    wrap.appendChild(stack);

    /* ---- 底座带（不属于四层，纵向穿透）---- */
    SUBSTRATES.forEach(sub => {
      const band = el('div', { class: 'substrate', id: 'layer-' + sub.id,
        style: `--c:${sub.color};--cw:${sub.wash}` });
      const cur = stackMeta(STACK);
      band.appendChild(el('div', { class: 'substrate-id' }, `
        <span class="substrate-num">L0 / ${esc(sub.en).toUpperCase()}</span>
        <h3 class="substrate-name">${esc(sub.label)}</h3>
        <span class="substrate-en">${esc(sub.en)}</span>
        <p class="substrate-note">${esc(sub.note)}</p>
        <p class="substrate-cur">当前视角：<b>${esc(cur.name)}</b> · 底座为 ${esc((window.WIKI_BY_ID[cur.substrate] || {}).name || '—')}</p>
      `));
      const bodyEl = el('div', { class: 'substrate-body' });
      const chips = el('div', { class: 'chips' });
      window.componentsOfLayer(sub.id).forEach(c => chips.appendChild(chip(c)));
      bodyEl.appendChild(chips);
      band.appendChild(bodyEl);
      stackWrap.appendChild(band);
    });

    /* ---- 闭环：L4 的结果回流到 L1 ---- */
    const lb = window.WIKI_LOOPBACK;
    if (lb) {
      const up = window.WIKI_LAYER_BY_ID[lb.from];
      const to = window.WIKI_LAYER_BY_ID[lb.to];
      const band = el('div', { class: 'loopback', style: `--from:${up.color};--to:${to.color}` });
      band.innerHTML = `
        <div class="loopback-arrow" aria-hidden="true">↻</div>
        <div class="loopback-body">
          <b>${esc(lb.title)}</b>
          <span>${window.md(lb.desc).html.replace(/^<p>|<\/p>$/g, '')}</span>
        </div>
        <div class="loopback-path">
          <em style="color:${up.color}">${esc(up.num)} ${esc(up.name)}</em>
          <i>──▶</i>
          <em style="color:${to.color}">${esc(to.num)} ${esc(to.name)}</em>
        </div>`;
      stackWrap.appendChild(band);
    }

    view.replaceChildren(wrap);
    document.title = 'LLM Infra Wiki · 大模型推理基础设施分层知识库';
  }

  /* 层内的「本层在链路中承担」——辅助信息，默认折叠、放在最后 */
  function buildRailSteps(layerId, collapsed) {
    const steps = window.flowStepsOfLayer(layerId);
    if (!steps.length) return null;
    const PH = window.flowPhaseOf();
    const d = el('details', { class: 'rail-steps' });
    if (!collapsed) d.open = true;
    d.appendChild(el('summary', null,
      `本层在链路中承担<em>${steps.length} 步</em><span class="rs-caret"></span>`));
    const list = el('div', { class: 'steplist' });
    steps.forEach(st => {
      const impl = st.impl ? st.impl[STACK] : null;
      const ph = PH[st.n] || '';
      list.appendChild(el('div', { class: 'srow' }, `
        <em class="snum">${String(st.n).padStart(2, '0')}</em>
        <span class="stitle">
          ${ph ? `<em class="sphase" data-ph="${esc(ph)}">${esc(ph)}</em>` : ''}${esc(st.title)}
          ${st.optional ? '<em class="sopt" title="在其它路径下不发生">条件</em>' : ''}
        </span>
        <span class="sdesc">${window.md(st.desc).html.replace(/^<p>|<\/p>$/g, '')}</span>
        ${impl ? `<span class="simpl"><b>${esc(stackMeta(STACK).name)}</b>${window.md(impl).html.replace(/^<p>|<\/p>$/g, '')}</span>` : ''}
      `));
    });
    d.appendChild(list);
    return d;
  }

  /* ------------------------------------------------------------
     L3 的 fabric 形态：横向贯穿带，左侧画出双向连接脊
     ------------------------------------------------------------ */
  function buildFabricBand(L, idx) {
    const band = el('div', {
      class: 'fabric', id: 'layer-' + L.id,
      style: `--c:${L.color};--c-dim:${L.colorDim};--cw:${L.wash};--i:${idx}`
    });
    const comps = window.componentsOfLayer(L.id);
    const stepList = window.flowStepsOfLayer(L.id);
    const PH = window.flowPhaseOf();

    band.appendChild(el('div', { class: 'fab-id' }, `
      <span class="fab-num">${L.num} / ${esc(L.en).toUpperCase()}</span>
      <h3 class="fab-name">${esc(L.name)}</h3>
      <span class="fab-badge">▲ 接 L2 <i>⇄</i> 接 L4 ▼　fabric</span>
      <p class="fab-tag">${esc(L.tagline)}</p>
      <p class="fab-pair">本层组件 ${comps.length} · 承担链路步骤 ${stepList.length}</p>
    `));

    const body = el('div', { class: 'fab-body' });

    // 组件在前（主内容）
    const cs = el('div', { class: 'fab-block fab-block-main' });
    cs.appendChild(el('div', { class: 'rail-label' }, '本层组件 · ' + comps.length));
    const chips = el('div', { class: 'chips' });
    comps.forEach(c => chips.appendChild(chip(c)));
    cs.appendChild(chips);
    body.appendChild(cs);

    // 边界声明（这一层最需要说清的事）
    body.appendChild(el('p', { class: 'fab-bound' },
      window.md('边界：**H2D / D2H 不属于本层**（需要按 slot_mapping 散进分页池，属引擎侧）；' +
                '「搬哪些、什么时候搬」也由引擎侧 Connector 决定。')
        .html.replace(/^<p>|<\/p>$/g, '')));

    // 链路步骤：折叠
    const stepsEl = buildRailSteps(L.id, true);
    if (stepsEl) body.appendChild(stepsEl);

    band.appendChild(body);
    return band;
  }

  /* ------------------------------------------------------------
     部署拓扑：手绘 SVG，精确坐标 + 矢量图形
     ------------------------------------------------------------ */
  function buildTopology() {
    // 芯片：本体 + 两侧引脚 + die + 标号
    const chip = (x, y, lbl, c) => {
      const pin = (px, py) => `<rect x="${px}" y="${py}" width="5" height="3" rx="1.5" fill="${c}" opacity=".55"/>`;
      const pins = [16, 29, 42].map(d => pin(x - 6, y + d) + pin(x + 99, y + d)).join('');
      return `
        ${pins}
        <rect x="${x}" y="${y}" width="98" height="62" rx="6" fill="url(#icg)" stroke="${c}" stroke-opacity=".45"/>
        <rect x="${x + 34}" y="${y + 17}" width="30" height="16" rx="2" fill="${c}" fill-opacity=".3" stroke="${c}" stroke-opacity=".5"/>
        <text x="${x + 49}" y="${y + 50}" class="t-chip" fill="${c}">${lbl}</text>`;
    };
    const chipRow = (x, y, k, n, c) =>
      Array.from({ length: n }, (_, i) => chip(x + i * 116, y, k + (i + 1), c)).join('');

    const svg = `
<svg viewBox="0 0 1200 672" class="topo-svg" role="img" aria-label="部署拓扑图">
  <defs>
    <linearGradient id="icg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#fffdf8"/><stop offset="1" stop-color="#f4ede2"/>
    </linearGradient>
    <clipPath id="cp1"><rect x="20" y="20" width="1160" height="86" rx="10"/></clipPath>
    <clipPath id="cp2"><rect x="20" y="152" width="500" height="216" rx="10"/></clipPath>
    <clipPath id="cp3"><rect x="680" y="152" width="500" height="216" rx="10"/></clipPath>
    <clipPath id="cp4"><rect x="20" y="420" width="1160" height="232" rx="10"/></clipPath>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
      <path d="M0,1 L9,5 L0,9 z" fill="#d5c7b0"/>
    </marker>
  </defs>

  <!-- ═══ 请求链 ═══ -->
  <rect x="20" y="20" width="1160" height="86" rx="10" fill="var(--panel)" stroke="var(--line)"/>
  <rect x="20" y="20" width="1160" height="3" fill="var(--l1)" clip-path="url(#cp1)"/>
  <text x="54" y="60" class="t-title">应用 / Agent</text>
  <text x="54" y="81" class="t-sub">发起推理请求</text>
  <line x1="404" y1="63" x2="426" y2="63" class="t-line" marker-end="url(#ah)"/>
  <text x="474" y="60" class="t-title">网关</text>
  <text x="474" y="81" class="t-sub">协议适配 · 鉴权</text>
  <line x1="844" y1="63" x2="866" y2="63" class="t-line" marker-end="url(#ah)"/>
  <text x="914" y="60" class="t-title">集群调度</text>
  <text x="914" y="81" class="t-sub">KV-aware 路由</text>

  <!-- ═══ 路由 ═══ -->
  <line x1="600" y1="106" x2="600" y2="146" class="t-line" marker-end="url(#ah)"/>
  <rect x="452" y="116" width="296" height="20" fill="var(--bg)"/>
  <text x="600" y="130" class="t-mono" text-anchor="middle">路由依据：KV 命中率 / 队列深度 / 显存水位</text>

  <!-- ═══ Prefill 池 ═══ -->
  <rect x="20" y="152" width="500" height="216" rx="10" fill="var(--panel)" stroke="var(--line)"/>
  <rect x="20" y="152" width="500" height="3" fill="var(--l2)" clip-path="url(#cp2)"/>
  <text x="44" y="188" class="t-title">Prefill 池</text>
  <text x="150" y="188" class="t-sub">计算 prompt 的 KV</text>
  ${chipRow(47, 226, 'P', 4, 'var(--l2)')}
  <text x="44" y="334" class="t-mono">计算密集 · 吞吐优先</text>

  <!-- ═══ Decode 池 ═══ -->
  <rect x="680" y="152" width="500" height="216" rx="10" fill="var(--panel)" stroke="var(--line)"/>
  <rect x="680" y="152" width="500" height="3" fill="var(--l2)" clip-path="url(#cp3)"/>
  <text x="704" y="188" class="t-title">Decode 池</text>
  <text x="810" y="188" class="t-sub">用 KV 逐 token 生成</text>
  ${chipRow(707, 226, 'D', 4, 'var(--l2)')}
  <text x="704" y="334" class="t-mono">访存密集 · 时延优先</text>

  <!-- ═══ KV 直传通道 ═══ -->
  <rect x="540" y="152" width="120" height="216" fill="var(--l3)" fill-opacity=".05"/>
  <line x1="540" y1="152" x2="540" y2="368" stroke="var(--l3)" stroke-opacity=".35" stroke-dasharray="5 5"/>
  <line x1="660" y1="152" x2="660" y2="368" stroke="var(--l3)" stroke-opacity=".35" stroke-dasharray="5 5"/>
  <text x="600" y="250" class="t-kv" text-anchor="middle">KV 直传</text>
  <text x="600" y="274" class="t-mono-c" text-anchor="middle">P → D</text>
  <text x="600" y="300" class="t-sub" text-anchor="middle">与计算重叠</text>

  <!-- ═══ 汇聚 ═══ -->
  <path d="M270,368 V392 H930 V368" fill="none" stroke="#d5c7b0" stroke-width="1.5"/>
  <line x1="600" y1="392" x2="600" y2="414" class="t-line" marker-end="url(#ah)"/>
  <text x="620" y="408" class="t-mono">写入 / 取回</text>

  <!-- ═══ KV 存储池 ═══ -->
  <rect x="20" y="420" width="1160" height="232" rx="10" fill="var(--panel)" stroke="var(--line)"/>
  <rect x="20" y="420" width="1160" height="3" fill="var(--l4)" clip-path="url(#cp4)"/>
  <text x="44" y="456" class="t-title">KV 存储池</text>
  <text x="176" y="456" class="t-sub">跨请求、跨实例复用同一段前缀</text>

  <text x="354" y="486" class="t-col" text-anchor="middle">本地</text>
  <text x="896" y="486" class="t-col" text-anchor="middle">远端</text>
  <text x="64" y="526" class="t-row" text-anchor="middle">DRAM</text>
  <text x="64" y="598" class="t-row" text-anchor="middle">SSD</text>

  ${[
    [94, 496, '本机主机内存', '微秒级 · TB 量级'],
    [636, 496, '集群内存池', '十微秒级 · 集群内存总量'],
    [94, 568, '单机盘 · GDS', '百微秒级 · 十 TB 量级'],
    [636, 568, '分布式文件系统 · 3FS', '毫秒级 · PB 量级'],
  ].map(([x, y, n, m]) => `
    <rect x="${x}" y="${y}" width="520" height="60" rx="7"
          fill="var(--l4)" fill-opacity=".07" stroke="var(--l4)" stroke-opacity=".4"/>
    <text x="${x + 18}" y="${y + 26}" class="t-cell">${n}</text>
    <text x="${x + 18}" y="${y + 46}" class="t-mono">${m}</text>`).join('')}
</svg>`;

    const sec = el('section', { class: 'topo', id: 'topology' });
    const w = el('div', { class: 'wrap' });
    w.appendChild(el('div', { class: 'stack-head' }, `
      <h2>部署拓扑</h2>
      <p>请求路径 · 实例形态 · 通信关系</p>
    `));
    w.appendChild(el('div', { class: 'topo-canvas' }, svg));
    w.appendChild(el('p', { class: 'topo-note' },
      window.md('两条通信路径需区分：**P → D 直传**传输的是本次请求自身的 KV，是 PD 分离的必经环节；' +
                '**实例 ⇄ 存储池**复用的是此前请求留下的前缀，即通常所说的「缓存命中」。')
        .html.replace(/^<p>|<\/p>$/g, '')));
    sec.appendChild(w);
    return sec;
  }

  /* ------------------------------------------------------------
     层间交互带：相邻两层之间的双向往来
     下行 = 请求 / 指令；上行 = 状态 / 反馈。只画下行会漏掉一半——
     L1 的路由决策依赖 L2 上报的负载，L2 能否继续算依赖 L3 的到位通知。
     ------------------------------------------------------------ */
  function buildXBand(lowerId, upperLayer) {
    const X = (window.WIKI_INTERACTIONS || []).find(x => x.lower === lowerId);
    const lower = window.WIKI_LAYER_BY_ID[lowerId];
    if (!X || !lower) return el('div', { class: 'connector' });

    const stepTag = ns => (ns || []).length
      ? `<em class="xn">${ns.map(n => String(n).padStart(2, '0')).join(' · ')}</em>` : '';

    const flow = (dir, data, layer) => `
      <div class="xflow ${dir}" style="--lc:${layer.color};--lcd:${layer.colorDim};--lcw:${layer.wash}">
        <span class="xline" aria-hidden="true"></span>
        <span class="xt">${stepTag(data.steps)}${esc(data.title)}</span>
        <span class="xd">${esc(data.desc)}</span>
      </div>`;

    return el('div', {
      class: 'xband',
      style: `--up:${upperLayer.color};--lo:${lower.color}`
    }, `
      <div class="xband-side">
        <b>层间交互</b>
        <span class="xpair">${esc(upperLayer.num)} <i>⇄</i> ${esc(lower.num)}</span>
      </div>
      <div class="xband-rows">
        ${flow('down', X.down, upperLayer)}
        ${flow('up', X.up, lower)}
      </div>
    `);
  }

  /* 组件卡片：带可运行栈标签；排序靠前的常驻色条，靠后的淡化 */
  function chip(c) {
    const L = layerInfoOf(c);
    const b = runsBadge(c);
    const rank = ecoRank(c);
    const a = el('a', {
      class: 'chip' + (rank === 2 ? ' chip-dim' : '') + (rank === 0 ? ' chip-mine' : ''),
      href: '#/c/' + c.id,
      style: `--c:${L.color};--c-dim:${L.colorDim};--ec:${b.color}`
    });
    const detail = detailOf(c.id);
    const draft = detail && detail.draft;
    a.innerHTML = `
      <div class="chip-top">
        <span class="chip-name">${esc(c.name)}</span>
        <span class="chip-eco${b.text === '双栈' ? ' chip-eco-both' : ''}" title="${esc(b.title)}">${esc(b.text)}</span>
        ${draft ? '<span class="chip-x">骨架</span>' : ''}
      </div>
      <span class="chip-role">${esc(c.role)}</span>`;
    return a;
  }

  /* ============================================================
     组件详情页
     ============================================================ */
  function renderComponent(id) {
    const c = BY[id];
    if (!c) { view.replaceChildren(el('div', { class: 'wrap about' }, '<h1>未找到该组件</h1><p><a href="#/">返回全景</a></p>')); return; }

    const detail = detailOf(id) || { overview: '> 该组件的内容正在整理中。', modules: [] };
    const layer = layerInfoOf(c);
    const styleVars = `--c:${layer.color};--c-dim:${layer.colorDim}`;

    const doc = el('div', { class: 'doc fade-in', style: styleVars });
    doc.appendChild(buildSidebar(id));

    /* ---- main ---- */
    const main = el('article', { class: 'doc-main' });

    // breadcrumbs
    const crumbs = el('nav', { class: 'crumbs' });
    crumbs.innerHTML = `<a href="#/">全景</a><span>/</span><a href="#/l/${layer.id}">${esc(layer.num)} ${esc(layer.name)}</a><span>/</span><span>${esc(c.name)}</span>`;
    main.appendChild(crumbs);

    // head
    const head = el('header', { class: 'doc-head' });
    head.innerHTML = `
      <div class="badge">${esc(layer.num)} · ${esc(layer.name)}</div>
      <h1>${esc(c.name)}</h1>
      <p class="doc-tagline">${esc(c.role)}</p>
      <div class="meta-row">
        <span class="meta">ORG · ${esc(c.org)}</span>
        <span class="meta">LANG · ${esc(c.lang || '—')}</span>
        <span class="meta" style="color:${runsBadge(c).color};border-color:${runsBadge(c).color}33">
          RUNS · ${runsOf(c).map(r => esc((RUNS[r] || {}).name || r)).join(' + ')}
        </span>
        <span class="meta">PORT · ${esc((PORTS[c.port] || {}).name || c.port || '—')}</span>
        ${c.repo ? `<span class="meta">REPO · <a href="${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.repo.replace(/^https?:\/\/(www\.)?/, ''))}</a></span>` : ''}
        ${detail.draft ? '<span class="meta" style="color:' + layer.color + '">骨架内容 · 待补完</span>' : ''}
      </div>
      ${(() => {
        const an = (window.WIKI_ANALYSES || []).find(x => x.component === id);
        if (!an) return '';
        return `<a class="deep-link" href="#/a/${esc(an.id)}" style="--dc:${layer.color}">
          <em>深度分析</em>
          <b>${esc(an.title)}</b>
          <span>${esc(an.subtitle || '')}</span>
          <i>→</i>
        </a>`;
      })()}`;
    if (c.portNote) {
      main.appendChild(el('div', { class: 'portnote', style: `--c:${layer.color};--cd:${layer.colorDim};--cw:${layer.wash}` },
        `<b>归类依据</b><span>${esc(c.portNote)}</span>`));
    }
    main.appendChild(head);

    // 特点速览（来自本地组件分析）
    if (c.highlights && c.highlights.length) {
      const hl = el('section', { class: 'highlights', id: 'highlights' });
      hl.appendChild(el('h2', { class: 'hl-head' },
        `特点速览<em>${c.highlights.length} 条</em>`));
      const ul = el('ul', { class: 'hl-list' });
      c.highlights.forEach(x => ul.appendChild(el('li', null,
        window.md(x).html.replace(/^<p>|<\/p>$/g, ''))));
      hl.appendChild(ul);
      main.appendChild(hl);
    }

    // overview
    const ovSec = el('section', { class: 'prose', id: 'overview' });
    const ov = window.md(detail.overview || '');
    ovSec.innerHTML = ov.html;
    main.appendChild(ovSec);

    // modules
    const mods = detail.modules || [];
    if (mods.length) {
      const mh = el('div', { class: 'mod-head' }, `
        <h2 id="modules">代码流程 · 子模块</h2>
        <p>${mods.length} 个模块 · 点击展开</p>`);
      main.appendChild(mh);

      const list = el('div', { class: 'modules' });
      mods.forEach((m, i) => list.appendChild(buildModule(m, i, mods.length)));
      main.appendChild(list);
    }

    doc.appendChild(main);
    doc.appendChild(buildToc(ov.toc, mods, !!(c.highlights && c.highlights.length)));
    view.replaceChildren(doc);
    document.title = `${c.name} · LLM Infra Wiki`;
    window.scrollTo({ top: 0 });
  }

  function buildModule(m, i, total) {
    const d = el('details', { class: 'module', id: 'm-' + m.id });
    if (i === 0) d.open = true;
    d.innerHTML = `
      <summary>
        <span class="mod-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="mod-title">${esc(m.name)}</span>
        <span class="mod-sum">${esc(m.summary || '')}</span>
        <span class="mod-caret"></span>
      </summary>
      <div class="mod-body"></div>`;
    const body = $('.mod-body', d);

    if (m.files && m.files.length) {
      const f = el('div', { class: 'files' });
      m.files.forEach(p => f.appendChild(el('span', { class: 'file' }, esc(p))));
      body.appendChild(f);
    }
    if (m.refs && m.refs.length) {
      const f = el('div', { class: 'files' });
      m.refs.forEach(x => f.appendChild(el('a', {
        class: 'file file-link', href: x.u, target: '_blank', rel: 'noopener'
      }, esc(x.t) + ' ↗')));
      body.appendChild(f);
    }
    if (m.flow && m.flow.length) {
      const ol = el('ol', { class: 'flow' });
      m.flow.forEach(s => ol.appendChild(el('li', null, window.md(s).html.replace(/^<p>|<\/p>$/g, ''))));
      body.appendChild(ol);
    }
    if (m.points && m.points.length) {
      const ul = el('ul', { class: 'pts' });
      m.points.forEach(s => ul.appendChild(el('li', null, window.md(s).html.replace(/^<p>|<\/p>$/g, ''))));
      body.appendChild(ul);
    }
    return d;
  }

  function buildSidebar(activeId) {
    const side = el('aside', { class: 'doc-side' });
    LAYERS.forEach(L => {
      const g = el('div', { class: 'side-group', style: `--c:${L.color}` });
      g.innerHTML = `<a href="#/l/${L.id}"><span class="side-num">${L.num}</span>${esc(L.name)}</a>`;
      const ul = el('ul', { class: 'side-list' });
      window.componentsOfLayer(L.id).forEach(c => ul.appendChild(sideItem(c, L, c.id === activeId)));
      g.appendChild(ul);
      side.appendChild(g);
    });
    SUBSTRATES.forEach(sub => {
      const g = el('div', { class: 'side-group', style: `--c:${sub.color}` });
      g.innerHTML = `<a href="#/l/substrate"><span class="side-num">L0</span>${esc(sub.label)}</a>`;
      const ul = el('ul', { class: 'side-list' });
      window.componentsOfLayer(sub.id).forEach(c => ul.appendChild(sideItem(c, sub, c.id === activeId)));
      g.appendChild(ul);
      side.appendChild(g);
    });
    return side;
  }

  function sideItem(c, L, on) {
    const li = el('li');
    li.appendChild(el('a', {
      href: '#/c/' + c.id, class: on ? 'on' : '', style: `--c:${L.color}`
    }, esc(c.name)));
    return li;
  }

  function buildToc(ovToc, mods, hasHL) {
    const toc = el('aside', { class: 'doc-toc' });
    let h = '<h5>本页目录</h5><ul>';
    if (hasHL) h += '<li><a href="#highlights" data-anchor="highlights">特点速览</a></li>';
    ovToc.filter(t => t.level === 2).forEach(t => {
      h += `<li><a href="#${t.id}" data-anchor="${t.id}">${esc(t.text)}</a></li>`;
    });
    if (mods.length) h += `<li><a href="#modules" data-anchor="modules">代码流程</a></li>`;
    h += '</ul>';
    toc.innerHTML = h;
    return toc;
  }

  /* ============================================================
     关于页
     ============================================================ */
  /* ============================================================
     深度分析：单组件模块代码分析（结构见 code-arch-analysis skill）
     ============================================================ */
  /* markdown 渲染出的表格同样需要横向滚动容器，否则窄屏撑破页面 */
  function wrapTables(root) {
    root.querySelectorAll('table').forEach(t => {
      if (t.parentElement && t.parentElement.classList.contains('tw')) return;
      const d = document.createElement('div');
      d.className = 'tw';
      t.parentNode.insertBefore(d, t);
      d.appendChild(t);
    });
  }

  /* 渲染一个分析小节（组件级与模块级共用） */
  /* 载入一个 PlantUML SVG 到 holder；失败时给出可行动的提示。 */
  function loadPuml(holder, url) {
    fetch(url)
      .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
      .then(t => { holder.innerHTML = t; })
      .catch(() => {
        const fail = el('p', { class: 'puml-fail' },
          '类图未能加载（' + esc(url) + '）。运行 diagrams/render.sh 重新生成。');
        holder.replaceWith(fail);
      });
  }

  /* 有序块：让「图 → 解析 → 图 → 解析」成为可能。
     没有 blocks 时退回原来的固定顺序（html → svg → chain → table → puml）。 */
  function renderBlock(b) {
    const out = [];
    if (b.h3) out.push(el('h3', { class: 'an-h3', id: 'a-' + b.h3id }, esc(b.h3)));
    if (b.lead) out.push(el('p', { class: 'an-lead' },
      window.md(b.lead).html.replace(/^<p>|<\/p>$/g, '')));
    if (b.svg) out.push(figCanvas(b.svg));
    if (b.puml) {
      const box = el('div', { class: 'puml-box' });
      box.appendChild(el('div', { class: 'puml-cap' },
        `<b>PlantUML</b><span>${esc(b.puml.caption || '')}</span>`));
      if (b.puml.svgUrl) {
        box.appendChild(el('div', { class: 'puml-render', 'data-src': b.puml.svgUrl }, '载入中…'));
        loadPuml(box.querySelector('.puml-render'), b.puml.svgUrl);
      }
      out.push(box);
    }
    if (b.html) out.push(el('div', { class: 'an-body' }, window.md(b.html).html));
    return out;
  }

  function buildAnSection(sec) {
    const s2 = el('section', { class: 'an-sec' });
    s2.appendChild(el('h2', { class: 'flow-h2', id: 'a-' + sec.id }, esc(sec.title)));
    if (sec.lead) s2.appendChild(el('p', { class: 'an-lead' },
      window.md(sec.lead).html.replace(/^<p>|<\/p>$/g, '')));
    if (sec.blocks) {
      sec.blocks.forEach(b => renderBlock(b).forEach(n => s2.appendChild(n)));
      return s2;
    }
    if (sec.puml) {
      const box = el('div', { class: 'puml-box' });
      box.appendChild(el('div', { class: 'puml-cap' },
        `<b>PlantUML</b><span>${esc(sec.puml.caption || '')}</span>`));
      s2.appendChild(box);
      // PlantUML 在构建期渲染，运行时按需取回注入
      if (sec.puml.svgUrl) {
        const holder = el('div', { class: 'puml-render' });
        box.appendChild(holder);
        loadPuml(holder, sec.puml.svgUrl);
      }
    }
    if (sec.svg) s2.appendChild(figCanvas(sec.svg));
    if (sec.html) s2.appendChild(el('div', { class: 'an-body' }, window.md(sec.html).html));
    if (sec.chain) {
      const ol = el('ol', { class: 'leg-steps' });
      sec.chain.forEach(st => ol.appendChild(el('li', null, `
        <span class="ls-t">${window.md(st.t).html.replace(/^<p>|<\/p>$/g, '')}</span>
        <code class="ls-a">${esc(st.a)}</code>
        ${st.note ? `<span class="ls-n">${window.md(st.note).html.replace(/^<p>|<\/p>$/g, '')}</span>` : ''}
      `)));
      s2.appendChild(ol);
    }
    if (sec.table) {
      const t = el('table', { class: 'seam-table an-table' });
      t.innerHTML = `<thead><tr>${sec.table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${sec.table.rows.map(r => `<tr>${r.map(cell =>
          `<td>${window.md(String(cell)).html.replace(/^<p>|<\/p>$/g, '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
      s2.appendChild(el('div', { class: 'tw' }, null));
      s2.lastChild.appendChild(t);
    }
    wrapTables(s2);
    return s2;
  }

  /* 模块的分组顺序——正文与侧栏目录必须用同一份，否则两处顺序会不一致。
     同名 group 必须合并：模块在数组里可以不相邻（例如 MP 模式与嵌入模式交错），
     只按相邻游程分组会重复输出同一个标题、并把一组拆成好几块。
     组间顺序由模块上的 groupRank 决定（缺省则保持首次出现顺序）。 */
  function groupModules(a) {
    const order = [], bucket = new Map();
    (a.modules || []).forEach(m => {
      const g = m.group || '';
      if (!bucket.has(g)) {
        bucket.set(g, { rank: (typeof m.groupRank === 'number' ? m.groupRank : 1e6), mods: [] });
        order.push(g);
      }
      bucket.get(g).mods.push(m);
    });
    order.sort((x, y) => bucket.get(x).rank - bucket.get(y).rank);
    return order.map(g => ({ group: g, mods: bucket.get(g).mods }));
  }

  /* 总分结构：模块入口紧跟在「总体设计」之后——那里才是讲分解的地方 */
  function buildModulesBlock(a) {
    const sec = el('section', { class: 'an-sec', id: 'a-modules' });
    sec.appendChild(el('h2', { class: 'flow-h2' }, '关键模块'));
    // 必须过 window.md()——与另外两处 lead（renderBlock / buildAnSection）保持一致。
    // 原样传字符串的话，里面的 ** 会当字面星号显示出来（本项目已犯过一次）。
    sec.appendChild(el('p', { class: 'an-lead' },
      window.md(a.modulesLead ||
        '上面是整体与接缝；下面这几个模块承担了主要复杂度，各自单独展开。')
        .html.replace(/^<p>|<\/p>$/g, '')));
    // 总分结构的欠账要摆在读者眼前：总体设计图里画了、但下面还没有模块的方框。
    // 数据来自 analysis.designUncovered——它同时被 check_module.js --design 校验，
    // 补一个模块就删一条，两处不会走偏。
    // 必须减掉已被模块认领的符号——与 check_module.js --design 用同一条规则。
    // 直接读 designUncovered 的话，一条「已经有家了但没删」的旧登记会让这里多报一个，
    // 而校验器那边静默忽略它——两边对同一件事给出不同说法。
    const claimed = new Set();
    (a.modules || []).forEach(m => (m.designSymbols || []).forEach(sym => claimed.add(sym)));
    const gap = (a.designUncovered || []).filter(x => !claimed.has(x.sym));
    if (gap.length) {
      sec.appendChild(el('div', { class: 'mod-gap' },
        `<b>图上还有 ${gap.length} 个方框没有模块</b>` +
        `<span>——它们已在页末<a href="#/a/${a.id}/s/notcovered">「未覆盖」</a>登记，` +
        `但在上面那张总体设计图里仍找不到家：</span>` +
        `<ul>${gap.map(x =>
          `<li><code>${esc(x.sym)}</code>${x.where ? ' ' + esc(x.where) : ''}</li>`).join('')}</ul>`));
    }
    // 模块清单要能看出它对应总体设计的哪一部分
    groupModules(a).forEach(({ group, mods }) => {
      if (group) sec.appendChild(el('h3', { class: 'mod-group' }, group));
      const grid = el('div', { class: 'mod-grid' });
      sec.appendChild(grid);
      mods.forEach(m => {
        const num = (m.sections || []).length;
        grid.appendChild(el('a', {
          class: 'mod-card' + (m.draft ? ' mod-draft' : ''), href: '#/a/' + a.id + '/' + m.id
        }, `
          <em>${esc(m.files || '')}</em>
          <b>${esc(m.title)}</b>
          <span>${esc(m.subtitle || '')}</span>
          <i>${m.draft ? '待补完' : num + ' 节'}</i>
        `));
      });
    });
    return sec;
  }

  function renderAnalysis(id, moduleId, scrollTo) {
    const a = (window.WIKI_ANALYSES || []).find(x => x.id === id);
    if (!a) {
      view.replaceChildren(el('div', { class: 'wrap about' },
        '<h1>未找到该分析</h1><p><a href="#/">返回全景</a></p>'));
      return;
    }
    const c = BY[a.component];
    const mod = moduleId ? (a.modules || []).find(m => m.id === moduleId) : null;
    const wrap = el('div', { class: 'wrap anpage fade-in' });
    const main = el('main', { class: 'an-main' });

    main.appendChild(el('nav', { class: 'crumbs' },
      `<a href="#/c/${a.component}">${esc(c ? c.name : a.component)}</a><span>/</span>` +
      (mod ? `<a href="#/a/${a.id}">深度分析</a><span>/</span><span>${esc(mod.title)}</span>`
           : '<span>深度分析</span>')));

    if (mod) {
      main.appendChild(el('header', { class: 'flow-head' }, `
        <p class="an-modtag">模块分析</p>
        <h1>${esc(mod.title)}</h1>
        <p class="flow-sub">${esc(mod.subtitle || '')}</p>
        <div class="an-meta">
          <span><em>所属组件</em>${esc(c ? c.name : a.component)}</span>
          ${mod.files ? `<span><em>主要文件</em><code>${esc(mod.files)}</code></span>` : ''}
          ${mod.loc ? `<span><em>规模</em>${esc(mod.loc)}</span>` : ''}
        </div>
        ${mod.lead ? `<p class="flow-summary">${window.md(mod.lead).html.replace(/^<p>|<\/p>$/g, '')}</p>` : ''}
      `));
      (mod.sections || []).forEach(sec => main.appendChild(buildAnSection(sec)));
      // 「未覆盖」不再是独立一节，而是文末的一个小段——读者据此判断可信度。
      if (mod.notCovered && mod.notCovered.length) {
        main.appendChild(el('div', { class: 'an-notcov' }, `
          <b>本文未读</b>
          <ul>${mod.notCovered.map(x =>
            `<li>${window.md(x).html.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>
        `));
      }
      main.appendChild(el('div', { class: 'an-back' },
        `<a href="#/a/${a.id}">← 返回《${esc(a.title)}》</a>`));
    } else {
      main.appendChild(el('header', { class: 'flow-head' }, `
        <h1>${esc(a.title)}</h1>
        <p class="flow-sub">${esc(a.subtitle || '')}</p>
        <div class="an-meta">
          <span><em>仓库</em>${esc(a.repo)}</span>
          <span><em>分析版本</em><code>${esc(a.revision)}</code></span>
          ${a.host ? `<span><em>宿主</em>${esc(a.host.name)} <code>${esc(a.host.tag)}</code></span>` : ''}
          <span><em>日期</em>${esc(a.date || '')}</span>
        </div>
        ${a.summary ? `<p class="flow-summary">${window.md(a.summary).html.replace(/^<p>|<\/p>$/g, '')}</p>` : ''}
        ${a.scope ? `<div class="an-scope"><b>本次覆盖</b><ul>${a.scope.map(x => `<li>${window.md(x).html.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
        ${a.notCovered ? `<div class="an-scope an-out"><b>未覆盖</b><ul>${a.notCovered.map(x => `<li>${window.md(x).html.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>` : ''}
      `));
      // 「关键模块」的位置：**紧跟「关键流程」之后**。
      // 顺序依据：定位与职责 → 总体设计 → 关键接口 → 关键流程 → 关键模块 → 模块详细实现。
      const secs = a.sections || [];
      const anchorSec =
        secs.find(x => x.id === 'flows') ||
        secs.find(x => x.id === 'flow') ||
        secs.find(x => x.id === 'design') ||
        secs.find(x => x.svg) ||
        secs[0];
      secs.forEach(sec => {
        main.appendChild(buildAnSection(sec));
        if (anchorSec && sec.id === anchorSec.id && a.modules && a.modules.length) {
          main.appendChild(buildModulesBlock(a));
        }
      });
    }

    // 左侧粘性目录：组件级列全部小节；模块级列组件小节 + 模块清单
    const side = el('aside', { class: 'an-side' });
    side.appendChild(el('b', { class: 'an-side-h' }, mod ? '模块目录' : '本页目录'));
    const nav = el('nav', { class: 'an-side-nav' });
    if (mod) {
      const base = '#/a/' + a.id + '/' + mod.id + '/s/';
      (mod.sections || []).forEach(sec => nav.appendChild(el('a', { href: base + sec.id }, esc(sec.title))));
    } else {
      const base = '#/a/' + a.id + '/s/';
      // 「关键模块」在页面里紧跟「关键流程」——目录顺序必须与之一致。
      // 两处（正文插入 / 目录插入）用同一个判据，改一处要同时改另一处。
      const secsAll = a.sections || [];
      const anchor = secsAll.find(x => x.id === 'flows') ||
                     secsAll.find(x => x.id === 'flow') ||
                     secsAll.find(x => x.id === 'design') ||
                     secsAll.find(x => x.svg) || secsAll[0];
      secsAll.forEach(sec => {
        nav.appendChild(el('a', { href: base + sec.id }, esc(sec.title)));
        if (anchor && sec.id === anchor.id && a.modules && a.modules.length) {
          nav.appendChild(el('a', { href: base + 'modules' }, '关键模块'));
        }
      });
    }
    side.appendChild(nav);

    if (a.modules && a.modules.length) {
      side.appendChild(el('b', { class: 'an-side-h an-side-h2' }, '关键模块'));
      const mn = el('nav', { class: 'an-side-nav an-side-mod' });
      // 顺序必须与正文一致——用同一份 groupModules，不要各自遍历 a.modules
      groupModules(a).forEach(({ group, mods }) => {
        if (group) mn.appendChild(el('b', { class: 'an-mod-grp' }, esc(group)));
        mods.forEach(m => {
          const on = mod && mod.id === m.id ? ' on' : '';
          mn.appendChild(el('a', {
            class: 'an-mod-link' + on, href: '#/a/' + a.id + '/' + m.id
          }, esc(m.title) + (m.draft ? ' <i>待补</i>' : '')));
        });
      });
      side.appendChild(mn);
    }
    wrap.appendChild(side);
    wrap.appendChild(main);

    wrapTables(main);
    view.replaceChildren(wrap);
    document.title = (mod ? mod.title + ' · ' + a.title : a.title) + ' · LLM Infra Wiki';
    // 小节锚点走路由（#/a/.../s/<sec>），否则裸 #anchor 会把 hash 路由顶掉
    if (scrollTo) {
      requestAnimationFrame(() => {
        const t = document.getElementById('a-' + scrollTo);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else {
      window.scrollTo({ top: 0 });
    }
  }

  /* ── 联动分析板块 ─────────────────────────────────────────
     内容来自仓库里的 `flows/`（含一级分组子目录），清单（flows/manifest.json）
     由 CI 扫目录重建。为什么走 fetch 而不是像其它页那样嵌进 data/*.js：
     这类内容是跨组件的联动分析，让写的人去改 7.7MB 的 analyses.js 门槛太高——
     加一个 md、提 PR 就行。 */
  let FLOWS = null;
  let svgSeq = 0;        // 内联 SVG 的 id 前缀，避免同页多张图撞 id

  function fetchFlowList() {
    if (FLOWS) return Promise.resolve(FLOWS);
    return fetch('flows/manifest.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(j => (FLOWS = (j && j.flows) || []))
      .catch(() => (FLOWS = []));
  }

  /* window.md() 不认识 front-matter——会渲染成 <hr> 加一串粘连的
     「title: X author: Y」，所以读进来先剥掉。
     正文开头那个 `# 标题` 也一并去掉：标题由 front-matter 渲染成 h1，
     留着就会出现两个一模一样的大标题。 */
  function stripFrontMatter(text) {
    let body = text;
    if (/^---\r?\n/.test(body)) {
      const end = body.indexOf('\n---', 3);
      if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1);
    }
    return body.replace(/^\s*\n/, '').replace(/^#\s+[^\n]*\n+/, '');
  }

  /* md 里的相对路径是相对那篇 md 所在目录的（可能在 `flows/<组>/` 下），
     但页面地址是 `#/f/<slug>`。渲染后统一按「清单里的 file」推出前缀补上。 */
  function fixFlowPaths(root, base) {
    root.querySelectorAll('img[src]').forEach(img => {
      const s = img.getAttribute('src');
      if (/^(https?:|data:|\/|#)/.test(s)) return;
      img.setAttribute('src', base + s.replace(/^\.\//, ''));
    });
    root.querySelectorAll('a[href]').forEach(a => {
      const h = a.getAttribute('href');
      if (/^(https?:|mailto:|#)/.test(h)) return;
      if (/\.md$/.test(h)) {                       // 指向另一个 md → 走站内路由
        a.setAttribute('href', '#/f/' + path.basename(h).replace(/\.md$/, ''));
        return;
      }
      a.setAttribute('href', base + h.replace(/^\.\//, ''));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    });
  }

  /* 站点的图都是「内联 SVG + 页面 CSS」画的：方框填 `var(--panel)`、文字靠
     `.diagram .t-mono` 这类规则取字号与颜色。这些在**外部 `<img>`** 里一概拿不到——
     自定义属性不解析（方框退成黑块），页面样式也不作用于图片文档。
     所以把 svg 取回来内联进 DOM，顺带把 `<script>` 与事件属性摘掉。 */
  function inlineFlowSvgs(root) {
    root.querySelectorAll('img[src$=".svg"], img[src*=".svg?"]').forEach(img => {
      const src = img.getAttribute('src');
      fetch(src)
        .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
        .then(txt => {
          const uid = 'nsvg' + (++svgSeq) + '-';
          // 同页可能有多张图，`marker` / `clipPath` 的 id 会互相抢；用 id="X" 与
          // url(#X) 一起改名。用 split/join 而不是正则，省得转义 id 里的特殊字符。
          const ids = [...txt.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
          let xml = txt;
          for (const id of ids) {
            xml = xml.split(`id="${id}"`).join(`id="${uid}${id}"`)
                     .split(`url(#${id})`).join(`url(#${uid}${id})`);
          }
          const box = document.createElement('div');
          box.className = 'flow-fig';
          box.innerHTML = xml;
          const svg = box.querySelector('svg');
          if (!svg) throw 0;
          box.querySelectorAll('script, foreignObject').forEach(n => n.remove());
          box.querySelectorAll('*').forEach(n => {
            [...n.attributes].forEach(a => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); });
          });
          // 两种图要分别对待：
          //   · 带固定 width/height 的（PlantUML 的输出、别处画好的 SVG）按**原尺寸
          //     居中**显示——和分析页一样（那边是 innerHTML 内联、不套 .diagram）。
          //     硬拉成容器宽会把 500px 的图放大一倍多，字比正文大一圈。
          //   · 只有 viewBox 的（本站手绘的那批）挂 .diagram 铺满容器。
          if (svg.getAttribute('width') && svg.getAttribute('height')) {
            svg.classList.add('fig-natural');
          } else if (!svg.classList.contains('diagram')) {
            svg.classList.add('diagram');
          }
          svg.setAttribute('role', 'img');
          const alt = img.getAttribute('alt');
          if (alt) svg.setAttribute('aria-label', alt);
          img.replaceWith(box);
          wrapTables(root);
        })
        .catch(() => { /* 取不到就留着 <img>，读者至少能看到 alt 文字 */ });
    });
  }

  /* 标签：子目录名（项目）在前，作者写的 tags 在后。 */
  function flowTags(f) {
    const tags = f.group ? [f.group].concat(f.tags || []) : (f.tags || []);
    return tags.map(t => `<span class="flow-tag">${esc(t)}</span>`).join('');
  }

  function renderFlowList() {
    const wrap = el('div', { class: 'wrap flows fade-in' });
    wrap.appendChild(el('header', { class: 'flows-head' }, `
      <p class="eyebrow">Flows · 联动分析</p>
      <h1>跨组件的联动分析</h1>
      <p class="lede">
        深度分析页跟着<b>一个仓库</b>走；这里跟着<b>一次操作</b>走——一次 KV 的存与取、
        一条 KV 回落通路、一个新模型带来的 KV 形态变化，横跨哪几个项目、各段怎么接上、
        在哪一层变形。体裁不限：全链路走读、方案对比、时延估算、PR 与社区梳理都收。
      </p>
      <p class="lede" style="margin-top:10px">
        正文是普通的 markdown，<b>不要求</b>深度分析页那套八节骨架。
        写进正文的 <code>路径:行号</code> 会被自动校验，所以标了行号就得真去那一行看过。
        想加一篇？在 <code>flows/</code> 下放一个 <code>.md</code>（照着
        <code>flows/_template.md</code> 写），提 PR 即可，清单由 CI 重建。
      </p>
    `));
    const box = el('div');
    wrap.appendChild(box);
    view.replaceChildren(wrap);
    document.title = '联动分析 · LLM Infra Wiki';
    window.scrollTo({ top: 0 });

    fetchFlowList().then(list => {
      if (!list.length) {
        box.appendChild(el('p', { class: 'flow-note' },
          '还没有内容。清单由 `node tools/build_flows.js` 生成，' +
          '如果 flows/ 下已经有 md 却看不到，说明清单没重建。'));
        return;
      }
      const grid = el('div', { class: 'flow-grid' });
      list.forEach(f => {
        const a = el('a', { class: 'flow-card', href: '#/f/' + f.slug });
        a.innerHTML = `
          <em>${esc(f.date)} · ${esc(f.author)}</em>
          <b>${esc(f.title)}</b>
          <div class="fc-parts">${flowTags(f)}</div>
          <p>${window.md(f.summary || '').html.replace(/^<p>|<\/p>$/g, '')}</p>`;
        grid.appendChild(a);
      });
      box.appendChild(grid);
    }).catch(err => {
      box.appendChild(el('p', { class: 'flow-note' },
        '清单读不出来，列表渲染失败。看一眼控制台。'));
      console.error('flows 列表渲染失败', err);
    });
  }

  function renderFlow(slug) {
    const wrap = el('div', { class: 'wrap about flow-page fade-in' });
    const crumb = el('span', null, esc(slug));
    const nav = el('nav', { class: 'crumbs' }, '<a href="#/flows">联动分析</a><span>/</span>');
    nav.appendChild(crumb);
    wrap.appendChild(nav);
    const body = el('div');
    wrap.appendChild(body);
    view.replaceChildren(wrap);
    window.scrollTo({ top: 0 });

    fetchFlowList().then(list => {
      const meta = list.find(x => x.slug === slug);
      document.title = (meta ? meta.title : slug) + ' · LLM Infra Wiki';
      if (meta) crumb.textContent = meta.title;

      // 正文相对路径要相对「这篇 md 所在的目录」解析，所以用清单里的 file
      const file = meta ? meta.file : slug + '.md';
      const base = 'flows/' + (file.includes('/') ? file.replace(/[^/]+$/, '') : '');
      fetch('flows/' + file, { cache: 'no-cache' })
        .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
        .then(text => {
          if (meta) {
            body.appendChild(el('header', null, `
              <h1>${esc(meta.title)}</h1>
              <p class="flow-sub">${esc(meta.date)} · ${esc(meta.author)}</p>
              <div class="fc-parts">${flowTags(meta)}</div>`));
          }
          const art = el('div', { class: 'flow-art' });
          art.innerHTML = window.md(stripFrontMatter(text)).html;
          fixFlowPaths(art, base);
          body.appendChild(art);
          wrapTables(wrap);
          inlineFlowSvgs(art);
        })
        .catch(() => {
          body.appendChild(el('h1', null, '没有这一篇'));
          body.appendChild(el('p', null,
            `flows/${esc(file)} 取不到。` +
            '<a href="#/flows">返回列表</a>'));
        });
    });
  }

  function renderAbout() {
    const src = `
# 关于这个知识库

## 它是什么

一个按**技术栈分层**组织的大模型推理基础设施知识库。目标不是罗列链接，而是把每个组件的
**整体架构**与**代码流程**讲清楚——读完一个组件的页面，你应该知道它的关键抽象在哪几个文件里，
以及请求在它内部是怎么流动的。

## 组织方式

四层结构 + 一条底座带，**每个组件只属于一层**：

| 层级 | 在本层回答的问题 | 代表组件 |
|---|---|---|
| **L1 集群调度** | 请求发给谁、什么时候扩容 | Dynamo / AIBrix / llm-d / PyMotor |
| **L2 推理引擎** | 单实例内怎么组批、怎么算、怎么放 KV | vLLM / SGLang / vLLM-Ascend / LMCache |
| **L3 KV 传输** | KV 怎么搬、搬哪些、怎么与计算重叠 | NIXL / HIXL / MemFabric |
| **L4 KV 存储** | KV 存在哪、怎么索引与淘汰 | Mooncake / MemCache / FlexKV / UCM |
| **L0 底座** | 算子、内存、通信原语由谁定义 | CANN |

### 为什么有 L0 底座

[CANN](#/c/cann) 不是 vLLM 或 Mooncake 的同级组件——它是**纵向穿透所有四层的地基**。把它塞进任何一层都会失真：
放进 L2 会让人以为它只是个推理引擎，放进 L3 又解释不了它同时提供算子与运行时。

所以底座单独建模，在全景图里画成一条带斜纹的地基带，视觉上也刻意与四个层级区分开。
它的存在回答了一类问题：**为什么昇腾栈看起来和 NVIDIA 栈结构不同**——因为地基的形状不同。

### 为什么不做「跨层组件」

早期版本允许一个组件同时挂在多层上，结果是 L3、L4 的每张卡都被列了两遍——因为
**传输与存储不是两个平行的产品品类，而是同一条垂直栈的两半**。Mooncake、MemCache、
DataSystem 这类产品内部本来就同时包含传输子系统与存储子系统。

所以本知识库改为**一个组件只归一层**，判据是**它的主要用途**：

- [Mooncake](#/c/mooncake) 是一个**分布式 KV 池**，自带的传输引擎只是它的实现手段——
  所以**整体归 L4**
- L3 只放**以搬字节本身为目的**的组件：[HIXL](#/c/hixl)、[NIXL](#/c/nixl)、
  [MemFabric](#/c/memfabric)——它们可以脱离任何存储系统单独使用，这才是传输层的判据
- **一个组件的内部子系统不单独成卡**。否则同一个仓库会在两层各出现一次，
  读者要在两处拼起来才看得全——Mooncake 曾经就是这样，现已合成一个
- 边界有争议时仍以判据决定。例如 [AscendStoreConnector](#/c/ascend-store-connector)：
  **它的仓库就是 vllm-ascend、实现的是引擎自己的 %%KVConnectorBase_V1%% 接口，所以归 L2**
  （「搬哪些」是引擎的决策，「字节怎么过去」才是传输层的事）

### 归类用两个正交维度，不合并

早期版本只有一个 %%eco%% 标签，把两件事混成了一件：

| 维度 | 含义 | 例子 |
|---|---|---|
| **org** | 谁做的 / 为谁做的（厂商血统） | Dynamo 出自 NVIDIA、MindIE 出自华为 |
| **runs** | 当前实际能跑在哪些硬件栈 | CANN 只能昇腾、vLLM 两栈都能跑 |

混起来的后果是会把 [Dynamo](#/c/dynamo) 误判成「像 CANN 一样锁死 NVIDIA」。实际上它只是
**引擎之上的编排层**，今天跑不了昇腾的原因是厂商 SDK 与发行物（NGC CUDA 容器、NIXL、
官方支持矩阵只列 Ampere→Blackwell），**不是架构上不可能**。昇腾侧的对应物是
[MindIE PyMotor](#/c/pymotor)。

所以现在每个组件标三个字段：

| 字段 | 取值 |
|---|---|
| %%runs%% | 可运行的硬件栈数组，如 %%['nvidia','ascend']%% |
| %%port%% | %%bound%% 硬件绑定 / %%sdk%% 厂商 SDK 绑定 / %%neutral%% 硬件中立 |
| %%portNote%% | 有歧义时的一句话依据，显示在组件页顶部 |

**%%bound%% 与 %%sdk%% 的区别很重要**：

- %%bound%%（CANN、CUDA、TensorRT-LLM、HIXL…）——本身就是硬件抽象层，或直接编译到特定硬件，**换栈要重写**
- %%sdk%%（Dynamo、NIXL、FlexKV…）——架构中立，但当前实现与发行物绑在某一栈上，**换栈要适配**

另有两个容易按厂商血统误判的例子：

- [UCM](#/c/ucm) 出自华为 ModelEngine，但构建配置的 runtime 覆盖 **simu / ascend / ascend-a3 / musa / cuda**，
  Ascend 优化还是默认关闭的编译选项——按功能归 L4，不是昇腾专属
- [openYuanrong DataSystem](#/c/yuanrong-ds) 的构建同时支持 Ascend 与 CUDA 后端

区分「国产开源生态」与「昇腾专属」是两回事，本知识库按 %%runs%% 划线。

### 层与层之间：一条请求与它的 KV

首页最上方是**全链路**——跟着一次请求走一遍：

~~~
L1 请求到达 → 路由决策
        ↓ 已编排的请求
L2 前缀查询 → 分配槽位 → 执行计算 → 采样输出      ← KV 在这里被消费，也被生产
        ↓ 新算出的 KV
L3 注册与握手 → 提交搬运 → 与计算重叠
        ↓ KV 已到位
L2 继续解码
        ↓ 本轮算完的 KV
L4 构造键 → 写入落存 → 登记索引
        ↻ 回到 L1：L4 的索引成为下次请求路由的依据
~~~

关键在于**它是一个环，不是一条线**：KV 落存的位置信息回流到 L1，直接改变下一次路由打分的输入。
这也是为什么四层必须放在一起看——任何一层的状态变化，都会改变其它层的最优解。

各层的详情区只列出**自己承担的那几步**（引用全链路的统一编号），点编号可以跳回链路。

### 三个容易搞混的边界

#### 一、H2D / D2H 不属于 KV 传输层，属于推理引擎

一条判据可以省掉很多争论：

> **L2 搬「KV 块」（懂布局），L3 搬「字节」（只认地址）。**

- L3 传输引擎（Mooncake TE / NIXL / HIXL）的接口里只有「注册内存段 + 偏移 + 长度」，
  **没有「层」「块」「slot」这些概念**——它不知道什么是 attention，也不知道 MLA 与 GQA 的
  KV 形状完全不同。%%registerLocalMemory(ptr, size)%% + %%submitTransfer(...)%% 就是全部
- 而 D2H / H2D 要按 %%slot_mapping%% 把连续的一段 KV **散进分页显存的正确位置**，还要处理 MLA 布局
- **这需要引擎的内部知识，所以由引擎侧的 GPU / NPU Connector 完成**（LMCache 的 %%gpu_connector%%、
  vLLM 的 %%v1/kv_offload/cpu%%）

所以本知识库把 L3 的定位写成「在注册过的内存段之间搬字节」，而不是「搬 KV 块」——
**后者是个错误的说法，它把需要布局知识的那一跳也算了进来。**

#### 二、KV 传输与 KV 存储是同件事的两个面

传输是动词、存储是名词。之所以能分成两层，是因为**产品形态上确实存在纯传输引擎**
（NIXL、HIXL 可以脱离任何存储系统单独使用）与**纯存储系统**（MemCache 不做传输）。

**垂直整合的产品不按内部子系统拆卡**：[Mooncake](#/c/mooncake) 自带一个传输引擎，
但它解决的问题域是「分布式 KV 池」，所以**整体归 L4**——
判据是**它主要用来解决什么**，而不是它内部有哪些子系统。

但边界不是绝对的：GDS（显存 ↔ SSD 直传）既像传输又像存储，本知识库按「**它被谁装配**」归入 L4。

#### 三、推理引擎与 KV 存储是「生产者/消费者 ↔ 托管方」

| | 推理引擎（L2） | KV 存储（L4） |
|---|---|---|
| 产生 KV | ✅ 计算产生 | ❌ 不产生 |
| 消费 KV | ✅ attention 读取 | ❌ 不知道 attention 是什么 |
| 定义 key 与块大小 | ✅ 前缀哈希 + 固定块大小由引擎定 | ❌ 只接受这个 key |
| 决定换入换出时机 | ✅ 调度器与前缀查询 | ❌ 只按容量与淘汰策略响应 |
| 持有 KV | 显存里持有（分页池） | 介质上持有（DRAM / SSD / 远端） |

两条推论：

1. **存储系统不知道哪些 KV 会被读到**——它只认 key。这正是 UCM 那类稀疏检索**必须侵入引擎**的原因：
   要决定「读哪些」，就必须懂 attention
2. **但存储后端的能力会反向约束引擎**：layerwise（逐层传输与计算重叠）要求后端支持分层、
   异步、部分完成的读写——所以目前只有 MemCache 支持，**这直接限制了 vLLM-Ascend 能不能做逐层流水**

## 内容分级

- **完整走读**：特点速览 + 整体介绍 + 每个子模块的文件、调用链、关键设计点
- **骨架**：已有定位与模块骨架，正在补完（页面顶部有标记）

## 特点速览

每个组件页顶部有一块**「特点速览」**——把该组件最容易踩坑、最能体现设计取舍的点提炼成若干条。
它来自对组件的源码走读与横向对比，而不是仓库 README 的复述。例如：

- vLLM：*v1 引擎没有 prefill / decode 阶段之分*
- LMCache-Ascend：*用 PAC 编解码替代 CUDA CacheGen*
- AscendStoreConnector：*layerwise 只有 memcache 后端支持*
- HIXL：*HCCS 119 GB/s vs RDMA 22 GB/s，这个差距决定了 PD 分离的拓扑设计*

它的作用是**让读者在三十秒内判断这个组件值不值得往下读**。

## 内容来源

基于上游公开仓库的源码与文档整理。每个组件页都标注了对应的**上游仓库地址**，
正文中的文件路径均为仓库内的相对路径，可直接对照上游代码核对。

## 技术实现

纯静态站点，无构建步骤、无外部运行时依赖（字体除外）。数据与视图分离：
%%data/catalog.js%% 描述层级与组件编目，%%data/details.js%%、%%data/details-ascend.js%% 与
%%data/details-outline.js%% 存放正文内容，全部是纯数据。新增一个组件只需在编目里加一条、
在详情里加一段。

## 部署

任意静态托管都可以：GitHub Pages、Vercel、Netlify、对象存储 + CDN，
或者直接用 %%python3 -m http.server%% 在本机跑起来。
`;
    const d = el('div', { class: 'wrap about prose fade-in' });
    d.innerHTML = window.md(src).html;
    view.replaceChildren(d);
    document.title = '关于 · LLM Infra Wiki';
  }

  /* ============================================================
     搜索
     ============================================================ */
  const INDEX = (() => {
    const idx = [];
    COMPS.forEach(c => {
      idx.push({
        id: c.id, name: c.name, sub: c.role, color: layerInfoOf(c).color,
        hay: [c.name, c.org, c.role, c.lang, layerInfoOf(c).name, layerInfoOf(c).en, runsOf(c).join(' ')].join(' ').toLowerCase()
      });
      const d = detailOf(c.id);
      (d && d.modules ? d.modules : []).forEach(m => {
        idx.push({
          id: c.id, name: m.name, sub: c.name + ' · ' + (m.summary || ''), color: layerInfoOf(c).color,
          hay: [m.name, m.summary, (m.files || []).join(' '), (m.points || []).join(' ')].join(' ').toLowerCase()
        });
      });
    });
    return idx;
  })();

  function doSearch(q) {
    const box = $('#search-results');
    q = q.trim().toLowerCase();
    if (q.length < 1) { box.hidden = true; box.innerHTML = ''; return; }
    const terms = q.split(/\s+/);
    const hits = INDEX
      .map(it => {
        let s = 0;
        terms.forEach(t => {
          if (it.name.toLowerCase().includes(t)) s += 10;
          if (it.hay.includes(t)) s += 3;
        });
        return { it, s };
      })
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12);

    if (!hits.length) {
      box.innerHTML = '<div class="sr-empty">没有匹配项</div>';
      box.hidden = false; return;
    }
    box.innerHTML = hits.map(({ it }) => `
      <a class="sr-item" href="#/c/${it.id}" style="--c:${it.color}">
        <span class="sr-dot"></span>
        <span class="sr-name">${esc(it.name)}</span>
        <span class="sr-sub">${esc(it.sub)}</span>
      </a>`).join('');
    box.hidden = false;
  }

  /* ============================================================
     路由
     ============================================================ */
  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);

    document.querySelectorAll('.topnav a').forEach(a => a.classList.remove('on'));
    const closeSearch = () => { const b = $('#search-results'); b.hidden = true; };

    const on = k => { const a = $('.topnav a[data-nav="' + k + '"]'); if (a) a.classList.add('on'); };

    if (parts[0] === 'c' && parts[1]) { renderComponent(parts[1]); on('home'); }
    else if (parts[0] === 'a' && parts[1]) {
      // 形如 #/a/<id>[/<module>][/s/<section>]
      let modId = null, sec = null;
      if (parts[2] === 's') sec = parts[3];
      else if (parts[2]) { modId = parts[2]; if (parts[3] === 's') sec = parts[4]; }
      renderAnalysis(parts[1], modId, sec);
      on('home');
    }
    else if (parts[0] === 'f' && parts[1]) { renderFlow(parts[1]); on('flows'); }
    else if (parts[0] === 'flows') { renderFlowList(); on('flows'); }
    else if (parts[0] === 'about') { renderAbout(); on('about'); }
    else if (parts[0] === 'l' && parts[1]) {
      renderHome();
      on('home');
      requestAnimationFrame(() => {
        const t = document.getElementById('layer-' + parts[1]);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    else { renderHome(); on('home'); }

    closeSearch();
    setupSpy();
  }

  /* 滚动高亮：TOC + 侧栏 */
  let spyObserver = null;
  function setupSpy() {
    if (spyObserver) spyObserver.disconnect();
    const links = document.querySelectorAll('.doc-toc a[data-anchor]');
    if (!links.length) return;
    const map = {};
    links.forEach(a => { map[a.dataset.anchor] = a; });

    spyObserver = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        links.forEach(a => a.classList.remove('on'));
        const a = map[e.target.id];
        if (a) a.classList.add('on');
      });
    }, { rootMargin: '-90px 0px -70% 0px', threshold: 0 });

    Object.keys(map).forEach(id => {
      const t = document.getElementById(id);
      if (t) spyObserver.observe(t);
    });
  }

  /* ============================================================
     启动
     ============================================================ */
  window.addEventListener('hashchange', route);

  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#search-input')) {
      e.preventDefault(); $('#search-input').focus(); $('#search-input').select();
    }
    if (e.key === 'Escape') {
      const inp = $('#search-input');
      inp.value = ''; doSearch(''); inp.blur();
    }
    if (e.key === 'Enter' && document.activeElement === $('#search-input')) {
      const first = $('#search-results .sr-item');
      if (first) { location.hash = first.getAttribute('href'); }
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search')) {
      const b = $('#search-results'); if (b) b.hidden = true;
    }
  });

  const si = $('#search-input');
  si.addEventListener('input', () => doSearch(si.value));
  si.addEventListener('focus', () => { if (si.value) doSearch(si.value); });

  /* hero 里的「怎么用」快捷入口 */
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.hasAttribute('data-focus-search')) {
      e.preventDefault();
      const inp = $('#search-input');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      inp.focus();
    } else if (a.hasAttribute('data-switch-stack')) {
      e.preventDefault();
      setStack(otherStack());
    }
  });

  /* 栈视角切换 */
  const sw = $('#stackswitch');
  if (sw) {
    sw.addEventListener('click', e => {
      const b = e.target.closest('button[data-stack]');
      if (b && b.dataset.stack !== STACK) setStack(b.dataset.stack);
    });
  }
  syncStackButtons();

  si.addEventListener('keydown', e => {
    const items = [...document.querySelectorAll('#search-results .sr-item')];
    if (!items.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const cur = items.findIndex(i => i.classList.contains('active'));
    let next = e.key === 'ArrowDown' ? cur + 1 : cur - 1;
    next = Math.max(0, Math.min(items.length - 1, next));
    items.forEach(i => i.classList.remove('active'));
    items[next].classList.add('active');
    items[next].scrollIntoView({ block: 'nearest' });
  });

  /* ============================================================
     图的放大浮层
     ------------------------------------------------------------
     实测：1200 作者宽度的图在 390px 手机上缩放系数只有 0.26，
     10.5px 的标注渲染出来是 3px —— 完全读不了。
     CSS 让窄屏保留 min-width 并允许横滑（能读了，但要滑），
     这里再给一个「点开看大图」的浮层：可缩放、可拖动、Esc 关闭。
     ============================================================ */
  function installZoom() {
    const BASE = 1200;                     // 图的作者坐标系宽度
    let layer = null, stage = null, svg = null, pct = null, z = 1;

    function apply(keepCenter) {
      if (!svg) return;
      const pw = stage.scrollWidth || 1, ph = stage.scrollHeight || 1;
      const cx = (stage.scrollLeft + stage.clientWidth / 2) / pw;
      const cy = (stage.scrollTop + stage.clientHeight / 2) / ph;
      svg.style.width = Math.round(BASE * z) + 'px';
      if (pct) pct.textContent = Math.round(z * 100) + '%';
      if (keepCenter) {
        stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
        stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
      }
    }
    // 适应宽度（可能小于 100%，用来「看全整张图」）
    function fitWidth() { return Math.max(0.15, (stage.clientWidth - 32) / BASE); }
    // 打开时不低于 100%：缩到 30% 就等于又把字压回 3px，浮层就白做了
    function fit() { if (!stage) return; z = Math.max(1, fitWidth()); apply(false); }
    function whole() { if (!stage) return; z = fitWidth(); apply(false); }
    function zoomBy(f) { z = Math.min(6, Math.max(0.25, z * f)); apply(true); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    function close() {
      if (!layer) return;
      layer.remove();
      layer = stage = svg = pct = null;
      document.body.classList.remove('zoom-open');
      document.removeEventListener('keydown', onKey);
    }

    function open(src) {
      layer = el('div', {
        class: 'zoom-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '放大看图'
      });
      const bar = el('div', { class: 'zoom-bar' });
      bar.innerHTML =
        '<span class="zoom-hint">拖动查看 · 双击放大一倍 · Esc 关闭</span>' +
        '<button type="button" data-zoom="out" aria-label="缩小">−</button>' +
        '<span class="zoom-pct">100%</span>' +
        '<button type="button" data-zoom="in" aria-label="放大">+</button>' +
        '<button type="button" data-zoom="whole">整图</button>' +
        '<button type="button" data-zoom="close" aria-label="关闭">✕</button>';
      stage = el('div', { class: 'zoom-stage' });
      svg = src.cloneNode(true);
      stage.appendChild(svg);
      layer.appendChild(bar);
      layer.appendChild(stage);
      document.body.appendChild(layer);
      document.body.classList.add('zoom-open');
      pct = bar.querySelector('.zoom-pct');
      fit();
      document.addEventListener('keydown', onKey);

      bar.addEventListener('click', e => {
        const b = e.target.closest('button[data-zoom]');
        if (!b) return;
        const a = b.dataset.zoom;
        if (a === 'close') close();
        else if (a === 'in') zoomBy(1.25);
        else if (a === 'out') zoomBy(0.8);
        else whole();
      });
      // 双击在 100% 与 200% 之间切换
      stage.addEventListener('dblclick', () => { z = (z > 1.2) ? 1 : 2; apply(true); });
      stage.addEventListener('wheel', e => {          // Ctrl / ⌘ + 滚轮缩放
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
      }, { passive: false });
      layer.addEventListener('click', e => { if (e.target === layer) close(); });
    }

    // 事件委托：路由切换会重建 DOM，监听挂一次就够
    document.addEventListener('click', e => {
      if (layer) return;
      const canvas = e.target.closest('.flow-canvas');
      if (!canvas) return;
      const s = canvas.querySelector('svg');
      if (!s) return;
      // 正在选字就别弹浮层
      if (window.getSelection && String(window.getSelection()).length) return;
      open(s);
    });
  }

  installZoom();
  route();
})();
