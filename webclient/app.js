const SIP_DOMAIN = 'pphone-sip.parfeon.ru';
const TRANSCRIBE_WS_URL = `wss://pphone-transcribe.parfeon.ru/`;
const ALL_CONTACTS = ['1001', '1002'];

const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const loginForm = document.getElementById('loginForm');
const loginExt = document.getElementById('loginExt');
const loginPass = document.getElementById('loginPass');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');
const myExtEl = document.getElementById('myExt');
const statusBadge = document.getElementById('statusBadge');
const contactsList = document.getElementById('contactsList');
const remoteAudio = document.getElementById('remoteAudio');

const incomingOverlay = document.getElementById('incomingOverlay');
const incomingFrom = document.getElementById('incomingFrom');
const acceptBtn = document.getElementById('acceptBtn');
const declineBtn = document.getElementById('declineBtn');

const activeCallBar = document.getElementById('activeCallBar');
const activeCallWith = document.getElementById('activeCallWith');
const activeCallState = document.getElementById('activeCallState');
const hangupBtn = document.getElementById('hangupBtn');

let ua = null;
let myExt = null;
let currentSession = null;

function setStatus(text, variant) {
  statusBadge.textContent = text;
  statusBadge.className = `badge rounded-pill bg-${variant}`;
}

function renderContacts() {
  contactsList.innerHTML = '';
  ALL_CONTACTS.filter((ext) => ext !== myExt).forEach((ext) => {
    const item = document.createElement('div');
    item.className = 'list-group-item';
    item.innerHTML = `
      <span><i class="bi bi-person-circle me-2 text-secondary"></i>${ext}</span>
      <button class="btn btn-success btn-sm rounded-circle call-btn-sm" aria-label="Позвонить ${ext}">
        <i class="bi bi-telephone-fill"></i>
      </button>`;
    item.querySelector('button').onclick = () => callNumber(ext);
    contactsList.appendChild(item);
  });
}

function showActiveCall(withWhom, state) {
  incomingOverlay.classList.add('d-none');
  activeCallBar.classList.remove('d-none');
  activeCallWith.textContent = withWhom;
  activeCallState.textContent = state;
}

function hideActiveCall() {
  activeCallBar.classList.add('d-none');
}

function showIncoming(from) {
  incomingFrom.textContent = from;
  incomingOverlay.classList.remove('d-none');
}

function hideIncoming() {
  incomingOverlay.classList.add('d-none');
}

function wireSession(session, withWhom) {
  session.on('peerconnection', ({ peerconnection }) => {
    peerconnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };
  });
  // 'progress' срабатывает и на входящей стороне (это означает лишь, что
  // сами отправили 180 Ringing) — для incoming до реального answer() не
  // трогаем экран, там остаётся оверлей "входящий звонок".
  if (session.direction === 'outgoing') {
    session.on('progress', () => showActiveCall(withWhom, 'вызов...'));
  }
  session.on('accepted', () => showActiveCall(withWhom, 'в разговоре'));
  session.on('confirmed', () => showActiveCall(withWhom, 'в разговоре'));
  session.on('ended', () => { currentSession = null; hideActiveCall(); hideIncoming(); });
  session.on('failed', () => { currentSession = null; hideActiveCall(); hideIncoming(); });
}

function callNumber(target) {
  if (!ua || currentSession) return;
  currentSession = ua.call(`sip:${target}@${SIP_DOMAIN}`, { mediaConstraints: { audio: true, video: false } });
  showActiveCall(target, 'вызов...');
  wireSession(currentSession, target);
}

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

  ua.on('registered', () => { setStatus('на линии', 'success'); loginError.textContent = ''; });
  ua.on('unregistered', () => setStatus('нет сети', 'secondary'));
  ua.on('registrationFailed', (e) => {
    setStatus('ошибка', 'danger');
    sessionStorage.removeItem('pphone_ext');
    sessionStorage.removeItem('pphone_pass');
    showLogin(`Не удалось войти: ${e.cause}`);
  });

  ua.on('newRTCSession', ({ session }) => {
    if (session.direction !== 'incoming') return;
    if (currentSession) { session.terminate(); return; }

    currentSession = session;
    const from = session.remote_identity.uri.user;
    showIncoming(from);
    wireSession(session, from);

    acceptBtn.onclick = () => session.answer({ mediaConstraints: { audio: true, video: false } });
    declineBtn.onclick = () => session.terminate();
  });

  ua.start();
}

function showMain(ext) {
  myExt = ext;
  myExtEl.textContent = ext;
  loginScreen.classList.add('d-none');
  mainScreen.classList.remove('d-none');
  renderContacts();
}

function showLogin(errorText) {
  loginScreen.classList.remove('d-none');
  mainScreen.classList.add('d-none');
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
