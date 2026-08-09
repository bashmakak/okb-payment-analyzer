/*
 * Node-стенд: прогоняет тот же самый parser.js по реальным PDF и сверяет
 * разобранные суммы с контрольными значениями из самого отчёта.
 *
 *   node test/run.mjs <файл.pdf> [ещё файлы...]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// parser.js рассчитан на globalThis — исполняем его как есть, без правок.
new Function(fs.readFileSync(path.join(root, 'src', 'parser.js'), 'utf8'))();
const P = globalThis.OKBParser;

const money = (v) => v == null ? '—' :
  v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

async function readPages(file) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    useSystemFonts: true
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push({
      num: n,
      rows: P.buildRows(tc.items.map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], width: it.width
      }))),
      // Нужны только старому формату: статус платежа нарисован иконкой.
      shapes: P.buildShapes(await page.getOperatorList(), pdfjs.OPS)
    });
  }
  return pages;
}

// Ошибка разбора и расхождение с контрольной суммой — разные вещи. ОКБ
// печатает агрегат «Сумма всех внесенных платежей» отдельно от построчного
// списка, и в реальных отчётах они регулярно не сходятся (проверено вручную:
// закрытый договор с 12 платежами по 5 260 ₽ при агрегате 0 ₽). Поэтому
// падением теста считаем только признаки сбоя разбора.
let failures = 0;
let mismatches = 0;

for (const file of process.argv.slice(2)) {
  console.log('\n' + '='.repeat(78));
  console.log(path.basename(file));
  console.log('='.repeat(78));

  const report = P.parse(await readPages(file));
  const m = report.meta;
  console.log(`Субъект: ${m.fio}   Отчёт от ${P.formatDate(m.reportDate)}   формат ${m.version} (${m.format})   стр. ${m.pages}`);

  if (m.format === 'old') {
    const all = {};
    for (const c of report.contracts)
      for (const k in c.statusCounts) all[k] = (all[k] || 0) + c.statusCounts[k];
    console.log('Статусы платежей: ' + Object.entries(all)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${P.STATUS_TITLES[k] || k} — ${n}`).join('; '));
  }
  for (const w of report.warnings) console.log('  ! ' + w);

  const withTable = report.contracts.filter((c) => c.hasPaymentTable);
  const allPayments = report.contracts.reduce((a, c) => a + c.payments.length, 0);
  console.log(`Договоров: ${report.contracts.length} ` +
    `(действующих ${report.contracts.filter((c) => c.section === 'active').length}, ` +
    `закрытых ${report.contracts.filter((c) => c.section === 'closed').length}); ` +
    `с таблицей платежей ${withTable.length}; платежей всего ${allPayments}`);
  console.log('');

  for (const c of report.contracts) {
    const mark = c.totalsMatch === true ? 'OK  '
      : c.totalsMatch === false ? 'РАСХ'
      : c.hasPaymentTable ? '?   ' : '--  ';
    const dates = c.payments.length
      ? `${P.formatDate(c.payments[0].date)} … ${P.formatDate(c.payments[c.payments.length - 1].date)}`
      : 'нет платежей';
    console.log(
      `${mark} ${String(c.index).padStart(2)}. ${(c.section === 'active' ? '[дейст]' : '[закр] ')} ` +
      `${c.creditor.padEnd(30).slice(0, 30)} ` +
      `дог. ${(c.contractDate || '—').padEnd(10)} ` +
      `плат. ${String(c.payments.length).padStart(3)}  ` +
      `${money(c.parsedTotal).padStart(16)} / ${money(c.controlTotals?.total).padStart(16)}  ${dates}`
    );
    if (report.meta.format === 'old' && c.payments.length) {
      const breakdown = Object.entries(c.statusCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${P.STATUS_TITLES[k] || k}: ${n}`).join(', ');
      console.log(`      статусы — ${breakdown}`);
      console.log(`      к зачёту (только оплаченные): ${money(c.paidTotal)} из ${money(c.parsedTotal)}`);
    }
    for (const g of (c.duplicates || [])) {
      console.log(`      ! ПОВТОР: ${g.date} × ${g.count} по ${money(g.amount)} — лишнее ${money(g.extra)}` +
        (g.debtMoved === false ? ', основной долг в этот день не изменился' : '') + `, лист ${g.page}`);
    }
    if (c.totalsMatch === false) {
      mismatches++;
      console.log(`      ^ агрегат отчёта расходится со списком на ${money(c.totalsDiff)}`);
    }
    if (c.hasPaymentTable && c.controlTotals == null) {
      failures++;
      console.log('      ^ СБОЙ: не найдена контрольная сумма');
    }
    for (const w of c.warnings) { failures++; console.log('      ! СБОЙ: ' + w); }

    // Целостность каждой строки: сумма платежа = долг + проценты + иное.
    let broken = 0;
    for (const p of c.payments) {
      if (p.amount == null) { broken++; continue; }
      const parts = [p.principal, p.interest, p.other];
      if (parts.every((v) => v == null)) continue;
      const s = parts.reduce((a, v) => a + (v || 0), 0);
      if (Math.abs(s - p.amount) > 0.02) broken++;
    }
    if (broken) console.log(`      · строк, где сумма ≠ долг+проценты+иное: ${broken} из ${c.payments.length}`);
  }
}

console.log('');
console.log(failures
  ? `СБОЕВ РАЗБОРА: ${failures}`
  : 'Сбоев разбора нет.');
console.log(mismatches
  ? `Договоров, где агрегат отчёта не сходится с его же списком платежей: ${mismatches} (особенность данных ОКБ, не ошибка разбора).`
  : 'Все агрегаты сошлись со списками платежей.');
process.exit(failures ? 1 : 0);
