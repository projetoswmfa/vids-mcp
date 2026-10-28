"""Gera legendas .ass a partir do roteiro aprovado e da linha do tempo da montagem.
Blocos de até 3 palavras; a palavra falada acende em laranja queimado."""
import json, re
from pathlib import Path

ROOT = Path(__file__).parent
LEAD = 0.15
beats = (ROOT / "beats.txt").read_text(encoding="utf-8").strip().splitlines()
scenes = json.loads((ROOT / "timeline.json").read_text())

def ts(s):
    h, s = divmod(s, 3600); m, s = divmod(s, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"

def chunks(words):
    out, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) == 3 or re.search(r"[.,:?!]$", w):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out

ORANGE = "&H1E52C4&"   # #C4521E em BGR
lines = []
for text, sc in zip(beats, scenes):
    words = text.upper().split()
    weights = [len(w) + 2 for w in words]
    total = sum(weights); t0 = sc["start"] + LEAD; span = sc["speech"]
    times, acc = [], t0
    for w in weights:
        d = span * w / total; times.append((acc, acc + d)); acc += d
    k = 0
    for ch in chunks(words):
        for j in range(len(ch)):
            a, b = times[k + j]
            if k + j == len(words) - 1: b = sc["start"] + sc["len"] - 0.05
            elif j == len(ch) - 1: b = times[k + j + 1][0]
            txt = " ".join((f"{{\\c{ORANGE}}}{w}{{\\c&HFFFFFF&}}" if i == j else w) for i, w in enumerate(ch))
            lines.append(f"Dialogue: 0,{ts(a)},{ts(b)},Cap,,0,0,0,,{txt}")
        k += len(ch)

head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Bahnschrift,80,&H00FFFFFF,&H00FFFFFF,&H00261E1E,&H00261E1E,1,0,0,0,100,100,1,0,3,20,0,2,70,70,320,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
(ROOT / "legendas.ass").write_text(head + "\n".join(lines) + "\n", encoding="utf-8")
print(len(lines), "eventos")
