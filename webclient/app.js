const SIP_DOMAIN = 'pphone-sip.parfeon.ru';
const TRANSCRIBE_WS_URL = `wss://pphone-transcribe.parfeon.ru/`;
const RECORDINGS_BASE_URL = 'https://pphone-recordings.parfeon.ru';
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

// Без STUN браузер знает только свои приватные host-кандидаты -> ICE между
// браузером (за NAT) и публичным Asterisk не устанавливается (connectionState
// уходит в failed, звука нет, хотя SIP-сигнализация отрабатывает нормально).
const PC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function setStatus(text, variant) {
  statusBadge.textContent = text;
  statusBadge.className = `status-pill status-pill--${variant}`;
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
  session.on('ended', () => { currentSession = null; hideActiveCall(); hideIncoming(); setTimeout(loadRecordings, 3000); });
  session.on('failed', () => { currentSession = null; hideActiveCall(); hideIncoming(); });
}

function callNumber(target) {
  if (!ua || currentSession) return;
  currentSession = ua.call(`sip:${target}@${SIP_DOMAIN}`, { mediaConstraints: { audio: true, video: false }, pcConfig: PC_CONFIG });
  showActiveCall(target, 'вызов...');
  wireSession(currentSession, target);
}

let keepAliveTimer = null;

function startUA(ext, password) {
  const socket = new JsSIP.WebSocketInterface(`wss://${SIP_DOMAIN}/ws`);
  ua = new JsSIP.UA({
    sockets: [socket],
    uri: `sip:${ext}@${SIP_DOMAIN}`,
    password,
    session_timers: false,
  });

  // Asterisk обрывает WS-транспорт без трафика за ~32с (idle reap в
  // res_pjsip). Пробовали qualify_frequency на сервере (Asterisk не получил
  // ответ на OPTIONS через WS и помечал контакт Unreachable) и короткий
  // SIP register_expires на клиенте (недостаточный запас против таймера
  // браузера приводил к редким пересозданиям транспорта прямо во время
  // звонка). Вместо этого шлём "голый" double-CRLF ping прямо в сырой
  // WebSocket — это recognised SIP-over-WS keepalive, не трогающий
  // регистрацию и состояние контакта вообще.
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    const rawWs = ua && ua._transport && ua._transport.socket && ua._transport.socket._ws;
    if (rawWs && rawWs.readyState === WebSocket.OPEN) rawWs.send('\r\n\r\n');
  }, 12000);

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

    acceptBtn.onclick = () => session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: PC_CONFIG });
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
  loadRecordings();
}

// --- переключение секций левой навигацией ---
document.querySelectorAll('.nav-rail-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav-rail-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel-section').forEach((t) => t.classList.add('d-none'));
    document.getElementById(`tab${btn.dataset.tab.charAt(0).toUpperCase()}${btn.dataset.tab.slice(1)}`).classList.remove('d-none');
  };
});

// --- панель "добавить специалиста в звонок" (детская больница, заглушка) ---
// Чисто визуальная заглушка: реального добавления в SIP-конференцию пока
// нет, кнопка "+" только помечает врача приглашённым в этом UI.
const HOSPITALS = [
  {
    name: 'БУЗ ВО «Воронежская областная детская клиническая больница №1»',
    doctors: [
      { name: 'Иванова Елена Сергеевна', specialty: 'Педиатр' },
      { name: 'Кузнецов Андрей Викторович', specialty: 'Кардиолог' },
      { name: 'Смирнова Ольга Павловна', specialty: 'Невролог' },
    ],
  },
  {
    name: 'БУЗ ВО «Городская детская клиническая больница №1»',
    doctors: [
      { name: 'Петров Дмитрий Игоревич', specialty: 'Хирург' },
      { name: 'Васильева Марина Олеговна', specialty: 'Реаниматолог' },
      { name: 'Соколов Артём Николаевич', specialty: 'Пульмонолог' },
    ],
  },
  {
    name: 'БУЗ ВО «Городская детская клиническая больница №2»',
    doctors: [
      { name: 'Морозова Татьяна Андреевна', specialty: 'Эндокринолог' },
      { name: 'Волков Сергей Петрович', specialty: 'Гастроэнтеролог' },
      { name: 'Лебедева Анна Дмитриевна', specialty: 'Инфекционист' },
    ],
  },
  {
    name: 'БУЗ ВО «Детская клиническая больница №7»',
    doctors: [
      { name: 'Новикова Виктория Романовна', specialty: 'ЛОР' },
      { name: 'Фёдоров Максим Сергеевич', specialty: 'Ортопед' },
      { name: 'Егорова Ксения Валерьевна', specialty: 'Офтальмолог' },
    ],
  },
];

const hospitalSearch = document.getElementById('hospitalSearch');
const specialtyFiltersEl = document.getElementById('specialtyFilters');
const hospitalListEl = document.getElementById('hospitalList');
const invitedListEl = document.getElementById('invitedList');

const ALL_SPECIALTIES = ['Все', ...new Set(HOSPITALS.flatMap((h) => h.doctors.map((d) => d.specialty)))];
let activeSpecialty = 'Все';
const invited = new Set();

function renderSpecialtyFilters() {
  specialtyFiltersEl.innerHTML = '';
  ALL_SPECIALTIES.forEach((s) => {
    const chip = document.createElement('button');
    chip.className = `chip${s === activeSpecialty ? ' active' : ''}`;
    chip.textContent = s;
    chip.onclick = () => { activeSpecialty = s; renderSpecialtyFilters(); renderHospitalList(); };
    specialtyFiltersEl.appendChild(chip);
  });
}

