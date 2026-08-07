/*
 * Интерфейс анализатора. Разбор PDF живёт в parser.js, здесь только состояние
 * и отрисовка.
 *
 * Важно про перерисовку: боковая панель со сделками строится один раз и
 * пересобирается только при добавлении/удалении сделки. Ввод в поля меняет
 * состояние и перерисовывает ТОЛЬКО правую часть. Иначе поле даты теряет
 * каретку на каждом нажатии клавиши.
 */
const P = globalThis.OKBParser;
const pdfjsLib = globalThis.pdfjsLib;

/* ================= состояние ================= */
let report = null;
let deals = [];
let activeDeal = null;
let dealSeq = 0;
let hideFio = false;
let activeTab = 'creditors';
let monthFilter = null;          // 'ГГГГ-ММ' — сужение до одного месяца по клику на графике
let crSearch = '';
let crSort = 'total';

// statuses — только для старого формата (v1.x), где статус платежа нарисован
// иконкой. По умолчанию засчитываем лишь те, при которых деньги поступили.
const filters = { strict: false, status: 'all', hideZero: false, min: 0, statuses: null };

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

/* ================= работа с датами ================= */
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
  const t = new Date(Date.UTC(p[0], p[1] - 1 + n, p[2]));
  return t.toISOString().slice(0, 10);
}

const monthEnd = (ym) => {
  const p = ym.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1], 0)).toISOString().slice(0, 10);
};

/* ================= настройки в localStorage ================= */
// Только настройки интерфейса. Ничего персонального: на file:// localStorage
// общий для всех локальных страниц, туда нельзя класть данные должника.
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ filters, crSort, hideFio }));
  } catch (e) { /* приватный режим или запрет — не критично */ }
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.filters) Object.assign(filters, p.filters);
    if (p.crSort) crSort = p.crSort;
    if (typeof p.hideFio === 'boolean') hideFio = p.hideFio;
  } catch (e) { /* повреждённые настройки игнорируем */ }
}

function applyPrefsToControls() {
  $('f-strict').checked = filters.strict;
  $('f-status').value = filters.status;
  $('f-zero').checked = filters.hideZero;
  $('f-min').value = filters.min;
  $('cr-sort').value = crSort;
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
        // Нужен старому формату: статус платежа нарисован иконкой, а не текстом.
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
    report = parsed;
    deals = []; dealSeq = 0; activeDeal = null; monthFilter = null;
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
  $('header-actions').hidden = false;
  $('progress').hidden = true;

  const m = report.meta;
  $('m-date').textContent = date(m.reportDate);
  $('m-contracts').textContent = report.contracts.length;
  $('m-payments').textContent = report.contracts.reduce((a, c) => a + c.payments.length, 0);
  $('m-version').textContent = (m.version || '—') + (m.format === 'old' ? ' · старый' : '');

  applyPrefsToControls();
  renderStatusFilters();
  renderFio();
  renderSidebar();
  renderResults();
}

/** Старый формат: галочки по статусам платежей. */
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
    .map((k) => `<div class="filter">
      <input type="checkbox" id="st-${k}" data-status="${k}"${filters.statuses.includes(k) ? ' checked' : ''}>
      <label for="st-${k}">${esc(P.STATUS_TITLES[k] || k)} <span class="dim">${present[k]}</span></label>
    </div>`).join('');

  $('status-filters').querySelectorAll('input[data-status]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const k = inp.dataset.status;
      filters.statuses = inp.checked
        ? filters.statuses.concat([k])
        : filters.statuses.filter((s) => s !== k);
      savePrefs();
      renderResults();
    }));
}

$('btn-reset').addEventListener('click', () => {
  report = null;
  fileInput.value = '';
  $('screen-report').hidden = true;
  $('header-actions').hidden = true;
  $('screen-upload').hidden = false;
  $('progress').hidden = true;
  $('error').hidden = true;
});
$('btn-print').addEventListener('click', () => window.print());

