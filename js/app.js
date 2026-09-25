/* Состояние страницы, загрузка файлов (в т.ч. потоковая для больших выгрузок),
   сохранение отчёта, экспорт трейсов. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let STATE = {traces: [], files: [], active: 0, raw: [], brokenFiles: []};

// the scripts are running — the notice for the case they are not goes away
{ const nj = $('#nojs'); if(nj) nj.remove(); }

const drop = $('#drop'), picker = $('#picker');
// Files are taken wherever on the page they are dropped, not only on the zone: anywhere
// else the browser would open the file itself, and inside an iframe (Confluence) that
// replaces the analyzer with the raw JSON.
const hasFiles = e => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
let dragDepth = 0;
window.addEventListener('dragenter', e => { if(!hasFiles(e)) return; e.preventDefault(); dragDepth++; drop.classList.add('hot'); });
window.addEventListener('dragover', e => { if(!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', e => {
  if(!hasFiles(e)) return;
  if(--dragDepth <= 0){ dragDepth = 0; drop.classList.remove('hot'); }
});
window.addEventListener('drop', e => {
  if(!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; drop.classList.remove('hot');
  if(e.dataTransfer.files && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});
drop.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); picker.click(); } });

// embedded in another page (a Confluence iframe): the frame is narrow and the host page
// may catch dragged files itself — offer the analyzer in a tab of its own
if(window.top !== window.self){
  const own = /^(https?|file):/.test(location.protocol) ? location.href.split('#')[0] : 'https://sovenov.github.io/trace_analyzer/';
  const mh = document.querySelector('.masthead');
  if(mh) mh.insertAdjacentHTML('beforeend', '<a class="popout" href="' + esc(own) + '" target="_blank" rel="noopener">открыть в отдельной вкладке ↗</a>');
}
picker.addEventListener('change', () => loadFiles(picker.files));

/* ---------- streaming loader ----------
   A Kibana dump can run to gigabytes. Reading it with file.text() + JSON.parse() needs
   the whole file as one string (V8 caps a string near 512M characters) plus the whole
   object tree at once, plus a second copy kept for "Сохранить отчёт" — the tab dies with
   Out of Memory long before 1 GB. So the file is read as a byte stream, the "logs"
   array (or a bare top-level array, or Elasticsearch hits.hits) is found by a tiny
   bracket/string scanner, and every record is JSON.parse'd on its own as soon as it
   closes. Peak memory is the records themselves, nothing else. */
const BIG_DUMP = 150 * 1048576;      // above this (all files together): lean mode
// fields no part of the analyzer reads; on a big dump they are ~15% of every record
const DEAD_FIELDS = ['app_host', 'pod_name', 'pod_id', '_index', '_score', '_ignored', '@version', '_p',
  'logCollectorSystemLabel', 'namespace', 'app_version', 'file_name', 'line', 'thread', 'function'];
