// dom-x11-input-region.js
// Efficient DOM engine: MutationObserver + ResizeObserver -> tile compression -> native.setInputRegion

(function(global) {

  function nowMs(){ return performance.now(); }

  function mergeRects(rects) {
    if (rects.length <= 1) return rects.slice();
    rects = rects.slice().sort((a,b) => (a.y - b.y) || (a.x - b.x));
    // horizontal merge
    let out = [];
    for (const r of rects) {
      const last = out.length ? out[out.length - 1] : null;
      if (last && r.y === last.y && r.h === last.h && r.x <= last.x + last.w) {
        last.w = Math.max(last.w, (r.x + r.w) - last.x);
      } else out.push(Object.assign({}, r));
    }
    // vertical merge
    let out2 = [];
    for (const r of out) {
      const last = out2.length ? out2[out2.length - 1] : null;
      if (last && r.x === last.x && r.w === last.w && r.y <= last.y + last.h) {
        last.h = Math.max(last.h, (r.y + r.h) - last.y);
      } else out2.push(Object.assign({}, r));
    }
    return out2;
  }

  function rasterizeToTiles(boxes, tileSize, surfaceW, surfaceH) {
    const cols = Math.max(1, Math.ceil(surfaceW / tileSize));
    const rows = Math.max(1, Math.ceil(surfaceH / tileSize));
    const grid = new Uint8Array(cols * rows);

    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor(b.x / tileSize));
      const y0 = Math.max(0, Math.floor(b.y / tileSize));
      const x1 = Math.min(cols - 1, Math.floor((b.x + b.w - 1) / tileSize));
      const y1 = Math.min(rows - 1, Math.floor((b.y + b.h - 1) / tileSize));
      for (let yy = y0; yy <= y1; yy++) {
        const base = yy * cols;
        for (let xx = x0; xx <= x1; xx++) grid[base + xx] = 1;
      }
    }

    const rects = [];
    for (let y = 0; y < rows; y++) {
      let start = -1;
      for (let x = 0; x < cols; x++) {
        const v = grid[y * cols + x];
        if (v && start === -1) start = x;
        if ((!v || x === cols - 1) && start !== -1) {
          const end = (!v) ? x - 1 : x;
          rects.push({ x: start * tileSize, y: y * tileSize, w: (end - start + 1) * tileSize, h: tileSize });
          start = -1;
        }
      }
    }

    const merged = mergeRects(rects);
    for (const r of merged) {
      if (r.x + r.w > surfaceW) r.w = surfaceW - r.x;
      if (r.y + r.h > surfaceH) r.h = surfaceH - r.y;
    }
    return merged;
  }

  function isElementHitTarget(el, selector) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false;
    if (style.pointerEvents === 'none') return false;
    if (selector && el.matches(selector)) return true;
    // interactive tags
    const tag = el.tagName.toLowerCase();
    if (['button','a','input','textarea','select','video','canvas'].includes(tag)) return true;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const hasBg = (style.backgroundImage && style.backgroundImage !== 'none') ||
                  (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') ||
                  (parseFloat(style.borderWidth) > 0);
    return !!hasBg;
  }

  function collectBoundingBoxes(selector, pixelRatio) {
    const boxes = [];
    let nodes;
    if (selector) nodes = document.querySelectorAll(selector);
    else nodes = document.body.getElementsByTagName('*');

    for (const el of nodes) {
      try {
        if (!isElementHitTarget(el, selector)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        boxes.push({ x: Math.floor(r.left * pixelRatio), y: Math.floor(r.top * pixelRatio), w: Math.ceil(r.width * pixelRatio), h: Math.ceil(r.height * pixelRatio) });
      } catch (e) { /* ignore detached */ }
    }
    return boxes;
  }

  function start(opts) {
    console.log("dom-x11-input-region starting...");
    const cfg = Object.assign({
      native: null,
      selector: '*',
      tileSize: 12,
      minIntervalMs: 16,
      pixelRatio: window.devicePixelRatio || 1,
      maxRects: 800
    }, opts || {});

    if (!cfg.native || typeof cfg.native.setInputRegion !== 'function') {
      throw new Error('native.setInputRegion required');
    }

    let scheduled = false;
    let lastEmit = 0;
    let lastHash = null;

    const mutObs = new MutationObserver(() => schedule());
    const resizeObs = new ResizeObserver(() => schedule());

    function scanInitial() {
      const nodes = document.querySelectorAll(cfg.selector);
      for (const n of nodes) {
        try { resizeObs.observe(n); } catch (e) {}
      }
    }
    scanInitial();

    mutObs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style'] });

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const since = nowMs() - lastEmit;
        if (since < cfg.minIntervalMs) {
          setTimeout(doUpdate, Math.max(0, cfg.minIntervalMs - since));
        } else doUpdate();
      });
    }

    function doUpdate() {
      const surfaceW = Math.ceil(window.innerWidth * cfg.pixelRatio);
      const surfaceH = Math.ceil(window.innerHeight * cfg.pixelRatio);

      const boxes = collectBoundingBoxes(cfg.selector, cfg.pixelRatio);
      if (boxes.length === 0) {
        if (lastHash !== 'EMPTY') {
          cfg.native.setInputRegion([]);
          lastHash = 'EMPTY';
        }
        lastEmit = nowMs();
        return;
      }

      const tiles = rasterizeToTiles(boxes, cfg.tileSize, surfaceW, surfaceH);

      if (tiles.length > cfg.maxRects) {
        let u = tiles.reduce((acc, r) => acc ? { x: Math.min(acc.x, r.x), y: Math.min(acc.y, r.y), w: Math.max(acc.x + acc.w, r.x + r.w) - Math.min(acc.x, r.x), h: Math.max(acc.y + acc.h, r.y + r.h) - Math.min(acc.y, r.y) } : r, null);
        const single = [{ x: u.x, y: u.y, w: u.w, h: u.h }];
        const hash = single.map(r => `${r.x},${r.y},${r.w},${r.h}`).join('|');
        if (hash !== lastHash) {
          cfg.native.setInputRegion(single);
          lastHash = hash;
        }
        lastEmit = nowMs();
        return;
      }

      const rects = tiles.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
      const hash = rects.map(r => `${r.x},${r.y},${r.w},${r.h}`).join('|');
      if (hash === lastHash) {
        lastEmit = nowMs();
        return;
      }
      lastHash = hash;

      try { cfg.native.setInputRegion(rects); } catch (e) { console.error('setInputRegion failed', e); }
      lastEmit = nowMs();
    }

    return {
      stop() {
        mutObs.disconnect();
        resizeObs.disconnect();
        window.removeEventListener('scroll', schedule, true);
        window.removeEventListener('resize', schedule);
      }
    };
  }

  // expose globally
  global.domRegion = { start };

})(window);
