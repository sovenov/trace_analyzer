/* Вкладки трейсов и сам отчёт: шапка, выводы, статистика, хроника, ответ.
   Две группировки: по traceId (разбор одного запроса) и по sessionId (переписка). */

/* the answer the client got: text parts as text, widgets (cards, charts, buttons) as
   labelled folds that open to their JSON */
function answerBodyHtml(parts, ans){
  if(!parts || !parts.length) return '<div class="quote full answer">' + esc(ans) + '</div>';
  return '<div class="quote full answer">' + parts.map(p => {
    if(p.kind === 'text') return '<div class="abody">' + esc(p.text) + '</div>';
    const label = p.kind === 'asset' ? 'карточка' : p.kind === 'chart' ? 'график' : 'кнопки';
    return '<details class="synth ' + p.kind + '"><summary>' +
      '<span class="slab">' + label + '</span>' +
      '<span class="stxt">' + esc(p.text) + '</span></summary>' +
      '<pre class="json">' + esc(pretty(JSON.stringify(p.node))) + '</pre></details>';
  }).join('') + '</div>';
}

/* ====================== grouping by sessionId ======================
   One dialog = one sessionId of the channel. Every client message of every trace
   (a trace can carry several) goes into its dialog, with the answer that trace gave to
   it. A message resent under the same messageId (retries) stays one message, listing
   every traceId that handled it. */
function buildSessions(){
  if(STATE._sessFor === STATE.traces) return STATE._sess;
  const map = new Map();
  STATE.traces.forEach((t, ti) => {
    const qs = (t.userQs && t.userQs.length) ? t.userQs : (t.userQ ? [t.userQ] : []);
    const ctx = t.meta.ctx || {};
    const answers = t.events.filter(e => e.kind === 'answer');
    qs.forEach((q, qi) => {
      if(!q || !q.text || !String(q.text).trim()) return;
      const id = q.session || (t.userQ && t.userQ.session) || t.meta.sessionGuess || '';
      const key = id || '__none__';
      let s = map.get(key);
      if(!s){ s = {key: key, id: id, items: [], traces: [], ctx: {}}; map.set(key, s); }
      Object.keys(ctx).forEach(k => { if(s.ctx[k] == null) s.ctx[k] = ctx[k]; });
      if(!s.cus) s.cus = q.cus || ctx.cus || '';
      if(!s.channel) s.channel = [ctx.sourceChannel || q.channel, ctx.channelApp].filter(Boolean)
                                   .filter((v, i, a) => a.indexOf(v) === i).join(' · ');
      const seg = t.segments && t.segments[qi];
      const next = qs[qi + 1];
      const ans = answers.filter(e => e.ts >= q.ts && (!next || e.ts < next.ts)).pop();
      const item = {ts: q.ts != null ? q.ts : (t.meta.from ? +t.meta.from : 0), ti: ti, qi: qi, multi: qs.length > 1,
                    text: String(q.text).trim(), messageId: q.messageId || '',
                    cus: String(q.cus || ctx.cus || '').trim(),
                    answer: seg ? seg.finalAnswer : t.finalAnswer, parts: seg ? seg.answerParts : t.answerParts,
                    delivered: seg ? seg.delivered : t.delivered, ansTs: ans ? ans.ts : null};
      const dup = item.messageId && s.items.find(x => x.messageId === item.messageId && x.text === item.text);
      if(dup){
        dup.also = dup.also || [];
        dup.also.push(item);
        // the copy that got an answer out is the one to show
        if(!dup.answer && item.answer){ ['ti','qi','multi','answer','parts','delivered','ansTs'].forEach(k => { dup[k] = item[k]; }); }
      } else s.items.push(item);
      if(s.traces.indexOf(ti) < 0) s.traces.push(ti);
    });
  });
  const out = Array.from(map.values());
  out.forEach(s => {
    s.items.sort((a, b) => a.ts - b.ts);
    s.from = s.items.length ? s.items[0].ts : 0;
    s.to = s.items.reduce((m, x) => Math.max(m, x.ansTs || x.ts), s.from);
    s.messages = s.items.length;
    s.fio = [s.ctx.lastName, s.ctx.firstName, s.ctx.middleName].filter(Boolean).join(' ').trim() || String(s.ctx.nickname || '').trim();
  });
  out.sort((a, b) => (a.key === '__none__') - (b.key === '__none__') || a.from - b.from);
  STATE._sessFor = STATE.traces; STATE._sess = out;
  return out;
}

function renderSession(){
  const host = $('#report');
  const sessions = buildSessions();
  const s = sessions.find(x => x.key === STATE.session) || sessions[0];
  if(!s){ host.innerHTML = '<div class="empty">Сообщений клиента в загруженных логах не найдено.</div>'; return; }
  STATE.session = s.key;
  const dt = ms => ms ? new Date(ms).toLocaleString('ru-RU') : '—';
  const cells = [
    ['sessionId', s.id || 'не найден'],
    ['ФИО', s.fio || '—'],
    ['cus', s.cus || '—'],
    ['канал', s.channel || '—'],
    ['сообщений', String(s.messages)],
    ['traceId', String(s.traces.length)],
    ['начало', dt(s.from)],
    ['последний ответ', dt(s.to)]
  ].map(p => '<div class="idcell"><dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd></div>').join('');
  const traceBtn = it => {
    const t = STATE.traces[it.ti];
    return '<button type="button" class="mtrace" data-ti="' + it.ti + '"' + (it.multi ? ' data-seg="' + it.qi + '"' : '') +
      ' title="Открыть разбор этого traceId">traceId <span>' + esc(t.traceId) + '</span></button>';
  };
  const msgs = s.items.map(it => {
    const others = (it.also || []).map(a => traceBtn(a)).join('');
    const client =
      '<div class="msg client"><div class="mhead"><span class="mwho"' + ((it.cus || s.cus) ? ' title="CUS клиента"' : '') + '>' +
        esc(it.cus || s.cus || 'Клиент') + '</span>' +
        '<span class="mtime">' + esc(fmtStamp(new Date(it.ts))) + '</span>' + traceBtn(it) + '</div>' +
        '<div class="mtext">' + esc(it.text) + '</div>' +
        (others ? '<div class="malso">повторно отправлено — ещё ' + (it.also.length) + ' traceId: ' + others + '</div>' : '') +
      '</div>';
    const agent = it.answer
      ? '<div class="msg agent"><div class="mhead"><span class="mwho">Агент</span>' +
          (it.ansTs ? '<span class="mtime">' + esc(fmtStamp(new Date(it.ansTs))) + '</span>' : '') +
          (it.ansTs ? '<span class="mdelay">через ' + esc(fmtMs(it.ansTs - it.ts)) + '</span>' : '') +
          traceBtn(it) +
          (it.delivered ? '' : '<span class="mflag" title="в логах нет подтверждения, что ответ ушёл клиенту">доставка не подтверждена</span>') +
        '</div>' + answerBodyHtml(it.parts, it.answer) + '</div>'
      : '<div class="msg agent none"><div class="mhead"><span class="mwho">Агент</span>' + traceBtn(it) + '</div>' +
          '<div class="mnone">ответ в логах не найден — откройте traceId, чтобы увидеть, где оборвалось</div></div>';
    return client + agent;
  }).join('');
  host.innerHTML =
    '<div class="dossier"><div class="eyebrow">Диалог — сообщения клиента и ответы агента</div>' +
      '<div class="idbar">' + cells + '</div></div>' +
    '<div class="section"><div class="section-head"><h2>Переписка</h2>' +
      '<span class="hint">по времени; traceId у сообщения открывает его разбор</span></div>' +
      '<div class="chat">' + msgs + '</div></div>';
  host.querySelectorAll('.mtrace').forEach(b => b.onclick = () => openTrace(+b.dataset.ti, b.dataset.seg));
}

