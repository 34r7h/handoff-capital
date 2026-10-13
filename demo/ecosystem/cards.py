# Title and end cards drawn here rather than recorded: the recording drops its last seconds on close, and its first frames are partly unpainted.
import json, os, subprocess
from PIL import Image, ImageDraw, ImageFont
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
j = json.load(open(D + '/walk.json'))
F = '/System/Library/Fonts/SFNS.ttf'
big, small = ImageFont.truetype(F, 26), ImageFont.truetype(F, 20)

def wrap(text, font, width):
    out, line = [], ''
    for w in text.split():
        t = (line + ' ' + w).strip()
        if font.getlength(t) > width and line: out.append(line); line = w
        else: line = t
    return out + [line] if line else out

def card(name, head, sub):
    im = Image.new('RGB', (1280, 720), '#0b0b10'); d = ImageDraw.Draw(im)
    rows = [(l, big, '#eeeeee', 39) for l in wrap(head, big, 1040)] + [(l, small, '#aaaaaa', 30) for l in wrap(sub, small, 1040)]
    y = (720 - sum(r[3] for r in rows)) // 2
    for l, f, c, h in rows: d.text((120, y), l, font=f, fill=c); y += h
    im.save(f'{D}/{name}.png')

card('title', 'handoff on Base Sepolia testnet: the whole loop, on the live sites',
     'Recorded 2026-10-13 04:48 UTC in a browser. The run itself took place on 2026-10-12 (15:21–15:28 UTC) and 2026-10-13 (00:49–00:51 UTC). Every figure shown is read from the live pages and from the chain. Amounts are test USDC.')
card('endcard', 'Every agent shown is run by the founder, in test USDC on Base Sepolia.',
     'Sale ids and transactions: github.com/34r7h/handoff-pay, demo/ecosystem.')

def rendered(x): return x - sum(max(0, min(b, x) - a) * 0.8 for a, b in j['fast'] if a < x)
start = 6.0                                    # the title card's hold in the recording; typing starts at 6.02
cut = [e['t'] for e in j['ev'] if e.get('cap') == '' and e['t'] > 100][0]   # caption cleared before the recorded end card
a, b = rendered(start), rendered(cut)
blank = rendered(8.92) - a                     # the recorded title card stays up until the first page paints at 8.92; a blank page stands in while the URL is typed
fc = (f'[0:v]loop=loop=-1:size=1,trim=duration=6,fps=25,format=yuv420p,setsar=1[t];'
      f'[1:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS,drawbox=x=0:y=40:w=1280:h=620:color=0x0b0b10@1:t=fill:enable=\'lt(t,{blank:.3f})\',fps=25,format=yuv420p,setsar=1[m];'
      f'[2:v]loop=loop=-1:size=1,trim=duration=5,fps=25,format=yuv420p,setsar=1[e];'
      f'[t][m][e]concat=n=3:v=1:a=0[out]')
out = D + '/final.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', D + '/title.png', '-i', D + '/walk.mp4', '-i', D + '/endcard.png',
                '-filter_complex', fc, '-map', '[out]', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], check=True)
print(out, round(a, 2), round(b, 2))
