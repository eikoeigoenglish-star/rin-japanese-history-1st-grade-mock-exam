// =======================
// 設定
// =======================
const VALID_EXAMS = [12, 13, 14, 15, 16, 17, 19, 21, 23, 25, 27];
const CHOICE_MARKERS = ["1", "2", "3", "4"];
const STORAGE_KEY = "kk2-progress-v1";

// 習得段階。streak（連続正解数）から決まる。
// 未出題 = 記録なし / ミス = 0 / ヒット = 1 / ダブル = 2 / トリプル = 3
const STAGES = [
  { key: "triple", label: "トリプル", streak: 3 },
  { key: "double", label: "ダブル", streak: 2 },
  { key: "hit", label: "ヒット", streak: 1 },
  { key: "miss", label: "ミス", streak: 0 },
  { key: "new", label: "未出題", streak: null }
];

const MAX_STREAK = 3;

// =======================
// 状態
// =======================
const state = {
  allQuestions: [],
  questions: [],
  answers: {},
  currentIndex: 0,
  progress: {},
  // 出題中のセッション種別。過去問は { kind: "past" }、
  // 公開テーマは { kind: "theme", themeId }（theme.js が設定する）
  session: { kind: "past" }
};

// =======================
// 進捗の保存と読み込み
// =======================
function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("進捗を読み込めませんでした", error);
    return {};
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
  } catch (error) {
    console.warn("進捗を保存できませんでした", error);
    showStorageWarning();
  }
}

function showStorageWarning() {
  const note = document.getElementById("mastery-note");
  if (note) {
    note.textContent = "この環境では進捗を保存できません。閉じるとリセットされます。";
  }
}

function stageOf(questionId) {
  const streak = state.progress[questionId];

  if (streak === undefined) return "new";
  if (streak >= MAX_STREAK) return "triple";
  if (streak === 2) return "double";
  if (streak === 1) return "hit";
  return "miss";
}

// 公開テーマ問題（__themeId を持つ）は theme.js 側の別進捗を参照する。
// 過去問は従来どおり stageOf(question.id)。
function stageOfQuestion(question) {
  if (question.__themeId && typeof stageOfThemeQuestion === "function") {
    return stageOfThemeQuestion(question);
  }
  return stageOf(question.id);
}

function questionMetaLabel(question) {
  if (question.__themeId && typeof themeQuestionLabel === "function") {
    return themeQuestionLabel(question);
  }
  return `第${question.exam}回　第${question.questionNumber}問`;
}

function stageLabel(key) {
  return STAGES.find(stage => stage.key === key)?.label ?? "";
}

