/*
 * ICC 開季實戰 — UI refresh.
 * Uses the existing Google Apps Script URL, question schema and submission payload.
 * Rules are unchanged: 10 questions, 40 starting mood, +10 at <= 150 seconds.
 * As before, the clock keeps running while answer feedback is open.
 */
"use strict";

const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbxouurLrJeDCf__fDMdnIay7xwBgcQI0dKz7Ld3o-vE-WGvJuub_bE3iyH-UHQOWew1kg/exec";

const SETTINGS = {
  totalQuestions: 10,
  startingMood: 40,
  fullSpeedBonusSeconds: 150,
  fullSpeedBonusPoints: 10
};

const state = {
  staffId: "",
  questions: [],
  currentIndex: 0,
  mood: SETTINGS.startingMood,
  startTime: null,
  elapsedSeconds: 0,
  timerId: null,
  productBest: 0,
  serviceBest: 0,
  answers: [],
  locked: false,
  validating: false,
  loading: false,
  finishing: false,
  submitting: false
};

const $ = id => document.getElementById(id);
const screens = {
  landing: $("screenLanding"),
  rules: $("screenRules"),
  loading: $("screenLoading"),
  game: $("screenGame"),
  result: $("screenResult")
};
const screenHeadings = {
  landing: "landingTitle",
  rules: "rulesTitle",
  loading: "loadingTitle",
  game: "gameTitle",
  result: "resultHeading"
};
let modalScrollState = null;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

/* Natural page height lets Safari reveal the input and allows long content to scroll.
   This bounded wait only settles the keyboard before a screen change. */
function waitForKeyboardClose() {
  if (!window.visualViewport) return Promise.resolve();
  return new Promise(resolve => {
    const started = performance.now();
    let lastHeight = window.visualViewport.height;
    let stableCount = 0;
    const check = () => {
      const height = window.visualViewport.height;
      stableCount = Math.abs(height - lastHeight) < 2 ? stableCount + 1 : 0;
      lastHeight = height;
      if ((stableCount >= 2 && height >= window.innerHeight * .85) || performance.now() - started >= 650) {
        resolve();
        return;
      }
      window.setTimeout(check, 60);
    };
    window.setTimeout(check, 60);
  });
}

function forceViewportTop() {
  window.scrollTo(0, 0);
}

function showScreen(name, { focus = true } = {}) {
  Object.entries(screens).forEach(([key, screen]) => {
    const active = key === name;
    screen.classList.toggle("active", active);
    screen.hidden = !active;
    screen.inert = !active;
    screen.setAttribute("aria-hidden", String(!active));
  });
  document.body.dataset.screen = name;
  forceViewportTop();
  if (focus) $(screenHeadings[name]).focus({ preventScroll: true });
}

function setStatus(id, message, tone = "") {
  $(id).textContent = message;
  $(id).dataset.tone = tone;
}

function setButtonBusy(id, busy, label) {
  const button = $(id);
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  if (label) button.querySelector(".button-label").textContent = label;
}

function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function normalizeMood(value) {
  return Math.max(0, Math.min(100, value));
}

function customerImage(mood) {
  if (mood >= 95) return "images/customer-delighted.png";
  if (mood >= 80) return "images/customer-happy.png";
  if (mood >= 60) return "images/customer-neutral.png";
  if (mood >= 30) return "images/customer-unhappy.png";
  return "images/customer-angry.png";
}

function moodAppearance(mood) {
  if (mood >= 95) return { color: "#22805d", description: "非常滿意的顧客" };
  if (mood >= 80) return { color: "#37966b", description: "開心的顧客" };
  if (mood >= 60) return { color: "#3789b7", description: "心情平穩的顧客" };
  if (mood >= 30) return { color: "#efb52f", description: "有點不開心的顧客" };
  return { color: "#d86661", description: "失望的顧客" };
}

function setCustomerImage(id, mood, decorative = false) {
  const img = $(id);
  const src = customerImage(mood);
  if (img.getAttribute("src") !== src) img.src = src;
  img.alt = decorative ? "" : moodAppearance(mood).description;
}

function setGauge(gauge, mood) {
  gauge.style.setProperty("--mood", `${mood}%`);
  gauge.style.setProperty("--mood-tone", moodAppearance(mood).color);
  gauge.setAttribute("aria-valuenow", String(mood));
  gauge.setAttribute("aria-valuetext", `${mood}%`);
}

function updateMoodUI() {
  state.mood = normalizeMood(state.mood);
  $("moodText").textContent = `${state.mood}%`;
  setCustomerImage("customerFace", state.mood);
  setCustomerImage("moodEmoji", state.mood, true);
  setGauge($("moodGauge"), state.mood);
}

