"""Renderiza o final a partir de timeline.json e mix_raw.wav (rode montar.py antes).
1080x1920, H.264 yuv420p CRF 16, áudio com loudnorm em duas passadas para -14 LUFS."""
import json, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
sc = json.loads((ROOT / "timeline.json").read_text())
inputs, fc, labels = [], [], []
for i, s in enumerate(sc):
    inputs += ["-i", str(ROOT.parent / "clips" / f"S{s['n']:02d}.mp4")]
    fc.append(f"[{i}:v]trim=start={s['clip_in']}:duration={s['len']},setpts=PTS-STARTPTS,fps=30,scale=1080:1920:flags=lanczos,setsar=1[v{i}]")
    labels.append(f"[v{i}]")
fc.append("".join(labels) + f"concat=n={len(sc)}:v=1:a=0[v]")
mix = str(ROOT / "mix_raw.wav")
m = subprocess.run(["ffmpeg", "-i", mix, "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
d = json.loads(m[m.rindex("{"):m.rindex("}") + 1])
ln = (f"loudnorm=I=-14:TP=-1:LRA=11:measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}"
      f":measured_thresh={d['input_thresh']}:offset={d['target_offset']}:linear=true")
n = len(sc)
subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-i", mix, "-filter_complex", ";".join(fc) + f";[{n}:a]{ln},aresample=48000[a]",
                "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-shortest", str(ROOT.parent / f"{ROOT.parent.name}-final.mp4")], check=True)
print("ok")
