"""
Testes do servidor de transcrição com um modelo falso (não baixa nada). Precisa do ffmpeg.
  python -m venv .venv && .venv/bin/pip install -r requirements.txt httpx==0.28.1
  .venv/bin/python test_server.py
"""
import os, subprocess, sys, tempfile, threading, time

os.environ["WHISPER_IDLE_UNLOAD_SECONDS"] = "2"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

D = tempfile.mkdtemp(prefix="whisper-test-")
for name, seconds in (("short", 12), ("long", 400)):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-ac", "1", "-c:a", "libopus", "-b:a", "16k", f"{D}/{name}.ogg"], check=True)

calls = {"load": 0, "transcribe": [], "concurrent": 0, "max_concurrent": 0}
lock = threading.Lock()

class Seg:
    def __init__(self, t): self.text = t

class FakeModel:
    def transcribe(self, audio, **kw):
        with lock:
            calls["concurrent"] += 1
            calls["max_concurrent"] = max(calls["max_concurrent"], calls["concurrent"])
        time.sleep(0.3)
        calls["transcribe"].append({"seconds": len(audio) / 16000, **{k: kw[k] for k in ("language", "beam_size", "vad_filter", "initial_prompt")}})
        with lock:
            calls["concurrent"] -= 1
        return iter([Seg(" gastei 50 "), Seg("no mercado ")]), None

def fake_load(self):
    calls["load"] += 1
    return FakeModel()

server.ModelHolder.load = fake_load

with TestClient(server.app) as c:
    h = c.get("/health").json()
    assert h == {"status": "ok", "model": "Systran/faster-whisper-base", "loaded": False, "busy": False}, h
    assert calls["load"] == 0, "health não pode carregar o modelo"
    r = c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"), "audio/ogg")}, data={"model": "Systran/faster-whisper-base", "language": "pt", "prompt": "finanças"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["text"] == "gastei 50 no mercado", body
    assert 11.5 < body["duration"] < 12.5, body
    t = calls["transcribe"][0]
    assert t["beam_size"] == server.BEAM_SIZE == 5 and t["language"] == "pt" and t["vad_filter"] is True and t["initial_prompt"] == "finanças", t
    assert c.get("/health").json()["loaded"] is True
    # whisper-1 também é aceito; outro modelo não (não baixa modelo grande por engano)
    assert c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"))}, data={"model": "whisper-1", "response_format": "text"}).text == "gastei 50 no mercado"
    r = c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"))}, data={"model": "Systran/faster-whisper-large-v3"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "model_not_found", r.text
    # áudio longo demais (> 330 s) → 413 sem transcrever
    n = len(calls["transcribe"])
    r = c.post("/v1/audio/transcriptions", files={"file": ("l.ogg", open(f"{D}/long.ogg", "rb"))}, data={"model": "whisper-1"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "audio_too_long", r.text
    assert len(calls["transcribe"]) == n
    # arquivo que não é áudio
    r = c.post("/v1/audio/transcriptions", files={"file": ("x.ogg", b"isto nao e audio")}, data={"model": "whisper-1"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_audio", r.text
    # uma transcrição por vez: 4 pedidos simultâneos
    res = []
    def go():
        res.append(c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"))}, data={"model": "whisper-1"}).status_code)
    ts = [threading.Thread(target=go) for _ in range(4)]
    [x.start() for x in ts]; [x.join() for x in ts]
    assert res == [200] * 4, res
    assert calls["max_concurrent"] == 1, calls["max_concurrent"]
    # descarrega depois do tempo ocioso; volta a carregar no próximo áudio
    assert server.holder.unload_if_idle(time.monotonic() + 3) is True
    assert c.get("/health").json()["loaded"] is False
    loads = calls["load"]
    assert c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"))}, data={"model": "whisper-1"}).status_code == 200
    assert calls["load"] == loads + 1
    # falha ao carregar (ex.: sem rede para baixar) → 503 claro, servidor continua de pé
    server.holder.model = None
    def broken(self): raise OSError("sem rede")
    server.ModelHolder.load = broken
    r = c.post("/v1/audio/transcriptions", files={"file": ("a.ogg", open(f"{D}/short.ogg", "rb"))}, data={"model": "whisper-1"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "model_unavailable", r.text
    assert c.get("/health").status_code == 200
print("OK", calls["load"], len(calls["transcribe"]))
