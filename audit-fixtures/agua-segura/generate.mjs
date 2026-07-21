// Generates synthetic evidence fixtures for the Uellix functional audit.
// Every artefact is stamped with the synthetic-data banner. Run: node generate.mjs
import { writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';

const BANNER = 'DATOS SINTETICOS - EXCLUSIVAMENTE PARA AUDITORIA FUNCIONAL DE UELLIX';
const BANNER_ACC = 'DATOS SINTÉTICOS — EXCLUSIVAMENTE PARA AUDITORÍA FUNCIONAL DE UELLIX';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = (n, buf) => { writeFileSync(here + n, buf); console.log('wrote', n, typeof buf === 'string' ? buf.length + ' chars' : buf.length + ' bytes'); };

// deterministic PRNG so re-runs produce identical files (hash stability matters for evidence)
let seed = 20260716;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ── CSV 1 — línea base ───────────────────────────────────────────────────────
{
  const rows = [`# ${BANNER_ACC}`, 'hogar_id,sector,personas,horas_semana_agua,gasto_mensual_cop,bienestar_pct,fecha_medicion'];
  for (let i = 1; i <= 120; i++) {
    rows.push([`HOG-${String(i).padStart(3, '0')}`, pick(['Norte', 'Sur', 'Centro', 'Playa']), int(2, 7),
      (3.8 + rnd() * 1.6).toFixed(1), int(88000, 102000), int(24, 41), '2025-01-15'].join(','));
  }
  out('linea-base.csv', rows.join('\n') + '\n');
}

// ── CSV 2 — encuesta final ───────────────────────────────────────────────────
{
  const rows = [`# ${BANNER_ACC}`, 'hogar_id,sector,personas,horas_semana_agua,gasto_mensual_cop,bienestar_pct,fecha_medicion'];
  for (let i = 1; i <= 120; i++) {
    rows.push([`HOG-${String(i).padStart(3, '0')}`, pick(['Norte', 'Sur', 'Centro', 'Playa']), int(2, 7),
      (0.9 + rnd() * 0.7).toFixed(1), int(37000, 47000), int(70, 86), '2025-12-10'].join(','));
  }
  out('encuesta-final.csv', rows.join('\n') + '\n');
}

// ── CSV 3 — asistencia (25 líderes, 22 completan) ────────────────────────────
{
  const rows = [`# ${BANNER_ACC}`, 'participante_id,rol,talleres_asistidos,talleres_totales,completo_formacion'];
  for (let i = 1; i <= 25; i++) {
    const done = i <= 22;
    rows.push([`LID-${String(i).padStart(2, '0')}`, pick(['Comite', 'Promotor', 'Vocal']),
      done ? int(10, 12) : int(3, 7), 12, done ? 'si' : 'no'].join(','));
  }
  out('asistencia.csv', rows.join('\n') + '\n');
}

// ── TXT — testimonios ────────────────────────────────────────────────────────
out('testimonios.txt', [
  BANNER_ACC, '='.repeat(70), '',
  'Proyecto: [QA-AUDIT-2026] Agua Segura y Bienestar Comunitario — Isla Esperanza',
  'Periodo: 1 enero – 31 diciembre 2025', '',
  'TESTIMONIO 1 — Hogar HOG-014, sector Norte',
  '"Antes caminábamos hasta la otra punta de la isla y hervíamos el agua dos veces.',
  'Se nos iba media mañana. Ahora el filtro está a cinco minutos y el agua sale limpia."', '',
  'TESTIMONIO 2 — Integrante del comité, LID-03',
  '"Lo que cambió no fue sólo el filtro. Aprendimos a llevar las cuentas del fondo y a',
  'turnarnos el mantenimiento. Si mañana se va la ONG, el comité sigue."', '',
  'TESTIMONIO 3 — Centro de salud local',
  '"Bajaron las consultas por diarrea en menores. No llevamos un registro formal para',
  'atribuirlo sólo al proyecto, pero la diferencia respecto a 2024 es visible."', '',
  'TESTIMONIO 4 — Hogar HOG-097, sector Playa',
  '"Gastábamos casi cien mil pesos al mes en agua de bidón. Ahora eso queda para otras',
  'cosas de la casa."', '',
  'NOTA: testimonios sintéticos. No corresponden a personas reales.',
].join('\n') + '\n');

// ── XLSX — inversiones (minimal valid OOXML, built by hand) ──────────────────
{
  const rowsData = [
    [BANNER_ACC], [],
    ['Financiador', 'Tipo', 'Monto COP', 'Naturaleza'],
    ['Financiador principal', 'financiero', 180000000, 'Aporte monetario'],
    ['Organizacion implementadora', 'especie', 30000000, 'Asistencia tecnica'],
    ['Comunidad', 'especie', 15000000, 'Trabajo y logistica'],
    ['Voluntariado', 'especie', 10000000, 'Horas voluntarias'],
    ['TOTAL', '', 235000000, ''],
  ];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = (i) => String.fromCharCode(65 + i);
  const sheetRows = rowsData.map((r, ri) => {
    const cells = r.map((v, ci) => typeof v === 'number'
      ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inversiones" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };

  // build ZIP (deflate) container
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const localHeaderOffset = offset; // central directory must point at THIS entry's local header
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(8, 8); lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(8, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt32LE(localHeaderOffset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  out('inversiones.xlsx', Buffer.concat([...chunks, cd, eocd]));
}

// ── PDFs — minimal valid single-page PDFs with computed xref ─────────────────
function makePdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 9 : 11} Tf 40 ${780 - i * 18} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

out('informe-continuidad.pdf', makePdf([
  BANNER, '',
  'INFORME DE CONTINUIDAD - FONDO DE MANTENIMIENTO',
  'Proyecto: [QA-AUDIT-2026] Agua Segura y Bienestar Comunitario',
  'Isla Esperanza, Archipielago de San Bernardo, Colombia',
  'Periodo: 1 enero - 31 diciembre 2025', '',
  '1. ESTADO DE LOS SISTEMAS',
  '   Cuatro sistemas comunitarios de filtracion instalados y operativos.',
  '   Disponibilidad media 2025: 94% de los dias.', '',
  '2. FONDO DE MANTENIMIENTO',
  '   Aporte mensual por hogar: COP 4.000. Hogares aportantes: 108 de 120 (90%).',
  '   Saldo al 31-dic-2025: COP 4.180.000. Gasto en repuestos 2025: COP 1.920.000.', '',
  '3. GOBERNANZA',
  '   Comite de agua constituido con 25 integrantes; 22 completaron la formacion.',
  '   Doce talleres de higiene realizados. Seguimiento mensual documentado.', '',
  '4. SUPUESTO DE CONTINUIDAD (relevante para drop-off)',
  '   El comite proyecta sostener la operacion 3 anos sin apoyo externo, con',
  '   deterioro esperado por reposicion de filtros a partir del ano 2.', '',
  'NOTA: documento sintetico. No corresponde a un proyecto real.',
]));

out('acta-entrega.pdf', makePdf([
  BANNER, '',
  'ACTA DE ENTREGA DE SISTEMAS DE FILTRACION',
  'Proyecto: [QA-AUDIT-2026] Agua Segura y Bienestar Comunitario',
  'Fecha: 12 de diciembre de 2025', '',
  'En Isla Esperanza, la organizacion implementadora hace entrega formal al Comite',
  'Comunitario de Agua de los siguientes bienes:', '',
  '   - Sistema de filtracion comunitario N.1 - sector Norte',
  '   - Sistema de filtracion comunitario N.2 - sector Sur',
  '   - Sistema de filtracion comunitario N.3 - sector Centro',
  '   - Sistema de filtracion comunitario N.4 - sector Playa', '',
  'El Comite acepta la titularidad y se compromete al mantenimiento con cargo al',
  'fondo constituido para tal fin.', '',
  'Poblacion cubierta: 120 hogares / 480 personas.',
  'Inversion total ejecutada: COP 235.000.000.', '',
  'Firmas: [Representante implementadora]  [Presidencia del Comite]', '',
  'NOTA: documento sintetico. Las firmas no corresponden a personas reales.',
]));

console.log('\nAll fixtures generated in audit-fixtures/agua-segura/');