/* ФИО */
function renderFio() {
  const el = $('fio');
  el.textContent = hideFio ? 'ФИО скрыто' : (report.meta.fio || '—');
  el.classList.toggle('hidden-fio', hideFio);
  $('btn-fio').textContent = hideFio ? 'Показать ФИО' : 'Скрыть ФИО';
}
$('btn-fio').addEventListener('click', () => { hideFio = !hideFio; renderFio(); savePrefs(); });

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
    app: 'okb-payment-analyzer', v: 1,
    savedAt: new Date().toISOString(),
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
    if (data.app !== 'okb-payment-analyzer' || !data.report) {
      throw new Error('Это не файл сессии анализатора.');
    }
    report = data.report;
    deals = data.deals && data.deals.length ? data.deals : [];
    dealSeq = deals.reduce((a, d) => Math.max(a, d.id), 0);
    if (!deals.length) addDeal();
    activeDeal = data.activeDeal && deals.some((d) => d.id === data.activeDeal)
      ? data.activeDeal : deals[0].id;
    if (data.filters) Object.assign(filters, data.filters);
    if (typeof data.hideFio === 'boolean') hideFio = data.hideFio;
    monthFilter = null;
    startReport();
  } catch (err) {
    console.error(err);
    showError(err && err.message ? err.message : 'Не удалось открыть сессию.');
  }
}

/* ================= сделки ================= */
function addDeal() {
  deals.push({ id: ++dealSeq, date: '', until: '', label: '' });
  activeDeal = dealSeq;
}

const currentDeal = () => deals.find((d) => d.id === activeDeal) || null;

const CAL_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">' +
  '<rect x="2" y="3.2" width="12" height="11" rx="1.6"/><path d="M2 6.6h12M5.5 1.8v2.6M10.5 1.8v2.6"/></svg>';

function dealCard(d, i, total) {
  const field = (f, label) => `
    <label>${label}</label>
    <div class="date-field">
      <input type="text" class="date-text" inputmode="numeric" maxlength="10"
             placeholder="дд.мм.гггг" data-f="${f}" data-id="${d.id}" value="${maskDigits(digitsFromIso(d[f]))}">
      <button class="date-pick" data-pick="${f}" data-id="${d.id}" title="Открыть календарь" tabindex="-1">${CAL_ICON}</button>
      <input type="date" class="date-native" data-native="${f}" data-id="${d.id}" tabindex="-1" aria-hidden="true">
    </div>
    <div class="date-echo" data-echo="${f}" data-id="${d.id}">${d[f] ? date(d[f]) : ''}</div>`;

  return `<div class="deal${d.id === activeDeal ? ' active' : ''}" data-deal="${d.id}">
    <div class="deal-top">
      <span class="deal-title">Сделка ${i + 1}</span>
      ${total > 1 ? `<button class="deal-del" data-del="${d.id}" title="Удалить">&times;</button>` : ''}
    </div>
    ${field('date', 'Дата сделки')}
    ${field('until', 'По (необязательно)')}
    <div class="presets">
      <button class="preset" data-preset="6" data-id="${d.id}">+6 мес</button>
      <button class="preset" data-preset="12" data-id="${d.id}">+1 год</button>
      <button class="preset" data-preset="36" data-id="${d.id}">+3 года</button>
      <button class="preset" data-preset="0" data-id="${d.id}">до конца</button>
    </div>
    <label>Пометка</label>
    <input type="text" data-f="label" data-id="${d.id}" value="${esc(d.label)}" placeholder="например, продажа авто">
  </div>`;
}

/** Пересобирает карточки сделок. Вызывать только при добавлении/удалении. */
function renderSidebar() {
  const box = $('deal-list');
  box.innerHTML = deals.map((d, i) => dealCard(d, i, deals.length)).join('');

  box.querySelectorAll('.deal').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    setActiveDeal(+el.dataset.deal);
  }));

  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const id = +b.dataset.del;
    deals = deals.filter((d) => d.id !== id);
    if (activeDeal === id) activeDeal = deals[0].id;
    renderSidebar();
    renderResults();
  }));

  box.querySelectorAll('input.date-text').forEach((inp) => {
    inp.addEventListener('input', () => onDateInput(inp));
    inp.addEventListener('focus', () => setActiveDeal(+inp.dataset.id));
  });

  box.querySelectorAll('input[data-f="label"]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const d = deals.find((x) => x.id === +inp.dataset.id);
      if (d) { d.label = inp.value; renderResults(); }
    });
  });

  box.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
    const d = deals.find((x) => x.id === +btn.dataset.id);
    const f = btn.dataset.pick;
    const native = box.querySelector(`input[data-native="${f}"][data-id="${btn.dataset.id}"]`);
    native.value = d[f] || '';
    setActiveDeal(d.id);
    try { native.showPicker(); } catch (e) { native.focus(); }
  }));

  box.querySelectorAll('input.date-native').forEach((native) => {
    native.addEventListener('change', () => {
      if (!native.value) return;
      const d = deals.find((x) => x.id === +native.dataset.id);
      const f = native.dataset.native;
      d[f] = native.value;
      const text = box.querySelector(`input.date-text[data-f="${f}"][data-id="${native.dataset.id}"]`);
      text.value = maskDigits(digitsFromIso(native.value));
      text.classList.remove('bad');
      setEcho(f, native.dataset.id, date(native.value), false);
      renderResults();
    });
  });

  box.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const d = deals.find((x) => x.id === +btn.dataset.id);
    if (!d.date) return;
    const n = +btn.dataset.preset;
    d.until = n ? addMonths(d.date, n) : '';
    const text = box.querySelector(`input.date-text[data-f="until"][data-id="${d.id}"]`);
    text.value = maskDigits(digitsFromIso(d.until));
    text.classList.remove('bad');
    setEcho('until', d.id, d.until ? date(d.until) : '', false);
    setActiveDeal(d.id);
    renderResults();
  }));
}

