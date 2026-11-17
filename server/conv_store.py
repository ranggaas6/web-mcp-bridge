'''conv_store.py - menyimpan percakapan chat ke ~/.easy-vibe/sessions/<chat>.md (+ .idx).

Dipanggil dari control port bridge (/conv/state dan /conv/append). Modul ini tidak
menyentuh proses bridge maupun server MCP: kegagalan di sini hanya menjadi balasan error.
Satu chat = satu file. Dedup memakai file .idx (satu uuid per baris), bukan isi .md.
'''
import os
import re
import json
from pathlib import Path

BASE = Path(os.environ.get('EASY_VIBE_HOME') or (Path.home() / '.easy-vibe')) / 'sessions'
NL = chr(10)
CONV_RE = re.compile('^[0-9a-fA-F-]{36}$')
ID_RE = re.compile('^[0-9A-Za-z_-]{1,64}$')
MAX_MESSAGES = 500
RESULT_HEAD = 2000
RESULT_TAIL = 300
INPUT_HEAD = 3000
ATT_HEAD = 4000
WMBX_BLOCK = re.compile(re.escape('[WMBX:') + '[0-9a-z]+' + re.escape(']' + NL + '# Local MCP tools (real)') + '(?s:.*?)' + re.escape(NL + '---' + NL + '## User request') + '(?:' + NL + ')?')
WMBX_LINE = re.compile('^' + re.escape('[WMBX] You') + '[^' + NL + ']*$', re.M)
HEADER_RE = re.compile('(?m)^## (?:USER|CLAUDE) #[0-9]+ [^ ]* <!--u:([^ >]+)-->$')


def valid_conv(conv):
    return isinstance(conv, str) and bool(CONV_RE.match(conv))


def clip(text, head, tail):
    t = str(text)
    if len(t) <= head + tail + 200:
        return t
    cut = len(t) - head - tail
    return t[:head] + NL + '...[dipotong ' + str(cut) + ' karakter]...' + NL + (t[-tail:] if tail else '')


def shrink(text):
    t = WMBX_BLOCK.sub('[prompt tool WMBX disingkat]' + NL, str(text))
    t = WMBX_LINE.sub('[pengingat WMBX disingkat]', t)
    if t.lstrip().startswith('[MCP_RESULT'):
        t = clip(t, RESULT_HEAD, RESULT_TAIL)
    return t


def fence(text, lang=''):
    n = max([len(x) for x in re.findall('`+', text)] + [2]) + 1
    f = '`' * n
    return f + lang + NL + text + NL + f


def render_md(o):
    role = 'USER' if o.get('role') == 'user' else 'CLAUDE'
    ts = re.sub('[^0-9T:-]', '', str(o.get('ts', '')))[:19]
    num = re.sub('[^0-9]', '', str(o.get('i', '')))
    out = ['## ' + role + ' #' + num + ' ' + ts + ' <!--u:' + str(o.get('uuid')) + '-->', '']
    if o.get('text'):
        out += [shrink(o['text']), '']
    for a in o.get('att') or []:
        out += ['**Lampiran: ' + str(a.get('name')) + '**', '', fence(clip(a.get('text', ''), ATT_HEAD, 500)), '']
    for x in o.get('extra') or []:
        k = x.get('k')
        if k == 'tool_use':
            body = json.dumps(x.get('input'), ensure_ascii=False, indent=1)
            out += ['**Tool call: ' + str(x.get('name')) + '**', '', fence(clip(body, INPUT_HEAD, 300), 'json'), '']
        elif k == 'tool_result':
            out += ['**Tool result: ' + str(x.get('name')) + '**', '', fence(clip(x.get('text', ''), RESULT_HEAD, RESULT_TAIL)), '']
        elif k == 'thinking':
            out += ['<details><summary>Thinking</summary>', '', str(x.get('text', '')), '', '</details>', '']
    return NL.join(out) + NL


def _paths(conv):
    return BASE / (conv + '.md'), BASE / (conv + '.idx')


def _seen(conv):
    md, idx = _paths(conv)
    if idx.exists():
        return set(x.strip() for x in idx.read_text(encoding='utf-8', errors='replace').splitlines() if x.strip())
    if md.exists():
        return set(HEADER_RE.findall(md.read_text(encoding='utf-8', errors='replace')))
    return set()


def _write(path, text):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(text)


def state(body):
    conv = body.get('chat')
    if not valid_conv(conv):
        return {'ok': False, 'error': 'chat id tidak valid'}
    seen = _seen(conv)
    return {'ok': True, 'uuids': sorted(seen), 'count': len(seen)}


def append(body):
    conv = body.get('chat')
    msgs = body.get('messages')
    if not valid_conv(conv) or not isinstance(msgs, list) or len(msgs) > MAX_MESSAGES:
        return {'ok': False, 'error': 'argumen tidak valid'}
    BASE.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(str(BASE), 0o700)
    except OSError:
        pass
    md, idx = _paths(conv)
    seen = _seen(conv)
    had_idx = idx.exists()
    exists = md.exists()
    parts = []
    ids = []
    skipped = 0
    for o in msgs:
        u = o.get('uuid') if isinstance(o, dict) else None
        if not isinstance(u, str) or not ID_RE.match(u) or u in seen:
            skipped += 1
            continue
        seen.add(u)
        ids.append(u)
        parts.append(render_md(o))
    if parts:
        head = '' if exists else '# Sesi ' + conv + NL + NL
        _write(md, head + ''.join(parts))
        _write(idx, NL.join(ids if had_idx else sorted(seen)) + NL)
    return {'ok': True, 'added': len(parts), 'skipped': skipped}
