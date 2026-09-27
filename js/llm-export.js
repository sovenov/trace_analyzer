/* «Для LLM»: сжатая выжимка по traceId, sessionId или CUS — Markdown, который можно
   целиком отдать модели на анализ. Только то, что нужно для разбора поведения агента:
   откуда и как пришёл запрос, путь по сервисам, план, ходы модели, вызовы инструментов
   с аргументами и (обрезанными) ответами, сбои, что ушло клиенту. Системные промпты,
   заголовки, служебные поля и повторы не попадают; длинные тексты обрезаются с пометкой. */

const LLM_LIMITS = {
  mcpArgs: 600,       // аргументы инструмента
  mcpResult: 1200,    // ответ инструмента
  llmText: 700,       // текст хода модели (финальный ответ идёт целиком отдельно)
  callArgs: 500,      // аргументы вызова, который модель заказала
  subIO: 700,         // вход/выход саб-агента
  error: 400,         // пример сообщения об ошибке
  chatAnswer: 600     // ответ агента в сводной переписке диалога
};

/* the task placed at the top of every file — the reader may replace it with their own */
const LLM_TASK =
  'Ниже — выжимка логов AI-ассистента (AlfaGen / AIAD_CHAT) по обработке сообщений клиента. ' +
  'Проанализируй её и напиши:\n' +
  '1. Где агент повёл себя неправильно или неоптимально: лишние или пропущенные вызовы инструментов, ' +
  'неверный выбор инструмента или агента, ошибки в аргументах, неверная интерпретация ответа инструмента, ' +
  'ответ не на тот вопрос, галлюцинации (утверждения, которых нет в данных инструментов).\n' +
  '2. Узкие места: что дольше всего, где больше всего токенов, что можно распараллелить или убрать.\n' +
  '3. Сбои и ошибки сервисов и их влияние на ответ.\n' +
  '4. Качество ответа клиенту: полнота, точность, понятность, соответствие вопросу.\n' +
  '5. Конкретные предложения по улучшению (промпт, набор инструментов, маршрутизация, данные).\n' +
  'Ссылайся на время (+N с) и traceId.';

let LLM_SCALE = 1;        // < 1 for a dialog or a client with many requests
function llmCut(s, n){
  if(s == null) return '';
  s = typeof s === 'string' ? s : JSON.stringify(s);
  n = Math.max(120, Math.round(n * LLM_SCALE));
  // JSON is re-serialized compactly: the model needs the data, not the indentation
  const t = s.trim();
  if(t.charAt(0) === '{' || t.charAt(0) === '['){
    try { s = JSON.stringify(JSON.parse(t)); } catch(e){ s = t.replace(/\s*\n\s*/g, ' '); }
  }
  return s.length > n ? s.slice(0, n) + ' …[+' + (s.length - n) + ' симв.]' : s;
}
const llmText = h => String(h == null ? '' : h).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const llmSec = s => (s < 10 ? s.toFixed(2) : s.toFixed(1)).replace('.', ',');
const llmMs = ms => ms == null ? '' : ms >= 1000 ? (ms / 1000).toFixed(1).replace('.', ',') + ' с' : Math.round(ms) + ' мс';
const llmNum = n => Math.round(n).toLocaleString('ru-RU');
const llmTime = ms => ms ? new Date(ms).toLocaleString('ru-RU') : '—';
function llmUsage(u){
  if(!u) return null;
  if(typeof u === 'string'){ try { u = JSON.parse(u); } catch(e){ return null; } }
  const i = u.prompt_tokens != null ? u.prompt_tokens : u.promptTokens;
  const o = u.completion_tokens != null ? u.completion_tokens : u.completionTokens;
  return (i != null || o != null) ? {in: +i || 0, out: +o || 0} : null;
}

