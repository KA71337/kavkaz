// Floating voice chat panel (bottom right). The WebRTC module is imported only on the first click,
// so nothing voice-related is downloaded or initialised before the player actually uses it.
import { $, esc, flagHtml, setHtml } from './dom.js';
import { toast } from './toast.js';
import { unlockAudio } from './sound.js';

let chat = null; // VoiceChat instance (lazy)
let loading = null;
let roster = []; // voice members known before joining (from session:join / voice:peers)
let listOpen = false;
let deps = null;

async function ensureChat() {
  if (chat) return chat;
  if (!loading) {
    loading = import('../voice/VoiceChat.js').then(({ VoiceChat }) => {
      chat = new VoiceChat({ ...deps, onChange: render });
      return chat;
    });
  }
  return loading;
}

export function bindVoice({ socket, request, on }) {
  deps = { socket, request, on };
  on('voice:peers', (list) => {
    roster = Array.isArray(list) ? list : [];
    render();
  });
  // publish the panel size so the HUD (declare button, side panel) leaves room for it
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(([entry]) => {
      const r = entry.target.getBoundingClientRect();
      const st = document.documentElement.style;
      st.setProperty('--voice-w', `${Math.round(r.width)}px`);
      st.setProperty('--voice-h', `${Math.round(r.height)}px`);
    }).observe($('#voice'));
  }
  $('#voice').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]');
    if (!b || b.disabled) return;
    unlockAudio();
    b.disabled = true;
    try {
      await handle(b.dataset.v);
    } finally {
      b.disabled = false;
      render();
    }
  });
  render();
}

async function handle(action) {
  if (action === 'list') {
    listOpen = !listOpen;
    return;
  }
  const vc = await ensureChat();
  if (action === 'join') {
    const r = await vc.join();
    if (!r.ok) toast(r.error, 'error');
  } else if (action === 'mic') {
    if (!vc.joined) {
      const r = await vc.join();
      if (!r.ok) return toast(r.error, 'error');
    }
    const r = await vc.setMic(!vc.mic);
    if (!r.ok) toast(r.error, 'error', 6000);
  } else if (action === 'deaf') {
    vc.setDeaf(!vc.deaf);
  } else if (action === 'unlock') {
    vc.unlockPlayback();
  } else if (action === 'leave') {
    vc.leave();
    listOpen = false;
  }
}

export function setVoiceRoster(list) {
  roster = Array.isArray(list) ? list : [];
  render();
}

/** Disconnect / screen change hooks. */
export function voiceSuspend() {
  return chat?.suspend() || null;
}
export function voiceResume(prev) {
  if (prev && chat) chat.resume(prev);
}
export function voiceLeave() {
  if (chat?.joined) chat.leave();
  listOpen = false;
  render();
}

function render() {
  const box = $('#voice');
  if (!box) return;
  const joined = !!chat?.joined;
  const peers = joined ? chat.peers : roster;
  const self = joined ? chat.self : null;
  const mic = !!chat?.mic;
  const deaf = !!chat?.deaf;
  box.classList.toggle('is-joined', joined);
  box.classList.toggle('list-open', listOpen);
  const talking = (id) => joined && chat.speaking.has(id);

  const chips = peers.length
    ? peers
        .map((p) => `<li class="v-peer ${talking(p.id) ? 'talking' : ''} ${p.mic ? 'mic-on' : ''}" title="${esc(p.name)}${p.mic ? ' · микрофон включён' : ' · микрофон выключен'}">
          <span class="v-ava">${p.country ? flagHtml(p.country, 'flag-sm') : '👤'}</span>
          <span class="v-name">${esc(p.name)}${p.id === self ? ' (вы)' : ''}</span>
          <span class="v-mic">${p.mic ? '🎙' : '🔇'}</span></li>`)
        .join('')
    : '<li class="v-empty">В голосовом чате никого нет</li>';

  const anyTalking = peers.some((p) => talking(p.id));
  let bar;
  if (!joined) {
    bar = `<button type="button" class="v-btn" data-v="join" title="Подключиться к голосовому чату (слушать)"><i>🎧</i><span>Голос</span></button>
      <button type="button" class="v-btn" data-v="mic" aria-pressed="false" title="Включить микрофон"><i>🎙</i><span>Микрофон</span></button>`;
  } else {
    bar = `<button type="button" class="v-btn ${mic ? 'on' : ''} ${talking(self) ? 'talking' : ''}" data-v="mic" aria-pressed="${mic}" title="${mic ? 'Выключить микрофон' : 'Включить микрофон'}"><i>🎙</i><span>${mic ? 'Микрофон вкл' : 'Микрофон'}</span></button>
      <button type="button" class="v-btn ${deaf ? 'off' : ''}" data-v="deaf" aria-pressed="${deaf}" title="${deaf ? 'Снова слышать игроков' : 'Не слышать игроков'}"><i>${deaf ? '🔇' : '🔊'}</i><span>${deaf ? 'Звук выкл' : 'Не слышать игроков'}</span></button>
      ${chat.needsUnlock ? '<button type="button" class="v-btn warn" data-v="unlock" title="Разрешить воспроизведение звука"><i>🔈</i><span>Включить звук</span></button>' : ''}
      <button type="button" class="v-btn v-leave" data-v="leave" title="Выйти из голосового чата"><i>⏻</i></button>`;
  }
  const count = `<button type="button" class="v-count ${anyTalking ? 'talking' : ''}" data-v="list" aria-expanded="${listOpen}" title="Игроки в голосовом чате">👥 <b>${peers.length}</b></button>`;

  setHtml(box, `<ul class="v-peers">${chips}</ul><div class="v-bar">${count}${bar}</div>`);
}
