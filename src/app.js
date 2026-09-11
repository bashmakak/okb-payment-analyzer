/*
 * Интерфейс. Разбор PDF живёт в parser.js.
 *
 * Устройство экрана: один вопрос — дата сделки — крупным полем наверху,
 * один ответ — плитка с суммой. Всё остальное убрано в «Дополнительно»,
 * потому что в девяти случаях из десяти нужна только дата.
 */
const P = globalThis.OKBParser;
const pdfjsLib = globalThis.pdfjsLib;

/* ================= состояние ================= */
let report = null;
let deals = [];
let activeDeal = null;
let dealSeq = 0;
let hideFio = false;
let activeTab = 'new';
let monthFilter = null;
let crSearch = '';
let crSort = 'total';
let openCreditors = new Set();
let bentoFirstRender = true;

const filters = {
  strict: false, status: 'all', hideZero: false, min: 0,
  statuses: null,      // только для старого формата, где статус — иконка
  excludeNew: false,
  // В старых отчётах ОКБ печатает один платёж десятки раз подряд одной датой.
  // По умолчанию считаем такую группу один раз — иначе итог завышается.
  dedupe: true
};

const PREFS_KEY = 'okb-analyzer-prefs';

/* ================= форматирование ================= */
const nfMoney = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfInt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (v) => (v == null ? '—' : nfMoney.format(v) + ' ₽');
const money0 = (v) => (v == null ? '—' : nfInt.format(Math.round(v)) + ' ₽');
const date = P.formatDate;

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

/* ================= даты ================= */
const onlyDigits = (s) => String(s).replace(/\D/g, '').slice(0, 8);

function maskDigits(d) {
  if (d.length <= 2) return d;
  if (d.length <= 4) return d.slice(0, 2) + '.' + d.slice(2);
  return d.slice(0, 2) + '.' + d.slice(2, 4) + '.' + d.slice(4);
}

function isoFromDigits(d) {
  if (d.length !== 8) return '';
  const dd = +d.slice(0, 2), mm = +d.slice(2, 4), yy = +d.slice(4, 8);
  if (mm < 1 || mm > 12 || dd < 1 || yy < 1900 || yy > 2100) return '';
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return '';
  return yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
}

const digitsFromIso = (iso) => {
  if (!iso) return '';
  const p = iso.split('-');
  return p[2] + p[1] + p[0];
};

/** Понимает «13.12.2021», «13122021», «2021-12-13» и «13 декабря 2021». */
function looseToDigits(text) {
  const t = String(text).trim();
  const full = P.parseFullDate(t);
  if (full) return digitsFromIso(full);
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return String(m[3]).padStart(2, '0') + String(m[2]).padStart(2, '0') + m[1];
  return onlyDigits(t);
}

function addMonths(iso, n) {
  const p = iso.split('-').map(Number);
  // День обрезаем по длине целевого месяца: 31.01 + 1 мес — это 28.02, а не 03.03.
  const last = new Date(Date.UTC(p[0], p[1] + n, 0)).getUTCDate();
  return new Date(Date.UTC(p[0], p[1] - 1 + n, Math.min(p[2], last))).toISOString().slice(0, 10);
}

const daysApart = (a, b) => {
  const x = a.split('-').map(Number), y = b.split('-').map(Number);
  return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 86400000);
};

const monthsBetween = (a, b) => {
  const x = a.split('-').map(Number), y = b.split('-').map(Number);
  return Math.max(1, (y[0] - x[0]) * 12 + (y[1] - x[1]) + 1);
};

/* ================= настройки ================= */
// Только настройки интерфейса. Персональному тут не место: на file://
// localStorage общий для всех локальных страниц.
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ filters, pdfOpts, crSort, hideFio })); }
  catch (e) { /* приватный режим — не критично */ }
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (!p) return;
    if (p.filters) Object.assign(filters, p.filters);
    if (p.pdfOpts) Object.assign(pdfOpts, p.pdfOpts);
    if (p.crSort) crSort = p.crSort;
    if (typeof p.hideFio === 'boolean') hideFio = p.hideFio;
  } catch (e) { /* повреждённые настройки игнорируем */ }
}

function applyPrefsToControls() {
  $('f-strict').checked = filters.strict;
  $('f-new').checked = filters.excludeNew;
  $('f-status').value = filters.status;
  $('f-zero').checked = filters.hideZero;
  $('f-min').value = filters.min;
  $('f-dup').checked = filters.dedupe;
}

/* ================= загрузка отчёта ================= */
const drop = $('drop'), fileInput = $('file');

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) load(e.target.files[0]); });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) (/\.json$/i.test(f.name) ? openSession(f) : load(f));
});

function showError(msg) {
  $('error').hidden = false;
  $('error').textContent = msg;
  $('progress').hidden = true;
}

async function load(file) {
  $('error').hidden = true;
  $('progress').hidden = false;
  $('progress-text').textContent = 'Читаю файл…';
  $('progress-fill').style.width = '0%';

  try {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      throw new Error('Нужен PDF-файл кредитного отчёта.');
    }
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      pages.push({
        num: n,
        rows: P.buildRows(tc.items.map((it) => ({
          str: it.str, x: it.transform[4], y: it.transform[5], width: it.width
        }))),
        // Нужен старому формату: статус платежа нарисован иконкой.
        shapes: P.buildShapes(await page.getOperatorList(), pdfjsLib.OPS)
      });
      if (n % 4 === 0 || n === doc.numPages) {
        $('progress-text').textContent = `Разбираю отчёт — страница ${n} из ${doc.numPages}`;
        $('progress-fill').style.width = (n / doc.numPages * 100) + '%';
        await new Promise((r) => setTimeout(r));
      }
    }

    const parsed = P.parse(pages);
    if (!parsed.contracts.length) {
      throw new Error('В файле не найдено кредитных договоров. Похоже, это не отчёт ОКБ / «Кредистория» либо структура отчёта изменилась.');
    }

    parsed.fileName = file.name;
    parsed.fileSize = file.size;
    // Контрольная сумма попадает в выгрузку: по ней видно, что расчёт сделан
    // именно по этому файлу. Считается локально, файл никуда не уходит.
    try {
      const h = await crypto.subtle.digest('SHA-256', buf);
      parsed.fileSha = [].map.call(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* crypto.subtle недоступен — обойдёмся без контрольной суммы */ }
    report = parsed;
    deals = []; dealSeq = 0; activeDeal = null; monthFilter = null;
    openCreditors = new Set();
    addDeal();
    startReport();
  } catch (e) {
    console.error(e);
    showError(e && e.message ? e.message : 'Не удалось прочитать файл.');
  }
}

function startReport() {
  $('screen-upload').hidden = true;
  $('screen-report').hidden = false;
  $('ask').hidden = false;
  $('act').hidden = false;
  $('progress').hidden = true;
  bentoFirstRender = true;

  applyPrefsToControls();
  renderStatusFilters();
  renderWho();
  syncDateInputs();
  renderDealList();
  renderAll();
  $('deal-date').focus();
}

$('btn-reset').addEventListener('click', () => {
  report = null;
  fileInput.value = '';
  $('screen-report').hidden = true;
  $('ask').hidden = true;
  $('act').hidden = true;
  $('screen-upload').hidden = false;
  $('progress').hidden = true;
  $('error').hidden = true;
  renderWho();
});
/* ================= выгрузка в PDF ================= */
// Объём и оформление документа. Правила расчёта сюда не дублируются:
// они общие с отчётом на экране, иначе в PDF попадёт другая цифра.
const pdfOpts = {
  scope: 'full', dynamics: true, ledger: true, method: true,
  foldDup: true, wideMargin: false
};

function applyOptsToDialog() {
  $('o-dyn').checked = pdfOpts.dynamics;
  $('o-ledger').checked = pdfOpts.ledger;
  $('o-method').checked = pdfOpts.method;
  $('o-fold').checked = pdfOpts.foldDup;
  $('o-wide').checked = pdfOpts.wideMargin;
  $('o-strict').checked = filters.strict;
  $('o-dup').checked = filters.dedupe;
  $('o-new').checked = filters.excludeNew;
  $('o-zero').checked = filters.hideZero;
  $('o-status').value = filters.status;
  $('o-min').value = filters.min;
  $('o-fio').checked = hideFio;
  document.querySelectorAll('#pdf-scope .card2').forEach((el) =>
    el.classList.toggle('on', el.dataset.scope === pdfOpts.scope));
  mirrorDates(null);
  updatePdfHint();
}

function updatePdfHint() {
  const d = currentDeal();
  const ok = !!(d && d.date);
  $('pdf-go').disabled = !ok;
  $('pdf-hint').textContent = ok ? '' : 'Сначала укажите дату сделки';
}

// «Краткая» и «расширенная» — это пресеты галочек, а не отдельный режим:
// человек всегда видит, что именно попадёт в документ, и может поправить.
function setScope(scope) {
  pdfOpts.scope = scope;
  if (scope === 'short') { pdfOpts.dynamics = false; pdfOpts.ledger = false; }
  else { pdfOpts.dynamics = true; pdfOpts.ledger = true; }
  pdfOpts.method = true;
  applyOptsToDialog();
  savePrefs();
}

function syncScopeLabel() {
  pdfOpts.scope = (pdfOpts.dynamics || pdfOpts.ledger) ? 'full' : 'short';
  document.querySelectorAll('#pdf-scope .card2').forEach((el) =>
    el.classList.toggle('on', el.dataset.scope === pdfOpts.scope));
}

document.querySelectorAll('#pdf-scope .card2').forEach((el) =>
  el.addEventListener('click', (e) => { e.preventDefault(); setScope(el.dataset.scope); }));

// Галочки объёма меняют только документ, галочки расчёта — ещё и экран.
const optToggle = (id, key) => $(id).addEventListener('change', (e) => {
  pdfOpts[key] = e.target.checked; syncScopeLabel(); savePrefs();
});
optToggle('o-dyn', 'dynamics');
optToggle('o-ledger', 'ledger');
optToggle('o-method', 'method');
optToggle('o-fold', 'foldDup');
optToggle('o-wide', 'wideMargin');

const filterToggle = (id, key) => $(id).addEventListener('change', (e) => {
  filters[key] = e.target.checked; applyPrefsToControls(); onFilterChange();
});
filterToggle('o-strict', 'strict');
filterToggle('o-dup', 'dedupe');
filterToggle('o-new', 'excludeNew');
filterToggle('o-zero', 'hideZero');
$('o-status').addEventListener('change', (e) => {
  filters.status = e.target.value; applyPrefsToControls(); onFilterChange();
});
$('o-min').addEventListener('input', (e) => {
  filters.min = Math.max(0, +e.target.value || 0); applyPrefsToControls(); onFilterChange();
});
$('o-fio').addEventListener('change', (e) => { hideFio = e.target.checked; renderWho(); savePrefs(); });