/* the path between services, one line per distinct caller → callee pair */
function llmRoute(tr){
  let list;
  try { list = extractContracts(tr.records); } catch(e){ return []; }
  const keep = {channel: 1, flow: 1, llm: 1, mcp: 1, rag: 1};
  const edges = [], seen = new Map();
  list.forEach(c => {
    if(!keep[c.kind]) return;
    const k = c.from + '\u0000' + c.to;
    let e = seen.get(k);
    if(!e){ e = {c: c, n: 0, bad: 0, ms: []}; seen.set(k, e); edges.push(e); }
    e.n++;
    if(c.ms != null) e.ms.push(c.ms);
    const st = String(c.status == null ? '' : c.status);
    if(/^[45]\d\d$/.test(st) || /ошиб|error|fail|isError/i.test(st)) e.bad++;
  });
  return edges.map(e => {
    const c = e.c;
    const ms = e.ms.length ? (e.ms.length > 1 ? 'в сумме ' + llmMs(e.ms.reduce((a, x) => a + x, 0)) + ', макс. ' + llmMs(Math.max.apply(null, e.ms)) : llmMs(e.ms[0])) : '';
    return c.from + ' → ' + c.to + ' — ' + [
      [c.method, c.endpoint].filter(Boolean).join(' ') || c.title,
      e.n > 1 ? '×' + e.n : '',
      ms,
      e.bad ? 'ОШИБОК: ' + e.bad : (c.status != null && c.status !== '' ? 'статус ' + c.status : '')
    ].filter(Boolean).join(' · ');
  });
}

