FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive TZ=Europe/Moscow

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        baresip baresip-x11 python3 python3-pip python3-venv ffmpeg \
        pulseaudio pulseaudio-utils libasound2-plugins && \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app
WORKDIR /app

CMD ["python3", "bot.py"]