function renderInvitedList() {
  if (invited.size === 0) {
    invitedListEl.innerHTML = 'пока никого';
    return;
  }
  invitedListEl.innerHTML = '';
  invited.forEach((key) => {
    const [docName] = key.split('@@');
    const pill = document.createElement('span');
    pill.className = 'invited-pill';
    pill.innerHTML = `${docName} <button aria-label="Убрать"><i class="bi bi-x-circle"></i></button>`;
    pill.querySelector('button').onclick = () => { invited.delete(key); renderInvitedList(); renderHospitalList(); };
    invitedListEl.appendChild(pill);
  });
}

function renderHospitalList() {
  const query = hospitalSearch.value.trim().toLowerCase();
  hospitalListEl.innerHTML = '';
  HOSPITALS.forEach((hospital) => {
    const doctors = hospital.doctors.filter((d) => {
      if (activeSpecialty !== 'Все' && d.specialty !== activeSpecialty) return false;
      if (!query) return true;
      return d.name.toLowerCase().includes(query) || d.specialty.toLowerCase().includes(query) || hospital.name.toLowerCase().includes(query);
    });
    if (!doctors.length) return;

    const group = document.createElement('details');
    group.className = 'hospital-group';
    group.open = !!query || activeSpecialty !== 'Все';

    const summary = document.createElement('summary');
    summary.innerHTML = `<span><i class="bi bi-hospital me-1 text-primary"></i>${hospital.name}</span><span class="badge bg-secondary rounded-pill">${doctors.length}</span>`;
    group.appendChild(summary);

    doctors.forEach((d) => {
      const key = `${d.name}@@${hospital.name}`;
      const row = document.createElement('div');
      row.className = 'doctor-row';
      const isInvited = invited.has(key);
      row.innerHTML = `
        <span>
          <span class="doctor-name d-block">${d.name}</span>
          <span class="doctor-specialty">${d.specialty}</span>
        </span>
        <button class="btn btn-sm ${isInvited ? 'btn-success' : 'btn-outline-primary'} rounded-circle call-btn-sm" aria-label="Добавить в звонок">
          <i class="bi bi-${isInvited ? 'check-lg' : 'plus-lg'}"></i>
        </button>`;
      row.querySelector('button').onclick = () => {
        if (invited.has(key)) invited.delete(key); else invited.add(key);
        renderInvitedList();
        renderHospitalList();
      };
      group.appendChild(row);
    });

    hospitalListEl.appendChild(group);
  });
}

hospitalSearch.oninput = renderHospitalList;
renderSpecialtyFilters();
renderHospitalList();
renderInvitedList();

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
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  sessionStorage.removeItem('pphone_ext');
  sessionStorage.removeItem('pphone_pass');
  showLogin();
};

hangupBtn.onclick = () => {
  if (currentSession) currentSession.terminate();
};

// --- записи звонков ---
const recordingsList = document.getElementById('recordingsList');
const refreshRecordingsBtn = document.getElementById('refreshRecordingsBtn');

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

function formatDate(mtime) {
  return new Date(mtime * 1000).toLocaleString('ru-RU');
}

async function loadRecordings() {
  try {
    const res = await fetch(`${RECORDINGS_BASE_URL}/api/recordings`);
    const items = await res.json();
    recordingsList.innerHTML = '';
    if (!items.length) {
      recordingsList.innerHTML = '<div class="list-group-item text-secondary small">записей пока нет</div>';
      return;
    }
    items.forEach((item) => {
      const fileUrl = `${RECORDINGS_BASE_URL}${item.url}`;
      const row = document.createElement('div');
      row.className = 'list-group-item';
      row.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mb-1">
          <span class="small">${formatDate(item.mtime)}</span>
          <div class="d-flex align-items-center gap-2">
            <span class="small text-secondary">${formatSize(item.size)}</span>
            <a href="${fileUrl}" download class="btn btn-sm btn-outline-secondary py-0 px-2" aria-label="Скачать"><i class="bi bi-download"></i></a>
            <button class="btn btn-sm btn-outline-danger py-0 px-2 deleteRecordingBtn" aria-label="Удалить"><i class="bi bi-trash"></i></button>
          </div>
        </div>
        <audio controls preload="none" class="w-100" src="${fileUrl}"></audio>`;
      row.querySelector('.deleteRecordingBtn').onclick = () => deleteRecording(item.name, fileUrl);
      recordingsList.appendChild(row);
    });
  } catch (e) {
    recordingsList.innerHTML = '<div class="list-group-item text-danger small">не удалось загрузить список</div>';
  }
}

refreshRecordingsBtn.onclick = loadRecordings;

async function deleteRecording(name, fileUrl) {
  if (!confirm('Удалить эту запись?')) return;
  try {
    await fetch(fileUrl, { method: 'DELETE' });
  } finally {
    loadRecordings();
  }
}

// --- живая транскрипция (общая для demo_room) ---
const transcriptEl = document.getElementById('transcript');
const clearTranscriptBtn = document.getElementById('clearTranscriptBtn');
let partialLine = null;

clearTranscriptBtn.onclick = () => {
  transcriptEl.innerHTML = '';
  partialLine = null;
};

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
