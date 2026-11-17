import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { NewThread, PdfBox, Rect, Thread } from './api';
import { load, save } from './layout';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfSelection {
  text: string;
  page: number;
  /** PDF points from the top-left of the page. */
  x: number;
  y: number;
}

export interface PdfHandle {
  highlight: (box: PdfBox) => void;
  showThread: (id: number) => void;
}

interface Props {
  /** Changes whenever a new PDF has been built. 0 means there is none yet. */
  version: number;
  /** Comments and drawings to show on the pages. */
  threads: Thread[];
  activeThread: number | null;
  onReverse: (page: number, x: number, y: number) => void;
  onAsk: (selection: PdfSelection) => void;
  onThreadClick: (id: number) => void;
  /** Save a new comment or drawing; `send` hands it to the agent straight away. */
  onCreate: (thread: NewThread, send: boolean) => Promise<void>;
  /** Move the PDF to its own browser tab. Absent when it is already there. */
  onDetach?: () => void;
}

interface SelectionMenu extends PdfSelection {
  left: number;
  top: number;
  rects: Rect[];
}

/** An annotation being made, before it is saved. */
interface Draft {
  kind: 'comment' | 'drawing';
  page: number;
  rects: Rect[];
  strokes: number[][];
  quote: string;
}

const esc = (n: number) => n.toFixed(2);