/* from the dialog to the analysis of one trace (and its question, if it has several) */
function openTrace(ti, seg){
  STATE.group = 'trace';
  STATE.active = ti;
  renderTabs(); renderReport();
  if(seg != null){
    const tab = document.querySelector('#segtabs .tab[data-seg="' + seg + '"]');
    if(tab) tab.click();
  }
  const d = document.querySelector('#report .dossier');
  if(d) d.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function renderTabs(){
  renderBudget();
  const tabs = $('#tabs');
  if(!STATE.traces.length){ tabs.classList.add('hidden'); tabs.innerHTML = ''; return; }
  tabs.classList.remove('hidden');
  const traceIds = uniqueTraceIds(STATE.traces);
  const sessions = buildSessions();
  const bySession = STATE.group === 'session';
  const head = '<div class="tabs-head">' +
    '<div class="groupby" role="tablist" aria-label="Группировка">' +
      '<button type="button" role="tab" data-g="trace" aria-selected="' + !bySession + '">по traceId<span class="count">' + STATE.traces.length + '</span></button>' +
      '<button type="button" role="tab" data-g="session" aria-selected="' + bySession + '"' + (sessions.length ? '' : ' disabled title="ни в одном трейсе не найдено сообщение клиента"') +
        '>по sessionId<span class="count">' + sessions.length + '</span></button>' +
    '</div>' +
    (bySession ? '' :
    '<button class="traceids-dl" id="traceidsdl" type="button"' + (traceIds.length ? '' : ' disabled') +
    ' title="Выгрузить уникальные traceId (' + traceIds.length + ')"' +
    ' aria-label="Выгрузить уникальные traceId">' + DL_ICON +
    '<span>Выгрузить уникальные traceId</span><span class="count">' + traceIds.length + '</span></button>') + '</div>';
  const wireHead = () => tabs.querySelectorAll('.groupby button').forEach(b => b.onclick = () => {
    if(b.disabled || STATE.group === b.dataset.g || (!STATE.group && b.dataset.g === 'trace')) return;
    STATE.group = b.dataset.g;
    if(STATE.group === 'session'){
      // open the dialog the trace on screen belongs to
      const s = sessions.find(x => x.items.some(it => it.ti === STATE.active)) || sessions[0];
      STATE.session = s ? s.key : null;
    }
    renderTabs(); renderReport();
  });
  if(bySession){
    tabs.innerHTML = head + sessions.map(s =>
      '<div class="tabrow' + (s.key === STATE.session ? ' on' : '') + '">' +
      '<button class="tab stab" role="tab" data-s="' + esc(s.key) + '" aria-selected="' + (s.key === STATE.session) + '">' +
        '<span class="ttime">' + esc(fmtStamp(new Date(s.from))) + '</span>' +
        '<span class="tmid">' +
          '<span class="tid">' + esc(s.id || 'sessionId не найден') + '</span>' +
          (s.channel ? '<span class="tcus">- ' + esc(s.channel) + '</span>' : '') +
          (s.cus ? '<span class="tcus">- ' + esc(s.cus) + '</span>' : '') +
          (s.fio ? '<span class="tfio">- ' + esc(s.fio) + '</span>' : '') +
        '</span>' +
        '<span class="tnum">' + s.messages + ' сообщ. · ' + s.traces.length + ' traceId</span>' +
      '</button></div>').join('');
    wireHead();
    tabs.querySelectorAll('.stab').forEach(b => b.onclick = () => {
      STATE.session = b.dataset.s; renderTabs(); renderReport();
    });
    return;
  }
  tabs.innerHTML = head +
    STATE.traces.map((t, i) => {
    const l = tabLabel(t);
      const full = [l.id, l.repeat ? 'повтор ' + l.repeat : '', l.q, l.cus, l.fio]
      .filter(Boolean).join(' - ');
    // the row is a pair of siblings, not nested buttons: the tab selects the trace,
    // the trailing one downloads it
    return '<div class="tabrow' + (i === STATE.active ? ' on' : '') + '">' +
    '<button class="tab" role="tab" data-i="' + i + '" title="' + esc(full) + '" aria-selected="' + (i === STATE.active) + '">' +
    '<span class="ttime">' + esc(fmtStamp(t.meta.from)) + '</span>' +
    '<span class="tmid">' +
      '<span class="tid">' + esc(l.id) + '</span>' +
      (l.repeat ? '<span class="trep" title="одно и то же обращение, отправленное повторно">' +
                  '↻ ' + esc(l.repeat) + '</span>' : '') +
      (l.q ? '<span class="tq">- ' + esc(l.q) + '</span>' : '') +
      (l.cus ? '<span class="tcus">- ' + esc(l.cus) + '</span>' : '') +
      (l.fio ? '<span class="tfio">- ' + esc(l.fio) + '</span>' : '') +
    '</span>' +
    '<span class="tnum">' +
    ((t.linked || []).length ? '<span class="tlinked" title="' + esc('Собран из traceId:\n' + [t.traceId].concat(t.linked.map(l => l.traceId + ' — ' + l.what)).join('\n')) + '">+' +
      t.linked.length + ' traceId</span>' : '') +
    t.stats.records + ' зап.</span></button>' +
    '<button class="tabdl" data-i="' + i + '" data-what="html" title="Сохранить HTML-отчёт только по этому traceId' +
      ((t.linked || []).length ? ' (вместе со связанными)' : '') + '" aria-label="Сохранить HTML-отчёт по этому traceId">' +
      DL_ICON + '<span class="tabdl-l">HTML</span></button>' +
    '<button class="tabdl" data-i="' + i + '" data-what="json" title="Выгрузить логи этого traceId в JSON (' +
      t.stats.records + ')" aria-label="Выгрузить логи этого traceId в JSON">' + DL_ICON + '<span class="tabdl-l">JSON</span></button>' +
    '</div>';
  }).join('');
  wireHead();
  tabs.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    STATE.active = +b.dataset.i; renderTabs(); renderReport();
  });
  tabs.querySelectorAll('.tabdl').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if(b.dataset.what === 'html') saveReport(+b.dataset.i, b);
    else exportTrace(+b.dataset.i);
  });
  const traceIdsDl = tabs.querySelector('#traceidsdl');
  if(traceIdsDl) traceIdsDl.onclick = exportUniqueTraceIds;
}