// =======================
// 初期化
// =======================
async function init() {
  try {
    const response = await fetch("data/questions.json");

    if (!response.ok) {
      throw new Error(`questions.json の読込に失敗しました（HTTP ${response.status}）`);
    }

    const questions = await response.json();

    if (!Array.isArray(questions)) {
      throw new Error("questions.json の形式が配列ではありません。");
    }

    state.allQuestions = questions;
    state.progress = loadProgress();

    renderMastery();
    updateAvailableCounts();

    document.getElementById("start-btn").addEventListener("click", startExam);
    document.getElementById("next-btn").addEventListener("click", nextQuestion);
    document.getElementById("back-to-start-btn").addEventListener("click", backToStart);
    document.getElementById("exam-toggle-btn").addEventListener("click", toggleAllExams);
    document.getElementById("range-toggle-btn").addEventListener("click", toggleAllRanges);
    document.getElementById("reset-progress-btn").addEventListener("click", resetProgress);
    document.addEventListener("keydown", handleQuizKeydown);
  } catch (error) {
    showStartError(error.message || "問題データを読み込めませんでした。");
    document.getElementById("start-btn").disabled = true;
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", init);

// =======================
// 進捗バーと内訳
// =======================
function countStages() {
  const counts = { new: 0, miss: 0, hit: 0, double: 0, triple: 0 };

  state.allQuestions.forEach(question => {
    counts[stageOf(question.id)] += 1;
  });

  return counts;
}

function renderMastery() {
  const counts = countStages();
  const total = state.allQuestions.length;

  if (total === 0) return;

  // バーは習得が進んだ順に左から積む。全部トリプル＝金一色が目標。
  ["triple", "double", "hit", "miss", "new"].forEach(key => {
    const percent = (counts[key] / total) * 100;
    document.getElementById(`seg-${key}`).style.width = `${percent}%`;
  });

  STAGES.forEach(stage => {
    const countEl = document.getElementById(`count-${stage.key}`);
    if (countEl) countEl.textContent = String(counts[stage.key]);

    const chipCount = document.getElementById(`chip-count-${stage.key}`);
    if (chipCount) chipCount.textContent = String(counts[stage.key]);
  });

  const triplePercent = Math.round((counts.triple / total) * 100);
  document.getElementById("mastery-headline").textContent =
    `トリプル ${counts.triple} / ${total}　（${triplePercent}%）`;

  const bar = document.getElementById("mastery-bar");
  bar.setAttribute("aria-valuenow", String(triplePercent));
  bar.setAttribute(
    "aria-valuetext",
    `全${total}問中、トリプル${counts.triple}問、ダブル${counts.double}問、` +
    `ヒット${counts.hit}問、ミス${counts.miss}問、未出題${counts.new}問`
  );
}

function resetProgress() {
  const answered = state.allQuestions.length - countStages().new;

  if (answered === 0) {
    return;
  }

  const ok = window.confirm(
    `${answered}問分の進捗をすべて消して、全問を未出題に戻します。よろしいですか。`
  );

  if (!ok) return;

  state.progress = {};
  saveProgress();
  renderMastery();
  updateAvailableCounts();
}

// =======================
// 回次 一括選択／解除
// =======================
function toggleAllExams() {
  const inputs = [...document.querySelectorAll('input[name="exam"]')];
  const allChecked = inputs.length > 0 && inputs.every(input => input.checked);
  const next = !allChecked;

  inputs.forEach(input => {
    input.checked = next;
  });

  updateExamToggleLabel();
  updateAvailableCounts();
}

function updateExamToggleLabel() {
  const inputs = [...document.querySelectorAll('input[name="exam"]')];
  const allChecked = inputs.length > 0 && inputs.every(input => input.checked);

  document.getElementById("exam-toggle-btn").textContent =
    allChecked ? "すべて解除" : "すべて選択";
}

// =======================
// 出題範囲 一括選択／解除
// =======================
function toggleAllRanges() {
  const inputs = [...document.querySelectorAll('input[name="range"]')];
  const allChecked = inputs.every(input => input.checked);
  const next = !allChecked;

  inputs.forEach(input => {
    input.checked = next;
  });

  updateRangeToggleLabel();
  updateAvailableCounts();
}

function updateRangeToggleLabel() {
  const inputs = [...document.querySelectorAll('input[name="range"]')];
  const allChecked = inputs.every(input => input.checked);

  document.getElementById("range-toggle-btn").textContent =
    allChecked ? "すべて解除" : "すべて選択";
}

document.addEventListener("change", event => {
  const name = event.target.name;

  if (name === "exam") {
    updateExamToggleLabel();
  }

  if (name === "range") {
    updateRangeToggleLabel();
  }

  if (name === "range" || name === "exam" || name === "stage" || name === "freq") {
    updateAvailableCounts();
  }
});

// =======================
// 試験開始
// =======================
function startExam() {
  clearStartError();

  const countValue = document.querySelector('input[name="count"]:checked')?.value;
  const filters = readFilters();

  if (!countValue) {
    showStartError("出題問数を選択してください。");
    return;
  }

  if (filters.exams.length === 0) {
    showStartError("回次を1つ以上選択してください。");
    return;
  }

  if (filters.ranges.length === 0) {
    showStartError("出題範囲を1つ以上選択してください。");
    return;
  }

  if (filters.stages.length === 0) {
    showStartError("出題状態を1つ以上選択してください。");
    return;
  }

  if (filters.freqs.length === 0) {
    showStartError("頻出度を1つ以上選択してください。");
    return;
  }

  const pool = filterQuestions(state.allQuestions, filters);

  if (pool.length === 0) {
    showStartError("選択した条件に該当する問題がありません。");
    return;
  }

  const questionCount = countValue === "all" ? pool.length : Number(countValue);

  if (countValue !== "all" && pool.length < questionCount) {
    showStartError(
      `選択した条件には${pool.length}問しかありません。` +
      `出題問数を${pool.length}問以下にしてください。`
    );
    return;
  }

  state.session = { kind: "past" };
  state.questions = shuffle(pool)
    .slice(0, questionCount)
    .map(question => ({
      ...question,
      displayChoices: shuffle(question.choices)
    }));

  state.answers = {};
  state.currentIndex = 0;

  showScreen("screen-quiz");
  renderQuestion();
  scrollPageTopImmediately();
}

// =======================
// 出題対象の抽出
// =======================
function readFilters() {
  return {
    exams: [...document.querySelectorAll('input[name="exam"]:checked')]
      .map(input => Number(input.value))
      .filter(exam => VALID_EXAMS.includes(exam)),
    ranges: [...document.querySelectorAll('input[name="range"]:checked')]
      .map(input => parseRange(input.value)),
    stages: [...document.querySelectorAll('input[name="stage"]:checked')]
      .map(input => input.value),
    freqs: [...document.querySelectorAll('input[name="freq"]:checked')]
      .map(input => input.value)
  };
}

function filterQuestions(allQuestions, filters) {
  return allQuestions.filter(question => {
    const examMatches = filters.exams.includes(Number(question.exam));

    if (!examMatches) return false;

    const number = Number(question.questionNumber);
    const rangeMatches = filters.ranges.some(
      range => number >= range.start && number <= range.end
    );

    if (!rangeMatches) return false;

    if (!filters.stages.includes(stageOf(question.id))) return false;

    return filters.freqs.includes(question.freq);
  });
}

function parseRange(value) {
  const [start, end] = value.split("-").map(Number);
  return { start, end };
}

// =======================
// 選択条件に応じた出題問数の制御
// =======================
function updateAvailableCounts() {
  if (state.allQuestions.length === 0) {
    return;
  }

  const filters = readFilters();

  const ready =
    filters.exams.length > 0 &&
    filters.ranges.length > 0 &&
    filters.stages.length > 0 &&
    filters.freqs.length > 0;

  const availableCount = ready
    ? filterQuestions(state.allQuestions, filters).length
    : 0;

  const countInputs = [...document.querySelectorAll('input[name="count"]')];

  countInputs.forEach(input => {
    input.disabled = input.value === "all"
      ? availableCount === 0
      : Number(input.value) > availableCount;
  });

  document.getElementById("count-all-num").textContent = String(availableCount);

  const selectedInput = document.querySelector('input[name="count"]:checked');

  if (!selectedInput || selectedInput.disabled) {
    // 「対象すべて」への自動切り替えは避け、選べる最大の固定値に下げる
    const largestAvailable =
      countInputs.find(input => input.value !== "all" && !input.disabled) ??
      countInputs.find(input => !input.disabled);

    if (largestAvailable) {
      largestAvailable.checked = true;
    }
  }

  const availability = document.getElementById("count-availability");

  if (availableCount === 0) {
    availability.textContent = "条件に合う問題がありません";
  } else {
    availability.textContent = `1つ選択・現在の対象は${availableCount}問`;
  }

  document.getElementById("start-btn").disabled = availableCount === 0;
  clearStartError();
}

// Fisher-Yates shuffle
function shuffle(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

// =======================
// 問題表示
// =======================
function renderQuestion() {
  const question = state.questions[state.currentIndex];
  const total = state.questions.length;
  const current = state.currentIndex + 1;

  document.getElementById("question-meta").textContent = questionMetaLabel(question);

  const stageTag = document.getElementById("question-stage");
  const currentStage = stageOfQuestion(question);
  stageTag.textContent = stageLabel(currentStage);
  stageTag.className = `stage-tag stage-${currentStage}`;

  document.getElementById("question-counter").textContent =
    `${current} / ${total}`;

  updateProgress(current, total);

  const questionText = document.getElementById("question-text");
  questionText.textContent = question.question;

  const answerArea = document.getElementById("answer-area");
  answerArea.innerHTML = "";

  renderChoice(answerArea, question);
  restoreAnswer(question);

  const nextButton = document.getElementById("next-btn");
  nextButton.textContent =
    state.currentIndex === total - 1 ? "結果を見る" : "次へ";

  // iPhone / iPad などのタッチ端末では、問題文への programmatic focus が
  // ブラウザ側の自動スクロールを誘発し、画面上部の回次・問題番号・進捗表示を隠すことがある。
  // キーボード操作を想定する端末だけ、従来どおり問題文へフォーカスを移す。
  const usesFinePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (usesFinePointer) {
    questionText.focus({ preventScroll: true });
  }
}

function updateProgress(current, total) {
  const percent = Math.round((current / total) * 100);

  document.getElementById("progress-fill").style.width = `${percent}%`;
  document.getElementById("progress-bar").setAttribute("aria-valuenow", String(percent));
}

// =======================
// 四択UI
// =======================
function renderChoice(area, question) {
  question.displayChoices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-btn";
    button.dataset.choice = choice;
    button.setAttribute("aria-pressed", "false");

    const marker = document.createElement("span");
    marker.className = "choice-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = CHOICE_MARKERS[index];

    const text = document.createElement("span");
    text.className = "choice-text";
    text.textContent = choice;

    button.append(marker, text);

    button.addEventListener("click", () => {
      state.answers[question.id] = choice;
      highlightChoice(area, choice);
    });

    area.appendChild(button);
  });
}

function highlightChoice(container, selectedChoice) {
  [...container.querySelectorAll(".choice-btn")].forEach(button => {
    const selected = button.dataset.choice === selectedChoice;

    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

// =======================
// 回答復元
// =======================
function restoreAnswer(question) {
  const answer = state.answers[question.id];

  if (answer === undefined) {
    return;
  }

  highlightChoice(document.getElementById("answer-area"), answer);
}

// =======================
// キーボード操作（1〜4で選択、Enterで次へ）
// =======================
function handleQuizKeydown(event) {
  const quizScreen = document.getElementById("screen-quiz");

  if (quizScreen.hidden) {
    return;
  }

  // 修飾キー付きは無視
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  const keyIndex = CHOICE_MARKERS.indexOf(event.key);

  if (keyIndex !== -1) {
    const buttons = document.querySelectorAll("#answer-area .choice-btn");

    if (buttons[keyIndex]) {
      buttons[keyIndex].click();
      event.preventDefault();
    }
    return;
  }

  // 「次へ」にフォーカスがあるときだけ既定の動作に任せ、
  // それ以外（選択肢をクリックした直後など）は Enter で先に進む
  if (event.key === "Enter" && document.activeElement.id !== "next-btn") {
    nextQuestion();
    event.preventDefault();
  }
}

// =======================
// 次へ
// =======================
function nextQuestion() {
  if (state.currentIndex < state.questions.length - 1) {
    state.currentIndex += 1;
    renderQuestion();
    scrollPageTopImmediately();
    return;
  }

  showResult();
}

// =======================
// 採点
// =======================
function normalize(value) {
  return String(value ?? "").trim();
}

function judge(question, answer) {
  return normalize(answer) === normalize(question.correct);
}

// 正解なら1段上げる（トリプルで打ち止め）。誤答と未回答はミスに戻す。
function applyResult(questionId, isCorrect) {
  const before = stageOf(questionId);
  const current = state.progress[questionId] ?? 0;

  state.progress[questionId] = isCorrect
    ? Math.min(current + 1, MAX_STREAK)
    : 0;

  return { before, after: stageOf(questionId) };
}

// =======================
// 結果表示
// =======================
function showResult() {
  showScreen("screen-result");

  let correctCount = 0;
  const list = document.getElementById("result-list");
  list.innerHTML = "";

  const transitions = state.questions.map(question => {
    const answer = state.answers[question.id];
    const isCorrect = judge(question, answer);

    if (isCorrect) {
      correctCount += 1;
    }

    // 公開テーマ問題はテーマ専用の進捗にだけ反映し、過去問の進捗には一切加算しない
    const change = question.__themeId && typeof applyThemeResult === "function"
      ? applyThemeResult(question.__themeId, question.id, isCorrect)
      : applyResult(question.id, isCorrect);

    return { question, answer, isCorrect, ...change };
  });

  if (state.session.kind === "theme") {
    if (typeof finishThemeSession === "function") {
      finishThemeSession(state.session.themeId);
    }
  } else {
    saveProgress();
    renderMastery();
    updateAvailableCounts();
  }

  transitions.forEach((entry, index) => {
    list.appendChild(createResultItem(entry, index));
  });

  const total = state.questions.length;
  const percent = Math.round((correctCount / total) * 100);

  const score = document.getElementById("score");
  score.innerHTML = "";

  const scoreNum = document.createElement("span");
  scoreNum.className = "score-num";
  scoreNum.textContent = String(correctCount);

  score.append("得点 ", scoreNum, ` / ${total}`);

  document.getElementById("score-percent").textContent = `正答率 ${percent}%`;
  document.getElementById("score-sub").textContent =
    percent === 100 ? "全問正解です。見事。" :
    percent >= 70 ? "合格ライン（70%）に到達しています。" :
    "合格ラインは70%です。復習して再挑戦しましょう。";

  const promoted = transitions.filter(entry => entry.after === "triple" && entry.before !== "triple").length;
  const dropped = transitions.filter(entry => !entry.isCorrect && entry.before !== "new" && entry.before !== "miss").length;

  const changes = [];
  if (promoted > 0) changes.push(`トリプル到達 ${promoted}問`);
  if (dropped > 0) changes.push(`ミスに後退 ${dropped}問`);

  document.getElementById("score-changes").textContent = changes.join("　／　");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function createResultItem(entry, index) {
  const { question, answer, isCorrect, before, after } = entry;

  const item = document.createElement("li");
  item.className = `result-item ${isCorrect ? "is-correct" : "is-incorrect"}`;

  const badge = document.createElement("span");
  badge.className = "result-badge";
  badge.textContent = isCorrect ? "○" : "×";
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", isCorrect ? "正解" : "不正解");

  const body = document.createElement("div");
  body.className = "result-body";

  const meta = document.createElement("p");
  meta.className = "result-meta";
  meta.textContent = `Q${index + 1}　${questionMetaLabel(question)}`;

  if (question.freq === "high") {
    const freqTag = document.createElement("span");
    freqTag.className = "freq-tag";
    freqTag.textContent = `頻出 ${question.answerRounds}回`;
    meta.append("　", freqTag);
  }

  const text = document.createElement("p");
  text.className = "result-question";
  text.textContent = question.question;

  const answers = document.createElement("dl");
  answers.className = "result-answers";

  answers.appendChild(
    createAnswerLine("正解", question.correct, "answer-correct")
  );

  const userText = answer === undefined ? "未回答" : answer;
  answers.appendChild(
    createAnswerLine(
      "あなたの答え",
      userText,
      isCorrect ? "answer-correct" : "answer-wrong"
    )
  );

  const transition = document.createElement("p");
  transition.className = "result-transition";

  const fromTag = document.createElement("span");
  fromTag.className = `stage-tag stage-${before}`;
  fromTag.textContent = stageLabel(before);

  const toTag = document.createElement("span");
  toTag.className = `stage-tag stage-${after}`;
  toTag.textContent = stageLabel(after);

  transition.append(fromTag, " → ", toTag);

  const aiPromptButton = createAiPromptCopyButton(question, answer);

  body.append(meta, text, answers, transition);

  // 解説を持つ問題（公開テーマ問題）だけ解説を表示する
  if (question.explanation) {
    const explanation = document.createElement("p");
    explanation.className = "result-explanation";

    const explanationLabel = document.createElement("span");
    explanationLabel.className = "result-explanation-label";
    explanationLabel.textContent = "解説";

    explanation.append(explanationLabel, String(question.explanation));
    body.appendChild(explanation);
  }

  body.appendChild(aiPromptButton);
  item.append(badge, body);

  return item;
}

function createAiPromptCopyButton(question, answer) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ai-prompt-copy";

  const icon = document.createElement("span");
  icon.className = "copy-icon";
  icon.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "ai-prompt-copy-label";
  label.textContent = "生成AI相談プロンプト";

  button.append(icon, label);

  let restoreTimer = null;

  button.addEventListener("click", async () => {
    const prompt = buildAiConsultPrompt(question, answer);

    try {
      await copyTextToClipboard(prompt);
      button.classList.remove("is-error");
      button.classList.add("is-copied");
      label.textContent = "コピーしました";
    } catch (error) {
      console.warn("生成AI相談プロンプトをコピーできませんでした", error);
      button.classList.remove("is-copied");
      button.classList.add("is-error");
      label.textContent = "コピーできませんでした";
    }

    if (restoreTimer !== null) {
      window.clearTimeout(restoreTimer);
    }

    restoreTimer = window.setTimeout(() => {
      button.classList.remove("is-copied", "is-error");
      label.textContent = "生成AI相談プロンプト";
      restoreTimer = null;
    }, 1800);
  });

  return button;
}

function buildAiConsultPrompt(question, answer) {
  const circledMarkers = ["①", "②", "③", "④"];
  const lines = [
    "京都・観光文化検定試験（京都検定）2級の次の問題を解説してください。",
    "",
    question.__themeId ? "【出典】" : "【回次・問題番号】",
    question.__themeId
      ? `${questionMetaLabel(question)}（過去問ではない公開テーマ対策の独自問題）`
      : `第${question.exam}回 第${question.questionNumber}問`,
    "",
    "【問題】",
    String(question.question ?? "").trim() || "（問題文なし）",
    "",
    "【選択肢】"
  ];

  const choices = Array.isArray(question.choices) ? question.choices : [];

  choices.forEach((choice, index) => {
    const marker = circledMarkers[index] ?? `${index + 1}.`;
    const choiceText = String(choice ?? "").trim() || "（選択肢データなし）";
    lines.push(`${marker} ${choiceText}`);
  });

  lines.push(
    "",
    "【正解】",
    String(question.correct ?? "").trim() || "（正解データなし）",
    "",
    "【私の回答】",
    answer === undefined ? "未回答" : String(answer).trim() || "未回答",
    "",
    "この問題について、正解の理由と各選択肢の正誤を解説してください。",
    "また、私の回答についても、正解・不正解に応じて判断のポイントを説明してください。",
    "京都の歴史・寺社・文化・地理など、理解に必要な背景知識も補ってください。",
    "単なる暗記ではなく、正解にたどり着くための考え方、関連知識、他の選択肢との見分け方、覚え方があれば説明してください。"
  );

  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  let clipboardError = null;

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;

  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }

  if (!copied) {
    if (clipboardError) {
      throw clipboardError;
    }
    throw new Error("Clipboard API と copy コマンドの両方が利用できませんでした。");
  }
}

function createAnswerLine(labelText, value, valueClass) {
  const line = document.createElement("div");

  const label = document.createElement("dt");
  label.textContent = labelText;

  const detail = document.createElement("dd");
  detail.textContent = value;
  detail.className = valueClass;

  line.append(label, detail);

  return line;
}

// =======================
// エラー表示
// =======================
function showStartError(message) {
  const area = document.getElementById("start-error");
  area.textContent = message;
  area.hidden = false;
}

function clearStartError() {
  const area = document.getElementById("start-error");
  area.textContent = "";
  area.hidden = true;
}

// =======================
// 画面切り替え
// =======================
function showScreen(id) {
  ["screen-start", "screen-quiz", "screen-result"].forEach(screenId => {
    document.getElementById(screenId).hidden = true;
  });

  document.getElementById(id).hidden = false;
}

// iOS系ブラウザの動的ツールバーとDOM更新のタイミング差でも、
// 問題画面の先頭（回次・問題番号・進捗区分）が確実に見えるようにする。
function scrollPageTopImmediately() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });

  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

// =======================
// 戻る
// =======================
function backToStart() {
  state.questions = [];
  state.answers = {};
  state.currentIndex = 0;
  state.session = { kind: "past" };

  renderMastery();
  updateAvailableCounts();
  if (typeof renderThemeSection === "function") {
    renderThemeSection();
  }
  showScreen("screen-start");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
