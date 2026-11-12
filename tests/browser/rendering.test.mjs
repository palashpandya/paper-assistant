import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserApp } from './cdp.mjs';
import { json, until } from '../helpers.mjs';

test('Markdown preview renders inline, display and bare math with the shared KaTeX', async () => {
  const app = await browserApp();
  try {
    await app.evaluate(`document.querySelector('.composer textarea').focus()`);
    await app.send('Input.insertText', { text: 'Inline $\\frac{a}{b}$ and bare \\rho_{ij}.\n\n$$\\sum_{i=1}^{n} i$$' });
    await until(() => app.evaluate(`document.querySelectorAll('.preview .katex').length === 3`), 'Math preview did not render all expressions');
    assert.equal(await app.evaluate(`!!document.querySelector('.preview .katex-display')`), true);
    assert.equal(await app.evaluate(`document.querySelectorAll('.preview .katex-error').length`), 0);
    // Untrusted math must not enable KaTeX's trusted HTML/link commands.
    await app.send('Input.insertText', { text: '\n$\\href{javascript:alert(1)}{click}$' });
    await until(() => app.evaluate(`document.querySelector('.preview')?.textContent.includes('click')`));
    assert.equal(await app.evaluate(`document.querySelectorAll('.preview a[href^="javascript:"]').length`), 0);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

/** Tiny self-contained fixture so rendering tests do not need a TeX installation. */
function onePagePdf() {
  const stream = 'BT /F1 20 Tf 50 150 Td (Hello PDF) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('PDF canvas, worker and selectable text load from the split production bundle', async () => {
  const app = await browserApp();
  try {
    fs.writeFileSync(path.join(app.root, 'main.pdf'), onePagePdf());
    await app.api('/api/compile', json('POST', {}));
    await until(() => app.evaluate(`!!document.querySelector('.pdf-page canvas') && document.querySelector('.textLayer')?.textContent.includes('Hello PDF')`), 'PDF page did not render', 15000);
    assert.equal(await app.evaluate(`document.querySelector('.pdf-page canvas').width > 0`), true);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
