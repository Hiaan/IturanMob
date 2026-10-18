# Servidor de transcrição próprio (faster-whisper), compatível com a API de transcrição da OpenAI.
# Usado pelo profile "whisper" do docker-compose.yml. Sem GPU: CPU, int8.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    MALLOC_ARENA_MAX=2 \
    OMP_NUM_THREADS=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin whisper \
    && mkdir -p /models \
    && chown whisper:whisper /models
COPY server.py .

USER whisper
EXPOSE 8000
# nice: prioridade baixa de CPU — os outros serviços do servidor vêm primeiro.
CMD ["nice", "-n", "10", "python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