function buildStepDots() {
  const area = $("stepDots");
  area.replaceChildren();
  for (let i = 0; i < SETTINGS.totalQuestions; i++) {
    const dot = document.createElement("li");
    dot.className = "step-dot";
    dot.textContent = i + 1;
    if (i < state.currentIndex) {
      dot.classList.add("done");
      dot.setAttribute("aria-label", `第 ${i + 1} 題，已完成`);
    } else if (i === state.currentIndex) {
      dot.classList.add("active");
      dot.setAttribute("aria-current", "step");
      dot.setAttribute("aria-label", `第 ${i + 1} 題，目前題目`);
    } else {
      dot.setAttribute("aria-label", `第 ${i + 1} 題，未作答`);
    }
    area.appendChild(dot);
  }
}

/* Keep the original GET actions and simple text/plain POST for Apps Script.
   No automatic POST retry: a lost response must not duplicate a result. */
async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error("伺服器暫時未能回應。");
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function validateStaffId() {
  const value = $("staffId").value.trim();
  if (!value) {
    $("staffId").setAttribute("aria-invalid", "true");
    setStatus("landingMessage", "請先輸入 Staff ID。", "error");
    $("staffId").focus();
    return false;
  }

  $("staffId").removeAttribute("aria-invalid");
  $("staffId").readOnly = true;
  setStatus("landingMessage", "正在驗證 Staff ID…", "loading");
  try {
    const url = `${GAS_WEB_APP_URL}?action=validateStaff&staffId=${encodeURIComponent(value)}&t=${Date.now()}`;
    const data = await requestJson(url);
    if (!data.ok) throw new Error(data.message || "Validation failed.");
    if (!data.valid) {
      $("staffId").setAttribute("aria-invalid", "true");
      setStatus("landingMessage", data.message || "未能找到此 Staff ID，請檢查後再試。", "error");
      return false;
    }
    state.staffId = value;
    setStatus("landingMessage", "Staff ID 已驗證 ✓", "success");
    return true;
  } catch (error) {
    console.error("Staff ID validation:", error);
    setStatus("landingMessage", "暫時無法驗證 Staff ID，請稍後再試。", "error");
    return false;
  } finally {
    $("staffId").readOnly = false;
  }
}

async function fetchQuestions() {
  const data = await requestJson(`${GAS_WEB_APP_URL}?action=questions&t=${Date.now()}`);
  if (!data.ok) throw new Error(data.message || "讀取題目失敗，請稍後再試。");
  if (!Array.isArray(data.questions) || data.questions.length < SETTINGS.totalQuestions) {
    throw new Error("題目暫未準備好，請通知活動負責人。");
  }
  const questions = data.questions.slice(0, SETTINGS.totalQuestions);
  const invalid = questions.some(question =>
    !question || typeof question.question !== "string" ||
    !Array.isArray(question.answers) || question.answers.length === 0 ||
    question.answers.some(answer => !answer || typeof answer.text !== "string" || !Number.isFinite(Number(answer.score || 0)))
  );
  if (invalid) throw new Error("部分題目資料未能讀取，請通知活動負責人。");
  state.questions = questions;
}

function updateTimer() {
  if (state.startTime === null) return;
  state.elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
  $("timerText").textContent = formatTime(state.elapsedSeconds);
}

function startTimer() {
  if (state.timerId !== null) window.clearInterval(state.timerId);
  state.startTime = Date.now();
  state.elapsedSeconds = 0;
  $("timerText").textContent = "00:00";
  state.timerId = window.setInterval(updateTimer, 250);
}

function stopTimer() {
  if (state.timerId !== null) window.clearInterval(state.timerId);
  state.timerId = null;
  updateTimer();
}

function openFeedback() {
  const modal = $("feedbackModal");
  if (!modal.hidden) return;
  modalScrollState = {
    y: window.scrollY,
    position: document.body.style.position,
    top: document.body.style.top,
    width: document.body.style.width
  };
  document.body.style.position = "fixed";
  document.body.style.top = `-${modalScrollState.y}px`;
  document.body.style.width = "100%";
  $("gameShell").inert = true;
  modal.hidden = false;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  modal.querySelector(".feedback-modal-card").scrollTop = 0;
  $("modalNextBtn").focus({ preventScroll: true });
}

function closeFeedback() {
  const modal = $("feedbackModal");
  modal.hidden = true;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  $("gameShell").inert = false;
  if (modalScrollState) {
    document.body.style.position = modalScrollState.position;
    document.body.style.top = modalScrollState.top;
    document.body.style.width = modalScrollState.width;
    window.scrollTo(0, modalScrollState.y);
    modalScrollState = null;
  }
}

