import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
j = json.load(open(D + '/walk.json'))
W, BAR, PAGE, CAP = 1280, 40, 620, 60
F = '/System/Library/Fonts/SFNS.ttf'
fu = ImageFont.truetype(F, 15); fc = ImageFont.truetype(F, 19)
od = D + '/chrome'; os.makedirs(od, exist_ok=True)
for x in os.listdir(od): os.remove(os.path.join(od, x))

def wrap(text, font, width):
    out, line = [], ''
    for w in text.split(' '):
        t = (line + ' ' + w).strip()
        if font.getlength(t) <= width: line = t
        else: out.append(line); line = w
    if line: out.append(line)
    return out

def frame(bar, typing, cap, path):
    im = Image.new('RGBA', (W, BAR + PAGE + CAP), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, BAR - 1], fill=(241, 243, 244, 255)); d.line([0, BAR - 1, W, BAR - 1], fill=(205, 208, 212, 255))
    g = (95, 99, 104, 255)
    d.line([14, 20, 30, 20], fill=g, width=2); d.line([14, 20, 20, 14], fill=g, width=2); d.line([14, 20, 20, 26], fill=g, width=2)
    d.line([44, 20, 60, 20], fill=(180, 183, 187, 255), width=2); d.line([60, 20, 54, 14], fill=(180, 183, 187, 255), width=2); d.line([60, 20, 54, 26], fill=(180, 183, 187, 255), width=2)
    d.arc([76, 12, 92, 28], 40, 340, fill=g, width=2); d.polygon([(92, 11), (92, 18), (86, 15)], fill=g)
    box = [108, 6, W - 12, BAR - 7]
    d.rounded_rectangle(box, radius=14, fill=(255, 255, 255, 255), outline=(26, 115, 232, 255) if typing else (218, 220, 224, 255), width=2 if typing else 1)
    shown = bar if typing else bar.replace('https://', '')
    x = 126
    if not typing and shown:
        d.rounded_rectangle([x, 15, x + 8, 24], radius=1, fill=g); d.arc([x + 1, 9, x + 7, 19], 180, 360, fill=g, width=2); x += 18
    maxw = box[2] - x - 16
    while shown and fu.getlength(shown + '…') > maxw: shown = shown[:-1]
    if not typing and shown != (bar.replace('https://', '')): shown += '…'
    if not typing and '/' in shown:
        host, rest = shown.split('/', 1); d.text((x, 11), host, font=fu, fill=(32, 33, 36, 255)); d.text((x + fu.getlength(host), 11), '/' + rest, font=fu, fill=(95, 99, 104, 255))
    else:
        d.text((x, 11), shown, font=fu, fill=(32, 33, 36, 255))
        if typing: cx = x + fu.getlength(shown) + 1; d.line([cx, 11, cx, 29], fill=(32, 33, 36, 255), width=1)
    y0 = BAR + PAGE
    d.rectangle([0, y0, W, y0 + CAP], fill=(11, 11, 16, 255))
    lines = wrap(cap, fc, W - 48)[:2]
    ty = y0 + (CAP - 24 * len(lines)) / 2 - 1
    for i, l in enumerate(lines): d.text((24, ty + i * 24), l, font=fc, fill=(255, 255, 255, 255))
    im.save(path)

states, last = [], None
for e in j['ev']:
    k = (e['bar'], e['typing'], e['cap'])
    if k != last: states.append([e['t'], k]); last = k
cache, lines = {}, ['ffconcat version 1.0']
for i, (t, k) in enumerate(states):
    t1 = states[i + 1][0] if i + 1 < len(states) else j['end']
    if t1 - t <= 0: continue
    if k not in cache: cache[k] = f'{od}/{len(cache):04d}.png'; frame(*k, cache[k])
    lines += [f"file '{cache[k]}'", f'duration {t1 - t:.3f}']
lines.append(f"file '{cache[states[-1][1]]}'")
open(D + '/chrome.txt', 'w').write('\n'.join(lines) + '\n')

SPEED = 5.0
segs, p = [], 0.0
for a, b in j['fast']:
    if a > p: segs.append((p, a, 1))
    segs.append((a, b, SPEED)); p = b
segs.append((p, j['end'], 1))
parts, lab = ['[0:v]fps=25,pad=1280:720:0:40:color=white,format=rgba[pg]', '[1:v]fps=25,format=rgba[ch]', '[pg][ch]overlay=0:0:shortest=1,format=yuv420p,split=%d%s' % (len(segs), ''.join(f'[s{i}]' for i in range(len(segs))))], ''
for i, (a, b, s) in enumerate(segs):
    parts.append(f'[s{i}]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{s}[v{i}]'); lab += f'[v{i}]'
parts.append(f'{lab}concat=n={len(segs)}:v=1:a=0,fps=25[out]')
out = D + '/walk.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', j['src'], '-f', 'concat', '-safe', '0', '-i', D + '/chrome.txt', '-filter_complex', ';'.join(parts), '-map', '[out]', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], check=True)
print(out, len(cache), 'chrome frames', len(segs), 'segments')