function openPdfOpts() {
  applyOptsToDialog();
  $('pdfopts').hidden = false;
  $('pdf-go').focus();
}
function closePdfOpts() { $('pdfopts').hidden = true; }

$('btn-print').addEventListener('click', openPdfOpts);
$('pdf-cancel').addEventListener('click', closePdfOpts);
$('pdfopts').addEventListener('click', (e) => { if (e.target === $('pdfopts')) closePdfOpts(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('pdfview').hidden) closePdfView();
  else if (!$('pdfopts').hidden) closePdfOpts();
});

$('pdf-go').addEventListener('click', async () => {
  const deal = currentDeal();
  if (!deal || !deal.date) return;
  const btn = $('pdf-go');
  btn.disabled = true;
  btn.textContent = 'Собираю…';
  try {
    const html = await globalThis.OKBPdf.build({
      report: report, res: compute(deal), deal: deal, filters: filters,
      opts: pdfOpts, hideFio: hideFio, monthly: monthly(), verdict: paymentVerdict
    });
    $('pdf-scroll').innerHTML = html;
    fitPdfZoom();
    const n = $('pdf-scroll').querySelectorAll('.pdfsheet').length;
    $('pdf-count').textContent = n + ' ' + plural(n, 'лист', 'листа', 'листов') +
      ' · сделка ' + date(deal.date);
    closePdfOpts();
    $('pdfview').hidden = false;
    $('pdf-scroll').scrollTop = 0;
  } catch (e) {
    console.error(e);
    $('pdf-hint').textContent = 'Не удалось собрать документ: ' + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Сформировать';
  }
});

// Лист A4 — 210 мм, это 794 px и заведомо шире телефона. Ужимаем документ
// под ширину области просмотра; на печать масштаб не влияет — там свой лист.
function fitPdfZoom() {
  const box = $('pdf-scroll');
  const avail = box.clientWidth - 16;
  const z = avail > 0 ? Math.min(1, avail / (210 * 3.7795275591)) : 1;
  box.style.setProperty('--pdf-zoom', z.toFixed(3));
}
addEventListener('resize', () => { if (!$('pdfview').hidden) fitPdfZoom(); });

function closePdfView() {
  $('pdfview').hidden = true;
  $('pdf-scroll').innerHTML = '';
  document.body.classList.remove('pdfmode');
}
$('pdf-close').addEventListener('click', closePdfView);
$('pdf-back').addEventListener('click', () => { $('pdfview').hidden = true; openPdfOpts(); });
$('pdf-print').addEventListener('click', () => {
  document.body.classList.add('pdfmode');
  window.print();
});
// Класс печати снимаем и когда диалог закрыли крестиком, а не кнопкой.
addEventListener('afterprint', () => document.body.classList.remove('pdfmode'));

function renderWho() {
  const el = $('who');
  if (!report) {
    el.textContent = 'Анализ кредитного отчёта ОКБ / «Кредистория»';
    el.classList.remove('hidden-fio');
    return;
  }
  const m = report.meta;
  const n = report.contracts.reduce((a, c) => a + c.payments.length, 0);
  el.innerHTML = `<b>${esc(hideFio ? 'ФИО скрыто' : (m.fio || '—'))}</b> · отчёт от ${date(m.reportDate)}`
    + ` · ${report.contracts.length} ${plural(report.contracts.length, 'договор', 'договора', 'договоров')}`
    + ` · ${n} ${plural(n, 'платёж', 'платежа', 'платежей')}`;
  el.classList.toggle('hidden-fio', hideFio);
  $('btn-fio').textContent = hideFio ? 'Показать ФИО' : 'Скрыть ФИО';
}
$('btn-fio').addEventListener('click', () => { hideFio = !hideFio; renderWho(); savePrefs(); });

/* ================= сессия ================= */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btn-save').addEventListener('click', () => {
  const payload = {
    app: 'okb-payment-analyzer', v: 1, savedAt: new Date().toISOString(),
    report, deals, filters, hideFio, activeDeal
  };
  const who = (report.meta.fio || 'отчёт').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  download(`сессия — ${who}.json`, JSON.stringify(payload), 'application/json');
});

$('btn-open-session').addEventListener('click', (e) => { e.stopPropagation(); $('session-file').click(); });
$('session-file').addEventListener('change', (e) => { if (e.target.files[0]) openSession(e.target.files[0]); });

async function openSession(file) {
  $('error').hidden = true;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'okb-payment-analyzer' || !data.report) throw new Error('Это не файл сессии анализатора.');
    report = data.report;
    deals = data.deals && data.deals.length ? data.deals : [];
    dealSeq = deals.reduce((a, d) => Math.max(a, d.id), 0);
    if (!deals.length) addDeal();
    activeDeal = data.activeDeal && deals.some((d) => d.id === data.activeDeal) ? data.activeDeal : deals[0].id;
    if (data.filters) Object.assign(filters, data.filters);
    if (typeof data.hideFio === 'boolean') hideFio = data.hideFio;
    monthFilter = null;
    openCreditors = new Set();
    startReport();
  } catch (err) {
    console.error(err);
    showError(err && err.message ? err.message : 'Не удалось открыть сессию.');
  }
}

/* ================= сделки ================= */
function addDeal() {
  deals.push({ id: ++dealSeq, date: '', until: '' });
  activeDeal = dealSeq;
}
const currentDeal = () => deals.find((d) => d.id === activeDeal) || null;

// Дата сделки редактируется в двух местах — на экране и в окне выгрузки.
// Второе поле обновляем, не трогая то, в котором сейчас курсор.
const DATE_FIELDS = [['deal-date', 'date'], ['o-from', 'date'],
  ['deal-until', 'until'], ['o-until', 'until']];

function mirrorDates(except) {
  const d = currentDeal();
  for (const pair of DATE_FIELDS) {
    const el = $(pair[0]);
    if (!el || el === except) continue;
    el.value = maskDigits(digitsFromIso(d ? d[pair[1]] : ''));
  }
}

/** Ставит в поля значения активной сделки. */
function syncDateInputs() {
  const d = currentDeal();
  mirrorDates(null);
  $('deal-date').classList.remove('bad');
  $('deal-until').classList.remove('bad');
  $('deal-echo').textContent = d && d.date ? date(d.date) : '';
  $('deal-echo').classList.remove('bad');
  $('until-echo').textContent = d && d.until ? 'по ' + date(d.until) : '';
}

/**
 * Формат ввода с маской. Нативное поле type=date здесь не годится: оно считает
 * дату готовой после первой же цифры года и сбрасывает позицию ввода.
 */
function bindDateInput(input, echo, field) {
  input.addEventListener('input', () => {
    const raw = input.value;
    const caretDigits = onlyDigits(raw.slice(0, input.selectionStart || 0)).length;
    const pasted = /[^\d.\s]/.test(raw);
    const digits = pasted ? looseToDigits(raw) : onlyDigits(raw);

    input.value = maskDigits(digits);
    if (!pasted) {
      let pos = 0, seen = 0;
      while (pos < input.value.length && seen < caretDigits) {
        if (/\d/.test(input.value[pos])) seen++;
        pos++;
      }
      try { input.setSelectionRange(pos, pos); } catch (e) { /* поле не поддерживает */ }
    }

    const d = currentDeal();
    if (!d) return;
    const iso = isoFromDigits(digits);
    d[field] = iso;
    const bad = digits.length === 8 && !iso;
    input.classList.toggle('bad', bad);
    echo.textContent = bad ? 'Такой даты не существует'
      : iso ? (field === 'until' ? 'по ' + date(iso) : date(iso)) : '';
    echo.classList.toggle('bad', bad);
    mirrorDates(input);
    renderDealList();
    renderAll();
  });
}
bindDateInput($('deal-date'), $('deal-echo'), 'date');
bindDateInput($('deal-until'), $('until-echo'), 'until');
bindDateInput($('o-from'), $('deal-echo'), 'date');
bindDateInput($('o-until'), $('until-echo'), 'until');

$('deal-pick').addEventListener('click', () => {
  const d = currentDeal();
  const nat = $('deal-native');
  nat.value = d && d.date ? d.date : '';
  try { nat.showPicker(); } catch (e) { nat.focus(); }
});
$('deal-native').addEventListener('change', () => {
  const d = currentDeal();
  if (!d || !$('deal-native').value) return;
  d.date = $('deal-native').value;
  syncDateInputs(); renderDealList(); renderAll();
});

document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => {
  const d = currentDeal();
  if (!d || !d.date) return;
  const n = +b.dataset.preset;
  d.until = n ? addMonths(d.date, n) : '';
  syncDateInputs(); renderAll();
}));

$('btn-add-deal').addEventListener('click', () => {
  addDeal(); syncDateInputs(); renderDealList(); renderAll();
  $('deal-date').focus();
});

/** Компактный список дат — без вторых полей ввода, чтобы не двоить состояние. */
function renderDealList() {
  const box = $('deal-list');
  box.innerHTML = deals.map((d, i) => `
    <div class="deal-row${d.id === activeDeal ? ' active' : ''}" data-deal="${d.id}">
      <b>${i + 1}.</b>
      <span>${d.date ? date(d.date) : 'дата не указана'}${d.until ? ' — ' + date(d.until) : ''}</span>
      ${deals.length > 1 ? `<button class="rm" data-rm="${d.id}" title="Удалить">&times;</button>` : ''}
    </div>`).join('');

  box.querySelectorAll('.deal-row').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    activeDeal = +el.dataset.deal;
    syncDateInputs(); renderDealList(); renderAll();
  }));
  box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    const id = +b.dataset.rm;
    deals = deals.filter((d) => d.id !== id);
    if (activeDeal === id) activeDeal = deals[0].id;
    syncDateInputs(); renderDealList(); renderAll();
  }));
}

/* ================= фильтры ================= */
function onFilterChange() { savePrefs(); renderAll(); }
$('f-strict').addEventListener('change', (e) => { filters.strict = e.target.checked; onFilterChange(); });
$('f-new').addEventListener('change', (e) => { filters.excludeNew = e.target.checked; onFilterChange(); });
$('f-dup').addEventListener('change', (e) => { filters.dedupe = e.target.checked; onFilterChange(); });
$('f-status').addEventListener('change', (e) => { filters.status = e.target.value; onFilterChange(); });
$('f-zero').addEventListener('change', (e) => { filters.hideZero = e.target.checked; onFilterChange(); });
$('f-min').addEventListener('input', (e) => { filters.min = Math.max(0, +e.target.value || 0); onFilterChange(); });

