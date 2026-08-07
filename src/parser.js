/*
 * Парсер кредитного отчёта ОКБ / «Кредистория» (PDF).
 *
 * Работает поверх координатного текстового слоя PDF: pdf.js отдаёт набор
 * текстовых фрагментов с координатами, парсер восстанавливает из них строки
 * и таблицы.
 *
 * Один и тот же файл используется браузерным приложением и Node-тестами,
 * поэтому здесь нет ни DOM, ни файловой системы — только чистые функции.
 *
 * Проверен на форматах v3.8.2.0 и v3.19.0.0.
 */
(function (global) {
  'use strict';

  var MONTHS = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  // Колонки таблицы «Фактические платежи по договору»: строка дат, затем
  // четыре строки значений в этом порядке.
  var PAYMENT_FIELDS = ['amount', 'principal', 'interest', 'other'];

  // ---------------------------------------------------------------- утилиты

  function normSpaces(s) {
    return String(s)
      .replace(/[\u200b\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /*
   * ОКБ защищает отчёт от копирования, подменяя часть кириллицы похожими
   * латинскими буквами: «Cyммa и валюта задолженности», «Maксимaльнaя»,
   * «Пpизнaк дoлгoвoй нагpyзки». Набор испорченных подписей меняется от
   * отчёта к отчёту, поэтому точное сравнение строк ненадёжно: однажды
   * подмена заденет «Фактические платежи по договору», и разбор молча
   * вернёт ноль платежей.
   *
   * Поэтому подписи сравниваются не напрямую, а через key(): латинские
   * двойники приводятся к кириллице. Исходный текст при этом не меняется —
   * иначе пострадали бы честные латинские названия вроде «POS-заем».
   */
  var HOMOGLYPHS = {
    'A': 'А', 'B': 'В', 'C': 'С', 'E': 'Е', 'H': 'Н', 'K': 'К', 'M': 'М',
    'O': 'О', 'P': 'Р', 'T': 'Т', 'X': 'Х', 'Y': 'У',
    'a': 'а', 'c': 'с', 'e': 'е', 'o': 'о', 'p': 'р', 'x': 'х', 'y': 'у'
  };

  function deHomoglyph(s) {
    return String(s).replace(/[ABCEHKMOPTXYacepxyo]/g, function (ch) {
      return HOMOGLYPHS[ch] || ch;
    });
  }

  /** Ключ для сравнения подписей: без подмен, без регистра, без лишних пробелов. */
  function key(s) {
    return deHomoglyph(normSpaces(s)).toLowerCase();
  }

  function keyEq(a, b) { return key(a) === key(b); }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function iso(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

  /** «12 997,83 р.» → 12997.83; «-» и мусор → null. */
  function parseAmount(raw) {
    if (raw == null) return null;
    var t = deHomoglyph(normSpaces(raw));
    if (!t || t === '-' || t === '—') return null;
    t = t.replace(/\s*р\.?$/i, '').trim();
    if (!t || t === '-' || t === '—') return null;
    var n = t.replace(/\s/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(n)) return null;
    return parseFloat(n);
  }

  /** «13 января» → {day, month}; иначе null. */
  function parseDayMonth(raw) {
    var m = key(raw).match(/^(\d{1,2})\s+([а-яё]+)$/);
    if (!m) return null;
    var mo = MONTHS[m[2]];
    if (mo === undefined) return null;
    var d = +m[1];
    if (d < 1 || d > 31) return null;
    return { day: d, month: mo };
  }

  /** «13 декабря 2021» → «2021-12-13»; иначе null. */
  function parseFullDate(raw) {
    if (raw == null) return null;
    var m = key(raw).match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})\b/);
    if (!m) return null;
    var mo = MONTHS[m[2]];
    if (mo === undefined) return null;
    return iso(+m[3], mo, +m[1]);
  }

  /** «2021-12-13» → «13 декабря 2021». */
  function formatDate(isoDate) {
    if (!isoDate) return '—';
    var p = isoDate.split('-');
    return (+p[2]) + ' ' + MONTHS_GEN[+p[1] - 1] + ' ' + p[0];
  }

  /** «2021-12» → «дек 2021». */
  function formatMonth(ym) {
    var p = ym.split('-');
    return MONTHS_SHORT[+p[1] - 1] + ' ' + p[0];
  }

  // ------------------------------------------------- восстановление строк

  /**
   * Собирает текстовые фрагменты страницы в строки.
   * items: [{str, x, y, width}] — как их отдаёт pdf.js (x/y из transform).
   * Возвращает строки сверху вниз, внутри строки — фрагменты слева направо,
   * склеенные, если между ними нет заметного зазора.
   */
  function buildRows(items) {
    var buckets = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.str == null || !it.str.trim()) continue; // отступы между колонками — это отдельные пробельные фрагменты
      var bucket = null;
      for (var b = 0; b < buckets.length; b++) {
        if (Math.abs(buckets[b].y - it.y) <= 2) { bucket = buckets[b]; break; }
      }
      if (!bucket) { bucket = { y: it.y, items: [] }; buckets.push(bucket); }
      bucket.items.push({ x: it.x, w: it.width || 0, s: it.str });
    }

    buckets.sort(function (a, b) { return b.y - a.y; });

    for (var k = 0; k < buckets.length; k++) {
      var row = buckets[k];
      row.items.sort(function (p, q) { return p.x - q.x; });
      var merged = [];
      for (var j = 0; j < row.items.length; j++) {
        var cur = row.items[j];
        var last = merged.length ? merged[merged.length - 1] : null;
        // Склеиваем только фрагменты, стоящие вплотную (смена шрифта внутри
        // ячейки). Любой видимый зазор — это уже граница колонки: отчёт
        // разделяет колонки пробельными фрагментами шириной в 10+ пунктов.
        if (last && cur.x - (last.x + last.w) < 1) {
          last.s += cur.s;
          last.w = Math.max(last.x + last.w, cur.x + cur.w) - last.x;
        } else {
          merged.push({ x: cur.x, w: cur.w, s: cur.s });
        }
      }
      row.items = [];
      for (var q = 0; q < merged.length; q++) {
        var s = normSpaces(merged[q].s);
        if (s) row.items.push({ x: merged[q].x, w: merged[q].w, s: s });
      }
    }

    return buckets.filter(function (r) { return r.items.length > 0; });
  }

  function nearest(row, x, tol) {
    var best = null, bd = tol == null ? 8 : tol;
    for (var i = 0; i < row.items.length; i++) {
      var d = Math.abs(row.items[i].x - x);
      if (d <= bd) { bd = d; best = row.items[i]; }
    }
    return best;
  }

  function firstText(row) { return row.items.length ? row.items[0].s : ''; }

  // -------------------------------------------------------------- разделы

  // Колонтитул «Сформирован 22 июня 2026 20:42 | v3.19.0.0 | Раздел | 20 | из 106»
  // свёрстан двумя строками с чуть разной высотой, поэтому распознаём обе:
  // левую (дата и версия формата) и правую (название раздела и номер страницы).
  function readRunningHeader(row) {
    var items = row.items;
    if (!items.length) return null;

    if (/^сформирован\s/.test(key(items[0].s))) {
      var version = null;
      for (var i = 1; i < items.length; i++) {
        if (/^v\d+(\.\d+)+$/.test(items[i].s)) { version = items[i].s; break; }
      }
      return {
        reportDate: parseFullDate(items[0].s.replace(/^\S+\s+/, '')),
        version: version,
        section: null
      };
    }

    for (var j = 0; j < items.length; j++) {
      if (/^из \d+$/.test(key(items[j].s))) {
        var section = /[А-Яа-яЁё]/.test(deHomoglyph(items[0].s)) && !/^\d+$/.test(items[0].s)
          ? items[0].s : null;
        return { reportDate: null, version: null, section: section };
      }
    }

    return null;
  }

  var SECTION_ACTIVE = 'ДЕЙСТВУЮЩИЕ КРЕДИТНЫЕ ДОГОВОРЫ';
  var SECTION_CLOSED = 'ЗАКРЫТЫЕ КРЕДИТНЫЕ ДОГОВОРЫ';

  function isAllCapsHeading(s) {
    var t = deHomoglyph(s);
    return t.length > 8 && /^[А-ЯЁ][А-ЯЁ\s,.?()«»°/-]+$/.test(t);
  }

  // ------------------------------------------------ таблица платежей

  function isYearRow(row) {
    return row.items.length === 1 &&
      row.items[0].x < 40 &&
      /^\d{4}$/.test(row.items[0].s);
  }

  function isDatesRow(row) {
    if (!row.items.length) return false;
    for (var i = 0; i < row.items.length; i++) {
      if (row.items[i].x < 40) return false;
      if (!parseDayMonth(row.items[i].s)) return false;
    }
    return true;
  }

  /**
   * Разбирает транспонированную таблицу «Фактические платежи по договору».
   * Колонка = один платёж, строки = дата / сумма / основной долг / проценты /
   * иное. Заголовок года стоит перед группой и не повторяется при переносе
   * таблицы на следующую страницу, поэтому год переносится между итерациями.
   */
  function parsePaymentTable(rows, start, warnings) {
    var payments = [];
    var year = null;
    var i = start;

    // Шапка таблицы, если она на месте.
    if (i < rows.length && /^дата платежа/.test(key(firstText(rows[i])))) i++;

    while (i < rows.length) {
      var row = rows[i];

      if (isYearRow(row)) { year = +row.items[0].s; i++; continue; }

      if (isDatesRow(row)) {
        if (year == null) {
          warnings.push('Группа платежей без заголовка года — пропущена.');
          i++;
          continue;
        }
        if (i + 4 >= rows.length) {
          warnings.push('Таблица платежей обрывается: нет строк со суммами.');
          break;
        }
        var valueRows = [rows[i + 1], rows[i + 2], rows[i + 3], rows[i + 4]];
        for (var c = 0; c < row.items.length; c++) {
          var cell = row.items[c];
          var dm = parseDayMonth(cell.s);
          var payment = {
            date: iso(year, dm.month, dm.day),
            amount: null, principal: null, interest: null, other: null
          };
          for (var f = 0; f < PAYMENT_FIELDS.length; f++) {
            var hit = nearest(valueRows[f], cell.x, 8);
            payment[PAYMENT_FIELDS[f]] = hit ? parseAmount(hit.s) : null;
          }
          payments.push(payment);
        }
        i += 5;
        continue;
      }

      break; // таблица закончилась
    }

    return { payments: payments, end: i };
  }

  // --------------------------------------------------------------- разбор

  /**
   * pages: [{num, rows}] — строки уже собраны buildRows().
   */
  function parse(pages) {
    var meta = { fio: null, birthDate: null, reportDate: null, version: null, pages: pages.length };
    var warnings = [];
    var flat = [];

    // Колонтитулы дают версию, дату отчёта и раздел страницы. Сами строки
    // колонтитулов из потока убираем, иначе они разрывают таблицы, идущие
    // через несколько страниц.
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var headerSection = null;
      for (var r = 0; r < page.rows.length; r++) {
        var hdr = readRunningHeader(page.rows[r]);
        if (hdr) {
          if (hdr.section) headerSection = hdr.section;
          if (!meta.reportDate && hdr.reportDate) meta.reportDate = hdr.reportDate;
          if (!meta.version && hdr.version) meta.version = hdr.version;
          continue;
        }
        page.rows[r].page = page.num;
        flat.push(page.rows[r]);
      }
      // Оглавление содержит названия всех разделов — оно бы сбило разбор.
      if (headerSection && /^Содержание$/i.test(headerSection)) {
        flat = flat.filter(function (row) { return row.page !== page.num; });
      }
    }

    // Субъект кредитной истории.
    for (var s = 0; s < flat.length; s++) {
      if (keyEq(firstText(flat[s]), 'СУБЪЕКТ КРЕДИТНОЙ ИСТОРИИ') && s + 1 < flat.length) {
        meta.fio = firstText(flat[s + 1]);
        for (var t = s + 2; t < Math.min(s + 6, flat.length); t++) {
          if (keyEq(firstText(flat[t]), 'Дата рождения') && t + 1 < flat.length) {
            meta.birthDate = parseFullDate(flat[t + 1].items[0].s) ||
              normSpaces(flat[t + 1].items[0].s);
          }
        }
        break;
      }
    }

    // Границы блоков договоров.
    var section = null;
    var blocks = [];
    for (var i = 0; i < flat.length; i++) {
      var row = flat[i];
      var head = firstText(row);
      if (!row.items.length || row.items[0].x > 30) continue;

      // Заголовок договора: «1. СОВКОМБАНК ПАО - Договор займа (кредита) - …».
      // Структуру проверяем по ключу (устойчиво к подмене букв), а кредитора
      // и вид берём из исходной строки, чтобы не испортить название.
      var m = head.match(/^(\d{1,3})\.\s+(.+?)\s+-\s+(.+)$/);
      if (m && !/^договор/.test(key(m[3]))) m = null;
      if (m && (section === 'active' || section === 'closed')) {
        if (blocks.length) blocks[blocks.length - 1].end = i;
        blocks.push({
          index: +m[1], creditor: normSpaces(m[2]), kind: normSpaces(m[3]),
          section: section, start: i, end: flat.length, row: row
        });
        continue;
      }

      if (keyEq(head, SECTION_ACTIVE)) { section = 'active'; if (blocks.length) blocks[blocks.length - 1].end = i; continue; }
      if (keyEq(head, SECTION_CLOSED)) { section = 'closed'; if (blocks.length) blocks[blocks.length - 1].end = i; continue; }
      if (isAllCapsHeading(head) && section) {
        section = null;
        if (blocks.length) blocks[blocks.length - 1].end = i;
      }
    }

    var contracts = blocks.map(function (block) {
      return parseContract(flat, block);
    });

    if (!contracts.length) {
      warnings.push('В файле не найдено ни одного кредитного договора. ' +
        'Похоже, это не отчёт ОКБ / «Кредистория» либо его структура изменилась.');
    } else if (!contracts.some(function (c) { return c.hasPaymentTable; })) {
      // Ноль таблиц на весь отчёт почти наверняка означает, что изменилась
      // вёрстка, а не что должник никогда не платил. Молчать здесь нельзя.
      warnings.push('Договоры найдены (' + contracts.length + '), но ни в одном не удалось ' +
        'найти таблицу «Фактические платежи по договору». Скорее всего изменилась структура ' +
        'отчёта — расчёт по такому файлу использовать нельзя.');
    }

    return { meta: meta, contracts: contracts, warnings: warnings };
  }

  function parseContract(flat, block) {
    var rows = flat.slice(block.start, block.end);
    var warnings = [];
    var paymentsEnd = null;

    var statuses = [];
    for (var h = 1; h < block.row.items.length; h++) statuses.push(block.row.items[h].s);
    // «Была просрочка по» иногда переносит дату на следующую строку.
    if (rows.length > 1 && rows[1].items.length === 1 && rows[1].items[0].x > 400 &&
        /^\d{2}\.\d{2}\.\d{4}$/.test(rows[1].items[0].s) &&
        statuses.length && /просрочка/i.test(statuses[statuses.length - 1])) {
      statuses[statuses.length - 1] += ' ' + rows[1].items[0].s;
    }

    var contract = {
      index: block.index,
      section: block.section,
      creditor: block.creditor,
      kind: block.kind,
      statuses: statuses,
      isClosed: statuses.some(function (x) { return /^Закрыт$/i.test(x); }),
      isAssigned: statuses.some(function (x) { return /Переуступлен/i.test(x); }),
      hadOverdue: statuses.some(function (x) { return /просрочка/i.test(x); }),
      contractDate: null,          // «Дата совершения сделки» — дата самого кредитного договора
      obligationDate: null,        // «Дата возникновения обязательства»
      participation: null,         // «Вид участия в сделке» — заёмщик / поручитель / …
      contractNumber: null,
      amount: null,                // сумма и валюта обязательства
      controlTotals: null,         // «Сумма всех внесенных платежей» — для сверки
      payments: [],
      hasPaymentTable: false,
      warnings: warnings,
      page: block.row.page
    };

    for (var i = 0; i < rows.length; i++) {
      var label = key(firstText(rows[i]));

      if (label === key('Вид участия в сделке') && i + 1 < rows.length) {
        var part = nearest(rows[i + 1], 32, 8);
        if (part) contract.participation = part.s;
        var num = nearest(rows[i + 1], 391, 10);
        if (num && /^[\w-]+$/.test(num.s)) contract.contractNumber = num.s;
        continue;
      }

      if (label === key('Дата совершения сделки')) {
        for (var j = i + 1; j < Math.min(i + 3, rows.length); j++) {
          var cell = nearest(rows[j], 32, 8);
          var d = cell ? parseFullDate(cell.s) : null;
          if (d) {
            contract.contractDate = d;
            var ob = nearest(rows[j], 212, 10);
            if (ob) contract.obligationDate = parseFullDate(ob.s);
            break;
          }
        }
        continue;
      }

      if (label === key('Сумма и валюта обязательства') && contract.amount == null) {
        for (var k = i + 1; k < Math.min(i + 4, rows.length); k++) {
          var a = nearest(rows[k], 32, 8);
          var v = a ? parseAmount(a.s) : null;
          if (v != null) { contract.amount = v; break; }
        }
        continue;
      }

      if (label === key('Сумма всех внесенных платежей')) {
        for (var n = i + 1; n < Math.min(i + 4, rows.length); n++) {
          var tot = nearest(rows[n], 32, 8);
          var totV = tot ? parseAmount(tot.s) : null;
          if (totV != null) {
            var pick = function (x) {
              var c = nearest(rows[n], x, 12);
              return c ? parseAmount(c.s) : null;
            };
            contract.controlTotals = {
              total: totV, principal: pick(167), interest: pick(302), other: pick(436)
            };
            break;
          }
        }
        continue;
      }

      if (label === key('Фактические платежи по договору')) {
        contract.hasPaymentTable = true;
        var res = parsePaymentTable(rows, i + 1, warnings);
        contract.payments = contract.payments.concat(res.payments);
        paymentsEnd = res.end;
        i = res.end - 1;
        continue;
      }
    }

    // Контроль обрыва: после таблицы в блоке не должно остаться строк с датами
    // платежей. Если остались — разбор остановился раньше конца таблицы.
    if (paymentsEnd != null) {
      for (var z = paymentsEnd; z < rows.length; z++) {
        if (isDatesRow(rows[z])) {
          warnings.push('Таблица платежей разобрана не полностью: после неё остались строки с датами.');
          break;
        }
      }
    }

    var noAmount = 0;
    for (var na = 0; na < contract.payments.length; na++) {
      if (contract.payments[na].amount == null) noAmount++;
    }
    contract.paymentsWithoutAmount = noAmount;
    if (noAmount) {
      warnings.push('Платежей без распознанной суммы: ' + noAmount + '.');
    }

    contract.payments.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

    // Сверка с контрольной суммой из самого отчёта.
    var sum = 0;
    for (var q = 0; q < contract.payments.length; q++) sum += contract.payments[q].amount || 0;
    contract.parsedTotal = Math.round(sum * 100) / 100;
    if (contract.controlTotals && contract.controlTotals.total != null) {
      contract.totalsDiff = Math.round((contract.parsedTotal - contract.controlTotals.total) * 100) / 100;
      contract.totalsMatch = Math.abs(contract.totalsDiff) <= 0.05;
    } else {
      contract.totalsDiff = null;
      contract.totalsMatch = null;
    }

    return contract;
  }

  global.OKBParser = {
    parse: parse,
    buildRows: buildRows,
    parseAmount: parseAmount,
    parseFullDate: parseFullDate,
    parseDayMonth: parseDayMonth,
    formatDate: formatDate,
    formatMonth: formatMonth,
    MONTHS_GEN: MONTHS_GEN,
    MONTHS_SHORT: MONTHS_SHORT
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