function setEcho(field, id, text, bad) {
  const el = $('deal-list').querySelector(`[data-echo="${field}"][data-id="${id}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

function setActiveDeal(id) {
  if (activeDeal === id) return;
  activeDeal = id;
  $('deal-list').querySelectorAll('.deal').forEach((el) =>
    el.classList.toggle('active', +el.dataset.deal === id));
  renderResults();
}

/**
 * Форматирует ввод, не сбивая каретку, и обновляет только правую часть.
 * Нативное поле type=date здесь не годится: оно считает дату «готовой»
 * после первой же цифры года и на перерисовке сбрасывает сегмент.
 */
function onDateInput(el) {
  const raw = el.value;
  const caretDigits = onlyDigits(raw.slice(0, el.selectionStart || 0)).length;
  const pasted = /[^\d.\s]/.test(raw);
  const digits = pasted ? looseToDigits(raw) : onlyDigits(raw);

  el.value = maskDigits(digits);
  if (!pasted) {
    let pos = 0, seen = 0;
    while (pos < el.value.length && seen < caretDigits) {
      if (/\d/.test(el.value[pos])) seen++;
      pos++;
    }
    try { el.setSelectionRange(pos, pos); } catch (e) { /* поле не поддерживает */ }
  }

  const d = deals.find((x) => x.id === +el.dataset.id);
  const f = el.dataset.f;
  const iso = isoFromDigits(digits);
  d[f] = iso;

  const bad = digits.length === 8 && !iso;
  el.classList.toggle('bad', bad);
  setEcho(f, el.dataset.id, bad ? 'Такой даты не существует' : (iso ? date(iso) : ''), bad);
  renderResults();
}

$('btn-add-deal').addEventListener('click', () => {
  addDeal();
  renderSidebar();
  renderResults();
});

/* ================= фильтры ================= */
function onFilterChange() { savePrefs(); renderResults(); }
$('f-strict').addEventListener('change', (e) => { filters.strict = e.target.checked; onFilterChange(); });
$('f-status').addEventListener('change', (e) => { filters.status = e.target.value; onFilterChange(); });
$('f-zero').addEventListener('change', (e) => { filters.hideZero = e.target.checked; onFilterChange(); });
$('f-min').addEventListener('input', (e) => { filters.min = Math.max(0, +e.target.value || 0); onFilterChange(); });
$('cr-search').addEventListener('input', (e) => { crSearch = e.target.value.trim().toLowerCase(); renderCreditors(compute(currentDeal())); });
$('cr-sort').addEventListener('change', (e) => { crSort = e.target.value; savePrefs(); renderCreditors(compute(currentDeal())); });

/* ================= расчёт ================= */
function contractsInScope() {
  return report.contracts.filter((c) => filters.status === 'all' ? true
    : filters.status === 'active' ? c.section === 'active' : c.section === 'closed');
}

function paymentPasses(p) {
  const a = p.amount == null ? 0 : p.amount;
  if (filters.hideZero && a === 0) return false;
  if (a < filters.min) return false;
  // Старый формат: столбцы со статусом «Платежи не вносятся» и подобными
  // содержат начисления, а не поступления — в расчёт их не берём.
  if (filters.statuses && p.status && !filters.statuses.includes(p.status)) return false;
  return true;
}

const afterDate = (iso, from) => filters.strict ? iso > from : iso >= from;

function compute(deal) {
  const from = deal.date;
  const until = deal.until || null;
  const scope = contractsInScope();

  // Суммы, отсечённые именно фильтром статусов, показываем отдельно —
  // молча выбрасывать сотни тысяч рублей нельзя.
  let excluded = 0, excludedCount = 0;

  const perContract = scope.map((c) => {
    const inPeriod = c.payments.filter((p) =>
      afterDate(p.date, from) &&
      (!until || p.date <= until) &&
      (!monthFilter || p.date.slice(0, 7) === monthFilter));
    for (const p of inPeriod) {
      if (p.status && filters.statuses && !filters.statuses.includes(p.status)) {
        excluded += p.amount || 0; excludedCount++;
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

  return {
    deal, groups, perContract, newContracts, excluded, excludedCount,
    total: perContract.reduce((a, x) => a + x.total, 0),
    count: perContract.reduce((a, x) => a + x.pays.length, 0),
    creditors: groups.length,
    contracts: perContract.length
  };
}

/** Суммы по месяцам за всё время — для графика (месячный фильтр здесь не применяется). */
function monthly() {
  const map = new Map();
  for (const c of contractsInScope())
    for (const p of c.payments) {
      if (!paymentPasses(p)) continue;
      const ym = p.date.slice(0, 7);
      const cur = map.get(ym) || { ym, total: 0, count: 0 };
      cur.total += p.amount || 0; cur.count++;
      map.set(ym, cur);
    }
  const list = [...map.values()].sort((a, b) => a.ym < b.ym ? -1 : 1);
  if (!list.length) return [];
  const out = [];
  const byYm = new Map(list.map((x) => [x.ym, x]));
  let [y, m] = list[0].ym.split('-').map(Number);
  const last = list[list.length - 1].ym;
  for (;;) {
    const ym = y + '-' + String(m).padStart(2, '0');
    out.push(byYm.get(ym) || { ym, total: 0, count: 0 });
    if (ym === last || out.length > 1200) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ================= отрисовка правой части ================= */
function renderResults() {
  const deal = currentDeal();
  const ready = deal && deal.date;

  $('no-deal').hidden = !!ready;
  $('results').hidden = !ready;
  if (!ready) return;

  const res = compute(deal);
  renderKpis(res);
  renderChart(deal);
  renderCompare();
  renderTabs(res);
  renderCreditors(res);
  renderNew(res);
  renderNoData();
  renderCheck();
  renderMonthChip();
}

function renderKpis(res) {
  const d = res.deal;
  const period = d.until
    ? `${date(d.date)} — ${date(d.until)}`
    : `с ${date(d.date)}` + (report.meta.reportDate ? ` по ${date(report.meta.reportDate)}` : '');
  $('kpis').innerHTML = `
    <div class="kpi main">
      <span>Внесено после сделки</span>
      <b class="num">${money0(res.total)}</b>
      <em>${money(res.total)}</em>
    </div>
    <div class="kpi">
      <span>Платежей</span><b class="num">${res.count}</b>
      <em>${monthFilter ? 'только ' + P.formatMonth(monthFilter) : period}</em>
    </div>
    <div class="kpi">
      <span>Кредиторов</span><b class="num">${res.creditors}</b>
      <em>по ${res.contracts} ${plural(res.contracts, 'договору', 'договорам', 'договорам')}</em>
    </div>
    <div class="kpi">
      <span>Договоров заключено после</span><b class="num">${res.newContracts.length}</b>
      <em>${res.newContracts.length ? 'см. вкладку ниже' : 'новых обязательств нет'}</em>
    </div>`;
}

function niceStep(max) {
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function renderChart(deal) {
  const data = monthly();
  const box = $('chart');
  if (data.length < 2) {
    box.innerHTML = '<p class="hint" style="padding:0 4px 8px">Недостаточно данных для графика.</p>';
    $('chart-note').textContent = '';
    return;
  }
  const W = 1000, H = 190, padL = 62, padR = 10, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...data.map((d) => d.total)) || 1;
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = iw / data.length;
  const from = deal.date, until = deal.until || null;

  let grid = '';
  for (let v = 0; v <= top + 1e-6; v += step) {
    const y = padT + ih - (v / top) * ih;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--ink-3)">${nfInt.format(v)}</text>`;
  }

  let bars = '', years = '', prevYear = null, marker = '';
  data.forEach((d, i) => {
    const x = padL + i * bw;
    const inPeriod = afterDate(d.ym + '-31', from) && (!until || d.ym + '-01' <= until);
    if (d.total > 0) {
      const h = Math.max(1.2, (d.total / top) * ih);
      const sel = monthFilter === d.ym;
      bars += `<rect x="${(x + bw * 0.14).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" `
        + `width="${(bw * 0.72).toFixed(1)}" height="${h.toFixed(1)}" rx="1" `
        + `fill="${sel ? 'var(--accent-2)' : inPeriod ? 'var(--accent)' : 'var(--line-2)'}" `
        + (inPeriod ? `class="bar-hit" data-ym="${d.ym}" style="cursor:pointer"` : '')
        + `><title>${P.formatMonth(d.ym)} — ${money(d.total)}, ${d.count} ${plural(d.count, 'платёж', 'платежа', 'платежей')}`
        + `${inPeriod ? '\nнажмите, чтобы показать только этот месяц' : ''}</title></rect>`;
    }
    const y = d.ym.slice(0, 4);
    if (y !== prevYear) {
      prevYear = y;
      years += `<text x="${x.toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--ink-3)">${y}</text>`;
    }
  });

  const idx = data.findIndex((d) => d.ym >= from.slice(0, 7));
  if (idx >= 0) {
    const x = padL + idx * bw;
    marker = `<line x1="${x.toFixed(1)}" y1="${padT - 4}" x2="${x.toFixed(1)}" y2="${padT + ih}" stroke="var(--accent-2)" stroke-width="1.2" stroke-dasharray="3 3"/>`;
  }

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">`
    + grid + bars + marker
    + `<line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}" stroke="var(--line-2)"/>`
    + years + '</svg>';

  box.querySelectorAll('.bar-hit').forEach((r) => r.addEventListener('click', () => {
    monthFilter = monthFilter === r.dataset.ym ? null : r.dataset.ym;
    renderResults();
  }));

  $('chart-note').textContent = `пунктир — дата сделки (${date(deal.date)}) · клик по столбцу — показать только этот месяц`;
}