/* start of a trace, for the chronologically ordered tab strip. Dumps routinely span
   several days, so the date is part of it. */
function fmtStamp(d){
  if(!d) return '—';
  const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtRel(s){
  if(s < 10) return '+' + s.toFixed(2) + 'с';
  return '+' + s.toFixed(1) + 'с';
}
function fmtMs(ms){
  if(ms == null) return '';
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' с' : Math.round(ms) + ' мс';
}
/* wall-clock time of an event: HH:MM:SS.mmm */
function fmtAbs(ms){
  if(ms == null || !isFinite(ms)) return '';
  const d = new Date(ms), p = (n, w) => String(n).padStart(w || 2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}
/* start/end of a step: startTs when the span is known, otherwise derived from duration */
function evSpan(e){
  if(e.startTs != null) return {start: e.startTs, end: e.ts};
  if(e.ms != null) return {start: e.ts - e.ms, end: e.ts};
  return {start: e.ts, end: null};
}
/* Lay out something that looks like JSON but does not parse — Kibana cuts long records
   mid-object, masking replaces numbers with *MASKED_X*, some payloads carry a trailing
   tail of their own. Nothing here is parsed: the text is walked character by character,
   strings are passed through untouched, and the structural characters get the line
   breaks and indentation. Whatever is left when the text ends simply ends. */
function prettyLoose(src){
  const s = String(src);
  let out = '', ind = 0, inStr = false, esc = false, cut = false;
  const nl = n => '\n' + '  '.repeat(Math.max(0, n));
  const nextNonWs = i => { while(i < s.length && /\s/.test(s[i])) i++; return i; };
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(inStr){
      out += c;
      if(esc) esc = false;
      else if(c === '\\') esc = true;
      else if(c === '"') inStr = false;
      continue;
    }
    if(c === '"'){ inStr = true; out += c; continue; }
    if(c === '{' || c === '['){
      const j = nextNonWs(i + 1), close = c === '{' ? '}' : ']';
      if(s[j] === close){ out += c + close; i = j; continue; }   // keep {} and [] on one line
      out += c; ind++; out += nl(ind); i = j - 1; continue;
    }
    if(c === '}' || c === ']'){
      ind--; out = out.replace(/[ \n]+$/, '');
      out += nl(ind) + c; continue;
    }
    if(c === ','){ out += c; out += nl(ind); i = nextNonWs(i + 1) - 1; continue; }
    if(c === ':'){ out += ': '; i = nextNonWs(i + 1) - 1; continue; }
    if(/\s/.test(c)) continue;      // whitespace outside strings carries nothing
    out += c;
  }
  if(inStr || ind > 0) cut = true;   // ended inside a string or with brackets still open
  return {text: out, cut: cut};
}
/* JSON.stringify when it parses; otherwise, for anything that starts like JSON, the
   loose layout above; plain text is returned as it is. */
function prettyInfo(txt){
  const o = safeJson(txt);
  if(o){ try { return {text: JSON.stringify(o, null, 2), loose: false, cut: false}; } catch(e){} }
  const raw = String(txt == null ? '' : txt);
  const t = raw.trim();
  if(t.charAt(0) === '{' || t.charAt(0) === '['){
    const r = prettyLoose(t);
    return {text: r.text, loose: true, cut: r.cut};
  }
  return {text: raw, loose: false, cut: false};
}
function pretty(txt){ return prettyInfo(txt).text; }
function payloadBlock(label, txt, cls){
  if(!txt) return '';
  const r = prettyInfo(txt);
  const mark = r.loose ? '<span class="paymark" title="' +
    (r.cut ? 'JSON не закрыт — запись обрезана в выгрузке. Показан как есть, с отступами'
           : 'JSON не разбирается (маскирование или посторонний текст). Показан как есть, с отступами') +
    '">' + (r.cut ? 'обрезан' : 'не разбирается') + '</span>' : '';
  return '<details class="pay' + (cls ? ' ' + cls : '') + '"><summary>' + esc(label) + mark + '</summary>' +
         '<pre class="json' + (r.loose ? ' loose' : '') + '">' + esc(r.text) + '</pre></details>';
}

function renderReport(){
  const host = $('#report');
  if(!STATE.traces.length){ host.innerHTML = ''; return; }
  if(STATE.group === 'session') return renderSession();
  const tr = STATE.traces[STATE.active];
  const m = tr.meta, ctx = m.ctx || {};

  // the client profile carries the name in pieces, and not every dump has all three
  const fio = [ctx.lastName, ctx.firstName, ctx.middleName].filter(Boolean).join(' ').trim()
              || (ctx.nickname || '').trim();
  const idcells = [
    ['traceId', tr.traceId],
    ['messageId', m.messageId || '—'],
    ['ФИО', fio || '—'],
    ['cus', (tr.userQ && tr.userQ.cus) || ctx.cus || '—'],
    ['sessionId', (tr.userQ && tr.userQ.session) || m.sessionGuess || '—'],
    // channel_id (UAI_CHAT, AIAD_CHAT…) and the client app it came from (AM, MT, NEW_CLICK…)
    ['канал', [ctx.sourceChannel || (tr.userQ && tr.userQ.channel), ctx.channelApp]
                .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ') || '—'],
    ['system_id', (m.systemIds || []).slice(0, 3).join(' · ') || '—'],
    // selectedSkill / selectedChip exist only when the client started from a skill or a chip;
    // a question typed by hand carries neither
    ['скилл клиента', [ctx.selectedSkill ? 'скилл ' + ctx.selectedSkill : '', ctx.selectedChip ? 'чип ' + ctx.selectedChip : '']
                        .filter(Boolean).join(' · ') || (ctx.profileSeen ? 'не выбран' : '—')],
    ['устройство', ctx.deviceModel || (tr.userQ && tr.userQ.os) || '—'],
    ['сегмент', ctx.segment || (tr.userQ && tr.userQ.segment) || '—'],
    ['начало', m.from ? m.from.toLocaleString('ru-RU') : '—'],
    ['длительность', (m.durationMs / 1000).toFixed(1) + ' с']
  ].concat((tr.linked || []).length ? [['связанные traceId', tr.linked.map(l => l.traceId + ' (' + l.what + ')').join('\n')]] : [])
  .map(p => '<div class="idcell"><dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd></div>').join('');

  // verdict / stats / answer are rendered from a source so they can be swapped per request
  const verdictHtml = f =>
    '<div class="verdict"><div class="verdict-head">Что произошло</div>' +
    f.map(x => '<div class="finding ' + x.level + '"><span class="dot"></span><div>' + x.text + '</div></div>').join('') +
    '</div>';
  const fmtN = n => Math.round(n).toLocaleString('ru-RU');
  const statCard = s => '<div class="stat ' + s[2] + '"' + (s[4] ? ' title="' + esc(s[4]) + '"' : '') + (s[5] ? ' ' + s[5] : '') + '>' +
    '<div class="v">' + esc(s[1]) + '</div><div class="k">' + esc(s[0]) + '</div>' +
    [].concat(s[3] || []).map(x => typeof x === 'string'
      ? '<div class="sub">' + esc(x) + '</div>'
      : '<div class="sub ' + x.cls + '">' + esc(x.text) + '</div>').join('') + '</div>';
  const tokCards = st => st.tokTurns ? [
    ['токенов всего', fmtN(st.tokens), '', 'вход ' + fmtN(st.tokIn) + ' · выход ' + fmtN(st.tokOut),
     'Сумма total_tokens по всем ходам LLM этого traceId'],
    ['токенов на ход LLM', fmtN(st.tokens / st.tokTurns), '', 'среднее по ' + st.tokTurns + ' ход.',
     'Сумма токенов, делённая на число ходов LLM с известными токенами'],
    ['самый большой ход LLM', fmtN(st.tokMax.tokens), 'jump',
     [st.tokMax.title || 'ход модели',
      fmtRel(st.tokMax.rel || 0) + ' · вход ' + fmtN(st.tokMax.tokIn) + ' · выход ' + fmtN(st.tokMax.tokOut)],
     'Самый дорогой по токенам вызов модели в этом traceId' + (st.tokMax.model ? ' (' + st.tokMax.model + ')' : '') +
       '. Нажмите, чтобы перейти к нему в хронике', 'data-jump-ts="' + st.tokMax.ts + '"']
  ] : [
    ['токенов всего', '—', '', 'в логах нет usage'],
    ['токенов на ход LLM', '—', '', ''],
    ['самый большой ход LLM', '—', '', '']
  ];
  /* bytes as the eye reads them; exact count goes to the tooltip */
  const fmtB = b => b < 1024 ? fmtN(b) + ' Б' :
    b < 1048576 ? (b / 1024).toLocaleString('ru-RU', {maximumFractionDigits: 1}) + ' КБ' :
    (b / 1048576).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' МБ';
  const t0 = tr.records[0] ? tr.records[0].ts : 0;
  /* one labelled row of size cards: "MCP" / "LLM" on the left, cards in 4 columns */
  const sizeRow = (label, cards, empty) => '<div class="szlabel">' + esc(label) + '</div>' +
    (cards ? cards.map(statCard).join('') + '<div class="szpad"></div>'.repeat(Math.max(0, 4 - cards.length))
           : '<div class="szempty">' + esc(empty) + '</div>');
  const sizeGroup = (cap, rows, all) => '<div class="tokgroup szgroup' + (all ? ' all' : '') + '">' +
    '<div class="stats-cap">' + esc(cap) + '</div><div class="szgrid">' + rows.join('') + '</div></div>';
  const traceSizeCards = (z, what, kind) => z.n ? [
    ['всего', fmtB(z.bytes), '', 'в ' + fmtN(z.n) + ' ответ.', fmtN(z.bytes) + ' байт'],
    ['на ответ', fmtB(z.bytes / z.n), '', 'среднее по ' + fmtN(z.n) + ' ответ.', fmtN(Math.round(z.bytes / z.n)) + ' байт'],
    ['самый большой ответ', fmtB(z.max.bytes), 'jump',
     [z.max.tool || what, fmtRel((z.max.ts - t0) / 1000)],
     fmtN(z.max.bytes) + ' байт. Нажмите, чтобы перейти к нему в хронике',
     'data-jump-kind="' + kind + '" data-jump-ts="' + z.max.ts + '"']
  ] : null;
  const sizeHtml = (st, label) => {
    const z = st.sizes || {mcp: {n: 0}, llm: {n: 0}};
    return sizeGroup('Content-length ответов · ' + (label || 'этот traceId'), [
      sizeRow('MCP', traceSizeCards(z.mcp, 'ответ инструмента', 'mcp'), 'вызовов инструментов с размером ответа нет'),
      sizeRow('LLM', traceSizeCards(z.llm, 'ответ модели', 'llm'), 'размер ответов модели в этих логах не пишется')
    ]);
  };
  function allSizeOf(){
    const pick = k => {
      let bytes = 0, n = 0, traces = 0, top = null, topTrace = -1;
      STATE.traces.forEach((t, i) => {
        const z = t.stats && t.stats.sizes && t.stats.sizes[k];
        if(!z || !z.n) return;
        bytes += z.bytes; n += z.n; traces++;
        if(!top || z.max.bytes > top.bytes){ top = z.max; topTrace = i; }
      });
      if(!n) return null;
      const id = STATE.traces[topTrace].traceId;
      return [
        ['всего', fmtB(bytes), '', 'в ' + fmtN(n) + ' ответ.', fmtN(bytes) + ' байт по всем traceId'],
        ['в среднем на traceId', fmtB(bytes / traces), '', 'по суммам, ÷ ' + fmtN(traces) + ' traceId',
         'Среднее по суммам (traceId без таких ответов не учитываются)'],
        ['в среднем на ответ', fmtB(bytes / n), '', 'по ' + fmtN(n) + ' ответ.', fmtN(Math.round(bytes / n)) + ' байт'],
        ['самый большой ответ', fmtB(top.bytes), 'jump',
         [{text: id, cls: 'mono'}].concat(top.tool ? [top.tool] : []),
         fmtN(top.bytes) + ' байт, traceId ' + id + '. Нажмите, чтобы открыть этот трейс',
         'data-jump-trace="' + topTrace + '" data-jump-kind="' + k + '" data-jump-ts="' + top.ts + '"']
      ];
    };
    return sizeGroup('Content-length ответов · все traceId · ' + fmtN(STATE.traces.length), [
      sizeRow('MCP', pick('mcp'), 'вызовов инструментов с размером ответа нет'),
      sizeRow('LLM', pick('llm'), 'размер ответов модели в этих логах не пишется')
    ], true);
  }
  const tokGroup = (cap, cards) => '<div class="tokgroup"><div class="stats-cap">' + esc(cap) + '</div>' +
    '<div class="stats">' + cards.map(statCard).join('') + '</div></div>';
  const statsHtml = (st, label) => '<div class="stats">' + [
    ['зап. в трейсе', st.records, ''],
    ['ходов LLM', st.llm, ''],
    ['саб-агентов', st.subs, ''],
    ['вызовов MCP', st.mcp, st.mcp === 0 ? 'hl' : ''],
    ['ходов в core', st.core || 0, ''],
    ['чанков RAG', st.rag, ''],
    ['секунд', st.seconds.toFixed(1), '']
  ].map(statCard).join('') + '</div>' +
    '<div class="tokrow">' + tokGroup('Токены · ' + (label || 'этот traceId'), tokCards(st)) + allTokHtml + '</div>' +
    '<div class="tokrow">' + sizeHtml(st, label) + allSizeHtml + '</div>';

  // the same token counters over every traceId loaded — a yardstick for this one
  function allTokOf(){
    const all = STATE.traces.map(t => t.stats || {});
    const withTok = all.filter(st => st.tokTurns > 0);
    const sum = withTok.reduce((a, st) => a + st.tokens, 0);
    const turns = withTok.reduce((a, st) => a + st.tokTurns, 0);
    const cap = 'Все traceId · ' + fmtN(all.length) +
      (withTok.length !== all.length ? ' (с токенами — ' + fmtN(withTok.length) + ')' : '');
    // the single most expensive model turn across every loaded traceId, and whose it was
    let top = null, topTrace = -1;
    STATE.traces.forEach((t, i) => {
      const mx = t.stats && t.stats.tokMax;
      if(mx && (!top || mx.tokens > top.tokens)){ top = mx; topTrace = i; }
    });
    const topId = topTrace >= 0 ? STATE.traces[topTrace].traceId : '';
    // distinct clients over every traceId: each request's cus plus the profile's one
    const cusSet = new Set(), cusTraces = new Set();
    STATE.traces.forEach((t, i) => {
      [t.userQ].concat(t.userQs || []).map(q => q && q.cus)
        .concat([t.meta && t.meta.ctx && t.meta.ctx.cus])
        .forEach(c => {
          c = String(c == null ? '' : c).trim();
          if(c && !/MASKED/.test(c)){ cusSet.add(c); cusTraces.add(i); }
        });
    });
    const cusCard = ['уникальных CUS', cusSet.size ? fmtN(cusSet.size) : '—', '',
      cusSet.size ? 'в ' + fmtN(cusTraces.size) + ' из ' + fmtN(STATE.traces.length) + ' traceId' : 'cus в логах не найден',
      'Сколько разных клиентов (cus) встречается во всех загруженных traceId'];
    const cards = withTok.length ? [
      ['токенов всего', fmtN(sum), '', 'вход ' + fmtN(withTok.reduce((a, st) => a + st.tokIn, 0)) +
        ' · выход ' + fmtN(withTok.reduce((a, st) => a + st.tokOut, 0)),
       'Сумма токенов по всем traceId'],
      ['в среднем на traceId', fmtN(sum / withTok.length), '', 'по суммам, ÷ ' + withTok.length + ' traceId',
       'Среднее по суммам: сколько токенов в среднем уходит на один traceId (traceId без ходов LLM не учитываются)'],
      ['в среднем на ход LLM', fmtN(sum / turns), '', 'по ' + turns + ' ход.',
       'Сумма токенов по всем traceId, делённая на общее число ходов LLM'],
      ['самый большой ход LLM', fmtN(top.tokens), 'jump',
       [{text: topId, cls: 'mono'}, top.title || 'ход модели',
        'вход ' + fmtN(top.tokIn) + ' · выход ' + fmtN(top.tokOut)],
       'Самый дорогой по токенам вызов модели среди всех traceId: ' + topId +
         '. Нажмите, чтобы открыть этот трейс',
       'data-jump-trace="' + topTrace + '" data-jump-ts="' + top.ts + '"'],
      cusCard
    ] : [['токенов всего', '—', '', 'в логах нет usage'], cusCard];
    return tokGroup(cap, cards).replace('class="tokgroup"', 'class="tokgroup all"');
  }
  /* The answer as the user saw it, except for the pieces that were not prose: a chip row
     and an instrument card are things we only describe. Mark those so nobody reads
     "[карточка] …" as something the assistant actually wrote, and let them open to the
     JSON node behind them. */
  const answerBody = answerBodyHtml;
  const answerHtml = (ans, parts) => ans ?
    '<div class="section"><div class="section-head"><h2>Что получил пользователь</h2>' +
    '<span class="hint">подсвеченное — не текст ответа, а виджеты; нажмите, чтобы увидеть их JSON</span></div>' +
    answerBody(parts, ans) + '</div>' : '';

  // one traceId can carry several user questions; split the chronicle by them
  const questions = (tr.userQs && tr.userQs.length) ? tr.userQs : (tr.userQ ? [tr.userQ] : []);
  const multiQ = questions.length > 1;
  const segOf = ts => {
    let idx = 0;
    for(let i = 0; i < questions.length; i++){ if(ts >= questions[i].ts) idx = i; else break; }
    return idx;
  };

  const total = Math.max(m.durationMs, 1);
  const rows = tr.events.map(e => {
    const ind = e.depth * 26;
    const bar = (() => {
      const st = (e.startTs != null ? e.startTs : e.ts) - (tr.records[0] ? tr.records[0].ts : 0);
      const dur = e.ms != null ? e.ms : 0;
      const left = Math.max(0, Math.min(100, st / total * 100));
      const w = Math.max(1.2, Math.min(100 - left, dur / total * 100));
      const k = (e.kind === 'mcp' || e.kind === 'mcpwrap') ? 'k-mcp' : e.kind === 'rag' ? 'k-rag' :
                e.kind === 'llm' ? 'k-llm' : e.kind === 'core' ? 'k-core' :
                e.kind === 'route' ? 'k-route' : 'k-sub';
      return '<div class="bar ' + k + '"><span style="left:' + left.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></span></div>' +
             (e.ms != null ? '<div class="dur">' + esc(fmtMs(e.ms)) + '</div>' : '');
    })();

    let inner = '<span class="chip ' + e.chipClass + '">' + esc(e.chip) + '</span>' +
                '<span class="title">' + esc(e.title) + (e.name ? '<span class="name">' + esc(e.name) + '</span>' : '') + '</span>';
    if(e.under) inner += '<div class="meta">внутри <b>' + esc(e.under) + '</b></div>';
    if(e.meta) inner += '<div class="meta">' + esc(e.meta) + '</div>';
    if(e.usage && e.usage.total_tokens) inner += '<div class="meta">токены: ' + e.usage.prompt_tokens + ' → ' + e.usage.completion_tokens + '</div>';
    if(e.kind === 'answer' && e.parts) inner += answerBody(e.parts, e.quote);
    else if(e.quote) inner += '<div class="quote' + (e.full ? ' full' : '') + '">' + esc(e.quote) + '</div>';
    if(e.error) inner += payloadBlock('ошибка', e.error, 'err');
    if(e.calls) inner += e.calls.map(c => payloadBlock('аргументы ' + c.name, c.args)).join('');
    if(e.params) inner += payloadBlock('параметры запроса', e.params);
    if(e.result) inner += payloadBlock('ответ инструмента', e.result);
    if(e.payload) inner += payloadBlock('полезная нагрузка', e.payload);
    if(e.detail) inner += payloadBlock('что делал сервис', e.detail);

    const sp = evSpan(e);
    const hasEnd = sp.end != null && sp.end > sp.start;
    const clock = '<div class="clock" title="' + esc('начало ' + fmtAbs(sp.start) +
                    (hasEnd ? ' · конец ' + fmtAbs(sp.end) + ' · ' + fmtMs(sp.end - sp.start) : '')) + '">' +
                  esc(fmtRel(e.rel)) +
                  '<div class="abs"><span>' + esc(fmtAbs(sp.start)) + '</span>' +
                  (hasEnd ? '<span class="to">' + esc(fmtAbs(sp.end)) + '</span>' : '') +
                  '</div></div>';

    return '<div class="row' + (e.minor ? ' minor' : '') + '" data-seg="' + segOf(e.ts) + '"' +
           (e.kind === 'llm' ? ' data-llm-ts="' + e.ts + '"' : '') +
           ' data-kind="' + e.kind + '" data-ts="' + e.ts + '">' + clock +
           '<div class="body d' + e.depth + '" style="--ind:' + ind + 'px"><div class="inner">' + inner + '</div></div>' +
           '<div class="track">' + bar + '</div></div>';
  }).join('');

  const qBlock = questions.length ? questions.map((q, i) =>
      '<p class="question">' + (multiQ ? '<span class="q-num">' + (i + 1) + '</span>' : '') +
      '<span class="q-mark">«</span>' + esc(q.text.trim()) + '<span class="q-mark">»</span></p>'
    ).join('') :
    '<p class="question"><span class="q-mark">«</span>запрос не найден в выгрузке<span class="q-mark">»</span></p>';

  const segTabs = multiQ ?
    '<div class="tabs segtabs" id="segtabs" role="tablist">' +
      '<button class="tab" data-seg="all" role="tab" aria-selected="false">Все</button>' +
      questions.map((q, i) => {
        const t = q.text.trim();
        return '<button class="tab" data-seg="' + i + '" role="tab" aria-selected="' + (i === 0) + '">' +
               '№' + (i + 1) + ' · ' + esc(t.slice(0, 36)) + (t.length > 36 ? '…' : '') + '</button>';
      }).join('') +
    '</div>' : '';

  // per-request swappable blocks (aggregate "all" + one per question); default request 0 visible
  const segs = tr.segments || [];
  const seg = (id, html) => '<div data-segblock="' + id + '"' + (String(id) === '0' ? '' : ' class="hidden"') + '>' + html + '</div>';
  const verdictBlock = multiQ
    ? seg('all', verdictHtml(tr.findings)) + segs.map(s => seg(s.index, verdictHtml(s.findings))).join('')
    : verdictHtml(tr.findings);
  const allTokHtml = allTokOf();
  const allSizeHtml = allSizeOf();
  const statsBlock = multiQ
    ? seg('all', statsHtml(tr.stats)) + segs.map(s => seg(s.index, statsHtml(s.stats, 'запрос №' + (s.index + 1)))).join('')
    : statsHtml(tr.stats);
  const answerBlock = multiQ
    ? seg('all', answerHtml(tr.finalAnswer, tr.answerParts)) +
      segs.map(s => seg(s.index, answerHtml(s.finalAnswer, s.answerParts))).join('')
    : answerHtml(tr.finalAnswer, tr.answerParts);

  // ---- sub-agents: what each one had on hand and what it actually used
  const agentCard = (a, root) => {
    const badge = root ? '<span class="badge root">оркестратор</span>' :
      a.calls ? '<span class="badge ok">вызван' + (a.calls > 1 ? ' ×' + a.calls : '') + '</span>' :
                '<span class="badge planned">назначен планом, не вызван</span>';
    const set = a.toolset || [];
    const used = set.filter(t => t.count).length;
    const mcp = set.filter(t => t.kind === 'mcp').length;
    const meta = a.known
      ? 'выдано инструментов: ' + set.length + (a.partial ? '+' : '') +
        ' · из них MCP: ' + mcp + (a.partial ? '+' : '') + ' · вызвал: ' + used +
        (a.partial ? ' · запись в логах обрезана, набор может быть неполным' : '')
      : (set.length ? 'вызвал: ' + used + ' · выданный набор в логах не виден'
                    : 'ничего не вызывал · выданный набор в логах не виден');
    const chips = set.map(t =>
      '<span class="tool' + (t.count ? ' used' : '') + (t.kind === 'sub' ? ' sub' : '') + '">' +
      esc(t.name) + (t.count > 1 ? ' ×' + t.count : '') + '</span>').join('');
    return '<div class="agent ' + (root ? 'root' : a.calls ? 'used' : 'planned') + '">' +
      '<div class="agent-top"><span class="agent-name">' + esc(a.name) + '</span>' + badge +
      (a.ms ? '<span class="agent-ms">' + esc(fmtMs(a.ms)) + '</span>' : '') + '</div>' +
      '<div class="agent-meta">' + esc(meta) + '</div>' +
      (chips ? '<div class="agent-tools">' + chips + '</div>' : '') + '</div>';
  };
  const agents = (tr.mainAgent ? [agentCard(tr.mainAgent, true)] : [])
    .concat((tr.subAgents || []).map(a => agentCard(a, false)));
  const subInv = agents.length ? (
    '<div class="section"><div class="section-head"><h2>Саб-агенты</h2>' +
    '<span class="hint">что было выдано агенту и что он вызвал: зелёным — вызванные, синим — вложенные агенты</span></div>' +
    '<div class="agents">' + agents.join('') + '</div></div>'
  ) : '';

  // ---- MCP tools: grouped by server; who was given each tool and who called it
  const agentRef = (name, n) => '<span class="by-agent">' + esc(name) + '</span>' +
    (n > 1 ? '<span class="by-n">×' + n + '</span>' : '');
  const mcpInv = (tr.mcpGroups || []).length ? (
    '<div class="section"><div class="section-head"><h2>MCP-Tools</h2>' +
    '<span class="hint">зелёным — вызванные, с указанием вызвавшего агента; ниже — кому инструмент был выдан, но не понадобился</span></div>' +
    tr.mcpGroups.map(g => {
      const called = g.tools.filter(t => t.calls);
      const held = g.tools.filter(t => !t.calls && t.offeredTo.length);
      const idle = g.tools.filter(t => !t.calls && !t.offeredTo.length);
      return '<div class="mcp-group">' +
        '<div class="mcp-srv"><span class="srv-name">' + esc(g.server) + '</span>' +
        '<span class="srv-meta">инструментов: ' + g.tools.length + ' · вызвано: ' + called.length +
        (held.length ? ' · выдано агентам без вызова: ' + held.length : '') +
        (g.apps.length ? ' · адаптер: ' + esc(g.apps.map(a => a.replace(/^alfagen-/, '')).join(', ')) : '') +
        '</span></div>' +
        (called.length ? '<div class="calls">' + called.map(t => {
          const idle2 = t.offeredTo.filter(w => !t.callers.some(c => c.name === w));
          return '<div class="callrow"><span class="tool used">' + esc(t.name) + '</span>' +
            '<span class="callmeta">' + (t.calls > 1 ? '×' + t.calls : '') +
            (t.calls > 1 && t.ms ? ' · ' : '') + (t.ms ? esc(fmtMs(t.ms)) : '') + '</span>' +
            '<span class="by">вызвал: ' + t.callers.map(c => agentRef(c.name, c.count)).join('') +
            (idle2.length ? '<span class="by-also">также выдан: ' + idle2.map(w => agentRef(w, 1)).join('') + '</span>' : '') +
            '</span></div>';
        }).join('') + '</div>' : '') +
        (held.length ? '<div class="calls held">' + held.map(t =>
          '<div class="callrow"><span class="tool' + (t.planned ? ' planned' : '') + '">' + esc(t.name) + '</span>' +
          '<span class="callmeta">не вызывался</span>' +
          '<span class="by">выдан: ' + t.offeredTo.map(w => agentRef(w, 1)).join('') + '</span></div>').join('') +
          '</div>' : '') +
        (idle.length ? '<details class="pay idle"><summary>ни одному агенту не выдавались: ' + idle.length + '</summary>' +
          '<div class="tools">' + idle.map(t =>
            '<span class="tool' + (t.planned ? ' planned' : '') + '">' + esc(t.name) +
            (t.planned ? ' — назначен планом, не вызван' : '') + '</span>').join('') +
          '</div></details>' : '') +
      '</div>';
    }).join('') + '</div>'
  ) : '';

  // ---- quality pipeline: the nightly verdict on this conversation. It runs hours after
  // the trace closes, so it gets a section of its own rather than rows in the chronicle,
  // where it would stretch the time scale past everything that actually happened.
  const qa = tr.quality;
  const qualityBlock = (() => {
    if(!qa) return '';
    // a dump can catch the pipeline at any point, so most of these are routinely absent —
    // show the ones that are known instead of a grid of dashes
    const known = [
      ['стратегия', qa.strategy],
      ['что оценивали', qa.kind],
      ['оценка', qa.score != null
          ? qa.score + (qa.rawScore != null && qa.rawScore !== qa.score ? ' (сырая ' + qa.rawScore + ')' : '')
          : (qa.rawScore != null ? 'сырая ' + qa.rawScore : null)],
      ['конфиг', qa.configVersion],
      ['batch', qa.batchId],
      ['pipeline item', qa.itemId],
      ['прогон', qa.from ? qa.from.toLocaleString('ru-RU') : null]
    ].filter(c => c[1] != null && c[1] !== '');
    const cells = known.length > 1
      ? '<div class="idbar" style="margin-top:14px">' + known.map(c =>
          '<div class="idcell"><dt>' + esc(c[0]) + '</dt><dd>' + esc(c[1]) + '</dd></div>').join('') + '</div>'
      : '';

    const verdicts = [];
    if(qa.humanReview){
      verdicts.push({level: 'note', text: 'Отправлено на ручную разметку в Label Studio' +
        (qa.humanReview.task ? ' — задача <code>#' + esc(qa.humanReview.task) + '</code>' : '') +
        (qa.humanReview.project ? ', проект <code>' + esc(qa.humanReview.project) + '</code>' : '') + '.'});
    }
    if(qa.autoAccept){
      verdicts.push({level: 'ok', text: 'Ответ принят автоматически и опубликован как few-shot пример' +
        (qa.autoAccept.store ? ' в <code>' + esc(qa.autoAccept.store) + '</code>' : '') + '.'});
    }
    if(qa.score == null && qa.rawScore == null){
      verdicts.push({level: 'note', text: qa.arbiterDone
        ? 'Арбитр отработал' + (qa.strategy ? ' по стратегии <code>' + esc(qa.strategy) + '</code>' : '') +
          ', но числовой оценки не выставил.'
        : qa.steps.length
          ? 'Трейс взят в работу, оценки в этой выгрузке ещё нет — она пишется позже, в логах арбитра.'
          : 'Коллектор выгружал этот трейс в quality-пайплайн' +
            (qa.from ? ' ' + esc(qa.from.toLocaleString('ru-RU')) : '') +
            ', но логов самой оценки в выгрузке нет.'});
    }
    if(qa.exampleId) verdicts.push({level: 'note', text: 'Идентификатор примера: <code>' + esc(qa.exampleId) + '</code>.'});

    const steps = qa.steps.length ? '<div class="qsteps">' + qa.steps.map(st =>
      '<div class="qstep"><span class="qtime">' + esc(fmtAbs(st.ts)) + '</span>' +
      '<span class="qtype">' + esc(st.type) + '</span>' +
      '<span class="qapp">' + esc(st.app.replace(/^aiagentscn-quality-/, '')) + '</span>' +
      '<span class="qtext">' + esc(st.text) + '</span></div>').join('') + '</div>' : '';

    return '<div class="section"><div class="section-head"><h2>Оценка качества</h2>' +
      '<span class="hint">ночной прогон quality-пайплайна — идёт через несколько часов после разговора, ' +
      'поэтому в хронику и длительность трейса не входит</span></div>' +
      cells +
      (verdicts.length ? '<div class="verdict">' +
        verdicts.map(x => '<div class="finding ' + x.level + '"><span class="dot"></span><div>' + x.text + '</div></div>').join('') +
        '</div>' : '') +
      steps + '</div>';
  })();

  host.innerHTML =
    '<div class="dossier">' +
      '<div class="eyebrow">О чём спросили' + (multiQ ? ' — запросов: ' + questions.length : '') + '</div>' +
      qBlock +
      '<div class="idbar">' + idcells + '</div>' +
    '</div>' +
    (multiQ ? segTabs : '') +
    verdictBlock +
    statsBlock +
    subInv +
    mcpInv +
    '<div class="section"><div class="section-head"><h2>Хроника</h2>' +
      '<span class="hint">' + (multiQ ? 'в трейсе несколько запросов — переключайте вкладки сверху' : 'отступ — глубина вызова, полоса справа — время') + '</span>' +
      '<span class="headtools">' +
        '<button type="button" class="foldbtn" id="foldopen">раскрыть все</button>' +
        '<button type="button" class="foldbtn close" id="foldshut">свернуть все</button>' +
      '</span></div>' +
      '<div class="spine" id="spine">' + (rows || '<div class="empty">Значимых событий не найдено.</div>') + '</div></div>' +
    (tr.errors.length ? '<div class="section"><div class="section-head"><h2>Сбои и предупреждения</h2>' +
      '<span class="hint">' + tr.errorTotal + ' записей, свёрнуты по одинаковым сигнатурам</span></div>' +
      '<div class="verdict" style="margin-top:14px">' + tr.errors.map(g =>
        '<div class="finding ' + (g.level === 'ERROR' ? 'warn' : 'note') + '"><span class="dot"></span><div>' +
        '<b>' + esc(g.level) + ' ×' + g.count + '</b> · <code>' + esc(String(g.logger).split('.').pop()) + '</code>' +
        '<div class="meta" style="margin-top:4px">' + esc(g.sample.replace(/\s+/g, ' ').slice(0, 260)) + '</div>' +
        '</div></div>').join('') + '</div></div>' : '') +
    contractsSection(tr) +
    answerBlock +
    qualityBlock +
    '<details class="section" id="rawfold"><summary class="section-head"><h2>Сырые записи</h2>' +
      '<span class="hint">' + tr.records.length + ' шт. в этом трейсе — нажмите, чтобы раскрыть</span></summary>' +
      '<div class="rawbar">' +
        '<input id="q" placeholder="поиск по тексту сообщения…">' +
        '<select id="fapp"></select><select id="flvl"></select>' +
      '</div><div id="rawtable"></div></details>';

  wireContracts(tr, segOf);
  wireChronicle();
  wireFolds();
  wireRaw(tr);
  wireTokJump();
}

/* "самый большой ход LLM" cards: open the owning trace if needed, then scroll to that
   model turn in the chronicle and flash it */
function wireTokJump(){
  document.querySelectorAll('.stat.jump').forEach(card => card.onclick = () =>
    jumpTo(card.dataset.jumpTrace, card.dataset.jumpKind, card.dataset.jumpTs));
}
/* open trace `ti` (if given), then scroll the chronicle to the row at `ts` and flash it */
function jumpTo(ti, kind, ts){
  {
    if(ti != null && (+ti !== STATE.active || STATE.group === 'session')){
      STATE.active = +ti; STATE.group = 'trace'; renderTabs(); renderReport();
    }
    // token cards name the exact model turn; size cards name a moment, so take the
    // closest chronicle row of that kind
    let row = null;
    if(kind){
      const kinds = kind === 'mcp' ? ['mcp', 'mcpwrap'] : [kind];
      let best = Infinity;
      document.querySelectorAll('#spine .row[data-kind]').forEach(r => {
        if(kinds.indexOf(r.dataset.kind) < 0) return;
        const d = Math.abs(+r.dataset.ts - +ts);
        if(d < best){ best = d; row = r; }
      });
    } else row = document.querySelector('#spine .row[data-llm-ts="' + ts + '"]');
    if(!row) return;
    if(row.classList.contains('hidden')){
      const tab = document.querySelector('#segtabs .tab[data-seg="' + row.dataset.seg + '"]');
      if(tab) tab.click();
    }
    row.scrollIntoView({behavior: 'smooth', block: 'center'});
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }
}

/* "раскрыть/свернуть все" over every payload fold in the chronicle — параметры запроса,
   ответ инструмента, аргументы, полезная нагрузка. Rows hidden by the segment tabs are
   folded too, so switching tabs does not reveal a different state than the buttons set. */
function wireFolds(){
  const open = $('#foldopen'), shut = $('#foldshut');
  if(!open || !shut) return;
  const folds = Array.from(document.querySelectorAll('#spine details.pay, #spine details.synth'));
  if(!folds.length){
    [open, shut].forEach(b => { b.disabled = true; b.title = 'в этой хронике нечего раскрывать'; });
    return;
  }
  const label = ' (' + folds.length + ')';
  open.textContent += label;
  shut.textContent += label;
  const setAll = v => folds.forEach(d => { d.open = v; });
  open.onclick = () => setAll(true);
  shut.onclick = () => setAll(false);
}

/* switch the whole report (verdict, stats, chronicle, answer) between requests */
function wireChronicle(){
  const tabs = $('#segtabs');
  if(!tabs) return;
  const rows = Array.from(document.querySelectorAll('#spine .row'));
  const blocks = Array.from(document.querySelectorAll('[data-segblock]'));
  function select(seg){
    tabs.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.seg === seg)));
    rows.forEach(r => r.classList.toggle('hidden', seg !== 'all' && r.dataset.seg !== seg));
    blocks.forEach(b => b.classList.toggle('hidden', b.dataset.segblock !== seg));
    ctSetSeg(seg);
  }
  tabs.querySelectorAll('.tab').forEach(b => b.onclick = () => select(b.dataset.seg));
  select('0');
}
