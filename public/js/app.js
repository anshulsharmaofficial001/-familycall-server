const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');
const statusDetail = document.getElementById('statusDetail');
const incomingCall = document.getElementById('incomingCall');
const inCall = document.getElementById('inCall');
const callerName = document.getElementById('callerName');
const inCallName = document.getElementById('inCallName');
const callTimer = document.getElementById('callTimer');
const setupBox = document.getElementById('setupBox');
const statusBox = document.getElementById('statusBox');

const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null;
let currentCallId = null;
let timerInterval = null;
let seconds = 0;
let myUsername = null;
let audioContext = null;
let scriptProcessor = null;
let micStream = null;
let audioQueue = [];
let isPlaying = false;
let playbackNode = null;

function setStatus(icon, text, detail) {
  statusIcon.textContent = icon;
  statusText.textContent = text;
  statusDetail.textContent = detail;
}

function connectWebSocket(username, name) {
  const url = `${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('✅', 'Connected', 'Ready for calls');
    statusBox.style.display = 'block';
    setupBox.style.display = 'none';
  };

  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); }
    catch (e) { console.error('Bad message:', e); }
  };

  ws.onclose = () => {
    if (currentCallId) endCall();
    setStatus('🔴', 'Disconnected', 'Reconnecting...');
    statusBox.style.display = 'block';
    setTimeout(() => connectWebSocket(username, name), 3000);
  };

  ws.onerror = () => { ws.close(); };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myUsername = msg.username;
      break;

    case 'incoming_call':
      if (currentCallId) {
        ws.send(JSON.stringify({ type: 'reject_call', callId: msg.callId }));
        return;
      }
      currentCallId = msg.callId;
      callerName.textContent = msg.callerName || 'Family Member';
      incomingCall.style.display = 'block';
      statusBox.style.display = 'none';
      break;

    case 'call_created':
      currentCallId = msg.callId;
      document.getElementById('callStatusText').textContent = 'Ringing...';
      break;

    case 'call_accepted':
      document.getElementById('callStatusText').textContent = 'Connected';
      incomingCall.style.display = 'none';
      statusBox.style.display = 'none';
      inCall.style.display = 'block';
      startAudioStream();
      break;

    case 'call_rejected':
      resetUI();
      setStatus('😔', 'Call rejected', 'The person declined your call');
      currentCallId = null;
      setTimeout(() => setStatus('✅', 'Connected', 'Ready for calls'), 3000);
      break;

    case 'call_ended':
      cleanupAudio();
      resetUI();
      setStatus('✅', 'Call ended', 'Ready for calls');
      break;

    case 'audio':
      if (currentCallId === msg.callId && msg.data) {
        audioQueue.push(msg.data);
        if (!isPlaying) playNextAudio();
      }
      break;
  }
}

function startAudioStream() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      micStream = stream;
      const source = audioContext.createMediaStreamSource(stream);
      const sampleRate = audioContext.sampleRate;

      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

      scriptProcessor.onaudioprocess = (event) => {
        if (!currentCallId) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm16 = float32ToInt16(input);
        const base64 = arrayBufferToBase64(pcm16.buffer);
        ws.send(JSON.stringify({ type: 'audio', callId: currentCallId, data: base64 }));
      };
    }).catch(e => {
      console.error('Mic error:', e);
    });
  } catch (e) {
    console.error('Audio error:', e);
  }
}

function float32ToInt16(float32) {
  const len = float32.length;
  const int16 = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

function int16ToFloat32(int16) {
  const len = int16.length;
  const float32 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function playNextAudio() {
  if (audioQueue.length === 0 || !audioContext) {
    isPlaying = false;
    return;
  }
  isPlaying = true;

  try {
    const base64 = audioQueue.shift();
    const buffer = base64ToArrayBuffer(base64);
    const int16 = new Int16Array(buffer);
    const float32 = int16ToFloat32(int16);

    const audioBuffer = audioContext.createBuffer(1, float32.length, audioContext.sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    playbackNode = audioContext.createBufferSource();
    playbackNode.buffer = audioBuffer;
    playbackNode.connect(audioContext.destination);
    playbackNode.onended = () => playNextAudio();
    playbackNode.start();
  } catch (e) {
    console.error('Playback error:', e);
    playNextAudio();
  }
}

function startTimer() {
  seconds = 0;
  timerInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    callTimer.textContent = `${m}:${s}`;
  }, 1000);
}

function endCall() {
  if (currentCallId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_call', callId: currentCallId }));
  }
  cleanupAudio();
  resetUI();
}

function cleanupAudio() {
  if (timerInterval) clearInterval(timerInterval);
  if (scriptProcessor) scriptProcessor.disconnect();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (playbackNode) { try { playbackNode.stop(); } catch(e) {} }
  if (audioContext) audioContext.close();
  audioContext = null;
  scriptProcessor = null;
  micStream = null;
  playbackNode = null;
  audioQueue = [];
  isPlaying = false;
  timerInterval = null;
  currentCallId = null;
}

function resetUI() {
  inCall.style.display = 'none';
  incomingCall.style.display = 'none';
  statusBox.style.display = 'block';
}

document.getElementById('acceptBtn').onclick = () => {
  if (currentCallId && ws) {
    ws.send(JSON.stringify({ type: 'accept_call', callId: currentCallId }));
    incomingCall.style.display = 'none';
    inCallName.textContent = callerName.textContent;
    inCall.style.display = 'block';
    startTimer();
    startAudioStream();
  }
};

document.getElementById('declineBtn').onclick = () => {
  if (currentCallId && ws) {
    ws.send(JSON.stringify({ type: 'reject_call', callId: currentCallId }));
  }
  currentCallId = null;
  resetUI();
};

document.getElementById('endCallBtn').onclick = endCall;

document.getElementById('muteBtn').onclick = function() {
  if (micStream) {
    const enabled = !micStream.getAudioTracks()[0].enabled;
    micStream.getAudioTracks()[0].enabled = enabled;
    this.style.opacity = enabled ? '1' : '0.5';
  }
};

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  const btn = document.getElementById('installBtn') || (() => {
    const b = document.createElement('button');
    b.id = 'installBtn';
    b.className = 'btn-install';
    b.textContent = '📲 Install App';
    document.getElementById('setupBox').appendChild(b);
    return b;
  })();
  btn.onclick = async () => {
    installPrompt.prompt();
    const result = await installPrompt.userChoice;
    if (result.outcome === 'accepted') setStatus('✅', 'App installed!', 'You can now receive calls like a real app');
    installPrompt = null;
    btn.remove();
  };
});

(async function init() {
  setStatus('📡', 'Connecting...', 'Setting up');

  const urlParts = window.location.pathname.match(/\/call\/(.+)/);
  const callIdFromUrl = urlParts ? urlParts[1] : null;

  let username = localStorage.getItem('familycall_username');
  let name = localStorage.getItem('familycall_name');
  if (!username || !name) {
    username = prompt('Choose your username:');
    if (!username) return;
    name = prompt('Enter your name:');
    if (!name) return;
    localStorage.setItem('familycall_username', username);
    localStorage.setItem('familycall_name', name);
  }

  connectWebSocket(username, name);

  // Call button handler
  document.getElementById('callBtn').onclick = () => {
    const target = document.getElementById('calleeInput').value.trim();
    if (!target) return;
    currentCallId = 'calling_' + Date.now();
    ws.send(JSON.stringify({ type: 'call', calleeUsername: target }));
    document.getElementById('inCallName').textContent = '@' + target;
    document.getElementById('callStatusText').textContent = 'Calling...';
    inCall.style.display = 'block';
    statusBox.style.display = 'none';
    startTimer();
  };

  // Handle Enter key in input
  document.getElementById('calleeInput').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('callBtn').click();
  };
})();
