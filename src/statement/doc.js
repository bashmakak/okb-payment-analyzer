/*
 * Выгрузка готового заявления: DOCX и раскладка листов A4 для печати в PDF.
 *
 * DOCX собирается вручную, без библиотек. Формат .docx — это ZIP из
 * нескольких XML-файлов, и написать их оказывается дешевле, чем тащить
 * в офлайновую страницу мегабайт стороннего кода. Сжатие не используется:
 * заявление весит десятки килобайт, а «сохранение без сжатия» — легальный
 * режим ZIP, который Word открывает наравне с обычным.
 *
 * PDF получается печатью: листы раскладываются здесь по фактическим высотам
 * абзацев, поэтому в файле не появляется ни срезанного текста, ни пустот,
 * а нумерация страниц совпадает с тем, что видно в предпросмотре.
 */
(function () {
  'use strict';

  const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

  const enc = new TextEncoder();
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ================= ZIP ================= */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** Дата и время в формате MS-DOS — два 16-битных поля заголовка ZIP. */
  function dosStamp(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  /**
   * Собирает ZIP из [{name, data}] без сжатия (метод 0).
   * Имена частей .docx — только ASCII, поэтому флаг UTF-8 роли не играет,
   * но выставлен: так архив корректен и для внешних инструментов.
   */
  function zip(files) {
    const stamp = dosStamp(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);          // версия для распаковки
      lv.setUint16(6, 0x0800, true);      // имена в UTF-8
      lv.setUint16(8, 0, true);           // метод: без сжатия
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const all = parts.concat(central, [end]);
    const total = all.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  /* ================= DOCX ================= */

  // Размеры в твипах (1/20 пункта). Поля — по ГОСТ Р 7.0.97 для документов,
  // подаваемых в суд: слева 30 мм под подшивку, справа 15, сверху и снизу 20.
  const PAGE = { w: 11906, h: 16838, top: 1134, right: 850, bottom: 1134, left: 1701 };
  const INDENT = 709;          // абзацный отступ 1,25 см
  const LINE = 360;            // полуторный интервал

  const ALIGN = { justify: 'both', center: 'center', right: 'right', left: 'left' };

  function paragraphXml(p) {
    const jc = ALIGN[p.align] || 'both';
    // Красная строка нужна только в связном тексте: в шапке, заголовке
    // и подписи она разъезжается.
    const indent = jc === 'both' || jc === 'left' ? `<w:ind w:firstLine="${INDENT}"/>` : '';
    const pPr = `<w:pPr><w:spacing w:after="0" w:line="${LINE}" w:lineRule="auto"/>` +
      `<w:jc w:val="${jc}"/>${indent}</w:pPr>`;

    if (!p.text.trim()) return `<w:p>${pPr}</w:p>`;

    const rPr = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
    const runs = String(p.text).split('\t')
      .map((chunk, i) => (i ? '<w:r><w:tab/></w:r>' : '') +
        `<w:r>${rPr}<w:t xml:space="preserve">${esc(chunk)}</w:t></w:r>`)
      .join('');
    return `<w:p>${pPr}${runs}</w:p>`;
  }

  function documentXml(paras) {
    const body = paras.map(paragraphXml).join('');
    const sect = '<w:sectPr>' +
      '<w:footerReference w:type="default" r:id="rId2"/>' +
      `<w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/>` +
      `<w:pgMar w:top="${PAGE.top}" w:right="${PAGE.right}" w:bottom="${PAGE.bottom}" ` +
      `w:left="${PAGE.left}" w:header="708" w:footer="708" w:gutter="0"/>` +
      '</w:sectPr>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}"><w:body>${body}${sect}</w:body></w:document>`;
  }

  const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:styles xmlns:w="${NS_W}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>' +
    '<w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="ru-RU"/>' +
    '</w:rPr></w:rPrDefault>' +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${LINE}" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '</w:styles>';

  // Номер страницы в колонтитуле — поле PAGE: Word пересчитывает его сам,
  // и нумерация остаётся верной после любой правки текста.
  const FOOTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:t>1</w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    '</w:p></w:ftr>';

  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${NS_R}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>';

  const DOC_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${NS_R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_R}/footer" Target="footer1.xml"/>` +
    '</Relationships>';

  function coreXml(title) {
    const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(title)}</dc:title>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
      '</cp:coreProperties>';
  }

  const APP_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>Конструктор заявлений</Application></Properties>';

  /** Готовый .docx как Uint8Array. */
  function docxBytes(paras, title) {
    return zip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'docProps/core.xml', data: coreXml(title || 'Заявление') },
      { name: 'docProps/app.xml', data: APP_XML },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/document.xml', data: documentXml(paras) },
      { name: 'word/styles.xml', data: STYLES_XML },
      { name: 'word/footer1.xml', data: FOOTER_XML }
    ]);
  }

  /* ================= листы A4 для печати ================= */

  const MM = 3.7795275591;                     // px в мм при 96 dpi
  const SHEET = { w: 210, h: 297, top: 20, right: 15, bottom: 20, left: 30 };
  const CONTENT_H = SHEET.h - SHEET.top - SHEET.bottom;

  const paraHtml = (p, i) =>
    `<p class="dp ${p.align}${p.bold ? ' b' : ''}" data-i="${i}">${esc(p.text) || '&nbsp;'}</p>`;

  /**
   * Раскладка по листам. Высоты не прикидываются, а измеряются: абзацы
   * рендерятся в скрытом контейнере той же ширины, и только потом
   * распределяются по страницам. Иначе на длинных заявлениях накапливается
   * ошибка и последняя строка листа уезжает под обрез.
   */
  function buildSheets(paras, opts) {
    const doc = (opts && opts.document) || globalThis.document;
    const box = doc.createElement('div');
    box.className = 'docmeasure';
    box.style.width = (SHEET.w - SHEET.left - SHEET.right) + 'mm';
    box.innerHTML = paras.map(paraHtml).join('');
    doc.body.appendChild(box);

    const limit = CONTENT_H * MM;
    const nodes = [...box.children];
    const pages = [[]];
    let used = 0;

    for (let i = 0; i < nodes.length; i++) {
      const h = nodes[i].getBoundingClientRect().height;
      // Абзац выше листа не разрезать нечем — отдаём его странице целиком
      // и позволяем браузеру перенести хвост.
      if (used > 0 && used + h > limit) { pages.push([]); used = 0; }
      pages[pages.length - 1].push(i);
      used += h;
    }
    box.remove();

    const total = pages.length;
    return pages.map((idx, n) =>
      '<section class="sheet">' +
      '<div class="sheetbody">' + idx.map((i) => paraHtml(paras[i], i)).join('') + '</div>' +
      `<div class="sheetnum">${n + 1} из ${total}</div>` +
      '</section>').join('');
  }

  /* ================= сохранение файла ================= */

  function download(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** Имя файла без символов, запрещённых в Windows. */
  const safeName = (s) => String(s || 'Заявление').replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 90) || 'Заявление';

  globalThis.ZDoc = {
    zip, crc32, docxBytes, documentXml, buildSheets, download, safeName,
    SHEET, CONTENT_H, MM,
    DOCX_MIME: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
})();