function llmEventLine(e, t0){
  const pad = '  '.repeat(Math.max(0, Math.min(4, e.depth || 0)));
  const at = '+' + llmSec(Math.max(0, ((e.startTs != null ? e.startTs : e.ts) - t0) / 1000)) + 'с';
  const name = e.name ? ' ' + e.name : '';
  const out = [];
  if(e.kind === 'user'){
    out.push(at + ' [Запрос клиента] ' + (e.meta ? '(' + e.meta + ') ' : '') + '«' + llmCut(e.quote, 1000) + '»');
  } else if(e.kind === 'route'){
    out.push(at + ' [Маршрутизация]' + name + (e.ms != null ? ' · ' + llmMs(e.ms) : '') + (e.meta ? ' · ' + e.meta : ''));
  } else if(e.kind === 'llm'){
    const u = llmUsage(e.usage);
    const head = at + ' [Модель: ' + (e.title || 'ход') + ']' +
      (e.model ? ' ' + e.model : '') +
      (u ? ' · токены ' + llmNum(u.in) + ' → ' + llmNum(u.out) : '') +
      (e.ms != null ? ' · ' + llmMs(e.ms) : '') +
      (e.finish && e.finish !== 'stop' ? ' · finish=' + e.finish : '') +
      (e.bad ? ' · ЗАБЛОКИРОВАНО' : '');
    out.push(head);
    let calls = e.calls;
    if(typeof calls === 'string'){ try { calls = JSON.parse(calls); } catch(err){ calls = null; } }
    if(calls && calls.length){
      calls.forEach(c => out.push(pad + '    вызывает ' + c.name + '(' + llmCut(c.args, LLM_LIMITS.callArgs) + ')'));
      if(e.content && String(e.content).trim()) out.push(pad + '    рассуждение: ' + llmCut(e.content, LLM_LIMITS.llmText));
    } else if(e.tag === 'plan' && e.planData){
      out.push(pad + '    план: ' + llmCut(JSON.stringify(e.planData), LLM_LIMITS.llmText));
    } else if(e.tag === 'guard' || e.tag === 'reform'){
      out.push(pad + '    ' + llmText(e.meta) + (e.quote ? ' · ' + llmCut(e.quote, LLM_LIMITS.llmText) : ''));
    } else if(e.content){
      out.push(pad + '    текст: ' + llmCut(e.content, LLM_LIMITS.llmText));
    } else if(e.empty){
      out.push(pad + '    (пустой ответ модели)');
    }
  } else if(e.kind === 'mcp' || e.kind === 'mcpwrap'){
    const err = e.error || (e.status && /ошиб|error|fail/i.test(String(e.status)));
    out.push(at + ' [MCP]' + name + (e.under ? ' (вызвал ' + e.under + ')' : '') +
      (e.ms != null ? ' · ' + llmMs(e.ms) : '') + (e.upstreamMs != null ? ' (из них core ' + llmMs(e.upstreamMs) + ')' : '') +
      (err ? ' · ОШИБКА' : ''));
    if(e.params != null) out.push(pad + '    аргументы: ' + llmCut(e.params, LLM_LIMITS.mcpArgs));
    if(e.error) out.push(pad + '    ошибка: ' + llmCut(e.error, LLM_LIMITS.mcpResult));
    else if(e.result != null){
      const len = String(e.result).length;
      out.push(pad + '    ответ (' + llmNum(len) + ' симв.): ' + llmCut(e.result, LLM_LIMITS.mcpResult));
    }
  } else if(e.kind === 'subagent'){
    out.push(at + ' [Саб-агент' + (e.phase === 'out' ? ': ответ' : ': вызов') + ']' + name +
      (e.ms != null ? ' · ' + llmMs(e.ms) : '') + (e.meta && e.phase === 'out' ? ' · ' + e.meta : '') +
      (e.error ? ' · ОШИБКА' : ''));
    if(e.payload) out.push(pad + '    ' + (e.phase === 'out' ? 'вернул: ' : 'вход: ') + llmCut(e.payload, LLM_LIMITS.subIO));
    if(e.error) out.push(pad + '    ошибка: ' + llmCut(e.error, LLM_LIMITS.subIO));
  } else if(e.kind === 'core'){
    const meta = String(e.meta || '').replace(/\s*·\s*логов сервиса в выгрузке нет/, '');
    out.push(at + ' [Core]' + name + (e.under ? ' (для ' + e.under + ')' : '') + (meta ? ' · ' + meta : '') + (e.error ? ' · ОШИБКА: ' + llmCut(e.error, 200) : ''));
  } else if(e.kind === 'rag'){
    out.push(at + ' [RAG] ' + (e.title || '') + (e.quote ? ' «' + llmCut(e.quote, 300) + '»' : '') + (e.meta ? ' · ' + e.meta : ''));
  } else if(e.kind === 'answer'){
    out.push(at + ' [' + (e.chip || 'Ответ') + '] ' + (e.title || '') + (e.meta ? ' · ' + e.meta : ''));
  } else if(e.kind === 'error'){
    out.push(at + ' [' + (e.chip || 'СБОЙ') + '] ' + (e.app || '') + ': ' + llmCut(e.quote, LLM_LIMITS.error));
  } else if(e.kind === 'sys'){
    return [];                                   // handshakes: noise for this purpose
  } else {
    out.push(at + ' [' + (e.chip || e.kind) + '] ' + llmText((e.title || '') + name) + (e.meta ? ' · ' + llmText(e.meta) : ''));
  }
  // a multi-line text stays inside its step: every continuation line is indented under it
  return out.map((l, i) => (i === 0 ? pad + '- ' + l : pad + l).replace(/\n/g, '\n' + pad + '      '));
}

function llmAgents(tr){
  const lines = [];
  const one = (a, role) => {
    const set = a.toolset || [];
    const used = set.filter(t => t.count);
    const unused = set.filter(t => !t.count).map(t => t.name);
    lines.push('- ' + a.name + ' (' + role + (a.ms ? ', ' + llmMs(a.ms) : '') + ')' +
      (set.length ? ': выдано инструментов ' + set.length + (a.partial ? '+' : '') : '') +
      (used.length ? '; вызвал: ' + used.map(t => t.name + (t.count > 1 ? ' ×' + t.count : '')).join(', ') : '; ничего не вызывал') +
      (unused.length ? '; не вызывал: ' + unused.join(', ') : ''));
  };
  if(tr.mainAgent) one(tr.mainAgent, 'оркестратор');
  (tr.subAgents || []).forEach(a => one(a, a.calls ? 'саб-агент, вызван' + (a.calls > 1 ? ' ×' + a.calls : '') : 'назначен планом, не вызван'));
  return lines;
}

