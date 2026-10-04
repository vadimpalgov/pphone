const SIP_DOMAIN = 'pphone-sip.parfeon.ru';
const TRANSCRIBE_WS_URL = `wss://pphone-transcribe.parfeon.ru/`;

const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const loginForm = document.getElementById('loginForm');
const loginExt = document.getElementById('loginExt');
const loginPass = document.getElementById('loginPass');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

const statusEl = document.getElementById('status');
const callBtn = document.getElementById('callBtn');
const hangupBtn = document.getElementById('hangupBtn');
const remoteAudio = document.getElementById('remoteAudio');
const myExtEl = document.getElementById('myExt');

let ua = null;
let currentSession = null;

function startUA(ext, password) {
  const socket = new JsSIP.WebSocketInterface(`wss://${SIP_DOMAIN}/ws`);
  ua = new JsSIP.UA({
    sockets: [socket],
    uri: `sip:${ext}@${SIP_DOMAIN}`,
    password,
    session_timers: false,
    // Asterisk обрывает WS-транспорт без трафика за 32с (idle reap в
    // res_pjsip). JsSIP сам не шлёт keepalive-пинги, поэтому держим
    // короткий register_expires — REGISTER-рефреш не даст транспорту заснуть.
    register_expires: 20,
  });

  ua.on('registered', () => { statusEl.textContent = `зарегистрирован как ${ext}`; loginError.textContent = ''; });
  ua.on('unregistered', () => statusEl.textContent = 'не зарегистрирован');
  ua.on('registrationFailed', (e) => {
    statusEl.textContent = `ошибка регистрации: ${e.cause}`;
    sessionStorage.removeItem('pphone_ext');
    sessionStorage.removeItem('pphone_pass');
    showLogin(`Не удалось войти: ${e.cause}`);
  });

  ua.on('newRTCSession', ({ session }) => {
    currentSession = session;
    hangupBtn.disabled = false;

    session.on('peerconnection', ({ peerconnection }) => {
      peerconnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
      };
    });

    session.on('ended', () => { currentSession = null; hangupBtn.disabled = true; });
    session.on('failed', () => { currentSession = null; hangupBtn.disabled = true; });

    if (session.direction === 'incoming') {
      session.answer({ mediaConstraints: { audio: true, video: false } });
    }
  });

  ua.start();
}

function showMain(ext) {
  myExtEl.textContent = ext;
  loginScreen.style.display = 'none';
  mainScreen.style.display = '';
}

function showLogin(errorText) {
  loginScreen.style.display = '';
  mainScreen.style.display = 'none';
  loginError.textContent = errorText || '';
}

function login(ext, password) {
  sessionStorage.setItem('pphone_ext', ext);
  sessionStorage.setItem('pphone_pass', password);
  showMain(ext);
  startUA(ext, password);
}

loginForm.onsubmit = (e) => {
  e.preventDefault();
  const ext = loginExt.value.trim();
  const password = loginPass.value;
  if (!ext || !password) return;
  login(ext, password);
};

logoutBtn.onclick = () => {
  if (currentSession) currentSession.terminate();
  if (ua) ua.stop();
  ua = null;
  sessionStorage.removeItem('pphone_ext');
  sessionStorage.removeItem('pphone_pass');
  showLogin();
};

callBtn.onclick = () => {
  const target = document.getElementById('target').value.trim();
  if (!target || !ua) return;
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

// автологин, если в этой вкладке уже входили (sessionStorage, не переживает закрытие вкладки)
const savedExt = sessionStorage.getItem('pphone_ext');
const savedPass = sessionStorage.getItem('pphone_pass');
if (savedExt && savedPass) {
  login(savedExt, savedPass);
} else {
  showLogin();
}