function renderStatusFilters() {
  const block = $('status-block');
  if (report.meta.format !== 'old') { block.hidden = true; filters.statuses = null; return; }

  const present = {};
  for (const c of report.contracts)
    for (const k in c.statusCounts) present[k] = (present[k] || 0) + c.statusCounts[k];

  if (!filters.statuses) filters.statuses = P.PAID_STATUSES.slice();
  block.hidden = false;
  $('status-filters').innerHTML = Object.keys(present)
    .sort((a, b) => present[b] - present[a])
    .map((k) => `<label class="chk"><input type="checkbox" data-status="${k}"${filters.statuses.includes(k) ? ' checked' : ''}>
      <span>${esc(P.STATUS_TITLES[k] || k)} <span class="m">${present[k]}</span></span></label>`).join('');

  $('status-filters').querySelectorAll('input[data-status]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const k = inp.dataset.status;
      filters.statuses = inp.checked ? filters.statuses.concat([k]) : filters.statuses.filter((s) => s !== k);
      savePrefs(); renderAll();
    }));
}

/* ================= расчёт ================= */
function contractsInScope() {
  return report.contracts.filter((c) => filters.status === 'all' ? true
    : filters.status === 'active' ? c.section === 'active' : c.section === 'closed');
}

/**
 * Судьба одной строки: зачтена либо исключена, и по какому основанию.
 * Выгрузка печатает исключённые строки серым с этой пометкой, поэтому
 * причина нужна отдельно от самого факта отсева.
 */
function paymentVerdict(p) {
  const a = p.amount == null ? 0 : p.amount;
  if (filters.dedupe && p.dupExtra) return 'dup';
  if (filters.hideZero && a === 0) return 'zero';
  if (a < filters.min) return 'min';
  // Старый формат: столбцы «Платежи не вносятся» — начисления, а не поступления.
  if (filters.statuses && p.status && !filters.statuses.includes(p.status)) {
    return report && report.meta.format === 'old' ? 'accrual' : 'status';
  }
  return 'counted';
}

function paymentPasses(p) { return paymentVerdict(p) === 'counted'; }

const afterDate = (iso, from) => filters.strict ? iso > from : iso >= from;

function compute(deal) {
  const from = deal.date, until = deal.until || null;
  const scope = contractsInScope();

  let excluded = 0, excludedCount = 0;
  let newExcluded = 0, newExcludedCount = 0, newExcludedContracts = 0;
  let dupExcluded = 0, dupExcludedCount = 0;
  const dupGroups = [];
  const isNewContract = (c) => !!c.contractDate && afterDate(c.contractDate, from);

  const perContract = scope.map((c) => {
    const inPeriod = c.payments.filter((p) =>
      afterDate(p.date, from) && (!until || p.date <= until) &&
      (!monthFilter || p.date.slice(0, 7) === monthFilter));

    if (filters.excludeNew && isNewContract(c)) {
      const kept = inPeriod.filter(paymentPasses);
      if (kept.length) {
        newExcludedContracts++; newExcludedCount += kept.length;
        for (const p of kept) newExcluded += p.amount || 0;
      }
      return { c, pays: [], total: 0, principal: 0, interest: 0, other: 0 };
    }

    for (const p of inPeriod) {
      if (filters.dedupe && p.dupExtra) { dupExcluded += p.amount || 0; dupExcludedCount++; continue; }
      if (p.status && filters.statuses && !filters.statuses.includes(p.status)) {
        excluded += p.amount || 0; excludedCount++;
      }
    }
    for (const g of (c.duplicates || [])) {
      if (afterDate(g.date, from) && (!until || g.date <= until)) {
        dupGroups.push({ ...g, creditor: c.creditor, index: c.index, section: c.section });
      }
    }
    const pays = inPeriod.filter(paymentPasses);
    let total = 0, principal = 0, interest = 0, other = 0;
    for (const p of pays) {
      total += p.amount || 0; principal += p.principal || 0;
      interest += p.interest || 0; other += p.other || 0;
    }
    return { c, pays, total, principal, interest, other };
  }).filter((x) => x.pays.length);

  const groups = [];
  const byCreditor = new Map();
  for (const item of perContract) {
    let g = byCreditor.get(item.c.creditor);
    if (!g) { g = { creditor: item.c.creditor, items: [], total: 0, count: 0 }; byCreditor.set(item.c.creditor, g); groups.push(g); }
    g.items.push(item); g.total += item.total; g.count += item.pays.length;
  }

  const newContracts = scope.filter((c) =>
    c.contractDate && afterDate(c.contractDate, from) && (!until || c.contractDate <= until));

  const lastDate = until || report.meta.reportDate || from;
  const afterMonths = monthsBetween(from, lastDate);

  // Окно «до» берём той же длины, что и «после»: усреднять по всей истории
  // значит занижать «до» и получать несуществующий рост.
  let earliest = null;
  for (const c of scope)
    for (const p of c.payments)
      if (paymentPasses(p) && (!earliest || p.date < earliest)) earliest = p.date;

  const windowStart = addMonths(from, -afterMonths);
  const beforeStart = earliest && earliest > windowStart ? earliest : windowStart;

  let beforeSum = 0, beforeCount = 0;
  for (const c of scope)
    for (const p of c.payments) {
      if (afterDate(p.date, from) || p.date < beforeStart) continue;
      if (!paymentPasses(p)) continue;
      beforeSum += p.amount || 0; beforeCount++;
    }
  const beforeMonths = (earliest && earliest < from) ? monthsBetween(beforeStart, from) : 0;

  let biggest = null;
  for (const item of perContract)
    for (const p of item.pays)
      if (!biggest || (p.amount || 0) > (biggest.amount || 0)) biggest = { ...p, creditor: item.c.creditor };

  return {
    deal, groups, perContract, newContracts, excluded, excludedCount,
    newExcluded, newExcludedCount, newExcludedContracts, biggest,
    dupExcluded, dupExcludedCount, dupGroups,
    total: perContract.reduce((a, x) => a + x.total, 0),
    principal: perContract.reduce((a, x) => a + x.principal, 0),
    interest: perContract.reduce((a, x) => a + x.interest, 0),
    other: perContract.reduce((a, x) => a + x.other, 0),
    count: perContract.reduce((a, x) => a + x.pays.length, 0),
    creditors: groups.length,
    contracts: perContract.length,
    afterMonths, beforeMonths, beforeStart, beforeSum, beforeCount, lastDate
  };
}

const STATUS_LEVEL = {
  paid_ontime: 1, paid_ontime_partial: 2, paid_partial: 2,
  paid_late: 3, not_paid: 4, ambiguous: 4, not_due: 4, no_data: 4, unknown: 4
};