function slimRecord(l){
  if(!l || typeof l !== 'object') return l;
  for(const k in l){
    const v = l[k];
    if(v === null || v === '' || DEAD_FIELDS.indexOf(k) >= 0) delete l[k];
  }
  return l;
}
async function streamLogs(file, onProgress){
  const reader = file.stream().getReader();
  const dec = new TextDecoder('utf-8');
  const logs = [];
  let depth = 0, inStr = false, esc = false;
  let target = -1, hitsShape = false, finished = false;
  let inEl = false, elStart = -1, carry = '';
  let strStart = -1, lastStr = '', keyCarry = '';
  const keys = [], types = [];
  let read = 0, bad = 0, lastTick = 0;
  const emit = text => {
    let o;
    try { o = JSON.parse(text); } catch(e){ bad++; return; }
    if(hitsShape && o && o._source) o = Object.assign({}, o._source, {_id: o._id});
    logs.push(o);
  };
  const scan = s => {
    const n = s.length;
    for(let i = 0; i < n; i++){
      const c = s.charCodeAt(i);
      if(inStr){
        if(esc) esc = false;
        else if(c === 92) esc = true;
        else if(c === 34){
          inStr = false;
          if(strStart >= 0){ lastStr = keyCarry + s.slice(strStart, i); strStart = -1; keyCarry = ''; }
        }
        continue;
      }
      if(c === 34){ inStr = true; strStart = (target < 0 && depth <= 2) ? i + 1 : -1; continue; }
      if(target < 0 && c === 58){ keys[depth] = lastStr; continue; }
      if(c === 123 || c === 91){
        if(depth === target && !inEl){ inEl = true; elStart = i; }
        depth++; types[depth] = c;
        if(target < 0 && c === 91){
          if(depth === 1) target = 1;
          else if(depth === 2 && types[1] === 123 && keys[1] === 'logs') target = 2;
          else if(depth === 3 && keys[1] === 'hits' && keys[2] === 'hits'){ target = 3; hitsShape = true; }
        }
        continue;
      }
      if(c === 125 || c === 93){
        depth--;
        if(inEl && depth === target){
          emit(carry ? carry + s.slice(0, i + 1) : s.slice(elStart, i + 1));
          carry = ''; inEl = false; elStart = -1;
        } else if(target >= 0 && depth < target){ finished = true; return; }
      }
    }
    if(inEl){ carry += elStart >= 0 ? s.slice(elStart) : s; elStart = -1; }
    // a top-level key cut by the chunk edge: keep its head and go on reading it
    if(inStr && strStart >= 0){ keyCarry += s.slice(strStart); strStart = 0; }
  };
  for(;;){
    const r = await reader.read();
    if(r.done) break;
    read += r.value.byteLength;
    if(!finished){
      scan(dec.decode(r.value, {stream: true}));
    }
    const now = Date.now();
    if(onProgress && now - lastTick > 150){ lastTick = now; onProgress(read); await new Promise(res => setTimeout(res, 0)); }
    if(finished){ try { reader.cancel(); } catch(e){} break; }
  }
  if(target < 0) return null;
  return {logs: logs, bad: bad};
}

const fmtSize = b => b < 1048576 ? (b / 1024).toFixed(0) + ' КБ' :
  b < 1073741824 ? (b / 1048576).toFixed(0) + ' МБ' : (b / 1073741824).toFixed(2).replace('.', ',') + ' ГБ';
function setStatus(html){
  let el = $('#loadstatus');
  if(!el){
    el = document.createElement('div'); el.id = 'loadstatus'; el.className = 'loadstatus';
    const host = $('#fatal'); host.parentNode.insertBefore(el, host);
  }
  el.innerHTML = html || '';
  el.style.display = html ? '' : 'none';
}
const nextFrame = () => new Promise(res => setTimeout(res, 30));