function resetGameState() {
  stopTimer();
  closeFeedback();
  state.currentIndex = 0;
  state.mood = SETTINGS.startingMood;
  state.startTime = null;
  state.elapsedSeconds = 0;
  state.productBest = 0;
  state.serviceBest = 0;
  state.answers = [];
  state.locked = false;
  state.finishing = false;
  updateMoodUI();
}

function renderQuestion() {
  state.locked = false;
  closeFeedback();
  const question = state.questions[state.currentIndex];
  const type = String(question.type).toLowerCase();
  $("questionCounter").textContent = `${state.currentIndex + 1} / ${SETTINGS.totalQuestions}`;
  $("questionType").textContent = ({ product: "產品知識", service: "服務技巧" })[type] || question.type;
  $("questionType").dataset.type = type;
  $("questionText").textContent = question.question;
  buildStepDots();

  const answerList = $("answerList");
  answerList.replaceChildren();
  question.answers.forEach((answer, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-btn";
    const letter = document.createElement("span");
    letter.className = "answer-letter";
    letter.textContent = String.fromCharCode(65 + index);
    const copy = document.createElement("span");
    copy.className = "answer-copy";
    copy.textContent = answer.text; // Sheet content is text, never executable HTML.
    button.append(letter, copy);
    button.addEventListener("click", () => selectAnswer(question, answer, index, button));
    answerList.appendChild(button);
  });
  forceViewportTop();
  $("questionText").focus({ preventScroll: true });
}

function selectAnswer(question, answer, answerIndex, button) {
  if (state.locked || state.finishing) return;
  state.locked = true;
  $("answerList").querySelectorAll(".answer-btn").forEach(btn => { btn.disabled = true; });
  button.classList.add("selected");

  const moodBefore = state.mood;
  const score = Number(answer.score || 0);
  state.mood += score;
  updateMoodUI();
  if (answer.isBest) {
    if (String(question.type).toLowerCase() === "product") state.productBest++;
    if (String(question.type).toLowerCase() === "service") state.serviceBest++;
  }
  state.answers.push({
    questionId: question.id,
    type: question.type,
    selectedOption: String.fromCharCode(65 + answerIndex),
    selectedText: answer.text,
    score,
    isBest: Boolean(answer.isBest),
    reaction: answer.reaction || "",
    moodBefore,
    moodAfter: state.mood
  });

  // Show the actual change after the original 0–100 clamp, including at either limit.
  const change = state.mood - moodBefore;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "neutral";
  $("feedbackModal").querySelector(".feedback-modal-card").dataset.direction = direction;
  $("feedbackMoodTitle").textContent = {
    up: "顧客心情提升 ↑",
    down: "顧客心情下降 ↓",
    neutral: "顧客心情維持不變"
  }[direction];
  $("feedbackMoodValues").textContent = `${moodBefore}% → ${state.mood}%`;
  $("feedbackDelta").textContent = `${change > 0 ? "+" : ""}${change}`;
  $("feedbackReaction").textContent = answer.reaction || "";
  setCustomerImage("feedbackMoodImage", state.mood);
  $("modalNextBtn").querySelector(".button-label").textContent =
    state.currentIndex === SETTINGS.totalQuestions - 1 ? "查看挑戰結果" : "繼續";
  openFeedback();
}

function calculateResult() {
  const speedBonus = state.elapsedSeconds <= SETTINGS.fullSpeedBonusSeconds ? SETTINGS.fullSpeedBonusPoints : 0;
  const finalMood = normalizeMood(state.mood + speedBonus);
  return { finalMood, speedBonus, qualified: finalMood === 100 };
}

function renderResult(result) {
  $("finalMood").textContent = `${result.finalMood}%`;
  $("completionTime").textContent = formatTime(state.elapsedSeconds);
  $("speedBonus").textContent = `+${result.speedBonus}`;
  const productTotal = state.questions.filter(q => String(q.type).toLowerCase() === "product").length;
  const serviceTotal = state.questions.filter(q => String(q.type).toLowerCase() === "service").length;
  $("productScore").textContent = `${state.productBest} / ${productTotal}`;
  $("serviceScore").textContent = `${state.serviceBest} / ${serviceTotal}`;
  setCustomerImage("resultFace", result.finalMood, true);
  setCustomerImage("resultCustomer", result.finalMood);
  setGauge($("finalGauge"), result.finalMood);
  screens.result.dataset.qualified = String(result.qualified);

  let copy;
  if (result.finalMood === 100) {
    copy = ["顧客非常滿意！", "你為顧客提供了專業又貼心嘅服務。", "Happy Customer Award", "恭喜你！已符合獎賞資格。", "trophy", "#22805d"];
  } else if (result.finalMood >= 80) {
    copy = ["顧客很滿意！", "你今次整體表現良好，成功為顧客提供正面嘅服務體驗。", "Good Customer Experience", "你已展現良好產品知識及服務技巧。", "star", "#287a5b"];
  } else if (result.finalMood >= 60) {
    copy = ["顧客滿意", "你已處理顧客基本需要，部分回應仍有改善空間。", "Customer Experience Review", "可重溫相關產品知識及服務技巧。", "book", "#28658b"];
  } else {
    copy = ["顧客有點失望", "今次顧客體驗未如理想，部分回應仍有改善空間。", "Learning Opportunity", "可重溫相關產品知識及服務技巧，掌握更合適的處理方式。", "book", "#ac4d3e"];
  }
  $("resultTitle").textContent = copy[0];
  $("resultMessage").textContent = copy[1];
  $("rewardTitle").textContent = copy[2];
  $("rewardMessage").textContent = copy[3];
  $("rewardIcon").setAttribute("href", `#icon-${copy[4]}`);
  screens.result.style.setProperty("--result-tone", copy[5]);
}