function monthly() {
  const hasStatus = report.meta.format === 'old';
  const map = new Map();
  for (const c of contractsInScope())
    for (const p of c.payments) {
      if (!paymentPasses(p)) continue;
      const ym = p.date.slice(0, 7);
      const cur = map.get(ym) || { ym, total: 0, count: 0, level: 1, overdueDays: 0 };
      cur.total += p.amount || 0; cur.count++;
      if (p.status) cur.level = Math.max(cur.level, STATUS_LEVEL[p.status] || 1);
      map.set(ym, cur);
    }

  // В новом формате статусов нет, зато в «Сведениях о сумме задолженности»
  // у каждого снимка есть строка «Просроченная» с датой возникновения.
  if (!hasStatus) {
    const snaps = [];
    for (const c of contractsInScope())
      for (const s of (c.debtSnapshots || [])) snaps.push(s);
    snaps.sort((a, b) => a.date < b.date ? -1 : 1);

    for (const cur of map.values()) {
      const end = cur.ym + '-31';
      let last = null;
      for (const s of snaps) { if (s.date > end) break; last = s; }
      // Снимок старше 100 дней уже не описывает этот месяц.
      const days = (last && daysApart(last.date, end) <= 100) ? (last.overdueDays || 0) : 0;
      cur.overdueDays = days;
      cur.level = days === 0 ? 1 : days < 30 ? 2 : days < 90 ? 3 : 4;
    }
  }

  const list = [...map.values()].sort((a, b) => a.ym < b.ym ? -1 : 1);
  if (!list.length) return [];
  const out = [];
  const byYm = new Map(list.map((x) => [x.ym, x]));
  let [y, m] = list[0].ym.split('-').map(Number);
  const last = list[list.length - 1].ym;
  for (;;) {
    const ym = y + '-' + String(m).padStart(2, '0');
    out.push(byYm.get(ym) || { ym, total: 0, count: 0, level: 0, overdueDays: 0 });
    if (ym === last || out.length > 1200) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ================= динамика просрочек =================
 *
 * Отдельный ряд, а не оттенок на столбцах платежей. Причина простая:
 * помесячный ряд платежей собирается перебором самих платежей, и месяц,
 * в котором не заплатили ничего, в него не попадает. А это ровно тот месяц,
 * когда просрочка растёт. Поэтому здесь ряд строится по календарю.
 *
 * Источник — «Сведения о сумме задолженности»: снимки долга на нерегулярные
 * даты, у каждого есть строка «Просроченная» с суммой и датой возникновения.
 * Снимок тянется вперёд до следующего, но не дольше SNAP_STALE дней: дальше
 * отчёт о месяце ничего не утверждает, и это «нет данных», а не «ноль».
 */
const SNAP_STALE = 100;

/** Границы корзин совпадают с шагом, которым просрочку меряют бюро. */
function depthBucket(days) { return days >= 90 ? 3 : days >= 30 ? 2 : 1; }

const DEPTH_TITLES = ['1—29 дней', '30—89 дней', '90 дней и больше'];

function endOfMonth(ym) {
  const p = ym.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10);
}

function monthsRange(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  for (;;) {
    const ym = y + '-' + String(m).padStart(2, '0');
    out.push(ym);
    if (ym >= toYm || out.length > 1200) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Состояние просрочки по одному договору на произвольную дату. */
function overdueAtDate(c, iso) {
  let snap = null;
  for (const s of (c.debtSnapshots || [])) { if (s.date > iso) break; snap = s; }
  if (!snap) return null;
  if (daysApart(snap.date, iso) > SNAP_STALE) return { noData: true };
  if (!(snap.overdue > 0)) return { clean: true, snap: snap.date };
  // Глубину считаем от даты возникновения к запрошенной дате: снимок
  // печатает её на свою дату, а нам нужна на конец месяца.
  const days = Math.max(1, snap.overdueSince ? daysApart(snap.overdueSince, iso) : (snap.overdueDays || 1));
  return { amount: snap.overdue, days, bucket: depthBucket(days), since: snap.overdueSince, snap: snap.date };
}

function overdueSeries() {
  const scope = contractsInScope().filter((c) => (c.debtSnapshots || []).length);
  if (!scope.length) return null;

  let min = null, max = null;
  for (const c of scope) {
    const s = c.debtSnapshots;
    if (!min || s[0].date < min) min = s[0].date;
    if (!max || s[s.length - 1].date > max) max = s[s.length - 1].date;
  }
  const deal = currentDeal();
  if (deal && deal.date) {
    if (deal.date < min) min = deal.date;
    if (deal.date > max) max = deal.date;
  }

  const yms = monthsRange(min.slice(0, 7), max.slice(0, 7));
  if (yms.length < 2) return null;

  const lanes = scope.map((c) => {
    const first = c.debtSnapshots[0].date.slice(0, 7);
    return {
      c,
      // До первого снимка отчёт о договоре молчит — это пусто, а не «нет данных».
      cells: yms.map((ym) => (ym < first ? null : overdueAtDate(c, endOfMonth(ym))))
    };
  });

  const months = yms.map((ym, i) => {
    const list = [];
    let inRange = 0, known = 0, sum = 0, maxDays = 0;
    for (const ln of lanes) {
      const cell = ln.cells[i];
      if (!cell) continue;
      inRange++;
      if (cell.noData) continue;
      known++;
      if (cell.clean) continue;
      sum += cell.amount;
      if (cell.days > maxDays) maxDays = cell.days;
      list.push({ c: ln.c, days: cell.days, amount: cell.amount, bucket: cell.bucket });
    }
    const byB = [0, 0, 0];
    for (const x of list) byB[x.bucket - 1] += x.amount;
    return { ym, sum, byB, maxDays, list, count: list.length,
      noData: inRange > 0 && known === 0, empty: inRange === 0 };
  });

  let atDeal = null;
  if (deal && deal.date) {
    const list = [];
    let sum = 0, days = 0, known = 0, inRange = 0, asOf = null;
    for (const c of scope) {
      const cell = overdueAtDate(c, deal.date);
      if (!cell) continue;
      inRange++;
      if (cell.noData) continue;
      known++;
      if (!asOf || cell.snap > asOf) asOf = cell.snap;
      if (cell.clean) continue;
      sum += cell.amount;
      if (cell.days > days) days = cell.days;
      list.push({ c, days: cell.days, amount: cell.amount, bucket: cell.bucket });
    }
    atDeal = { date: deal.date, sum, days, list, count: list.length, asOf,
      noData: inRange > 0 && known === 0, total: scope.length };
  }

  const everOverdue = lanes.filter((ln) => ln.cells.some((x) => x && x.amount > 0)).length;
  return { yms, months, lanes, atDeal, everOverdue, scope, episodes: overdueEpisodes(scope) };
}

/*
 * Эпизоды просрочки: один непрерывный период по одному договору.
 *
 * Главный вопрос к отчёту — с какого момента, у кого и на сколько, а это
 * не ряд по месяцам, а список событий. Снимки долга дают его напрямую:
 * у строки «Просроченная» есть сумма и дата возникновения. Смена даты
 * возникновения — это новая просрочка, даже если прошлая не гасилась.
 */
function overdueEpisodes(scope) {
  const out = [];
  for (const c of scope) {
    let cur = null;
    for (const s of (c.debtSnapshots || [])) {
      if (s.overdue > 0) {
        const since = s.overdueSince || null;
        if (cur && since && cur.since && since !== cur.since) { out.push(cur); cur = null; }
        if (!cur) cur = { c, since, first: s.date, last: s.date, max: 0, maxAt: s.date, lastAmount: 0 };
        if (since && !cur.since) cur.since = since;
        cur.last = s.date;
        cur.lastAmount = s.overdue;
        if (s.overdue > cur.max) { cur.max = s.overdue; cur.maxAt = s.date; }
      } else if (cur) {
        cur.cured = true; cur.curedAt = s.date;
        out.push(cur); cur = null;
      }
    }
    if (cur) out.push(cur);
  }
  for (const ep of out) {
    ep.start = ep.since || ep.first;       // даты возникновения может не быть
    ep.exact = !!ep.since;                 // тогда знаем только «не позже снимка»
    ep.until = ep.cured ? ep.curedAt : ep.last;
    ep.days = Math.max(1, daysApart(ep.start, ep.until));
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

/** Состояние эпизода на дату сделки: был ли он тогда открыт и на сколько. */
function episodeAt(ep, iso) {
  if (!iso || iso < ep.start) return null;
  if (ep.cured && ep.curedAt <= iso) return null;
  let snap = null;
  for (const s of ep.c.debtSnapshots) {
    if (s.date > iso || s.date < ep.first || s.date > ep.last) continue;
    snap = s;
  }
  if (!snap || !(snap.overdue > 0)) return null;
  if (daysApart(snap.date, iso) > SNAP_STALE) return { stale: true };
  return { amount: snap.overdue, days: Math.max(1, daysApart(ep.start, iso)) };
}

/*
 * Старый формат: снимков долга нет, зато у каждого платежа есть статус.
 * Тогда меряем долей платежей месяца, а не суммой. Принцип тот же —
 * рисуем только неблагополучие, платежи в срок не занимают цвета.
 */
const BAD_STATUS = { paid_ontime_partial: 1, paid_partial: 1, paid_late: 2, not_paid: 3 };

function overdueByStatus() {
  const map = new Map();
  for (const c of contractsInScope())
    for (const p of c.payments) {
      if (!paymentPasses(p) || !p.status) continue;
      const ym = p.date.slice(0, 7);
      const cur = map.get(ym) || { ym, n: 0, byB: [0, 0, 0] };
      cur.n++;
      const b = BAD_STATUS[p.status];
      if (b) cur.byB[b - 1]++;
      map.set(ym, cur);
    }
  if (map.size < 2) return null;

  const keys = [...map.keys()].sort();
  const yms = monthsRange(keys[0], keys[keys.length - 1]);
  const months = yms.map((ym) => {
    const cur = map.get(ym);
    if (!cur) return { ym, n: 0, byB: [0, 0, 0], bad: 0, share: 0, empty: true };
    const bad = cur.byB[0] + cur.byB[1] + cur.byB[2];
    return { ym, n: cur.n, byB: cur.byB, bad, share: cur.n ? bad / cur.n : 0 };
  });
  return { yms, months };
}

/* ================= отрисовка ================= */
function renderAll() { renderBento(); renderTabs(); renderPanels(); }

function renderBento() {
  const bento = $('bento');
  const deal = currentDeal();
  if (!deal || !deal.date) {
    bento.innerHTML = `<div class="t s12" style="align-items:center;text-align:center;padding:44px 24px">
      <div class="k">Отчёт разобран</div>
      <p style="font-size:20px;font-weight:600;letter-spacing:-.02em;margin:8px 0 0">
        Впишите дату сделки наверху — расчёт появится здесь.</p>
      <p class="m">${report.contracts.length} ${plural(report.contracts.length, 'договор', 'договора', 'договоров')},
        ${report.contracts.reduce((a, c) => a + c.payments.length, 0)} платежей уже прочитано.</p>
    </div>`;
    bento.classList.remove('anim');
    return;
  }

  const res = compute(deal);
  const withTable = report.contracts.filter((c) => c.hasPaymentTable).length;
  const totalC = report.contracts.length;
  const avgBefore = res.beforeMonths ? res.beforeSum / res.beforeMonths : null;
  const avgAfter = res.afterMonths ? res.total / res.afterMonths : null;
  const deltaPct = (avgBefore && avgAfter) ? Math.round((avgAfter / avgBefore - 1) * 100) : null;
  const excludedTotal = res.excluded + res.newExcluded + res.dupExcluded;
  const cents = String(Math.round((res.total % 1) * 100)).padStart(2, '0');

  const tiles = [];

  // Повторы — не мелочь: на проверенном отчёте это 15 % суммы по договору.
  // Поэтому предупреждение идёт первым, до всех цифр.
  if (res.dupGroups.length) {
    const g = res.dupGroups[0];
    tiles.push(`<div class="t s12 warnT">
      <div class="k">Внимание: в отчёте есть повторяющиеся записи</div>
      <p style="font-size:14.5px;line-height:1.5;margin:6px 0 0">
        ОКБ напечатал один и тот же платёж несколько раз подряд одной датой — известный сбой старых отчётов.
        Например, <b>${date(g.date)}</b> по договору «${esc(g.creditor)}» запись на <b>${money(g.amount)}</b>
        повторена <b>${g.count} ${plural(g.count, 'раз', 'раза', 'раз')}</b>${g.debtMoved === false
          ? ', при этом основной долг в этот день не изменился' : ''}.
        ${res.dupGroups.length > 1 ? `Всего таких групп: ${res.dupGroups.length}.` : ''}</p>
      <p class="m">${filters.dedupe
        ? `Каждая группа засчитана один раз, из расчёта исключено <b>${money(res.dupExcluded)}</b>. Подробности — во вкладке «Проверка».`
        : 'Повторы сейчас считаются полностью. Включите «Считать повторы записей один раз» в «Дополнительно».'}</p>
    </div>`);
  }

  tiles.push(`<div class="t hero">
    <div class="k">Внесено после сделки</div>
    <div class="big">${nfInt.format(Math.floor(res.total))}<small>,${cents} ₽</small></div>
    <div class="per">${date(deal.date)} — ${date(res.lastDate)}${monthFilter ? ' · только ' + P.formatMonth(monthFilter) : ''}</div>
    <p class="said">${res.count
      ? `Платежи шли <b>${res.creditors}</b> ${plural(res.creditors, 'кредитору', 'кредиторам', 'кредиторам')}`
        + ` по ${res.contracts} ${plural(res.contracts, 'договору', 'договорам', 'договорам')}.`
        + (res.biggest ? ` Крупнейший платёж — <b>${money0(res.biggest.amount)}</b> ${date(res.biggest.date)}.` : '')
      : 'Платежей после этой даты не найдено. Проверьте дату и настройки в «Дополнительно».'}</p>
    <div class="strip">
      <div><b>${res.count}</b>${plural(res.count, 'платёж', 'платежа', 'платежей')}</div>
      <div><b>${res.creditors}</b>${plural(res.creditors, 'кредитор', 'кредитора', 'кредиторов')}</div>
      <div><b>${res.afterMonths}</b>${plural(res.afterMonths, 'месяц', 'месяца', 'месяцев')}</div>
      <div><b>${res.newContracts.length}</b>новых договоров</div>
    </div>
  </div>`);

  tiles.push(`<div class="stack">
    <div class="t split">
      <div class="k">Из чего сложилась сумма</div>
      <div class="r"><span>Основной долг</span><b>${money0(res.principal)}</b></div>
      <div class="r"><span>Проценты</span><b>${money0(res.interest)}</b></div>
      <div class="r"><span>Пени</span><b>${money0(res.other)}</b></div>
    </div>
    <div class="t">
      <div class="k">Средний платёж в месяц</div>
      <div class="ba">
        <div><span class="m">до сделки</span><div class="n">${avgBefore == null ? '—' : money0(avgBefore)}</div></div>
        <div class="after"><span class="m">после сделки</span><div class="n">${avgAfter == null ? '—' : money0(avgAfter)}</div></div>
      </div>
      <div class="m">${deltaPct == null ? 'нет данных за период до сделки'
        : `<span class="delta">${deltaPct > 0 ? '+' : ''}${deltaPct} %</span> · сравниваются равные окна по ${res.afterMonths} ${plural(res.afterMonths, 'месяцу', 'месяца', 'месяцев')}`}</div>
    </div>
  </div>`);

  tiles.push(renderTimeline(deal));
  tiles.push(renderCreditorsTile(res));

  const rightTiles = [];
  rightTiles.push(`<div class="t link" data-tab="new">
    <div class="k">Договоры после сделки</div>
    <div class="v">${res.newContracts.length}</div>
    <div class="m">${res.newContracts.length
      ? esc(res.newContracts.map((c) => c.creditor).slice(0, 2).join(', '))
        + (res.newContracts.length > 2 ? ` и ещё ${res.newContracts.length - 2}` : '')
      : 'новых кредитов после сделки нет'}</div>
  </div>`);

  rightTiles.push(`<div class="t link${totalC - withTable ? '' : ''}" data-tab="nodata">
    <div class="k">Полнота данных</div>
    <div class="v">${withTable} из ${totalC}</div>
    <div class="m">${totalC - withTable
      ? `по ${totalC - withTable} договорам кредиторы не передали список платежей`
      : 'по всем договорам есть построчный список платежей'}</div>
  </div>`);

  if (excludedTotal) {
    rightTiles.push(`<div class="t warnT">
      <div class="k">Не засчитано</div>
      <div class="v">${money0(excludedTotal)}</div>
      <div class="m">${[res.dupExcludedCount ? `${res.dupExcludedCount} повторов записей` : '',
        res.excludedCount ? `${res.excludedCount} по статусу платежа` : '',
        res.newExcludedCount ? `${res.newExcludedCount} по новым договорам` : ''].filter(Boolean).join(' · ')}</div>
    </div>`);
  }
  tiles.push(`<div class="stack">${rightTiles.join('')}</div>`);

  bento.innerHTML = tiles.join('');
  bento.classList.toggle('anim', bentoFirstRender);
  bentoFirstRender = false;
  wireBento();
}

function wireBento() {
  const bento = $('bento');
  bento.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  bento.querySelectorAll('.strip2 i.hit').forEach((b) => b.addEventListener('click', () => {
    monthFilter = monthFilter === b.dataset.ym ? null : b.dataset.ym;
    renderAll();
  }));
  const clr = bento.querySelector('[data-clear-month]');
  if (clr) clr.addEventListener('click', () => { monthFilter = null; renderAll(); });
  wireCreditors();
}

function renderTimeline(deal) {
  const data = monthly();
  if (data.length < 2) {
    return `<div class="t s12 tl"><div class="head"><h3>Платежи по месяцам</h3></div>
      <p class="m">Недостаточно данных для графика.</p></div>`;
  }
  const max = Math.max(...data.map((d) => d.total)) || 1;
  const from = deal.date, until = deal.until || null;
  const hasStatus = report.meta.format === 'old';
  const cut = data.findIndex((d) => d.ym >= from.slice(0, 7));

  const bars = data.map((d) => {
    const inPeriod = afterDate(d.ym + '-31', from) && (!until || d.ym + '-01' <= until);
    const h = d.total > 0 ? Math.max(2, Math.round(d.total / max * 100)) : 2;
    const cls = [];
    if (!d.total) cls.push('none');
    else if (d.level > 1) cls.push('l' + d.level);
    if (!inPeriod) cls.push('pre');
    if (d.total && inPeriod) cls.push('hit');
    if (monthFilter === d.ym) cls.push('sel');
    const extra = hasStatus ? ''
      : (d.total ? (d.overdueDays ? `, просрочка ${d.overdueDays} ${plural(d.overdueDays, 'день', 'дня', 'дней')}` : ', без просрочки') : '');
    const t = `${P.formatMonth(d.ym)} — ${money(d.total)}, ${d.count} ${plural(d.count, 'платёж', 'платежа', 'платежей')}${extra}`;
    return `<i class="${cls.join(' ')}" style="height:${h}%" data-ym="${d.ym}" title="${t}"></i>`;
  }).join('');

  const notch = cut >= 0
    ? `<span class="notch" style="left:${(cut / data.length * 100).toFixed(2)}%"><b>${date(from)}</b></span>` : '';

  const years = [];
  let prev = null;
  data.forEach((d) => { const y = d.ym.slice(0, 4); if (y !== prev) { prev = y; years.push(y); } });

  const legend = hasStatus
    ? `<span class="sw"><i style="background:var(--s1)"></i>в срок</span>
       <span class="sw"><i style="background:var(--s2)"></i>частично</span>
       <span class="sw"><i style="background:var(--s3)"></i>с просрочкой</span>
       <span class="sw"><i style="background:var(--s4)"></i>не вносились</span>`
    : `<span class="sw"><i style="background:var(--s1)"></i>без просрочки</span>
       <span class="sw"><i style="background:var(--s2)"></i>до 30 дней</span>
       <span class="sw"><i style="background:var(--s3)"></i>30—90 дней</span>
       <span class="sw"><i style="background:var(--s4)"></i>свыше 90 дней</span>`;

  return `<div class="t s12 tl">
    <div class="head"><h3>Платежи по месяцам</h3>
      <span>высота — сумма, цвет — ${hasStatus ? 'статус платежей' : 'просрочка'} · клик по столбцу сузит расчёт до месяца</span>
      ${monthFilter ? '<button class="btn btn-sm" data-clear-month style="margin-left:auto">Показать весь период</button>' : ''}</div>
    <div class="strip2">${bars}${notch}</div>
    <div class="axis${years.length > 6 ? ' thin' : ''}">${years.map((y) => `<span>${y}</span>`).join('')}</div>
    <div class="ramp">${legend}<span class="faded">приглушённые — до сделки</span></div>
  </div>`;
}

function renderCreditorsTile(res) {
  return `<div class="t s8 cr">
    <div class="head">
      <h3>Кому платил после сделки</h3>
      <span>${res.creditors} ${plural(res.creditors, 'кредитор', 'кредитора', 'кредиторов')}</span>
      <span class="tools">
        <input type="text" id="cr-search" placeholder="Поиск" value="${esc(crSearch)}">
        <select id="cr-sort">
          <option value="total"${crSort === 'total' ? ' selected' : ''}>по сумме</option>
          <option value="count"${crSort === 'count' ? ' selected' : ''}>по количеству</option>
          <option value="name"${crSort === 'name' ? ' selected' : ''}>по названию</option>
        </select>
      </span>
    </div>
    <div id="cr-list">${creditorListHtml(res)}</div>
  </div>`;
}

function creditorListHtml(res) {
  let groups = res.groups.slice();
  if (crSearch) groups = groups.filter((g) => g.creditor.toLowerCase().includes(crSearch.toLowerCase()));
  groups.sort(crSort === 'name' ? (a, b) => a.creditor.localeCompare(b.creditor, 'ru')
    : crSort === 'count' ? (a, b) => b.count - a.count : (a, b) => b.total - a.total);

  if (!groups.length) {
    return `<div style="padding:24px 16px;color:var(--ink-3);font-size:13.5px">${res.groups.length
      ? 'По этому запросу ничего не найдено.'
      : 'Платежей после ' + date(res.deal.date) + ' не найдено.'}</div>`;
  }
  const max = Math.max(...groups.map((g) => g.total)) || 1;
  // Доля считается от всей суммы после сделки, а не от максимума в списке:
  // при поиске или фильтре знаменатель не должен «плыть».
  const share = (v) => res.total > 0 ? (v / res.total * 100).toFixed(1).replace('.', ',') + ' %' : '—';
  // Ни одна группа не раскрыта сама: у первого кредитора список платежей
  // бывает на сотни строк, и он выталкивал остальных за экран.
  return groups.map((g) => `
    <details class="g" data-cr="${esc(g.creditor)}"${openCreditors.has(g.creditor) ? ' open' : ''}>
      <summary>
        <span class="chev"></span>
        <span class="nm" title="${esc(g.creditor)}">${esc(g.creditor)}</span>
        <span class="meter"><i style="width:${(g.total / max * 100).toFixed(1)}%"></i></span>
        <span class="cnt">${g.count} ${plural(g.count, 'платёж', 'платежа', 'платежей')}</span>
        <span class="pct">${share(g.total)}</span>
        <span class="tot">${money(g.total)}</span>
      </summary>
      <div class="cbody">${g.items.map(contractHtml).join('')}</div>
    </details>`).join('');
}

function contractHtml(item) {
  const c = item.c;
  const showStatus = report.meta.format === 'old';
  const chips = [`<span class="chipm"><i class="dot"></i>${c.section === 'closed' ? 'закрыт' : 'действующий'}</span>`];
  if (c.hadOverdue) chips.push('<span class="chipm w"><i class="dot"></i>была просрочка</span>');
  if (c.totalsMatch === false) chips.push(`<span class="chipm w"><i class="dot"></i>агрегат расходится на ${money(c.totalsDiff)}</span>`);

  return `<div>
    <div class="meta">
      <span>Договор №${c.index} от <b>${date(c.contractDate)}</b> · ${esc(c.kind)}</span>${chips.join('')}
    </div>
    <div class="scroll-x"><table>
      <thead><tr><th>Дата платежа</th>${showStatus ? '<th>Статус</th>' : ''}<th class="r">Сумма</th>
        <th class="r">Основной долг</th><th class="r">Проценты</th><th class="r">Пени</th><th class="r">Лист</th></tr></thead>
      <tbody>${item.pays.map((p) => `<tr>
        <td>${date(p.date)}${p.dupCount && filters.dedupe
          ? ` <span class="dupmark" title="В отчёте эта запись повторена ${p.dupCount} раз; засчитана один раз">× ${p.dupCount} повтор</span>` : ''}</td>
        ${showStatus ? `<td class="sub">${esc(P.STATUS_TITLES[p.status] || '—')}</td>` : ''}
        <td class="r">${money(p.amount)}</td>
        <td class="r sub">${money(p.principal)}</td>
        <td class="r sub">${money(p.interest)}</td>
        <td class="r sub">${money(p.other)}</td>
        <td class="r sub">${p.page || '—'}</td>
      </tr>`).join('')}
      <tr class="total"><td${showStatus ? ' colspan="2"' : ''}>Итого ${item.pays.length} ${plural(item.pays.length, 'платёж', 'платежа', 'платежей')}</td>
        <td class="r">${money(item.total)}</td><td class="r">${money(item.principal)}</td>
        <td class="r">${money(item.interest)}</td><td class="r">${money(item.other)}</td><td></td></tr>
      </tbody></table></div>
  </div>`;
}

function wireCreditors() {
  const list = $('cr-list');
  if (!list) return;
  list.querySelectorAll('details.g').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) openCreditors.add(d.dataset.cr); else openCreditors.delete(d.dataset.cr);
  }));
  const refresh = () => {
    const deal = currentDeal();
    if (deal && deal.date) { list.innerHTML = creditorListHtml(compute(deal)); wireCreditors(); }
  };
  const s = $('cr-search');
  if (s) s.addEventListener('input', (e) => {
    crSearch = e.target.value.trim();
    refresh();
    const again = $('cr-search');
    if (again && again !== e.target) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });
  const sel = $('cr-sort');
  if (sel) sel.addEventListener('change', (e) => { crSort = e.target.value; savePrefs(); refresh(); });
}

/* ================= нижние разделы ================= */
function selectTab(k) {
  activeTab = k;
  renderTabs();
  const el = $('panel-' + k);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTabs() {
  const deal = currentDeal();
  const res = deal && deal.date ? compute(deal) : null;
  const noData = report.contracts.filter((c) => !c.hasPaymentTable).length;
  const od = overdueTabCount();
  const defs = [
    ['overdue', 'Просрочка', od],
    ['new', 'Новые договоры', res ? res.newContracts.length : null],
    ['nodata', 'Нет данных о платежах', noData],
    ['check', 'Проверка', null]
  ];
  $('tabs').innerHTML = defs.map(([k, label, n]) =>
    `<button class="tab${k === activeTab ? ' on' : ''}" data-t="${k}">${label}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`).join('');
  $('tabs').querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.t)));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + activeTab));
}

