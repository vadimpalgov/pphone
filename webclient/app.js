const params = new URLSearchParams(window.location.search);
const myExt = params.get('ext') || '1001';
const passwords = { '1001': '1001secret', '1002': '1002secret' };

document.getElementById('myExt').textContent = myExt;

const SIP_DOMAIN = 'pphone-sip.parfeon.ru';
const SIP_WS_URL = `wss://${SIP_DOMAIN}/ws`;
const TRANSCRIBE_WS_URL = `wss://pphone-transcribe.parfeon.ru/`;

const socket = new JsSIP.WebSocketInterface(SIP_WS_URL);
const ua = new JsSIP.UA({
  sockets: [socket],
  uri: `sip:${myExt}@${SIP_DOMAIN}`,
  password: passwords[myExt],
  session_timers: false,
});

const statusEl = document.getElementById('status');
const callBtn = document.getElementById('callBtn');
const hangupBtn = document.getElementById('hangupBtn');
const remoteAudio = document.getElementById('remoteAudio');
let currentSession = null;

ua.on('registered', () => statusEl.textContent = `зарегистрирован как ${myExt}`);
ua.on('unregistered', () => statusEl.textContent = 'не зарегистрирован');
ua.on('registrationFailed', (e) => statusEl.textContent = `ошибка регистрации: ${e.cause}`);

ua.on('newRTCSession', ({ session }) => {
  currentSession = session;
  hangupBtn.disabled = false;
  console.log('newRTCSession', session.direction, session);

  session.on('peerconnection', ({ peerconnection }) => {
    console.log('peerconnection', peerconnection);
    peerconnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };
    peerconnection.oniceconnectionstatechange = () =>
      console.log('iceConnectionState', peerconnection.iceConnectionState);
  });

  session.on('progress', () => console.log('session progress'));
  session.on('accepted', () => console.log('session accepted'));
  session.on('ended', (e) => { console.log('session ended', e.cause); currentSession = null; hangupBtn.disabled = true; });
  session.on('failed', (e) => { console.log('session failed', e.cause, e); currentSession = null; hangupBtn.disabled = true; });

  if (session.direction === 'incoming') {
    session.answer({ mediaConstraints: { audio: true, video: false } });
  }
});

ua.on('connecting', () => console.log('ua connecting'));
ua.on('connected', () => console.log('ua connected'));
ua.on('disconnected', (e) => console.log('ua disconnected', e));

window._debug = { ua, getSession: () => currentSession };

ua.start();

callBtn.onclick = () => {
  const target = document.getElementById('target').value.trim();
  if (!target) return;
  ua.call(`sip:${target}@${SIP_DOMAIN}`, { mediaConstraints: { audio: true, video: false } });
};

hangupBtn.onclick = () => {
  if (currentSession) currentSession.terminate();
};

// --- живая транскрипция (общая для demo_room) ---
const transcriptEl = document.getElementById('transcript');
let partialLine = null;

function connectTranscriptWs() {
  const ws = new WebSocket(TRANSCRIBE_WS_URL);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.is_final) {
      if (!partialLine) {
        partialLine = document.createElement('p');
        partialLine.className = 'partial';
        transcriptEl.appendChild(partialLine);
      }
      partialLine.textContent = msg.text;
    } else {
      if (partialLine) { partialLine.remove(); partialLine = null; }
      const p = document.createElement('p');
      p.textContent = msg.text;
      transcriptEl.appendChild(p);
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  };
  ws.onclose = () => setTimeout(connectTranscriptWs, 2000);
}
connectTranscriptWs();
