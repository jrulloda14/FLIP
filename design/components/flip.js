/* @ds-bundle: {"format":4,"namespace":"Flip","components":[{"name":"DotMatrix"},{"name":"FlipText"},{"name":"DotMeter"},{"name":"DotPlot"}]} */
/* FLIP primitives — vanilla, no dependencies. window.Flip = { dotMatrix, flipText, meter, dotPlot, GLYPHS } */
(function () {
  var G = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['0', '0', '1', '0', '1', '0', '0'],
    ';': ['0', '0', '0', '0', '0', '0', '0'], /* colon "off" frame for blinking */
    '.': ['0', '0', '0', '0', '0', '0', '1'],
    '-': ['000', '000', '000', '111', '000', '000', '000'],
    ' ': ['000', '000', '000', '000', '000', '000', '000']
  };
  var SVGNS = 'http://www.w3.org/2000/svg';
  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-static'); } catch (e) { return false; }
  }

  /** Render text as a 5x7 dot-matrix SVG into el. Re-calls with the same layout animate only the changed dots. */
  function dotMatrix(el, text, o) {
    o = Object.assign({ pitch: 28, gap: 1, ghost: true, shape: 'round', dot: 0.72 }, o || {});
    var glyphs = String(text).split('').map(function (c) { return G[c] || G[' ']; });
    var widths = glyphs.map(function (g) { return g[0].length; });
    var cols = widths.reduce(function (a, b) { return a + b; }, 0) + o.gap * Math.max(0, glyphs.length - 1);
    var key = widths.join(',') + '|' + o.shape + '|' + o.dot;
    var svg = el.querySelector('svg.fl-matrix');
    if (!svg || svg.getAttribute('data-key') !== key) {
      el.innerHTML = '';
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'fl-matrix');
      svg.setAttribute('data-key', key);
      svg.setAttribute('viewBox', '0 0 ' + cols + ' 7');
      svg.setAttribute('aria-hidden', 'true');
      var x = 0, frag = document.createDocumentFragment();
      glyphs.forEach(function (g, gi) {
        for (var c = 0; c < widths[gi]; c++) {
          for (var r = 0; r < 7; r++) {
            var d;
            if (o.shape === 'square') {
              d = document.createElementNS(SVGNS, 'rect');
              var s = o.dot; d.setAttribute('x', x + c + (1 - s) / 2); d.setAttribute('y', r + (1 - s) / 2);
              d.setAttribute('width', s); d.setAttribute('height', s); d.setAttribute('rx', s * 0.12);
            } else {
              d = document.createElementNS(SVGNS, 'circle');
              d.setAttribute('cx', x + c + 0.5); d.setAttribute('cy', r + 0.5); d.setAttribute('r', o.dot / 2);
            }
            d.setAttribute('data-g', gi + ',' + c + ',' + r);
            d.style.transitionDelay = ((x + c) * 9 + r * 6) + 'ms';
            frag.appendChild(d);
          }
        }
        x += widths[gi] + o.gap;
      });
      svg.appendChild(frag);
      el.appendChild(svg);
    }
    svg.style.width = 'calc(var(--u, 1) * ' + cols * o.pitch + 'px)';
    svg.style.height = 'calc(var(--u, 1) * ' + 7 * o.pitch + 'px)';
    svg.classList.toggle('no-ghost', !o.ghost);
    svg.classList.toggle('is-instant', reduced());
    var nodes = svg.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var p = nodes[i].getAttribute('data-g').split(',');
      var on = glyphs[+p[0]][+p[2]].charAt(+p[1]) === '1';
      if (nodes[i].classList.contains('on') !== on) nodes[i].classList.toggle('on', on);
    }
    el.setAttribute('aria-label', String(text).replace(';', ':'));
    return svg;
  }

  var CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var FIXED = ' :./%-+·°↓↑×–()';
  /** Split-flap style text change: changed characters scramble, then settle left to right. */
  function flipText(el, next) {
    next = String(next);
    var prev = el.getAttribute('data-v');
    if (prev === null) prev = el.textContent;
    if (prev === next) return;
    el.setAttribute('data-v', next);
    clearInterval(el._ft);
    if (reduced() || !prev) { el.textContent = next; return; }
    var f = 0, n = next.length;
    el._ft = setInterval(function () {
      f++;
      var s = '';
      for (var i = 0; i < n; i++) {
        var ch = next.charAt(i);
        if (f >= i * 1.1 + 3 || ch === prev.charAt(i) || FIXED.indexOf(ch) >= 0) s += ch;
        else s += CH.charAt((Math.random() * 36) | 0);
      }
      el.textContent = s;
      if (f > n * 1.1 + 3) { clearInterval(el._ft); el.textContent = next; }
    }, 34);
  }

  /** Dotted meter: n dots spread across the element's width; first round(v*n) lit. */
  function meter(el, v, o) {
    o = Object.assign({ cells: 24, warnAt: 0.9, loading: false }, o || {});
    if (el.children.length !== o.cells) {
      var h = '';
      for (var i = 0; i < o.cells; i++) h += '<i style="animation-delay:' + (i * 55) + 'ms"></i>';
      el.innerHTML = h;
    }
    el.classList.add('fl-meter');
    el.classList.toggle('is-loading', !!o.loading);
    var lit = o.loading ? 0 : Math.round(Math.max(0, Math.min(1, v || 0)) * o.cells);
    for (var j = 0; j < el.children.length; j++) {
      var on = j < lit;
      if (el.children[j].classList.contains('on') !== on) el.children[j].classList.toggle('on', on);
    }
    el.classList.toggle('is-warn', !o.loading && v >= o.warnAt);
    el.setAttribute('role', 'meter');
    el.setAttribute('aria-valuenow', Math.round((v || 0) * 100));
    el.setAttribute('aria-valuemin', 0); el.setAttribute('aria-valuemax', 100);
  }

  /** Dot plot: one column per sample (0..1), rows dots tall, lit from the bottom. */
  function dotPlot(el, values, o) {
    o = Object.assign({ rows: 6, pitch: 8 }, o || {});
    var cols = values.length;
    var svg = el.querySelector('svg.fl-plot');
    var key = cols + 'x' + o.rows;
    if (!svg || svg.getAttribute('data-key') !== key) {
      el.innerHTML = '';
      svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'fl-plot');
      svg.setAttribute('data-key', key);
      svg.setAttribute('viewBox', '0 0 ' + cols + ' ' + o.rows);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      for (var c = 0; c < cols; c++) for (var r = 0; r < o.rows; r++) {
        var d = document.createElementNS(SVGNS, 'rect');
        d.setAttribute('x', c + 0.2); d.setAttribute('y', r + 0.2); d.setAttribute('width', 0.6); d.setAttribute('height', 0.6);
        svg.appendChild(d);
      }
      el.appendChild(svg);
    }
    svg.style.height = 'calc(var(--u, 1) * ' + o.rows * o.pitch + 'px)';
    var k = 0;
    for (var c2 = 0; c2 < cols; c2++) {
      var level = Math.round(Math.max(0, Math.min(1, values[c2])) * o.rows);
      for (var r2 = 0; r2 < o.rows; r2++) {
        svg.childNodes[k++].setAttribute('class', (o.rows - r2 <= level) ? 'on' : '');
      }
    }
  }

  window.Flip = Object.assign(window.Flip || {}, { dotMatrix: dotMatrix, flipText: flipText, meter: meter, dotPlot: dotPlot, GLYPHS: G });
})();