function boundsOf(rects: Rect[], strokes: number[][]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      x0 = Math.min(x0, s[i]);
      y0 = Math.min(y0, s[i + 1]);
      x1 = Math.max(x1, s[i]);
      y1 = Math.max(y1, s[i + 1]);
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const shapes = (rects: Rect[], strokes: number[][]) =>
  rects.map((r) => `<rect class="hl" x="${esc(r.x)}" y="${esc(r.y)}" width="${esc(r.w)}" height="${esc(r.h)}" rx="1.5"/>`).join('') +
  strokes
    .map((s) => {
      // A single tap becomes a dot.
      const pts = s.length === 2 ? [...s, s[0] + 0.1, s[1] + 0.1] : s;
      const d = pts.map((v, i) => (i % 2 ? esc(v) : `${i ? 'L' : 'M'}${esc(v)},`)).join('');
      return `<path class="ink" d="${d}"/>`;
    })
    .join('');

export const PdfView = forwardRef<PdfHandle, Props>(function PdfView(
  { version, threads, activeThread, onReverse, onAsk, onThreadClick, onCreate, onDetach },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [menu, setMenu] = useState<SelectionMenu | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [tool, setTool] = useState<'text' | 'hand'>('text');
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const dragged = useRef(false);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Night mode inverts the page colours on screen only; the PDF file and agent snapshots are unaffected.
  const [night, setNight] = useState(() => load('pdf.night', false));
  useEffect(() => save('pdf.night', night), [night]);

  const s = useRef({
    doc: null as pdfjs.PDFDocumentProxy | null,
    version: 0,
    zoom: 1,
    generation: 0,
    observer: null as IntersectionObserver | null,
    zooming: false,
    renders: new Map<HTMLDivElement, pdfjs.RenderTask>(),
    stroke: null as { page: number; el: HTMLDivElement; points: number[] } | null,
    threads,
    activeThread,
    draft,
  });
  s.current.threads = threads;
  s.current.activeThread = activeThread;
  s.current.draft = draft;

  // ---------- annotation overlay ----------

  /** Redraws the comments, drawings and the unsaved draft on top of every page. */
  const drawOverlays = () => {
    const st = s.current;
    const host = pagesRef.current;
    if (!host) return;
    for (const el of Array.from(host.children) as HTMLDivElement[]) {
      const page = Number(el.dataset.page);
      let svg = el.querySelector('svg.annot');
      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'annot');
        el.appendChild(svg);
      }
      svg.setAttribute('viewBox', `0 0 ${el.dataset.w} ${el.dataset.h}`);
      let html = '';
      for (const t of st.threads) {
        if (t.view.page !== page) continue;
        const b = boundsOf(t.rects, t.strokes);
        if (!b) continue;
        const cls = ['thread', t.kind, t.author === 'agent' && 'agent', t.id === st.activeThread && 'active', t.resolved && 'resolved', t.view.stale && 'stale']
          .filter(Boolean)
          .join(' ');
        const px = Math.min(Number(el.dataset.w) - 7, b.x + b.w + 5);
        const py = Math.max(7, b.y - 3);
        html +=
          `<g class="${cls}" data-id="${t.id}" transform="translate(${esc(t.view.dx)} ${esc(t.view.dy)})">` +
          shapes(t.rects, t.strokes) +
          `<g class="pin" data-id="${t.id}"><circle cx="${esc(px)}" cy="${esc(py)}" r="6"/>` +
          `<text x="${esc(px)}" y="${esc(py + 2.4)}" text-anchor="middle">${t.id}</text></g></g>`;
      }
      if (st.draft && st.draft.page === page) {
        html += `<g class="thread draft ${st.draft.kind}">${shapes(st.draft.rects, st.draft.strokes)}</g>`;
      }
      if (st.stroke && st.stroke.page === page) {
        html += `<g class="thread draft drawing">${shapes([], [st.stroke.points])}</g>`;
      }
      svg.innerHTML = html;
    }
  };

  useEffect(drawOverlays, [threads, activeThread, draft, pageCount]);

  // ---------- pages ----------

  const renderPage = async (el: HTMLDivElement) => {
    const st = s.current;
    const doc = st.doc;
    const key = el.dataset.key!;
    if (!doc || el.dataset.rendered === key || el.dataset.rendering === key) return;
    el.dataset.rendering = key;
    let task: pdfjs.RenderTask | undefined;
    try {
      const page = await doc.getPage(Number(el.dataset.page));
      if (el.dataset.key !== key) return;
      const scale = Number(el.dataset.scale);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: canvas.getContext('2d')!, viewport });
      st.renders.set(el, task);
      await task.promise;
      if (el.dataset.key !== key) return;

      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      await new pdfjs.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textLayer,
        viewport: page.getViewport({ scale }),
      }).render();

      if (el.dataset.key !== key) return; // A newer build or zoom level took over.
      // Swap in one step so the page never flashes blank.
      el.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
      el.prepend(canvas, textLayer);
      el.dataset.rendered = key;
    } catch {
      // The document was replaced mid-render; the new one will render this page.
    } finally {
      if (task && st.renders.get(el) === task) st.renders.delete(el);
      if (el.dataset.rendering === key) delete el.dataset.rendering;
    }
  };

  const layout = async (point?: { x: number; y: number }) => {
    const st = s.current;
    const doc = st.doc;
    const host = pagesRef.current;
    const scroller = scrollRef.current;
    if (!doc || !host || !scroller) return;
    const generation = ++st.generation;
    const available = Math.max(200, scroller.clientWidth - 32);
    const zoom = st.zoom;
    const viewport = scroller.getBoundingClientRect();
    const at = point ?? { x: viewport.left + scroller.clientWidth / 2, y: viewport.top + scroller.clientHeight / 2 };
    // Remember a point on the nearest page, including the fixed gaps between pages.
    const existing = Array.from(host.children) as HTMLDivElement[];
    const anchor = existing.reduce<HTMLDivElement | null>((nearest, el) => {
      const distance = (page: HTMLDivElement) => {
        const r = page.getBoundingClientRect();
        return Math.max(r.top - at.y, at.y - r.bottom, 0);
      };
      return !nearest || distance(el) < distance(nearest) ? el : nearest;
    }, null);
    const rect = anchor?.getBoundingClientRect();
    const offset = rect && { x: (at.x - rect.left) / rect.width, y: (at.y - rect.top) / rect.height };

    // Fetch first, then resize every page together so intermediate layouts cannot move the view.
    const bases = await Promise.all(Array.from({ length: doc.numPages }, async (_, i) =>
      (await doc.getPage(i + 1)).getViewport({ scale: 1 }),
    ));
    if (generation !== st.generation) return;

    for (let i = 1; i <= doc.numPages; i++) {
      const base = bases[i - 1];
      const scale = (available / base.width) * zoom;
      let el = host.children[i - 1] as HTMLDivElement | undefined;
      if (!el) {
        el = document.createElement('div');
        el.className = 'pdf-page';
        el.dataset.page = String(i);
        host.appendChild(el);
        st.observer?.observe(el);
      }
      el.style.width = `${base.width * scale}px`;
      el.style.height = `${base.height * scale}px`;
      el.style.setProperty('--scale-factor', String(scale));
      el.dataset.scale = String(scale);
      el.dataset.w = String(base.width);
      el.dataset.h = String(base.height);
      const key = `${st.version}:${scale.toFixed(4)}`;
      if (el.dataset.key !== key) st.renders.get(el)?.cancel();
      el.dataset.key = key;
      if (el.dataset.visible && !st.zooming) void renderPage(el);
    }
    while (host.children.length > doc.numPages) {
      const last = host.lastElementChild!;
      st.observer?.unobserve(last);
      last.remove();
    }
    if (anchor?.isConnected && offset) {
      const next = anchor.getBoundingClientRect();
      scroller.scrollLeft += next.left + offset.x * next.width - at.x;
      scroller.scrollTop += next.top + offset.y * next.height - at.y;
    }
    drawOverlays();
  };

  const changeZoom = (value: number, point?: { x: number; y: number }) => {
    const next = Math.max(0.5, Math.min(3, value));
    if (next === s.current.zoom) return;
    s.current.zoom = next;
    // Stretch the existing canvas while zooming; render sharp text once the gesture settles.
    s.current.zooming = true;
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => {
      s.current.zooming = false;
      for (const el of Array.from(pagesRef.current?.children ?? []) as HTMLDivElement[]) {
        if (el.dataset.visible) void renderPage(el);
      }
    }, 100);
    setZoom(next);
    setMenu(null);
    void layout(point);
  };

  useEffect(() => {
    const scroller = scrollRef.current!;
    // Trackpad pinches are delivered as Ctrl+wheel by Chromium and Firefox.
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      changeZoom(s.current.zoom * Math.exp(-event.deltaY * unit * 0.005), { x: event.clientX, y: event.clientY });
    };
    let distance = 0;
    const pinch = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        distance = 0;
        return;
      }
      event.preventDefault();
      const [a, b] = Array.from(event.touches);
      const next = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (distance && next) {
        changeZoom(s.current.zoom * next / distance, { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
      }
      distance = next;
    };
    scroller.addEventListener('wheel', wheel, { passive: false });
    scroller.addEventListener('touchstart', pinch, { passive: false });
    scroller.addEventListener('touchmove', pinch, { passive: false });
    scroller.addEventListener('touchend', pinch);
    scroller.addEventListener('touchcancel', pinch);
    return () => {
      scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('touchstart', pinch);
      scroller.removeEventListener('touchmove', pinch);
      scroller.removeEventListener('touchend', pinch);
      scroller.removeEventListener('touchcancel', pinch);
    };
  }, []);

  // Render pages only when they are near the viewport.
  useEffect(() => {
    const st = s.current;
    st.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLDivElement;
          if (entry.isIntersecting) {
            el.dataset.visible = '1';
            if (!st.zooming) void renderPage(el);
          } else {
            delete el.dataset.visible;
          }
        }
      },
      { root: scrollRef.current, rootMargin: '800px 0px' },
    );
    let timer: ReturnType<typeof setTimeout>;
    const resize = new ResizeObserver(() => {
      clearTimeout(timer);
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
      for (const task of st.renders.values()) task.cancel();
      timer = setTimeout(() => void layout(), 150);
    });
    resize.observe(scrollRef.current!);
    return () => {
      st.observer?.disconnect();
      resize.disconnect();
      clearTimeout(timer);
      void st.doc?.destroy();
      st.doc = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load each new build; the old pages stay on screen until the new ones are drawn.
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const task = pdfjs.getDocument({ url: `/api/pdf?v=${version}` });
    task.promise.then(
      (doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        const st = s.current;
        const old = st.doc;
        st.doc = doc;
        st.version = version;
        setPageCount(doc.numPages);
        void layout().then(() => old?.destroy());
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useImperativeHandle(ref, () => ({
    highlight(box) {
      const el = pagesRef.current?.children[box.page - 1] as HTMLDivElement | undefined;
      if (!el) return;
      const scale = Number(el.dataset.scale);
      const mark = document.createElement('div');
      mark.className = 'pdf-highlight';
      mark.style.left = `${box.x * scale - 4}px`;
      mark.style.top = `${box.y * scale - 2}px`;
      mark.style.width = `${box.width * scale + 8}px`;
      mark.style.height = `${box.height * scale + 4}px`;
      el.appendChild(mark);
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => mark.remove(), 2200);
    },
    showThread(id) {
      pagesRef.current?.querySelector(`g.thread[data-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  }));

  // ---------- pointer handling ----------

  const pageOf = (target: EventTarget | null) =>
    ((target as Element | null)?.closest?.('.pdf-page') as HTMLDivElement | null) ?? null;

  /** Converts a viewport point to PDF points on the given page. */
  const toPoints = (el: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const scale = Number(el.dataset.scale);
    return { page: Number(el.dataset.page), x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };

  const onClick = (e: React.MouseEvent) => {
    if (dragged.current) return;
    if (!drawing && (e.ctrlKey || e.metaKey)) {
      const el = pageOf(e.target);
      if (!el) return;
      const at = toPoints(el, e.clientX, e.clientY);
      onReverse(at.page, at.x, at.y);
      return;
    }
    const pin = (e.target as Element).closest?.('.pin') as SVGElement | null;
    if (pin) {
      onThreadClick(Number(pin.dataset.id));
      return;
    }
  };

  const onMouseUp = () => {
    if (drawing || tool === 'hand') return;
    // Wait a tick so the browser has finalised the selection.
    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!selection || !text || selection.rangeCount === 0 || !pagesRef.current?.contains(selection.anchorNode)) {
        setMenu(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = range.startContainer;
      const el = pageOf(start.nodeType === 1 ? start : start.parentElement);
      const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      if (!el || !clientRects.length) return;

      // Merge the per-word boxes into one box per line, in PDF points, keeping to the first page.
      const pageRect = el.getBoundingClientRect();
      const scale = Number(el.dataset.scale);
      const lines: Rect[] = [];
      for (const r of clientRects) {
        if (r.bottom < pageRect.top || r.top > pageRect.bottom) continue;
        const box = { x: (r.left - pageRect.left) / scale, y: (r.top - pageRect.top) / scale, w: r.width / scale, h: r.height / scale };
        const line = lines.find((l) => Math.abs(l.y + l.h / 2 - (box.y + box.h / 2)) < Math.max(l.h, box.h) / 2);
        if (line) {
          const right = Math.max(line.x + line.w, box.x + box.w);
          const bottom = Math.max(line.y + line.h, box.y + box.h);
          line.x = Math.min(line.x, box.x);
          line.y = Math.min(line.y, box.y);
          line.w = right - line.x;
          line.h = bottom - line.y;
        } else {
          lines.push(box);
        }
      }
      if (!lines.length) return;
      const first = clientRects[0];
      const last = clientRects[clientRects.length - 1];
      const at = toPoints(el, first.left + 2, first.top + first.height / 2);
      setMenu({ text, ...at, rects: lines, left: last.right + 6, top: last.bottom + 6 });
    });
  };

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  };

  const askAgent = () => {
    if (!menu) return;
    onAsk({ text: menu.text, page: menu.page, x: menu.x, y: menu.y });
    clearSelection();
  };

  const startComment = () => {
    if (!menu) return;
    setDraft({ kind: 'comment', page: menu.page, rects: menu.rects, strokes: [], quote: menu.text });
    setNote('');
    clearSelection();
  };

  // Freehand drawing: strokes on one page are collected into a single draft.
  const onPointerDown = (e: React.PointerEvent) => {
    dragged.current = false;
    if (!drawing && tool === 'hand' && e.button === 0 && e.pointerType !== 'touch' && !(e.ctrlKey || e.metaKey)) {
      const scroller = scrollRef.current!;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      setPanning(true);
      return;
    }
    if (!drawing || e.button !== 0) return;
    const el = pageOf(e.target);
    if (!el) return;
    const at = toPoints(el, e.clientX, e.clientY);
    const current = s.current.draft;
    if (current && (current.kind !== 'drawing' || current.page !== at.page)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    s.current.stroke = { page: at.page, el, points: [at.x, at.y] };
    drawOverlays();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = pan.current;
    if (start && start.id === e.pointerId) {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 3) dragged.current = true;
      if (dragged.current) {
        scrollRef.current!.scrollLeft = start.left - dx;
        scrollRef.current!.scrollTop = start.top - dy;
      }
      return;
    }
    const stroke = s.current.stroke;
    if (!stroke) return;
    const at = toPoints(stroke.el, e.clientX, e.clientY);
    const n = stroke.points.length;
    // Skip points closer than half a point to keep strokes light.
    if (Math.hypot(at.x - stroke.points[n - 2], at.y - stroke.points[n - 1]) < 0.5) return;
    stroke.points.push(at.x, at.y);
    drawOverlays();
  };

  const onPointerUp = () => {
    pan.current = null;
    setPanning(false);
    const stroke = s.current.stroke;
    if (!stroke) return;
    s.current.stroke = null;
    setDraft((d) =>
      d && d.kind === 'drawing'
        ? { ...d, strokes: [...d.strokes, stroke.points] }
        : { kind: 'drawing', page: stroke.page, rects: [], strokes: [stroke.points], quote: '' },
    );
  };

  /** A picture of the marked-up region, so the agent can see what was drawn and where. */
  const snapshot = (d: Draft): string | undefined => {
    const el = pagesRef.current?.children[d.page - 1] as HTMLDivElement | undefined;
    const canvas = el?.querySelector('canvas');
    const b = boundsOf(d.rects, d.strokes);
    if (!el || !canvas || !b) return undefined;
    const pageW = Number(el.dataset.w);
    const pageH = Number(el.dataset.h);
    // Include generous surroundings so the marks can be read in context.
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const w = Math.min(pageW, Math.max(b.w + 140, 360));
    const h = Math.min(pageH, Math.max(b.h + 140, 240));
    const x = Math.min(pageW - w, Math.max(0, cx - w / 2));
    const y = Math.min(pageH - h, Math.max(0, cy - h / 2));
    const k = canvas.width / pageW; // canvas pixels per point
    const out = document.createElement('canvas');
    const outScale = Math.min(k, 1600 / w) / k;
    out.width = Math.round(w * k * outScale);
    out.height = Math.round(h * k * outScale);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, x * k, y * k, w * k, h * k, 0, 0, out.width, out.height);
    const f = k * outScale;
    ctx.strokeStyle = '#e02020';
    ctx.lineWidth = 1.6 * f;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of d.strokes) {
      ctx.beginPath();
      for (let i = 0; i + 1 < stroke.length; i += 2) {
        const px = (stroke[i] - x) * f;
        const py = (stroke[i + 1] - y) * f;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      if (stroke.length === 2) ctx.lineTo((stroke[0] - x) * f + 0.1, (stroke[1] - y) * f + 0.1);
      ctx.stroke();
    }
    return out.toDataURL('image/png');
  };

  const cancelDraft = () => {
    setDraft(null);
    setNote('');
  };

  const saveDraft = async (send: boolean) => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await onCreate(
        {
          kind: draft.kind,
          page: draft.page,
          rects: draft.rects,
          strokes: draft.strokes,
          quote: draft.quote,
          text: note,
          image: draft.kind === 'drawing' ? snapshot(draft) : undefined,
        },
        send,
      );
      cancelDraft();
      setDrawing(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleDrawing = () => {
    setDrawing((on) => !on);
    if (draft?.kind === 'drawing') cancelDraft();
    setMenu(null);
  };

  const chooseTool = (next: 'text' | 'hand') => {
    setTool(next);
    setDrawing(false);
    if (draft?.kind === 'drawing') cancelDraft();
    clearSelection();
  };

  return (
    <div className="pane pdf-pane">
      <div className="pane-bar">
        <span className="pane-title">PDF</span>
        {pageCount > 0 && <span className="muted">{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>}
        <span className="spacer" />
        <span className="muted hint">{drawing ? 'Draw on the page, then add a note' : 'Ctrl+click to jump to source'}</span>
        <button
          className={`btn small icon ${!drawing && tool === 'text' ? 'active' : ''}`}
          onClick={() => chooseTool('text')}
          aria-pressed={!drawing && tool === 'text'}
          aria-label="Select text"
          title="Select text (Ctrl+click to jump to source)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M4 2h2l2 2 2-2h2M8 4v8M4 14h2l2-2 2 2h2" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`btn small icon ${!drawing && tool === 'hand' ? 'active' : ''}`}
          onClick={() => chooseTool('hand')}
          aria-pressed={!drawing && tool === 'hand'}
          aria-label="Pan PDF"
          title="Hand: drag to move the PDF (Ctrl+click to jump to source)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <path d="M5 8V4a1 1 0 0 1 2 0v3-5a1 1 0 0 1 2 0v5-4a1 1 0 0 1 2 0v4-2a1 1 0 0 1 2 0v5c0 3-2 5-5 5H7c-1 0-2-1-3-3L2 9a1 1 0 0 1 1.5-1.3L5 9Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className={`btn small ${night ? 'active' : ''}`}
          onClick={() => setNight((on) => !on)}
          aria-pressed={night}
          title="Night mode: show the PDF with inverted colours"
        >
          Night
        </button>
        <button
          className={`btn small ${drawing ? 'active' : ''}`}
          onClick={toggleDrawing}
          aria-pressed={drawing}
          disabled={!version}
          title="Draw on the PDF to show the agent what you mean"
        >
          Draw
        </button>
        <button className="btn small icon" onClick={() => changeZoom(+(s.current.zoom - 0.1).toFixed(2))} title="Zoom out">
          −
        </button>
        <button className="btn small" onClick={() => changeZoom(1)} title="Fit width">
          {Math.round(zoom * 100)}%
        </button>
        <button className="btn small icon" onClick={() => changeZoom(+(s.current.zoom + 0.1).toFixed(2))} title="Zoom in">
          +
        </button>
        {onDetach && (
          <button
            className="btn small icon"
            onClick={onDetach}
            title="Open the PDF in a separate tab"
            aria-label="Open the PDF in a separate tab"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <path d="M5 2.5H2.5v7h7V7M7 1.5h3.5V5M10.5 1.5 5.5 6.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div
        className={`pdf-scroll ${drawing ? 'drawing' : tool === 'hand' ? 'hand' : ''} ${panning ? 'panning' : ''} ${night ? 'night' : ''}`}
        ref={scrollRef}
        onClick={onClick}
        onMouseUp={onMouseUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onScroll={() => menu && setMenu(null)}
      >
        {!version && <div className="empty">No PDF yet. It appears here after the first successful build.</div>}
        <div className="pdf-pages" ref={pagesRef} />
      </div>

      {menu && (
        <div
          className="selection-menu"
          style={{ left: Math.min(menu.left, window.innerWidth - 230), top: Math.min(menu.top, window.innerHeight - 44) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="btn small primary" onClick={askAgent}>
            Ask agent
          </button>
          <button className="btn small" onClick={startComment}>
            Comment
          </button>
        </div>
      )}

      {draft && (
        <div className="note-panel">
          <div className="note-title">
            {draft.kind === 'drawing' ? `Drawing on page ${draft.page}` : `Comment on “${draft.quote.length > 60 ? `${draft.quote.slice(0, 59)}…` : draft.quote}”`}
          </div>
          <textarea
            autoFocus
            rows={2}
            value={note}
            placeholder={draft.kind === 'drawing' ? 'What should change here? (optional)' : 'What should change here?'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelDraft();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveDraft(true);
            }}
          />
          <div className="note-bar">
            <button className="btn small" onClick={cancelDraft}>
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn small" onClick={() => void saveDraft(false)} disabled={saving || (draft.kind === 'comment' && !note.trim())}>
              Save
            </button>
            <button
              className="btn small primary"
              onClick={() => void saveDraft(true)}
              disabled={saving || (draft.kind === 'comment' && !note.trim())}
              title="Save and send to the agent (Ctrl+Enter)"
            >
              Save and send to agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
