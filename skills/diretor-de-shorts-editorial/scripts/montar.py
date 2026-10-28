"""Montagem de um short da skill diretor-de-shorts-editorial: corta os clipes no ritmo da narração,
sintetiza SFX por objeto no instante de maior movimento e mixa tudo.
Determinístico: ruído só com gerador semeado."""
import json, subprocess, wave
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt

ROOT = Path(__file__).parent
CLIPS = ROOT.parent / "clips"
SR = 48000
GAP = 0.45          # respiro depois de cada fala
LEAD = 0.15         # a narração entra 0,15 s depois do corte
MIN_SCENE = 2.2
END_HOLD = 1.3      # a última cena segura depois da fala
# entrada fixa onde o trecho de mais movimento corta a manchete (vista na folha de contato)
CLIP_IN = {}   # ex.: {1: 0.25, 2: 1.5} no BotaoWhatsApp

# ---------- medição ----------
def wav_len(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()

def read_wav(p):
    with wave.open(str(p)) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return a

def motion_curve(clip, fps=24, w=72, h=128):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(clip), "-vf", f"fps={fps},scale={w}:{h},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    d = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))
    return np.concatenate([[0], d]), fps

# ---------- síntese ----------
rng = np.random.default_rng(1607)

def t(dur): return np.arange(int(dur * SR)) / SR
def env(dur, a=0.005, decay=8.0):
    x = t(dur); e = np.exp(-x * decay); n = int(a * SR)
    if n: e[:n] *= np.linspace(0, 1, n)
    return e
def band(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], btype="band", fs=SR, output="sos"), x)
def lowp(x, f): return sosfilt(butter(2, f, btype="low", fs=SR, output="sos"), x)
def highp(x, f): return sosfilt(butter(2, f, btype="high", fs=SR, output="sos"), x)
def noise(dur): return rng.standard_normal(int(dur * SR))
def norm(x, peak): m = np.abs(x).max() or 1; return x / m * peak

def whoosh(dur=0.45):
    x = t(dur); n = noise(dur)
    sweep = np.concatenate([band(n[i:i + 2400], 300 + 2500 * (i / len(n)), 900 + 4000 * (i / len(n))) for i in range(0, len(n), 2400)])[:len(n)]
    e = np.sin(np.pi * x / dur) ** 2
    return norm(sweep * e, 0.22)
def thud(f0=90, dur=0.35):
    x = t(dur); f = f0 * (1 + 1.5 * np.exp(-x * 30))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(dur, 0.002, 14)
    c = lowp(noise(dur), 900) * env(dur, 0.001, 60) * 0.5
    return norm(s + c, 0.5)
def tick(f=2600, dur=0.05):
    return norm(band(noise(dur), f * 0.7, f * 1.3) * env(dur, 0.0005, 120), 0.28)
def pop(dur=0.18):
    x = t(dur); f = 380 + 700 * (1 - np.exp(-x * 40))
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(dur, 0.001, 22)
    return norm(s + tick(3200, dur) * 0.4, 0.45)
