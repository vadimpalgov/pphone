import asyncio
import json
import os
import subprocess
import time
import wave
from pathlib import Path

import websockets
from aiohttp import web
from faster_whisper import WhisperModel

SIP_DOMAIN = os.environ.get("SIP_DOMAIN", "sip.pphone.home")
BOT_USER = os.environ.get("BOT_USER", "bot")
BOT_PASS = os.environ.get("BOT_PASS", "botsecret")
JOIN_EXTEN = os.environ.get("JOIN_EXTEN", "9000")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
AMI_PORT = 5038
AMI_USER = os.environ.get("AMI_USER", "transcriber")
AMI_PASS = os.environ.get("AMI_PASS", "amisecret")
WS_PORT = 8765
HTTP_PORT = 8766

BARESIP_CONFIG_DIR = Path("/root/.baresip")
REC_PATH = Path("/rec/call.raw")
RECORDINGS_DIR = Path("/rec/calls")
SILENCE_PATH = Path("/tmp/silence.wav")
SILENCE_SECONDS = 6 * 60 * 60
SAMPLE_RATE = 8000
BYTES_PER_SAMPLE = 2
CHUNK_SECONDS = 4
CHUNK_BYTES = CHUNK_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE

clients = set()

# Запись текущего звонка: открытый wave.Wave_write (+ его путь) или None,
# когда в конференции кроме бота никого нет. Пишется из
# recording_tail_loop, открывается/закрывается из ami_loop по событиям
# ConfbridgeJoin/Leave.
current_wav = None
current_wav_path = None


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


def start_recording():
    global current_wav, current_wav_path
    if current_wav is not None:
        return
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    path = RECORDINGS_DIR / f"call_{time.strftime('%Y%m%d_%H%M%S')}.wav"
    w = wave.open(str(path), "wb")
    w.setnchannels(1)
    w.setsampwidth(BYTES_PER_SAMPLE)
    w.setframerate(SAMPLE_RATE)
    current_wav = w
    current_wav_path = path


def stop_recording():
    global current_wav, current_wav_path
    if current_wav is not None:
        current_wav.close()
        current_wav = None
        current_wav_path = None


async def recording_tail_loop():
    # Независимо от transcribe_loop хвостом читаем тот же сырой PCM-поток и,
    # пока идёт звонок (current_wav открыт ami_loop'ом), дописываем байты в
    # файл текущего звонка. Два независимых offset'а по одному файлу - ок,
    # т.к. каждый читает только свои ещё не прочитанные байты.
    while not REC_PATH.exists():
        await asyncio.sleep(1)

    offset = 0
    with open(REC_PATH, "rb") as f:
        while True:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            if size > offset:
                f.seek(offset)
                raw = f.read(size - offset)
                offset += len(raw)
                if current_wav is not None:
                    current_wav.writeframes(raw)
            await asyncio.sleep(0.5)


def parse_ami_block(buf: bytes) -> dict:
    msg = {}
    for line in buf.decode(errors="ignore").split("\r\n"):
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        msg[key.strip()] = value.strip()
    return msg


async def ami_loop():
    # ConfbridgeJoin/ConfbridgeLeave прилетают независимо от количества SIP-
    # диалогов бота (бот зашёл в demo_room один раз на старте и сидит там
    # постоянно) - только по ним можно понять, когда в комнате появляется
    # первый "настоящий" абонент (начало звонка) и когда уходит последний
    # (конец звонка).
    members = set()
    while True:
        try:
            reader, writer = await asyncio.open_connection(SIP_DOMAIN, AMI_PORT)
            try:
                await reader.readline()  # баннер "Asterisk Call Manager/x.x"
                writer.write(
                    f"Action: Login\r\nUsername: {AMI_USER}\r\nSecret: {AMI_PASS}\r\n\r\n".encode()
                )
                await writer.drain()

                buf = b""
                while True:
                    line = await reader.readline()
                    if not line:
                        raise ConnectionError("AMI connection closed")
                    buf += line
                    if line in (b"\r\n", b"\n"):
                        msg = parse_ami_block(buf)
                        buf = b""
                        event = msg.get("Event")
                        channel = msg.get("Channel")
                        if event == "ConfbridgeJoin" and channel:
                            members.add(channel)
                        elif event == "ConfbridgeLeave" and channel:
                            members.discard(channel)
                        else:
                            continue

                        if len(members) >= 2:
                            start_recording()
                        elif len(members) <= 1:
                            stop_recording()
            finally:
                writer.close()
        except OSError:
            stop_recording()
            members.clear()
            await asyncio.sleep(3)


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

                # Без VAD Whisper транскрибирует даже чистую тишину (которой в
                # конференции большая часть времени, пока никто не говорит) и
                # на пустом входе типично выдаёт галлюцинации — утечки фраз из
                # обучающих субтитров ("Редактор субтитров...", "СПОКОЙНАЯ
                # МУЗЫКА"). vad_filter обрезает чанк до реальных речевых
                # отрезков (Silero VAD), на оставшейся тишине сегментов просто
                # не будет.
                segments, _ = model.transcribe(
                    chunk_path,
                    language="ru",
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=500),
                    condition_on_previous_text=False,
                )
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


@web.middleware
async def cors_middleware(request, handler):
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


async def list_recordings(request):
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for path in sorted(RECORDINGS_DIR.glob("call_*.wav"), key=lambda p: p.stat().st_mtime, reverse=True):
        # файл текущего незакрытого звонка не отдаём - wave-заголовок с
        # правильным размером пишется только при close()
        if current_wav_path is not None and path == current_wav_path:
            continue
        stat = path.stat()
        items.append({
            "name": path.name,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "url": f"/recordings/{path.name}",
        })
    return web.json_response(items)


async def get_recording(request):
    name = request.match_info["name"]
    if "/" in name or not name.startswith("call_") or not name.endswith(".wav"):
        raise web.HTTPNotFound()
    path = RECORDINGS_DIR / name
    if not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def start_http_server():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/api/recordings", list_recordings)
    app.router.add_get("/recordings/{name}", get_recording)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()


background_tasks = set()


def spawn(coro):
    # event loop хранит на Task только слабую ссылку - без явного сохранения
    # сильной ссылки сборщик мусора может собрать задачу прямо во время
    # выполнения ("Task was destroyed but it is pending!"), что на практике
    # и обрывало ami_loop сразу после логина на AMI.
    task = asyncio.create_task(coro)
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)
    return task


async def main():
    start_baresip()
    spawn(dial_loop())
    spawn(transcribe_loop())
    spawn(recording_tail_loop())
    spawn(ami_loop())
    await start_http_server()
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
