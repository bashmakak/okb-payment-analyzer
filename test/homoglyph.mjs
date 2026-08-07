/*
 * Проверка устойчивости к подмене букв.
 *
 * ОКБ произвольно заменяет часть кириллицы латинскими двойниками, и набор
 * испорченных подписей меняется от отчёта к отчёту. Тест берёт настоящий
 * отчёт, портит в нём ВСЕ подверженные буквы и убеждается, что разбор даёт
 * ровно тот же результат.
 *
 *   node test/homoglyph.mjs <файл.pdf>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(fs.readFileSync(path.join(root, 'src', 'parser.js'), 'utf8'))();
const P = globalThis.OKBParser;

// Кириллица → латинские двойники: ровно то, что делает генератор отчётов.
const TO_LATIN = {
  'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M','О':'O','Р':'P','Т':'T','Х':'X','У':'Y',
  'а':'a','с':'c','е':'e','о':'o','р':'p','х':'x','у':'y'
};
const mangle = (s) => s.replace(/[АВСЕНКМОРТХУасеорху]/g, (c) => TO_LATIN[c] || c);

async function rowsOf(file, transform) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    pages.push({
      num: n,
      rows: P.buildRows(tc.items.map((it) => ({
        str: transform(it.str), x: it.transform[4], y: it.transform[5], width: it.width
      })))
    });
  }
  return pages;
}

const file = process.argv[2];
const clean = P.parse(await rowsOf(file, (s) => s));
const dirty = P.parse(await rowsOf(file, mangle));

// Названия кредиторов в испорченной версии заведомо другие — сравниваем
// то, от чего зависит расчёт: структуру, даты и суммы.
const shape = (r) => r.contracts.map((c) => [
  c.index, c.section, c.contractDate, c.hasPaymentTable,
  c.payments.length, c.parsedTotal,
  c.controlTotals ? c.controlTotals.total : null
]);

let fail = 0;
const eq = (name, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'СБОЙ'} ${name}`);
  if (!ok) console.log(`      чистый:  ${JSON.stringify(a)}\n      битый:   ${JSON.stringify(b)}`);
};

console.log(path.basename(file) + '\n');
console.log(`  чистый отчёт: ${clean.contracts.length} договоров, ` +
  `${clean.contracts.reduce((a, c) => a + c.payments.length, 0)} платежей`);
console.log(`  с подменой:   ${dirty.contracts.length} договоров, ` +
  `${dirty.contracts.reduce((a, c) => a + c.payments.length, 0)} платежей\n`);

eq('дата отчёта', clean.meta.reportDate, dirty.meta.reportDate);
eq('версия формата', clean.meta.version, dirty.meta.version);
eq('предупреждения разбора', clean.warnings, dirty.warnings);
eq('структура, даты и суммы по всем договорам', shape(clean), shape(dirty));

console.log('\n' + (fail ? `ПРОВАЛЕНО: ${fail}` : 'Подмена букв на разбор не влияет.'));
process.exit(fail ? 1 : 0);
