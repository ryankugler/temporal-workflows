/* Lending Ops console. Plain JS, no build step. Data from /api (see src/ui/server.ts). */
(() => {
  'use strict';

  const STATUSES = ['RECEIVED', 'VALIDATING', 'AWAITING_DOCS', 'ENRICHING', 'AWAITING_PROVIDER', 'UNDERWRITING', 'HUMAN_REVIEW', 'AWAITING_SIGNATURE', 'DISBURSING', 'FUNDED', 'DECLINED', 'ESCALATED'];
  const TERMINAL = ['FUNDED', 'DECLINED', 'ESCALATED'];
  const PRODUCTS = ['PERSONAL', 'AUTO', 'DEBT_CONSOLIDATION'];
  const CHANNELS = ['PORTAL', 'BROKER_EMAIL', 'AGGREGATOR'];
  const DOCS = ['GOV_ID', 'PAYSTUB', 'BANK_STATEMENT', 'VEHICLE_PURCHASE_AGREEMENT', 'DEBT_STATEMENTS'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  let config = null;
  let refreshTimer = null;
  let drawerTimer = null;
  let openCaseId = null;

  // ---- utilities ----------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nice = (s) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  const money = (n) => (n == null ? '–' : '$' + Math.round(n).toLocaleString('en-US'));
  const cssVar = (s) => `var(--st-${s.toLowerCase().replace(/_/g, '-')})`;
  const color = (s) => getComputedStyle(document.documentElement).getPropertyValue(`--st-${s.toLowerCase().replace(/_/g, '-')}`).trim() || '#94A3B8';
  const chip = (s) => `<span class="chip" style="--c:${cssVar(s)}">${esc(nice(s))}</span>`;
  const ago = (iso) => {
    if (!iso) return '–';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
  };
  const dur = (sec) => (sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`);
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–');
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // Reads retry with backoff when the console API or Temporal is briefly unreachable; writes don't
  // auto-retry (the user decides), except that the API itself is idempotent where it matters.
  let apiDown = false;
  async function api(path, opts = {}) {
    const method = opts.method ?? 'GET';
    // Reads always retry. A write retries only when it carries a request ID, because then the server
    // maps a repeat to the same effect (update ID, workflow ID or external reference). See README.
    const attempts = method === 'GET' || opts.body?.requestId ? 3 : 1;
    let delay = 400;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(path, {
          method,
          headers: opts.body ? { 'content-type': 'application/json' } : undefined,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        if (attempt < attempts) { await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue; }
        setApiDown(true);
        throw new Error('The console API is unreachable');
      }
      setApiDown(false);
      const data = await res.json().catch(() => ({}));
      if (res.status === 503 && attempt < attempts) {
        const wait = Number(res.headers.get('retry-after') ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, Math.min(wait, delay * 2)));
        delay *= 2;
        continue;
      }
      if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
      return data;
    }
  }
  // One request ID per intended action, kept until that action gets an answer, so a retry (automatic, or
  // the user clicking again after a timeout) repeats the same request instead of making a new one.
  const pendingIds = new Map();
  const reqId = (key) => {
    if (!pendingIds.has(key)) pendingIds.set(key, (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 24));
    return pendingIds.get(key);
  };
  const settle = (key) => pendingIds.delete(key);

  function setApiDown(down) {
    if (down === apiDown) return;
    apiDown = down;
    renderBanner();
  }
  let lastHealth = null;
  function renderBanner() {
    const b = $('#conn-banner');
    if (apiDown) { b.hidden = false; b.className = 'conn-banner down'; b.textContent = 'Lost connection to the console API. Retrying automatically…'; return; }
    const h = lastHealth;
    if (h && !h.temporal.ok) {
      b.hidden = false; b.className = 'conn-banner down';
      b.textContent = `Temporal is unreachable (${h.temporal.error}). New applications are kept in the ingest outbox (${h.outbox.depth} queued) and submitted when it's back. Running workflows resume on their own.`;
      return;
    }
    const down = h?.providers.filter((p) => p.down || p.circuit.state !== 'CLOSED') ?? [];
    if (down.length || h?.outbox.depth) {
      b.hidden = false; b.className = 'conn-banner';
      b.innerHTML = [
        down.length ? `Provider trouble: ${down.map((p) => `<b>${esc(p.name)}</b> ${p.down ? 'down' : ''}${p.circuit.state !== 'CLOSED' ? ` (circuit ${p.circuit.state.toLowerCase().replace('_', '-')})` : ''}`).join(', ')}. ${h.parked ?? 0} application(s) parked, retrying on a schedule. <a href="#/health">Health</a>` : '',
        h?.outbox.depth ? `${h.outbox.depth} application(s) waiting in the ingest outbox.` : '',
      ].filter(Boolean).join(' ');
      return;
    }
    b.hidden = true;
  }
  async function pollHealth() {
    try {
      lastHealth = await api('/api/health');
      const issues = lastHealth.providers.filter((p) => p.down || p.circuit.state !== 'CLOSED').length + (lastHealth.temporal.ok ? 0 : 1);
      $('#health-badge').hidden = !issues;
      $('#health-badge').textContent = issues;
    } catch { /* banner already shows the API is down */ }
    renderBanner();
  }

  function toast(html, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4500);
    return el;
  }

  // Route state lives in the hash: #/page?key=value, so filtered views can be bookmarked and shared.
  function route() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    return { page: path || 'flow', params: new URLSearchParams(qs ?? '') };
  }
  function setParams(params) {
    const { page } = route();
    const clean = new URLSearchParams([...params.entries()].filter(([, v]) => v));
    const qs = clean.toString();
    history.replaceState(null, '', `#/${page}${qs ? `?${qs}` : ''}`);
  }
  const opts = (values, selected, all = 'All') =>
    `<option value="">${all}</option>` + values.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${nice(v)}</option>`).join('');

  function schedule(fn, ms) {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
  }

  // ---- shell ------------------------------------------------------------------
  async function loadLogo() {
    try {
      const svg = await (await fetch('brand/pockethealth-logo.svg')).text();
      // Ink-coloured paths follow the theme so the wordmark stays legible in dark mode.
      $('#logo').innerHTML = svg.replace(/fill="#0F172A"/g, 'class="ink"').replace('<svg ', '<svg role="img" aria-label="PocketHealth" ');
    } catch {
      $('#logo').textContent = 'PocketHealth';
    }
  }

  async function init() {
    await loadLogo();
    config = await api('/api/config');
    $('#temporal-link').href = `${config.temporalUiUrl}/namespaces/${config.namespace}/workflows`;
    $('#scenario-select').innerHTML = '<option value="">Choose a scenario…</option>' +
      '<optgroup label="Scenarios">' + config.scenarios.map((s) => `<option value="${s.name}" title="${esc(s.expected)}">${esc(s.title)}</option>`).join('') + '</optgroup>' +
      '<optgroup label="Channel adapters"><option value="portal">Portal submission</option><option value="email">Broker email (missing paystub)</option></optgroup>';
    $('#synth-mix').innerHTML = config.mixes.map((m) => `<option value="${m}">${nice(m)}</option>`).join('');
    $('#synth-pack').innerHTML = config.packs.map((p) => `<option value="${p.name}">${esc(p.title)}</option>`).join('');
    $('#synth-pack-desc').textContent = config.packs[0]?.description ?? '';
    setInterval(tickCountdowns, 1000);
    mermaid.initialize({ startOnLoad: false, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'neutral', fontFamily: 'Inter, Arial, sans-serif', securityLevel: 'strict' });
    bindShell();
    window.addEventListener('hashchange', render);
    render();
    pollReviewBadge();
    setInterval(pollReviewBadge, 5000);
    pollHealth();
    setInterval(pollHealth, 3000);
    pollSlaBadge();
    setInterval(pollSlaBadge, 5000);
  }

  function bindShell() {
    // Choose, then click: picking a scenario only arms the Synthesize button.
    $('#scenario-select').addEventListener('change', (e) => { $('#scenario-go').disabled = !e.target.value; });
    $('#scenario-go').addEventListener('click', async () => {
      const name = $('#scenario-select').value;
      if (!name) return;
      const key = `scenario:${name}:${Math.floor(Date.now() / 5000)}`; // one ID per click window; retries within it reuse it
      $('#scenario-go').disabled = true;
      try {
        const r = await api(`/api/scenarios/${name}`, { method: 'POST', body: { requestId: reqId(key) } });
        settle(key);
        if (r.queued) { toast(`Temporal is unreachable: <b>${esc(r.workflowId)}</b> is queued in the ingest outbox and will start when it's back.`); return; }
        const s = config.scenarios.find((x) => x.name === name);
        toast(`${r.duplicate ? 'Duplicate of' : 'Started'} <a href="#" data-open="${esc(r.workflowId)}">${esc(r.workflowId)}</a>${s ? `<br>${esc(s.expected)}` : ''}`);
        render();
      } catch (err) { toast(esc(err.message), 'error'); }
      finally { $('#scenario-go').disabled = !$('#scenario-select').value; }
    });

    // Synthesize many: a random mix or a scenario pack.
    $('#synth-open').addEventListener('click', () => $('#synth-dialog').showModal());
    const syncMode = () => {
      const pack = $('#synth-form').elements.mode.value === 'pack';
      $('#synth-mix-fields').hidden = pack;
      $('#synth-pack-fields').hidden = !pack;
    };
    $('#synth-form').querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));
    $('#synth-pack').addEventListener('change', (e) => { $('#synth-pack-desc').textContent = config.packs.find((p) => p.name === e.target.value)?.description ?? ''; });
    $('#synth-form').addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'go') return;
      const f = new FormData(e.target);
      const pack = f.get('mode') === 'pack' ? f.get('pack') : undefined;
      const key = `synth:${Math.floor(Date.now() / 5000)}`;
      try {
        const body = pack
          ? { pack, autoResolve: f.get('autoResolve') === 'on', requestId: reqId(key) }
          : { count: Number(f.get('count')), mix: f.get('mix'), rate: Number(f.get('rate')), autoResolve: f.get('autoResolve') === 'on', requestId: reqId(key) };
        const r = await api('/api/synthesize', { method: 'POST', body });
        settle(key);
        const t = toast(`Started: ${esc(r.title)}. <a href="${esc(r.temporalUrl)}" target="_blank" rel="noopener">View in Temporal</a>`);
        trackSynth(r.workflowId, r.count, t);
        if (route().page !== 'flow') location.hash = '#/flow';
      } catch (err) { toast(esc(err.message), 'error'); }
    });

    // Clear synthesized data, behind a confirmation that says exactly what will go.
    $('#clear-open').addEventListener('click', async () => {
      $('#clear-summary').textContent = 'Counting…';
      $('#clear-go').disabled = true;
      $('#clear-dialog').showModal();
      try {
        const sm = await api('/api/demo/summary');
        $('#clear-summary').innerHTML = sm.applications
          ? `<b>${sm.applications}</b> synthesized application${sm.applications === 1 ? '' : 's'} (${sm.running} still running) and ${sm.drivers} synthesizer run${sm.drivers === 1 ? '' : 's'}.`
          : 'There is no synthesized data to clear.';
        $('#clear-go').disabled = !sm.applications && !sm.drivers;
      } catch (err) { $('#clear-summary').textContent = err.message; }
    });
    $('#clear-form').addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'clear') return;
      try {
        const r = await api('/api/demo/clear', { method: 'POST', body: { requestId: reqId('clear') } });
        settle('clear');
        toast(`Cleared ${r.deletedApplications} applications and ${r.deletedChildWorkflows} child workflows. Audit log archived${r.archivedTo ? ` to ${esc(r.archivedTo.split('/').slice(-2).join('/'))}` : ''}.`);
        lastMermaid = '';
        setTimeout(render, 800); // Visibility catches up within a second
      } catch (err) { toast(esc(err.message), 'error'); }
    });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-open]');
      if (a) { e.preventDefault(); openCase(a.dataset.open); }
    });
    $('#drawer-close').addEventListener('click', closeCase);
    $('#scrim').addEventListener('click', closeCase);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openCaseId) closeCase(); });
  }

  async function trackSynth(id, total, toastEl) {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const p = await api(`/api/synthesize/${encodeURIComponent(id)}`);
        if (p.startedSoFar >= total) {
          toast(`All ${total} applications started${p.duplicatesAbsorbed ? ` (${p.duplicatesAbsorbed} duplicate delivery absorbed)` : ''}. Watch them drain to terminal states.`);
          return;
        }
      } catch { return; }
    }
    toastEl?.remove();
  }

  async function pollSlaBadge() {
    try {
      const b = await api('/api/sla-board');
      const n = b.counts.breached + b.counts.atRisk;
      $('#sla-badge').hidden = !n;
      $('#sla-badge').textContent = n;
    } catch { /* banner covers outages */ }
  }

  async function pollReviewBadge() {
    try {
      const q = await api('/api/review-queue');
      const b = $('#review-badge');
      b.hidden = !q.length;
      b.textContent = q.length;
    } catch { /* server restarting */ }
  }

  let lastPage = null;
  function render() {
    const { page } = route();
    if (lastPage && lastPage !== page && openCaseId) closeCase();
    lastPage = page;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === page));
    clearInterval(refreshTimer);
    ({ flow: renderFlow, cases: renderCases, review: renderReview, sla: renderSla, audit: renderAudit, billing: renderBilling, health: renderHealth }[page] ?? renderFlow)();
  }

  // ---- Flow -------------------------------------------------------------------
  let lastMermaid = '';

  function renderFlow() {
    const p = route().params;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Application flow</h1><p class="muted">How every application moved through the lifecycle, and where each one ended. Built from the audit log; refreshes every 3 seconds.</p></div>
        <div class="filters">
          <select id="f-product" aria-label="Product">${opts(PRODUCTS, p.get('product'), 'All products')}</select>
          <select id="f-channel" aria-label="Channel">${opts(CHANNELS, p.get('channel'), 'All channels')}</select>
          <select id="f-range" aria-label="Received within">
            ${[['all', 'All time'], ['15', 'Last 15 min'], ['60', 'Last hour'], ['1440', 'Last 24 hours']].map(([v, l]) => `<option value="${v}" ${v === (p.get('range') ?? 'all') ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="kpis" id="kpis"></div>
      <div class="card">
        <div class="card-head"><h2>Lifecycle Sankey</h2><div class="legend" id="legend"></div></div>
        <div id="sankey"></div>
      </div>
      <div class="card"><div class="card-head"><h2>State machine</h2><span class="muted">the workflow's lifecycle, with applications in each state now</span></div><div class="mermaid-wrap" id="mermaid"></div></div>
      <div class="card"><div class="card-head"><h2>Why applications ended</h2><span class="muted">terminal reason codes</span></div><div id="outcomes"></div></div>`;
    lastMermaid = '';
    $('#legend').innerHTML = STATUSES.map((s) => `<span><i style="background:${cssVar(s)}"></i>${nice(s)}</span>`).join('');
    for (const id of ['f-product', 'f-channel', 'f-range']) {
      $(`#${id}`).addEventListener('change', () => {
        setParams(new URLSearchParams({ product: $('#f-product').value, channel: $('#f-channel').value, range: $('#f-range').value === 'all' ? '' : $('#f-range').value }));
        loadFlow();
      });
    }
    loadFlow();
    schedule(loadFlow, 3000);
  }

  async function loadFlow() {
    const flow = await api(`/api/flow?${route().params}`);
    if (!$('#kpis')) return;
    const t = flow.terminal;
    $('#kpis').innerHTML = [
      ['Applications', flow.total, `${flow.inFlight} in flight`, 'var(--ph-blue)'],
      ['Funded', t.FUNDED, money(flow.fundedVolume) + ' disbursed', cssVar('FUNDED')],
      ['Declined', t.DECLINED, '', cssVar('DECLINED')],
      ['Escalated', t.ESCALATED, 'handed to ops', cssVar('ESCALATED')],
      ['Funding rate', pct(flow.fundingRate), 'of closed applications', 'var(--ph-blue)'],
      ['Needs review', flow.needsReview, 'waiting on a reviewer', cssVar('HUMAN_REVIEW')],
      ['SLA breaches', flow.slaBreached, flow.medianSecondsToClose == null ? '' : `median time to close ${dur(flow.medianSecondsToClose)}`, cssVar('ESCALATED')],
    ].map(([label, value, sub, accent]) => `<div class="kpi" style="--accent:${accent}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    drawSankey($('#sankey'), flow);
    const max = Math.max(1, ...flow.outcomes.map((o) => o.count));
    $('#outcomes').innerHTML = flow.outcomes.length
      ? `<table class="outcomes">${flow.outcomes.slice(0, 10).map((o) => `
          <tr><td>${chip(o.status)}</td><td class="mono">${esc(o.reason)}</td>
          <td style="width:30%"><div class="bar"><i style="width:${(o.count / max) * 100}%;background:${cssVar(o.status)}"></i></div></td>
          <td class="num"><a href="#/audit?view=events&q=${encodeURIComponent(o.reason)}">${o.count}</a></td></tr>`).join('')}</table>`
      : '<div class="empty">No application has reached a terminal state yet.</div>';
    drawMermaid(flow);
  }

  function drawSankey(el, flow) {
    if (!flow.links.length) {
      el.innerHTML = `<div class="empty"><strong>No applications yet</strong>Start a scenario or click <b>Synthesize</b> to generate a few hundred and watch them flow.</div>`;
      return;
    }
    const width = Math.max(640, el.clientWidth);
    const depth = Math.max(...flow.nodes.map((n) => n.visit)) > 1 ? 1 : 0;
    const height = Math.max(440, Math.min(720, flow.nodes.length * 34 + depth * 40));
    const nodes = flow.nodes.map((n) => ({ ...n }));
    const links = flow.links.map((l) => ({ ...l }));
    const sankey = d3.sankey()
      .nodeId((d) => d.id)
      .nodeWidth(14)
      .nodePadding(16)
      // Terminal states line up on the right; in-flight states stay where they are in the lifecycle.
      .nodeAlign((node, n) => (node.terminal ? n - 1 : node.depth))
      .nodeSort((a, b) => a.visit - b.visit || STATUSES.indexOf(a.state) - STATUSES.indexOf(b.state))
      .extent([[1, 8], [width - 150, height - 8]]);
    let graph;
    try { graph = sankey({ nodes, links }); } catch (err) { el.innerHTML = `<div class="empty">Could not lay out the flow: ${esc(err.message)}</div>`; return; }

    const svg = d3.create('svg').attr('viewBox', [0, 0, width, height]).attr('width', '100%').attr('height', height).attr('role', 'img')
      .attr('aria-label', `Sankey of ${flow.total} applications across lifecycle states`);
    svg.append('g').selectAll('path').data(graph.links).join('path')
      .attr('class', 'link').attr('d', d3.sankeyLinkHorizontal())
      .attr('stroke', (d) => color(d.target.state)).attr('stroke-width', (d) => Math.max(1, d.width))
      .append('title').text((d) => `${label(d.source)} → ${label(d.target)}: ${d.value}`);
    const node = svg.append('g').selectAll('g').data(graph.nodes).join('g').attr('class', 'node');
    node.append('rect').attr('x', (d) => d.x0).attr('y', (d) => d.y0).attr('height', (d) => Math.max(2, d.y1 - d.y0)).attr('width', (d) => d.x1 - d.x0)
      .attr('fill', (d) => color(d.state))
      .append('title').text((d) => {
        const now = d.visit === 1 && !d.terminal ? flow.byStatus[d.state] ?? 0 : null;
        return `${label(d)}: ${d.count} application${d.count === 1 ? '' : 's'} passed through${now ? `, ${now} here now` : ''}`;
      });
    // Slivers get no label (hover shows it) so text never piles up; small nodes get one line.
    const labelled = node.filter((d) => d.y1 - d.y0 >= 10 || d.terminal);
    labelled.append('text').attr('x', (d) => d.x1 + 6).attr('y', (d) => (d.y0 + d.y1) / 2 - (d.y1 - d.y0 >= 28 ? 2 : -4))
      .attr('font-weight', (d) => (d.terminal ? 700 : 500)).text((d) => (d.y1 - d.y0 >= 28 || d.terminal ? label(d) : `${label(d)} · ${d.count}`));
    labelled.filter((d) => d.y1 - d.y0 >= 28 || d.terminal).append('text').attr('class', 'node-count').attr('x', (d) => d.x1 + 6).attr('y', (d) => (d.y0 + d.y1) / 2 + 12)
      .text((d) => {
        if (d.terminal) return `${d.count} · ${pct(d.count / flow.total)}`;
        const now = d.visit === 1 ? flow.byStatus[d.state] ?? 0 : 0;
        return now ? `${d.count} · ${now} now` : String(d.count);
      });
    el.replaceChildren(svg.node());
  }
  const label = (d) => `${nice(d.state)}${d.visit > 1 ? ' (rework)' : ''}`;

  async function drawMermaid(flow) {
    const n = (s) => flow.byStatus[s] ?? 0;
    const lbl = (s) => `${nice(s)} (${n(s)})`;
    const edges = [
      ['[*]', 'RECEIVED'], ['RECEIVED', 'VALIDATING'], ['VALIDATING', 'AWAITING_DOCS'], ['AWAITING_DOCS', 'VALIDATING'],
      ['VALIDATING', 'ENRICHING'], ['ENRICHING', 'UNDERWRITING'], ['ENRICHING', 'AWAITING_PROVIDER'], ['AWAITING_PROVIDER', 'UNDERWRITING'], ['AWAITING_PROVIDER', 'HUMAN_REVIEW'], ['UNDERWRITING', 'HUMAN_REVIEW'],
      ['UNDERWRITING', 'AWAITING_SIGNATURE'], ['HUMAN_REVIEW', 'AWAITING_SIGNATURE'], ['HUMAN_REVIEW', 'AWAITING_DOCS'],
      ['AWAITING_SIGNATURE', 'DISBURSING'], ['DISBURSING', 'FUNDED'],
      ['VALIDATING', 'DECLINED'], ['AWAITING_DOCS', 'DECLINED'], ['UNDERWRITING', 'DECLINED'], ['HUMAN_REVIEW', 'DECLINED'], ['AWAITING_SIGNATURE', 'DECLINED'],
      ['HUMAN_REVIEW', 'ESCALATED'], ['AWAITING_SIGNATURE', 'ESCALATED'], ['DISBURSING', 'ESCALATED'],
      ['FUNDED', '[*]'], ['DECLINED', '[*]'], ['ESCALATED', '[*]'],
    ];
    const text = ['stateDiagram-v2', 'direction LR',
      ...STATUSES.map((s) => `  ${s}: ${lbl(s)}`),
      ...edges.map(([a, b]) => `  ${a} --> ${b}`),
      ...STATUSES.map((s) => `  classDef c_${s} fill:${color(s)},color:#fff,stroke:${color(s)}`),
      ...STATUSES.map((s) => `  class ${s} c_${s}`)].join('\n');
    if (text === lastMermaid || !$('#mermaid')) return;
    lastMermaid = text;
    try {
      const { svg } = await mermaid.render(`m${Date.now()}`, text);
      if ($('#mermaid')) $('#mermaid').innerHTML = svg;
    } catch (err) { $('#mermaid').innerHTML = `<div class="empty">Diagram unavailable: ${esc(err.message)}</div>`; }
  }

  // ---- Cases ------------------------------------------------------------------
  function renderCases() {
    const p = route().params;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Cases</h1><p class="muted">Every application from Temporal Visibility (search attributes and memo, no per-workflow queries). Click a row for detail and actions.</p></div>
        <div class="filters">
          <input type="search" id="c-q" placeholder="Search applicant, ID, scenario" value="${esc(p.get('q') ?? '')}" aria-label="Search">
          <select id="c-product" aria-label="Product">${opts(PRODUCTS, p.get('product'), 'All products')}</select>
          <select id="c-channel" aria-label="Channel">${opts(CHANNELS, p.get('channel'), 'All channels')}</select>
        </div>
      </div>
      <div class="kpis" id="c-tiles"></div>
      <div class="card"><div class="card-head"><h2 id="c-count">Applications</h2><code class="muted" id="c-query"></code></div><div class="table-wrap" id="c-table"></div></div>`;
    const apply = () => {
      const cur = route().params;
      setParams(new URLSearchParams({ q: $('#c-q').value, product: $('#c-product').value, channel: $('#c-channel').value, status: cur.get('status') ?? '' }));
      loadCases();
    };
    $('#c-q').addEventListener('input', debounce(apply, 250));
    $('#c-product').addEventListener('change', apply);
    $('#c-channel').addEventListener('change', apply);
    loadCases();
    schedule(loadCases, 4000);
  }

  let allCaseCounts = {};
  async function loadCases() {
    const p = route().params;
    const status = p.get('status') ?? '';
    const base = new URLSearchParams({ product: p.get('product') ?? '', channel: p.get('channel') ?? '', q: p.get('q') ?? '' });
    const [all, filtered] = await Promise.all([
      api(`/api/cases?${base}`),
      status ? api(`/api/cases?${base}&status=${status}`) : null,
    ]);
    if (!$('#c-table')) return;
    allCaseCounts = all.rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    const open = all.rows.filter((r) => r.executionStatus === 'RUNNING').length;
    const sla = all.rows.filter((r) => r.slaBreached).length;
    const tiles = [['', 'All', all.rows.length, 'var(--ph-blue)'], ['OPEN', 'Open', open, 'var(--ph-blue)'],
      ...STATUSES.filter((s) => s !== 'RECEIVED').map((s) => [s, nice(s), allCaseCounts[s] ?? 0, cssVar(s)]), ['SLA', 'SLA breached', sla, cssVar('ESCALATED')]];
    $('#c-tiles').innerHTML = tiles.map(([key, l, v, accent]) =>
      `<button class="kpi ${status === key ? 'active' : ''}" data-status="${key}" style="--accent:${accent}"><div class="label">${l}</div><div class="value">${v}</div></button>`).join('');
    $('#c-tiles').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const cur = route().params;
      cur.set('status', b.dataset.status);
      setParams(cur);
      loadCases();
    }));
    const rows = (filtered ?? all).rows;
    $('#c-query').textContent = (filtered ?? all).query;
    $('#c-count').textContent = `${rows.length} application${rows.length === 1 ? '' : 's'}`;
    $('#c-table').innerHTML = rows.length ? `<table class="data"><thead><tr>
        <th>Applicant</th><th>Status</th><th>Product</th><th>Channel</th><th class="num">Amount</th><th>Scenario</th><th>Started</th><th>Workflow ID</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickable" data-open="${esc(r.applicationId)}">
          <td><b>${esc(r.applicantName || '(unparsed)')}</b></td>
          <td>${chip(r.status)} ${r.slaBreached ? '<span class="flag">SLA</span>' : ''}</td>
          <td>${nice(r.productType)}</td><td>${nice(r.channel)}</td><td class="num">${money(r.amount)}</td>
          <td class="muted">${esc(r.scenario ?? '')}</td><td class="muted" title="${esc(r.startTime)}">${ago(r.startTime)} ago</td>
          <td class="mono muted">${esc(r.applicationId)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>No applications match</strong>Change the filters, start a scenario or run the synthesizer.</div>';
  }

  // ---- Review queue -----------------------------------------------------------
  function renderReview() {
    view.innerHTML = `
      <div class="page-head"><div><h1>Review queue</h1><p class="muted">Applications paused in <b>HUMAN_REVIEW</b>, oldest first. Each workflow is durably suspended until a decision arrives through the <code>submitReviewDecision</code> update.</p></div></div>
      <div class="card"><div class="table-wrap" id="r-table"></div></div>`;
    loadReview();
    schedule(loadReview, 3000);
  }

  let slaIndex = {};
  const slaCell = (id) => {
    const i = slaIndex[id];
    if (!i) return '<span class="muted">On track</span>';
    const c = { BREACHED: 'var(--danger)', AT_RISK: 'var(--st-escalated)', STALE: 'var(--st-awaiting-docs)' }[i.risk];
    return `<span class="chip" style="--c:${c}">${i.risk === 'BREACHED' ? 'Breached' : i.risk === 'AT_RISK' ? 'At risk' : 'Stale'}</span><div class="muted">${i.msLeft > 0 ? `<span class="countdown" data-until="${esc(i.slaDeadline)}"></span> left` : `${dur(Math.round(-i.msLeft / 1000))} over`}</div>`;
  };

  async function loadReview() {
    const [rows, board] = await Promise.all([api('/api/review-queue'), api('/api/sla-board').catch(() => null)]);
    if (board) slaIndex = Object.fromEntries([...board.breached, ...board.atRisk, ...board.stale].map((i) => [i.applicationId, i]));
    if (!$('#r-table')) return;
    $('#r-table').innerHTML = rows.length ? `<table class="data"><thead><tr><th>Applicant</th><th>Why it's here</th><th>Approvals</th><th>Claim</th><th>SLA</th><th class="num">Amount</th><th>Product</th><th>Waiting</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="clickable" data-open="${esc(r.applicationId)}">
        <td><b>${esc(r.applicantName)}</b><div class="mono muted">${esc(r.applicationId)}</div></td>
        <td class="reason">${esc(r.reason ?? '')}</td>
        <td>${r.approvals.length}/${r.approvalsRequired}${r.approvalsRequired > 1 ? ' <span class="chip" style="--c:var(--st-human-review)">Four-eyes</span>' : ''}${r.approvals.length ? `<div class="muted">${esc(r.approvals.join(', '))}</div>` : ''}</td>
        <td>${r.claim && Date.parse(r.claim.expiresAt) > Date.now() ? `<b>${esc(r.claim.reviewerId)}</b><div class="muted"><span class="countdown" data-until="${esc(r.claim.expiresAt)}"></span> left</div>` : '<span class="muted">Open</span>'}</td>
        <td>${slaCell(r.applicationId)}</td>
        <td class="num">${money(r.amount)}</td><td>${nice(r.productType)}</td>
        <td>${ago(r.since)}${r.slaBreached ? ' <span class="flag">SLA</span>' : ''}</td>
        <td><button class="btn primary sm" data-open="${esc(r.applicationId)}">Review</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>The queue is empty</strong>Start the <i>Fraud signals</i> or <i>Large loan (four-eyes)</i> scenario to see a case land here.</div>';
  }

  // ---- Audit ------------------------------------------------------------------
  // Two views over the same append-only log: Cases (one row per application, the compliance dashboard)
  // and Events (every decision and transition). Filters live in the URL; exports use the same filters.
  function renderAudit() {
    const p = route().params;
    const mode = p.get('view') === 'events' ? 'events' : 'cases';
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Audit</h1><p class="muted">Every automated and human decision, append-only. Filters are kept in the URL, so a view can be bookmarked; exports use the same filters.</p></div>
        <div class="filters">
          <div class="seg" role="tablist" aria-label="Audit view">
            <button role="tab" class="${mode === 'cases' ? 'on' : ''}" data-mode="cases">Cases</button>
            <button role="tab" class="${mode === 'events' ? 'on' : ''}" data-mode="events">Events</button>
          </div>
          <a class="btn ghost" id="a-csv">Export CSV</a><a class="btn primary" id="a-pdf" target="_blank" rel="noopener">Export PDF report</a>
        </div>
      </div>
      <div class="card">
        <div class="filters">
          <input type="search" id="a-q" placeholder="${mode === 'cases' ? 'Search applicant, case ID, reason, reviewer, scenario' : 'Search reason, ID, actor, details'}" value="${esc(p.get('q') ?? '')}" style="flex:1;min-width:200px" aria-label="Search">
          ${mode === 'events' ? `<select id="a-type" aria-label="Event type"><option value="">All events</option></select>
          <select id="a-state" aria-label="Transition state">${opts(STATUSES, p.get('state'), 'Any state')}</select>`
          : `<select id="a-status" aria-label="Current state"><option value="">Any state</option><option value="OPEN" ${p.get('status') === 'OPEN' ? 'selected' : ''}>Open (not terminal)</option>${STATUSES.map((v) => `<option value="${v}" ${v === p.get('status') ? 'selected' : ''}>${nice(v)}</option>`).join('')}</select>`}
          <select id="a-product" aria-label="Product">${opts(PRODUCTS, p.get('product'), 'All products')}</select>
          <select id="a-channel" aria-label="Channel">${opts(CHANNELS, p.get('channel'), 'All channels')}</select>
          ${mode === 'events' ? `<input type="text" id="a-actor" placeholder="Actor (e.g. reviewer:)" value="${esc(p.get('actor') ?? '')}" aria-label="Actor">` : ''}
          <input type="datetime-local" id="a-from" value="${esc(p.get('from') ? p.get('from').slice(0, 16) : '')}" aria-label="Received from">
          <input type="datetime-local" id="a-to" value="${esc(p.get('to') ? p.get('to').slice(0, 16) : '')}" aria-label="Received to">
        </div>
      </div>
      <div class="kpis" id="a-kpis" style="margin-top:16px"></div>
      ${mode === 'cases' ? `<div class="card"><div class="card-head"><h2>State distribution</h2><span class="muted">click a state to filter</span></div><div id="a-bar"></div></div>` : ''}
      <div class="card"><div class="card-head"><h2 id="a-count"></h2><span class="muted">${mode === 'cases' ? 'newest first, up to 1,000 shown' : 'newest first, up to 500 shown'}</span></div><div class="table-wrap" id="a-table"></div></div>`;
    const val = (id) => $(`#${id}`)?.value ?? '';
    const apply = () => {
      const iso = (v) => (v ? new Date(v).toISOString() : '');
      setParams(new URLSearchParams({
        view: mode === 'events' ? 'events' : '', q: val('a-q'), type: val('a-type'), state: val('a-state'), status: val('a-status'),
        product: val('a-product'), channel: val('a-channel'), actor: val('a-actor'), from: iso(val('a-from')), to: iso(val('a-to')),
      }));
      loadAudit();
    };
    view.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      const cur = route().params;
      cur.set('view', b.dataset.mode === 'events' ? 'events' : '');
      ['type', 'state', 'actor', 'status'].forEach((k) => cur.delete(k));
      setParams(cur);
      renderAudit();
    }));
    $('#a-q').addEventListener('input', debounce(apply, 250));
    $('#a-actor')?.addEventListener('input', debounce(apply, 250));
    for (const id of ['a-type', 'a-state', 'a-status', 'a-product', 'a-channel', 'a-from', 'a-to']) $(`#${id}`)?.addEventListener('change', apply);
    loadAudit();
    schedule(loadAudit, 5000);
  }

  async function loadAudit() {
    const p = route().params;
    return p.get('view') === 'events' ? loadAuditEvents(p) : loadAuditCases(p);
  }

  async function loadAuditCases(p) {
    const data = await api(`/api/audit/cases?${p}`);
    if (!$('#a-table') || !$('#a-bar')) return;
    const s = data.summary;
    $('#a-csv').href = `/api/audit/cases.csv?${p}`;
    $('#a-pdf').href = `/api/audit.pdf?${p}`;
    $('#a-kpis').innerHTML = [
      ['Open', s.inFlight, 'not yet terminal'], ['Closed', s.terminal.FUNDED + s.terminal.DECLINED + s.terminal.ESCALATED, `${s.terminal.FUNDED} funded · ${s.terminal.DECLINED} declined · ${s.terminal.ESCALATED} escalated`],
      ['Funding rate', pct(s.fundingRate), 'of closed applications'], ['Funded volume', money(s.fundedVolume), ''],
      ['SLA breaches', s.slaBreached, ''], ['Manually reviewed', s.manuallyReviewed, `${s.needsReview} waiting now`],
      ['Median time to close', s.medianSecondsToClose == null ? '–' : dur(s.medianSecondsToClose), 'received to terminal'],
    ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    const present = STATUSES.filter((k) => s.byStatus[k]);
    const active = p.get('status') ?? '';
    $('#a-bar').innerHTML = s.total ? `
      <div class="stack" role="img" aria-label="Applications by current state">${present.map((k) => `<i style="flex:${s.byStatus[k]};background:${cssVar(k)}" title="${nice(k)}: ${s.byStatus[k]}"></i>`).join('')}</div>
      <div class="legend legend-filters">${present.map((k) => `<button class="${active === k ? 'on' : ''}" data-status="${k}"><i style="background:${cssVar(k)}"></i>${nice(k)} <b>${s.byStatus[k]}</b></button>`).join('')}
        ${active ? '<button data-status="">Clear filter ✕</button>' : ''}</div>`
      : '<div class="empty">No applications yet.</div>';
    $('#a-bar').querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      const cur = route().params;
      cur.set('status', cur.get('status') === b.dataset.status ? '' : b.dataset.status);
      setParams(cur);
      if ($('#a-status')) $('#a-status').value = cur.get('status') ?? '';
      loadAudit();
    }));
    $('#a-count').textContent = `${data.total.toLocaleString()} case${data.total === 1 ? '' : 's'}`;
    $('#a-table').innerHTML = data.cases.length ? `<table class="data"><thead><tr><th>Applicant / case</th><th>Product</th><th>Channel</th><th>State</th><th>Latest reason</th><th>Reviewers</th><th>Received</th><th class="num">Events</th><th>Report</th></tr></thead><tbody>
      ${data.cases.map((c) => `<tr class="clickable" data-open="${esc(c.applicationId)}">
        <td><b>${esc(c.applicantName || '(unparsed)')}</b><div class="mono muted">${esc(c.applicationId)}</div></td>
        <td>${nice(c.productType)}</td><td>${nice(c.channel)}</td>
        <td>${chip(c.status)} ${c.slaBreached ? '<span class="flag">SLA</span>' : ''}</td>
        <td class="reason">${esc(c.lastReason ?? '')}<div class="muted mono">${esc(c.lastActor ?? '')}</div></td>
        <td>${esc(c.reviewers.join(', ') || '–')}</td>
        <td class="muted" title="${esc(c.receivedAt)}">${ago(c.receivedAt)} ago</td>
        <td class="num">${c.eventCount}</td>
        <td><a href="/api/cases/${encodeURIComponent(c.applicationId)}/report.pdf" target="_blank" rel="noopener" onclick="event.stopPropagation()">PDF</a></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>No cases match</strong>Loosen the filters.</div>';
  }

  async function loadAuditEvents(p) {
    const [data, flow] = await Promise.all([api(`/api/audit?${p}`), api(`/api/flow?${p}`)]);
    if (!$('#a-table') || !$('#a-type')) return;
    const typeSel = $('#a-type');
    const cur = p.get('type') ?? '';
    if (typeSel.options.length !== data.types.length + 1) typeSel.innerHTML = `<option value="">All events</option>` + data.types.map((t) => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('');
    $('#a-csv').href = `/api/audit.csv?${p}`;
    $('#a-pdf').href = `/api/audit.pdf?${p}`;
    $('#a-kpis').innerHTML = [
      ['Applications', flow.total], ['Funded', flow.terminal.FUNDED], ['Declined', flow.terminal.DECLINED], ['Escalated', flow.terminal.ESCALATED],
      ['Funding rate', pct(flow.fundingRate)], ['Events', data.total],
    ].map(([l, v]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
    $('#a-count').textContent = `${data.total.toLocaleString()} event${data.total === 1 ? '' : 's'}`;
    $('#a-table').innerHTML = data.events.length ? `<table class="data"><thead><tr><th>Time</th><th>Application</th><th>Event</th><th>Transition</th><th>Actor</th><th>Reason</th></tr></thead><tbody>
      ${data.events.map((e) => `<tr>
        <td class="mono muted" title="${esc(e.at)}">${time(e.at)}</td>
        <td><a href="#" data-open="${esc(e.applicationId)}" class="mono">${esc(e.applicationId)}</a><div class="muted">${nice(e.productType)} · ${nice(e.channel)}</div></td>
        <td class="mono">${esc(e.type)}</td>
        <td>${e.to ? `${e.from ? `${chip(e.from)} → ` : ''}${chip(e.to)}` : ''}</td>
        <td class="mono">${esc(e.actor)}</td>
        <td class="reason">${esc(e.reason ?? '')}${e.details && !e.to ? `<div class="mono muted">${esc(JSON.stringify(e.details).slice(0, 140))}</div>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>No events match</strong>Loosen the filters.</div>';
  }

  // ---- SLA watch ------------------------------------------------------------
  // Open applications that have breached, are about to breach, or have gone stale, so a reviewer can see
  // which ones need a person now. Columns sort by least time left.
  function renderSla() {
    const p = route().params;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>SLA watch</h1><p class="muted">Open applications closest to breaching their SLA (48 hours; 4 minutes in the demo), and ones that have gone quiet. Least time left first; click a card to act. To fill it quickly: Synthesize many › Scenario pack › SLA pressure.</p></div>
        <div class="filters">
          <div class="seg" role="tablist" aria-label="Show">
            <button class="${p.get('who') === 'people' ? '' : 'on'}" data-who="">Everything</button>
            <button class="${p.get('who') === 'people' ? 'on' : ''}" data-who="people">Needs a person</button>
          </div>
          <select id="s-product" aria-label="Product">${opts(PRODUCTS, p.get('product'), 'All products')}</select>
        </div>
      </div>
      <div class="kpis" id="s-kpis"></div>
      <div class="board" id="s-board"></div>`;
    view.querySelectorAll('[data-who]').forEach((b) => b.addEventListener('click', () => {
      const cur = route().params; cur.set('who', b.dataset.who); setParams(cur); renderSla();
    }));
    $('#s-product').addEventListener('change', (e) => { const cur = route().params; cur.set('product', e.target.value); setParams(cur); loadSla(); });
    loadSla();
    schedule(loadSla, 4000);
  }

  async function loadSla() {
    const p = route().params;
    const b = await api(`/api/sla-board?product=${encodeURIComponent(p.get('product') ?? '')}`);
    if (!$('#s-board')) return;
    const people = p.get('who') === 'people';
    const keep = (items) => (people ? items.filter((i) => i.needsPerson) : items);
    const lanes = [
      ['BREACHED', 'Breached', 'Past the deadline. Escalate or finish now.', 'var(--danger)', keep(b.breached)],
      ['AT_RISK', 'At risk', 'Flagged by the workflow; breaches soon unless someone acts.', 'var(--st-escalated)', keep(b.atRisk)],
      ['STALE', 'Stale', `No activity for ${b.timing.staleAfter} or more.`, 'var(--st-awaiting-docs)', keep(b.stale)],
    ];
    $('#s-kpis').innerHTML = [
      ['Breached', b.counts.breached, 'past the SLA deadline', 'var(--danger)'],
      ['At risk', b.counts.atRisk, 'flagged, not yet breached', 'var(--st-escalated)'],
      ['Stale', b.counts.stale, 'no recent activity', 'var(--st-awaiting-docs)'],
      ['Waiting on a reviewer', b.counts.reviews, 'of the cards on this board', 'var(--st-human-review)'],
      ['Fees at stake', money(b.feesAtStake), 'billable if these fund', 'var(--ph-blue)'],
    ].map(([l, v, sub, accent]) => `<div class="kpi" style="--accent:${accent}"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    const card = (i, c) => {
      const claim = b.claims?.[i.applicationId];
      const claimed = claim && Date.parse(claim.expiresAt) > Date.now();
      return `<div class="risk-card" style="--c:${c}" data-open="${esc(i.applicationId)}">
        <div class="top"><span class="who">${esc(i.applicantName || i.applicationId)}</span>
          <span class="left">${i.msLeft > 0 ? `<span class="countdown" data-until="${esc(i.slaDeadline)}"></span> left` : `${dur(Math.round(-i.msLeft / 1000))} over`}</span></div>
        <div class="progress" title="${i.pctUsed}% of the SLA used"><i style="width:${Math.min(100, i.pctUsed)}%"></i></div>
        <div>${chip(i.status)} ${i.needsPerson ? '<span class="person">Needs a person</span>' : ''}</div>
        <div class="meta"><span>Waiting on: <b>${esc(i.waitingOn)}</b></span><span>Quiet for ${dur(Math.round(i.staleMs / 1000))}</span>
          <span>${nice(i.productType)} · ${money(i.amount)}</span>${claimed ? `<span>Claimed by <b>${esc(claim.reviewerId)}</b></span>` : i.status === 'HUMAN_REVIEW' ? '<span>Unclaimed</span>' : ''}</div>
      </div>`;
    };
    $('#s-board').innerHTML = lanes.map(([, title, desc, c, items]) => `
      <section class="lane"><div class="lane-head"><div><h2><i style="--c:${c}"></i>${title}</h2><p class="muted">${esc(desc)}</p></div><b>${items.length}</b></div>
      <div class="lane-body">${items.length ? items.map((i) => card(i, c)).join('') : '<div class="empty" style="padding:20px">Nothing here.</div>'}</div></section>`).join('');
    tickCountdowns();
  }

  // ---- Billing --------------------------------------------------------------
  // Funded loans are billable workflows: one charge each, priced by a versioned tariff, billed to the
  // business line that owns the product. Declined and escalated applications bill nothing.
  function renderBilling() {
    const p = route().params;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Billing</h1><p class="muted">One charge per funded loan, priced by the tariff in force and billed to the business line that owns the product. Applications that don’t fund bill nothing.</p></div>
        <div class="filters">
          <select id="b-period" aria-label="Billing period"><option value="">All periods</option></select>
          <select id="b-product" aria-label="Product">${opts(PRODUCTS, p.get('product'), 'All products')}</select>
          <select id="b-channel" aria-label="Channel">${opts(CHANNELS, p.get('channel'), 'All channels')}</select>
          <a class="btn ghost" id="b-csv">Export CSV</a>
        </div>
      </div>
      <div class="kpis" id="b-kpis"></div>
      <div class="grid two">
        <div class="card"><div class="card-head"><h2>By account</h2><span class="muted">invoice per account and period</span></div><div class="table-wrap" id="b-accounts"></div></div>
        <div class="card"><div class="card-head"><h2>Tariff</h2><span class="muted mono" id="b-tariff-version"></span></div><div class="table-wrap" id="b-tariff"></div></div>
      </div>
      <div class="card"><div class="card-head"><h2 id="b-count">Charges</h2><span class="muted">newest first, up to 500 shown</span></div><div class="table-wrap" id="b-charges"></div></div>`;
    const apply = () => {
      setParams(new URLSearchParams({ period: $('#b-period').value, product: $('#b-product').value, channel: $('#b-channel').value }));
      loadBilling();
    };
    for (const id of ['b-period', 'b-product', 'b-channel']) $(`#${id}`).addEventListener('change', apply);
    loadBilling();
    schedule(loadBilling, 5000);
  }

  async function loadBilling() {
    const p = route().params;
    const b = await api(`/api/billing?${p}`);
    if (!$('#b-charges')) return;
    const sel = $('#b-period');
    const cur = p.get('period') ?? '';
    if (sel.options.length !== b.periods.length + 1) sel.innerHTML = '<option value="">All periods</option>' + b.periods.map((x) => `<option ${x === cur ? 'selected' : ''}>${x}</option>`).join('');
    $('#b-csv').href = `/api/billing.csv?${p}`;
    const o = b.outcomes;
    $('#b-kpis').innerHTML = [
      ['Billable workflows', b.totals.charges, 'funded loans charged', 'var(--ph-blue)'],
      ['Billed', money(b.totals.billed), `avg ${money(b.totals.averageFee)} per loan`, 'var(--ph-blue)'],
      ['Principal funded', money(b.totals.principal), '', 'var(--st-funded)'],
      ['Billable rate', pct(o.billableRate), `${o.funded} of ${o.closed} closed`, 'var(--ok)'],
      ['Not billable', o.notBillable, `${o.declined} declined · ${o.escalated} escalated`, 'var(--st-declined)'],
      ['Pipeline', money(b.pipeline.expectedFees), `expected from ${b.pipeline.open} open`, 'var(--st-awaiting-signature)'],
    ].map(([l, v, sub, accent]) => `<div class="kpi" style="--accent:${accent}"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    const period = cur || b.periods[0] || new Date().toISOString().slice(0, 7);
    $('#b-accounts').innerHTML = b.byAccount.length ? `<table class="data"><thead><tr><th>Account</th><th class="num">Loans</th><th class="num">Principal</th><th class="num">Billed</th><th>Invoice</th></tr></thead><tbody>
      ${b.byAccount.map((a) => `<tr><td><b>${esc(a.key)}</b></td><td class="num">${a.charges}</td><td class="num">${money(a.principal)}</td><td class="num">${money(a.billed)}</td>
        <td><a href="/api/billing/invoice.pdf?account=${encodeURIComponent(a.key)}&period=${period}" target="_blank" rel="noopener">${period} PDF</a></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No charges yet. Charges appear when loans fund.</div>';
    $('#b-tariff-version').textContent = b.tariff.version;
    $('#b-tariff').innerHTML = `<table class="data"><thead><tr><th>Product</th><th>Account</th><th class="num">Flat</th><th class="num">+ bps</th><th class="num">Min</th><th class="num">Cap</th></tr></thead><tbody>
      ${Object.entries(b.tariff.lines).map(([prod, l]) => `<tr><td>${nice(prod)}</td><td>${esc(l.account)}</td><td class="num">$${l.flat}</td><td class="num">${l.bps}</td><td class="num">$${l.min}</td><td class="num">$${l.cap}</td></tr>`).join('')}</tbody></table>`;
    $('#b-count').textContent = `${b.totals.charges} charge${b.totals.charges === 1 ? '' : 's'}`;
    $('#b-charges').innerHTML = b.charges.length ? `<table class="data"><thead><tr><th>Funded</th><th>Application</th><th>Account</th><th>Channel</th><th class="num">Principal</th><th>Basis</th><th class="num">Fee</th></tr></thead><tbody>
      ${b.charges.map((c) => `<tr class="clickable" data-open="${esc(c.applicationId)}"><td class="muted" title="${esc(c.fundedAt)}">${time(c.fundedAt)}</td>
        <td class="mono">${esc(c.applicationId)}<div class="muted">${esc(c.loanNumber)}</div></td><td>${esc(c.account)}</td><td>${nice(c.channel)}</td>
        <td class="num">${money(c.principal)}</td><td class="muted">$${c.breakdown.flat} + ${c.breakdown.bps} bps${c.breakdown.minApplied ? ' (min)' : c.breakdown.capApplied ? ' (cap)' : ''}</td><td class="num"><b>$${c.fee.toFixed(2)}</b></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>No charges</strong>Run a scenario that funds, such as Happy path.</div>';
  }

  // ---- Health -----------------------------------------------------------------
  function renderHealth() {
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Health and downtime</h1><p class="muted">Third-party providers, their circuit breakers, and Temporal itself. Switching a provider off simulates a vendor outage so you can watch the retry layers work.</p></div>
        <div class="filters"><button class="btn primary" id="h-retry">Retry parked applications now</button></div>
      </div>
      <div class="kpis" id="h-kpis"></div>
      <div class="card"><div class="card-head"><h2>Providers</h2><span class="muted">the switch is the demo's outage control; circuit state comes from the workers</span></div><div class="providers" id="h-providers"></div></div>
      <div class="card"><div class="card-head"><h2>How downtime is handled</h2></div>
        <ol class="layers">
          <li><b>Activity retries.</b> Each call retries with exponential backoff (429s follow Retry-After) inside a total time budget per call. Covers blips of seconds.</li>
          <li><b>Circuit breaker per provider.</b> After 5 failures in 30s the circuit opens: calls fail fast for 10s instead of every workflow hammering a dead API, then one probe tests recovery (half-open).</li>
          <li><b>Parking.</b> The application moves to <code>AWAITING_PROVIDER</code>, a durable wait that holds no worker. It re-runs only the failed checks (successful ones are kept, never re-billed) on a widening schedule. If the outage outlasts its budget it goes to human review with what it has. Turning a provider back on nudges parked applications to retry immediately.</li>
          <li><b>Core banking.</b> Payouts retry through outages (idempotent on the application ID) for up to the banking budget, then escalate. Money is late rather than bounced to a person.</li>
          <li><b>Temporal down.</b> Ingest retries the start with backoff and jitter, then writes the application to a local outbox and returns its workflow ID. A drainer submits it once Temporal is back. Running workflows simply resume.</li>
        </ol>
      </div>`;
    $('#h-retry').addEventListener('click', async () => {
      try { const r = await api('/api/providers-retry', { method: 'POST' }); toast(`Nudged ${r.nudged} parked application(s)`); } catch (err) { toast(esc(err.message), 'error'); }
    });
    loadHealth();
    schedule(loadHealth, 2000);
  }

  let lastHealthKey = '';
  async function loadHealth() {
    const h = await api('/api/health');
    lastHealth = h;
    renderBanner();
    if (!$('#h-providers')) return;
    // Re-render only on change, so a switch isn't replaced under the user's cursor every poll.
    const key = JSON.stringify(h);
    if (key === lastHealthKey && $('#h-providers').children.length) return;
    lastHealthKey = key;
    const open = h.providers.filter((p) => p.circuit.state !== 'CLOSED').length;
    $('#h-kpis').innerHTML = [
      ['Temporal', `<span class="status-dot ${h.temporal.ok ? '' : 'bad'}"></span>${h.temporal.ok ? 'Reachable' : 'Unreachable'}`, h.temporal.ok ? '' : esc(h.temporal.error)],
      ['Parked on a provider', h.parked ?? '–', 'AWAITING_PROVIDER'],
      ['Open circuits', open, `${h.providers.filter((p) => p.down).length} provider(s) switched off`],
      ['Ingest outbox', h.outbox.depth, h.outbox.oldest ? `oldest ${ago(h.outbox.oldest)} ago` : 'empty'],
    ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value" style="font-size:20px">${v}</div><div class="sub">${sub}</div></div>`).join('');
    $('#h-providers').innerHTML = h.providers.map((p) => `
      <div class="provider ${p.down ? 'is-down' : ''}">
        <div class="provider-head"><b>${esc(p.name)}</b>
          <label class="switch"><input type="checkbox" data-provider="${esc(p.name)}" ${p.down ? '' : 'checked'} aria-label="${esc(p.name)} available"> ${p.down ? 'Down' : 'Up'}</label></div>
        <div><span class="circuit ${p.circuit.state}">Circuit ${p.circuit.state.replace('_', '-').toLowerCase()}</span>
          <span class="muted" style="font-size:12px"> ${p.circuit.recentFailures} recent failure(s)${p.circuit.trips ? `, tripped ${p.circuit.trips}×` : ''}</span></div>
        ${p.circuit.state === 'OPEN' && p.circuit.reopensAt ? `<div class="muted" style="font-size:12px">Probe allowed ${time(p.circuit.reopensAt)}</div>` : ''}
        ${p.circuit.lastError ? `<div class="muted mono" style="font-size:11px">${esc(p.circuit.lastError)}</div>` : ''}
        ${p.name === 'core-banking' ? '<div class="muted" style="font-size:12px">Payouts wait and retry; no circuit (money movement never fails fast).</div>' : ''}
      </div>`).join('');
    $('#h-providers').querySelectorAll('[data-provider]').forEach((el) => el.addEventListener('change', async () => {
      try {
        const r = await api(`/api/providers/${el.dataset.provider}`, { method: 'POST', body: { down: !el.checked } });
        toast(r.down ? `${esc(r.name)} switched off: calls now fail with 503` : `${esc(r.name)} back up; nudged ${r.nudged} parked application(s)`);
        loadHealth();
      } catch (err) { toast(esc(err.message), 'error'); }
    }));
  }

  // ---- Case drawer ------------------------------------------------------------
  async function openCase(id) {
    openCaseId = id;
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
    $('#drawer-title').textContent = 'Loading…';
    $('#drawer-sub').textContent = id;
    $('#drawer-body').innerHTML = '';
    await loadCase(true);
    clearInterval(drawerTimer);
    drawerTimer = setInterval(() => { if (!document.hidden) loadCase(false).catch(() => {}); }, 2500);
  }

  function closeCase() {
    openCaseId = null;
    clearInterval(drawerTimer);
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
  }

  let lastCaseKey = '';
  async function loadCase(force) {
    const id = openCaseId;
    if (!id) return;
    let data;
    try { data = await api(`/api/cases/${encodeURIComponent(id)}`); } catch (err) {
      $('#drawer-title').textContent = 'Not found';
      $('#drawer-body').innerHTML = `<div class="err">${esc(err.message)}</div>`;
      return;
    }
    const key = JSON.stringify([data.status?.status, data.status?.approvals?.length, data.events.length, data.status?.slaBreached, data.status?.claim?.reviewerId, data.status?.claim?.expiresAt]);
    // Don't wipe a half-typed review reason on every refresh.
    if (!force && key === lastCaseKey) return;
    if (!force && document.activeElement?.closest('#drawer-body .action-box')) return;
    lastCaseKey = key;
    renderCase(data);
  }

  function renderCase({ status: s, events, temporalUrl, childLinks, executionStatus }) {
    const id = openCaseId;
    const st = s?.status ?? events.filter((e) => e.to).at(-1)?.to ?? 'RECEIVED';
    $('#drawer-title').innerHTML = `${esc(s?.applicantName ?? id)} ${chip(st)}`;
    $('#drawer-sub').textContent = id;
    const uw = s?.underwriting;
    const enr = s?.enrichment;
    const facts = s ? [
      ['Product', nice(s.productType)], ['Channel', nice(s.channel)], ['Amount', money(s.amount)],
      ['Scenario', s.scenario ?? '–'], ['SLA deadline', `${time(s.slaDeadline)}${s.slaBreached ? ' · breached' : ''}`], ['Execution', nice(executionStatus ?? '')],
    ] : [];
    $('#drawer-body').innerHTML = `
      ${s?.pendingAction ? `<div class="pending"><b>Waiting on:</b> ${esc(s.pendingAction)}</div>` : ''}
      ${s?.reasons?.length ? `<div class="section"><h4>Current reason</h4><div>${s.reasons.map(esc).join('<br>')}</div></div>` : ''}
      <div class="section"><div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div></div>
      <div class="section" id="actions"></div>
      ${uw ? `<div class="section"><h4>Underwriting · ${esc(uw.policyVersion)}</h4>
        <div><span class="chip" style="--c:${cssVar(uw.outcome === 'APPROVE' ? 'FUNDED' : uw.outcome === 'DECLINE' ? 'DECLINED' : 'HUMAN_REVIEW')}">${esc(uw.outcome)}</span> ${esc(uw.reasons.join('; '))}</div>
        <div class="kv" style="margin-top:8px">${Object.entries(uw.metrics).map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div></div>` : ''}
      ${enr ? `<div class="section"><h4>Enrichment</h4><div class="kv">
        ${enr.credit ? `<span>Credit score <b>${enr.credit.score}</b></span>` : ''}
        ${enr.identity ? `<span>Identity <b>${enr.identity.verified ? 'verified' : 'unverified'}</b></span>` : ''}
        ${enr.fraud ? `<span>Fraud risk <b>${enr.fraud.riskScore}</b>${enr.fraud.flagged ? ' flagged' : ''}</span>` : ''}
        ${enr.failures.map((f) => `<span style="border-color:var(--danger)">${esc(f.provider)} ${f.kind === 'PERMANENT' ? 'answered' : 'unavailable'}: ${esc(f.error)}</span>`).join('')}</div></div>` : ''}
      ${s?.approvalsRequired ? `<div class="section"><h4>Reviewer approvals (${s.approvals.length}/${s.approvalsRequired})</h4>${s.approvals.map((a) => `<div><b>${esc(a.reviewerId)}</b>: ${esc(a.reason)}</div>`).join('') || '<span class="muted">None yet</span>'}</div>` : ''}
      ${s?.billing ? `<div class="section"><h4>Billing · ${esc(s.billing.tariffVersion)}</h4><div class="kv">
        <span>Billed to <b>${esc(s.billing.account)}</b></span><span>Fee <b>$${s.billing.fee.toFixed(2)}</b></span>
        <span>Basis <b>$${s.billing.breakdown.flat} + ${s.billing.breakdown.bps} bps</b>${s.billing.breakdown.minApplied ? ' (minimum)' : s.billing.breakdown.capApplied ? ' (cap)' : ''}</span>
        <span>Period <b>${esc(s.billing.period)}</b></span><span class="mono">${esc(s.billing.chargeId)}</span></div></div>` : ''}
      ${s?.slaAtRisk && !TERMINAL.includes(s.status) ? `<div class="pending" style="margin-top:12px"><b>SLA at risk:</b> ${s.slaBreached ? 'the deadline has passed' : `deadline ${time(s.slaDeadline)}`}. Act now or it ${s.slaBreached ? 'stays flagged' : 'breaches'}.</div>` : ''}
      ${s?.children?.length ? `<div class="section"><h4>Child workflows</h4><table class="data"><tbody>
        ${s.children.map((c) => `<tr><td>${esc(c.stage)}</td><td class="mono">${esc(c.workflowType)}</td><td class="mono muted">${esc(c.taskQueue)}</td><td><a href="${esc(childLinks[c.workflowId])}" target="_blank" rel="noopener">open ↗</a></td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="section"><h4>Lifecycle</h4><ol class="timeline">
        ${(s?.history ?? []).map((h) => `<li style="--c:${cssVar(h.to)}"><b>${nice(h.to)}</b> <span class="t">${time(h.at)} · ${esc(h.actor)}</span>${h.reason ? `<div class="muted">${esc(h.reason)}</div>` : ''}</li>`).join('')}
      </ol></div>
      <div class="section"><h4>Audit trail (${events.length})</h4><table class="data"><tbody>
        ${events.map((e) => `<tr><td class="mono muted">${time(e.at)}</td><td class="mono">${esc(e.type)}${e.to ? ` → ${esc(nice(e.to))}` : ''}</td><td class="mono">${esc(e.actor)}</td><td>${esc(e.reason ?? '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="section" style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn ghost" href="/api/cases/${encodeURIComponent(id)}/report.pdf" target="_blank" rel="noopener">Download audit PDF</a>
        <a class="btn ghost" href="${esc(temporalUrl)}" target="_blank" rel="noopener">Open in Temporal UI ↗</a>
      </div>`;
    renderActions(s);
  }

  function renderActions(s) {
    const box = $('#actions');
    if (!s || TERMINAL.includes(s.status)) { box.innerHTML = ''; return; }
    const parts = [];
    if (s.status === 'HUMAN_REVIEW') {
      const me = store.get('reviewerId', '');
      const c = s.claim && Date.parse(s.claim.expiresAt) > Date.now() ? s.claim : null;
      const lease = config.timing?.claimLease ?? '30m';
      const claimHtml = !c
        ? `<div class="claim free"><span>Unclaimed. Claim it so nobody else decides while you work; a claim lasts ${esc(lease)} and can be extended.</span><button class="btn primary sm" id="cl-claim">Claim</button></div>`
        : c.reviewerId === me
          ? `<div class="claim mine" data-claim-until="${esc(c.expiresAt)}"><span>Claimed by you · <span class="countdown" data-until="${esc(c.expiresAt)}"></span> left. Extend it or it returns to the queue.</span><div class="row"><button class="btn primary sm" id="cl-extend">Extend</button><button class="btn ghost sm" id="cl-release">Release</button></div></div>`
          : `<div class="claim other"><span>Claimed by <b>${esc(c.reviewerId)}</b> · <span class="countdown" data-until="${esc(c.expiresAt)}"></span> left. Only they can decide until it ends.</span></div>`;
      const blocked = c && c.reviewerId !== me;
      parts.push(`<div class="action-box">
        <b>Reviewer decision</b>
        <input type="text" id="rv-id" placeholder="Reviewer ID" value="${esc(me)}" aria-label="Reviewer ID">
        ${claimHtml}
        <textarea id="rv-reason" rows="2" placeholder="Reason (required, recorded in the audit trail)" aria-label="Reason"></textarea>
        <div class="row">
          <button class="btn ok" data-decision="APPROVE" ${blocked ? 'disabled' : ''}>Approve</button>
          <button class="btn danger" data-decision="DECLINE" ${blocked ? 'disabled' : ''}>Decline</button>
          <select id="rv-docs" aria-label="Document to request">${DOCS.map((d) => `<option value="${d}">${nice(d)}</option>`).join('')}</select>
          <button class="btn ghost" data-decision="REQUEST_INFO" ${blocked ? 'disabled' : ''}>Request document</button>
        </div>
        <div class="err" id="rv-err"></div>
      </div>`);
    }
    if (s.status === 'AWAITING_DOCS') {
      parts.push(`<div class="action-box"><b>Documents</b><div class="row">
        ${s.missingDocuments.map((d) => `<button class="btn ghost" data-doc="${d}">Mark ${nice(d)} uploaded</button>`).join('')}
        ${s.missingDocuments.length > 1 ? `<button class="btn primary" data-doc="${s.missingDocuments.join(',')}">Upload all</button>` : ''}</div></div>`);
    }
    if (s.status === 'AWAITING_PROVIDER') {
      const w = s.providerWait;
      parts.push(`<div class="action-box"><b>Waiting on a provider</b>
        ${w ? `<div class="muted">${esc(w.providers.join(', '))} unavailable since ${time(w.since)}. ${w.attempts} retr${w.attempts === 1 ? 'y' : 'ies'} so far${w.nextRetryAt ? `, next at ${time(w.nextRetryAt)}` : ''}. Goes to human review at ${time(w.deadline)} if still down.</div>` : ''}
        <div class="row"><button class="btn primary" id="act-retry">Retry providers now</button></div></div>`);
    }
    if (s.status === 'AWAITING_SIGNATURE') {
      parts.push(`<div class="action-box"><b>E-signature</b><div class="row"><button class="btn primary" id="act-sign">Simulate "signed" webhook</button></div></div>`);
    }
    if (s.status !== 'DISBURSING') {
      parts.push(`<div class="row" style="display:flex;justify-content:flex-end"><button class="btn ghost sm" id="act-withdraw">Applicant withdraws</button></div>`);
    }
    if (!parts.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h4>Actions</h4><div style="display:grid;gap:10px">${parts.join('')}</div>`;
    const id = openCaseId;
    const after = (msg) => { toast(msg); lastCaseKey = ''; setTimeout(() => loadCase(true), 400); };
    box.querySelectorAll('[data-decision]').forEach((b) => b.addEventListener('click', async () => {
      const reviewerId = $('#rv-id').value.trim();
      store.set('reviewerId', reviewerId);
      const decision = b.dataset.decision;
      const reason = $('#rv-reason').value;
      const requestedDocuments = decision === 'REQUEST_INFO' ? [$('#rv-docs').value] : undefined;
      // Same decision, same request ID: a retry after a timeout can't record it twice.
      const key = `decision:${id}:${decision}:${reviewerId}:${reason}:${requestedDocuments ?? ''}`;
      try {
        const ack = await api(`/api/cases/${encodeURIComponent(id)}/review`, {
          method: 'POST', body: { decision, reviewerId, reason, requestedDocuments, requestId: reqId(key) },
        });
        settle(key);
        after(`Decision accepted (${ack.approvalsReceived}/${ack.approvalsRequired} approvals)`);
      } catch (err) {
        if (!/unreachable/i.test(err.message)) settle(key); // a rejection is final; only an unknown outcome keeps the ID
        $('#rv-err').textContent = `Rejected by the workflow: ${err.message}`;
      }
    }));
    const claim = async (action) => {
      const reviewerId = $('#rv-id').value.trim();
      store.set('reviewerId', reviewerId);
      const key = `claim:${id}:${action}:${reviewerId}:${Math.floor(Date.now() / 5000)}`;
      try {
        await api(`/api/cases/${encodeURIComponent(id)}/claim`, { method: 'POST', body: { reviewerId, action, requestId: reqId(key) } });
        settle(key);
        after(action === 'release' ? 'Claim released: the case is back in the queue' : action === 'extend' ? 'Claim extended' : 'Case claimed');
      } catch (err) { settle(key); $('#rv-err').textContent = `Rejected by the workflow: ${err.message}`; }
    };
    $('#cl-claim')?.addEventListener('click', () => claim('claim'));
    $('#cl-extend')?.addEventListener('click', () => claim('extend'));
    $('#cl-release')?.addEventListener('click', () => claim('release'));
    box.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/cases/${encodeURIComponent(id)}/docs`, { method: 'POST', body: { documents: b.dataset.doc.split(','), requestId: 'idempotent' } });
      after(`Signalled documentsUploaded: ${b.dataset.doc}`);
    }));
    $('#act-retry')?.addEventListener('click', async () => {
      await api(`/api/cases/${encodeURIComponent(id)}/retry-providers`, { method: 'POST' });
      after('Signalled retryProvidersNow');
    });
    $('#act-sign')?.addEventListener('click', async () => {
      try { await api(`/api/cases/${encodeURIComponent(id)}/sign`, { method: 'POST' }); after('Signalled agreementSigned'); } catch (err) { toast(esc(err.message), 'error'); }
    });
    $('#act-withdraw')?.addEventListener('click', async () => {
      await api(`/api/cases/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: { reason: 'Applicant withdrew via support call', requestId: 'idempotent' } });
      after('Signalled withdraw: applied at the next wait point');
    });
  }

  // Claim countdowns tick every second; a claim inside its reminder window turns amber, like a session
  // warning; one that runs out refreshes the case (the workflow has returned it to the queue).
  function tickCountdowns() {
    const warnMs = parseDur(config?.timing?.claimReminderBefore ?? '5m');
    document.querySelectorAll('.countdown[data-until]').forEach((el) => {
      const left = Date.parse(el.dataset.until) - Date.now();
      el.textContent = left > 0 ? `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` : 'expired';
      el.closest('[data-claim-until]')?.classList.toggle('expiring', left <= warnMs);
      if (left <= 0 && el.closest('#drawer') && openCaseId) { lastCaseKey = ''; loadCase(true); }
    });
  }
  const parseDur = (d) => { const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(d)); return m ? Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2]] : 0; };

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  init().catch((err) => { view.innerHTML = `<div class="card"><div class="err">Could not start the console: ${esc(err.message)}</div></div>`; });
})();