function renderMonthChip() {
  $('month-chip').innerHTML = monthFilter
    ? `<span class="chip">Только ${P.formatMonth(monthFilter)}<button id="chip-off" title="Показать весь период">&times;</button></span>`
    : '';
  const off = $('chip-off');
  if (off) off.addEventListener('click', () => { monthFilter = null; renderResults(); });
}

function renderCompare() {
  const valid = deals.filter((d) => d.date);
  const card = $('compare-card');
  if (valid.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const rows = valid.map((d) => {
    const r = compute(d);
    const idx = deals.indexOf(d) + 1;
    return `<tr class="clickable${d.id === activeDeal ? ' sel' : ''}" data-deal="${d.id}">
      <td><b>Сделка ${idx}</b>${d.label ? `<div class="dim" style="font-size:12.5px">${esc(d.label)}</div>` : ''}</td>
      <td class="num">${date(d.date)}</td>
      <td class="num dim">${d.until ? date(d.until) : '—'}</td>
      <td class="r money strong">${money(r.total)}</td>
      <td class="r num">${r.count}</td>
      <td class="r num">${r.creditors}</td>
      <td class="r num">${r.contracts}</td>
      <td class="r num">${r.newContracts.length}</td>
    </tr>`;
  }).join('');
  $('compare').innerHTML = `<thead><tr>
      <th>Сделка</th><th>Дата</th><th>По</th><th class="r">Внесено после</th>
      <th class="r">Платежей</th><th class="r">Кредиторов</th><th class="r">Договоров</th><th class="r">Новых договоров</th>
    </tr></thead><tbody>${rows}</tbody>`;
  $('compare').querySelectorAll('tr[data-deal]').forEach((tr) =>
    tr.addEventListener('click', () => setActiveDeal(+tr.dataset.deal)));
}

function renderTabs(res) {
  const noData = report.contracts.filter((c) => !c.hasPaymentTable).length;
  const defs = [
    ['creditors', 'По кредиторам', res.creditors],
    ['new', 'Договоры после сделки', res.newContracts.length],
    ['nodata', 'Без данных о платежах', noData],
    ['check', 'Проверка разбора', null]
  ];
  $('tabs').innerHTML = defs.map(([k, label, cnt]) =>
    `<button class="tab${k === activeTab ? ' active' : ''}" data-tab="${k}">${label}${cnt != null ? ` <span class="cnt">${cnt}</span>` : ''}</button>`).join('');
  $('tabs').querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    $('tabs').querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-panel').forEach((p) =>
      p.classList.toggle('active', p.id === 'panel-' + activeTab));
  }));
  defs.forEach(([k, label]) => {
    const t = document.querySelector('#panel-' + k + ' .panel-title');
    if (t) t.textContent = label;
  });
  document.querySelectorAll('.tab-panel').forEach((p) =>
    p.classList.toggle('active', p.id === 'panel-' + activeTab));
}

