/*
 * Документ выгрузки живёт внутри той же страницы, поэтому правила сайта
 * наследуются в него. Совпадение имени класса ничего не ломает шумно —
 * оно молча меняет вёрстку листа: так .tot из списка кредиторов однажды
 * поставил nowrap строке «Итого зачтено», и она наехала на числа.
 *
 * Ругаемся не на само совпадение имени, а на свойство, которое правило
 * сайта задаёт, а стили .pdfdoc не перекрывают.
 *
 *   node test/css-clash.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'src', 'app.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const pdf = fs.readFileSync(path.join(root, 'src', 'pdf.js'), 'utf8');

const PDF_SCOPE = /\.pdf(doc|sheet|view|bar)\b/;

// Классы, которые выгрузка ставит на элементы.
const used = new Set();
for (const m of pdf.matchAll(/class="([^"$]+)"/g))
  for (const c of m[1].split(/\s+/)) if (c) used.add(c);
for (const m of pdf.matchAll(/cls: '([^']+)'/g)) used.add(m[1]);

const rules = [];
for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const head = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!head || head.startsWith('@')) continue;
  const props = new Set();
  for (const d of m[2].split(';')) {
    const p = d.split(':')[0].trim().toLowerCase();
    if (p) props.add(p);
  }
  for (const sel of head.split(',')) rules.push({ sel: sel.trim(), props });
}

// Что уже перекрыто внутри .pdfdoc — по классу.
const covered = new Map();
for (const r of rules) {
  if (!PDF_SCOPE.test(r.sel)) continue;
  for (const m of r.sel.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    if (!used.has(m[1])) continue;
    if (!covered.has(m[1])) covered.set(m[1], new Set());
    for (const p of r.props) covered.get(m[1]).add(p);
  }
}

// Опасны правила сайта без внешнего предка: «.card{}» достанет .pdfdoc .card,
// а «.chipm .dot{}» — нет.
const problems = [];
for (const r of rules) {
  if (PDF_SCOPE.test(r.sel) || /[\s>+~]/.test(r.sel)) continue;
  for (const m of r.sel.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    const cls = m[1];
    if (!used.has(cls)) continue;
    const own = covered.get(cls) || new Set();
    const leaks = [...r.props].filter((p) => !own.has(p) && p !== 'content');
    if (leaks.length) problems.push({ cls, sel: r.sel, leaks });
  }
}

if (!problems.length) {
  console.log('Пересечений классов между сайтом и выгрузкой нет.');
  process.exit(0);
}
console.log('ПЕРЕСЕЧЕНИЯ КЛАССОВ — правила сайта достанут документ выгрузки:');
for (const p of problems) {
  console.log('  .' + p.cls + '  ←  ' + p.sel + '  задаёт: ' + p.leaks.join(', '));
}
console.log('Переименуйте класс в src/pdf.js и в стилях .pdfdoc либо перекройте свойства.');
process.exit(1);
