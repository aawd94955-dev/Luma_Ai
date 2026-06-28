const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ── 명령 큐: { sessionId -> [commands] } ──────────────────────
const commandQueues = {};
const commandResults = {};

// 세션 마지막 접근 시간 (배열에 프로퍼티 붙이지 않고 별도 Map 사용)
const sessionLastAccess = {};

// 큐 자동 정리 (10분 이상 된 세션 제거)
setInterval(() => {
  const now = Date.now();
  for (const sid in sessionLastAccess) {
    if (now - sessionLastAccess[sid] > 600000) {
      delete commandQueues[sid];
      delete commandResults[sid];
      delete sessionLastAccess[sid];
    }
  }
}, 60000);

function getQueue(sessionId) {
  if (!commandQueues[sessionId]) {
    commandQueues[sessionId] = [];
  }
  sessionLastAccess[sessionId] = Date.now();
  return commandQueues[sessionId];
}

// ── RobLuma 시스템 프롬프트 ────────────────────────────────────
const ROBLUMA_SYSTEM = `당신은 RobLuma입니다. Roblox Studio 전용 AI 어시스턴트입니다.
사이트↔플러그인 방식으로 작동합니다: 당신이 생성한 액션이 Roblox Studio 플러그인으로 전송되어 직접 실행됩니다.

[수행 가능한 기능]
1. 파일 읽기: Roblox Studio의 스크립트/모델 내용 읽기
2. 블록(파트) 넣기: Workspace에 파트, 모델 배치
3. UI 생성: StarterGui에 ScreenGui, Frame, TextButton 등 직접 생성 (스크립트로 동적 생성 금지)
4. 스크립트 생성: Script, LocalScript, ModuleScript 생성 및 삽입
5. 프로퍼티 수정: 인스턴스 속성 변경

[응답 규칙 - 반드시 준수]
액션이 필요한 경우 반드시 응답 끝에 아래 형식으로 액션 블록을 포함하세요.

파트 삽입:
ACTION_START
{"type":"INSERT_PART","data":{"name":"파트이름","className":"Part","parent":"Workspace","properties":{"Size":"Vector3.new(4,1,4)","BrickColor":"BrickColor.new('Bright red')","Anchored":true}}}
ACTION_END

스크립트 생성:
ACTION_START
{"type":"CREATE_SCRIPT","data":{"name":"스크립트이름","scriptType":"Script","parent":"ServerScriptService","source":"-- 코드\nprint('Hello')"}}
ACTION_END

GUI 생성 (StarterGui에 직접):
ACTION_START
{"type":"CREATE_GUI","data":{"name":"MyGui","parent":"StarterGui","tree":{"className":"ScreenGui","name":"MyGui","children":[{"className":"Frame","name":"MainFrame","properties":{"Size":"UDim2.new(0.3,0,0.4,0)","Position":"UDim2.new(0.35,0,0.3,0)","BackgroundColor3":"Color3.fromRGB(30,30,30)"},"children":[{"className":"TextLabel","name":"Title","properties":{"Text":"안녕하세요","Size":"UDim2.new(1,0,0.2,0)","TextColor3":"Color3.fromRGB(255,255,255)"}}]}]}}}
ACTION_END

파일 읽기:
ACTION_START
{"type":"READ_FILE","data":{"target":"ServerScriptService.MyScript"}}
ACTION_END

액션이 여러 개면 여러 블록을 순서대로 작성하세요.
항상 한국어로 답변하고, 코드는 luau로 표시하세요.`;

// ── Gemini 3.5 Flash 스트리밍 호출 ────────────────────────────
async function callGemini(apiKey, messages, onChunk) {
  const contents = [];
  for (const msg of messages) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: ROBLUMA_SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    }),
    signal: AbortSignal.timeout(90000)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const parsed = JSON.parse(raw);
        const token = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (token) onChunk(token);
      } catch(e) { /* JSON 파싱 실패 무시 */ }
    }
  }
  // 남은 버퍼 처리
  if (buffer.trim() && buffer.startsWith('data: ')) {
    const raw = buffer.slice(6).trim();
    if (raw && raw !== '[DONE]') {
      try {
        const parsed = JSON.parse(raw);
        const token = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (token) onChunk(token);
      } catch(e) {}
    }
  }
}

// ── 액션 파싱 ──────────────────────────────────────────────────
function parseActions(text, sessionId) {
  const actions = [];
  const regex = /ACTION_START\s*([\s\S]*?)\s*ACTION_END/g;
  let match;
  let idCounter = Date.now();
  while ((match = regex.exec(text)) !== null) {
    try {
      const action = JSON.parse(match[1].trim());
      action._id = ++idCounter;
      action._sessionId = sessionId;
      action._status = 'pending';
      action._createdAt = Date.now();
      actions.push(action);
    } catch(e) {}
  }
  return actions;
}

// ── API 엔드포인트 ─────────────────────────────────────────────

// [사이트 → 서버] RobLuma 채팅 (Gemini 스트리밍)
app.post('/robluma/chat', async (req, res) => {
  const { message, history, apiKey, sessionId, stream } = req.body;
  if (!message || !apiKey || !sessionId) {
    return res.status(400).json({ error: 'message, apiKey, sessionId 필요' });
  }

  // 메시지 히스토리 구성
  const messages = [];
  if (history) {
    for (const [u, a] of history) {
      messages.push({ role: 'user', content: u });
      messages.push({ role: 'assistant', content: a });
    }
  }
  messages.push({ role: 'user', content: message });

  // SSE 스트리밍
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullText = '';
  try {
    await callGemini(apiKey, messages, (chunk) => {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
    });

    // 액션 파싱 → 큐에 추가
    const actions = parseActions(fullText, sessionId);
    if (actions.length) {
      const queue = getQueue(sessionId);
      queue.push(...actions);
      // 액션 정보 사이트로 전달
      res.write(`data: ${JSON.stringify({ actions })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// [플러그인 → 서버] 명령 폴링
app.get('/robluma/commands', (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'session 필요' });

  const queue = getQueue(session);
  // pending 명령만 꺼내서 전달, 상태를 sent로 변경
  const pending = queue.filter(c => c._status === 'pending');
  pending.forEach(c => c._status = 'sent');

  res.json({ commands: pending });
});

// [플러그인 → 서버] 실행 결과 보고
app.post('/robluma/ack', (req, res) => {
  const { session, commandId, result } = req.body;
  if (!session) return res.status(400).json({ error: 'session 필요' });

  if (!commandResults[session]) commandResults[session] = {};
  commandResults[session][commandId] = { ...result, _ackedAt: Date.now() };

  // 큐에서 해당 명령 상태 업데이트
  const queue = getQueue(session);
  const cmd = queue.find(c => c._id === commandId);
  if (cmd) cmd._status = result?.success ? 'done' : 'error';

  res.json({ ok: true });
});

// [사이트 → 서버] 실행 결과 조회 (READ_FILE 결과 등)
app.get('/robluma/results', (req, res) => {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'session 필요' });
  res.json({ results: commandResults[session] || {} });
});

// [플러그인 → 서버] 파일 읽기 결과 전송
app.post('/robluma/result', (req, res) => {
  const { session, type, target, content } = req.body;
  if (!session) return res.status(400).json({ error: 'session 필요' });
  if (!commandResults[session]) commandResults[session] = {};
  commandResults[session][`read_${target}`] = { type, target, content, _at: Date.now() };
  res.json({ ok: true });
});

// 헬스체크
app.get('/', (req, res) => res.json({ status: 'RobLuma server running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`RobLuma server on port ${PORT}`));
