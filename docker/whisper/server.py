"""
Servidor de transcrição do Finance AI (faster-whisper), compatível com a rota de transcrição da
OpenAI: POST /v1/audio/transcriptions (multipart: file, model, language, prompt, response_format).

Feito para servidor pequeno, dividido com outros serviços:
- CPU, int8, beam 5, idioma pt e 1 thread por padrão (beam 1 é ~20% mais rápido, mas o base erra
  "empresa" e nomes; ajuste em WHISPER_BEAM_SIZE);
- UMA transcrição por vez (as demais esperam na fila);
- o modelo é baixado no primeiro uso (cache no volume /models), nunca na partida;
- o modelo sai da memória depois de WHISPER_IDLE_UNLOAD_SECONDS sem uso (padrão 10 min);
- áudio acima de WHISPER_MAX_AUDIO_SECONDS é recusado (413).
Nenhuma porta é publicada no compose: só o web/worker alcançam o serviço pela rede interna.
Áudio e texto não vão para disco nem para os logs (só duração e tempo de processamento).

Preparo opcional (baixa o modelo antes do primeiro áudio):
  docker compose --profile whisper run --rm whisper python server.py --download
"""

from __future__ import annotations

import gc
import logging
import os
import sys
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


MODEL = os.environ.get("WHISPER_MODEL", "base").strip() or "base"
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
CPU_THREADS = max(1, _int("WHISPER_CPU_THREADS", 1))
BEAM_SIZE = max(1, _int("WHISPER_BEAM_SIZE", 5))
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "pt").strip() or None
IDLE_UNLOAD_SECONDS = _int("WHISPER_IDLE_UNLOAD_SECONDS", 600)
MAX_AUDIO_SECONDS = _int("WHISPER_MAX_AUDIO_SECONDS", 330)
MAX_UPLOAD_BYTES = _int("WHISPER_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)
SAMPLE_RATE = 16000

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s whisper: %(message)s")
log = logging.getLogger("whisper")


def repo_id(name: str) -> str:
    """'base' → 'Systran/faster-whisper-base' (o mesmo nome que o Finance AI envia)."""
    return name if "/" in name else f"Systran/faster-whisper-{name}"


def same_model(requested: str | None) -> bool:
    if not requested or requested == "whisper-1":
        return True
    return repo_id(requested).lower() == repo_id(MODEL).lower()


class ModelHolder:
    """Modelo carregado sob demanda, descarregado quando fica ocioso. O lock serializa tudo."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.model = None
        self.last_used = 0.0
        self.loads = 0

    def load(self):
        from faster_whisper import WhisperModel

        started = time.monotonic()
        model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE_TYPE, cpu_threads=CPU_THREADS, num_workers=1)
        self.loads += 1
        log.info("modelo %s carregado em %.1fs", repo_id(MODEL), time.monotonic() - started)
        return model

    def get(self):
        if self.model is None:
            self.model = self.load()
        self.last_used = time.monotonic()
        return self.model

    def unload_if_idle(self, now: float | None = None) -> bool:
        if IDLE_UNLOAD_SECONDS < 0 or self.model is None:
            return False
        now = time.monotonic() if now is None else now
        if now - self.last_used < IDLE_UNLOAD_SECONDS:
            return False
        if not self.lock.acquire(blocking=False):
            return False
        try:
            if self.model is None or now - self.last_used < IDLE_UNLOAD_SECONDS:
                return False
            self.model = None
            gc.collect()
            log.info("modelo descarregado após %ss sem uso", IDLE_UNLOAD_SECONDS)
            return True
        finally:
            self.lock.release()


holder = ModelHolder()


def _reaper() -> None:
    while True:
        time.sleep(15)
        try:
            holder.unload_if_idle()
        except Exception:  # nunca derruba o servidor
            log.exception("falha ao descarregar o modelo")


def decode(file_obj):
    from faster_whisper import decode_audio

    return decode_audio(file_obj, sampling_rate=SAMPLE_RATE)


def error(status: int, message: str, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error", "code": code}})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_reaper, name="whisper-reaper", daemon=True).start()
    log.info("pronto: modelo %s (%s, %s thread(s), beam %s, idioma %s); baixado no primeiro uso", repo_id(MODEL), COMPUTE_TYPE, CPU_THREADS, BEAM_SIZE, LANGUAGE or "auto")
    yield


app = FastAPI(title="Finance AI — transcrição", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/health")
def health():
    # Não carrega nem baixa o modelo.
    return {"status": "ok", "model": repo_id(MODEL), "loaded": holder.model is not None, "busy": holder.lock.locked()}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": repo_id(MODEL), "object": "model", "owned_by": "local"}]}


@app.post("/v1/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    response_format: str = Form("json"),
):
    if not same_model(model):
        return error(404, f"Este servidor só tem o modelo {repo_id(MODEL)} (WHISPER_MODEL).", "model_not_found")
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        return error(413, f"Arquivo acima de {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.", "file_too_large")
    waited = time.monotonic()
    # Uma transcrição por vez: decodificar e transcrever usam a CPU inteira.
    with holder.lock:
        started = time.monotonic()
        try:
            audio = decode(file.file)
        except Exception:
            return error(400, "Não foi possível ler o áudio.", "invalid_audio")
        seconds = len(audio) / SAMPLE_RATE
        if MAX_AUDIO_SECONDS > 0 and seconds > MAX_AUDIO_SECONDS:
            return error(413, f"Áudio de {seconds / 60:.1f} min; o limite é {MAX_AUDIO_SECONDS / 60:.1f} min.", "audio_too_long")
        try:
            whisper = holder.get()
        except Exception as exc:  # sem rede para baixar o modelo, disco cheio, memória…
            log.error("modelo indisponível: %s", type(exc).__name__)
            return error(503, f"Modelo {repo_id(MODEL)} indisponível (download ou carga falhou: {type(exc).__name__}).", "model_unavailable")
        segments, _info = whisper.transcribe(
            audio,
            language=(language or LANGUAGE),
            beam_size=BEAM_SIZE,
            initial_prompt=prompt or None,
            vad_filter=True,
            condition_on_previous_text=False,
            temperature=(0.0, 0.4, 0.8),
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        holder.last_used = time.monotonic()
        took = holder.last_used - started
    log.info("áudio de %.0fs transcrito em %.1fs (fila %.1fs)", seconds, took, started - waited)
    if response_format == "text":
        return PlainTextResponse(text)
    return {"text": text, "duration": round(seconds, 2)}


def _download() -> int:
    from faster_whisper.utils import download_model

    path = download_model(MODEL)
    print(f"Modelo {repo_id(MODEL)} pronto em {path}")
    return 0


if __name__ == "__main__":
    if "--download" in sys.argv:
        raise SystemExit(_download())
    print("Uso: python server.py --download (o servidor sobe com uvicorn; veja o Dockerfile)")