function llmTraceSection(tr, n, opts){
  const m = tr.meta, ctx = m.ctx || {}, s = tr.stats || {};
  const L = [];
  const q = (tr.userQs && tr.userQs.length) ? tr.userQs : (tr.userQ ? [tr.userQ] : []);
  const t0 = tr.records.length ? tr.records[0].ts : (m.from ? +m.from : 0);
  L.push('## ' + (n ? 'Запрос ' + n + ' · ' : '') + 'traceId ' + tr.traceId);
  L.push('');
  const fio = [ctx.lastName, ctx.firstName, ctx.middleName].filter(Boolean).join(' ');
  const skill = [ctx.selectedSkill ? 'скилл ' + ctx.selectedSkill : '', ctx.selectedChip ? 'чип ' + ctx.selectedChip : ''].filter(Boolean).join(', ');
  const facts = [
    ['начало', llmTime(m.from ? +m.from : t0)],
    ['длительность', llmMs(m.durationMs)],
    ['messageId', m.messageId],
    !opts.inSession ? ['sessionId', (tr.userQ && tr.userQ.session) || m.sessionGuess] : null,
    !opts.inCus ? ['cus', (tr.userQ && tr.userQ.cus) || ctx.cus] : null,
    !opts.inCus && fio ? ['клиент', fio] : null,
    ['канал', [ctx.sourceChannel || (tr.userQ && tr.userQ.channel), ctx.channelApp].filter(Boolean).join(' · ')],
    ['system_id', (m.systemIds || []).slice(0, 3).join(', ')],
    ['скилл/чип', skill || (ctx.profileSeen ? 'не выбран (вопрос введён текстом)' : '')],
    ['устройство', [ctx.deviceModel, ctx.operationSystem].filter(Boolean).join(', ')],
    ['сегмент', ctx.segment],
    ['связанные traceId', (tr.linked || []).map(l => l.traceId + ' (' + l.what + ')').join('; ')]
  ].filter(p => p && p[1]);
  facts.forEach(p => L.push('- ' + p[0] + ': ' + p[1]));
  L.push('');

  L.push('### Вопрос клиента');
  q.forEach(x => L.push('> ' + String(x.text || '').replace(/\n/g, '\n> ')));
  if(!q.length) L.push('(в логах не найден)');
  L.push('');

  const route = llmRoute(tr);
  if(route.length){
    L.push('### Путь запроса между сервисами');
    route.forEach((r, i) => L.push((i + 1) + '. ' + r));
    L.push('');
  }

  L.push('### Метрики');
  const tm = s.tokMax;
  [
    'длительность ' + (s.seconds != null ? llmSec(s.seconds) + ' с' : '—'),
    'ходов LLM ' + (s.llm || 0) + (s.tokens ? ', токенов ' + llmNum(s.tokens) + ' (вход ' + llmNum(s.tokIn || 0) + ', выход ' + llmNum(s.tokOut || 0) + ')' : ''),
    tm ? 'самый большой ход LLM: ' + llmNum(tm.tokens) + ' ток. (' + tm.title + ', +' + llmSec(tm.rel || 0) + 'с)' : '',
    'вызовов MCP ' + (s.mcp || 0) + (s.sizes && s.sizes.mcp && s.sizes.mcp.bytes ? ', ответы MCP ' + llmNum(s.sizes.mcp.bytes) + ' байт' +
      (s.sizes.mcp.max ? ' (самый большой ' + llmNum(s.sizes.mcp.max.bytes) + ' байт, ' + s.sizes.mcp.max.tool + ')' : '') : ''),
    'саб-агентов ' + (s.subs || 0) + ', вызовов core ' + (s.core || 0) + ', чанков RAG ' + (s.rag || 0),
    'ответ ' + (tr.finalAnswer ? (tr.delivered ? 'доставлен клиенту' : 'сформирован, доставка в логах не подтверждена') : 'в логах не найден')
  ].filter(Boolean).forEach(x => L.push('- ' + x));
  L.push('');

  if((tr.findings || []).length){
    L.push('### Выводы анализатора');
    tr.findings.forEach(f => L.push('- [' + ({ok: 'ок', warn: 'проблема', bad: 'проблема', note: 'заметка'}[f.level] || f.level) + '] ' + llmText(f.text)));
    L.push('');
  }

  const ag = llmAgents(tr);
  if(ag.length){ L.push('### Агенты и инструменты'); ag.forEach(x => L.push(x)); L.push(''); }

  L.push('### Ход выполнения');
  L.push('(время от начала запроса; отступ — вложенность вызова; токены — вход → выход)');
  tr.events.forEach(e => llmEventLine(e, t0).forEach(x => L.push(x)));
  L.push('');

  if((tr.errors || []).length){
    L.push('### Сбои и предупреждения (' + tr.errorTotal + ' записей)');
    tr.errors.slice(0, 15).forEach(g => L.push('- ' + g.level + ' ×' + g.count + ' · ' + String(g.logger).split('.').pop() + ': ' + llmCut(g.sample.replace(/\s+/g, ' '), LLM_LIMITS.error)));
    if(tr.errors.length > 15) L.push('- … ещё ' + (tr.errors.length - 15) + ' групп');
    L.push('');
  }

  L.push('### Что получил клиент');
  if(tr.finalAnswer){
    const parts = tr.answerParts && tr.answerParts.length ? tr.answerParts : [{kind: 'text', text: tr.finalAnswer}];
    parts.forEach(p => {
      if(p.kind === 'text') L.push(String(p.text).trim());
      else L.push('[' + (p.kind === 'asset' ? 'карточка' : p.kind === 'chart' ? 'график' : 'кнопки') + ': ' + llmText(p.text) + ']');
      L.push('');
    });
  } else { L.push('(ответ в логах не найден)'); L.push(''); }

  if(tr.quality){
    L.push('### Оценка качества (ночной прогон)');
    L.push(llmCut(JSON.stringify(tr.quality), 1500));
    L.push('');
  }
  return L.join('\n');
}