function statusTags(c) {
  const tags = [];
  tags.push(c.section === 'closed'
    ? '<span class="tag closed">закрыт</span>'
    : '<span class="tag ok">действующий</span>');
  if (c.isAssigned) tags.push('<span class="tag">переуступлен</span>');
  if (c.hadOverdue) tags.push('<span class="tag overdue">была просрочка</span>');
  return tags.join(' ');
}

function renderCreditors(res) {
  const box = document.querySelector('#panel-creditors .panel-body');
  let groups = res.groups.slice();

  if (crSearch) groups = groups.filter((g) => g.creditor.toLowerCase().includes(crSearch));
  groups.sort(crSort === 'name'
    ? (a, b) => a.creditor.localeCompare(b.creditor, 'ru')
    : crSort === 'count' ? (a, b) => b.count - a.count : (a, b) => b.total - a.total);

  if (!groups.length) {
    box.innerHTML = `<div class="empty"><b>${res.groups.length ? 'Ничего не найдено' : 'Платежей после ' + date(res.deal.date) + ' не найдено'}</b>
      ${res.groups.length ? 'Измените строку поиска.' : 'Проверьте дату и фильтры — возможно, отсечены нулевые или мелкие платежи.'}</div>`;
    return;
  }
  const max = Math.max(...groups.map((g) => g.total)) || 1;
  const note = res.excludedCount ? `<div class="callout">
      <b>Не засчитано по статусу: ${money(res.excluded)}</b> — ${res.excludedCount} ${plural(res.excludedCount, 'столбец', 'столбца', 'столбцов')}
      таблицы с отметками вроде «Платежи не вносятся». Это начисления, а не поступления.
      Управлять набором статусов можно слева.</div>` : '';
  box.innerHTML = note + groups.map((g, i) => `
    <details class="creditor"${i === 0 ? ' open' : ''}>
      <summary>
        <i class="chev"></i>
        <span class="cr-name" title="${esc(g.creditor)}">${esc(g.creditor)}</span>
        <span class="cr-bar"><i style="width:${(g.total / max * 100).toFixed(1)}%"></i></span>
        <span class="cr-count">${g.count} ${plural(g.count, 'платёж', 'платежа', 'платежей')} · ${g.items.length} ${plural(g.items.length, 'договор', 'договора', 'договоров')}</span>
        <span class="cr-total">${money(g.total)}</span>
      </summary>
      <div class="cr-body">${g.items.map(renderContract).join('')}</div>
    </details>`).join('');
}

