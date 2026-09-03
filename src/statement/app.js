/*
 * Интерфейс конструктора.
 *
 * Устройство: данные вводятся один раз в карточке дела и карточке сделки,
 * дальше человек только отвечает на вопросы и отмечает блоки, а текст
 * собирается сам. Поэтому основной экран — не редактор, а анкета: формы
 * и переключатели слева, готовый документ справа.
 *
 * Разметка перерисовывается целиком на смену экрана и на смену ответа,
 * влияющего на состав полей. Набор текста перерисовку не вызывает — иначе
 * каретка прыгала бы на каждой букве.
 */
(function () {
  'use strict';

  const D = globalThis.ZData;
  const S = globalThis.ZStore;
  const X = globalThis.ZDoc;

  let db = S.load();

  /* ================= служебное ================= */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const attr = (s) => esc(s).replace(/'/g, '&#39;');

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!S.save(db)) note('Не удалось сохранить: в браузере отключено локальное хранилище.');
    }, 200);
  }
  const saveNow = () => { clearTimeout(saveTimer); S.save(db); };

  /* ================= маршрут ================= */

  let route = { name: 'cases' };
  let tabs = { case: 'req', deal: 'main' };
  let openBlocks = new Set();

  function parseHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const p = raw.split('/').filter(Boolean).map(decodeURIComponent);
    if (!p.length) return { name: 'cases' };
    if (p[0] === 'case' && p[1]) return { name: 'case', caseId: p[1] };
    if (p[0] === 'deal' && p[2]) return { name: 'deal', caseId: p[1], dealId: p[2] };
    if (p[0] === 'builder' && p[2]) return { name: 'builder', caseId: p[1], dealId: p[2] };
    if (p[0] === 'blocks') return { name: 'blocks' };
    return { name: 'cases' };
  }

  const go = (hash) => { location.hash = hash; };

  const currentCase = () => db.cases.find((c) => c.id === route.caseId) || null;
  const currentDeal = () => {
    const c = currentCase();
    return c ? (c.deals.find((d) => d.id === route.dealId) || null) : null;
  };

  /* ================= привязка полей ================= */

  let editParty = null, editDoc = null, editBlock = null;

  function roots() {
    return {
      db: db, profile: db.profile,
      case: currentCase(), deal: currentDeal(),
      party: editParty, doc: editDoc, block: editBlock
    };
  }

  function resolve(path) {
    const seg = String(path).split('.');
    let o = roots()[seg[0]];
    for (let i = 1; i < seg.length - 1 && o; i++) o = o[seg[i]];
    return o ? { obj: o, key: seg[seg.length - 1] } : null;
  }

  const getPath = (path) => {
    const r = resolve(path);
    return r ? r.obj[r.key] : '';
  };

  function setPath(path, value) {
    const r = resolve(path);
    if (r) r.obj[r.key] = value;
  }

  /** «8 400 000,55» и «8400000.55» — одно и то же число. */
  const normMoney = (s) => String(s).replace(/\s|\u00A0/g, '').replace(',', '.');

  // Крупные суммы на плитках печатаются без копеек: две лишние цифры в кегле
  // 56 px забирают половину строки и ничего не добавляют.
  const nfInt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const money0 = (v) => (v === '' || v == null || !isFinite(v)) ? '—' : nfInt.format(Math.round(Number(v)));

  /* ================= элементы формы ================= */

  function field(o) {
    const type = o.type || 'text';
    const val = o.value != null ? o.value : getPath(o.bind);
    if (o.readonly) {
      return `<div class="f${o.wide ? ' wide' : ''}"><label class="lb">${esc(o.label)}</label>` +
        `<input type="text" value="${attr(val)}" readonly tabindex="-1" ` +
        `style="background:var(--surface-2);color:var(--ink-2)"></div>`;
    }
    const req = o.required ? ' <span class="req">*</span>' : '';
    const cls = 'f' + (o.wide ? ' wide' : '');
    const bad = o.bad ? ' bad' : '';
    let control;

    if (type === 'select') {
      control = `<select data-bind="${attr(o.bind)}" class="${bad}">` +
        o.options.map((op) => `<option value="${attr(op.id)}"${String(op.id) === String(val) ? ' selected' : ''}>` +
          esc(op.name) + '</option>').join('') + '</select>';
    } else if (type === 'textarea') {
      control = `<textarea data-bind="${attr(o.bind)}" rows="${o.rows || 3}" ` +
        `placeholder="${attr(o.placeholder || '')}"${o.grow ? ' data-grow="1"' : ''}>${esc(val)}</textarea>`;
    } else {
      const kind = o.money ? ' data-kind="money"' : '';
      const list = o.list ? ` list="${attr(o.list)}"` : '';
      control = `<input type="${type}" data-bind="${attr(o.bind)}" value="${attr(val)}" ` +
        `placeholder="${attr(o.placeholder || '')}" class="${bad}"${kind}${list}>`;
    }

    return `<div class="${cls}"><label class="lb">${esc(o.label)}${req}</label>${control}` +
      (o.hint ? `<p class="hint">${esc(o.hint)}</p>` : '') + '</div>';
  }

  /** Переключатель «или — или» таблетками: и на телефоне попадаешь пальцем. */
  function radios(bind, options, value) {
    return '<div class="radios">' + options.map((op) =>
      `<label class="radio${String(op.id) === String(value) ? ' on' : ''}">` +
      `<input type="radio" data-bind="${attr(bind)}" value="${attr(op.id)}"` +
      (String(op.id) === String(value) ? ' checked' : '') + `>${esc(op.name)}</label>`).join('') + '</div>';
  }

  const yesNo = (bind, value) => radios(bind, [{ id: 'yes', name: 'Да' }, { id: 'no', name: 'Нет' }], value ? 'yes' : 'no');

  function checkList(bind, options, selected) {
    const set = new Set(selected || []);
    return options.map((op) =>
      `<label class="chk"><input type="checkbox" data-arr="${attr(bind)}" value="${attr(op.id)}"` +
      (set.has(op.id) ? ' checked' : '') + `><span>${esc(op.name)}</span></label>`).join('');
  }

  const dataList = (id, items) =>
    `<datalist id="${id}">` + items.map((s) => `<option value="${attr(s)}">`).join('') + '</datalist>';

  /* ================= экран «Мои дела» ================= */

  /** Сводка по делу: на неё опираются и карточка, и плитки. */
  function caseStats(c) {
    const ready = c.deals.filter((d) => d.statement.status === 'ready').length;
    return { deals: c.deals.length, ready: ready, draft: c.deals.length - ready, parties: c.parties.length };
  }

  function screenCases() {
    // Первый заход: то же приглашение, что экран загрузки у анализатора —
    // одно крупное действие слева и три шага справа.
    if (!db.cases.length) {
      return `<div class="up">
        <button class="drop" data-act="new-case">
          <span class="ic">+</span>
          <b>Новое дело</b>
          <span>Суд, номер, должник, управляющий — один раз на всё дело</span>
        </button>
        <div class="aside">
          <div class="t">
            <div class="steps">
              <div class="stp"><span class="n">1</span><div><b>Заведите дело</b>
                <span class="m">Реквизиты подставятся во все заявления внутри него.</span></div></div>
              <div class="stp"><span class="n">2</span><div><b>Добавьте сделку</b>
                <span class="m">Тип, объект, стороны и несколько вопросов об обстоятельствах.</span></div></div>
              <div class="stp"><span class="n">3</span><div><b>Соберите заявление</b>
                <span class="m">Отметьте блоки и скачайте DOCX или распечатайте в PDF.</span></div></div>
            </div>
          </div>
          <div class="t">
            <div class="k">Данные остаются у вас</div>
            <p class="m" style="font-size:13px;color:var(--ink-2)">Дела хранятся в этом браузере.
              Сервера у приложения нет — реквизиты должников и контрагентов никуда не отправляются,
              страница работает и без интернета.</p>
          </div>
        </div>
      </div>`;
    }

    const total = db.cases.reduce((a, c) => {
      const s = caseStats(c);
      return { deals: a.deals + s.deals, ready: a.ready + s.ready, draft: a.draft + s.draft };
    }, { deals: 0, ready: 0, draft: 0 });

    const cards = db.cases.map((c) => {
      const s = caseStats(c);
      return `<button class="t link casecard s4" data-go="#/case/${c.id}">
        <div class="no">${esc(c.number || 'номер не указан')}</div>
        <h3>${esc(S.partyName(S.debtorOf(c)) || 'Должник не указан')}</h3>
        <div class="m">${esc(D.nameOf(D.PROCEDURES, c.procedure))}${c.court ? ' · ' + esc(c.court) : ''}</div>
        <div class="strip">
          <div><b>${s.deals}</b>${D.plural(s.deals, 'сделка', 'сделки', 'сделок')}</div>
          <div><b>${s.ready}</b>готово</div>
          <div><b>${s.draft}</b>${D.plural(s.draft, 'черновик', 'черновика', 'черновиков')}</div>
        </div>
      </button>`;
    }).join('');

    return `<div class="bento anim">
      <div class="t hero s8">
        <div class="k">Мои дела</div>
        <div class="big">${db.cases.length}<small> ${D.plural(db.cases.length, 'дело', 'дела', 'дел')}</small></div>
        <p class="said">Реквизиты дела вводятся один раз и подставляются во все заявления внутри него —
          ни суд, ни ИНН должника, ни данные контрагента переписывать не нужно.</p>
        <div class="strip">
          <div><b>${total.deals}</b>${D.plural(total.deals, 'сделка', 'сделки', 'сделок')}</div>
          <div><b>${total.ready}</b>${D.plural(total.ready, 'заявление готово', 'заявления готовы', 'заявлений готово')}</div>
          <div><b>${total.draft}</b>${D.plural(total.draft, 'черновик', 'черновика', 'черновиков')}</div>
        </div>
        <div class="act"><button class="btn pri" data-act="new-case">+ Новое дело</button></div>
      </div>

      <div class="t s4">
        <div class="k">Как это работает</div>
        <div class="steps" style="margin-top:4px">
          <div class="stp"><span class="n">1</span><div><b>Дело</b>
            <span class="m">Суд, номер, должник, управляющий.</span></div></div>
          <div class="stp"><span class="n">2</span><div><b>Сделка</b>
            <span class="m">Объект, стороны, обстоятельства.</span></div></div>
          <div class="stp"><span class="n">3</span><div><b>Заявление</b>
            <span class="m">Блоки, предпросмотр, DOCX и PDF.</span></div></div>
        </div>
      </div>

      ${cards}
      <button class="t link s4" data-act="new-case"
        style="border-style:dashed;align-items:center;justify-content:center;min-height:132px;
               color:var(--ink-3);background:none;box-shadow:none">
        <span style="font-size:26px;line-height:1">+</span><span>Новое дело</span>
      </button>
    </div>`;
  }

  /* ================= экран дела ================= */

  const tab = (screen, id, name, count) =>
    `<button class="tab${tabs[screen] === id ? ' on' : ''}" data-tab="${screen}:${id}">${name}` +
    (count == null ? '' : `<span class="n">${count}</span>`) + '</button>';

  function screenCase() {
    const c = currentCase();
    if (!c) return notFound();
    const debtor = S.debtorOf(c);
    const s = caseStats(c);
    const pct = s.deals ? Math.round(s.ready / s.deals * 100) : 0;

    const head = `<div class="crumbs"><a href="#/">Мои дела</a><span>›</span>
        <span>${esc(c.number || 'без номера')}</span></div>
      <div class="bento anim">
        <div class="t hero s8">
          <div class="k">${esc(c.number || 'Номер дела не указан')}</div>
          <h2>${esc(S.partyName(debtor) || 'Новое дело')}</h2>
          <p class="said">${esc(D.nameOf(D.PROCEDURES, c.procedure))}${c.court ? ' · ' + esc(c.court) : ''}</p>
          <div class="strip">
            <div><b>${s.deals}</b>${D.plural(s.deals, 'сделка', 'сделки', 'сделок')}</div>
            <div><b>${s.ready}</b>${D.plural(s.ready, 'заявление готово', 'заявления готовы', 'заявлений готово')}</div>
            <div><b>${s.draft}</b>${D.plural(s.draft, 'черновик', 'черновика', 'черновиков')}</div>
            <div><b>${s.parties}</b>${D.plural(s.parties, 'сторона', 'стороны', 'сторон')}</div>
          </div>
          <div class="act"><button class="btn pri" data-act="new-deal">+ Добавить сделку</button></div>
        </div>

        <div class="t s4">
          <div class="k">Готовность заявлений</div>
          <div class="v">${pct}<small style="font-size:16px;color:var(--ink-3)"> %</small></div>
          <div class="meter"><i class="${pct === 100 ? 'done' : ''}" style="width:${pct}%"></i></div>
          <p class="m">${s.ready} из ${s.deals} ${D.plural(s.deals, 'сделки', 'сделок', 'сделок')} доведено до готового заявления.</p>
          <div style="margin-top:auto;padding-top:8px">
            <button class="btn btn-sm danger" data-act="del-case">Удалить дело</button>
          </div>
        </div>
      </div>

      <div class="tabs">
        ${tab('case', 'req', 'Реквизиты дела')}
        ${tab('case', 'parties', 'Стороны', c.parties.length)}
        ${tab('case', 'deals', 'Сделки', c.deals.length)}
      </div>`;

    const body = tabs.case === 'parties' ? casePartiesTab(c)
      : tabs.case === 'deals' ? caseDealsTab(c)
        : caseReqTab(c, debtor);

    return head + body;
  }

  function caseReqTab(c, debtor) {
    return `<div class="card">
        <h3>Суд и дело</h3>
        <p class="m">Эти сведения попадут в шапку каждого заявления по делу.</p>
        <div class="form">
          ${field({ label: 'Арбитражный суд', bind: 'case.court', required: true, placeholder: 'Арбитражный суд города Москвы' })}
          ${field({ label: 'Номер дела', bind: 'case.number', required: true, placeholder: 'А40-000000/2025' })}
          ${field({ label: 'Адрес суда', bind: 'case.courtAddress', wide: true })}
          ${field({ label: 'Процедура', bind: 'case.procedure', type: 'select', options: D.PROCEDURES })}
          ${field({ label: 'Дата введения процедуры', bind: 'case.procedureDate', type: 'date' })}
          ${field({ label: 'Дата возбуждения дела', bind: 'case.caseStartDate', type: 'date', hint: 'От неё считаются периоды подозрительности' })}
          ${field({ label: 'Реквизиты судебного акта', bind: 'case.judicialAct', wide: true, placeholder: 'Решением Арбитражного суда города Москвы от 12.03.2025 по делу № А40-000000/2025' })}
          ${field({ label: 'Размер требований кредиторов, ₽', bind: 'case.creditorsSum', money: true })}
        </div>
      </div>

      <div class="card">
        <h3>Должник</h3>
        <p class="m">Реквизиты должника подставляются в шапку, описание сделки и требования.</p>
        ${partyForm(debtor, 'case.', debtorIndex(c))}
      </div>

      <div class="card">
        <h3>Арбитражный управляющий</h3>
        <p class="m">Пустые поля берутся из профиля — заполнять по каждому делу не нужно.</p>
        <div class="form">
          ${field({ label: 'ФИО', bind: 'case.managerName', placeholder: db.profile.name || 'Иванов Иван Иванович' })}
          ${field({ label: 'СРО', bind: 'case.managerSro', placeholder: db.profile.sro || '' })}
          ${field({ label: 'Адрес для корреспонденции', bind: 'case.managerAddress', wide: true, placeholder: db.profile.address || '' })}
          ${field({ label: 'Контакты', bind: 'case.managerContacts', wide: true, placeholder: db.profile.contacts || 'тел. +7 000 000-00-00, e-mail: ...' })}
        </div>
      </div>`;
  }

  const debtorIndex = (c) => c.parties.findIndex((p) => p.id === c.debtorId);

  /** Форма стороны: набор полей зависит от того, кто это — организация, ИП или гражданин. */
  function partyForm(p, prefix, index) {
    if (!p) return '<p class="hint">Сторона не выбрана.</p>';
    const b = prefix === 'case.' ? `case.parties.${index}.` : 'party.';
    const head = `<div class="f wide"><label class="lb">Тип стороны</label>
      ${radios(b + 'kind', D.PARTY_KINDS, p.kind)}</div>`;

    let body;
    if (p.kind === 'org') {
      body = field({ label: 'Полное наименование', bind: b + 'nameFull', wide: true, required: true, placeholder: 'Общество с ограниченной ответственностью «Ромашка»' }) +
        field({ label: 'Сокращённое наименование', bind: b + 'nameShort', placeholder: 'ООО «Ромашка»' }) +
        field({ label: 'ИНН', bind: b + 'inn' }) +
        field({ label: 'ОГРН', bind: b + 'ogrn' }) +
        field({ label: 'Юридический адрес', bind: b + 'addressLegal', wide: true }) +
        field({ label: 'Почтовый адрес', bind: b + 'addressPostal', wide: true }) +
        field({ label: 'Руководитель', bind: b + 'director' }) +
        field({ label: 'Представитель', bind: b + 'representative' }) +
        field({ label: 'Основание полномочий', bind: b + 'powerBasis', placeholder: 'Устав, доверенность от ...' });
    } else if (p.kind === 'ip') {
      body = field({ label: 'ФИО', bind: b + 'fio', wide: true, required: true }) +
        field({ label: 'ИНН', bind: b + 'inn' }) +
        field({ label: 'ОГРНИП', bind: b + 'ogrnip' }) +
        field({ label: 'Адрес', bind: b + 'address', wide: true });
    } else {
      body = field({ label: 'ФИО', bind: b + 'fio', wide: true, required: true }) +
        field({ label: 'Дата рождения', bind: b + 'birthDate', type: 'date' }) +
        field({ label: 'ИНН', bind: b + 'inn' }) +
        field({ label: 'Адрес', bind: b + 'address', wide: true });
    }
    return `<div class="form">${head}${body}</div>`;
  }

  function casePartiesTab(c) {
    const rows = c.parties.map((p) => {
      const isDebtor = p.id === c.debtorId;
      const used = c.deals.filter((d) => d.counterpartyId === p.id).length;
      return `<div class="party">
        <div style="min-width:0">
          <div class="nm">${esc(S.partyName(p) || 'Без наименования')}</div>
          <div class="rq">${esc(D.nameOf(D.PARTY_KINDS, p.kind))}${S.partyRequisites(p) ? ' · ' + esc(S.partyRequisites(p)) : ''}${used ? ' · в сделках: ' + used : ''}</div>
        </div>
        ${isDebtor ? '<span class="tag">Должник</span>' : ''}
        <div class="sp">
          <button class="btn btn-sm" data-act="edit-party" data-id="${p.id}">Изменить</button>
          ${isDebtor ? '' : `<button class="btn btn-sm danger" data-act="del-party" data-id="${p.id}">Удалить</button>`}
        </div>
      </div>`;
    }).join('');

    return `<div class="card">
      <h3>Участники дела</h3>
      <p class="m">Сторону сделки достаточно завести один раз — дальше она выбирается из списка,
        а реквизиты подставляются сами.</p>
      ${rows || '<p class="hint">Кроме должника сторон пока нет.</p>'}
      <div style="margin-top:12px"><button class="btn" data-act="new-party">+ Добавить сторону</button></div>
    </div>`;
  }

  function caseDealsTab(c) {
    if (!c.deals.length) {
      return `<div class="empty"><b>Сделок пока нет</b>
        Добавьте сделку — приложение спросит только то, что нужно для заявления.
        <div style="margin-top:16px"><button class="btn pri" data-act="new-deal">+ Добавить сделку</button></div></div>`;
    }
    const rows = c.deals.map((d) => {
      const ready = d.statement.status === 'ready';
      return `<tr class="click" data-go="#/deal/${c.id}/${d.id}">
        <td data-l="Контрагент"><b>${esc(S.partyShort(S.counterpartyOf(c, d)) || '— не выбран —')}</b></td>
        <td data-l="Тип">${esc(S.dealTypeName(d))}</td>
        <td data-l="Дата">${esc(D.dateShort(d.date) || '—')}</td>
        <td class="r" data-l="Сумма">${esc(money0(d.amount))}</td>
        <td class="sub" data-l="Документов">${(d.documents || []).length}</td>
        <td data-l="Статус"><span class="pill ${ready ? 'ready' : 'draft'}">${ready ? 'Готово' : 'Черновик'}</span></td>
      </tr>`;
    }).join('');

    return `<div class="card">
      <table><thead><tr><th>Контрагент</th><th>Тип</th><th>Дата</th><th class="r">Сумма, ₽</th>
        <th>Документов</th><th>Статус</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="margin-top:14px"><button class="btn" data-act="new-deal">+ Добавить сделку</button></div>
    </div>`;
  }

  /* ================= экран сделки ================= */

  function screenDeal() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return notFound();
    const cp = S.counterpartyOf(c, d);
    const debtor = S.debtorOf(c);
    const v = S.validate(db, c, d);
    const ready = d.statement.status === 'ready';
    const docs = (d.documents || []).length;

    const head = `<div class="crumbs"><a href="#/">Мои дела</a><span>›</span>
        <a href="#/case/${c.id}">${esc(c.number || 'дело')}</a><span>›</span><span>сделка</span></div>
      <div class="bento anim">
        <div class="t hero s8">
          <div class="k">${esc(S.dealTypeName(d))}${d.number ? ' № ' + esc(d.number) : ''}</div>
          <div class="big">${esc(money0(d.amount))}<small> ₽</small></div>
          <p class="said">${esc(S.partyShort(debtor) || 'должник')} → <b>${esc(S.partyShort(cp) || 'контрагент не выбран')}</b></p>
          <div class="strip">
            <div><b>${esc(D.dateShort(d.date) || '—')}</b>дата сделки</div>
            <div><b>${esc(D.nameOf(D.OBJECT_TYPES, d.object.kind))}</b>объект</div>
            <div><b>${docs}</b>${D.plural(docs, 'документ', 'документа', 'документов')}</div>
            <div><b>${esc(D.nameOf(D.COUNTER, d.counter.state))}</b>встречное исполнение</div>
          </div>
          <div class="act">
            <button class="btn pri" data-go="#/builder/${c.id}/${d.id}">Открыть конструктор</button>
            <button class="btn" data-act="clone-deal">Создать на основе этой</button>
          </div>
        </div>

        <div class="t s4">
          <div class="k">Заявление</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="pill ${ready ? 'ready' : 'draft'}">${ready ? 'Готово' : 'Черновик'}</span>
            ${v.errors.length
        ? `<span class="chipm w"><span class="dot"></span>не заполнено: ${v.errors.length}</span>`
        : '<span class="chipm"><span class="dot"></span>обязательные поля заполнены</span>'}
          </div>
          <p class="m">${d.statement.versions.length
        ? 'Сохранённых версий: ' + d.statement.versions.length
        : 'Версии пока не сохранялись.'}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px">
            <button class="btn btn-sm" data-act="preview-sheets">Предпросмотр</button>
            <button class="btn btn-sm" data-act="export-docx">Скачать DOCX</button>
            <button class="btn btn-sm danger" data-act="del-deal">Удалить</button>
          </div>
        </div>
      </div>

      <div class="tabs">
        ${tab('deal', 'main', 'Основные сведения')}
        ${tab('deal', 'parties', 'Стороны')}
        ${tab('deal', 'object', 'Объект')}
        ${tab('deal', 'perf', 'Исполнение')}
        ${tab('deal', 'circ', 'Обстоятельства')}
        ${tab('deal', 'docs', 'Документы', docs)}
      </div>`;

    const body = tabs.deal === 'parties' ? dealPartiesTab(c, d)
      : tabs.deal === 'object' ? dealObjectTab(d)
        : tabs.deal === 'perf' ? dealPerfTab(d)
          : tabs.deal === 'circ' ? dealCircTab(d)
            : tabs.deal === 'docs' ? dealDocsTab(d)
              : dealMainTab(d);

    return head + body;
  }

  function dealMainTab(d) {
    return `<div class="card">
      <h3>Основные сведения</h3>
      <p class="m">Тип сделки определяет формулировки в заявлении. Остальные поля появятся по ходу.</p>
      <div class="form">
        ${field({ label: 'Тип сделки', bind: 'deal.type', type: 'select', options: D.DEAL_TYPES, required: true })}
        ${d.type === 'other' ? field({ label: 'Наименование сделки', bind: 'deal.typeOther', placeholder: 'соглашение о ...' }) : ''}
        ${field({ label: 'Дата сделки', bind: 'deal.date', type: 'date', required: true })}
        ${field({ label: 'Номер договора', bind: 'deal.number' })}
        ${field({ label: 'Дата договора', bind: 'deal.contractDate', type: 'date', hint: 'Если отличается от даты сделки' })}
        ${field({ label: 'Сумма сделки', bind: 'deal.amount', money: true, required: true })}
        ${field({ label: 'Валюта', bind: 'deal.currency', type: 'select', options: D.CURRENCIES })}
        ${field({ label: 'Предмет сделки', bind: 'deal.subject', type: 'textarea', wide: true, rows: 2, placeholder: 'Если не заполнено — соберётся из сведений об объекте' })}
      </div>
    </div>`;
  }

  function dealPartiesTab(c, d) {
    const options = [{ id: '', name: '— выберите сторону —' }]
      .concat(c.parties.filter((p) => p.id !== c.debtorId)
        .map((p) => ({ id: p.id, name: S.partyName(p) || 'без наименования' })));
    const cp = S.counterpartyOf(c, d);
    const debtor = S.debtorOf(c);

    return `<div class="card">
      <h3>Стороны сделки</h3>
      <p class="m">Должник подставляется из дела. Контрагент выбирается из участников — повторно
        вводить реквизиты не нужно.</p>
      <div class="party">
        <div style="min-width:0">
          <div class="nm">${esc(S.partyName(debtor) || 'Должник не заполнен')}</div>
          <div class="rq">${esc(S.partyRequisites(debtor))}</div>
        </div>
        <span class="tag">Должник</span>
        <div class="sp"><button class="btn btn-sm" data-act="edit-party" data-id="${debtor ? debtor.id : ''}">Изменить</button></div>
      </div>
      <div class="form" style="margin-top:14px">
        ${field({ label: 'Контрагент (ответчик)', bind: 'deal.counterpartyId', type: 'select', options: options, required: true, wide: true })}
      </div>
      ${cp ? `<div class="party" style="margin-top:10px">
          <div style="min-width:0">
            <div class="nm">${esc(S.partyName(cp))}</div>
            <div class="rq">${esc(D.nameOf(D.PARTY_KINDS, cp.kind))}${S.partyRequisites(cp) ? ' · ' + esc(S.partyRequisites(cp)) : ''}${S.partyAddress(cp) ? ' · ' + esc(S.partyAddress(cp)) : ''}</div>
          </div>
          <div class="sp"><button class="btn btn-sm" data-act="edit-party" data-id="${cp.id}">Изменить</button></div>
        </div>` : ''}
      <div style="margin-top:12px"><button class="btn" data-act="new-party">+ Новая сторона</button></div>
    </div>`;
  }

  /** Динамическая форма объекта (§3): показываем только то, что относится к выбранному типу. */
  function dealObjectTab(d) {
    const o = d.object;
    let body;
    if (o.kind === 'realty') {
      body = field({ label: 'Вид объекта', bind: 'deal.object.realtyKind', list: 'realty-kinds', placeholder: 'Квартира' }) +
        field({ label: 'Кадастровый номер', bind: 'deal.object.cadastral' }) +
        field({ label: 'Адрес', bind: 'deal.object.address', wide: true }) +
        field({ label: 'Площадь, кв. м', bind: 'deal.object.area' }) +
        field({ label: 'Назначение', bind: 'deal.object.purpose' }) +
        field({ label: 'Иные характеристики', bind: 'deal.object.features', type: 'textarea', wide: true, rows: 2 });
    } else if (o.kind === 'vehicle') {
      body = field({ label: 'Марка', bind: 'deal.object.brand' }) +
        field({ label: 'Модель', bind: 'deal.object.model' }) +
        field({ label: 'VIN', bind: 'deal.object.vin' }) +
        field({ label: 'Государственный номер', bind: 'deal.object.plate' }) +
        field({ label: 'Год выпуска', bind: 'deal.object.year' });
    } else if (o.kind === 'money') {
      body = field({ label: 'Сумма платежа, ₽', bind: 'deal.object.sum', money: true }) +
        field({ label: 'Дата платежа', bind: 'deal.object.payDate', type: 'date' }) +
        field({ label: 'Номер платёжного поручения', bind: 'deal.object.orderNumber' }) +
        field({ label: 'Счёт отправителя', bind: 'deal.object.accountFrom' }) +
        field({ label: 'Счёт получателя', bind: 'deal.object.accountTo' }) +
        field({ label: 'Назначение платежа', bind: 'deal.object.purposeText', type: 'textarea', wide: true, rows: 2 });
    } else {
      body = field({ label: 'Описание объекта', bind: 'deal.object.description', type: 'textarea', wide: true, rows: 4 });
    }

    return `<div class="card">
      <h3>Объект сделки</h3>
      <p class="m">Что именно выбыло из имущества должника.</p>
      <div class="form"><div class="f wide"><label class="lb">Тип объекта</label>
        ${radios('deal.object.kind', D.OBJECT_TYPES, o.kind)}</div></div>
      <div class="form step" style="margin-top:14px">
        ${body}
        ${field({ label: 'Стоимость объекта, ₽', bind: 'deal.object.value', money: true, hint: 'Если не указана — берётся сумма сделки' })}
      </div>
      ${dataList('realty-kinds', D.REALTY_KINDS)}
      <div class="note calm" style="margin:14px 0 0">Так объект попадёт в заявление:
        <b>${esc(S.objectDescription(d) || '— пока пусто —')}</b></div>
    </div>`;
  }

  function dealPerfTab(d) {
    const st = d.counter.state;
    let counterFields;
    if (st === 'partial') {
      counterFields = `<div class="form step" style="margin-top:12px">
        ${field({ label: 'Стоимость исполнения должника, ₽', bind: 'deal.counter.debtorValue', money: true })}
        ${field({ label: 'Стоимость встречного исполнения, ₽', bind: 'deal.counter.counterValue', money: true })}
        ${field({ label: 'Размер неисполнения, ₽', value: D.money(S.gapValue(d)) || '—', readonly: true })}
        ${field({ label: 'Описание обстоятельств', bind: 'deal.counter.note', type: 'textarea', wide: true, rows: 3 })}
      </div>`;
    } else if (st === 'none') {
      counterFields = `<div class="form step" style="margin-top:12px">
        ${field({ label: 'Причины отсутствия исполнения', bind: 'deal.counter.reasons', type: 'textarea', wide: true, rows: 3 })}
        ${field({ label: 'Дополнительные обстоятельства', bind: 'deal.counter.note', type: 'textarea', wide: true, rows: 3 })}
      </div>`;
    } else {
      counterFields = `<div class="form step" style="margin-top:12px">
        ${field({ label: 'Стоимость исполнения должника, ₽', bind: 'deal.counter.debtorValue', money: true })}
        ${field({ label: 'Стоимость встречного исполнения, ₽', bind: 'deal.counter.counterValue', money: true })}
        ${field({ label: 'Комментарий', bind: 'deal.counter.note', type: 'textarea', wide: true, rows: 2 })}
      </div>`;
    }

    return `<div class="card">
      <h3>Исполнение сделки</h3>
      <div class="form"><div class="f wide"><label class="lb">Как исполнена сделка</label>
        ${radios('deal.performance.state', D.PERFORMANCE, d.performance.state)}</div></div>
      <div class="form" style="margin-top:12px">
        ${field({ label: 'Дата исполнения', bind: 'deal.performance.date', type: 'date' })}
        ${field({ label: 'Способ исполнения', bind: 'deal.performance.method', placeholder: 'передача по акту, перечисление на счёт' })}
      </div>
    </div>

    <div class="card">
      <h3>Встречное исполнение</h3>
      <p class="m">Было ли встречное исполнение со стороны контрагента?</p>
      ${radios('deal.counter.state', D.COUNTER, d.counter.state)}
      ${counterFields}
    </div>`;
  }

  /** Вопросы, от ответов на которые зависит состав заявления (§8, §9). */
  function dealCircTab(d) {
    const f = d.flags;
    const q = (bind, value, title, extra) => `<div class="card">
      <h3>${esc(title)}</h3>
      <div style="margin-top:10px">${yesNo(bind, value)}</div>
      ${value ? `<div class="step" style="margin-top:14px">${extra}</div>` : ''}
    </div>`;

    return q('deal.flags.unequal', f.unequal, 'Есть ли признаки неравноценного встречного исполнения?',
      `<div class="note calm" style="margin:0">Стоимости берутся из вкладки «Исполнение»: должник —
        ${esc(D.money(d.counter.debtorValue) || '—')} ₽, встречное — ${esc(D.money(d.counter.counterValue) || '—')} ₽,
        разница — <b>${esc(D.money(S.gapValue(d)) || '—')} ₽</b>.</div>`) +

      q('deal.flags.harm', f.harm, 'Причинён ли вред имущественным правам кредиторов?',
        `<div class="form">${field({ label: 'В чём выразился вред', bind: 'deal.harmNote', type: 'textarea', wide: true, rows: 3, placeholder: 'Имущество выбыло безвозмездно, требования кредиторов остались непогашенными…' })}</div>`) +

      q('deal.flags.affiliation', f.affiliation, 'Есть ли заинтересованность сторон?',
        `<label class="lb">Основание заинтересованности</label>
         ${checkList('deal.affiliationGrounds', D.AFFILIATION_GROUNDS, d.affiliationGrounds)}
         <div class="form" style="margin-top:10px">${field({ label: 'Пояснения', bind: 'deal.affiliationNote', type: 'textarea', wide: true, rows: 2 })}</div>`) +

      q('deal.flags.preference', f.preference, 'Оказано ли предпочтение отдельному кредитору?',
        `<label class="lb">Основание предпочтения</label>
         ${checkList('deal.preferenceGrounds', D.PREFERENCE_GROUNDS, d.preferenceGrounds)}
         <div class="form" style="margin-top:10px">${field({ label: 'Пояснения', bind: 'deal.preferenceNote', type: 'textarea', wide: true, rows: 2 })}</div>`) +

      q('deal.flags.awareness', f.awareness, 'Знал ли контрагент о признаках неплатёжеспособности?',
        `<div class="form">${field({ label: 'Чем подтверждается', bind: 'deal.awarenessNote', type: 'textarea', wide: true, rows: 3 })}</div>`) +

      `<div class="card">
        <h3>Дополнительные обстоятельства</h3>
        <p class="m">Свободный текст, который войдёт в блок «Обстоятельства заключения сделки».</p>
        <div class="form">${field({ label: '', bind: 'deal.circumstances', type: 'textarea', wide: true, rows: 4 })}</div>
      </div>
      <div class="note calm">Ответы «Да» включают соответствующие блоки заявления, «Нет» — выключают.
        В конструкторе состав блоков можно поправить вручную.</div>`;
  }

  function dealDocsTab(d) {
    const docs = d.documents || [];
    const rows = docs.map((doc) => `<tr>
      <td data-l="№">${doc.attach !== false ? attachNo(d, doc) : '—'}</td>
      <td data-l="Документ"><b>${esc(doc.name || D.nameOf(D.DOC_TYPES, doc.type))}</b>
        ${doc.description ? `<div class="sub">${esc(doc.description)}</div>` : ''}</td>
      <td data-l="Тип">${esc(D.nameOf(D.DOC_TYPES, doc.type))}</td>
      <td data-l="Номер">${esc(doc.number || '—')}</td>
      <td data-l="Дата">${esc(D.dateShort(doc.date) || '—')}</td>
      <td data-l="В приложения"><label class="chk" style="padding:0"><input type="checkbox" data-act="toggle-attach"
        data-id="${doc.id}" ${doc.attach !== false ? 'checked' : ''}><span>включён</span></label></td>
      <td><div class="rowact">
        <button class="btn btn-sm" data-act="edit-doc" data-id="${doc.id}">Изменить</button>
        <button class="btn btn-sm danger" data-act="del-doc" data-id="${doc.id}">Удалить</button>
      </div></td>
    </tr>`).join('');

    const list = S.attachments(d);
    return `<div class="card">
      <h3>Документы по сделке</h3>
      <p class="m">Отмеченные документы попадают в раздел «Приложения». Нумерация пересчитывается
        автоматически при любом изменении списка.</p>
      ${docs.length ? `<table><thead><tr><th>№</th><th>Документ</th><th>Тип</th><th>Номер</th><th>Дата</th>
        <th>В приложения</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="hint">Документов пока нет.</p>'}
      <div style="margin-top:14px"><button class="btn" data-act="new-doc">+ Добавить документ</button></div>
    </div>
    ${list.length ? `<div class="card"><h3>Приложения к заявлению</h3>
      <ol style="margin:10px 0 0;padding-left:22px;font-size:13.5px;color:var(--ink-2);line-height:1.7">
      ${list.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
    <div class="note calm">Файлы не загружаются в браузер: приложение хранит только реквизиты документа.
      Так персональные данные не оседают в хранилище, а список приложений всё равно собирается сам.</div>`;
  }

  /** Номер документа в списке приложений — считается по тем, что отмечены. */
  function attachNo(deal, doc) {
    return (deal.documents || []).filter((x) => x.attach !== false).indexOf(doc) + 1;
  }

  /* ================= конструктор ================= */

  function screenBuilder() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return notFound();

    const blocks = S.statementBlocks(db, c, d);
    const on = blocks.filter((b) => b.enabled).length;
    const versions = d.statement.versions.length;

    return `<div class="crumbs"><a href="#/">Мои дела</a><span>›</span>
        <a href="#/case/${c.id}">${esc(c.number || 'дело')}</a><span>›</span>
        <a href="#/deal/${c.id}/${d.id}">сделка</a><span>›</span><span>конструктор</span></div>

      <div class="bento anim">
        <div class="t hero s8">
          <div class="k">Конструктор заявления</div>
          <h2>${esc(S.dealTypeName(d))}${d.number ? ' № ' + esc(d.number) : ''}</h2>
          <p class="said">${esc(S.partyShort(S.debtorOf(c)) || 'должник')} →
            <b>${esc(S.partyShort(S.counterpartyOf(c, d)) || 'контрагент не выбран')}</b>${d.amount !== '' ? ' · ' + esc(money0(d.amount)) + ' ₽' : ''}</p>
          <div class="act">
            <button class="btn pri" data-act="export-docx">Скачать DOCX</button>
            <button class="btn" data-act="preview-sheets">Листы и печать</button>
          </div>
        </div>

        <div class="t s4">
          <div class="k">Версии заявления</div>
          <div class="v">${versions}</div>
          <p class="m">Снимок состава блоков и текста: можно вернуться к предыдущей и сравнить построчно.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px">
            <button class="btn btn-sm" data-act="save-version">Сохранить версию</button>
            ${versions ? '<button class="btn btn-sm" data-act="versions">Все версии</button>' : ''}
          </div>
        </div>
      </div>

      <div class="builder" style="padding-top:12px">
        <div class="left">
          <div class="blocks">
            <div class="bh"><h3>Блоки заявления</h3>
              <span class="m">включено ${on} из ${blocks.length}</span></div>
            ${blocks.map(blockRow).join('')}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-sm" data-act="reset-blocks">Собрать заново по ответам</button>
            <button class="btn btn-sm" data-go="#/blocks">Библиотека блоков</button>
          </div>
          <div class="check" id="check">${checkPanel(c, d)}</div>
        </div>

        <div class="right">
          <div class="preview">
            <div class="ph"><h3>Предпросмотр</h3>
              <span class="m">обновляется на каждое изменение</span></div>
            <div class="paper" id="paper">${previewHtml(c, d)}</div>
          </div>
        </div>
      </div>`;
  }

  function blockRow(b) {
    const open = openBlocks.has(b.id);
    const flags = [
      b.required ? '<span class="flag">обязательный</span>' : '',
      b.condition ? `<span class="flag cond">${b.available ? 'условие выполнено' : 'условие не выполнено'}</span>` : '',
      b.overridden ? '<span class="flag edit">изменён</span>' : '',
      b.custom ? '<span class="flag">свой</span>' : ''
    ].filter(Boolean).join('');

    return `<div class="blk${b.enabled ? '' : ' off'}" data-block="${b.id}" draggable="${open ? 'false' : 'true'}">
      <div class="row">
        <span class="grip" title="Перетащите, чтобы изменить порядок">⠿</span>
        <input type="checkbox" data-act="toggle-block" data-id="${b.id}"${b.enabled ? ' checked' : ''}>
        <span class="nm" data-act="open-block" data-id="${b.id}">
          <b>${esc(b.name)}</b><span>${esc(b.description)}</span></span>
        ${flags}
      </div>
      ${open ? `<div class="body">
        <label class="lb">Текст блока</label>
        <textarea data-blocktext="${b.id}" rows="9">${esc(b.template)}</textarea>
        <div class="tools">
          <button class="btn btn-sm" data-act="insert-var" data-id="${b.id}">Вставить переменную</button>
          ${b.overridden ? `<button class="btn btn-sm" data-act="reset-block" data-id="${b.id}">Вернуть текст из библиотеки</button>` : ''}
          <span class="m">Правка действует только в этом заявлении.</span>
        </div>
      </div>` : ''}
    </div>`;
  }

  /** Предпросмотр: незаполненные переменные подсвечены — сразу видно, чего не хватает. */
  function previewHtml(c, d) {
    const paras = S.buildDocument(db, c, d, { mark: true });
    if (!paras.length) return '<p class="left" style="color:#8A867F">Не включён ни один блок.</p>';
    return paras.map((p) => {
      const text = esc(p.text)
        .split(S.MISS_A).join('<span class="miss">')
        .split(S.MISS_B).join('</span>');
      return `<p class="${p.align}${p.bold ? ' b' : ''}">${text || '&nbsp;'}</p>`;
    }).join('');
  }

  function checkPanel(c, d) {
    const v = S.validate(db, c, d);
    let html = '';
    if (v.errors.length) {
      html += '<div class="note warn"><h4>Нельзя сформировать заявление</h4><ul>' +
        v.errors.map((e) => `<li>Не заполнено: ${esc(e.field)}</li>`).join('') + '</ul></div>';
    }
    if (v.warnings.length) {
      html += '<div class="note calm"><h4>Проверьте</h4><ul>' +
        v.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul></div>';
    }
    if (v.missingVars.length) {
      html += '<div class="note calm"><h4>Переменные без значения</h4><ul><li>' +
        v.missingVars.map((n) => esc(D.VAR_INDEX.has(n) ? D.VAR_INDEX.get(n).label : n)).join(', ') +
        '</li></ul></div>';
    }
    if (!html) html = '<div class="note good"><b>Всё заполнено</b> — заявление можно выгружать.</div>';
    return html;
  }

  function refreshBuilder() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return;
    const paper = $('#paper');
    if (paper) paper.innerHTML = previewHtml(c, d);
    const check = $('#check');
    if (check) check.innerHTML = checkPanel(c, d);
  }

  /* ================= библиотека блоков ================= */

  function screenBlocks() {
    const lib = S.library(db);
    const own = lib.filter((b) => b.custom).length;
    const rows = lib.map((b) => `<div class="party">
      <div style="min-width:0">
        <div class="nm">${esc(b.name)}</div>
        <div class="rq">${esc(b.group || '')}${b.condition ? ' · условие: ' + esc(b.condition) : ''}${b.edited ? ' · изменён' : ''}${b.custom ? ' · свой блок' : ''}</div>
      </div>
      <div class="sp">
        <button class="btn btn-sm" data-act="edit-lib" data-id="${b.id}">Изменить</button>
        ${b.custom ? `<button class="btn btn-sm danger" data-act="del-lib" data-id="${b.id}">Удалить</button>`
        : (b.edited ? `<button class="btn btn-sm" data-act="reset-lib" data-id="${b.id}">Вернуть исходный</button>` : '')}
      </div>
    </div>`).join('');

    return `<div class="crumbs"><a href="#/">Мои дела</a><span>›</span><span>библиотека блоков</span></div>
      <div class="bento anim">
        <div class="t hero s8">
          <div class="k">Библиотека блоков</div>
          <div class="big">${lib.length}<small> ${D.plural(lib.length, 'блок', 'блока', 'блоков')}</small></div>
          <p class="said">Тексты хранятся отдельно от программы: чтобы поменять формулировку,
            править код не нужно.</p>
          <div class="act"><button class="btn pri" data-act="new-lib">+ Новый блок</button></div>
        </div>
        <div class="t s4">
          <div class="k">Свои блоки</div>
          <div class="v">${own}</div>
          <p class="m">Изменения применяются ко всем новым заявлениям. Уже собранные заявления,
            в которых текст блока правился вручную, остаются как есть.</p>
        </div>
      </div>
      <div class="card" style="margin-top:12px">${rows}</div>`;
  }

  /* ================= модальные окна ================= */

  let closeModal = () => { };

  function openModal(html, onMount) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal"><div class="box">${html}</div></div>`;
    const box = $('.modal', root);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    function close() { root.innerHTML = ''; closeModal = () => { }; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    closeModal = close;
    if (onMount) onMount(root, close);
    return close;
  }

  const note = (text) => openModal(`<h3>Сообщение</h3><p class="lead">${esc(text)}</p>
    <div class="foot"><button class="btn pri" data-act="modal-close">Понятно</button></div>`);

  function confirmBox(text, onYes) {
    openModal(`<h3>Подтвердите</h3><p class="lead">${esc(text)}</p>
      <div class="foot"><button class="btn" data-act="modal-close">Отмена</button>
      <button class="btn pri" id="confirm-yes">Да</button></div>`, (root, close) => {
      $('#confirm-yes', root).addEventListener('click', () => { close(); onYes(); });
    });
  }

  function partyModal(party, onDone) {
    editParty = party;
    openModal(`<h3>Сторона сделки</h3>
      <p class="lead">Реквизиты вводятся один раз и подставляются во все заявления по делу.</p>
      <div id="party-body">${partyForm(party, '', 0)}</div>
      <div class="foot"><button class="btn" data-act="modal-close">Отмена</button>
        <button class="btn pri" id="party-save">Сохранить</button></div>`, (root, close) => {
      // Тип стороны меняет набор полей — перерисовываем только тело окна.
      root.addEventListener('change', (e) => {
        const el = e.target.closest('[data-bind="party.kind"]');
        if (!el) return;
        editParty.kind = el.value;
        $('#party-body', root).innerHTML = partyForm(editParty, '', 0);
      });
      $('#party-save', root).addEventListener('click', () => {
        close();
        editParty = null;
        onDone();
      });
    });
  }

  function docModal(doc, onDone) {
    editDoc = doc;
    openModal(`<h3>Документ</h3>
      <p class="lead">Попадёт в список приложений с автоматическим номером.</p>
      <div class="form">
        ${field({ label: 'Тип', bind: 'doc.type', type: 'select', options: D.DOC_TYPES })}
        ${field({ label: 'Наименование', bind: 'doc.name', placeholder: 'Договор купли-продажи' })}
        ${field({ label: 'Номер', bind: 'doc.number' })}
        ${field({ label: 'Дата', bind: 'doc.date', type: 'date' })}
        ${field({ label: 'Имя файла', bind: 'doc.file', placeholder: 'dogovor-15.pdf', hint: 'Только для вашей ориентировки — файл не загружается' })}
        ${field({ label: 'Примечание', bind: 'doc.description', type: 'textarea', wide: true, rows: 2 })}
      </div>
      <div class="foot"><button class="btn" data-act="modal-close">Отмена</button>
        <button class="btn pri" id="doc-save">Сохранить</button></div>`, (root, close) => {
      $('#doc-save', root).addEventListener('click', () => { close(); editDoc = null; onDone(); });
    });
  }

  function profileModal() {
    openModal(`<h3>Профиль</h3>
      <p class="lead">Подставляется в дела, где поля управляющего оставлены пустыми.</p>
      <div class="form">
        ${field({ label: 'ФИО арбитражного управляющего', bind: 'profile.name', wide: true })}
        ${field({ label: 'СРО', bind: 'profile.sro', wide: true })}
        ${field({ label: 'Адрес для корреспонденции', bind: 'profile.address', wide: true })}
        ${field({ label: 'Контакты', bind: 'profile.contacts', wide: true })}
      </div>
      <div class="foot"><button class="btn pri" data-act="modal-close">Готово</button></div>`);
  }

  function backupModal() {
    openModal(`<h3>Резервная копия</h3>
      <p class="lead">Все дела хранятся только в этом браузере. Выгрузите файл, чтобы перенести их
        на другой компьютер или сохранить перед чисткой кэша.</p>
      <div class="foot">
        <button class="btn left" id="backup-import">Загрузить из файла</button>
        <button class="btn" data-act="modal-close">Закрыть</button>
        <button class="btn pri" id="backup-export">Выгрузить всё</button>
      </div>
      <input type="file" id="backup-file" accept="application/json,.json" hidden>`, (root, close) => {
      $('#backup-export', root).addEventListener('click', () => {
        const bytes = new TextEncoder().encode(JSON.stringify(db, null, 2));
        X.download(bytes, 'Заявления — резервная копия.json', 'application/json');
      });
      $('#backup-import', root).addEventListener('click', () => $('#backup-file', root).click());
      $('#backup-file', root).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (!data || !Array.isArray(data.cases)) throw new Error('это не резервная копия конструктора');
          db = S.migrate(data);
          saveNow();
          close();
          go('#/');
          render();
        } catch (err) {
          close();
          note('Не удалось прочитать файл: ' + (err && err.message ? err.message : err));
        }
      });
    });
  }

  /** Пикер переменных (§24): вставляет {{ИМЯ}} в позицию каретки. */
  function varsModal(textarea) {
    openModal('<h3>Вставить переменную</h3><p class="lead">Значение подставится при сборке документа.</p>' +
      '<div class="vars">' + D.VARS.map((g) => `<div><h4>${esc(g.group)}</h4>` +
        g.items.map((it) => `<button data-var="${attr(it.name)}">${esc(it.label)}<code>{{${esc(it.name)}}}</code></button>`).join('') +
        '</div>').join('') + '</div>' +
      '<div class="foot"><button class="btn" data-act="modal-close">Закрыть</button></div>',
      (root, close) => {
        root.addEventListener('click', (e) => {
          const b = e.target.closest('[data-var]');
          if (!b) return;
          const token = '{{' + b.dataset.var + '}}';
          const at = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
          const end = textarea.selectionEnd == null ? at : textarea.selectionEnd;
          textarea.value = textarea.value.slice(0, at) + token + textarea.value.slice(end);
          textarea.selectionStart = textarea.selectionEnd = at + token.length;
          close();
          textarea.focus();
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
  }

  function sheetsModal() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return;
    const paras = S.buildDocument(db, c, d, { mark: false });
    if (!paras.length) return note('Не включён ни один блок — печатать нечего.');

    openModal(`<h3>Листы заявления</h3>
      <p class="lead">Так документ ляжет на бумагу и в PDF. Печать → «Сохранить как PDF».</p>
      <div class="sheets" id="sheets">${X.buildSheets(paras)}</div>
      <div class="foot">
        <span class="left m" id="sheet-count"></span>
        <button class="btn" data-act="modal-close">Закрыть</button>
        <button class="btn" id="sheet-docx">Скачать DOCX</button>
        <button class="btn pri" id="sheet-print">Печать в PDF</button>
      </div>`, (root, close) => {
      const n = $$('.sheet', root).length;
      $('#sheet-count', root).textContent = n + ' ' + D.plural(n, 'лист', 'листа', 'листов');
      fitSheets(root);
      $('#sheet-print', root).addEventListener('click', () => {
        document.body.classList.add('printmode');
        window.print();
        setTimeout(() => document.body.classList.remove('printmode'), 500);
      });
      $('#sheet-docx', root).addEventListener('click', exportDocx);
    });
  }

  /** Лист A4 шире телефона — ужимаем его под ширину окна, на печать это не влияет. */
  function fitSheets(root) {
    const box = $('#sheets', root);
    if (!box) return;
    const avail = box.clientWidth - 36;
    const z = avail > 0 ? Math.min(1, avail / (210 * X.MM)) : 1;
    box.style.setProperty('--zoom', z.toFixed(3));
    // При масштабе transform не сжимает занимаемую высоту — компенсируем вручную,
    // иначе под последним листом остаётся полоса пустоты.
    for (const s of $$('.sheet', box)) s.style.marginBottom = (z < 1 ? (z - 1) * 297 * X.MM + 14 : 14) + 'px';
  }

  function versionsModal() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return;
    const vs = [...d.statement.versions].reverse();

    const list = vs.length ? vs.map((v) => `<div class="v">
        <b>Версия ${v.no}</b>
        <span class="m">${esc(D.dateShort(v.createdAt.slice(0, 10)))} ${esc(v.createdAt.slice(11, 16))}
          ${v.note ? ' · ' + esc(v.note) : ''}</span>
        <button class="btn btn-sm" data-act="view-version" data-id="${v.id}">Посмотреть</button>
        <button class="btn btn-sm" data-act="restore-version" data-id="${v.id}">Восстановить</button>
      </div>`).join('')
      : '<p class="hint">Версий пока нет. Сохраните текущую — потом можно будет сравнить и вернуться.</p>';

    const options = vs.map((v) => `<option value="${v.id}">Версия ${v.no}</option>`).join('');

    openModal(`<h3>Версии заявления</h3>
      <p class="lead">Каждая версия — снимок состава блоков и собранного текста.</p>
      <div class="versions">${list}</div>
      ${vs.length ? `<div class="card" style="margin:14px 0 0;box-shadow:none">
        <h3>Сравнение</h3>
        <div class="form">
          <div class="f"><label class="lb">Версия A</label><select id="cmp-a">${options}</select></div>
          <div class="f"><label class="lb">Версия B</label><select id="cmp-b"><option value="current">Текущее состояние</option>${options}</select></div>
        </div>
        <div class="diff" id="diff" style="margin-top:12px"></div>
      </div>` : ''}
      <div class="foot"><button class="btn" data-act="modal-close">Закрыть</button>
        <button class="btn pri" id="ver-save">Сохранить текущую версию</button></div>`, (root, close) => {
      $('#ver-save', root).addEventListener('click', () => { close(); saveVersion(); });

      const a = $('#cmp-a', root), b = $('#cmp-b', root);
      if (a && b) {
        const textOf = (id) => id === 'current' ? S.documentText(db, c, d)
          : (d.statement.versions.find((v) => v.id === id) || { text: '' }).text;
        const draw = () => {
          $('#diff', root).innerHTML = S.diffLines(textOf(a.value), textOf(b.value))
            .map((l) => `<span class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same'}">` +
              esc((l.op === ' ' ? '  ' : l.op + ' ') + l.text) + '</span>').join('');
        };
        a.addEventListener('change', draw);
        b.addEventListener('change', draw);
        draw();
      }

      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const v = d.statement.versions.find((x) => x.id === btn.dataset.id);
        if (btn.dataset.act === 'view-version' && v) {
          close();
          openModal(`<h3>Версия ${v.no}</h3><div class="diff">${esc(v.text)}</div>
            <div class="foot"><button class="btn pri" data-act="modal-close">Закрыть</button></div>`);
        } else if (btn.dataset.act === 'restore-version' && v) {
          close();
          confirmBox('Восстановить версию ' + v.no + '? Текущий состав блоков будет заменён.', () => {
            S.restoreVersion(d, v.id);
            saveNow();
            render();
          });
        }
      });
    });
  }

  function libModal(block) {
    editBlock = block;
    const isNew = !block.id;
    openModal(`<h3>${isNew ? 'Новый блок' : 'Блок «' + esc(block.name) + '»'}</h3>
      <p class="lead">Условие показа записывается как <code>deal.unequal = true</code>. Доступны поля
        deal.unequal, deal.harm, deal.affiliation, deal.preference, deal.awareness, deal.objectType,
        deal.performance, deal.counter, deal.amount, deal.documents, case.procedure.</p>
      <div class="form">
        ${field({ label: 'Название блока', bind: 'block.name', wide: true, required: true })}
        ${field({ label: 'Описание', bind: 'block.description', wide: true })}
        ${field({ label: 'Раздел', bind: 'block.group' })}
        ${field({ label: 'Выравнивание', bind: 'block.align', type: 'select', options: [
          { id: 'justify', name: 'По ширине' }, { id: 'center', name: 'По центру' },
          { id: 'right', name: 'По правому краю' }, { id: 'left', name: 'По левому краю' }] })}
        ${field({ label: 'Условие показа', bind: 'block.condition', wide: true, placeholder: 'deal.unequal = true' })}
        <div class="f wide"><label class="lb">Текст шаблона</label>
          <textarea data-bind="block.template" rows="12" id="lib-template">${esc(block.template || '')}</textarea></div>
        <div class="f wide"><label class="chk"><input type="checkbox" data-bind="block.required"
          ${block.required ? 'checked' : ''}><span>Обязательный блок</span></label></div>
      </div>
      <div class="foot">
        <button class="btn left" id="lib-var">Вставить переменную</button>
        <button class="btn" data-act="modal-close">Отмена</button>
        <button class="btn pri" id="lib-save">Сохранить</button>
      </div>`, (root, close) => {
      $('#lib-var', root).addEventListener('click', () => {
        const ta = $('#lib-template', root);
        // Окно переменных заменит текущее — сначала запомним, куда вставлять.
        varsModalKeep(ta, block);
      });
      $('#lib-save', root).addEventListener('click', () => {
        if (!editBlock.name) { note('У блока должно быть название.'); return; }
        saveLibBlock(editBlock);
        editBlock = null;
        close();
        render();
      });
    });
  }

  /*
   * Пикер переменных поверх редактора блока: одно модальное окно на всё
   * приложение, поэтому редактор пересобирается после вставки — с уже
   * изменённым текстом.
   */
  function varsModalKeep(textarea, block) {
    block.template = textarea.value;
    const pos = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
    openModal('<h3>Вставить переменную</h3><p class="lead">Значение подставится при сборке документа.</p>' +
      '<div class="vars">' + D.VARS.map((g) => `<div><h4>${esc(g.group)}</h4>` +
        g.items.map((it) => `<button data-var="${attr(it.name)}">${esc(it.label)}<code>{{${esc(it.name)}}}</code></button>`).join('') +
        '</div>').join('') + '</div>' +
      '<div class="foot"><button class="btn" data-act="modal-close">Закрыть</button></div>',
      (root, close) => {
        root.addEventListener('click', (e) => {
          const b = e.target.closest('[data-var]');
          if (!b) return;
          const token = '{{' + b.dataset.var + '}}';
          block.template = block.template.slice(0, pos) + token + block.template.slice(pos);
          close();
          libModal(block);
        });
      });
  }

  function saveLibBlock(block) {
    if (block.custom || !D.BLOCKS.some((b) => b.id === block.id)) {
      block.custom = true;
      if (!block.id) block.id = 'own_' + S.uid();
      const at = db.customBlocks.findIndex((b) => b.id === block.id);
      if (at >= 0) db.customBlocks[at] = block; else db.customBlocks.push(block);
    } else {
      // Для стандартного блока правится только текст: остальное задано программой,
      // иначе обновление приложения молча потеряло бы чужие настройки.
      db.edits[block.id] = block.template;
    }
    saveNow();
  }

  /* ================= действия ================= */

  function newCase() {
    const c = S.newCase();
    c.managerName = db.profile.name;
    c.managerSro = db.profile.sro;
    c.managerAddress = db.profile.address;
    c.managerContacts = db.profile.contacts;
    db.cases.push(c);
    saveNow();
    go('#/case/' + c.id);
  }

  function newDeal() {
    const c = currentCase();
    if (!c) return;
    const d = S.newDeal();
    c.deals.push(d);
    saveNow();
    tabs.deal = 'main';
    go('#/deal/' + c.id + '/' + d.id);
  }

  function saveVersion() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return;
    const v = S.saveVersion(db, c, d, '');
    saveNow();
    render();
    note('Сохранена версия ' + v.no + '.');
  }

  function exportDocx() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d) return;
    const check = S.validate(db, c, d);
    const paras = S.buildDocument(db, c, d, { mark: false });
    if (!paras.length) return note('Не включён ни один блок — выгружать нечего.');

    const name = X.safeName('Заявление — ' + (c.number || 'дело') + ' — ' +
      (S.partyShort(S.counterpartyOf(c, d)) || 'контрагент'));
    const make = () => {
      X.download(X.docxBytes(paras, name), name + '.docx', X.DOCX_MIME);
      if (d.statement.status !== 'ready' && check.ok) { d.statement.status = 'ready'; saveNow(); }
    };

    if (check.errors.length) {
      confirmBox('Не заполнено обязательных полей: ' + check.errors.length +
        ' (' + check.errors.map((e) => e.field).join(', ') + '). Выгрузить с прочерками?', make);
    } else {
      make();
    }
  }

  /* ================= отрисовка ================= */

  function notFound() {
    return `<div class="empty"><b>Ничего не найдено</b>Возможно, запись была удалена.
      <div style="margin-top:16px"><button class="btn pri" data-go="#/">К списку дел</button></div></div>`;
  }

  function render() {
    const app = $('#app');
    app.innerHTML = route.name === 'case' ? screenCase()
      : route.name === 'deal' ? screenDeal()
        : route.name === 'builder' ? screenBuilder()
          : route.name === 'blocks' ? screenBlocks()
            : screenCases();
    if (route.name === 'builder') save();     // statementBlocks мог достроить состав
    document.title = titleFor() + ' — Конструктор заявлений';
    // Наверх — только при переходе на другой экран: перерисовка после ответа
    // на вопрос не должна утаскивать страницу от места, где человек читает.
    const key = [route.name, route.caseId, route.dealId].join('/');
    if (key !== lastScreen) { lastScreen = key; window.scrollTo(0, 0); }
  }

  let lastScreen = null;

  function titleFor() {
    const c = currentCase();
    if (route.name === 'builder') return 'Конструктор';
    if (route.name === 'blocks') return 'Библиотека блоков';
    if (c) return c.number || 'Дело';
    return 'Мои дела';
  }

  /* ================= события ================= */

  document.addEventListener('input', (e) => {
    const el = e.target;

    if (el.dataset.blocktext) {
      const d = currentDeal();
      if (!d) return;
      const ref = d.statement.blocks.find((b) => b.id === el.dataset.blocktext);
      if (ref) { ref.text = el.value; save(); refreshBuilder(); }
      return;
    }

    if (!el.dataset.bind || el.type === 'radio' || el.type === 'checkbox') return;
    setPath(el.dataset.bind, el.value);
    save();
    if (route.name === 'builder') refreshBuilder();
  });

  document.addEventListener('change', (e) => {
    const el = e.target;

    if (el.dataset.arr) {
      const r = resolve(el.dataset.arr);
      if (!r) return;
      const list = new Set(r.obj[r.key] || []);
      if (el.checked) list.add(el.value); else list.delete(el.value);
      r.obj[r.key] = [...list];
      saveNow();
      if (route.name === 'builder') refreshBuilder();
      return;
    }

    if (!el.dataset.bind) return;

    // Поля в модальном окне перерисовывает само окно: общий render()
    // трогает только основной экран.
    const inModal = !!(el.closest && el.closest('#modal-root'));

    if (el.type === 'radio') {
      if (!el.checked) return;
      const path = el.dataset.bind;
      // Ответы «Да / Нет» хранятся флагом, а не строкой.
      setPath(path, /^deal\.flags\./.test(path) ? el.value === 'yes' : el.value);
      if (/^deal\.flags\./.test(path)) syncConditionalBlocks();
      saveNow();
      if (!inModal) render();
      return;
    }

    if (el.type === 'checkbox') {
      setPath(el.dataset.bind, el.checked);
      saveNow();
      return;
    }

    if (el.dataset.kind === 'money') {
      el.value = normMoney(el.value);
      setPath(el.dataset.bind, el.value);
    } else {
      setPath(el.dataset.bind, el.value);
    }
    saveNow();

    // Селект может менять состав полей (тип сделки, тип стороны, контрагент).
    if (el.tagName === 'SELECT' && !inModal) render();
    else if (route.name === 'builder') refreshBuilder();
  });

  /**
   * Ответ на вопрос об обстоятельствах прямо управляет составом заявления (§8):
   * «Нет» — блок выключается, «Да» — включается. Ручную правку в конструкторе
   * это переопределит, о чём сказано подсказкой под вопросами.
   */
  function syncConditionalBlocks() {
    const c = currentCase(), d = currentDeal();
    if (!c || !d || !d.statement.blocks.length) return;
    for (const b of S.statementBlocks(db, c, d)) {
      if (b.condition) b.ref.enabled = b.available;
    }
  }

  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-go]');
    if (nav) { go(nav.dataset.go); return; }

    const tab = e.target.closest('[data-tab]');
    if (tab) {
      const [screen, id] = tab.dataset.tab.split(':');
      tabs[screen] = id;
      render();
      return;
    }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const c = currentCase(), d = currentDeal();

    switch (act) {
      case 'modal-close': closeModal(); break;
      case 'new-case': newCase(); break;
      case 'new-deal': newDeal(); break;

      case 'del-case':
        confirmBox('Удалить дело со всеми сделками и заявлениями?', () => {
          db.cases = db.cases.filter((x) => x.id !== c.id);
          saveNow(); go('#/');
        });
        break;

      case 'del-deal':
        confirmBox('Удалить сделку вместе с заявлением?', () => {
          c.deals = c.deals.filter((x) => x.id !== d.id);
          saveNow(); go('#/case/' + c.id);
        });
        break;

      case 'clone-deal': {
        const copy = S.cloneDeal(d);
        c.deals.push(copy);
        saveNow();
        go('#/deal/' + c.id + '/' + copy.id);
        break;
      }

      case 'new-party': {
        const p = S.newParty('org');
        partyModal(p, () => {
          c.parties.push(p);
          if (d && !d.counterpartyId) d.counterpartyId = p.id;
          saveNow(); render();
        });
        break;
      }

      case 'edit-party': {
        const p = S.findParty(c, id);
        if (p) partyModal(p, () => { saveNow(); render(); });
        break;
      }

      case 'del-party':
        confirmBox('Удалить сторону? В сделках, где она выбрана, контрагент станет пустым.', () => {
          c.parties = c.parties.filter((x) => x.id !== id);
          for (const deal of c.deals) if (deal.counterpartyId === id) deal.counterpartyId = '';
          saveNow(); render();
        });
        break;

      case 'new-doc': {
        const doc = S.newDocument();
        docModal(doc, () => { d.documents.push(doc); saveNow(); render(); });
        break;
      }

      case 'edit-doc': {
        const doc = d.documents.find((x) => x.id === id);
        if (doc) docModal(doc, () => { saveNow(); render(); });
        break;
      }

      case 'del-doc':
        d.documents = d.documents.filter((x) => x.id !== id);
        saveNow(); render();
        break;

      case 'toggle-attach': {
        const doc = d.documents.find((x) => x.id === id);
        if (doc) { doc.attach = btn.checked; saveNow(); render(); }
        break;
      }

      case 'toggle-block': {
        const ref = d.statement.blocks.find((b) => b.id === id);
        if (ref) {
          ref.enabled = btn.checked;
          btn.closest('.blk').classList.toggle('off', !ref.enabled);
          const counter = $('.blocks .bh .m');
          if (counter) {
            const on = d.statement.blocks.filter((b) => b.enabled).length;
            counter.textContent = 'включено ' + on + ' из ' + d.statement.blocks.length;
          }
          save(); refreshBuilder();
        }
        break;
      }

      case 'open-block':
        if (openBlocks.has(id)) openBlocks.delete(id); else openBlocks.add(id);
        render();
        break;

      case 'insert-var': {
        const ta = $(`[data-blocktext="${id}"]`);
        if (ta) varsModal(ta);
        break;
      }

      case 'reset-block': {
        const ref = d.statement.blocks.find((b) => b.id === id);
        if (ref) { ref.text = null; saveNow(); render(); }
        break;
      }

      case 'reset-blocks':
        confirmBox('Собрать состав блоков заново по ответам на вопросы? Ручные правки состава пропадут.', () => {
          d.statement.blocks = [];
          S.statementBlocks(db, c, d);
          saveNow(); render();
        });
        break;

      case 'save-version': saveVersion(); break;
      case 'versions': versionsModal(); break;
      case 'preview-sheets': sheetsModal(); break;
      case 'export-docx': exportDocx(); break;

      case 'new-lib':
        libModal({ id: '', name: '', description: '', group: 'Свои блоки', align: 'justify', condition: '', template: '', custom: true });
        break;

      case 'edit-lib': {
        const b = S.library(db).find((x) => x.id === id);
        if (b) libModal(JSON.parse(JSON.stringify(b)));
        break;
      }

      case 'reset-lib':
        delete db.edits[id];
        saveNow(); render();
        break;

      case 'del-lib':
        confirmBox('Удалить свой блок из библиотеки?', () => {
          db.customBlocks = db.customBlocks.filter((x) => x.id !== id);
          saveNow(); render();
        });
        break;
    }
  });

  /* ---------- перетаскивание блоков ---------- */

  let dragId = null;

  document.addEventListener('dragstart', (e) => {
    const blk = e.target.closest ? e.target.closest('.blk') : null;
    if (!blk) return;
    // Из раскрытого блока тянут текст, а не сам блок.
    if (e.target.closest('.body')) { e.preventDefault(); return; }
    dragId = blk.dataset.block;
    blk.classList.add('drag');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox не начнёт перетаскивание без данных в буфере.
    e.dataTransfer.setData('text/plain', dragId);
  });

  document.addEventListener('dragend', () => {
    dragId = null;
    for (const el of $$('.blk')) el.classList.remove('drag', 'over');
  });

  document.addEventListener('dragover', (e) => {
    const blk = e.target.closest ? e.target.closest('.blk') : null;
    if (!dragId || !blk || blk.dataset.block === dragId) return;
    e.preventDefault();
    for (const el of $$('.blk')) el.classList.toggle('over', el === blk);
  });

  document.addEventListener('drop', (e) => {
    const blk = e.target.closest ? e.target.closest('.blk') : null;
    const d = currentDeal();
    if (!dragId || !blk || !d) return;
    e.preventDefault();

    const list = d.statement.blocks;
    const from = list.findIndex((b) => b.id === dragId);
    const to = list.findIndex((b) => b.id === blk.dataset.block);
    if (from < 0 || to < 0 || from === to) return;

    list.splice(to, 0, list.splice(from, 1)[0]);
    list.forEach((b, i) => { b.order = i; });
    dragId = null;
    saveNow();
    render();
  });

  /* ---------- шапка и маршрут ---------- */

  $('#btn-profile').addEventListener('click', profileModal);
  $('#btn-backup').addEventListener('click', backupModal);
  $('#btn-blocks').addEventListener('click', () => go('#/blocks'));

  addEventListener('hashchange', () => { route = parseHash(); render(); });
  addEventListener('resize', () => { if ($('#sheets')) fitSheets(document); });
  addEventListener('beforeunload', saveNow);

  route = parseHash();
  render();
})();
