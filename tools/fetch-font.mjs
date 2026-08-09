/*
 * Скачивает Onest (кириллица + латиница) с Google Fonts и складывает
 * в src/fonts/onest.css как @font-face с data:-URI.
 *
 * Шрифт встраивается в сборку, потому что приложение обязано работать
 * с флешки без интернета: ссылка на CDN там молча отвалится.
 *
 * Onest распространяется по SIL Open Font License 1.1.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'fonts');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CSS = 'https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&display=swap';

const css = await (await fetch(CSS, { headers: { 'User-Agent': UA } })).text();

// Google отдаёт по блоку @font-face на каждый поднабор символов, причём имя
// поднабора стоит в комментарии ПЕРЕД блоком. Поэтому разбираем пары
// «комментарий + блок», а не режем строку по @font-face.
const pairs = [...css.matchAll(/\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)]
  .map((m) => ({ subset: m[1], block: m[2] }));

const wanted = pairs.filter((p) => p.subset === 'cyrillic' || p.subset === 'latin');
console.log(`блоков всего ${pairs.length}, берём ${wanted.length}: ` +
  [...new Set(wanted.map((w) => w.subset))].join(', '));

let out = '/* Onest — SIL Open Font License 1.1, встроен для работы без интернета */\n';
let bytes = 0;

for (const { subset, block } of wanted) {
  const url = block.match(/url\((https:[^)]+\.woff2)\)/);
  const weight = block.match(/font-weight:\s*(\d+)/);
  if (!url) continue;
  const buf = Buffer.from(await (await fetch(url[1], { headers: { 'User-Agent': UA } })).arrayBuffer());
  bytes += buf.length;
  const range = block.match(/unicode-range:\s*([^;]+);/);
  out += `@font-face{font-family:Onest;font-style:normal;font-weight:${weight ? weight[1] : 400};`
    + `font-display:swap;src:url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');`
    + (range ? `unicode-range:${range[1].trim()};` : '') + '}\n';
  console.log(`  ${subset} ${weight ? weight[1] : '?'} — ${(buf.length / 1024).toFixed(1)} КБ`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'onest.css'), out, 'utf8');
console.log(`\nИтого шрифтов: ${(bytes / 1024).toFixed(1)} КБ · файл ${(Buffer.byteLength(out) / 1024).toFixed(1)} КБ`);
