const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const QUESTIONS = require("./questions");

function lanAddress() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|Bluetooth|Loopback|Virtual|WSL/i.test(name)) continue;
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (net.address.startsWith("169.254.")) continue;
      found.push(net.address);
    }
  }
  found.sort((a, b) => {
    const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
    return rank(a) - rank(b);
  });
  return found[0] || null;
}

const PORT = process.env.PORT || 3000;
const ON_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR =
  process.env.DATA_DIR ||
  (ON_SERVERLESS ? path.join(os.tmpdir(), "this-or-that") : path.join(__dirname, "data"));
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const REVEAL_MS = 2200;
const HUG_MS = 3800;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  transports: ["polling", "websocket"],
});

app.use(express.static(path.join(__dirname, "public")));

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function emptyAnswers() {
  return { him: null, her: null };
}

function freshState() {
  return {
    questions: shuffle(QUESTIONS),
    questionIndex: 0,
    answers: emptyAnswers(),
    history: [],
    matches: 0,
    streak: 0,
    phase: "lobby",
    startedAt: Date.now(),
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.questions) || saved.questions.length === 0) {
      return freshState();
    }
    return {
      ...freshState(),
      ...saved,
      answers: saved.answers || emptyAnswers(),
    };
  } catch {
    return freshState();
  }
}

function persist() {
  const snapshot = {
    questions: state.questions,
    questionIndex: state.questionIndex,
    answers: state.answers,
    history: state.history,
    matches: state.matches,
    streak: state.streak,
    phase: state.phase === "hug" ? "reveal" : state.phase,
    startedAt: state.startedAt,
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.warn("session not written:", error.message);
  }
}

const seats = {
  him: null,
  her: null,
};

let state = loadState();
let advanceTimer = null;

if (state.phase === "reveal" || state.phase === "hug") {
  state.phase = state.questionIndex >= state.questions.length - 1 ? "kiss" : "question";
  if (state.phase === "question") state.answers = emptyAnswers();
}

function bothSeated() {
  return Boolean(seats.him && seats.her);
}

function currentQuestion() {
  return state.questions[state.questionIndex] || null;
}

function closeness() {
  return Math.min(1, state.matches / 6);
}

function publicState(role) {
  const revealing = state.phase === "reveal" || state.phase === "hug" || state.phase === "kiss";
  const hideChoice = (who, value) => {
    if (revealing || who === role) return value;
    return value ? "locked" : null;
  };

  return {
    role,
    seats: {
      him: Boolean(seats.him),
      her: Boolean(seats.her),
    },
    phase: state.phase,
    questionIndex: state.questionIndex,
    total: state.questions.length,
    question: currentQuestion(),
    answers: {
      him: hideChoice("him", state.answers.him),
      her: hideChoice("her", state.answers.her),
    },
    closeness: closeness(),
    streak: state.streak,
    canReset: state.phase === "kiss",
  };
}

function emitAll() {
  persist();
  for (const [role, socketId] of Object.entries(seats)) {
    if (!socketId) continue;
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.emit("state", publicState(role));
  }
  io.emit("presence", {
    him: Boolean(seats.him),
    her: Boolean(seats.her),
  });
}

function clearAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function maybeStart() {
  if (!bothSeated()) return;
  if (state.phase === "lobby") {
    state.phase = "question";
    emitAll();
  }
}

function finishRound() {
  const last = state.questionIndex >= state.questions.length - 1;
  if (last) {
    state.phase = "kiss";
    io.emit("fx", { type: "kiss" });
    emitAll();
    return;
  }
  state.questionIndex += 1;
  state.answers = emptyAnswers();
  state.phase = "question";
  emitAll();
}

function resolveRound() {
  const match = state.answers.him === state.answers.her;
  const question = currentQuestion();
  state.history.push({
    question,
    him: state.answers.him,
    her: state.answers.her,
    match,
  });

  if (match) {
    state.matches += 1;
    state.streak += 1;
  } else {
    state.streak = 0;
  }

  const hatTrick = match && state.streak > 0 && state.streak % 3 === 0;
  state.phase = hatTrick ? "hug" : "reveal";
  io.emit("fx", {
    type: hatTrick ? "hug" : match ? "heart" : "miss",
    match,
    streak: state.streak,
  });
  emitAll();

  clearAdvance();
  advanceTimer = setTimeout(finishRound, hatTrick ? HUG_MS : REVEAL_MS);
}

function seatOf(socketId) {
  if (seats.him === socketId) return "him";
  if (seats.her === socketId) return "her";
  return null;
}

io.on("connection", (socket) => {
  socket.emit("hello", {
    seats: { him: Boolean(seats.him), her: Boolean(seats.her) },
    phase: state.phase,
    total: state.questions.length,
  });

  socket.on("join", (role) => {
    if (role !== "him" && role !== "her") {
      socket.emit("join-error", "Pick him or her.");
      return;
    }
    if (seats[role] && seats[role] !== socket.id) {
      socket.emit("join-error", role === "him" ? "He's already here." : "She's already here.");
      return;
    }

    const previous = seatOf(socket.id);
    if (previous && previous !== role) seats[previous] = null;

    seats[role] = socket.id;
    socket.data.role = role;
    maybeStart();
    emitAll();
    socket.emit("joined", publicState(role));
  });

  socket.on("pick", (choice) => {
    const role = seatOf(socket.id);
    if (!role) return;
    if (state.phase !== "question") return;
    if (choice !== "a" && choice !== "b") return;
    if (state.answers[role]) return;

    state.answers[role] = choice;
    emitAll();

    if (state.answers.him && state.answers.her) {
      resolveRound();
    }
  });

  socket.on("reset", () => {
    const role = seatOf(socket.id);
    if (!role) return;
    if (state.phase !== "kiss") return;
    clearAdvance();
    state = freshState();
    if (bothSeated()) state.phase = "question";
    io.emit("fx", { type: "reset" });
    emitAll();
  });

  socket.on("disconnect", () => {
    const role = seatOf(socket.id);
    if (role) seats[role] = null;
    emitAll();
  });
});

if (!ON_SERVERLESS) {
  server.listen(PORT, () => {
    persist();
    const lan = lanAddress();
    console.log(`this or that → http://localhost:${PORT}`);
    if (lan) console.log(`phones on wifi → http://${lan}:${PORT}`);
  });
}

module.exports = server;