function renderContract(item) {
  const c = item.c;
  const showStatus = report.meta.format === 'old';
  return `<div class="contract-block">
    <div class="contract-head">
      <h4>№${c.index} · ${esc(c.kind)}</h4>
      ${statusTags(c)}
      <span class="contract-total">${money(item.total)}</span>
    </div>
    <div class="contract-meta" style="margin-bottom:9px">
      Договор от <b>${date(c.contractDate)}</b>
      ${c.contractNumber ? ` · № <b>${esc(c.contractNumber)}</b>` : ''}
      ${c.participation ? ` · ${esc(c.participation)}` : ''}
      ${c.amount != null ? ` · сумма обязательства <b>${money0(c.amount)}</b>` : ''}
      · стр. ${c.page}
    </div>
    <div class="table-scroll"><table class="pay-table">
      <thead><tr>
        <th>Дата платежа</th>${showStatus ? '<th>Статус</th>' : ''}<th class="r">Сумма</th><th class="r">Основной долг</th>
        <th class="r">Проценты</th><th class="r">Иное (пени)</th>
      </tr></thead>
      <tbody>${item.pays.map((p) => `<tr>
        <td class="num">${date(p.date)}</td>
        ${showStatus ? `<td class="dim" style="font-size:12px">${esc(P.STATUS_TITLES[p.status] || '—')}</td>` : ''}
        <td class="r money strong">${money(p.amount)}</td>
        <td class="r money dim">${money(p.principal)}</td>
        <td class="r money dim">${money(p.interest)}</td>
        <td class="r money dim">${money(p.other)}</td>
      </tr>`).join('')}
      <tr class="sum-row">
        <td${showStatus ? ' colspan="2"' : ''}>Итого ${item.pays.length} ${plural(item.pays.length, 'платёж', 'платежа', 'платежей')}</td>
        <td class="r money">${money(item.total)}</td>
        <td class="r money">${money(item.principal)}</td>
        <td class="r money">${money(item.interest)}</td>
        <td class="r money">${money(item.other)}</td>
      </tr></tbody>
    </table></div>
  </div>`;
}

