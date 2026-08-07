/*
 * Собирает dist/_selftest.html — копию приложения со встроенным PDF, который
 * подставляется в поле выбора файла сразу после загрузки страницы. Нужен,
 * чтобы прогнать весь путь (pdf.js → парсер → интерфейс) прямо из file://,
 * где вручную выбрать файл в автоматическом браузере нельзя.
 *
 *   node test/selftest-build.mjs <файл.pdf>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfPath = process.argv[2];
const app = path.join(root, 'dist', 'Платежи после сделки.html');

const b64 = fs.readFileSync(pdfPath).toString('base64');
const inject = `
<script>
window.addEventListener('load', () => {
  const bin = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], ${JSON.stringify(path.basename(pdfPath))}, { type: 'application/pdf' }));
  const input = document.getElementById('file');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
});
</script>`;

const html = fs.readFileSync(app, 'utf8').replace('</body>', inject + '\n</body>');
const out = path.join(root, 'dist', '_selftest.html');
fs.writeFileSync(out, html, 'utf8');
console.log('Готово:', out, (Buffer.byteLength(html) / 1024 / 1024).toFixed(2), 'МБ');
