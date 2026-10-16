/* «Сырые записи»: таблица всех записей трейса с поиском по тексту сообщения. */
function wireRaw(tr){
  const apps = Array.from(new Set(tr.records.map(r => r.app))).sort();
  const lvls = Array.from(new Set(tr.records.map(r => r.level))).sort();
  $('#fapp').innerHTML = '<option value="">все сервисы</option>' + apps.map(a => '<option>' + esc(a) + '</option>').join('');
  $('#flvl').innerHTML = '<option value="">все уровни</option>' + lvls.map(a => '<option>' + esc(a) + '</option>').join('');

  function draw(){
    const q = $('#q').value.trim().toLowerCase();
    const fa = $('#fapp').value, fl = $('#flvl').value;
    const rows = tr.records.filter(r =>
      (!fa || r.app === fa) && (!fl || r.level === fl) && (!q || r.msg.toLowerCase().indexOf(q) >= 0));
    // nothing is capped here: every matching record, with its message in full
    $('#rawtable').innerHTML =
      '<table class="raw"><thead><tr><th>время</th><th>сервис</th><th>ур.</th><th>сообщение</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + esc(r.t ? r.t.toLocaleTimeString('ru-RU') + '.' + String(r.t.getMilliseconds()).padStart(3, '0') : '—') + '</td>' +
        '<td>' + esc(r.app.replace(/^alfagen-/, '')) + '</td>' +
        '<td class="lvl lvl-' + esc(r.level) + '">' + esc(r.level) + '</td>' +
        '<td class="msg">' + esc(r.msg) + '</td></tr>').join('') +
      '</tbody></table>' +
      (rows.length ? '' : '<div class="empty">Ничего не найдено.</div>');
  }
  ['#q','#fapp','#flvl'].forEach(s => { $(s).oninput = draw; $(s).onchange = draw; });

  // The table is the heaviest thing on the page — thousands of rows with full message
  // text. Build it the first time the section is opened, not on every render.
  const fold = $('#rawfold');
  if(fold) fold.addEventListener('toggle', () => { if(fold.open && !$('#rawtable').innerHTML) draw(); });
  else draw();
}
