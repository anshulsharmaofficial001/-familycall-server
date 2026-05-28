const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const users = {};      // { username: { name, username, ws } }
const calls = {};      // { callId: { caller, callee, status, callerName } }
const audioChunks = {}; // { callId: [chunks] }

// === HTTP API ===

app.post('/api/register', (req, res) => {
  const { username, name } = req.body;
  if (!username || !name) return res.status(400).json({ error: 'Username and name required' });
  const key = username.toLowerCase();
  if (users[key]) return res.status(400).json({ error: 'Username already taken' });
  users[key] = { name, username, online: false };
  res.json({ success: true, user: { username, name } });
});

app.get('/api/users', (req, res) => {
  const list = Object.entries(users).map(([key, u]) => ({
    username: u.username, name: u.name, online: !!u.ws && u.ws.readyState === WebSocket.OPEN
  }));
  res.json(list);
});

app.get('/api/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, name: u.name, online: !!u.ws });
});

// === WebSocket ===

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const username = (url.searchParams.get('username') || '').toLowerCase();
  const name = url.searchParams.get('name');

  if (!username || !name) { ws.close(); return; }

  if (!users[username]) users[username] = { name, username };
  users[username].ws = ws;
  users[username].online = true;

  console.log(`${name} (@${username}) connected`);

  // Send welcome message
  ws.send(JSON.stringify({ type: 'welcome', username, name }));

  // Forward any pending calls
  for (const [cid, call] of Object.entries(calls)) {
    if (call.calleeUsername === username && call.status === 'ringing') {
      ws.send(JSON.stringify({ type: 'incoming_call', callId: cid, callerName: call.callerName, callerUsername: call.callerUsername }));
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg, username, name);
    } catch (e) { console.error('Bad message:', e.message); }
  });

  ws.on('close', () => {
    if (users[username]) users[username].ws = null;
    console.log(`${name} (@${username}) disconnected`);
  });
});

function handleMessage(ws, msg, username, name) {
  switch (msg.type) {
    case 'call': {
      const calleeKey = (msg.calleeUsername || '').toLowerCase();
      const callee = users[calleeKey];
      if (!callee) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      calls[callId] = { callId, callerUsername: username, calleeUsername: calleeKey, callerName: name, status: 'ringing' };

      ws.send(JSON.stringify({ type: 'call_created', callId }));

      if (callee.ws && callee.ws.readyState === WebSocket.OPEN) {
        callee.ws.send(JSON.stringify({ type: 'incoming_call', callId, callerName: name, callerUsername: username }));
      }
      break;
    }

    case 'accept_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'connected';
      const caller = users[call.callerUsername];
      if (caller && caller.ws) {
        caller.ws.send(JSON.stringify({ type: 'call_accepted', callId: msg.callId }));
      }
      break;
    }

    case 'reject_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'rejected';
      const caller = users[call.callerUsername];
      if (caller && caller.ws) {
        caller.ws.send(JSON.stringify({ type: 'call_rejected', callId: msg.callId }));
      }
      break;
    }

    case 'end_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'ended';
      const otherKey = call.callerUsername === username ? call.calleeUsername : call.callerUsername;
      const other = users[otherKey];
      if (other && other.ws) {
        other.ws.send(JSON.stringify({ type: 'call_ended', callId: msg.callId }));
      }
      delete audioChunks[msg.callId];
      delete calls[msg.callId];
      break;
    }

    case 'audio': {
      const call = calls[msg.callId];
      if (!call) return;
      const otherKey = call.callerUsername === username ? call.calleeUsername : call.callerUsername;
      const other = users[otherKey];
      if (other && other.ws && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify({ type: 'audio', callId: msg.callId, data: msg.data }));
      }
      break;
    }

    case 'ice_candidate': {
      const call = calls[msg.callId];
      if (!call) return;
      const otherKey = call.callerUsername === username ? call.calleeUsername : call.callerUsername;
      const other = users[otherKey];
      if (other && other.ws) {
        other.ws.send(JSON.stringify({ type: 'ice_candidate', callId: msg.callId, candidate: msg.candidate }));
      }
      break;
    }
  }
}

app.get('/call/:callId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`FamilyCall server running on http://localhost:${PORT}`);
});
