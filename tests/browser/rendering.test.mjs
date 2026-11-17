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
function onePagePdf(pageCount = 1, height = 200) {
  const stream = 'BT /F1 20 Tf 50 150 Td (Hello PDF) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, i) => `${i + 6} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  for (let i = 1; i < pageCount; i++) objects.push(objects[2]);
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

test('PDF zoom preserves the reading position and handles wheel and touch pinches locally', async () => {
  const app = await browserApp();
  try {
    fs.writeFileSync(path.join(app.root, 'main.pdf'), onePagePdf(4, 800));
    await app.api('/api/compile', json('POST', {}));
    await until(() => app.evaluate(`document.querySelectorAll('.pdf-page').length === 4 && !!document.querySelector('.pdf-page canvas')`));
    // Scroll well into a later page: preceding pages must also be accounted for when zooming.
    await app.evaluate(`
      window.pdfScroller = document.querySelector('.pdf-scroll');
      window.pdfPage = document.querySelectorAll('.pdf-page')[2];
      pdfScroller.scrollTop = pdfPage.offsetTop + pdfPage.clientHeight / 2 - pdfScroller.clientHeight / 2;
      window.pdfPoint = (x, y) => {
        const r = pdfPage.getBoundingClientRect();
        return { x: (x - r.left) / r.width, y: (y - r.top) / r.height };
      };
      window.pdfCenter = () => {
        const r = pdfScroller.getBoundingClientRect();
        return { x: r.left + pdfScroller.clientWidth / 2, y: r.top + pdfScroller.clientHeight / 2 };
      };
      window.center = pdfCenter();
      window.before = pdfPoint(center.x, center.y);
      document.querySelector('[title="Zoom in"]').click();
    `);
    await until(() => app.evaluate(`document.querySelector('[title="Fit width"]').textContent.trim() === '110%' && Number(pdfPage.dataset.scale) > 0`));
    const checkAnchor = async () => {
      const error = await app.evaluate(`(() => {
        const after = pdfPoint(center.x, center.y);
        return { x: Math.abs(after.x - before.x) * pdfPage.clientWidth, y: Math.abs(after.y - before.y) * pdfPage.clientHeight };
      })()`);
      assert.ok(error.x < 2 && error.y < 2, `PDF anchor moved: ${JSON.stringify(error)}`);
    };
    await checkAnchor();
    // Use an off-center pointer to catch implementations that always zoom around the center.
    assert.equal(await app.evaluate(`(() => {
      center = pdfCenter(); center.x -= 40; center.y += 50;
      before = pdfPoint(center.x, center.y);
      return !pdfScroller.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: center.x, clientY: center.y,
      }));
    })()`), true, 'Browser zoom must be prevented');
    await until(() => app.evaluate(`document.querySelector('[title="Fit width"]').textContent.trim() === '181%'`));
    await checkAnchor();
    // Ordinary wheel scrolling must remain available.
    assert.equal(await app.evaluate(`pdfScroller.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaY: 100 }))`), true);
    assert.equal(await app.evaluate(`(() => {
      before = pdfPoint(center.x, center.y);
      window.touchPinch = (type, distance) => pdfScroller.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: [-1, 1].map((direction, i) => new Touch({ identifier: i, target: pdfScroller,
          clientX: center.x + direction * distance / 2, clientY: center.y })),
      }));
      touchPinch('touchstart', 100);
      return !touchPinch('touchmove', 80);
    })()`), true);
    await until(() => app.evaluate(`document.querySelector('[title="Fit width"]').textContent.trim() === '145%'`));
    await checkAnchor();
    // A rapid gesture changes page size immediately, then renders the final scale after it settles.
    const gesture = await app.evaluate(`(async () => {
      const canvas = pdfPage.querySelector('canvas');
      const width = pdfPage.clientWidth;
      for (let i = 0; i < 8; i++) pdfScroller.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true, deltaY: -5, clientX: center.x, clientY: center.y, cancelable: true,
      }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { grew: pdfPage.clientWidth > width, reusedCanvas: pdfPage.querySelector('canvas') === canvas };
    })()`);
    assert.deepEqual(gesture, { grew: true, reusedCanvas: true });
    await until(() => app.evaluate(`pdfPage.dataset.rendered === pdfPage.dataset.key`), 'Final zoom did not finish rendering');
    // A resize can arrive while the zoom redraw is still debounced. It must
    // resume rendering rather than leave the viewer in gesture mode forever.
    await app.evaluate(`
      window.beforeResizeKey = pdfPage.dataset.key;
      pdfScroller.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true, deltaY: -10, clientX: center.x, clientY: center.y, cancelable: true,
      }));
      pdfScroller.style.width = '90%';
    `);
    await until(() => app.evaluate(`pdfPage.dataset.key !== beforeResizeKey && pdfPage.dataset.rendered === pdfPage.dataset.key`),
      'Resizing during zoom stranded the PDF redraw');
    assert.equal(await app.evaluate('window.visualViewport.scale'), 1);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('PDF hand tool pans in both directions and both tools retain Ctrl+click to source', async () => {
  const app = await browserApp();
  try {
    fs.writeFileSync(path.join(app.root, 'main.pdf'), onePagePdf(3, 800));
    await app.api('/api/compile', json('POST', {}));
    await until(() => app.evaluate(`!!document.querySelector('.pdf-page .textLayer span')`));
    const reverse = [];
    app.on('Fetch.requestPaused', async (event) => {
      reverse.push(event.request.url);
      await app.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ hit: { path: 'main.tex', line: 3 } })).toString('base64') });
    });
    await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/synctex/reverse*' }] });
    await app.evaluate(`for (let i = 0; i < 5; i++) document.querySelector('[title="Zoom in"]').click()`);
    await until(() => app.evaluate(`document.querySelector('[title="Fit width"]').textContent.trim() === '150%'`));
    await until(() => app.evaluate(`document.querySelector('.pdf-page').dataset.rendered === document.querySelector('.pdf-page').dataset.key`));
    await app.evaluate(`document.querySelector('[aria-label="Pan PDF"]').click()`);
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Pan PDF"]').getAttribute('aria-pressed')`), 'true');
    const start = await app.evaluate(`(() => {
      const s = document.querySelector('.pdf-scroll');
      s.scrollTop = 400; s.scrollLeft = 50;
      const r = s.getBoundingClientRect();
      return { x: r.left + s.clientWidth / 2, y: r.top + s.clientHeight / 2, left: s.scrollLeft, top: s.scrollTop };
    })()`);
    // Let Chrome commit the programmatic scroll before native hit testing.
    await app.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await app.evaluate(`!!document.elementFromPoint(${start.x}, ${start.y})?.closest('.pdf-scroll')`), true,
      'The drag must start on the visible PDF scroller');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x - 35, y: start.y - 65, buttons: 1 });
    await until(() => app.evaluate(`getComputedStyle(document.querySelector('.pdf-scroll')).cursor === 'grabbing'`), 'Hand drag did not start');
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x - 35, y: start.y - 65, button: 'left', clickCount: 1 });
    const after = await app.evaluate(`(() => {
      const s = document.querySelector('.pdf-scroll');
      return { left: s.scrollLeft, top: s.scrollTop, cursor: getComputedStyle(s).cursor, selection: window.getSelection().toString() };
    })()`);
    assert.equal(after.left, start.left + 35);
    assert.equal(after.top, start.top + 65);
    assert.equal(after.cursor, 'grab');
    assert.equal(after.selection, '');
    assert.equal(reverse.length, 0, 'Dragging should not jump to source');
    for (const [index, tool] of ['Pan PDF', 'Select text'].entries()) {
      await app.evaluate(`document.querySelector('[aria-label="${tool}"]').click()`);
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, modifiers: 2 });
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x, y: start.y, button: 'left', clickCount: 1, modifiers: 2 });
      await until(() => reverse.length === index + 1, `Ctrl+click did not jump to source in ${tool} mode`);
      assert.equal(new URL(reverse[index]).searchParams.get('page'), '1');
    }
    assert.equal(await app.evaluate(`document.querySelector('[aria-label="Select text"]').getAttribute('aria-pressed')`), 'true');
    assert.notEqual(await app.evaluate(`getComputedStyle(document.querySelector('.pdf-page .textLayer span')).userSelect`), 'none');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
