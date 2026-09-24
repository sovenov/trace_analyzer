/* «Сырые записи»: таблица всех записей трейса с поиском по сообщению и по полям. */
/* The structured fields of a record — everything the collector kept besides the message
   itself and the bookkeeping nobody reads. Built on demand and cached per record. */
const RAW_SKIP = /^(message|msg|@timestamp|timestamp|@version|_id|_index|_score|_ignored|_p|app_host|pod_name|pod_id|namespace|logCollectorSystemLabel|app_version|file_name|line|thread|function|type)$|^resource\./;
const RAW_PAYLOAD_RE = /body|payload|request|response|parameters|result|metadata|headers\./i;
const rawFieldsCache = new WeakMap();
function rawFields(r){
  let f = rawFieldsCache.get(r);
  if(f) return f;
  f = {};
  const raw = r.raw || {};
  Object.keys(raw).forEach(k => {
    const v = raw[k];
    if(RAW_SKIP.test(k) || v == null || v === '' || v === '(empty)' || v === '-') return;
    if(typeof v === 'string' && v === r.msg) return;
    f[k] = v;
  });
  rawFieldsCache.set(r, f);
  return f;
}
const rawTextCache = new WeakMap();
function rawFieldsText(r){
  let t = rawTextCache.get(r);
  if(t == null){ try { t = JSON.stringify(rawFields(r)); } catch(e){ t = ''; } rawTextCache.set(r, t); }
  return t;
}
function rawFieldsPre(r){
  const f = rawFields(r);
  const lines = Object.keys(f).map(k => {
    const v = f[k];
    let txt = typeof v === 'string' ? v : JSON.stringify(v);
    if(typeof v === 'string' && /^\s*[\[{]/.test(v)) txt = prettyInfo(v).text;
    return k + ': ' + txt;
  });
  return '<pre class="json rawfpre">' + esc(lines.join('\n')) + '</pre>';
}

function wireRaw(tr){
  const apps = Array.from(new Set(tr.records.map(r => r.app))).sort();
  const lvls = Array.from(new Set(tr.records.map(r => r.level))).sort();
  $('#fapp').innerHTML = '<option value="">все сервисы</option>' + apps.map(a => '<option>' + esc(a) + '</option>').join('');
  $('#flvl').innerHTML = '<option value="">все уровни</option>' + lvls.map(a => '<option>' + esc(a) + '</option>').join('');

  function draw(){
    const q = $('#q').value.trim().toLowerCase();
    const fa = $('#fapp').value, fl = $('#flvl').value;
    // the search looks at the record's fields too: newer services keep the request body,
    // headers and the client profile there, next to a message as short as "[ACCESS] Request"
    const rows = tr.records.filter(r =>
      (!fa || r.app === fa) && (!fl || r.level === fl) &&
      (!q || r.msg.toLowerCase().indexOf(q) >= 0 || rawFieldsText(r).toLowerCase().indexOf(q) >= 0));
    // nothing is capped here: every matching record, with its message in full
    $('#rawtable').innerHTML =
      '<table class="raw"><thead><tr><th>время</th><th>сервис</th><th>ур.</th><th>сообщение</th></tr></thead><tbody>' +
      rows.map(r => {
        const f = rawFields(r), keys = Object.keys(f);
        const hit = q && r.msg.toLowerCase().indexOf(q) < 0;
        const payload = keys.filter(k => RAW_PAYLOAD_RE.test(k));
        return '<tr><td>' + esc(r.t ? r.t.toLocaleTimeString('ru-RU') + '.' + String(r.t.getMilliseconds()).padStart(3, '0') : '—') + '</td>' +
          '<td>' + esc(r.app.replace(/^alfagen-/, '')) + '</td>' +
          '<td class="lvl lvl-' + esc(r.level) + '">' + esc(r.level) + '</td>' +
          '<td class="msg">' + esc(r.msg) +
          (keys.length ? '<details class="rawf"' + (hit ? ' open' : '') + ' data-i="' + tr.records.indexOf(r) + '"><summary>поля записи · ' + keys.length +
            (payload.length ? '<span class="rawkeys">' + esc(payload.slice(0, 4).join(', ') + (payload.length > 4 ? '…' : '')) + '</span>' : '') +
            (hit ? '<span class="rawhit">найдено в полях</span>' : '') + '</summary>' +
            (hit ? rawFieldsPre(r) : '') + '</details>' : '') +
          '</td></tr>';
      }).join('') +
      '</tbody></table>' +
      (rows.length ? '' : '<div class="empty">Ничего не найдено.</div>');
    $('#rawtable').querySelectorAll('details.rawf').forEach(d => d.addEventListener('toggle', () => {
      if(d.open && !d.querySelector('pre')) d.insertAdjacentHTML('beforeend', rawFieldsPre(tr.records[+d.dataset.i]));
    }));
  }
  ['#q','#fapp','#flvl'].forEach(s => { $(s).oninput = draw; $(s).onchange = draw; });

  // The table is the heaviest thing on the page — thousands of rows with full message
  // text. Build it the first time the section is opened, not on every render.
  const fold = $('#rawfold');
  if(fold) fold.addEventListener('toggle', () => { if(fold.open && !$('#rawtable').innerHTML) draw(); });
  else draw();
}