function renderNew(res) {
  const box = document.querySelector('#panel-new .panel-body');
  if (!res.newContracts.length) {
    box.innerHTML = `<div class="empty"><b>Новых договоров нет</b>
      После ${date(res.deal.date)} должник не заключал кредитных договоров из этого отчёта.</div>`;
    return;
  }
  box.innerHTML = `<div class="callout info">Договоры, <b>заключённые после даты сделки</b> — по полю «Дата совершения сделки» кредитного договора в отчёте.</div>
    <div class="card"><div class="table-scroll"><table>
    <thead><tr><th>Дата договора</th><th>Кредитор</th><th>Вид</th><th>Статус</th>
      <th class="r">Сумма обязательства</th><th class="r">Платежей в отчёте</th><th class="r">Стр.</th></tr></thead>
    <tbody>${res.newContracts.slice().sort((a, b) => a.contractDate < b.contractDate ? 1 : -1).map((c) => `<tr>
      <td class="num">${date(c.contractDate)}</td>
      <td><b>${esc(c.creditor)}</b></td>
      <td class="dim">${esc(c.kind)}</td>
      <td>${statusTags(c)}</td>
      <td class="r money">${money0(c.amount)}</td>
      <td class="r num">${c.payments.length}</td>
      <td class="r num dim">${c.page}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
}

function renderNoData() {
  const box = document.querySelector('#panel-nodata .panel-body');
  const list = report.contracts.filter((c) => !c.hasPaymentTable);
  if (!list.length) {
    box.innerHTML = '<div class="empty"><b>Таких договоров нет</b>По каждому договору в отчёте есть таблица платежей.</div>';
    return;
  }
  box.innerHTML = `<div class="callout"><b>Важно.</b> По этим договорам кредитор не передал в бюро построчный список платежей.
    Отсутствие платежей здесь <b>не значит, что их не было</b> — сведений просто нет в отчёте.</div>
    <div class="card"><div class="table-scroll"><table>
    <thead><tr><th>№</th><th>Кредитор</th><th>Вид</th><th>Дата договора</th><th>Статус</th>
      <th class="r">Сумма обязательства</th><th class="r">Агрегат «всего внесено»</th><th class="r">Стр.</th></tr></thead>
    <tbody>${list.map((c) => `<tr>
      <td class="num dim">${c.section === 'closed' ? 'з' : 'д'}${c.index}</td>
      <td><b>${esc(c.creditor)}</b></td>
      <td class="dim">${esc(c.kind)}</td>
      <td class="num">${date(c.contractDate)}</td>
      <td>${statusTags(c)}</td>
      <td class="r money">${money0(c.amount)}</td>
      <td class="r money">${c.controlTotals ? money(c.controlTotals.total) : '—'}</td>
      <td class="r num dim">${c.page}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
}

