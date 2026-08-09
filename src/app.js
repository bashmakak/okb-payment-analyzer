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
  return new Date(Date.UTC(p[0], p[1] - 1 + n, p[2])).toISOString().slice(0, 10);
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
    <div class="axis">${years.map((y) => `<span>${y}</span>`).join('')}</div>
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
  return groups.map((g, i) => `
    <details class="g" data-cr="${esc(g.creditor)}"${openCreditors.has(g.creditor) || (i === 0 && !openCreditors.size) ? ' open' : ''}>
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
  const defs = [
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
  renderNew(res); renderNoData(res); renderCheck();
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
