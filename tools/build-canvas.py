"""Builds the Design canvas preview of the UI (a single Main.dc.html artboard) from web/app.

The canvas runs the same UI logic as the server-backed app, on browser storage: no server, so file
uploads, attachments and previews are unavailable there. Usage:

    python tools/build-canvas.py <output Main.dc.html>
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / 'web' / 'app'
# boot.js (DCLogic, server connection) and runtime.js (renderer) are provided by the canvas itself.
SCRIPTS = ['engine.js', 'helpers.js', 'core.js', 'db.js', 'sheet.js', 'nb.js', 'dbrange.js', 'viewer.js', 'sync.js']


def read(name):
    return (APP / name).read_text(encoding='utf-8')


def js_object(src, var):
    """Pulls the object literal assigned to `var` out of a script (it is written as JSON)."""
    m = re.search(r'var\s+' + var + r'\s*=\s*(\{.*?\n\});', src, re.S)
    if not m:
        raise SystemExit('could not find ' + var)
    return json.loads(m.group(1))


def js_map(src, var):
    m = re.search(r'var\s+' + var + r'\s*=\s*\{([^}]*)\}', src)
    if not m:
        raise SystemExit('could not find ' + var)
    return dict(re.findall(r"(\w+):\s*'?(\w+)'?", m.group(1)))


ICONS = js_object(read('icons.js'), 'TRUSS_ICONS')
RUNTIME = read('runtime.js')
DOT_ICONS = set(js_map(RUNTIME, 'DOT_ICONS'))
PICON_KEYS = js_map(RUNTIME, 'PICON_KEYS')


def icon(name, cls=''):
    if name not in ICONS:
        raise SystemExit('unknown icon ' + name)
    extra = ' dots' if name in DOT_ICONS and 'dots' not in cls else ''
    c = ('ic ' + (cls or '') + extra).strip()
    return '<svg class="%s" viewBox="0 0 24 24" aria-hidden="true"><path d="%s"></path></svg>' % (c, ICONS[name])


TEMPLATE = read('ui.html')
MACROS = {m.group(1): m.group(2).strip() for m in re.finditer(r'<!--@(\w+)-->\n?(.*?)<!--@END-->', TEMPLATE, re.S)}


def picon(arg):
    return ''.join('<sc-if value="{{%s.ic.%s}}">%s</sc-if>' % (arg, k, icon(v, 'sm')) for k, v in PICON_KEYS.items())


def expand(s, depth=0):
    if depth > 8:
        raise SystemExit('macro recursion')

    def mac(m):
        name, arg = m.group(1), m.group(2)
        if name == 'PICON':
            return picon(arg)
        body = MACROS[name]
        body = body.replace('{{$}}', '{{' + arg + '}}').replace('{{$.', '{{' + arg + '.').replace('($.', '(' + arg + '.')
        return expand(body, depth + 1)

    s = re.sub(r'@@([A-Z]+)\(([^)@]+)\)@@', mac, s)
    return re.sub(r'@@I:(\w+)(?::([\w ]+))?@@', lambda m: icon(m.group(1), m.group(2) or ''), s)


def build(out):
    markup = expand(MACROS['MAIN'])
    leftovers = re.findall(r'@@[^@]*@@', markup)
    if leftovers:
        raise SystemExit('unexpanded: %r' % leftovers[:5])
    css = read('app.css')
    js = '\n'.join(read(f) for f in SCRIPTS)
    if '</script' in js.lower() or '</style' in css.lower():
        raise SystemExit('script or style terminator inside the source')
    doc = f'''<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<title>Truss workspace</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
{css}
</style>
</helmet>
{markup}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":900}}}}'>
{js}
</script>
</body>
</html>
'''
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding='utf-8')
    print('wrote', out, len(doc), 'bytes')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    build(pathlib.Path(sys.argv[1]))
