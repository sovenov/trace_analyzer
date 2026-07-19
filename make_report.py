#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Собирает все выгрузки Kibana (*.json) из директории в один самодостаточный
HTML-отчёт «Разбор трейса» — полностью предзаполненный, без перетаскивания файлов.

Скрипт НЕ дублирует логику разбора: он переиспользует парсер и вёрстку из
index.html. Файлы логов встраиваются в страницу как JSON, а маленький бутстрап
прогоняет их через тот же самый код, что работает в браузере. Итог идентичен
ручному перетаскиванию файлов в index.html.

Запуск (Python 3.8+):
    python make_report.py [директория_с_логами] [--template путь/к/index.html]

  • без аргументов берётся текущая директория;
  • index.html по умолчанию ищется рядом со скриптом, затем в текущей директории;
  • результат: <директория>/trace_report_YYYYmmdd_HHMMSS.html
"""

import argparse
import glob
import json
import os
import sys
import traceback
from datetime import datetime


class ReportError(Exception):
    """Ожидаемая ошибка с понятным пользователю сообщением (нет логов и т.п.)."""


def pause():
    """Не дать консоли закрыться сразу. В неинтерактивном режиме (пайп) — просто выходим."""
    try:
        input("\nНажмите Enter, чтобы закрыть окно...")
    except (EOFError, KeyboardInterrupt):
        pass


def read_json(path):
    """utf-8-sig снимает BOM, если он есть, и работает без него."""
    with open(path, "r", encoding="utf-8-sig") as fh:
        return json.load(fh)


def collect_logs(log_dir):
    """Все *.json в директории (без рекурсии), отсортированы по имени.
    Окончательный порядок файлов всё равно восстановит buildTraces по unixtime
    в имени — здесь сортировка только для стабильного вывода."""
    paths = sorted(
        p for p in glob.glob(os.path.join(log_dir, "*.json")) if os.path.isfile(p)
    )
    good, broken = [], []
    for path in paths:
        name = os.path.basename(path)
        try:
            good.append({"name": name, "json": read_json(path)})
        except Exception as exc:  # файл не читается как JSON — покажем в отчёте
            broken.append({"name": name, "why": "не разбирается как JSON: %s" % exc})
    return good, broken, paths


def find_template(explicit):
    if explicit:
        if not os.path.isfile(explicit):
            raise ReportError("Не найден шаблон: %s" % explicit)
        return explicit
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, "index.html"), os.path.join(os.getcwd(), "index.html")):
        if os.path.isfile(cand):
            return cand
    raise ReportError(
        "Не найден index.html рядом со скриптом или в текущей директории.\n"
        "Укажите его явно: --template путь/к/index.html"
    )


def make_data_block(good, broken):
    payload = {"files": good, "broken": broken}
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    # '</' -> '<\/' : в JSON \/ означает '/', поэтому JSON.parse вернёт исходный
    # текст, но HTML-парсер уже не увидит '</script>' внутри блока данных.
    text = text.replace("</", "<\\/")
    return '<script id="__TRACE_DATA__" type="application/json">' + text + "</script>\n"


# Отдельный <script>, который выполняется ПОСЛЕ основного: он видит его глобальные
# функции (normalizeFile, buildTraces, renderFiles, renderTabs, renderReport) и STATE,
# и повторяет то, что делает loadFiles(), но по встроенным данным.
BOOTSTRAP = r"""
<script>
(function(){
  var node = document.getElementById('__TRACE_DATA__');
  if(!node) return;
  var payload;
  try { payload = JSON.parse(node.textContent); }
  catch(e){
    document.getElementById('fatal').innerHTML =
      '<div class="err-box">Встроенные данные повреждены: ' + e + '</div>';
    return;
  }
  var entries = [], broken = (payload.broken || []).slice();
  (payload.files || []).forEach(function(f){
    try {
      var norm = normalizeFile(f.json);
      if(!norm){ broken.push({name: f.name, why: 'не найден массив logs'}); return; }
      entries.push({name: f.name, logs: norm.logs, url: norm.url});
    } catch(err){
      broken.push({name: f.name, why: 'ошибка разбора'});
    }
  });
  var brokenChips = broken.map(function(b){ return {name: b.name, bad: b.why}; });
  if(!entries.length){
    document.getElementById('fatal').innerHTML =
      '<div class="err-box">Ни один файл логов не удалось прочитать.</div>';
    renderFiles(brokenChips);
    return;
  }
  var built = buildTraces(entries);
  STATE.traces = built.traces;
  STATE.files = built.files;
  STATE.active = 0;
  renderFiles(built.files.concat(brokenChips));
  renderTabs();
  renderReport();
})();
</script>
"""


def build_html(template_html, good, broken):
    if "</body>" not in template_html:
        raise ReportError("Шаблон не похож на index.html: нет </body>.")
    injected = make_data_block(good, broken) + BOOTSTRAP + "</body>"
    return template_html.replace("</body>", injected, 1)


def main():
    ap = argparse.ArgumentParser(
        description="Собрать самодостаточный HTML-отчёт по логам Kibana из директории."
    )
    ap.add_argument("directory", nargs="?", default=".",
                    help="директория с файлами логов (по умолчанию — текущая)")
    ap.add_argument("--template", default=None,
                    help="путь к index.html (по умолчанию — рядом со скриптом)")
    args = ap.parse_args()

    log_dir = os.path.abspath(args.directory)
    if not os.path.isdir(log_dir):
        raise ReportError("Не директория: %s" % log_dir)

    good, broken, paths = collect_logs(log_dir)
    if not paths:
        raise ReportError("В директории нет *.json файлов: %s" % log_dir)
    if not good:
        raise ReportError("Ни один *.json не удалось прочитать как JSON (%d файл(ов))." % len(paths))

    template_path = find_template(args.template)
    with open(template_path, "r", encoding="utf-8-sig") as fh:
        template_html = fh.read()

    html = build_html(template_html, good, broken)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_name = "trace_report_%s.html" % stamp
    out_path = os.path.join(log_dir, out_name)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    print("Директория : %s" % log_dir)
    print("Шаблон     : %s" % template_path)
    print("Файлов     : %d прочитано, %d с ошибкой" % (len(good), len(broken)))
    for f in good:
        print("   + %s" % f["name"])
    for b in broken:
        print("   ! %s — %s" % (b["name"], b["why"]))
    print("Отчёт      : %s" % out_path)


if __name__ == "__main__":
    exit_code = 0
    try:
        main()
        print("\nГотово.")
    except ReportError as err:
        print("\nОШИБКА: %s" % err)
        exit_code = 1
    except SystemExit as err:  # argparse (--help / неверные аргументы)
        exit_code = err.code if isinstance(err.code, int) else 1
    except Exception:  # непредвиденная ситуация — покажем полностью
        print("\nНепредвиденная ошибка:")
        traceback.print_exc()
        exit_code = 1
    finally:
        pause()
    sys.exit(exit_code)