function renderPanels() {
  const deal = currentDeal();
  const res = deal && deal.date ? compute(deal) : null;
  renderOverdue(); renderNew(res); renderNoData(res); renderCheck();
}

/* ---------------- вкладка «Просрочка» ---------------- */
let odMode = 'sum';
let odRange = 36;   // 0 — весь отчёт

function overdueTabCount() {
  if (!report) return null;
  const s = overdueSeries();
  if (s) return s.everOverdue || null;
  const st = overdueByStatus();
  if (!st) return null;
  return st.months.filter((m) => m.bad > 0).length || null;
}

function odYears(yms) {
  const out = [];
  let prev = null;
  for (const ym of yms) { const y = ym.slice(0, 4); if (y !== prev) { prev = y; out.push(y); } }
  return out;
}

/** Верхняя граница шкалы округляется вверх до половины разряда: 296 500 → 300 000. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (pow / 2)) * (pow / 2);
}

function odDays(n) { return n + ' ' + plural(n, 'день', 'дня', 'дней'); }

const odPlotWidth = (n) => Math.max(360, n * 30);

function odChart(yms, cols, ticks, dealYm) {
  const cut = dealYm ? yms.indexOf(dealYm) : -1;
  const at = cut >= 0 ? (cut / yms.length * 100).toFixed(2) : null;
  const notch = at ? `<span class="od-notch" style="left:${at}%"><b>сделка</b></span>` : '';
  // Помечаем фоном период после сделки — он и есть предмет разбора. Раньше
  // заливали то, что до, но на длинном ряду это гасило почти весь график.
  const band = cut >= 0 ? `<span class="od-post" style="left:${at}%"></span>` : '';
  return `<div class="od-plot" style="--od-w:${odPlotWidth(yms.length)}px">
    <div class="od-y">${ticks.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="od-area">
      <div class="od-grid"><i style="top:0"></i><i style="top:50%"></i><i class="base" style="bottom:0"></i></div>
      ${band}<div class="od-cols">${cols}</div>${notch}
    </div>
    <div class="od-x">${odYears(yms).map((y) => `<span>${y}</span>`).join('')}</div>
  </div>`;
}

function odTitle(m) {
  const name = P.formatMonth(m.ym);
  if (m.empty) return `${name} — сведений о договорах ещё нет`;
  if (m.noData) return `${name} — снимка долга нет, просрочка неизвестна`;
  if (!m.count) return `${name} — просрочки нет`;
  const head = `${name} — ${money(m.sum)}, глубина ${odDays(m.maxDays)}`;
  const body = m.list.slice().sort((a, b) => b.amount - a.amount)
    .map((x) => `${x.c.creditor} — ${money(x.amount)}, ${odDays(x.days)}`);
  return [head, ...body].join('\n');
}

function odVerdict(at) {
  if (!at) {
    return `<div class="od-verdict flat"><span class="k">Дата сделки не указана</span>
      <p>Впишите дату наверху — здесь появится, что было с просрочкой на этот день.</p></div>`;
  }
  if (at.noData) {
    return `<div class="od-verdict flat"><span class="k">На дату сделки — ${date(at.date)}</span>
      <p>Ближайший снимок долга старше ${SNAP_STALE} дней. Отчёт не говорит, была ли просрочка на этот день.</p></div>`;
  }
  if (!at.count) {
    return `<div class="od-verdict flat"><span class="k">На дату сделки — ${date(at.date)}</span>
      <p>Просроченной задолженности по данным отчёта не было.</p></div>`;
  }
  // Сумма — из последнего снимка до сделки, глубина — на саму дату сделки.
  // Даты разные, и об этом надо сказать прямо, иначе числа выглядят как одно.
  const asOf = at.asOf && at.asOf !== at.date
    ? `<p class="as">Сумма — по последнему снимку долга от ${date(at.asOf)}: свежее него
       отчёт о просрочке ничего не сообщает. Глубина посчитана на саму дату сделки.</p>` : '';
  return `<div class="od-verdict">
    <span class="k">На дату сделки — ${date(at.date)}</span>
    <span class="fig"><b>${money0(at.sum)}</b><span>просрочено</span></span>
    <span class="fig"><b>${at.days}</b><span>${plural(at.days, 'день просрочки', 'дня просрочки', 'дней просрочки')}</span></span>
    <span class="fig"><b>${at.count}</b><span>из ${at.total} ${plural(at.total, 'договора', 'договоров', 'договоров')}</span></span>
    ${asOf}</div>`;
}

const OD_LEGEND = DEPTH_TITLES.map((t, i) => `<span class="sw"><i class="b${i + 1}"></i>${t}</span>`).join('');

/*
 * Окно графика. «Год» и «3 года» отсчитываются до сделки, а всё, что после
 * неё, видно всегда: период после сделки и есть предмет разбора, обрезать
 * его нельзя. Возвращаем срез и индекс, с которого он начался.
 */
