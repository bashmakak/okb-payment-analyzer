/*
 * Сквозная проверка выгрузки в PDF прямо из file://.
 *
 * Собирает копию приложения со встроенным отчётом, сама вводит дату сделки,
 * открывает настройки, жмёт «Сформировать» и меряет каждый лист: содержимое
 * не должно вылезать за границы A4, а «Итого» — отрываться от таблицы.
 * Раскладка держится на измерении высот, поэтому проверять её надо в браузере,
 * а не в голове.
 *
 *   node test/pdf-check.mjs <файл.pdf> [дата дд.мм.гггг]
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfPath = process.argv[2];
const deal = process.argv[3] || '01.01.2023';
const CHROME = process.env.CHROME ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!pdfPath) {
  console.error('Укажите PDF: node test/pdf-check.mjs <файл.pdf> [дд.мм.гггг]');
  process.exit(2);
}

const appFile = path.join(root, 'dist', 'Платежи после сделки.html');
if (!fs.existsSync(appFile)) {
  console.error('Сначала соберите приложение: node build.mjs');
  process.exit(2);
}

const b64 = fs.readFileSync(pdfPath).toString('base64');
const inject = `
<script>
const wait = (fn, ms) => new Promise((ok, no) => {
  const t0 = Date.now();
  (function tick() {
    let v; try { v = fn(); } catch (e) { v = null; }
    if (v) return ok(v);
    if (Date.now() - t0 > (ms || 60000)) return no(new Error('таймаут: ' + fn));
    setTimeout(tick, 120);
  })();
});
const report = (o) => { document.body.innerHTML = '<pre id="R">' + JSON.stringify(o) + '</pre>'; };

window.addEventListener('load', async () => {
  try {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(path.basename(pdfPath))}, { type: 'application/pdf' }));
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    await wait(() => !document.getElementById('screen-report').hidden, 180000);

    const d = document.getElementById('deal-date');
    d.value = ${JSON.stringify(deal)};
    d.dispatchEvent(new Event('input'));

    document.getElementById('btn-print').click();
    await wait(() => !document.getElementById('pdfopts').hidden);
    document.getElementById('pdf-go').click();
    await wait(() => !document.getElementById('pdfview').hidden, 120000);

    const sheets = [...document.querySelectorAll('.pdfsheet')];
    const A4 = 297 * 3.7795275591;
    const bad = [];
    sheets.forEach((s, i) => {
      const over = s.scrollHeight - s.clientHeight;
      const h = s.getBoundingClientRect().height;
      if (over > 1) bad.push({ sheet: i + 1, over: Math.round(over) });
      if (Math.abs(h - A4) > 2) bad.push({ sheet: i + 1, height: Math.round(h) });
    });
    // «Итого» не должно оказаться первой строкой листа без своей таблицы,
    // а продолжение — начинаться без повторённой шапки.
    const orphans = [];
    sheets.forEach((s, i) => {
      s.querySelectorAll('table').forEach((t) => {
        const rows = t.querySelectorAll('tbody tr');
        if (rows.length === 1 && rows[0].classList.contains('tot')) orphans.push(i + 1);
        if (!t.tHead || !t.tHead.rows.length) orphans.push(i + 1);
      });
    });
    const txt = document.getElementById('pdf-scroll').innerText;
    report({
      ok: !bad.length && !orphans.length,
      sheets: sheets.length,
      overflow: bad, orphans: orphans,
      counter: (document.getElementById('pdf-count') || {}).textContent || '',
      undefinedInText: (txt.match(/undefined|NaN/g) || []).length,
      totalLine: (txt.match(/Внесено после сделки\\s*\\n?\\s*([^\\n]+)/) || [])[1] || ''
    });
  } catch (e) {
    report({ ok: false, error: String(e && e.message || e) });
  }
});
</script>`;

const out = path.join(root, 'dist', '_pdfcheck.html');
fs.writeFileSync(out, fs.readFileSync(appFile, 'utf8').replace('</body>', inject + '\n</body>'), 'utf8');

const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--dump-dom',
  '--virtual-time-budget=300000', 'file:///' + out.replace(/\\/g, '/')],
  { encoding: 'utf8', maxBuffer: 1 << 28 });

const m = dom.match(/<pre id="R">([\s\S]*?)<\/pre>/);
if (!m) {
  console.error('Страница не отчиталась — вероятно, скрипт упал до отчёта.');
  process.exit(1);
}
const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

console.log('дата сделки:', deal);
if (r.error) { console.log('ОШИБКА:', r.error); process.exit(1); }
console.log('листов:', r.sheets, '|', r.counter);
console.log('итог:', r.totalLine);
if (r.overflow.length) console.log('ПЕРЕПОЛНЕНИЕ:', JSON.stringify(r.overflow));
if (r.orphans.length) console.log('ТАБЛИЦЫ БЕЗ ШАПКИ ИЛИ СИРОТЫ:', JSON.stringify(r.orphans));
if (r.undefinedInText) console.log('undefined/NaN в тексте:', r.undefinedInText);

const ok = r.ok && !r.undefinedInText;
console.log(ok ? 'Выгрузка собрана без замечаний.' : 'ЕСТЬ ЗАМЕЧАНИЯ.');
fs.unlinkSync(out);
process.exit(ok ? 0 : 1);