async function loadFiles(list){
  const files = Array.from(list || []);
  if(!files.length) return;
  $('#fatal').innerHTML = '';
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const lean = totalBytes > BIG_DUMP;
  const entries = [], broken = [], raw = [];
  let doneBytes = 0, badRecs = 0;
  for(const f of files){
    try{
      const res = await streamLogs(f, got => setStatus(
        'Читаю <b>' + esc(f.name) + '</b>: ' + fmtSize(doneBytes + got) + ' из ' + fmtSize(totalBytes) +
        ' (' + Math.floor((doneBytes + got) / Math.max(totalBytes, 1) * 100) + '%)'));
      doneBytes += f.size;
      if(!res){ broken.push({name: f.name, why: 'не найден массив logs'}); continue; }
      badRecs += res.bad;
      // the originals are what "Сохранить отчёт" and the per-trace export write back;
      // on a big dump there is no keeping a second copy, so both work off the records
      const logs = res.logs.map(l => {
        const o = liftRecord(l);
        return lean ? slimRecord(o === l ? o : Object.assign({}, o)) : o;
      });
      entries.push({name: f.name, logs: logs, url: ''});
      if(!lean) raw.push({name: f.name, json: {url: '', logs: res.logs}});
      res.logs = null;
    }catch(err){
      doneBytes += f.size;
      broken.push({name: f.name, why: 'файл не разбирается как JSON'});
    }
  }
  const recCount = entries.reduce((a, e) => a + e.logs.length, 0);
  setStatus('Разбираю ' + recCount.toLocaleString('ru-RU') + ' записей по трейсам…');
  await nextFrame();
  STATE.raw = raw;
  STATE.brokenFiles = broken.slice();
  if(!entries.length){
    $('#fatal').innerHTML = '<div class="err-box">Ни один файл не удалось прочитать. Нужен JSON вида <code>{"logs":[…]}</code> — ровно то, что отдаёт выгрузка из Kibana.</div>';
    renderFiles(broken.map(b => ({name: b.name, bad: b.why})));
    return;
  }
  let built;
  try { built = buildTraces(entries); }
  catch(err){
    setStatus('');
    $('#fatal').innerHTML = '<div class="err-box">Не удалось разобрать выгрузку: ' + esc(err && err.message || err) + '</div>';
    return;
  }
  STATE.traces = built.traces;
  STATE.files = built.files;
  STATE.active = built.active;
  STATE.lean = lean;
  setStatus('');
  renderFiles(built.files.concat(broken.map(b => ({name: b.name, bad: b.why}))));
  renderTabs();
  renderReport();
  const notes = [];
  if(lean) notes.push('Большая выгрузка (' + fmtSize(totalBytes) + '): загружена в экономном режиме — пустые и служебные поля записей отброшены, «Сохранить отчёт» отключён (такой отчёт не открылся бы в браузере). Выгрузка логов отдельного traceId работает.');
  if(badRecs) notes.push('Не разобрано записей: ' + badRecs.toLocaleString('ru-RU') + ' (битый JSON внутри массива).');
  if(notes.length) $('#fatal').innerHTML = notes.map(t => '<div class="note-box">' + esc(t) + '</div>').join('');
  if(broken.length){
    $('#fatal').innerHTML += '<div class="err-box">Пропущено файлов: ' + broken.length + '. Проверьте, что это выгрузки Kibana в JSON.</div>';
  }
  $('#report').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function renderFiles(files){
  const box = $('#files');
  if(!files.length){ box.innerHTML = ''; return; }
  const dt = ms => new Date(ms).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'});
  const tm = ms => new Date(ms).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  const chips = files.map(f => {
    if(f.bad) return '<span class="file-chip bad">' + esc(f.name) + ' — ' + esc(f.bad) + '</span>';
    // show the period the logs actually cover, not when the file was downloaded
    let period;
    if(f.logMinTs != null){
      const sameDay = new Date(f.logMinTs).toDateString() === new Date(f.logMaxTs).toDateString();
      period = sameDay ? dt(f.logMinTs) + '–' + tm(f.logMaxTs) : dt(f.logMinTs) + ' – ' + dt(f.logMaxTs);
    } else {
      period = f.key ? 'скачан ' + new Date(f.key).toLocaleString('ru-RU') : 'без метки времени';
    }
    const dl = f.key ? 'скачан ' + new Date(f.key).toLocaleString('ru-RU') : '';
    return '<span class="file-chip" title="' + esc(dl) + '"><span class="ord">' + f.order + '</span>' +
           '<b>' + esc(f.name) + '</b>' + esc(period) + ' · ' + (f.logs ? f.logs.length : 0) + ' зап.' +
           (f.dupes ? ' · −' + f.dupes + ' дубл.' : '') + '</span>';
  }).join('');
  box.innerHTML = chips +
    (STATE.raw && STATE.raw.length ? '<button class="reset save" id="save">💾 Сохранить отчёт</button>' : '') +
    '<button class="reset" id="reset">Очистить</button>';
  const r = $('#reset');
  if(r) r.onclick = () => {
    STATE = {traces: [], files: [], active: 0, raw: [], brokenFiles: []};
    box.innerHTML = ''; $('#report').innerHTML = '';
    $('#tabs').classList.add('hidden'); $('#tabs').innerHTML = '';
    $('#budget').innerHTML = ''; BUDGET.for = null;
    $('#fatal').innerHTML = ''; picker.value = '';
  };
  const sv = $('#save');
  if(sv) sv.onclick = saveReport;
}

/* Inner JS of the bootstrap embedded into a saved copy: on open it reads the
   inlined logs and re-renders the whole report.
   Set as a <script> element's textContent, so no closing-tag escaping is needed
   here (there is deliberately no "</scr"+"ipt>" literal in this string). */
const BOOTSTRAP_JS =
'(function(){\n' +
'  var node = document.getElementById("__TRACE_DATA__");\n' +
'  if(!node) return;\n' +
'  var payload;\n' +
'  try { payload = JSON.parse(node.textContent); }\n' +
'  catch(e){ document.getElementById("fatal").innerHTML = "<div class=\\"err-box\\">Встроенные данные повреждены: " + e + "</div>"; return; }\n' +
'  var entries = [], broken = (payload.broken || []).slice();\n' +
'  (payload.files || []).forEach(function(f){\n' +
'    try {\n' +
'      var norm = normalizeFile(f.json);\n' +
'      if(!norm){ broken.push({name: f.name, why: "не найден массив logs"}); return; }\n' +
'      entries.push({name: f.name, logs: norm.logs, url: norm.url});\n' +
'    } catch(err){ broken.push({name: f.name, why: "ошибка разбора"}); }\n' +
'  });\n' +
'  var brokenChips = broken.map(function(b){ return {name: b.name, bad: b.why}; });\n' +
'  if(!entries.length){ document.getElementById("fatal").innerHTML = "<div class=\\"err-box\\">Ни один файл логов не удалось прочитать.</div>"; renderFiles(brokenChips); return; }\n' +
'  var built = buildTraces(entries);\n' +
'  STATE.raw = payload.files || [];\n' +
'  STATE.brokenFiles = (payload.broken || []).slice();\n' +
'  STATE.traces = built.traces; STATE.files = built.files; STATE.active = built.active;\n' +
'  renderFiles(built.files.concat(brokenChips));\n' +
'  renderTabs(); renderReport();\n' +
'})();';

function tstamp(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
         '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/* Snapshot the page into a single self-contained HTML with the loaded logs inlined.
   We build the data + bootstrap as real DOM <script> nodes and append them to the
   clone — no string surgery on the serialized HTML, so a stray body-close token
   sitting inside this script's own source can never be matched by mistake.
   The analyzer itself lives in css/ and js/ files; a saved report has to open on its
   own, so their text is put inline. Served over http(s) (GitHub Pages) the files can be
   read back; opened straight from disk (file://) the browser forbids reading them, and
   the copy keeps absolute links to them instead — it then opens on this computer only. */
async function readSource(url){
  try {
    const r = await fetch(url, {cache: 'no-store'});
    return r.ok ? await r.text() : null;
  } catch(e){ return null; }
}
async function saveReport(){
  if(!STATE.raw || !STATE.raw.length) return;

  const clone = document.documentElement.cloneNode(true);
  // drop anything from a previous save so re-saving a copy stays idempotent
  clone.querySelectorAll('#__TRACE_DATA__, #__TRACE_BOOTSTRAP__, .popout').forEach(n => n.remove());
  // blank runtime containers — the bootstrap refills them on open
  ['#files', '#report', '#fatal', '#budget'].forEach(sel => { const n = clone.querySelector(sel); if(n) n.innerHTML = ''; });
  const tabsN = clone.querySelector('#tabs'); if(tabsN){ tabsN.innerHTML = ''; tabsN.classList.add('hidden'); }
  const pick = clone.querySelector('#picker'); if(pick) pick.removeAttribute('value');
  const body = clone.querySelector('body');

  let portable = true;
  for(const link of Array.from(clone.querySelectorAll('link[rel="stylesheet"][href]'))){
    const url = new URL(link.getAttribute('href'), location.href).href;
    const txt = await readSource(url);
    if(txt == null){ link.setAttribute('href', url); portable = false; continue; }
    const st = document.createElement('style');
    st.textContent = txt;
    link.replaceWith(st);
  }
  for(const sc of Array.from(clone.querySelectorAll('script[src]'))){
    const url = new URL(sc.getAttribute('src'), location.href).href;
    const txt = await readSource(url);
    if(txt == null){ sc.setAttribute('src', url); portable = false; continue; }
    const inl = document.createElement('script');
    // a closing tag spelled inside the source would end the inline script early;
    // '<\/' means the same thing in every place it can appear in JS
    inl.textContent = txt.replace(/<\/script/gi, '<\\/script');
    sc.replaceWith(inl);
  }

  const dataScript = document.createElement('script');
  dataScript.id = '__TRACE_DATA__';
  dataScript.type = 'application/json';
  // '</' -> '<\/' : keeps a literal closing tag inside the logs from ending the
  // <script> early; JSON.parse turns '\/' back into '/' when the copy opens.
  dataScript.textContent = JSON.stringify({
    files: STATE.raw,
    broken: (STATE.brokenFiles || []).map(b => ({name: b.name, why: b.why}))
  }).replace(/<\//g, '<\\/');
  body.appendChild(dataScript);

  const bootScript = document.createElement('script');
  bootScript.id = '__TRACE_BOOTSTRAP__';
  bootScript.textContent = BOOTSTRAP_JS;
  body.appendChild(bootScript);

  downloadBlob('<!DOCTYPE html>\n' + clone.outerHTML, 'text/html;charset=utf-8',
               'trace_report_' + tstamp() + '.html');
  if(!portable){
    const sv = $('#save');
    if(sv){
      const was = sv.textContent;
      sv.textContent = '💾 Сохранено — откроется только на этом компьютере';
      sv.title = 'Страница открыта с диска (file://), и браузер не даёт прочитать её css/js, чтобы вложить в отчёт. ' +
                 'Отчёт ссылается на эти файлы на вашем диске. Для отчёта, который можно отправить, сохраните его со страницы на GitHub Pages.';
      setTimeout(() => { sv.textContent = was; }, 6000);
    }
  }
}

function downloadBlob(text, mime, filename){
  const blob = new Blob([text], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* The documents exactly as Kibana handed them over, keyed by _id. A per-trace export
   ships those rather than the analyzer's normalized copies, so the file stays
   comparable with the original dump - and loads straight back in here. */
function rawById(){
  const map = new Map();
  (STATE.raw || []).forEach(f => {
    const j = f.json;
    const arr = Array.isArray(j) ? j
      : (j && Array.isArray(j.logs)) ? j.logs
      : (j && j.hits && Array.isArray(j.hits.hits))
        ? j.hits.hits.map(h => Object.assign({}, h._source, {_id: h._id}))
        : [];
    arr.forEach(l => { if(l && l._id != null && !map.has(l._id)) map.set(l._id, l); });
  });
  return map;
}

/* Every record of one trace, in its own file, in the shape the loader accepts. */
function exportTrace(i){
  const t = STATE.traces[i];
  if(!t) return;
  const src = rawById();
  // records are already in @timestamp order; fall back to the normalized copy when the
  // original is not in STATE.raw (a report opened from a saved copy)
  const logs = t.records.map(r => (r.raw && src.get(r.raw._id)) || r.raw);
  const slug = (t.traceId === NO_TRACE ? 'bez-traceid' : t.traceId).replace(/[^\w.-]+/g, '_');
  downloadBlob(JSON.stringify({url: '', logs: logs}), 'application/json;charset=utf-8',
               'trace_' + slug + '_' + tstamp() + '.json');
}

function uniqueTraceIds(traces){
  const ids = [], seen = new Set();
  const flat = [];
  (traces || []).forEach(t => { flat.push(t); (t && t.linked || []).forEach(l => flat.push({traceId: l.traceId})); });
  flat.forEach(t => {
    const id = String(t && t.traceId != null ? t.traceId : '').trim();
    if(!id || id === NO_TRACE || id === 'null' || id === '(empty)' || id === '-') return;
    // Hex trace ids are case-insensitive; preserve the spelling of the first occurrence
    // while still treating an upper-case copy as the same id.
    const key = /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : id;
    if(seen.has(key)) return;
    seen.add(key); ids.push(id);
  });
  return ids;
}

function exportUniqueTraceIds(){
  const ids = uniqueTraceIds(STATE.traces);
  if(!ids.length) return;
  downloadBlob(ids.join('\n') + '\n', 'text/plain;charset=utf-8',
               'traceids_unique_' + tstamp() + '.txt');
}

const DL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M8 1.8v7.4M4.7 6.2 8 9.5l3.3-3.3M2.6 13.2h10.8" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* A traceId identifies a row but does not describe it. What tells the rows apart at a
   glance is what was asked and by whom, so each one reads
   "<id> - <вопрос> - <cus> - <ФИО>"; missing parts are simply left out. */
function tabLabel(t){
  const ctx = t.meta.ctx || {};
  const q = (t.userQ && t.userQ.text ? String(t.userQ.text) : '').replace(/\s+/g, ' ').trim();
  const cus = (t.userQ && t.userQ.cus) || ctx.cus || '';
  const fio = [ctx.lastName, ctx.firstName, ctx.middleName].filter(Boolean).join(' ').trim()
              || String(ctx.nickname || '').trim();
  return {
    id: t.traceId,
    repeat: t.retry ? t.retry.index + '/' + t.retry.total : '',
    q: q.length > 200 ? q.slice(0, 200) + '…' : q,
    cus: String(cus || '').trim(),
    fio: fio
  };
}
