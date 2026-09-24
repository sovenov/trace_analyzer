/* ====================== MCP budget ======================
   "Какой верхний предел токенов может вернуть MCP-инструмент" over every loaded traceId.
   Per call: tokens measured from the agent's own prompt growth (see mcpBudget), else
   estimated from the response bytes with a bytes-per-token ratio calibrated on the
   measured calls. The threshold comes two ways:
     · the meeting's rule of thumb — the agent's context divided by how many tools it
       called, averaged over agent conversations;
     · the window budget — (model window − what the agent carries before any tool −
       room for the answer) ÷ calls per conversation.
   Everything below the threshold inputs re-renders live when they change. */
let BUDGET = {for: null, thr: null, win: 128000, reserve: 8000, calls: null, agent: ''};
const DEFAULT_BPT = 2.8;
function quantile(xs, q){
  if(!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const mean = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;

function budgetModel(){
  const traces = STATE.traces;
  const batches = [], calls = [], convs = [];
  traces.forEach((t, ti) => {
    const B = t.budget;
    if(!B) return;
    B.batches.forEach(b => batches.push(b));
    const base = convs.length;
    B.convs.forEach(c => convs.push(Object.assign({trace: ti, mcpTokens: 0, known: 0}, c,
      {agent: c.agent || 'Основной агент'})));
    B.calls.forEach(c => calls.push(Object.assign({trace: ti}, c,
      {agent: c.agent || 'Основной агент', conv: base + c.conv})));
  });
  const ratios = batches.map(b => b.bytes / b.tokens);
  const bpt = quantile(ratios, 0.5) || DEFAULT_BPT;
  calls.forEach(c => {
    if(c.tokens != null){ c.est = c.tokens; c.how = 'замер'; }
    else if(c.bytes){ c.est = Math.round(c.bytes / bpt); c.how = 'оценка'; }
    else { c.est = null; c.how = 'нет данных'; }
    const cv = convs[c.conv];
    if(cv && c.est != null){ cv.mcpTokens += c.est; cv.known++; }
  });
  const active = convs.filter(c => c.calls > 0);
  const perCall = active.filter(c => c.peak).map(c => c.peak / c.calls);
  // what each agent had on hand, from the per-trace agent inventory
  const toolsets = new Map();
  traces.forEach(t => [t.mainAgent].concat(t.subAgents || []).forEach(a => {
    if(!a) return;
    if(!toolsets.has(a.name)) toolsets.set(a.name, new Set());
    (a.toolset || []).filter(x => x.kind === 'mcp').forEach(x => toolsets.get(a.name).add(x.name));
  }));
  const models = new Map();
  traces.forEach(t => t.events.forEach(e => {
    if(e.kind === 'llm' && e.model) models.set(e.model, (models.get(e.model) || 0) + 1);
  }));
  return {
    models: Array.from(models.entries()).sort((a, b) => b[1] - a[1]).map(p => p[0]),
    bpt: bpt, bptN: ratios.length, calls: calls, convs: convs, active: active,
    ruleMean: mean(perCall), ruleMedian: quantile(perCall, 0.5),
    baseP90: quantile(active.filter(c => c.base).map(c => c.base), 0.9),
    callsP90: Math.ceil(quantile(active.map(c => c.calls), 0.9) || 0),
    toolsets: toolsets
  };
}

function renderBudget(){
  const host = $('#budget');
  if(!host) return;
  if(!STATE.traces.length){ host.innerHTML = ''; BUDGET.for = null; return; }
  if(BUDGET.for === STATE.traces) return;          // tab switches keep what the user typed
  BUDGET.for = STATE.traces;
  const M = budgetModel();
  BUDGET.model = M;
  if(!M.calls.length){ host.innerHTML = ''; return; }
  BUDGET.calls = M.callsP90 || 1;
  BUDGET.agent = '';
  const thrWin = Math.max(0, BUDGET.win - (M.baseP90 || 0) - BUDGET.reserve) / BUDGET.calls;
  BUDGET.thr = Math.round(M.ruleMean ? Math.min(M.ruleMean, thrWin) : thrWin);
  host.innerHTML = '<details class="section budget" id="budgetfold">' +
    '<summary class="section-head"><h2>Бюджет токенов на ответ MCP</h2>' +
    '<span class="hint" id="bsum"></span></summary><div id="bbody"></div></details>';
  drawBudget();
}

function drawBudget(){
  const M = BUDGET.model, B = BUDGET;
  const fmtN = n => n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('ru-RU');
  const thrWin = Math.max(0, B.win - (M.baseP90 || 0) - B.reserve) / Math.max(B.calls, 1);
  const thr = B.thr;
  const calls = M.calls.filter(c => !B.agent || c.agent === B.agent);
  const agentsAll = Array.from(new Set(M.calls.map(c => c.agent))).sort();

  // ---- per tool
  const byTool = new Map();
  calls.forEach(c => {
    if(!byTool.has(c.tool)) byTool.set(c.tool, {tool: c.tool, n: 0, measured: 0, vals: [], bytes: [], agents: new Set(), top: null});
    const g = byTool.get(c.tool);
    g.n++; g.agents.add(c.agent);
    if(c.how === 'замер') g.measured++;
    if(c.bytes) g.bytes.push(c.bytes);
    if(c.est != null){
      g.vals.push(c.est);
      if(!g.top || c.est > g.top.est) g.top = c;
    }
  });
  const tools = Array.from(byTool.values()).map(g => Object.assign(g, {
    avg: mean(g.vals), p95: quantile(g.vals, 0.95), max: g.vals.length ? Math.max.apply(null, g.vals) : null,
    over: g.vals.filter(v => v > thr).length
  })).sort((a, b) => (b.max || -1) - (a.max || -1) || b.n - a.n);
  const overTools = tools.filter(t => t.max != null && t.max > thr);
  const overCalls = calls.filter(c => c.est != null && c.est > thr).length;
  const withEst = calls.filter(c => c.est != null).length;
  const measured = calls.filter(c => c.how === 'замер').length;

  // ---- per agent
  const byAgent = new Map();
  M.active.filter(c => !B.agent || c.agent === B.agent).forEach(c => {
    if(!byAgent.has(c.agent)) byAgent.set(c.agent, []);
    byAgent.get(c.agent).push(c);
  });
  const agents = Array.from(byAgent.entries()).map(([name, cs]) => {
    const peaks = cs.filter(c => c.peak).map(c => c.peak);
    const share = cs.filter(c => c.peak && c.known).map(c => Math.min(1, c.mcpTokens / c.peak));
    const set = M.toolsets.get(name);
    const used = new Set(M.calls.filter(c => c.agent === name).map(c => c.tool));
    return {name: name, convs: cs.length, callsAvg: mean(cs.map(c => c.calls)), callsMax: Math.max.apply(null, cs.map(c => c.calls)),
      base: mean(cs.filter(c => c.base).map(c => c.base)), peakAvg: mean(peaks), peakMax: peaks.length ? Math.max.apply(null, peaks) : null,
      mcpAvg: mean(cs.map(c => c.mcpTokens)), share: mean(share),
      rule: mean(cs.filter(c => c.peak).map(c => c.peak / c.calls)),
      connected: set ? set.size : null, connectedList: set ? Array.from(set).sort() : [], used: used.size};
  }).sort((a, b) => (b.peakMax || 0) - (a.peakMax || 0));

  const top = tools[0];
  $('#bsum').textContent = 'порог ' + fmtN(thr) + ' ток. · выше порога: ' + overTools.length + ' из ' + tools.length +
    ' инструментов' + (top && top.max ? ' · самый тяжёлый ответ: ' + top.tool + ' — ' + fmtN(top.max) + ' ток.' : '');

  const card = (v, k, sub, cls, title, attrs) => '<div class="stat ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + (attrs || '') + '>' +
    '<div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
  const num = (id, val, label, hint) => '<label class="bin"><span>' + esc(label) + '</span>' +
    '<input type="number" min="0" step="1" id="' + id + '" value="' + Math.round(val) + '">' +
    (hint ? '<em>' + hint + '</em>' : '') + '</label>';
  const level = v => v == null ? '' : v > thr ? 'over' : v > thr * 0.5 ? 'near' : 'ok';

  const html =
    '<p class="bnote">Сколько токенов ответ каждого MCP-инструмента добавил в контекст агента — по всем загруженным traceId. ' +
    '<b>Замер</b> — по росту prompt_tokens у следующего хода той же модели; <b>оценка</b> — по размеру ответа (content-length) ' +
    'из расчёта 1 токен ≈ ' + M.bpt.toFixed(2).replace('.', ',') + ' байта' +
    (M.bptN ? ' (медиана по ' + M.bptN + ' замерам)' : ' (замеров нет — взято типовое значение)') + '.' +
    (M.models.length ? ' Модели в логах: <code>' + M.models.slice(0, 4).map(esc).join('</code>, <code>') + '</code>' +
      (M.models.length > 4 ? ' и ещё ' + (M.models.length - 4) : '') + ' — окно контекста впишите под свою.' : '') +
    (M.active.some(c => c.peak > B.win) ? ' <b class="warn">Пик контекста у части диалогов выше окна ' + fmtN(B.win) + ' — окно модели, видимо, больше.</b>' : '') +
    '</p>' +

    '<div class="bcontrols">' +
      num('bwin', B.win, 'окно контекста модели, ток.') +
      num('breserve', B.reserve, 'запас на ответ и рассуждения, ток.') +
      num('bcalls', B.calls, 'вызовов MCP на диалог агента', 'наблюдаемый p90: ' + (M.callsP90 || '—')) +
      num('bthr', thr, 'порог на один ответ, ток.') +
      '<label class="bin"><span>агент</span><select id="bagent"><option value="">все агенты</option>' +
        agentsAll.map(a => '<option' + (a === B.agent ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></label>' +
    '</div>' +

    '<div class="stats bstats">' +
      card(fmtN(M.ruleMean), 'порог по методике встречи', 'контекст ÷ вызовов, среднее по ' + M.active.filter(c => c.peak).length +
        ' диалогам · медиана ' + fmtN(M.ruleMedian), 'jump',
        'Пиковый prompt_tokens диалога агента, делённый на число вызванных им MCP-инструментов, усреднённый по всем диалогам. Нажмите, чтобы взять как порог',
        ' data-thr="' + Math.round(M.ruleMean || 0) + '"') +
      card(fmtN(thrWin), 'порог по бюджету окна', '(' + fmtN(B.win) + ' − ' + fmtN(M.baseP90) + ' − ' + fmtN(B.reserve) + ') ÷ ' + B.calls, 'jump',
        'Окно модели минус то, что агент несёт до первого инструмента (системный промпт, описания тулов, история; p90 по диалогам), минус запас на ответ, делённое на число вызовов. Нажмите, чтобы взять как порог',
        ' data-thr="' + Math.round(thrWin) + '"') +
      card(overCalls + ' из ' + withEst, 'ответов выше порога', withEst ? Math.round(overCalls / withEst * 100) + '% вызовов' : '', overCalls ? 'hl' : '') +
      card(overTools.length + ' из ' + tools.length, 'инструментов выше порога', 'по максимальному ответу', overTools.length ? 'hl' : '') +
      card(measured + ' / ' + (withEst - measured), 'замер / оценка', (calls.length - withEst) ? 'без данных: ' + (calls.length - withEst) : 'у всех вызовов есть цифра') +
    '</div>' +

    '<div class="bhead"><h3>Инструменты</h3><span class="hint">отсортировано по самому большому ответу · нажмите на максимум, чтобы открыть этот вызов</span>' +
      '<button class="foldbtn" id="bcsv" type="button">CSV</button></div>' +
    '<div class="btable-wrap"><table class="btable"><thead><tr>' +
      '<th>инструмент</th><th>вызовов</th><th>ток. в среднем</th><th>p95</th><th>максимум</th><th>выше порога</th><th>байт макс.</th><th>как получено</th><th>агенты</th>' +
    '</tr></thead><tbody>' +
    tools.map(t => '<tr class="' + level(t.max) + '">' +
      '<td class="bname">' + esc(t.tool) + '</td>' +
      '<td>' + t.n + '</td><td>' + fmtN(t.avg) + '</td><td>' + fmtN(t.p95) + '</td>' +
      '<td>' + (t.top ? '<button class="blink" data-t="' + t.top.trace + '" data-ts="' + t.top.ts + '">' + fmtN(t.max) + '</button>' : '—') + '</td>' +
      '<td>' + (t.vals.length ? (t.over ? '<b>' + t.over + '</b>' : '0') + ' <span class="muted">(' + Math.round(t.over / t.vals.length * 100) + '%)</span>' : '—') + '</td>' +
      '<td>' + (t.bytes.length ? fmtN(Math.max.apply(null, t.bytes)) : '—') + '</td>' +
      '<td class="muted bwrap">' + (t.measured ? 'замер ' + t.measured : '') + (t.measured && t.vals.length > t.measured ? ' · ' : '') +
        (t.vals.length > t.measured ? 'оценка ' + (t.vals.length - t.measured) : '') + (t.n > t.vals.length ? (t.vals.length ? ' · ' : '') + 'нет данных ' + (t.n - t.vals.length) : '') + '</td>' +
      '<td class="muted bwrap">' + esc(Array.from(t.agents).join(', ')) + '</td></tr>').join('') +
    '</tbody></table></div>' +

    '<div class="bhead"><h3>Агенты</h3><span class="hint">один диалог — один агент в одном traceId; контекст — prompt_tokens</span></div>' +
    '<div class="btable-wrap"><table class="btable"><thead><tr>' +
      '<th>агент</th><th>диалогов</th><th>вызовов MCP на диалог</th><th>контекст до инструментов</th><th>пик контекста ср. / макс.</th>' +
      '<th>от MCP в пике</th><th>контекст ÷ вызовов</th><th>MCP подкл. / вызв.</th>' +
    '</tr></thead><tbody>' +
    agents.map(a => '<tr class="' + (a.peakMax == null ? '' : a.peakMax > B.win ? 'over' : a.peakMax > B.win * 0.75 ? 'near' : 'ok') + '"' +
      ' title="красная метка — пик контекста выше окна модели, жёлтая — выше 75% окна">' +
      '<td class="bname">' + esc(a.name) + '</td><td>' + a.convs + '</td>' +
      '<td>' + (a.callsAvg != null ? a.callsAvg.toFixed(1).replace('.', ',') : '—') + ' <span class="muted">/ макс. ' + a.callsMax + '</span></td>' +
      '<td>' + fmtN(a.base) + '</td>' +
      '<td>' + fmtN(a.peakAvg) + ' <span class="muted">/ ' + fmtN(a.peakMax) + '</span></td>' +
      '<td>' + (a.share != null ? Math.round(a.share * 100) + '%' : '—') + ' <span class="muted">(' + fmtN(a.mcpAvg) + ')</span></td>' +
      '<td>' + fmtN(a.rule) + '</td>' +
      '<td' + (a.connectedList.length ? ' title="' + esc(a.connectedList.join(', ')) + '"' : '') + '>' +
        (a.connected != null ? a.connected : '—') + ' / ' + a.used + '</td></tr>').join('') +
    '</tbody></table></div>' +

    '<details class="bhow"><summary>Как считается</summary><ul>' +
      '<li><b>Токены ответа.</b> Когда агент вызывает инструменты, следующий ход той же модели приходит с prompt_tokens = предыдущий prompt + предыдущий completion + то, что вернули инструменты. Разница и есть цена ответа в токенах. Несколько вызовов в одной пачке делятся пропорционально байтам. Если разница не вяжется с размером ответа (меньше 1,2 или больше 8 байт на токен) — в контекст попало что-то ещё, такой замер отбрасывается.</li>' +
      '<li><b>Оценка по байтам.</b> Где замер невозможен (после вызова модель не логировала токены, или это последний вызов), токены = content-length ответа ÷ байт на токен, откалиброванный на замерах этой выгрузки.</li>' +
      '<li><b>Порог по методике встречи.</b> Пиковый контекст диалога ÷ число вызванных в нём инструментов, среднее по диалогам. Это «средняя доля контекста на один инструмент» — цифра, за которую лучше не вылезать.</li>' +
      '<li><b>Порог по бюджету окна.</b> (окно − контекст до первого инструмента (p90) − запас) ÷ вызовов на диалог. Это верхний предел: если каждый ответ его не превышает, агент гарантированно укладывается в окно даже при p90 по числу вызовов.</li>' +
      '<li>По умолчанию порог — меньшее из двух. Любое поле можно поменять, таблицы пересчитаются.</li>' +
    '</ul></details>';
  $('#bbody').innerHTML = html;

  const bind = (id, key) => { const el = $('#' + id); if(el) el.onchange = () => { B[key] = Math.max(0, +el.value || 0); if(key !== 'thr') B.thr = Math.round(Math.max(0, B.win - (M.baseP90 || 0) - B.reserve) / Math.max(B.calls, 1)); drawBudget(); }; };
  bind('bwin', 'win'); bind('breserve', 'reserve'); bind('bcalls', 'calls'); bind('bthr', 'thr');
  $('#bagent').onchange = e => { B.agent = e.target.value; drawBudget(); };
  document.querySelectorAll('.bstats .stat.jump').forEach(c => c.onclick = () => { B.thr = +c.dataset.thr; drawBudget(); });
  document.querySelectorAll('#bbody .blink').forEach(b => b.onclick = () => jumpTo(b.dataset.t, 'mcp', b.dataset.ts));
  $('#bcsv').onclick = () => {
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['инструмент', 'вызовов', 'токенов в среднем', 'p95', 'максимум', 'выше порога', 'порог', 'байт макс.', 'замеров', 'оценок', 'агенты', 'traceId максимума']]
      .concat(tools.map(t => [t.tool, t.n, Math.round(t.avg || 0), Math.round(t.p95 || 0), t.max, t.over, thr,
        t.bytes.length ? Math.max.apply(null, t.bytes) : '', t.measured, t.vals.length - t.measured,
        Array.from(t.agents).join(', '), t.top ? STATE.traces[t.top.trace].traceId : '']));
    downloadBlob('﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), 'text/csv;charset=utf-8', 'mcp_budget_' + tstamp() + '.csv');
  };
}
