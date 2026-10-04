import asyncio
import json
import os
import subprocess
import time
import wave
from pathlib import Path

import websockets
from faster_whisper import WhisperModel

SIP_DOMAIN = os.environ.get("SIP_DOMAIN", "sip.pphone.home")
BOT_USER = os.environ.get("BOT_USER", "bot")
BOT_PASS = os.environ.get("BOT_PASS", "botsecret")
JOIN_EXTEN = os.environ.get("JOIN_EXTEN", "9000")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
WS_PORT = 8765

BARESIP_CONFIG_DIR = Path("/root/.baresip")
REC_PATH = Path("/rec/call.raw")
SILENCE_PATH = Path("/tmp/silence.wav")
SILENCE_SECONDS = 20 * 60
SAMPLE_RATE = 8000
BYTES_PER_SAMPLE = 2
CHUNK_SECONDS = 4
CHUNK_BYTES = CHUNK_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE

clients = set()


def setup_baresip_config():
    BARESIP_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    REC_PATH.parent.mkdir(parents=True, exist_ok=True)

    # ausine умеет генерировать только 48kHz, а наш звонок на G.711/8kHz —
    # вместо него отдаём тишину из заранее сгенерированного WAV через aufile
    with wave.open(str(SILENCE_PATH), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(BYTES_PER_SAMPLE)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"\x00\x00" * (SAMPLE_RATE * SILENCE_SECONDS))

    # aufile.so умеет быть только ausrc (не auplay). ALSA "null" slave не
    # тактирует запись реальным временем (проверено: пишет в тысячи раз
    # быстрее реального звука) — поэтому плеером служит null-sink
    # PulseAudio (у него честное тактирование), а ALSA "pulse" plugin
    # просто мостит туда baresip.
    Path("/etc/asound.conf").write_text("""\
pcm.pcm_record {
    type pulse
    device "rec_sink"
}
""")

    (BARESIP_CONFIG_DIR / "accounts").write_text(
        f"<sip:{BOT_USER}@{SIP_DOMAIN}>;auth_pass={BOT_PASS};audio_codecs=PCMU/8000\n"
    )
    (BARESIP_CONFIG_DIR / "config").write_text(f"""\
module_path\t\t/usr/lib/baresip/modules
module\t\t\taccount.so
module\t\t\tg711.so
module\t\t\taufile.so
module\t\t\talsa.so
module\t\t\tctrl_tcp.so
module\t\t\tmenu.so

audio_player\t\talsa,pcm_record
audio_source\t\taufile,{SILENCE_PATH}

ctrl_tcp_listen\t\t0.0.0.0:4444
""")


def start_pulseaudio():
    REC_PATH.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["pulseaudio", "--start", "--exit-idle-time=-1", "--daemonize=yes"], check=True)
    time.sleep(2)
    subprocess.run(["pactl", "load-module", "module-null-sink", "sink_name=rec_sink"], check=True)
    subprocess.Popen([
        "parec", "-d", "rec_sink.monitor",
        "--format=s16le", f"--rate={SAMPLE_RATE}", "--channels=1",
        str(REC_PATH),
    ])


def start_baresip() -> subprocess.Popen:
    start_pulseaudio()
    setup_baresip_config()
    return subprocess.Popen(["baresip", "-f", str(BARESIP_CONFIG_DIR)])


def netstring(payload: str) -> bytes:
    data = payload.encode()
    return f"{len(data)}:".encode() + data + b","


async def dial_loop():
    # ждём регистрации на Asterisk, затем шлём команду dial через ctrl_tcp.
    # ctrl_tcp ожидает netstring-фрейминг ("<len>:<payload>,"), где payload —
    # JSON {"command": ..., "params": ...}, а не голый текст команды.
    await asyncio.sleep(5)
    payload = json.dumps({"command": "dial", "params": f"{JOIN_EXTEN}@{SIP_DOMAIN}"})
    for _ in range(15):
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", 4444)
            writer.write(netstring(payload))
            await writer.drain()
            writer.close()
            return
        except OSError:
            await asyncio.sleep(2)


async def broadcast(message: dict):
    if not clients:
        return
    data = json.dumps(message)
    await asyncio.gather(*(c.send(data) for c in list(clients)), return_exceptions=True)


async def transcribe_loop():
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

    while not REC_PATH.exists():
        await asyncio.sleep(1)

    offset = 0
    with open(REC_PATH, "rb") as f:
        while True:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size - offset >= CHUNK_BYTES:
                f.seek(offset)
                raw = f.read(CHUNK_BYTES)
                offset += len(raw)

                chunk_path = "/tmp/chunk.wav"
                with wave.open(chunk_path, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(BYTES_PER_SAMPLE)
                    w.setframerate(SAMPLE_RATE)
                    w.writeframes(raw)

                segments, _ = model.transcribe(chunk_path, language="ru")
                text = " ".join(s.text.strip() for s in segments).strip()
                if text:
                    await broadcast({"text": text, "is_final": True})
            else:
                await asyncio.sleep(0.5)


async def ws_handler(websocket):
    clients.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        clients.discard(websocket)


async def main():
    start_baresip()
    asyncio.create_task(dial_loop())
    asyncio.create_task(transcribe_loop())
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
