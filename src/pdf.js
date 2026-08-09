/*
 * Выгрузка анализа в PDF.
 *
 * Раскладка по листам делается не по прикидкам высот, а по фактическим:
 * весь материал сначала рендерится сплошняком в скрытом контейнере той же
 * ширины, браузер сообщает высоту каждого блока и каждой строки таблицы,
 * и только потом блоки раскладываются по листам. Поэтому таблицы переносятся
 * с повтором шапки, «Итого» не отрывается от последней строки, а на листе
 * не остаётся ни дыр, ни срезанного текста.
 *
 * Расчёт сюда не дублируется: суммы приходят готовыми из compute(),
 * а судьбу каждой строки определяет verdict() из app.js — иначе выгрузка
 * рано или поздно разойдётся с тем, что человек видит на экране.
 */
(function () {
  'use strict';

  const P = globalThis.OKBParser;
  const NB = ' ';
  const MM = 3.7795275591;                  // px в мм при 96 dpi
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Разряды разделяет неразрывный пробел: иначе сумма переносится на вторую
  // строку и таблица становится нечитаемой.
  const money = (v) => v == null ? '—' : nf2.format(v).replace(/\s/g, NB);
  const short = (v) => v >= 1e6 ? (v / 1e6).toFixed(1).replace('.', ',') + NB + 'млн'
    : v >= 1e3 ? Math.round(v / 1e3) + NB + 'тыс.' : String(Math.round(v));
  const pct = (v, t) => t > 0 ? (v / t * 100).toFixed(1).replace('.', ',') + NB + '%' : '—';
  const dshort = (iso) => { const p = String(iso).split('-'); return p[2] + '.' + p[1] + '.' + p[0]; };
  const dlong = (iso) => {
    const p = String(iso).split('-');
    return +p[2] + NB + MONTHS[+p[1] - 1] + NB + p[0];
  };
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
  }
  // Вид обязательства напечатан в отчёте длинной канцелярской строкой —
  // в таблицу берём только содержательный хвост.
  function kindShort(c) {
    const k = String(c.kind || '').replace(/^Договор займа \(кредита\)\s*[-—]\s*/i, '').trim();
    return k || 'заём (кредит)';
  }
  // pageEnd отчёт не печатает — границу договора выводим из листов его платежей.
  function lastPage(c) {
    const pp = c.payments.map((p) => p.page).filter(Boolean);
    return pp.length ? Math.max(c.page, ...pp) : (c.pageEnd || c.page);
  }
  const CR = (i) => ['#C0552E', '#A96068', '#6F8047', '#D98C3A', '#8C6A9B', '#4E7C82'][i % 6];

  // В расшифровке статус стоит в узкой графе. Полные формулировки ОКБ
  // («Оплачен вовремя») переносятся на вторую строку и удваивают высоту
  // каждой строки таблицы — на двухстах платежах это лишние листы.
  const ST_SHORT = {
    paid_ontime: 'в срок', paid_late: 'с задержкой',
    paid_ontime_partial: 'не полностью', paid_partial: 'не полностью',
    not_paid: 'не вносятся', not_due: 'срок не наступил',
    no_data: 'нет данных', ambiguous: 'неоднозначно'
  };

  const VERDICT = {
    dup: 'повтор', accrual: 'начисление', unknown: 'сумма не распознана',
    zero: 'нулевая запись', min: 'ниже порога', status: 'не учитывается'
  };

  /* ================= сбор материала ================= */

  function collect(ctx) {
    const { report, res, deal, filters, opts, verdict } = ctx;
    const meta = report.meta;
    const fio = ctx.hideFio ? 'ФИО скрыто' : (meta.fio || '—');
    const from = deal.date, until = res.lastDate;
    const old = meta.format === 'old';

    const B = [];
    const add = (html, glue) => B.push({ html: html, glue: !!glue });
    const part = (eyebrow, title, sub) => {
      // Новая часть всегда открывает лист, иначе её титул повисает под
      // таблицей предыдущего раздела и документ читается сплошной лентой.
      B.push({ html: '<span class="eyebrow">' + eyebrow + '</span>', glue: true, brk: true });
      add('<h1>' + title + '</h1>', true);
      add('<p class="sub">' + sub + '</p>', true);
    };
    let tblN = 0;
    // Ширины колонок задаются явно: при table-layout:auto они зависят от того,
    // какие строки попали в таблицу, и обмер целой таблицы перестаёт совпадать
    // с её частью — куски разъезжаются, а на листах остаются дыры.
    const tbl = (w, cols, rows, total, o) => {
      o = o || {};
      B.push({ tbl: {
        id: 'X' + (tblN++), cols: cols, rows: rows, total: total || '',
        cg: '<colgroup>' + w.map((x) => '<col style="width:' + x + '%">').join('') + '</colgroup>',
        cls: o.cls || 'fit', head: o.head || '', cont: o.cont || ''
      } });
    };
    const h2 = (n, t) => add('<h2><span class="n">' + n + '</span>' + t + '</h2>', true);
    let sec = 0;

    /* --- часть I: общие данные --- */
    part('Часть I · Общие данные', 'Платежи, внесённые после сделки',
      'по кредитному отчёту АО «ОКБ» от ' + dlong(meta.reportDate) +
      (meta.version ? ' · формат ' + esc(meta.version) : '') +
      (meta.pages ? ' · ' + meta.pages + NB + plural(meta.pages, 'лист', 'листа', 'листов') : ''));

    add('<div class="pcard"><dl class="facts">' +
      '<dt>Проверяемая дата сделки</dt><dd>' + dlong(from) +
      (filters.strict ? ', платежи строго после неё' : '') + '</dd>' +
      '<dt>Анализируемый период</dt><dd>' + dlong(from) + ' — ' + dlong(until) + ', ' +
      res.afterMonths + NB + plural(res.afterMonths, 'месяц', 'месяца', 'месяцев') + '</dd>' +
      '<dt>Договоров в отчёте</dt><dd>' + report.contracts.length +
      ', из них с построчным списком платежей — ' +
      report.contracts.filter((c) => c.payments.length).length + '</dd>' +
      '</dl></div>');

    h2(++sec, 'Общая сумма платежей после сделки');
    add('<div class="total"><div><div class="lbl">Внесено после сделки</div>' +
      '<div class="sum">' + money(res.total) + NB + '₽</div></div><div class="side">' +
      '<div><span>платежей</span><b>' + res.count + '</b></div>' +
      '<div><span>кредиторов</span><b>' + res.creditors + '</b></div>' +
      '<div><span>договоров</span><b>' + res.contracts + '</b></div></div></div>');

    const bits = [];
    if (res.biggest) bits.push('Крупнейший единовременный платёж — ' + money(res.biggest.amount) +
      NB + '₽ ' + dlong(res.biggest.date) + ', ' + esc(res.biggest.creditor) + '.');
    if (res.beforeMonths && res.beforeSum > 0) {
      const a = res.beforeSum / res.beforeMonths, b = res.total / res.afterMonths;
      bits.push('В среднем ' + money(Math.round(a)) + NB + '₽ в месяц за ' + res.beforeMonths +
        NB + plural(res.beforeMonths, 'месяц', 'месяца', 'месяцев') + ' до сделки и ' +
        money(Math.round(b)) + NB + '₽ после — ' + (b < a ? 'снижение' : 'рост') + ' на ' +
        Math.abs(Math.round((b / a - 1) * 100)) + NB + '%.');
    }
    if (bits.length) add('<p class="small">' + bits.join(' ') + '</p>');

    /* --- кредиторы --- */
    h2(++sec, 'Кому и сколько внесено');
    const groups = res.groups.slice().sort((a, b) => b.total - a.total);
    groups.forEach((g, i) => { g.color = CR(i); });

    // Подпись влезает в сегмент, только если он широкий и название короткое:
    // обрезок читается хуже, чем просто процент.
    add('<div class="sharebar">' + groups.map((g) => {
      const w = res.total > 0 ? g.total / res.total * 100 : 0;
      const label = w >= 22 && g.creditor.length <= 20 ? esc(g.creditor) + ' — ' : '';
      return '<b style="width:' + w.toFixed(2) + '%;background:' + g.color + '">' +
        label + pct(g.total, res.total) + '</b>';
    }).join('') + '</div>');

    const crRows = [];
    for (const g of groups) {
      const many = g.items.length > 1;
      // У кредитора может быть несколько договоров: сначала строка-итог по нему,
      // иначе доли в таблице не сходятся с сегментами полосы.
      if (many) crRows.push('<tr class="grp"><td><span class="dot" style="background:' + g.color +
        '"></span>' + esc(g.creditor) + '<em>' + g.items.length + NB +
        plural(g.items.length, 'договор', 'договора', 'договоров') + '</em></td>' +
        '<td class="r">' + g.count + '</td><td colspan="3"></td>' +
        '<td class="r">' + money(g.total) + '</td>' +
        '<td class="r">' + pct(g.total, res.total) + '</td></tr>');
      for (const it of g.items) {
        const c = it.c, brk = it.interest || it.other;
        crRows.push('<tr' + (many ? ' class="in"' : '') + '><td>' +
          (many ? '' : '<span class="dot" style="background:' + g.color + '"></span>') +
          esc(many ? kindShort(c) : g.creditor) + '<em>' +
          (many ? '' : esc(kindShort(c)) + ', ') + 'договор от ' + dshort(c.contractDate) +
          ', листы ' + c.page + '—' + lastPage(c) + '</em></td>' +
          '<td class="r">' + it.pays.length + '</td>' +
          '<td class="r">' + (brk ? money(it.principal) : '<span class="nd">нет данных</span>') + '</td>' +
          '<td class="r">' + (brk ? money(it.interest) : '') + '</td>' +
          '<td class="r">' + (brk ? money(it.other) : '') + '</td>' +
          '<td class="r">' + money(it.total) + '</td>' +
          '<td class="r">' + pct(it.total, res.total) + '</td></tr>');
      }
    }
    tbl([32, 9, 13, 13, 10, 15, 8],
      '<tr><th>Кредитор и договор</th><th class="r">Платежей</th><th class="r">Осн. долг</th>' +
      '<th class="r">Проценты</th><th class="r">Иное</th><th class="r">Всего, ₽</th>' +
      '<th class="r">Доля</th></tr>', crRows,
      '<tr class="tsum"><td>Итого</td><td class="r">' + res.count + '</td>' +
      '<td class="r">' + money(res.principal) + '</td><td class="r">' + money(res.interest) + '</td>' +
      '<td class="r">' + money(res.other) + '</td><td class="r">' + money(res.total) + '</td>' +
      '<td class="r">100' + NB + '%</td></tr>');

    /* --- структура --- */
    const known = res.perContract.reduce((a, x) => a + ((x.interest || x.other) ? x.total : 0), 0);
    const split = [
      ['Основной долг', res.principal, 'var(--p-olive)'],
      ['Проценты', res.interest, 'var(--p-beige)'],
      ['Иное', res.other, 'var(--p-terra)'],
      ['Разбивка не передана', Math.max(0, res.total - known), 'var(--p-greige)']
    ].filter((x) => x[1] > 0.005);
    if (split.length) {
      h2(++sec, 'На что пошли деньги');
      add('<div class="pmix">' + split.map((x) =>
        '<b style="width:' + (x[1] / res.total * 100).toFixed(2) + '%;background:' + x[2] + '"></b>').join('') +
        '</div><div class="splitleg">' + split.map((x) =>
        '<span><i style="background:' + x[2] + '"></i>' + x[0] + ' — <b>' + money(x[1]) + NB + '₽</b> · ' +
        pct(x[1], res.total) + '</span>').join('') + '</div>');
    }

    /* --- часть II: исключения --- */
    const anyExcl = res.dupGroups.length || res.excludedCount || res.newExcludedCount ||
      res.newContracts.length;
    if (anyExcl) {
      part('Часть II · Исключения', 'Что не вошло в расчёт',
        'каждое исключение проверяемо по листу исходного отчёта');

      if (res.dupGroups.length) {
        h2(++sec, 'Записи, исключённые как повтор');
        add('<div class="warn"><b>Обнаружен сбой отчёта: повтор записи.</b> Один и тот же платёж ' +
          'напечатан несколько раз одной датой. Признак сбоя — основной долг в этот день не ' +
          'изменился, хотя при реальном внесении он должен был уменьшиться. ' +
          (filters.dedupe ? 'Засчитан один платёж из группы.'
            : '<b>Отсев повторов выключен, все записи учтены в итоге.</b>') + '</div>');
        // Повтор и начисление могут совпасть в одной группе: тогда отсев ничего
        // из итога не убирает — эти строки и так не платежи. Считаем отдельно,
        // иначе исключения сложатся дважды.
        let raw = 0, net = 0;
        const rows = res.dupGroups.map((g) => {
          const c = report.contracts.find((x) => x.creditor === g.creditor && x.index === g.index);
          const base = c && c.payments.find((p) => p.date === g.date && p.amount === g.amount && p.dupCount);
          const real = !!(base && verdict(base) === 'counted') && filters.dedupe;
          raw += g.extra; if (real) net += g.extra;
          return '<tr><td>' + esc(g.creditor) + '</td><td>' + dshort(g.date) + '</td>' +
            '<td class="r">' + money(g.amount) + '</td><td class="r">' + g.count + '</td>' +
            '<td class="r">' + money(g.extra) + '</td>' +
            '<td class="r two">' + money(g.principalBefore) +
            '<em>→ ' + money(g.principalAfter) + '</em></td>' +
            '<td class="r">' + (real ? '−' + money(g.extra) : '<span class="nd">0,00</span>') + '</td>' +
            '<td class="r sub">' + g.page + '</td></tr>';
        });
        tbl([17, 9, 12, 8, 12, 16, 18, 8],
          '<tr><th>Кредитор</th><th>Дата</th><th class="r">Сумма записи</th><th class="r">Повторов</th>' +
          '<th class="r">Лишнее, ₽</th><th class="r">Осн. долг до и после</th>' +
          '<th class="r">Влияние на итог, ₽</th><th class="r">Лист</th></tr>', rows,
          '<tr class="tsum"><td colspan="4">Итого</td><td class="r">' + money(raw) + '</td><td></td>' +
          '<td class="r">−' + money(net) + '</td><td></td></tr>');
        if (net < raw) add('<p class="small">Нулевое влияние на итог означает, что записи группы ' +
          'и без того не являются платежами: они исключены по другому основанию. ' +
          'Двойного вычета не происходит.</p>');
      }

      if (old && res.excludedCount) {
        h2(++sec, 'Начисления, ошибочно похожие на платежи');
        add('<p>В отчётах старого формата статус платежа обозначен значком, а не словом. Суммы ' +
          'под значком <b>«платежи не вносятся»</b> — это начисленные банком проценты и неустойка, ' +
          'а не внесённые должником деньги. Такие строки в расчёт не принимаются' +
          (opts.ledger ? ', но приведены в расшифровке серым' : '') + '.</p>');
        add('<div class="pcard"><dl class="facts"><dt>Записей после сделки</dt><dd>' +
          res.excludedCount + '</dd><dt>Сумма начислений</dt><dd>' + money(res.excluded) + NB +
          '₽</dd><dt>Их включение завысило бы итог</dt><dd>на ' +
          pct(res.excluded, res.total) + ' от рассчитанной суммы</dd></dl></div>');
      }

      if (res.newContracts.length) {
        h2(++sec, 'Кредиты, заключённые после сделки');
        // Дата пишется словами и склеена неразрывными пробелами: в узкой графе
        // она рвётся посреди года, поэтому графа шире прочих.
        tbl([19, 20, 28, 10, 16, 7],
          '<tr><th>Дата договора</th><th>Кредитор</th><th>Вид обязательства</th>' +
          '<th class="r">Платежей</th><th class="r">Внесено, ₽</th><th class="r">Лист</th></tr>',
          res.newContracts.map((c) => {
            const it = res.perContract.find((x) => x.c === c);
            return '<tr><td>' + dlong(c.contractDate) + '</td><td>' + esc(c.creditor) + '</td>' +
              '<td class="sub">' + esc(kindShort(c)) + '</td>' +
              '<td class="r">' + (it ? it.pays.length : 0) + '</td>' +
              '<td class="r">' + (it ? money(it.total) : '—') + '</td>' +
              '<td class="r sub">' + c.page + '</td></tr>';
          }));
        add(filters.excludeNew
          ? '<p class="small">Платежи по этим договорам <b>исключены</b> из расчёта раздела 1: ' +
            res.newExcludedCount + NB + plural(res.newExcludedCount, 'платёж', 'платежа', 'платежей') +
            ' на ' + money(res.newExcluded) + NB + '₽.</p>'
          : '<p class="small">Платежи по этим договорам <b>включены</b> в расчёт раздела 1. Если по ' +
            'обстоятельствам дела учитывать следует только обязательства, существовавшие на дату ' +
            'сделки, их сумма подлежит вычету.</p>');
      }

      const noTable = report.contracts.filter((c) => !c.payments.length);
      if (noTable.length) {
        h2(++sec, 'Договоры без построчного списка платежей');
        add('<p>По <b>' + noTable.length + NB + plural(noTable.length, 'договору', 'договорам', 'договорам') +
          ' из ' + report.contracts.length + '</b> кредиторы не передали список платежей. Отсутствие ' +
          'таких платежей в расчёте <b>не свидетельствует об их отсутствии в действительности</b>.</p>');
        tbl([28, 13, 30, 21, 8],
          '<tr><th>Кредитор</th><th>Договор от</th><th>Вид обязательства</th>' +
          '<th class="r">Агрегат отчёта, ₽</th><th class="r">Лист</th></tr>',
          noTable.map((c) => '<tr><td>' + esc(c.creditor) + '</td>' +
            '<td class="sub">' + dshort(c.contractDate) + '</td>' +
            '<td class="sub">' + esc(kindShort(c)) + '</td>' +
            '<td class="r">' + (c.controlTotals ? money(c.controlTotals.total)
              : '<span class="nd">не указан</span>') + '</td>' +
            '<td class="r sub">' + c.page + '</td></tr>'));
      }
    }

    /* --- часть III: динамика --- */
    if (opts.dynamics) {
      part('Часть III · Расширенный анализ', 'Динамика платежей и платёжная дисциплина',
        'сопоставление периодов до и после проверяемой даты');

      const years = {};
      for (const c of report.contracts)
        for (const p of c.payments) {
          if (verdict(p) !== 'counted') continue;
          if (res.beforeStart && p.date < res.beforeStart) continue;
          if (p.date > until) continue;
          const y = p.date.slice(0, 4);
          years[y] = years[y] || { sum: 0, after: false };
          years[y].sum += p.amount || 0;
          if (p.date >= from) years[y].after = true;
        }
      const yl = Object.keys(years).sort().map((y) => ({ y: y, sum: years[y].sum, after: years[y].after }));
      if (yl.length > 1) {
        const ymax = Math.max.apply(null, yl.map((x) => x.sum)) || 1;
        h2(++sec, 'Платежи по годам');
        add('<div class="plot"><div class="grid"><i style="bottom:25%"></i><i style="bottom:50%"></i>' +
          '<i style="bottom:75%"></i></div><div class="cols">' +
          yl.map((x) => '<i class="' + (x.after ? 'a' : '') + '" style="height:' +
            Math.max(4, x.sum / ymax * 100).toFixed(0) + '%"><span>' + short(x.sum) + '</span></i>').join('') +
          '</div><div class="colsx">' + yl.map((x) => '<span>' + x.y + '</span>').join('') + '</div></div>' +
          '<div class="splitleg" style="margin-top:8pt">' +
          '<span><i style="background:var(--p-beige)"></i>до сделки</span>' +
          '<span><i style="background:var(--p-terra)"></i>после сделки</span>' +
          '<span class="nd">крайние годы неполные</span></div>');
      }

      const mon = ctx.monthly.filter((m) => m.count > 0 || m.level);
      if (mon.length > 2) {
        const ys = [];
        for (const m of ctx.monthly) { const y = m.ym.slice(0, 4); if (ys.indexOf(y) < 0) ys.push(y); }
        const lvl = {};
        for (const m of ctx.monthly) lvl[m.ym] = m.level;
        h2(++sec, 'Платёжная дисциплина по месяцам');
        add('<p class="small">Строка — год, клетка — месяц. Цвет — худшее состояние платежей ' +
          'в этом месяце по всем договорам сразу. Обведён месяц совершения сделки.</p>', true);
        add('<div class="heat"><span></span>' +
          ['я', 'ф', 'м', 'а', 'м', 'и', 'и', 'а', 'с', 'о', 'н', 'д']
            .map((m) => '<span class="mh">' + m + '</span>').join('') +
          ys.map((y) => {
            let s = '<span class="y">' + y + '</span>';
            for (let i = 1; i <= 12; i++) {
              const ym = y + '-' + String(i).padStart(2, '0');
              s += '<i class="' + (lvl[ym] ? 'l' + lvl[ym] : '') +
                (ym === from.slice(0, 7) ? ' cut' : '') + '"></i>';
            }
            return s;
          }).join('') + '</div>' +
          '<div class="splitleg">' + (old
            ? '<span><i style="background:var(--p-olive)"></i>в срок</span>' +
              '<span><i style="background:var(--p-beige)"></i>не полностью</span>' +
              '<span><i style="background:var(--p-amber)"></i>с задержкой</span>' +
              '<span><i style="background:var(--p-terra)"></i>платежи не вносятся</span>'
            : '<span><i style="background:var(--p-olive)"></i>без просрочки</span>' +
              '<span><i style="background:var(--p-beige)"></i>до 30 дней</span>' +
              '<span><i style="background:var(--p-amber)"></i>30—90 дней</span>' +
              '<span><i style="background:var(--p-terra)"></i>свыше 90 дней</span>') +
          '<span><i style="background:var(--p-greige)"></i>нет данных</span></div>');
      }

      if (res.beforeMonths && res.beforeSum > 0) {
        const chg = (res.total / res.beforeMonths * res.beforeMonths / res.beforeSum - 1);
        const perA = res.beforeSum / res.beforeMonths, perB = res.total / res.afterMonths;
        const d = ((perB / perA - 1) * 100).toFixed(1).replace('.', ',').replace('-', '−');
        h2(++sec, 'Сопоставление периодов');
        tbl([31, 23, 23, 23],
          '<tr><th>Показатель</th><th class="r">' + res.beforeMonths + NB + 'мес. до сделки</th>' +
          '<th class="r">' + res.afterMonths + NB + 'мес. после сделки</th>' +
          '<th class="r">Изменение</th></tr>', [
            '<tr><td>Внесено всего, ₽</td><td class="r">' + money(res.beforeSum) + '</td>' +
              '<td class="r">' + money(res.total) + '</td><td class="r">' +
              ((res.total / res.beforeSum - 1) * 100).toFixed(1).replace('.', ',').replace('-', '−') +
              NB + '%</td></tr>',
            '<tr><td>В среднем за месяц, ₽</td><td class="r">' + money(perA) + '</td>' +
              '<td class="r">' + money(perB) + '</td><td class="r">' + d + NB + '%</td></tr>',
            '<tr><td>Количество платежей</td><td class="r">' + res.beforeCount + '</td>' +
              '<td class="r">' + res.count + '</td><td class="r">' +
              (res.count - res.beforeCount >= 0 ? '+' : '−') + Math.abs(res.count - res.beforeCount) +
              '</td></tr>'
          ]);
        add('<p class="small">Период «до» взят той же длины, что и период после сделки (' +
          dlong(res.beforeStart) + ' — ' + dlong(from) + '). Усреднение по всей истории занижало бы ' +
          'показатель «до» и создавало бы видимость роста.</p>');
      }

      const mismatched = res.perContract.filter((x) => x.c.totalsMatch === false);
      if (mismatched.length) {
        h2(++sec, 'Расхождения внутри самого отчёта');
        add('<p class="small">ОКБ печатает поле «Сумма всех внесенных платежей» отдельно от ' +
          'построчного списка, и эти значения формируются кредитором независимо. Расхождение — ' +
          'не ошибка расчёта, а основание истребовать выписку у кредитора.</p>', true);
        tbl([30, 14, 19, 19, 18],
          '<tr><th>Кредитор</th><th>Договор от</th><th class="r">Агрегат отчёта, ₽</th>' +
          '<th class="r">Сумма списка, ₽</th><th class="r">Расхождение, ₽</th></tr>',
          mismatched.map((x) => '<tr><td>' + esc(x.c.creditor) + '</td>' +
            '<td class="sub">' + dshort(x.c.contractDate) + '</td>' +
            '<td class="r">' + money(x.c.controlTotals.total) + '</td>' +
            '<td class="r">' + money(x.c.parsedTotal) + '</td>' +
            '<td class="r">' + money(Math.abs(x.c.controlTotals.total - x.c.parsedTotal)) +
            '</td></tr>'));
      }
    }

    /* --- часть IV: построчная расшифровка --- */
    if (opts.ledger) {
      part('Часть IV · Расшифровка платежей', 'Все платежи после сделки, по договорам',
        'исключённые записи приведены серым · «лист» — страница исходного отчёта');

      for (const c of report.contracts) {
        const inPeriod = c.payments.filter((p) =>
          (filters.strict ? p.date > from : p.date >= from) && p.date <= until);
        if (!inPeriod.length) continue;

        const it = res.perContract.find((x) => x.c === c);
        const brk = it && (it.interest || it.other);
        const cols = brk
          ? '<tr><th>Дата</th><th class="r">Сумма, ₽</th><th class="r">Осн. долг</th>' +
            '<th class="r">Проценты</th><th class="r">Иное</th><th>Статус</th>' +
            '<th class="r">Нараст. итог</th><th class="r">Лист</th></tr>'
          : '<tr><th>Дата</th><th class="r">Сумма, ₽</th><th>Статус</th>' +
            '<th class="r">Нараст. итог</th><th class="r">Лист</th></tr>';
        const w = brk ? [16, 13, 12, 12, 11, 15, 15, 6] : [21, 19, 25, 24, 11];

        const rows = [];
        let run = 0, skip = 0;
        for (const p of inPeriod) {
          if (skip > 0) { skip--; continue; }
          const v = it ? verdict(p) : 'status';
          const ok = v === 'counted';
          if (ok) run += p.amount || 0;
          // Сумму такой строки отчёт напечатал так, что разобрать её не вышло.
          // Из итога она не выпадает (вклад нулевой), но пометить надо.
          const mark = !ok ? VERDICT[v] || 'исключено'
            : p.amount == null ? VERDICT.unknown : '';
          rows.push('<tr' + (ok ? '' : ' class="off"') + '><td>' + dshort(p.date) +
            (mark ? '<span class="pill">' + mark + '</span>' : '') + '</td>' +
            '<td class="r">' + money(p.amount) + '</td>' +
            (brk ? '<td class="r sub">' + money(p.principal) + '</td>' +
              '<td class="r sub">' + money(p.interest) + '</td>' +
              '<td class="r sub">' + money(p.other) + '</td>' : '') +
            '<td class="st">' + esc(ST_SHORT[p.status] || P.STATUS_TITLES[p.status] || '—') + '</td>' +
            '<td class="r">' + (ok ? money(run) : '<span class="nd">—</span>') + '</td>' +
            '<td class="r sub">' + p.page + '</td></tr>');

          // Двадцать девять одинаковых строк подряд ничего не добавляют:
          // сворачиваем в одну, сохранив количество, сумму и лист.
          const g = opts.foldDup && p.dupCount && filters.dedupe &&
            (c.duplicates || []).find((x) => x.date === p.date && x.amount === p.amount);
          if (g) {
            rows.push('<tr class="off"><td colspan="' + (brk ? 5 : 2) + '">Ещё ' + (g.count - 1) + ' ' +
              plural(g.count - 1, 'идентичная запись', 'идентичные записи', 'идентичных записей') +
              ' за ' + dshort(g.date) + ' по ' + money(g.amount) + NB + '₽ на сумму ' +
              money(g.extra) + NB + '₽ — сбой отчёта, в расчёт не приняты</td>' +
              '<td class="st">исключено</td><td class="r"><span class="nd">—</span></td>' +
              '<td class="r sub">' + g.page + '</td></tr>');
            skip = g.count - 1;
          }
        }

        const n = it ? it.pays.length : 0;
        tbl(w, cols, rows,
          '<tr class="tsum"><td>Итого зачтено: ' + n + NB + plural(n, 'платёж', 'платежа', 'платежей') +
          '</td><td class="r">' + money(it ? it.total : 0) + '</td>' +
          (brk ? '<td class="r">' + money(it.principal) + '</td>' +
            '<td class="r">' + money(it.interest) + '</td>' +
            '<td class="r">' + money(it.other) + '</td>' : '') +
          '<td colspan="3"></td></tr>',
          { cls: 'ledger',
            head: '<div class="chead"><div class="cname">' + esc(c.creditor) + '</div>' +
              '<div class="cmeta">' + esc(kindShort(c)) + ' · договор от ' + dlong(c.contractDate) +
              ' · ' + (c.section === 'active' ? 'действующий' : 'закрытый') +
              ' · листы отчёта ' + c.page + '—' + lastPage(c) + '</div></div>',
            cont: '<div class="chead cont"><div class="cname">' + esc(c.creditor) + '</div>' +
              '<div class="cmeta">продолжение · договор от ' + dlong(c.contractDate) + '</div></div>' });
      }
    }

    /* --- часть V: методика --- */
    if (opts.method) {
      part('Часть V · Порядок расчёта', 'Методика и оговорки',
        'чтобы расчёт можно было повторить и проверить');

      h2(++sec, 'Источник данных');
      const src = ['<dt>Файл отчёта</dt><dd>' + esc(report.fileName || '—') +
        (report.fileSize ? ', ' + (report.fileSize / 1048576).toFixed(2).replace('.', ',') + NB + 'МБ' : '') +
        '</dd>'];
      if (report.fileSha) src.push('<dt>Контрольная сумма SHA-256</dt><dd class="hash">' +
        report.fileSha + '</dd>');
      src.push('<dt>Отчёт сформирован</dt><dd>' + dlong(meta.reportDate) + '</dd>');
      src.push('<dt>Субъект</dt><dd>' + esc(fio) + '</dd>');
      add('<div class="pcard"><dl class="facts">' + src.join('') + '</dl>' +
        (report.fileSha ? '<p class="small" style="margin:8pt 0 0">Контрольная сумма позволяет ' +
          'убедиться, что расчёт произведён именно по этому файлу: любое изменение отчёта, вплоть ' +
          'до одного символа, даёт другое значение.</p>' : '') + '</div>');

      // Без перечня настроек цифру нельзя воспроизвести: из тех же данных
      // с другими фильтрами получится другой итог.
      h2(++sec, 'Настройки, при которых получен результат');
      add('<div class="pcard"><dl class="facts">' +
        '<dt>Дата сделки</dt><dd>' + dlong(from) + (filters.strict
          ? ', платежи строго позднее' : ', включая платежи этого дня') + '</dd>' +
        '<dt>Конец периода</dt><dd>' + (deal.until ? dlong(deal.until)
          : dlong(until) + ' (дата формирования отчёта)') + '</dd>' +
        '<dt>Договоры</dt><dd>' + (filters.status === 'all' ? 'действующие и закрытые'
          : filters.status === 'active' ? 'только действующие' : 'только закрытые') + '</dd>' +
        '<dt>Повторы записей</dt><dd>' + (filters.dedupe
          ? 'группа засчитана один раз' : 'учтены все записи') + '</dd>' +
        '<dt>Договоры после сделки</dt><dd>' + (filters.excludeNew
          ? 'исключены из расчёта' : 'включены в расчёт') + '</dd>' +
        (filters.min > 0 ? '<dt>Порог суммы</dt><dd>платежи меньше ' + money(filters.min) +
          NB + '₽ не учитывались</dd>' : '') +
        (filters.hideZero ? '<dt>Нулевые платежи</dt><dd>не учитывались</dd>' : '') +
        (old && filters.statuses ? '<dt>Учтённые статусы</dt><dd>' +
          filters.statuses.map((k) => esc(P.STATUS_TITLES[k] || k)).join(', ') + '</dd>' : '') +
        '</dl></div>');

      h2(++sec, 'Как считалось');
      add('<div class="pcard"><p>Расчёт произведён по разделу «Фактические платежи по договору» — ' +
        'единственному разделу отчёта, содержащему даты внесения платежей.</p>' +
        (old ? '<p><b>Начисления не считаются платежами.</b> В отчётах старого формата статус ' +
          'платежа обозначен цветным значком. Суммы со статусом «платежи не вносятся» — ' +
          'начисленные банком проценты и неустойка.</p>' : '') +
        (filters.dedupe ? '<p><b>Повторы отсеиваются.</b> ОКБ иногда печатает один платёж ' +
          'многократно одной датой. Признак сбоя — неизменность основного долга в этот день. ' +
          'Из группы засчитывается один платёж.</p>' : '') +
        '<p style="margin:0">Разбивка на основной долг, проценты и иное приведена там, где её ' +
        'передал кредитор. Где не передал, показано «нет данных», а сумма платежа учтена ' +
        'целиком.</p></div>');

      h2(++sec, 'Границы применимости');
      add('<p>Расчёт отражает <b>только те платежи, сведения о которых кредиторы передали в бюро ' +
        'кредитных историй</b>. Он не охватывает расчёты наличными, платежи по обязательствам вне ' +
        'кредитных договоров и договоры, по которым списка платежей нет. Итоговая сумма является ' +
        'оценкой снизу.</p>', true);
      add('<div class="stamp">Расчёт выполнен автоматически, без передачи файла отчёта третьим ' +
        'лицам: разбор PDF происходит в браузере на устройстве пользователя.</div>');
    }

    return { blocks: B, fio: fio, from: from };
  }

  /* ================= обмер ================= */

  async function measure(blocks, opts) {
    const box = document.createElement('div');
    box.className = 'pdfdoc measuring' + (opts.wideMargin ? ' wide' : '');
    box.innerHTML = '<div class="pdfsheet auto">' +
      '<div class="rh" data-m="RH"><span class="pwho"><span class="mk"></span>x</span><span>x</span></div>' +
      blocks.map((b, i) => b.tbl
        ? '<div class="probe" data-m="H' + b.tbl.id + '">' + b.tbl.head + '</div>' +
          '<div class="probe" data-m="C' + b.tbl.id + '">' + b.tbl.cont + '</div>' +
          '<table class="' + b.tbl.cls + '" data-m="T' + b.tbl.id + '">' + b.tbl.cg +
          '<thead>' + b.tbl.cols + '</thead><tbody>' + b.tbl.rows.join('') + b.tbl.total + '</tbody></table>'
        : '<div data-m="B' + i + '">' + b.html + '</div>').join('') +
      '<div class="rf" data-m="RF"><span>x</span><span>x</span></div></div>';
    document.body.appendChild(box);

    if (document.fonts && document.fonts.ready) await document.fonts.ready;

    const M = {};
    const els = box.querySelectorAll('[data-m]');
    for (const el of els) {
      const k = el.dataset.m;
      if (k[0] === 'T') {
        const cs = getComputedStyle(el);
        M[k] = {
          thead: el.tHead.getBoundingClientRect().height,
          gap: parseFloat(cs.marginTop) + parseFloat(cs.marginBottom),
          rows: [].map.call(el.querySelectorAll('tbody tr'), (r) => r.getBoundingClientRect().height)
        };
      } else if (k === 'RH' || k === 'RF') {
        const cs = getComputedStyle(el);
        M[k] = el.getBoundingClientRect().height +
          Math.max(0, parseFloat(cs.marginTop)) + Math.max(0, parseFloat(cs.marginBottom));
      } else {
        // Блок — flex-элемент листа, поэтому поля его потомков наружу
        // не схлопываются и уже входят в измеренную высоту.
        M[k] = el.getBoundingClientRect().height;
      }
    }
    box.remove();
    return M;
  }

  /* ================= раскладка ================= */

  // Минимум строк, ради которых стоит начинать таблицу внизу листа:
  // две строки под шапкой выглядят как обрывок.
  const MINROWS = 3;

  function paginate(blocks, M) {
    // Лист A4 за вычетом полей и колонтитулов, и ещё миллиметр про запас:
    // округления при печати не должны выдавливать последнюю строку за лист.
    const AVAIL = 270 * MM - M.RH - M.RF - MM;
    const sheets = [];
    let cur = [], used = 0;
    const flush = () => { if (cur.length) sheets.push(cur); cur = []; used = 0; };
    const put = (html, h) => { cur.push(html); used += h; };

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];

      if (!b.tbl) {
        const h = M['B' + i];
        if (b.brk) flush();
        // Заголовок не должен остаться внизу листа в одиночестве: считаем,
        // сколько места нужно ему вместе со склеенным продолжением.
        let need = h;
        for (let j = i; blocks[j] && blocks[j].glue && blocks[j + 1]; j++) {
          const nx = blocks[j + 1];
          if (nx.tbl) {
            const T = M['T' + nx.tbl.id];
            need += M['H' + nx.tbl.id] + T.gap + T.thead + T.rows[0];
            break;
          }
          need += M['B' + (j + 1)];
        }
        if (used > 0 && used + need > AVAIL) flush();
        put(b.html, h);
        continue;
      }

      const L = b.tbl, T = M['T' + L.id];
      const rowH = T.rows.slice(0, L.rows.length);
      const totH = L.total ? T.rows[T.rows.length - 1] : 0;
      let k = 0;
      while (k < L.rows.length) {
        const hd = k === 0 ? M['H' + L.id] : M['C' + L.id];
        const chunk = Math.min(MINROWS, L.rows.length - k);
        let probe = 0;
        for (let q = 0; q < chunk; q++) probe += rowH[k + q];
        if (used > 0 && used + hd + T.gap + T.thead + probe > AVAIL) flush();

        let n = 0, h = used + hd + T.gap + T.thead;
        while (k + n < L.rows.length && h + rowH[k + n] <= AVAIL) { h += rowH[k + n]; n++; }
        // Строка «Итого» не должна отрываться от последней строки таблицы,
        // а на продолжении не должна оставаться одна строка-сирота.
        if (k + n >= L.rows.length && h + totH > AVAIL) n--;
        if (L.rows.length - (k + n) === 1 && n > 1) n--;
        if (n <= 0) { flush(); continue; }

        const last = k + n >= L.rows.length;
        let sum = 0;
        for (let q = 0; q < n; q++) sum += rowH[k + q];
        put((k === 0 ? L.head : L.cont) + '<table class="' + L.cls + '">' + L.cg +
          '<thead>' + L.cols + '</thead><tbody>' + L.rows.slice(k, k + n).join('') +
          (last ? L.total : '') + '</tbody></table>',
          hd + T.gap + T.thead + sum + (last ? totH : 0));
        k += n;
        if (!last) flush();
      }
    }
    flush();
    return sheets;
  }

  /* ================= сборка ================= */

  async function build(ctx) {
    const material = collect(ctx);
    const M = await measure(material.blocks, ctx.opts);
    const sheets = paginate(material.blocks, M);

    const rh = '<div class="rh"><span class="pwho"><span class="mk"></span>' + esc(material.fio) +
      '</span><span>Приложение к заключению финансового управляющего</span></div>';
    const foot = esc(material.fio) + ' · сделка ' + dshort(material.from);

    return '<div class="pdfdoc' + (ctx.opts.wideMargin ? ' wide' : '') + '" id="pdfdoc">' +
      sheets.map((s, i) => '<div class="pdfsheet">' + rh + s.join('') +
        '<div class="rf"><span>' + foot + '</span><span>Лист ' + (i + 1) + ' из ' +
        sheets.length + '</span></div></div>').join('') + '</div>';
  }

  globalThis.OKBPdf = { build: build };
})();
