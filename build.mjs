/*
 * Сборка приложения в один файл: pdf.js, его воркер и парсер
 * встраиваются прямо в HTML, чтобы файл открывался двойным кликом
 * (file://) без сервера и без интернета.
 *
 *   node build.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build');

/**
 * pdf.js поставляется только как ES-модуль. Инлайн-модуль в HTML нельзя
 * импортировать, поэтому забираем нужные экспорты через globalThis: читаем
 * финальный `export{...}` бандла и дописываем присваивание с его локальными
 * именами. Имена минифицированы, но берём мы их из самого файла, так что
 * пересборка на новой версии pdf.js ничего не сломает.
 */
function exposeExports(src, globalName, wanted) {
  const tail = src.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!tail) throw new Error(`не найден export{...} в бандле ${globalName}`);

  const map = new Map();
  for (const part of tail[1].split(',')) {
    const m = part.trim().match(/^(\S+)(?:\s+as\s+(\S+))?$/);
    if (m) map.set(m[2] || m[1], m[1]);
  }

  const fields = wanted.map((name) => {
    const local = map.get(name);
    if (!local) throw new Error(`бандл ${globalName} не экспортирует ${name}`);
    return `${JSON.stringify(name)}:${local}`;
  });

  return `${src}\nglobalThis[${JSON.stringify(globalName)}]={${fields.join(',')}};\n`;
}

/** Внутри <script> последовательность </script> закрыла бы тег раньше времени. */
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const worker = exposeExports(
  fs.readFileSync(path.join(pdfjs, 'pdf.worker.min.mjs'), 'utf8'),
  'pdfjsWorker',
  ['WorkerMessageHandler']
);

// Воркер, поднятый в globalThis, заставляет pdf.js работать в главном потоке:
// отдельный worker-файл не нужен, а из file:// его и не загрузить.
const core = exposeExports(
  fs.readFileSync(path.join(pdfjs, 'pdf.min.mjs'), 'utf8'),
  'pdfjsLib',
  ['getDocument', 'GlobalWorkerOptions', 'version', 'OPS']
);

const parser = fs.readFileSync(path.join(root, 'src', 'parser.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');

const html = fs.readFileSync(path.join(root, 'src', 'app.html'), 'utf8')
  .replace('<!-- @@PARSER@@ -->', () => `<script>${safe(parser)}</script>`)
  .replace('<!-- @@PDFJS_WORKER@@ -->', () => `<script type="module">${safe(worker)}</script>`)
  .replace('<!-- @@PDFJS@@ -->', () => `<script type="module">${safe(core)}</script>`)
  .replace('<!-- @@APP@@ -->', () => `<script type="module">${safe(app)}</script>`);

for (const marker of ['@@PARSER@@', '@@PDFJS_WORKER@@', '@@PDFJS@@', '@@APP@@']) {
  if (html.includes(marker)) throw new Error(`метка ${marker} не подставлена`);
}

fs.mkdirSync(dist, { recursive: true });

// index.html — для хостинга (Render раздаёт его как корень сайта).
// Второй файл с человеческим именем — чтобы открывать двойным кликом локально.
const outputs = ['index.html', 'Платежи после сделки.html'];
for (const name of outputs) fs.writeFileSync(path.join(dist, name), html, 'utf8');

console.log(`Готово: ${outputs.map((n) => 'dist/' + n).join(', ')}`);
console.log(`Размер: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} МБ`);