def rustle(dur=0.8):
    n = highp(noise(dur), 1800); g = np.repeat(rng.uniform(0.1, 1, int(dur * 60) + 1), SR // 60)[:len(n)]
    e = np.sin(np.pi * t(dur) / dur)
    return norm(lowp(n, 7000) * g * e, 0.18)
def chime(f=1760, dur=1.6):
    x = t(dur); s = sum(a * np.sin(2 * np.pi * f * r * x) * np.exp(-x * d) for r, a, d in [(1, 1, 3), (2.76, .5, 5), (5.4, .25, 8), (8.93, .12, 12)])
    n = int(0.003 * SR); s[:n] *= np.linspace(0, 1, n)
    return norm(s, 0.2)
def scrape(dur=0.7):
    n = band(noise(dur), 120, 900) * (0.6 + 0.4 * np.sin(2 * np.pi * 9 * t(dur)))
    return norm(n * np.sin(np.pi * t(dur) / dur) ** 1.5, 0.28)
def metal_click(dur=0.25):
    x = t(dur); r = np.sin(2 * np.pi * 3100 * x) * np.exp(-x * 25) + 0.5 * np.sin(2 * np.pi * 4700 * x) * np.exp(-x * 35)
    return norm(r + tick(4000, dur) * 0.8, 0.3)
def creak(dur=0.55, f0=140):
    x = t(dur); f = f0 + 40 * np.sin(2 * np.pi * 2.5 * x) + rng.normal(0, 8, len(x))
    ph = np.cumsum(f) / SR; s = (2 * (ph % 1) - 1)
    s = band(s, 200, 2500) * np.sin(np.pi * x / dur)
    return norm(s, 0.16)
def shimmer(dur=1.8):
    x = t(dur); s = sum(np.sin(2 * np.pi * f * x + p) for f, p in [(2093, 0), (2637, 1), (3136, 2), (4186, .5)])
    s *= (0.6 + 0.4 * np.sin(2 * np.pi * 6 * x)) * np.sin(np.pi * x / dur) ** 2
    return norm(s, 0.08)
def swell(dur=1.4):
    x = t(dur); return norm(lowp(noise(dur), 600 + 1400 * 0) * (x / dur) ** 2 * np.exp(-np.maximum(0, x - dur * 0.85) * 20), 0.2)
def flicks(n=4, gap=0.07):
    out = np.zeros(int((n * gap + 0.1) * SR))
    for i in range(n):
        s = norm(band(noise(0.04), 1500, 6000) * env(0.04, 0.0005, 90), 0.22 * (1 - i * 0.12)); k = int(i * gap * SR); out[k:k + len(s)] += s
    return out
def pebbles():
    out = np.zeros(int(0.4 * SR))
    for k, f in [(0, 2200), (0.16, 2600)]:
        s = tick(f, 0.06) * 0.9 + thud(400, 0.06) * 0.2; i = int(k * SR); out[i:i + len(s)] += s
    return out
def key_click():
    out = np.zeros(int(0.5 * SR)); a = metal_click(0.2); b = tick(1800, 0.05)
    out[:len(b)] += b; out[int(0.09 * SR):int(0.09 * SR) + len(a)] += a
    return out

def pad(dur):
    x = t(dur); chord = [110, 164.81, 220, 261.63, 329.63]
    s = sum(np.sin(2 * np.pi * f * x + i) * (1 / (i + 1)) for i, f in enumerate(chord))
    s *= 0.75 + 0.25 * np.sin(2 * np.pi * 0.11 * x)
    s = lowp(s, 900)
    fade = np.minimum(1, np.minimum(x / 1.5, (dur - x) / 2.0))
    return norm(s * fade, 0.05)

# objeto de cada cena: (função do som, ganho)
OBJ = {1: (lambda: thud(85), .8), 2: (pop, .9), 3: (rustle, 1), 4: (lambda: thud(70, .45), .7),
       5: (pebbles, .9), 6: (lambda: creak(.6, 110), 1), 7: (chime, 1), 8: (scrape, 1),
       9: (flicks, 1), 10: (shimmer, 1), 11: (metal_click, .9), 12: (lambda: scrape(.4), .8),
       13: (lambda: creak(.5, 180), .9), 14: (key_click, 1)}

def place(buf, sig, at, gain=1.0):
    i = max(0, int(at * SR)); j = min(len(buf), i + len(sig)); buf[i:j] += sig[:j - i] * gain

# ---------- linha do tempo ----------
N = len((ROOT / "beats.txt").read_text(encoding="utf-8").strip().splitlines())
vo = [ROOT / "vo" / f"B{i:02d}.wav" for i in range(1, N + 1)]
speech = [wav_len(p) for p in vo]
scenes, cur = [], 0.0
for i, s in enumerate(speech, 1):
    ln = max(MIN_SCENE, LEAD + s + (END_HOLD if i == N else GAP))
    clip = CLIPS / f"S{i:02d}.mp4"
    curve, fps = motion_curve(clip)
    total = len(curve) / fps
    # janela do clipe com mais movimento, começando depois do quadro parado inicial
    best, best_e = 0.25, -1
    starts = [CLIP_IN[i]] if i in CLIP_IN else np.arange(0.25, max(0.26, total - ln - 0.05), 1 / fps)
    for st in starts:
        a, b = int(st * fps), int((st + ln) * fps)
        e = curve[a:b].sum()
        if e > best_e: best, best_e = st, e
    a, b = int(best * fps), int((best + ln) * fps)
    seg = curve[a:b].copy(); seg[: int(0.15 * fps)] = 0  # não colar o impacto no corte
    peak = (a + int(np.argmax(seg))) / fps - best
    scenes.append(dict(n=i, start=round(cur, 3), len=round(ln, 3), clip_in=round(float(best), 3), peak=round(float(peak), 3), speech=round(s, 3)))
    cur += ln
total = cur
(ROOT / "timeline.json").write_text(json.dumps(scenes, indent=1))

# ---------- áudio ----------
mix = np.zeros(int((total + 0.5) * SR))
bed = pad(total); place(mix, bed, 0)
for sc, p in zip(scenes, vo):
    place(mix, read_wav(p), sc["start"] + LEAD, 1.0)
    if sc["n"] > 1: place(mix, whoosh(0.4), sc["start"] - 0.22, 0.6)
    f, g = OBJ.get(sc["n"], (lambda: thud(120, .3), .7)); place(mix, f(), sc["start"] + sc["peak"], g * 0.55)
s1 = scenes[0]; place(mix, tick(2400), s1["start"] + 0.9, .5); place(mix, tick(2400), s1["start"] + 1.9, .5)
s14 = scenes[-1]; place(mix, creak(0.9, 95), s14["start"] + 0.9, .5); place(mix, swell(1.6), s14["start"] + s14["len"] - 1.8, .6)
mix = np.clip(mix, -1, 1)
with wave.open(str(ROOT / "mix_raw.wav"), "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype(np.int16).tobytes())
print(json.dumps(dict(total=round(total, 2), scenes=scenes)))