/* which traces, in what order, and the header for the file */
function llmBuild(scope, key){
  const date = new Date().toLocaleString('ru-RU');
  const head = (title, what) => [
    '# ' + title,
    '',
    'Выжимка логов для анализа, собрана анализатором трейсов ' + date + '. ' + what +
    ' Длинные тексты обрезаны (пометка «…[+N симв.]»), системные промпты и служебные поля не включены.',
    '',
    '## Задача',
    '',
    LLM_TASK,
    ''
  ];
  let L = [], traces = [], opts = {};
  if(scope === 'trace'){
    const tr = STATE.traces[key];
    if(!tr) return null;
    L = head('Запрос traceId ' + tr.traceId, 'Один запрос клиента.');
    traces = [tr];
  } else {
    const list = scope === 'session' ? buildSessions() : buildCustomers();
    const g = list.find(x => x.key === key);
    if(!g) return null;
    const items = g.items;
    const tis = [];
    items.forEach(it => [it].concat(it.also || []).forEach(x => { if(tis.indexOf(x.ti) < 0) tis.push(x.ti); }));
    traces = tis.map(i => STATE.traces[i]).sort((a, b) => (a.meta.from || 0) - (b.meta.from || 0));
    if(scope === 'session'){
      opts.inSession = true;
      L = head('Диалог sessionId ' + (g.id || 'не найден'),
        'Один диалог клиента: ' + g.messages + ' сообщ., ' + traces.length + ' traceId.');
      L.push('## Диалог', '', '- sessionId: ' + (g.id || '—'), '- cus: ' + (g.cus || '—'), '- клиент: ' + (g.fio || '—'),
             '- канал: ' + (g.channel || '—'), '- период: ' + llmTime(g.from) + ' — ' + llmTime(g.to), '');
    } else {
      opts.inCus = true;
      L = head('Клиент CUS ' + (g.cus || 'не найден'),
        'Все диалоги одного клиента: ' + g.sessions.length + ' сесс., ' + g.items.length + ' сообщ., ' + traces.length + ' traceId.');
      L.push('## Клиент', '', '- cus: ' + (g.cus || '—'), '- клиент: ' + (g.fio || '—'), '- каналы: ' + (g.channels.join(', ') || '—'),
             '- сессий: ' + g.sessions.length, '- период: ' + llmTime(g.from) + ' — ' + llmTime(g.to), '');
    }
    L.push('## Переписка', '', '(коротко; подробности — в разделах по traceId ниже)', '');
    let prev = null;
    items.forEach(it => {
      if(scope === 'cus' && it.skey !== prev){ L.push('— сессия ' + (it.sid || 'без sessionId') + ' —'); prev = it.skey; }
      const tid = STATE.traces[it.ti].traceId;
      L.push('- ' + llmTime(it.ts) + ' · клиент' + (it.cus ? ' ' + it.cus : '') + ': «' + llmCut(it.text, 1000) + '» [traceId ' + tid + ']' +
             ((it.also || []).length ? ' (отправлено повторно ещё ' + it.also.length + ' раз)' : ''));
      L.push('  ' + (it.answer
        ? (it.ansTs ? llmTime(it.ansTs) + ' · ' : '') + 'агент' + (it.ansTs ? ' (через ' + llmMs(it.ansTs - it.ts) + ')' : '') +
          (it.delivered ? '' : ' [доставка не подтверждена]') + ': «' + llmCut(it.answer, LLM_LIMITS.chatAnswer) + '»'
        : 'агент: ответ в логах не найден'));
    });
    L.push('');
  }
  // many requests in one file: tighter cuts, so a long dialog stays a readable size
  LLM_SCALE = traces.length > 6 ? 0.4 : traces.length > 3 ? 0.6 : 1;
  try {
    traces.forEach((tr, i) => { L.push(llmTraceSection(tr, traces.length > 1 ? i + 1 : 0, opts)); L.push(''); });
  } finally { LLM_SCALE = 1; }
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

function exportForLlm(scope, key, btn){
  const text = llmBuild(scope, key);
  if(!text) return;
  let id = '';
  if(scope === 'trace') id = STATE.traces[key].traceId;
  else {
    const g = (scope === 'session' ? buildSessions() : buildCustomers()).find(x => x.key === key);
    id = (scope === 'session' ? g && g.id : g && g.cus) || 'unknown';
  }
  const slug = String(id).replace(/[^\w.-]+/g, '_').slice(0, 60);
  downloadBlob(text, 'text/markdown;charset=utf-8', 'llm_' + scope + '_' + slug + '_' + tstamp() + '.md');
  // a rough size, so the reader knows what they are about to paste: ~3 characters a token
  if(btn){
    const tok = Math.round(text.length / 3);
    btn.title = 'Скачано: ' + llmNum(text.length) + ' симв., ≈' + llmNum(tok) + ' токенов';
    const lab = btn.querySelector('.tabdl-l');
    if(lab){ const was = lab.textContent; lab.textContent = '≈' + (tok >= 1000 ? Math.round(tok / 1000) + 'K' : tok) + ' ток.'; setTimeout(() => { lab.textContent = was; }, 4000); }
  }
}
