/* ====================== contracts: the section ======================
   A folded section under «Сбои и предупреждения». Nothing is computed until it is opened:
   extractContracts walks every record of the trace, and a body panel is only laid out
   when its row is opened. */
const CT = {tr: null, list: null, seg: 'all', segOf: null, kinds: null};
const CT_CHIP = {channel: 'c-user', flow: 'c-sub', llm: 'c-llm', mcp: 'c-mcp', rag: 'c-rag', llmgw: 'c-sys', auth: 'c-sys'};
const CT_FMT = {json: 'JSON', py: 'python repr', proto: 'protobuf text', tostring: 'Java toString', text: 'текст'};

/* protobuf text format → one field per line. Some services log it already laid out,
   others squeeze it into one line; either way octal escapes (\320\225) are UTF-8 bytes
   and are decoded back into letters. Strings pass through untouched otherwise. */
function protoPretty(src){
  const s = String(src == null ? '' : src);
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const unOctal = str => !dec || str.indexOf('\\') < 0 ? str : str.replace(/(?:\\[0-3][0-7]{2})+/g, run => {
    const bytes = run.match(/\\[0-3][0-7]{2}/g).map(x => parseInt(x.slice(1), 8));
    try { return dec.decode(new Uint8Array(bytes)); } catch(e){ return run; }
  });
  // already one field per line: only the escapes need decoding
  if(/\n\s+\S/.test(s.slice(0, 2000)) && /\{\n/.test(s)) return {text: unOctal(s), cut: false};
  const toks = [];
  let i = 0;
  while(i < s.length){
    const c = s[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c === '{' || c === '}'){ toks.push(c); i++; continue; }
    if(c === '"' || c === "'"){
      let j = i + 1;
      while(j < s.length && s[j] !== c){ if(s[j] === '\\') j++; j++; }
      toks.push(s.slice(i, Math.min(j + 1, s.length)));
      i = j + 1; continue;
    }
    let j = i;
    while(j < s.length && !/[\s{}"']/.test(s[j])) j++;
    toks.push(s.slice(i, j)); i = j;
  }
  let out = '', ind = 0, line = '';
  const flush = () => { if(line) out += (out ? '\n' : '') + '  '.repeat(Math.max(0, ind)) + line; line = ''; };
  for(let k = 0; k < toks.length; k++){
    const t = toks[k];
    if(t === '{'){ line += (line ? ' ' : '') + '{'; flush(); ind++; continue; }
    if(t === '}'){ flush(); ind--; line = '}'; flush(); continue; }
    const isName = /^[A-Za-z_][\w.\[\]]*:$/.test(t) || (/^[A-Za-z_][\w.]*$/.test(t) && toks[k + 1] === '{');
    if(isName){ flush(); line = t; continue; }
    line += (line && !/:$/.test(line) ? ' ' : line ? ' ' : '') + (t[0] === '"' ? unOctal(t) : t);
  }
  flush();
  return {text: out, cut: ind > 0};
}

/* a Java record's toString(): Name[a=1, b=Sub[c=2], d=[x, y]] → nested lines. The values
   are not quoted, so a comma inside a text value can break a line early — the layout is
   for reading, not for parsing. */
function javaToStringPretty(src){
  const s = String(src == null ? '' : src);
  let out = '', ind = 0;
  const stack = [];            // true: a bracket that opened an indented block
  const nl = () => '\n' + '  '.repeat(Math.max(0, ind));
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(c === '['){
      const block = /[\w=]$/.test(out) && s[i + 1] !== ']';
      stack.push(block);
      out += '[';
      if(block){ ind++; out += nl(); }
      continue;
    }
    if(c === ']' && stack.length){
      if(stack.pop()){ ind--; out += nl() + ']'; } else out += ']';
      continue;
    }
    if(c === ',' && s[i + 1] === ' ' && ind > 0 && /^ [A-Za-z_]\w*=/.test(s.slice(i + 1, i + 60))){
      out += ','; out += nl(); i++; continue;
    }
    out += c;
  }
  return {text: out, cut: ind > 0};
}

/* body text → {text, note} laid out by its format */
function ctFormat(body, fmt){
  if(body == null || body === '') return {text: '', mark: ''};
  const b = String(body);
  if(fmt === 'json' || fmt === 'py'){
    const r = prettyInfo(fmt === 'py' ? (safeJson(pyToJson(b)) ? pyToJson(b) : b) : b);
    if(fmt === 'py' && !safeJson(pyToJson(b)) && r.loose){
      const r2 = prettyLoose(pyToJson(b));
      return {text: r2.text, mark: r2.cut ? 'обрезан' : 'не разбирается'};
    }
    return {text: r.text, mark: r.loose ? (r.cut ? 'обрезан' : 'не разбирается') : ''};
  }
  if(fmt === 'proto'){ const r = protoPretty(b); return {text: r.text, mark: r.cut ? 'обрезан' : ''}; }
  if(fmt === 'tostring'){ const r = javaToStringPretty(b); return {text: r.text, mark: r.cut ? 'обрезан' : ''}; }
  return {text: b, mark: ''};
}
function ctHeaders(h, hfmt){
  if(h == null) return null;
  if(typeof h === 'string'){
    const o = safeJson(hfmt === 'py' ? pyToJson(h) : h);
    if(!o) return h;
    h = o;
  }
  const keys = Object.keys(h);
  if(!keys.length) return null;
  return keys.map(k => k + ': ' + (typeof h[k] === 'object' ? JSON.stringify(h[k]) : h[k])).join('\n');
}
function ctStatus(c){
  const s = c.status;
  if(s == null || s === '') return '';
  const bad = (typeof s === 'number' && s >= 400) || /^[45]\d\d$/.test(String(s)) || /ошиб|error|fail|isError/i.test(String(s));
  return '<span class="ctst ' + (bad ? 'bad' : 'ok') + '">' + esc(s) + '</span>';
}
function ctPanel(label, p, side){
  if(!p) return '<div class="ctpanel"><h4>' + label + '</h4><div class="ctnote">ответ в выгрузке не найден</div></div>';
  const hdr = ctHeaders(p.headers, p.hfmt);
  const f = ctFormat(p.body, p.fmt);
  const len = p.body != null ? String(p.body).length : 0;
  return '<div class="ctpanel"><h4>' + label +
      (len ? '<span class="ctmeta">' + esc(CT_FMT[p.fmt] || p.fmt || '') + ' · ' + len.toLocaleString('ru-RU') + ' симв.</span>' : '') +
      (f.text ? '<button type="button" class="ctcopy" data-side="' + side + '" title="скопировать тело как есть в логе">копировать</button>' : '') +
    '</h4>' +
    (p.rebuilt ? '<div class="ctrebuilt">' + esc(p.rebuilt) + '</div>' : '') +
    (p.note ? '<div class="ctnote">' + esc(p.note) + '</div>' : '') +
    (hdr ? '<details class="pay"><summary>заголовки</summary><pre class="json">' + esc(hdr) + '</pre></details>' : '') +
    (f.text ? '<pre class="json ctpre' + (f.mark ? ' loose' : '') + '">' +
        (f.mark ? '<span class="paymark" title="тело не закрыто или не разбирается — показано как есть, с отступами">' + f.mark + '</span>\n' : '') +
        esc(f.text) + '</pre>' : (p.note || p.rebuilt ? '' : '<div class="ctnote">тело не записано в лог</div>')) +
  '</div>';
}
function ctBodyHtml(c){
  const facts = [
    c.title ? '<b>' + esc(c.title) + '</b>' : '',
    c.method || c.endpoint ? '<code>' + esc([c.method, c.endpoint].filter(Boolean).join(' ')) + '</code>' : '',
    c.ms != null ? 'длительность ' + esc(fmtMs(c.ms)) : '',
    c.end && c.end !== c.ts ? 'ответ в ' + esc(fmtAbs(c.end)) : '',
    c.via ? 'через ' + esc(c.via) : '',
    'источник: ' + esc(c.src || '—')
  ].filter(Boolean).join(' · ');
  return '<div class="ctfacts">' + facts + '</div>' +
    '<div class="ctpanels">' + ctPanel('Запрос', c.req, 'req') + ctPanel('Ответ', c.resp, 'resp') + '</div>';
}
/* what "скачать JSON" writes: bodies parsed when they parse, text otherwise */
function ctExport(c){
  const side = p => {
    if(!p) return null;
    let body = p.body == null ? null : String(p.body);
    const parsed = body != null && (p.fmt === 'json' ? safeJson(body) : p.fmt === 'py' ? safeJson(pyToJson(body)) : null);
    const o = {};
    if(p.headers) o.headers = typeof p.headers === 'string' ? (safeJson(p.hfmt === 'py' ? pyToJson(p.headers) : p.headers) || p.headers) : p.headers;
    if(body != null){ o.format = p.fmt; o.body = parsed || body; }
    if(p.note) o.note = p.note;
    if(p.rebuilt) o.rebuilt = p.rebuilt;
    return o;
  };
  return {time: new Date(c.ts).toISOString(), kind: c.kind, from: c.from, to: c.to, method: c.method || null,
          endpoint: c.endpoint || null, title: c.title || null, status: c.status != null ? c.status : null,
          duration_ms: c.ms != null ? c.ms : null, source_log: c.src || null, request: side(c.req), response: side(c.resp)};
}

function contractsSection(tr){
  return '<details class="section" id="ctfold"><summary class="section-head"><h2>Контракты</h2>' +
    '<span class="hint">вызовы между сервисами по порядку — что ушло и что вернулось, как это записано в логах; нажмите, чтобы раскрыть</span></summary>' +
    '<div id="ctwrap"></div></details>';
}

function wireContracts(tr, segOf){
  CT.tr = tr; CT.list = null; CT.segOf = segOf; CT.seg = 'all';
  if(!CT.kinds){ CT.kinds = {}; Object.keys(CONTRACT_KINDS).forEach(k => CT.kinds[k] = !CONTRACT_HIDDEN[k]); }
  const fold = $('#ctfold');
  if(!fold) return;
  fold.addEventListener('toggle', () => { if(fold.open) drawContracts(); });
}
function ctSetSeg(seg){
  CT.seg = seg;
  const fold = $('#ctfold');
  if(fold && fold.open) drawContracts();
}
function ctVisible(){
  return CT.list.filter(c => CT.kinds[c.kind] !== false &&
    (CT.seg === 'all' || !CT.segOf || String(CT.segOf(c.ts)) === String(CT.seg)));
}
function drawContracts(){
  const host = $('#ctwrap');
  if(!host || !CT.tr) return;
  if(!CT.list){
    try { CT.list = extractContracts(CT.tr.records); }
    catch(e){ CT.list = []; host.innerHTML = '<div class="empty">Не удалось разобрать контракты: ' + esc(e.message) + '</div>'; return; }
  }
  const all = CT.list;
  if(!all.length){ host.innerHTML = '<div class="empty">В записях этого трейса не нашлось вызовов между сервисами.</div>'; return; }
  const inSeg = all.filter(c => CT.seg === 'all' || !CT.segOf || String(CT.segOf(c.ts)) === String(CT.seg));
  const cnt = {};
  inSeg.forEach(c => cnt[c.kind] = (cnt[c.kind] || 0) + 1);
  const vis = ctVisible();
  const t0 = CT.tr.records.length ? CT.tr.records[0].ts : (vis[0] || all[0]).ts;

  // the route: every distinct caller → callee pair, in the order it first happened
  const edges = [], seen = new Map();
  vis.forEach((c, i) => {
    const k = c.from + '\u0000' + c.to;
    if(!seen.has(k)){ seen.set(k, edges.length); edges.push({from: c.from, to: c.to, kind: c.kind, n: 0, first: i}); }
    edges[seen.get(k)].n++;
  });

  const filters = Object.keys(CONTRACT_KINDS).filter(k => cnt[k]).map(k =>
    '<button type="button" class="ctf" data-k="' + k + '" aria-pressed="' + (CT.kinds[k] !== false) + '"' +
    (CONTRACT_HIDDEN[k] ? ' title="по умолчанию скрыто — внутренняя кухня"' : '') + '>' +
    esc(CONTRACT_KINDS[k]) + '<span class="n">' + cnt[k] + '</span></button>').join('');

  const route = edges.length ? '<ol class="ctroute">' + edges.map(e =>
    '<li data-first="' + e.first + '"><span class="chip ' + (CT_CHIP[e.kind] || 'c-sys') + '">' + esc(CONTRACT_KINDS[e.kind] || e.kind) + '</span>' +
    '<span class="who">' + esc(e.from) + '</span><span class="arr">→</span><span class="who">' + esc(e.to) + '</span>' +
    (e.n > 1 ? '<span class="times">×' + e.n + '</span>' : '') + '</li>').join('') + '</ol>' : '';

  const rows = vis.map((c, i) =>
    '<details class="ct" data-i="' + all.indexOf(c) + '" id="ct' + i + '"><summary>' +
      '<span class="ctno">' + (i + 1) + '</span>' +
      '<span class="ctclock">' + esc(fmtAbs(c.ts)) + '<span class="rel">' + esc(fmtRel(Math.max(0, (c.ts - t0) / 1000))) + '</span></span>' +
      '<span class="cthop"><span class="chip ' + (CT_CHIP[c.kind] || 'c-sys') + '">' + esc(CONTRACT_KINDS[c.kind] || c.kind) + '</span>' +
        '<span class="who">' + esc(c.from) + '</span><span class="arr">→</span><span class="who">' + esc(c.to) + '</span>' +
        '<span class="ctep">' + esc([c.method, c.endpoint].filter(Boolean).join(' ') || c.title || '') + '</span>' +
        (c.title && (c.method || c.endpoint) && String(c.endpoint || '').indexOf(c.title.replace(/^tools\/call /, '')) < 0 ? '<span class="cttitle">' + esc(c.title) + '</span>' : '') +
        ((c.req && c.req.rebuilt) ? '<span class="ctflag" title="тело восстановлено по соседнему логу">восстановлено</span>' : '') +
      '</span>' +
      '<span class="ctres">' + ctStatus(c) + (c.ms != null ? '<span class="ctms">' + esc(fmtMs(c.ms)) + '</span>' : '') + '</span>' +
    '</summary><div class="ctbody"></div></details>').join('');

  const hidden = inSeg.length - vis.length;
  host.innerHTML =
    '<div class="ctbar">' + filters +
      '<span class="headtools">' +
        '<button type="button" class="foldbtn" id="ctopen">раскрыть все</button>' +
        '<button type="button" class="foldbtn close" id="ctshut">свернуть все</button>' +
        '<button type="button" class="foldbtn dl" id="ctdl" title="видимые контракты одним JSON-файлом">скачать JSON</button>' +
      '</span></div>' +
    '<div class="ctsum">' + vis.length + ' вызовов' + (hidden ? ' · ещё ' + hidden + ' скрыто фильтром' : '') +
      ' · маршрут — пары «кто → кого» в порядке первого появления, нажмите пару, чтобы перейти к первому вызову</div>' +
    route +
    '<div class="ctlist">' + (rows || '<div class="empty">Под выбранные фильтры ничего не попало.</div>') + '</div>';

  host.querySelectorAll('.ctf').forEach(b => b.onclick = () => {
    CT.kinds[b.dataset.k] = b.getAttribute('aria-pressed') !== 'true';
    drawContracts();
  });
  const fill = d => {
    const body = d.querySelector('.ctbody');
    if(body.innerHTML) return;
    const c = all[+d.dataset.i];
    body.innerHTML = ctBodyHtml(c);
    body.querySelectorAll('.ctcopy').forEach(btn => btn.onclick = ev => {
      ev.preventDefault();
      const p = c[btn.dataset.side];
      ctCopy(String(p && p.body != null ? p.body : ''), btn);
    });
  };
  const items = Array.from(host.querySelectorAll('details.ct'));
  items.forEach(d => d.addEventListener('toggle', () => { if(d.open) fill(d); }));
  $('#ctopen').onclick = () => items.forEach(d => { fill(d); d.open = true; });
  $('#ctshut').onclick = () => items.forEach(d => { d.open = false; });
  $('#ctdl').onclick = () => downloadBlob(JSON.stringify(vis.map(ctExport), null, 2), 'application/json;charset=utf-8',
    'contracts_' + String(CT.tr.traceId || 'trace').slice(0, 16) + '_' + tstamp() + '.json');
  host.querySelectorAll('.ctroute li').forEach(li => li.onclick = () => {
    const d = document.getElementById('ct' + li.dataset.first);
    if(!d) return;
    fill(d); d.open = true;
    d.scrollIntoView({behavior: 'smooth', block: 'center'});
    d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash');
  });
}
function ctCopy(text, btn){
  const done = ok => { const t = btn.textContent; btn.textContent = ok ? 'скопировано' : 'не вышло'; setTimeout(() => btn.textContent = t, 1400); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => done(true), () => done(legacyCopy(text)));
  } else done(legacyCopy(text));
  function legacyCopy(t){
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch(e){}
    ta.remove(); return ok;
  }
}