function renderCheck() {
  const box = document.querySelector('#panel-check .panel-body');
  const withTable = report.contracts.filter((c) => c.hasPaymentTable);
  const bad = withTable.filter((c) => c.totalsMatch === false);
  const broken = report.contracts.filter((c) => c.warnings.length);
  const totalPayments = report.contracts.reduce((a, c) => a + c.payments.length, 0);

  let head = '';
  for (const w of (report.warnings || [])) head += `<div class="callout"><b>${esc(w)}</b></div>`;

  if (broken.length) {
    head += `<div class="callout"><b>Разбор дал сбой</b> по ${broken.length} ${plural(broken.length, 'договору', 'договорам', 'договорам')}.
      Данные ниже могут быть неполными:<br>${broken.map((c) => `${esc(c.creditor)} (№${c.index}): ${c.warnings.map(esc).join('; ')}`).join('<br>')}</div>`;
  } else {
    head += `<div class="callout info">Сбоев разбора нет: все ${withTable.length} ${plural(withTable.length, 'таблица платежей прочитана', 'таблицы платежей прочитаны', 'таблиц платежей прочитаны')} целиком,
      разобрано ${totalPayments} ${plural(totalPayments, 'платёж', 'платежа', 'платежей')}.</div>`;
  }
  if (bad.length) {
    head += `<div class="callout"><b>Отчёт сам себе противоречит по ${bad.length} ${plural(bad.length, 'договору', 'договорам', 'договорам')}.</b>
      ОКБ печатает поле «Сумма всех внесенных платежей» отдельно от построчного списка, и кредиторы передают эти данные независимо.
      Там, где они расходятся, построчный список (а значит и расчёт выше) может быть неполным — такие договоры стоит проверить по первичным документам.</div>`;
  }

  box.innerHTML = head + `<div class="card"><div class="table-scroll"><table>
    <thead><tr><th>№</th><th>Кредитор</th><th class="r">Платежей</th>
      <th class="r">Сумма по списку</th><th class="r">Агрегат отчёта</th><th class="r">Расхождение</th><th>Итог</th></tr></thead>
    <tbody>${report.contracts.map((c) => {
    const state = !c.hasPaymentTable ? '<span class="tag">нет таблицы</span>'
      : c.warnings.length ? '<span class="tag overdue">сбой разбора</span>'
        : c.totalsMatch ? '<span class="tag ok">сходится</span>'
          : c.totalsMatch === false ? '<span class="tag overdue">расхождение в отчёте</span>'
            : '<span class="tag">нет агрегата</span>';
    return `<tr>
        <td class="num dim">${c.section === 'closed' ? 'з' : 'д'}${c.index}</td>
        <td><b>${esc(c.creditor)}</b></td>
        <td class="r num">${c.payments.length}</td>
        <td class="r money">${c.hasPaymentTable ? money(c.parsedTotal) : '—'}</td>
        <td class="r money">${c.controlTotals ? money(c.controlTotals.total) : '—'}</td>
        <td class="r money${c.totalsMatch === false ? '' : ' dim'}">${!c.hasPaymentTable ? '—' : c.totalsDiff ? money(c.totalsDiff) : (c.totalsMatch ? '0,00 ₽' : '—')}</td>
        <td>${state}</td>
      </tr>`;
  }).join('')}</tbody></table></div></div>
    <p class="hint">Файл: ${esc(report.fileName || '—')} · формат ${esc(report.meta.version || '—')} · ${report.meta.pages} стр. ·
    «д» — действующий договор, «з» — закрытый; номера соответствуют нумерации разделов отчёта.</p>`;
}

/* ================= выгрузка CSV ================= */
$('btn-csv').addEventListener('click', () => {
  const deal = currentDeal();
  if (!deal || !deal.date) return;
  const res = compute(deal);
  const num = (v) => v == null ? '' : String(v).replace('.', ',');
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  const rows = [['Кредитор', 'Договор', 'Вид договора', 'Статус', 'Дата договора',
    'Дата платежа', 'Сумма платежа', 'Основной долг', 'Проценты', 'Иное (пени)']];
  for (const g of res.groups)
    for (const it of g.items)
      for (const p of it.pays)
        rows.push([g.creditor, (it.c.section === 'closed' ? 'з' : 'д') + it.c.index, it.c.kind,
          it.c.section === 'closed' ? 'закрыт' : 'действующий', date(it.c.contractDate),
          date(p.date), num(p.amount), num(p.principal), num(p.interest), num(p.other)]);
  rows.push([]);
  rows.push(['Итого', '', '', '', '', '', num(Math.round(res.total * 100) / 100)]);
  rows.push(['Период', deal.until ? `${date(deal.date)} — ${date(deal.until)}` : `с ${date(deal.date)}`]);
  if (monthFilter) rows.push(['Ограничение', 'только ' + P.formatMonth(monthFilter)]);

  // BOM + точка с запятой — чтобы русский Excel открыл файл без «Мастера импорта».
  const csv = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
  const who = (report.meta.fio || 'отчёт').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  download(`платежи после ${date(deal.date)} — ${who}.csv`, csv, 'text/csv;charset=utf-8');
});

/* при печати раскрываем все свёрнутые группы */
let reopen = [];
window.addEventListener('beforeprint', () => {
  reopen = [];
  document.querySelectorAll('details.creditor').forEach((d) => {
    if (!d.open) { reopen.push(d); d.open = true; }
  });
});
window.addEventListener('afterprint', () => { reopen.forEach((d) => { d.open = false; }); reopen = []; });

loadPrefs();
