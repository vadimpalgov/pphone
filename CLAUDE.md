# pPhone — обзор проекта

Самодельная мини-PBX: два веб-клиента (1001, 1002) звонят друг другу через
Asterisk по WebRTC, разговор слушает headless SIP-бот, который гонит живую
транскрипцию в браузер и пишет запись звонка на диск. Всё живёт в
docker-compose за общим Traefik на хосте.

## Компоненты (docker-compose.yml)

- **asterisk** (`asterisk/`) — Asterisk 20, собран из исходников в
  Dockerfile. PJSIP + ConfBridge. Единственный порт, торчащий наружу напрямую
  (не через Traefik) — `10000-10200/udp` (RTP); SIP/WS и AMI идут только
  через Traefik/внутреннюю сеть.
- **transcriber** (`transcriber/`, `bot.py`) — headless SIP-клиент на
  `baresip` + Python-обвязка (aiohttp + websockets). Звонит на exten `9000`,
  сидит в конференции постоянно, слушает AMI, транскрибирует через
  `faster-whisper`, пишет .wav записи звонков, отдаёт HTTP API записей и
  WS с live-транскрипцией.
- **webclient** (`webclient/`) — статика (nginx): `index.html` + `app.js`
  (JsSIP) + `style.css`. Два контакта: 1001, 1002.

Сети: `backend` (внутренняя, docker-managed) и `traefik` — внешняя сеть
(создана и управляется отдельным compose-проектом `traefik` на хосте,
имя сети в `docker network ls` на проде — ровно `traefik`).

Домены (через Traefik, TLS letsencrypt):
- `pphone.parfeon.ru` → webclient
- `pphone-sip.parfeon.ru` → asterisk:8088 (SIP over WS, путь `/ws`)
- `pphone-transcribe.parfeon.ru` → transcriber:8765 (WS живой транскрипции)
- `pphone-recordings.parfeon.ru` → transcriber:8766 (HTTP API записей)

## Звонок: как это устроено

1. Браузер (JsSIP) логинится как `1001` или `1002` на `wss://pphone-sip.../ws`.
2. Набор номера → `Dial(PJSIP/${EXTEN},20,G(ringresult^1))`
   (`asterisk/conf/extensions.conf`). Когда вызываемый отвечает, `G()`
   переводит **оба** плеча на `confjoin` → оба попадают в один и тот же
   `ConfBridge(demo_room,...)`.
3. Бот-транскрайбер всегда сидит в `demo_room` (заходит через exten `9000`
   сразу при старте контейнера и не выходит).
4. Когда в конференции становится ≥2 "настоящих" участников (не бот, не
   announcement-канал) — транскрайбер начинает писать .wav; когда участников
   становится 0 — закрывает файл. Детектится через AMI-события
   `ConfbridgeJoin`/`ConfbridgeLeave` (см. `is_real_participant()` в
   `bot.py`).
5. Транскрипция идёт независимо от записи — читает тот же сырой PCM-поток
   (`/rec/call.raw`, пишется `parec` из null-sink'а PulseAudio, в который
   `baresip` играет микс конференции) чанками по 4 сек через Whisper
   (`base`, int8, CPU), с VAD-фильтром (без VAD на тишине Whisper
   генерирует "музыкальные" галлюцинации).

### WebRTC / ICE специфика

- `transport-ws` в `pjsip.conf` явно переписывает
  `external_media_address`/`external_signaling_address` на публичный IP —
  иначе Asterisk рекламирует свой internal docker-IP, который браузер
  снаружи не достанет.
- ICE host-кандидаты для самого RTP-движка Asterisk генерируются **при
  каждом старте контейнера** в `entrypoint.sh` →
  `/etc/asterisk/ice_host_candidates.conf` (маппинг локальный-docker-IP →
  публичный IP), т.к. docker не гарантирует, что IP контейнера останется
  тем же между пересозданиями. Статически прописывать их в `rtp.conf`
  нельзя — именно это один раз и уронило ICE/STUN на проде.
- Клиентский `PC_CONFIG` в `app.js` обязательно включает STUN
  (`stun:stun.l.google.com:19302`) — без него браузер за NAT не видит
  своих публичных кандидатов и ICE не устанавливается, хотя SIP-сигнализация
  при этом отрабатывает нормально (ложное ощущение, что "звонок прошёл").
