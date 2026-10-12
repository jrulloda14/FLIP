#!/usr/bin/env python3
"""Build FLIP: tokens.css from tokens.json, expand u(N) in CSS, assemble the single-file prototype."""
import json, re, pathlib
SRC = pathlib.Path(__file__).parent
OUT = SRC.parent / 'dist'
OUT.mkdir(exist_ok=True)

def tokens_css(t):
    L = [f"/* {t['name']} — generated from tokens.json */", ":root, [data-theme=\"display\"] {"]
    first = t['color']['themes'][0]['id']
    for c in t['color']['tokens']:
        v = c['value'] if isinstance(c['value'], str) else c['value'][first]
        L.append(f"  --{c['name']}: {v};")
    L.append("}")
    L.append(":root {")
    for fam in ('spacing', 'radius', 'matrix'):
        for x in t.get(fam, {}).get('tokens', []):
            L.append(f"  --{x['name']}: {x['value']};")
    for k, v in t['type']['families'].items():
        L.append(f"  --font-{k}: {v};")
    L.append("}")
    for g in t['type']['groups']:
        for s in g['styles']:
            fam = s.get('family', g['family'])
            L.append(f".{s['name']} {{ font-family: var(--font-{fam}); font-size: {s['fontSize']}; line-height: {s['lineHeight']}; font-weight: {s['fontWeight']}; letter-spacing: {s.get('letterSpacing','normal')}; }}")
    return "\n".join(L) + "\n"

def expand_u(css):
    return re.sub(r'u\((-?[\d.]+)\)', lambda m: f"calc(var(--u, 1) * {m.group(1)}px)", css)

tok = json.loads((SRC / 'tokens.json').read_text())
tcss = tokens_css(tok)
fcss = expand_u((SRC / 'flip.css').read_text())
acss = expand_u((SRC / 'app.css').read_text())
(OUT / 'tokens.css').write_text(tcss)
(OUT / 'flip.css').write_text(fcss)
(OUT / 'flip.js').write_text((SRC / 'flip.js').read_text())

import base64, shutil
fontface = ""
(OUT / 'fonts').mkdir(exist_ok=True)
for w in (400, 500):
    f = SRC / 'fonts' / f'jetbrains-mono-latin-{w}-normal.woff2'
    shutil.copy(f, OUT / 'fonts' / f.name)
    b = base64.b64encode(f.read_bytes()).decode()
    fontface += "@font-face{font-family:'JetBrains Mono';font-weight:%d;font-style:normal;font-display:block;src:url(data:font/woff2;base64,%s) format('woff2')}\n" % (w, b)
html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLIP — Prototype</title>
<style>
{fontface}
{tcss}
{fcss}
{acss}
</style>
</head>
<body>
<nav class="proto-bar" aria-label="Prototype screens"></nav>
<div class="proto-view"><div class="proto-stage"></div></div>
<script>
{(SRC / 'flip.js').read_text()}
</script>
<script>
{(SRC / 'app.js').read_text()}
</script>
</body>
</html>
"""
(OUT / 'FLIP-prototype.html').write_text(html)
print('built', len(html), 'bytes')
