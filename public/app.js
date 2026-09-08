const socket = io();

const views = {
  lobby: document.getElementById("view-lobby"),
  play: document.getElementById("view-play"),
  kiss: document.getElementById("view-kiss"),
};

const els = {
  hint: document.getElementById("lobby-hint"),
  progress: document.getElementById("progress"),
  status: document.getElementById("status"),
  choiceA: document.getElementById("choice-a"),
  choiceB: document.getElementById("choice-b"),
  pillHim: document.getElementById("pill-him"),
  pillHer: document.getElementById("pill-her"),
  liveDot: document.getElementById("live-dot"),
  stage: document.getElementById("stage"),
  midHeart: document.getElementById("mid-heart"),
  burst: document.getElementById("heart-burst"),
  fx: document.getElementById("fx"),
};

let me = null;
let latest = null;

function show(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.classList.toggle("hidden", key !== name);
  });
}

function setPresence(seats) {
  els.pillHim.classList.toggle("on", Boolean(seats.him));
  els.pillHer.classList.toggle("on", Boolean(seats.her));
  els.liveDot.classList.toggle("live", Boolean(seats.him && seats.her));
  els.pillHim.classList.toggle("me", me === "him");
  els.pillHer.classList.toggle("me", me === "her");
}

function closenessClass(value) {
  if (value >= 0.8) return "close-5";
  if (value >= 0.6) return "close-4";
  if (value >= 0.4) return "close-3";
  if (value >= 0.25) return "close-2";
  if (value >= 0.1) return "close-1";
  return "";
}

function renderStage(state, fxType) {
  const classes = ["stage"];
  if (me) classes.push("has-me");
  classes.push(closenessClass(state.closeness || 0));
  if (state.phase === "hug" || fxType === "hug") classes.push("hug", "show-heart");
  if (state.phase === "kiss" || fxType === "kiss") classes.push("kiss", "show-heart");
  if (
    (state.phase === "reveal" || fxType === "heart") &&
    state.answers.him &&
    state.answers.him === state.answers.her
  ) {
    classes.push("show-heart");
  }
  els.stage.className = classes.join(" ");

  document.getElementById("person-him").classList.toggle("you", me === "him");
  document.getElementById("person-her").classList.toggle("you", me === "her");
}

function spawnHearts(count, extraWide) {
  for (let i = 0; i < count; i += 1) {
    const node = document.createElement("span");
    node.className = extraWide ? "fx-heart" : "heart-pop";
    node.textContent = i % 4 === 0 ? "♡" : "❤";
    if (extraWide) {
      node.style.left = `${12 + Math.random() * 76}%`;
      node.style.top = `${48 + Math.random() * 40}%`;
      els.fx.appendChild(node);
    } else {
      node.style.setProperty("--dx", `${(Math.random() * 80 - 40).toFixed(0)}px`);
      node.style.animationDelay = `${i * 70}ms`;
      els.burst.appendChild(node);
    }
    setTimeout(() => node.remove(), 1700);
  }
}

function statusText(state) {
  if (state.phase === "lobby") return "Waiting for your person.";
  if (state.phase === "hug") return "A hat-trick. Come here.";
  if (state.phase === "kiss") return "Always a kiss at the end.";
  if (state.phase === "reveal") {
    return state.answers.him === state.answers.her ? "A match." : "Different, still yours.";
  }

  const mine = state.answers[me];
  const otherRole = me === "him" ? "her" : "him";
  const theirs = state.answers[otherRole];
  if (!state.seats[otherRole]) return "Waiting for your person to come back.";
  if (mine && !theirs) return `Waiting for ${otherRole}.`;
  if (!mine && theirs) return `${otherRole === "him" ? "He" : "She"} has picked.`;
  return "Pick one.";
}

function renderChoices(state) {
  const revealing = state.phase === "reveal" || state.phase === "hug";
  const buttons = document.querySelectorAll(".choice");
  buttons.forEach((button) => {
    const choice = button.dataset.choice;
    button.classList.remove("mine", "match", "taken-him", "taken-her");
    button.disabled = state.phase !== "question" || Boolean(state.answers[me]);

    if (state.answers.him === choice) button.classList.add("taken-him");
    if (state.answers.her === choice) button.classList.add("taken-her");
    if (state.answers[me] === choice) button.classList.add("mine");
    if (revealing && state.answers.him === state.answers.her && state.answers.him === choice) {
      button.classList.add("match");
    }
  });
}

function render(state, fxType) {
  latest = state;
  setPresence(state.seats);
  renderStage(state, fxType);

  if (!me || state.phase === "lobby") {
    show("lobby");
    if (me) {
      els.hint.classList.remove("error");
      els.hint.textContent =
        me === "him" ? "You're him. Waiting for her." : "You're her. Waiting for him.";
    }
    document.querySelectorAll("[data-role]").forEach((button) => {
      const role = button.dataset.role;
      button.disabled = Boolean(state.seats[role] && role !== me);
      button.classList.toggle("mine", role === me);
    });
    return;
  }

  if (state.phase === "kiss") {
    show("kiss");
    return;
  }

  show("play");
  if (state.question) {
    els.choiceA.textContent = state.question.a;
    els.choiceB.textContent = state.question.b;
  }
  els.progress.textContent = `${state.questionIndex + 1} · ${state.total}`;
  els.status.textContent = statusText(state);
  renderChoices(state);
}

document.querySelectorAll("[data-role]").forEach((button) => {
  button.addEventListener("click", () => {
    els.hint.classList.remove("error");
    els.hint.textContent = "Open this on both phones.";
    socket.emit("join", button.dataset.role);
  });
});

document.querySelectorAll("[data-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!me || !latest || latest.phase !== "question") return;
    socket.emit("pick", button.dataset.choice);
  });
});

document.getElementById("again").addEventListener("click", () => {
  socket.emit("reset");
});

socket.on("joined", (state) => {
  me = state.role;
  render(state);
});

socket.on("join-error", (message) => {
  els.hint.classList.add("error");
  els.hint.textContent = message;
});

socket.on("state", (state) => {
  if (me && state.role && state.role !== me) me = state.role;
  render(state);
});

socket.on("presence", (seats) => {
  if (!me) setPresence(seats);
});

socket.on("fx", (event) => {
  if (event.type === "heart") {
    els.stage.classList.add("show-heart");
    spawnHearts(5, false);
  }
  if (event.type === "hug") {
    els.stage.classList.add("hug", "show-heart");
    spawnHearts(10, true);
    spawnHearts(8, false);
  }
  if (event.type === "kiss") {
    els.stage.classList.add("kiss", "show-heart");
    spawnHearts(18, true);
  }
  if (event.type === "reset") {
    els.fx.innerHTML = "";
    els.burst.innerHTML = "";
  }
});

socket.on("hello", (hello) => {
  setPresence(hello.seats);
});