- 1001/1002 — зеркальные WebRTC-эндпоинты (`webrtc=yes`,
  `dtls_setup=actpass`, `dtls_verify=no`, общий `transport-ws`). Бот —
  обычный SIP/UDP эндпоинт без WebRTC (`transport-udp`), т.к. `baresip`
  говорит на plain RTP.
- WS keepalive: браузер раз в 12с шлёт голый `\r\n\r\n` прямо в сырой
  WebSocket (recognised SIP-over-WS ping), т.к. Asterisk рвёт WS-транспорт
  без трафика за ~32с, а честный SIP OPTIONS/короткий register_expires
  пробовали раньше и оба давали побочку (contact помечался Unreachable /
  транспорт пересоздавался прямо во время звонка).

### AMI

`manager.conf`: пользователь `transcriber`, слушает только на backend-сети
(порт не опубликован в compose). Нужен исключительно транскрайберу, чтобы
резать запись по `ConfbridgeJoin`/`ConfbridgeLeave`.

### Редайл бота

Если звонок бота в `demo_room` обрывается (например, Asterisk
пересоздали при деплое), сам бот этого не замечает. `redial_supervisor()`
в `bot.py` раз в 15с проверяет `bot_in_room` (обновляется из AMI-событий) и
передозванивает, если бота не видно в комнате дольше окна на установление
звонка.

## Известные грабли / история

- Если после ребута хоста стек pPhone не поднимается (контейнеров нет
  вообще, не "упали", а не создались) — первым делом проверяй
  `docker network ls` и что внешняя прокси-сеть `traefik`, на которую
  ссылается `docker-compose.yml` (`networks.traefik: external: true`),
  существует и называется именно так.
- Random docker hostname, начинающийся с цифры, ломал SIP `From`-заголовок
  (JsSIP тихо ронял такой INVITE) — поэтому у `asterisk`-сервиса явно задан
  `hostname: pphone-asterisk`.
- `Task was destroyed but it is pending!` — asyncio-таски в `bot.py` нужно
  держать за сильную ссылку (`background_tasks` set + `spawn()`), иначе GC
  может собрать таск прямо во время работы (так рвался `ami_loop`).
- На первом тестовом звонке счётчик участников конференции не опускался до
  0 — бот и announcement-канал (`CBAnn/...`) тоже шлют
  `ConfbridgeJoin/Leave`; фильтруются в `is_real_participant()`.

## Текущие временные флаги / открытые вопросы

- **`ENABLE_RECORDING=false`** (docker-compose.yml, окружение
  `transcriber`) — запись звонков **временно выключена** (2026-10-04),
  проверяем гипотезу, что звонок + Whisper-транскрибация + запись
  одновременно не укладываются в ресурсы сервера. Транскрипция при этом
  продолжает работать как обычно. Включить обратно — убрать переменную или
  выставить `"true"`.
- **Открытый баг:** на двух разных устройствах/браузерах при звонке был
  слышен только один абонент (второй не слышал первого). Не переподтверждён
  на свежем звонке — нужно воспроизвести и разобрать логи Asterisk per-leg
  (RTP/SRTP/DTLS) для обоих участников.
- **Жалоба:** в Safari кнопка "Принять звонок" не нажимается. Не
  переподтверждена на живом сервисе. Если воспроизведётся — смотреть
  `acceptBtn.onclick` в `wireSession()`/`newRTCSession` (`app.js`), а также
  autoplay-политику Safari для `remoteAudio` (srcObject ставится
  асинхронно в `ontrack`, вне исходного user-gesture от клика).

## Полезные команды

```sh
docker compose up -d --build        # пересобрать и поднять весь стек
docker logs pphone-asterisk --tail 100
docker logs pphone-transcriber --tail 100
docker exec pphone-transcriber printenv ENABLE_RECORDING
```

Учётки (дев-стенд, не продовые секреты): веб-клиенты `1001`/`1001secret`,
`1002`/`1002secret`; бот `bot`/`botsecret`; AMI `transcriber`/`amisecret`.