async function finishGame() {
  if (state.finishing || state.answers.length !== SETTINGS.totalQuestions) return;
  state.finishing = true;
  stopTimer();
  const result = calculateResult();
  renderResult(result);
  showScreen("result");
  await submitResult(result);
}

async function submitResult(result) {
  state.submitting = true;
  $("restartBtn").disabled = true;
  $("restartBtn").setAttribute("aria-busy", "true");
  setStatus("submitStatus", "正在儲存成績，請稍候…", "loading");
  const payload = {
    action: "submitResult",
    staffId: state.staffId,
    finalMood: result.finalMood,
    productScore: state.productBest,
    serviceScore: state.serviceBest,
    completionSeconds: state.elapsedSeconds,
    completionTime: formatTime(state.elapsedSeconds),
    speedBonus: result.speedBonus,
    qualified: result.qualified ? "Yes" : "No",
    answers: state.answers
  };
  try {
    const data = await requestJson(GAS_WEB_APP_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    if (!data.ok) throw new Error(data.message || "Save failed");
    setStatus("submitStatus", "成績已儲存 ✓", "success");
  } catch (error) {
    console.error("Result submission:", error);
    setStatus("submitStatus", "未能確認成績是否已儲存，請通知活動負責人。", "error");
  } finally {
    state.submitting = false;
    $("restartBtn").disabled = false;
    $("restartBtn").setAttribute("aria-busy", "false");
  }
}

/* Input and screen events */
$("staffId").addEventListener("input", () => {
  $("staffId").removeAttribute("aria-invalid");
  state.staffId = "";
  setStatus("landingMessage", "");
});

$("staffForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.validating) return;
  state.validating = true;
  setButtonBusy("goRulesBtn", true, "正在驗證");
  try {
    if (!await validateStaffId()) return;
    $("staffId").blur();
    await waitForKeyboardClose();
    setStatus("rulesMessage", "");
    showScreen("rules");
  } finally {
    state.validating = false;
    setButtonBusy("goRulesBtn", false, "開始挑戰");
  }
});

$("backBtn").addEventListener("click", () => showScreen("landing"));

$("startBtn").addEventListener("click", async () => {
  if (state.loading || !state.staffId) return;
  state.loading = true;
  setButtonBusy("startBtn", true, "正在載入");
  setStatus("rulesMessage", "");
  showScreen("loading");
  try {
    await fetchQuestions();
    resetGameState();
    showScreen("game", { focus: false });
    renderQuestion();
    startTimer();
  } catch (error) {
    console.error("Question loading:", error);
    setStatus("rulesMessage", error.name === "AbortError" ? "載入逾時，請檢查網絡後再試。" : error.message || "暫時未能載入題目，請稍後再試。", "error");
    showScreen("rules");
  } finally {
    state.loading = false;
    setButtonBusy("startBtn", false, "開始接待顧客");
  }
});

$("modalNextBtn").addEventListener("click", () => {
  if ($("feedbackModal").hidden || !state.locked) return;
  closeFeedback();
  if (state.currentIndex < SETTINGS.totalQuestions - 1) {
    state.currentIndex++;
    renderQuestion();
  } else {
    void finishGame();
  }
});

// This acknowledgement dialog has a single action; retain keyboard focus inside it.
$("feedbackModal").addEventListener("keydown", event => {
  if (event.key === "Tab") {
    event.preventDefault();
    $("modalNextBtn").focus({ preventScroll: true });
  }
});

$("restartBtn").addEventListener("click", () => {
  if (state.submitting) return;
  resetGameState();
  state.staffId = "";
  state.questions = [];
  $("staffId").value = "";
  $("staffId").removeAttribute("aria-invalid");
  setStatus("landingMessage", "");
  setStatus("submitStatus", "");
  showScreen("landing");
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.timerId !== null) updateTimer();
});

updateMoodUI();
showScreen("landing", { focus: false });