const OD_RANGES = [[12, 'год'], [36, '3 года'], [0, 'весь отчёт']];

/**
 * Окно симметрично: n месяцев до сделки и столько же после. Никакой
 * дополнительной подрезки: кнопка значит ровно то, что на ней написано,
 * иначе «год» и «3 года» дают одну и ту же картинку.
 */
function odWindow(yms, dealYm, n) {
  if (!n) return { from: 0, to: yms.length };
  const i = dealYm ? yms.indexOf(dealYm) : -1;
  if (i < 0) return { from: Math.max(0, yms.length - n), to: yms.length };
  return { from: Math.max(0, i - n), to: Math.min(yms.length, i + n + 1) };
}

function odRangeBar() {
  return `<div class="od-filter"><span class="lb">Вокруг сделки</span>
    <span class="od-seg" role="group" aria-label="Диапазон графика">${OD_RANGES.map(([n, t]) =>
    `<button type="button" data-odr="${n}" aria-pressed="${odRange === n}">${t}</button>`).join('')}</span></div>`;
}

/** Что осталось за краями окна — одной строкой, а не сотней пустых столбцов. */
function odHiddenNote(months, w) {
  const head = months.slice(0, w.from);
  const tail = months.slice(w.to);
  const hidden = head.concat(tail);
  if (!hidden.length) return '';
  const mon = (n) => n + ' ' + plural(n, 'месяц', 'месяца', 'месяцев');
  const parts = [];
  if (head.length) parts.push(`${mon(head.length)} до ${P.formatMonth(months[w.from].ym)}`);
  if (tail.length) parts.push(`${mon(tail.length)} после ${P.formatMonth(months[w.to - 1].ym)}`);
  const bad = hidden.filter((m) => m.count).length;
  const nod = hidden.filter((m) => m.noData).length;
  if (bad) {
    return `<p class="od-hidden warn">За окном осталось ${mon(bad)} с просрочкой —
      ${parts.join(' и ')}.
      <button type="button" class="linkbtn" data-odr="0">Показать весь отчёт</button></p>`;
  }
  const what = nod === hidden.length ? 'снимков долга за них нет' : 'просрочек в них нет';
  return `<p class="od-hidden">Свёрнуто ${parts.join(' и ')} — ${what}.</p>`;
}

/** Сводная клетка кредитора: худшее из его договоров за месяц. */
function odMergeCells(cells) {
  let amount = 0, days = 0, bad = false, clean = false, nod = false, any = false;
  for (const c of cells) {
    if (!c) continue;
    any = true;
    if (c.amount) { bad = true; amount += c.amount; if (c.days > days) days = c.days; }
    else if (c.clean) clean = true;
    else if (c.noData) nod = true;
  }
  if (!any) return null;
  if (bad) return { amount, days, bucket: depthBucket(days) };
  return clean ? { clean: true } : nod ? { noData: true } : null;
}

/** «д7 от 12.03.2021» — так строки одного банка различимы между собой. */
function odContractName(c) {
  return (c.section === 'closed' ? 'з' : 'д') + c.index +
    (c.contractDate ? ' от ' + date(c.contractDate) : '');
}

function odCells(cells, yms, w) {
  return cells.slice(w.from, w.to).map((cell, i) => {
    const nm = esc(P.formatMonth(yms[w.from + i]));
    if (!cell) return '<i></i>';
    if (cell.noData) return `<i class="nd" title="${nm} — снимка долга нет"></i>`;
    if (cell.clean) return `<i title="${nm} — без просрочки"></i>`;
    return `<i class="b${cell.bucket}" title="${nm} — ${esc(odDays(cell.days))}, ${esc(money(cell.amount))}"></i>`;
  }).join('');
}

function odEpisodesTable(s) {
  const eps = s.episodes;
  if (!eps.length) {
    return `<div class="empty"><b>Просрочек в отчёте нет</b>
      Ни по одному договору раздел «Сведения о сумме задолженности» не показывает
      просроченной задолженности.</div>`;
  }
  const dealDate = s.atDeal ? s.atDeal.date : null;

  const rows = eps.map((ep) => {
    const at = dealDate ? episodeAt(ep, dealDate) : null;
    const cells = !dealDate
      ? '<td class="r sub" colspan="2">дата сделки не указана</td>'
      : at && at.stale ? '<td class="r sub" colspan="2">снимок устарел</td>'
        : at ? `<td class="r"><b>${money0(at.amount)}</b></td><td class="r">${at.days}</td>`
          : '<td class="r sub" colspan="2">не было</td>';
    // Дата возникновения бывает не напечатана — тогда знаем только дату снимка.
    const mark = ep.exact ? ''
      : ' <span class="sub" title="Дата возникновения в отчёте не указана — взята дата снимка">≈</span>';
    const outcome = (ep.cured ? 'погашена ' + date(ep.curedAt) : 'не погашена') +
      `, ${ep.days} ${plural(ep.days, 'день', 'дня', 'дней')}`;
    return `<tr>
      <td><b>${esc(ep.c.creditor)}</b><span class="sub2">${esc(odContractName(ep.c))} · ${esc(ep.c.kind)}</span></td>
      <td class="nw"><i class="od-dot b${depthBucket(ep.days)}"></i>${date(ep.start)}${mark}</td>
      ${cells}
      <td class="r sub">${money0(ep.max)}</td>
      <td class="sub nw">${outcome}</td>
    </tr>`;
  }).join('');

  return `<div class="card"><div class="scroll-x"><table class="od-tbl">
    <thead><tr>
      <th>Кредитор и договор</th><th>Просрочка с</th>
      <th class="r">На сделку, ₽</th><th class="r">На сделку, дней</th>
      <th class="r">Наибольшая, ₽</th><th>Чем кончилась</th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}

function odBySnapshots(s) {
  const dealYm = s.atDeal ? s.atDeal.date.slice(0, 7) : null;
  const w = odWindow(s.yms, dealYm, odRange);
  const yms = s.yms.slice(w.from, w.to);
  const months = s.months.slice(w.from, w.to);

  const vals = months.map((m) => (odMode === 'sum' ? m.sum : m.maxDays));
  const max = niceMax(Math.max(...vals));
  const ticks = odMode === 'sum'
    ? [max >= 1000 ? Math.round(max / 1000) + ' тыс' : max, max >= 1000 ? Math.round(max / 2000) : max / 2, 0]
    : [max + ' дн', max / 2, 0];

  const cols = months.map((m) => {
    const cls = ['od-col'];
    if (m.noData) cls.push('nd');
    let inner = '', first = true;
    if (odMode === 'sum') {
      // Сверху мельче, вниз глубже: 90+ лежит на нулевой линии как основание.
      for (let b = 1; b <= 3; b++) {
        const v = m.byB[b - 1];
        if (!v) continue;
        inner += `<em class="b${b}${first ? ' cap' : ''}" style="height:${(v / max * 100).toFixed(2)}%"></em>`;
        first = false;
      }
    } else if (m.maxDays) {
      inner = `<em class="b${depthBucket(m.maxDays)} cap" style="height:${(m.maxDays / max * 100).toFixed(2)}%"></em>`;
    }
    return `<span class="${cls.join(' ')}" title="${esc(odTitle(m))}">${inner}</span>`;
  }).join('');

  // Строк столько же, сколько кредиторов: у одного банка бывает два десятка
  // договоров, и построчно они неотличимы. Договоры — внутри, по раскрытию.
  const groups = [];
  const byCr = new Map();
  for (const ln of s.lanes) {
    let g = byCr.get(ln.c.creditor);
    if (!g) { g = { creditor: ln.c.creditor, lanes: [] }; byCr.set(ln.c.creditor, g); groups.push(g); }
    g.lanes.push(ln);
  }

  const lanes = groups.map((g) => {
    const merged = s.yms.map((_, i) => odMergeCells(g.lanes.map((ln) => ln.cells[i])));
    const cells = odCells(merged, s.yms, w);
    if (g.lanes.length === 1) {
      const c = g.lanes[0].c;
      return `<div class="od-lane">
        <span class="nm" title="${esc(g.creditor)}">${esc(g.creditor)}<span
          title="${esc(c.kind)}">${esc(odContractName(c))}</span></span>
        <span class="od-cells">${cells}</span></div>`;
    }
    const subs = g.lanes.map((ln) => `<div class="od-lane">
      <span class="nm" title="${esc(ln.c.kind)}">${esc(odContractName(ln.c))}<span>${esc(ln.c.kind)}</span></span>
      <span class="od-cells">${odCells(ln.cells, s.yms, w)}</span></div>`).join('');
    return `<details class="od-grp"><summary class="od-lane od-sum">
        <i class="chev"></i>
        <span class="nm" title="${esc(g.creditor)}">${esc(g.creditor)}<span>${g.lanes.length}
          ${plural(g.lanes.length, 'договор', 'договора', 'договоров')}</span></span>
        <span class="od-cells">${cells}</span></summary>
      <div class="od-sub">${subs}</div></details>`;
  }).join('');

  return `<div class="note calm">Всё на этой вкладке взято из раздела «Сведения о сумме задолженности»:
      кредитор печатает там снимки долга на нерегулярные даты, а в снимке — строка «Просроченная»
      с суммой и датой возникновения. Где свежего снимка нет, отчёт не утверждает, что просрочки
      не было, — такие месяцы заштрихованы.</div>

    ${odVerdict(s.atDeal)}

    <h4 class="od-h">Каждая просрочка по отдельности</h4>
    <p class="od-lead">Строка — один непрерывный период просрочки по одному договору:
      с какого дня, у какого кредитора, на какую сумму и чем кончился.</p>
    ${odEpisodesTable(s)}

    <h4 class="od-h">Как это выглядело по месяцам</h4>
    ${odRangeBar()}

    <div class="card od-card">
      <div class="od-head"><h3>Просрочка по месяцам</h3>
        <span class="sub">${odMode === 'sum' ? 'высота — сумма, цвет — глубина' : 'высота и цвет — глубина'}</span>
        <span class="od-seg" role="group" aria-label="Что показывать по высоте">
          <button type="button" data-od="sum" aria-pressed="${odMode === 'sum'}">сумма, ₽</button>
          <button type="button" data-od="days" aria-pressed="${odMode === 'days'}">глубина, дней</button>
        </span></div>
      ${odChart(yms, cols, ticks, dealYm)}
      ${odHiddenNote(s.months, w)}
      <div class="od-ramp">${OD_LEGEND}
        <span class="sw"><i class="nd"></i>нет снимков долга</span>
        ${dealYm && yms[yms.length - 1] > dealYm
    ? '<span class="sw"><i class="post"></i>после сделки</span>' : ''}</div>
    </div>

    <div class="card od-card" style="--od-w:${odPlotWidth(yms.length)}px">
      <div class="od-head"><h3>Глубина просрочки по договорам</h3>
        <span class="sub">строка — кредитор, цвет — глубина на конец месяца · период тот же</span></div>
      <div class="od-lane od-lane-x"><span></span>
        <span class="od-x">${odYears(yms).map((y) => `<span>${y}</span>`).join('')}</span></div>
      <div class="od-lanes">${lanes}</div>
      <div class="od-ramp">${OD_LEGEND}
        <span class="sw"><i class="none"></i>без просрочки</span>
        <span class="sw"><i class="nd"></i>нет снимков</span></div>
    </div>`;
}

function odByStatus(st) {
  const deal = currentDeal();
  const dealYm = deal && deal.date ? deal.date.slice(0, 7) : null;
  const NAMES = ['оплачен не полностью', 'оплачен не вовремя', 'платежи не вносятся'];
  const w = odWindow(st.yms, dealYm, odRange);
  const yms = st.yms.slice(w.from, w.to);
  const months = st.months.slice(w.from, w.to);

  const cols = months.map((m) => {
    const cls = ['od-col'];
    let inner = '', first = true;
    for (let b = 1; b <= 3; b++) {
      if (!m.byB[b - 1]) continue;
      inner += `<em class="b${b}${first ? ' cap' : ''}" style="height:${(m.byB[b - 1] / m.n * 100).toFixed(2)}%"></em>`;
      first = false;
    }
    const t = m.empty
      ? `${P.formatMonth(m.ym)} — платежей нет`
      : [`${P.formatMonth(m.ym)} — ${m.n} ${plural(m.n, 'платёж', 'платежа', 'платежей')}`]
        .concat(m.bad ? NAMES.map((n, i) => (m.byB[i] ? `${n} — ${m.byB[i]}` : '')).filter(Boolean)
          : ['все в срок']).join('\n');
    return `<span class="${cls.join(' ')}" title="${esc(t)}">${inner}</span>`;
  }).join('');

  return `<div class="note"><b>Старый формат отчёта.</b> Снимков долга в нём нет, есть статус у каждого платежа.
      Поэтому высота столбца — <b>какая доля платежей месяца прошла не в срок или не прошла вовсе</b>,
      а не сумма просроченного долга.</div>
    ${odRangeBar()}
    <div class="card od-card">
      <div class="od-head"><h3>Просрочка по месяцам</h3>
        <span class="sub">доля проблемных платежей</span></div>
      ${odChart(yms, cols, ['100 %', 50, 0], dealYm)}
      ${odHiddenNote(st.months, w)}
      <div class="od-ramp">
        <span class="sw"><i class="b1"></i>оплачен не полностью</span>
        <span class="sw"><i class="b2"></i>оплачен не вовремя</span>
        <span class="sw"><i class="b3"></i>платежи не вносятся</span>
        <span class="sw"><i class="post"></i>после сделки</span></div>
    </div>`;
}

function odWire(box) {
  box.querySelectorAll('[data-od]').forEach((b) => b.addEventListener('click', () => {
    odMode = b.dataset.od; renderOverdue();
  }));
  box.querySelectorAll('[data-odr]').forEach((b) => b.addEventListener('click', () => {
    odRange = +b.dataset.odr; renderOverdue();
  }));
}

function renderOverdue() {
  const box = document.querySelector('#panel-overdue .pbody');
  if (!box) return;

  const s = overdueSeries();
  if (s) {
    box.innerHTML = odBySnapshots(s);
    odWire(box);
    return;
  }
  const st = overdueByStatus();
  if (st) { box.innerHTML = odByStatus(st); odWire(box); return; }

  box.innerHTML = `<div class="empty"><b>Данных о просрочке нет</b>
    Ни в одном договоре не нашлось ни раздела «Сведения о сумме задолженности»,
    ни статусов у платежей — построить динамику не из чего.</div>`;
}

function renderNew(res) {
  const box = document.querySelector('#panel-new .pbody');
  if (!res || !res.newContracts.length) {
    box.innerHTML = '<div class="empty"><b>Новых договоров нет</b>После указанной даты должник не заключал кредитных договоров из этого отчёта.</div>';
    return;
  }
  box.innerHTML = `<div class="note calm">Определяется по полю «Дата совершения сделки» кредитного договора.
      Исключить платежи по ним можно галочкой в «Дополнительно».</div>
    <div class="card"><div class="scroll-x"><table>
    <thead><tr><th>Дата договора</th><th>Кредитор</th><th>Вид</th><th>Статус</th>
      <th class="r">Сумма обязательства</th><th class="r">Платежей</th><th class="r">Лист</th></tr></thead>
    <tbody>${res.newContracts.slice().sort((a, b) => a.contractDate < b.contractDate ? 1 : -1).map((c) => `<tr>
      <td>${date(c.contractDate)}</td><td><b>${esc(c.creditor)}</b></td><td class="sub">${esc(c.kind)}</td>
      <td class="sub">${c.section === 'closed' ? 'закрыт' : 'действующий'}${c.hadOverdue ? ' · была просрочка' : ''}</td>
      <td class="r">${money0(c.amount)}</td><td class="r">${c.payments.length}</td>
      <td class="r sub">${c.page}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderNoData(res) {
  const box = document.querySelector('#panel-nodata .pbody');
  const list = report.contracts.filter((c) => !c.hasPaymentTable);
  if (!list.length) {
    box.innerHTML = '<div class="empty"><b>Таких договоров нет</b>По каждому договору в отчёте есть построчный список платежей.</div>';
    return;
  }
  const from = res && res.deal ? res.deal.date : null;
  const withEst = list.filter((c) => P.principalRepaidSince(c.debtSnapshots, from) > 0);

  box.innerHTML = `<div class="note"><b>Важно.</b> По этим договорам кредитор не передал в бюро построчный список платежей.
      Отсутствие платежей здесь <b>не значит, что их не было</b> — сведений просто нет в отчёте.</div>
    ${withEst.length ? `<div class="note calm">По ${withEst.length} из них движение всё же видно: раздел «Сведения о сумме
      задолженности» показывает, как менялся основной долг. Это <b>оценка снизу и косвенная</b>: долг уменьшается
      не только от платежей, но и при списании, переуступке или реструктуризации. В расчёт она не входит.</div>` : ''}
    <div class="card"><div class="scroll-x"><table>
    <thead><tr><th>№</th><th>Кредитор</th><th>Вид</th><th>Дата договора</th>
      <th class="r">Сумма обязательства</th><th class="r">Агрегат отчёта</th><th class="r">Снижение долга</th><th class="r">Лист</th></tr></thead>
    <tbody>${list.map((c) => {
    const est = P.principalRepaidSince(c.debtSnapshots, from);
    return `<tr><td class="sub">${c.section === 'closed' ? 'з' : 'д'}${c.index}</td>
      <td><b>${esc(c.creditor)}</b></td><td class="sub">${esc(c.kind)}</td><td>${date(c.contractDate)}</td>
      <td class="r">${money0(c.amount)}</td><td class="r">${c.controlTotals ? money(c.controlTotals.total) : '—'}</td>
      <td class="r"${est > 0 ? ' style="font-weight:700"' : ' class="r sub"'}>${c.debtSnapshots.length ? money(est) : '—'}</td>
      <td class="r sub">${c.page}</td></tr>`;
  }).join('')}</tbody></table></div></div>`;
}

function renderCheck() {
  const box = document.querySelector('#panel-check .pbody');
  const withTable = report.contracts.filter((c) => c.hasPaymentTable);
  const bad = withTable.filter((c) => c.totalsMatch === false);
  const broken = report.contracts.filter((c) => c.warnings.length);
  const totalPayments = report.contracts.reduce((a, c) => a + c.payments.length, 0);

  const dupContracts = report.contracts.filter((c) => c.duplicates && c.duplicates.length);

  let head = '';
  for (const w of (report.warnings || [])) head += `<div class="note"><b>${esc(w)}</b></div>`;

  if (dupContracts.length) {
    const totalExtra = dupContracts.reduce((a, c) => a + c.duplicateExtra, 0);
    head += `<div class="note"><b>Повторяющиеся записи — ${money(totalExtra)}.</b>
      Известный сбой старых отчётов ОКБ: один платёж печатается подряд несколько раз одной датой.
      ${filters.dedupe ? 'Сейчас каждая группа засчитана один раз.' : 'Сейчас повторы считаются полностью — переключатель в «Дополнительно».'}
      Проверить можно по столбцу «Долг до / после»: если он не изменился, денег в этот день не вносили.</div>
      <div class="card" style="margin-bottom:16px"><div class="scroll-x"><table>
      <thead><tr><th>Дата</th><th>Кредитор</th><th class="r">Сумма записи</th><th class="r">Повторов</th>
        <th class="r">Лишнее</th><th class="r">Долг до</th><th class="r">Долг после</th><th class="r">Лист</th></tr></thead>
      <tbody>${dupContracts.flatMap((c) => c.duplicates.map((g) => `<tr>
        <td>${date(g.date)}</td>
        <td><b>${esc(c.creditor)}</b> <span class="sub">${c.section === 'closed' ? 'з' : 'д'}${c.index}</span></td>
        <td class="r">${money(g.amount)}</td>
        <td class="r" style="font-weight:700">${g.count}</td>
        <td class="r" style="color:var(--acc);font-weight:600">${money(g.extra)}</td>
        <td class="r sub">${g.principalBefore == null ? '—' : money(g.principalBefore)}</td>
        <td class="r sub">${g.principalAfter == null ? '—' : money(g.principalAfter)}</td>
        <td class="r sub">${g.page || '—'}</td>
      </tr>`)).join('')}</tbody></table></div></div>`;
  }
  head += broken.length
    ? `<div class="note"><b>Разбор дал сбой</b> по ${broken.length} ${plural(broken.length, 'договору', 'договорам', 'договорам')}:<br>
       ${broken.map((c) => `${esc(c.creditor)} (№${c.index}): ${c.warnings.map(esc).join('; ')}`).join('<br>')}</div>`
    : `<div class="note calm">Сбоев разбора нет: ${withTable.length}
       ${plural(withTable.length, 'таблица прочитана', 'таблицы прочитаны', 'таблиц прочитаны')} целиком,
       разобрано ${totalPayments} ${plural(totalPayments, 'платёж', 'платежа', 'платежей')}.</div>`;

  if (bad.length) {
    head += `<div class="note"><b>Отчёт сам себе противоречит по ${bad.length} ${plural(bad.length, 'договору', 'договорам', 'договорам')}.</b>
      ОКБ печатает поле «Сумма всех внесенных платежей» отдельно от построчного списка, и кредиторы передают эти данные
      независимо. Там, где они расходятся, список может быть неполным.</div>`;
  }

  box.innerHTML = head + `<div class="card"><div class="scroll-x"><table>
    <thead><tr><th>№</th><th>Кредитор</th><th class="r">Платежей</th><th class="r">Сумма по списку</th>
      <th class="r">Агрегат отчёта</th><th class="r">Расхождение</th><th class="r">Погашено осн. долга</th><th>Итог</th></tr></thead>
    <tbody>${report.contracts.map((c) => {
    const state = !c.hasPaymentTable ? 'нет таблицы'
      : c.warnings.length ? 'сбой разбора'
        : c.totalsMatch ? 'сходится'
          : c.totalsMatch === false ? 'расхождение в отчёте' : 'нет агрегата';
    return `<tr><td class="sub">${c.section === 'closed' ? 'з' : 'д'}${c.index}</td>
      <td><b>${esc(c.creditor)}</b></td><td class="r">${c.payments.length}</td>
      <td class="r">${c.hasPaymentTable ? money(c.parsedTotal) : '—'}</td>
      <td class="r">${c.controlTotals ? money(c.controlTotals.total) : '—'}</td>
      <td class="r"${c.totalsMatch === false ? ' style="color:var(--acc);font-weight:600"' : ' class="r sub"'}>${!c.hasPaymentTable ? '—' : c.totalsDiff ? money(c.totalsDiff) : (c.totalsMatch ? '0,00 ₽' : '—')}</td>
      <td class="r sub">${c.debtSnapshots.length ? money(P.principalRepaidSince(c.debtSnapshots, null)) : '—'}</td>
      <td class="sub">${state}</td></tr>`;
  }).join('')}</tbody></table></div></div>
    <p class="hint">«Погашено осн. долга» — независимая оценка по разделу «Сведения о сумме задолженности».
      Не зависит от таблицы платежей, поэтому служит перекрёстной проверкой. Меньше суммы платежей, потому что
      не включает проценты и пени.</p>
    <p class="hint">Файл: ${esc(report.fileName || '—')} · формат ${esc(report.meta.version || '—')}${report.meta.format === 'old' ? ' (старый)' : ''} · ${report.meta.pages} стр.</p>`;
}

/* ================= CSV ================= */
$('btn-csv').addEventListener('click', () => {
  const deal = currentDeal();
  if (!deal || !deal.date) return;
  const res = compute(deal);
  const num = (v) => v == null ? '' : String(v).replace('.', ',');
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  const rows = [['Кредитор', 'Договор', 'Вид договора', 'Статус договора', 'Дата договора',
    'Дата платежа', 'Статус платежа', 'Сумма платежа', 'Основной долг', 'Проценты', 'Пени', 'Лист']];
  for (const g of res.groups)
    for (const it of g.items)
      for (const p of it.pays)
        rows.push([g.creditor, (it.c.section === 'closed' ? 'з' : 'д') + it.c.index, it.c.kind,
          it.c.section === 'closed' ? 'закрыт' : 'действующий', date(it.c.contractDate), date(p.date),
          p.status ? (P.STATUS_TITLES[p.status] || p.status) : '',
          num(p.amount), num(p.principal), num(p.interest), num(p.other), p.page || '']);
  rows.push([]);
  rows.push(['Сводка по кредиторам', 'Платежей', 'Сумма', 'Доля от внесённого после сделки']);
  for (const g of res.groups.slice().sort((a, b) => b.total - a.total)) {
    rows.push([g.creditor, g.count, num(Math.round(g.total * 100) / 100),
      res.total > 0 ? num(Math.round(g.total / res.total * 1000) / 10) + ' %' : '']);
  }
  rows.push([]);
  rows.push(['Итого', res.count, num(Math.round(res.total * 100) / 100), '100 %']);
  rows.push(['Период', deal.until ? `${date(deal.date)} — ${date(deal.until)}` : `с ${date(deal.date)}`]);
  if (monthFilter) rows.push(['Ограничение', 'только ' + P.formatMonth(monthFilter)]);

  // BOM + точка с запятой — чтобы русский Excel открыл без «Мастера импорта».
  const csv = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
  const who = (report.meta.fio || 'отчёт').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  download(`платежи после ${date(deal.date)} — ${who}.csv`, csv, 'text/csv;charset=utf-8');
});

/* при печати раскрываем свёрнутые группы */
let reopen = [];
window.addEventListener('beforeprint', () => {
  reopen = [];
  document.querySelectorAll('#cr-list details.g').forEach((d) => {
    if (!d.open) { reopen.push(d); d.open = true; }
  });
});
window.addEventListener('afterprint', () => { reopen.forEach((d) => { d.open = false; }); reopen = []; });

loadPrefs();
renderWho();
