// =======================================================
// 公開テーマ（期間限定の独自問題セット）
//
// ・過去問（data/questions.json / kk2-progress-v1）とは完全に別管理。
// ・data/themes.json に並べたテーマのうち active:true のものだけを表示する。
//   試験終了後は active:false にする（論理削除）。問題JSONも進捗も消さない。
// ・テーマごとに別の LocalStorage キー（manifest の progressKey）で進捗を持つ。
// ・出題・選択肢シャッフル・採点・結果表示は app.js の仕組みをそのまま使う。
// ・スタート画面では「過去問トレーニング」と各公開テーマを独立した学習モードとして
//   上部のタブで切り替える。現在モードは URL の ?mode=<テーマID> で保持する。
// =======================================================

const THEME_MANIFEST_URL = "data/themes.json";
// 過去問モードと同じ選択肢（出題問数・出題範囲・出題状態）
const THEME_COUNT_OPTIONS = ["all", "100", "50", "25", "20", "10", "5", "3", "1"];
const THEME_DEFAULT_COUNT = "10"; // 本試験の公開テーマ出題数（約10問）に合わせた初期値
const THEME_RANGES = ["1-10", "11-20", "21-30", "31-40", "41-50", "51-60", "61-70", "71-80", "81-90", "91-100"];
const THEME_STAGE_CHIPS = [
  { key: "new", label: "未出題" },
  { key: "miss", label: "ミス" },
  { key: "hit", label: "ヒット" },
  { key: "double", label: "ダブル" },
  { key: "triple", label: "トリプル" }
];

const themeState = {
  themes: [] // { manifest, meta, questions, progress, ids:Set }
};

// -----------------------
// 読み込み
// -----------------------
async function initThemes() {
  try {
    const response = await fetch(THEME_MANIFEST_URL);
    if (!response.ok) return;

    const manifest = await response.json();
    if (!Array.isArray(manifest)) return;

    // active:false のテーマは読み込まない（データ・進捗は残したまま非表示）
    const activeEntries = manifest.filter(entry => entry && entry.active === true && entry.file);

    for (const entry of activeEntries) {
      try {
        const res = await fetch(`data/${entry.file}`);
        if (!res.ok) continue;

        const data = await res.json();
        if (!data || !data.meta || data.meta.active === false || !Array.isArray(data.questions)) {
          continue;
        }

        const questions = data.questions.map(question => ({
          ...question,
          __themeId: entry.id
        }));

        themeState.themes.push({
          manifest: entry,
          meta: data.meta,
          questions,
          ids: new Set(questions.map(question => question.id)),
          progress: loadThemeProgress(entry.progressKey)
        });
      } catch (error) {
        console.warn(`公開テーマ ${entry.id} を読み込めませんでした`, error);
      }
    }

  } catch (error) {
    // テーマが読めなくても過去問は通常どおり使える
    console.warn("公開テーマの一覧を読み込めませんでした", error);
  } finally {
    renderThemeSection();
    initModeSwitch();
  }
}

window.addEventListener("DOMContentLoaded", initThemes);

function findTheme(themeId) {
  return themeState.themes.find(theme => theme.manifest.id === themeId) ?? null;
}

// -----------------------
// 進捗（テーマ専用キー）
// -----------------------
function loadThemeProgress(key) {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("公開テーマの進捗を読み込めませんでした", error);
    return {};
  }
}

function saveThemeProgress(theme) {
  if (!theme.manifest.progressKey) return;
  try {
    localStorage.setItem(theme.manifest.progressKey, JSON.stringify(theme.progress));
  } catch (error) {
    console.warn("公開テーマの進捗を保存できませんでした", error);
  }
}

function themeStageOf(theme, questionId) {
  const streak = theme.progress[questionId];

  if (streak === undefined) return "new";
  if (streak >= MAX_STREAK) return "triple";
  if (streak === 2) return "double";
  if (streak === 1) return "hit";
  return "miss";
}

function countThemeStages(theme) {
  const counts = { new: 0, miss: 0, hit: 0, double: 0, triple: 0 };
  theme.questions.forEach(question => {
    counts[themeStageOf(theme, question.id)] += 1;
  });
  return counts;
}

// app.js の結果処理から呼ばれる（テーマ問題のときだけ）
function applyThemeResult(themeId, questionId, isCorrect) {
  const theme = findTheme(themeId);
  if (!theme) return { before: "new", after: "new" };

  const before = themeStageOf(theme, questionId);
  const current = theme.progress[questionId] ?? 0;

  theme.progress[questionId] = isCorrect ? Math.min(current + 1, MAX_STREAK) : 0;

  return { before, after: themeStageOf(theme, questionId) };
}

function stageOfThemeQuestion(question) {
  const theme = findTheme(question.__themeId);
  return theme ? themeStageOf(theme, question.id) : "new";
}

function themeQuestionLabel(question) {
  const theme = findTheme(question.__themeId);
  const label = theme ? `${theme.manifest.label}「${theme.manifest.title}」` : "公開テーマ";
  return `${label}　第${question.questionNumber}問`;
}

function finishThemeSession(themeId) {
  const theme = findTheme(themeId);
  if (!theme) return;
  saveThemeProgress(theme);
  renderThemeSection();
}

// -----------------------
// 画面（公開テーマモードのパネル）
// -----------------------
function renderThemeSection() {
  const area = document.getElementById("theme-area");
  if (!area) return;

  if (themeState.themes.length === 0) {
    area.innerHTML = "";
    area.hidden = true;
    return;
  }

  // 既に描画済みなら数値だけ更新（選択状態を保つ）
  const alreadyRendered = themeState.themes.every(theme =>
    document.getElementById(`${theme.manifest.id}-panel`)
  );

  if (!alreadyRendered) {
    area.innerHTML = "";
    themeState.themes.forEach(theme => {
      area.appendChild(createThemePanel(theme));
    });
  }

  themeState.themes.forEach(updateThemePanel);
  applyModeVisibility();
}

// =======================================================
// 学習モード切替（過去問トレーニング ⇔ 公開テーマ）
//
// ・モードは「過去問（past）」と、active な各テーマ（テーマID）。
// ・選択中のモード以外の設定UI・進捗UIは hidden で完全に非表示にする。
// ・URL の ?mode=<テーマID> で現在モードを保持する（過去問はパラメータなし）。
//   旧リンク #theme-area や #<テーマID> で来た場合もテーマモードとして開く。
// ・active なテーマが無ければ切替UI自体を出さない。
// =======================================================
const MODE_PARAM = "mode";
const PAST_MODE = "past";
const PAST_LEAD_TEXT = document.getElementById("app-lead")?.textContent ?? "";

themeState.mode = PAST_MODE;

function readRequestedMode() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get(MODE_PARAM);
  if (fromQuery) return fromQuery;

  const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  if (hash === "theme-area") return "theme";       // 旧リンク互換：先頭のテーマへ
  if (hash.startsWith("theme-")) return hash;

  return PAST_MODE;
}

function resolveMode(requested) {
  if (!requested || requested === PAST_MODE) return PAST_MODE;
  if (requested === "theme") return themeState.themes[0]?.manifest.id ?? PAST_MODE;
  return findTheme(requested) ? requested : PAST_MODE;
}

function modeUrl(mode) {
  const url = new URL(window.location.href);
  url.hash = "";
  if (mode === PAST_MODE) {
    url.searchParams.delete(MODE_PARAM);
  } else {
    url.searchParams.set(MODE_PARAM, mode);
  }
  return url.pathname + url.search;
}

// テーマモード指定で開いたとき、テーマ読込完了まで過去問UIを出さない（ちらつき防止）
if (readRequestedMode() !== PAST_MODE) {
  document.documentElement.classList.add("mode-pending");
}

function initModeSwitch() {
  buildModeSwitch();

  const requested = readRequestedMode();
  const mode = resolveMode(requested);

  // 無効なモード（active:false のテーマなど）が指定されていたら URL から外す
  const needsCleanUrl = requested !== mode || window.location.hash !== "";
  setMode(mode, { history: needsCleanUrl ? "replace" : "none" });

  document.documentElement.classList.remove("mode-pending");

  window.addEventListener("popstate", () => {
    setMode(resolveMode(readRequestedMode()), { history: "none" });
  });
}

function buildModeSwitch() {
  const nav = document.getElementById("mode-switch");
  if (!nav) return;

  // 過去問タブ以外（以前に描いたテーマタブ）を作り直す
  nav.querySelectorAll("[data-theme-tab]").forEach(tab => tab.remove());

  if (themeState.themes.length === 0) {
    nav.hidden = true;
    return;
  }

  themeState.themes.forEach(theme => {
    const id = theme.manifest.id;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mode-tab mode-tab-theme";
    tab.id = `mode-tab-${id}`;
    tab.dataset.mode = id;
    tab.dataset.themeTab = "";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `${id}-panel`);
    tab.innerHTML =
      `<span class="mode-tab-main">${escapeThemeHtml(theme.manifest.label)}対策</span>` +
      `<span class="mode-tab-sub">${escapeThemeHtml(theme.manifest.title)}・${theme.questions.length}問</span>`;
    nav.appendChild(tab);

    const panel = document.getElementById(`${id}-panel`);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
    }
  });

  if (!nav.dataset.bound) {
    nav.dataset.bound = "1";
    nav.addEventListener("click", event => {
      const tab = event.target.closest("[data-mode]");
      if (!tab) return;
      setMode(tab.dataset.mode, { history: "push" });
    });
    nav.addEventListener("keydown", handleModeTabKeydown);
  }

  nav.hidden = false;

}

function handleModeTabKeydown(event) {
  const tabs = [...document.querySelectorAll("#mode-switch [role='tab']")];
  const index = tabs.indexOf(document.activeElement);
  if (index === -1) return;

  let next = null;
  if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
  if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
  if (event.key === "Home") next = tabs[0];
  if (event.key === "End") next = tabs[tabs.length - 1];
  if (!next) return;

  event.preventDefault();
  next.focus();
  setMode(next.dataset.mode, { history: "push" });
}

function setMode(mode, { history = "push" } = {}) {
  const resolved = resolveMode(mode);
  const changed = resolved !== themeState.mode;
  themeState.mode = resolved;

  applyModeVisibility();

  if (history === "push" && changed) {
    window.history.pushState({ mode: resolved }, "", modeUrl(resolved));
  } else if (history === "replace" || (history === "push" && !changed)) {
    window.history.replaceState({ mode: resolved }, "", modeUrl(resolved));
  }
}

// 現在モード以外の設定UI・進捗UIを完全に非表示にする
function applyModeVisibility() {
  const mode = resolveMode(themeState.mode);
  const isPast = mode === PAST_MODE;

  const pastPanel = document.getElementById("mode-past");
  if (pastPanel) pastPanel.hidden = !isPast;

  const area = document.getElementById("theme-area");
  if (area) area.hidden = isPast || themeState.themes.length === 0;

  themeState.themes.forEach(theme => {
    const panel = document.getElementById(`${theme.manifest.id}-panel`);
    if (panel) panel.hidden = theme.manifest.id !== mode;
  });

  document.querySelectorAll("#mode-switch [role='tab']").forEach(tab => {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle("is-active", selected);
  });

  const lead = document.getElementById("app-lead");
  if (lead) {
    const theme = findTheme(mode);
    lead.textContent = theme
      ? `公開テーマ「${theme.manifest.title}」${theme.questions.length}問すべてをトリプルにするのが目標です。`
      : PAST_LEAD_TEXT;
  }

  document.body.dataset.mode = isPast ? PAST_MODE : "theme";
}

// 問題番号帯ごとのジャンル（カテゴリ）を、データから自動で要約する
function describeThemeRanges(theme) {
  const runs = [];
  [...theme.questions]
    .sort((a, b) => a.questionNumber - b.questionNumber)
    .forEach(question => {
      const last = runs[runs.length - 1];
      if (last && last.category === question.category && last.end === question.questionNumber - 1) {
        last.end = question.questionNumber;
      } else {
        runs.push({ category: question.category, start: question.questionNumber, end: question.questionNumber });
      }
    });
  if (runs.length === 0 || runs.some(run => !run.category)) return "";
  return runs.map(run => `${run.start}〜${run.end} ${run.category}`).join("／");
}

function themeRangeLabel(value) {
  const [start, end] = value.split("-");
  return `${start}〜${end}`;
}

// 過去問モード（index.html）と同じパネル構成：進捗／出題範囲／出題状態／出題問数／開始
function createThemePanel(theme) {
  const id = theme.manifest.id;
  const total = theme.questions.length;
  const rangeGuide = describeThemeRanges(theme);

  const container = document.createElement("div");
  container.className = "theme-mode";
  container.id = `${id}-panel`;
  container.hidden = true;

  container.innerHTML = `
    <!-- テーマ紹介 -->
    <section class="panel theme-panel" aria-labelledby="${id}-heading">
      <p class="theme-eyebrow">
        <span class="theme-badge">期間限定</span>
        <span>${escapeThemeHtml(theme.manifest.label)}</span>
      </p>
      <h2 id="${id}-heading" class="theme-title">${escapeThemeHtml(theme.manifest.title)}</h2>
      <p class="panel-desc theme-desc">${escapeThemeHtml(theme.meta.description || "")}</p>
      <p class="panel-desc theme-desc">本試験では公開テーマから10問程度の出題が見込まれます。この${total}問は過去問ではない独自問題で、進捗は過去問とは別に記録されます。</p>
    </section>

    <!-- 進捗 -->
    <section class="panel mastery-panel" aria-labelledby="${id}-mastery-heading">
      <div class="panel-head">
        <h2 id="${id}-mastery-heading" class="panel-title">進捗</h2>
        <p id="${id}-headline" class="mastery-headline theme-headline"></p>
        <button type="button" id="${id}-reset" class="btn-ghost btn-small">進捗を消す</button>
      </div>

      <div class="mastery-bar" id="${id}-bar" role="progressbar"
           aria-label="公開テーマのトリプル到達率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <span class="mastery-seg seg-triple" data-seg="triple"></span>
        <span class="mastery-seg seg-double" data-seg="double"></span>
        <span class="mastery-seg seg-hit" data-seg="hit"></span>
        <span class="mastery-seg seg-miss" data-seg="miss"></span>
        <span class="mastery-seg seg-new" data-seg="new"></span>
      </div>

      <ul class="mastery-legend">
        <li><span class="dot dot-triple"></span>トリプル<b data-count="triple">0</b></li>
        <li><span class="dot dot-double"></span>ダブル<b data-count="double">0</b></li>
        <li><span class="dot dot-hit"></span>ヒット<b data-count="hit">0</b></li>
        <li><span class="dot dot-miss"></span>ミス<b data-count="miss">0</b></li>
        <li><span class="dot dot-new"></span>未出題<b data-count="new">0</b></li>
      </ul>

      <p class="panel-desc mastery-note">
        公開テーマ${total}問だけの進捗です。過去問1100問の進捗とは別に記録され、互いに影響しません。
      </p>
    </section>

    <!-- 出題範囲 -->
    <section class="panel" aria-labelledby="${id}-range-heading">
      <div class="panel-head">
        <h2 id="${id}-range-heading" class="panel-title">出題範囲</h2>
        <p class="panel-note">複数選択可</p>
        <button type="button" id="${id}-range-toggle" class="btn-ghost btn-small">すべて解除</button>
      </div>
      <p class="panel-desc">問題番号の範囲を選びます。${rangeGuide ? `番号帯はジャンルに対応しています（${escapeThemeHtml(rangeGuide)}）。` : ""}</p>

      <div class="chip-group" role="group" aria-labelledby="${id}-range-heading">
        ${THEME_RANGES.map(value => `
          <input type="checkbox" id="${id}-range-${value}" name="${id}-range" value="${value}" checked>
          <label class="chip" for="${id}-range-${value}">${themeRangeLabel(value)}</label>
        `).join("")}
      </div>
    </section>

    <!-- 出題状態 -->
    <section class="panel" aria-labelledby="${id}-stage-heading">
      <div class="panel-head">
        <h2 id="${id}-stage-heading" class="panel-title">出題状態</h2>
        <p class="panel-note">複数選択可</p>
      </div>
      <p class="panel-desc">どの状態の問題を出すか選びます。ミスと未出題だけに絞ると弱点だけを回せます。</p>

      <div class="chip-group" role="group" aria-labelledby="${id}-stage-heading">
        ${THEME_STAGE_CHIPS.map(stage => `
          <input type="checkbox" id="${id}-stage-${stage.key}" name="${id}-stage" value="${stage.key}" checked>
          <label class="chip" for="${id}-stage-${stage.key}">${stage.label}<span class="chip-count" data-stage-count="${stage.key}">0</span></label>
        `).join("")}
      </div>
    </section>

    <!-- 出題問数 -->
    <section class="panel" aria-labelledby="${id}-count-heading">
      <div class="panel-head">
        <h2 id="${id}-count-heading" class="panel-title">出題問数</h2>
        <p id="${id}-count-availability" class="panel-note" aria-live="polite">1つ選択</p>
      </div>

      <div class="chip-group" role="radiogroup" aria-labelledby="${id}-count-heading">
        ${THEME_COUNT_OPTIONS.map(value => `
          <input type="radio" id="${id}-count-${value}" name="${id}-count" value="${value}" ${value === THEME_DEFAULT_COUNT ? "checked" : ""}>
          <label class="chip${value === "all" ? " chip-wide" : ""}" for="${id}-count-${value}">${value === "all" ? `対象すべて<span class="chip-count" data-count-all>0</span>` : `${value}問`}</label>
        `).join("")}
      </div>
    </section>

    <div id="${id}-error" class="alert" role="alert" hidden></div>

    <button id="${id}-start" type="button" class="btn-primary btn-block theme-btn">開始する</button>
  `;

  container.querySelector(`#${id}-reset`).addEventListener("click", () => resetThemeProgress(id));
  container.querySelector(`#${id}-start`).addEventListener("click", () => startTheme(id));
  container.querySelector(`#${id}-range-toggle`).addEventListener("click", () => toggleThemeRanges(theme));
  container.addEventListener("change", event => {
    const name = event.target.name;
    if (name === `${id}-range` || name === `${id}-stage`) updateThemePanel(theme);
  });

  return container;
}

function readThemeFilters(theme) {
  const id = theme.manifest.id;
  const panel = document.getElementById(`${id}-panel`);
  return {
    ranges: [...panel.querySelectorAll(`input[name="${id}-range"]:checked`)].map(input => parseRange(input.value)),
    stages: [...panel.querySelectorAll(`input[name="${id}-stage"]:checked`)].map(input => input.value)
  };
}

function filterThemeQuestions(theme, filters) {
  return theme.questions.filter(question => {
    const number = Number(question.questionNumber);
    const inRange = filters.ranges.some(range => number >= range.start && number <= range.end);
    return inRange && filters.stages.includes(themeStageOf(theme, question.id));
  });
}

function toggleThemeRanges(theme) {
  const id = theme.manifest.id;
  const inputs = [...document.querySelectorAll(`#${id}-panel input[name="${id}-range"]`)];
  const next = !inputs.every(input => input.checked);
  inputs.forEach(input => { input.checked = next; });
  updateThemePanel(theme);
}

function updateThemePanel(theme) {
  const id = theme.manifest.id;
  const panel = document.getElementById(`${id}-panel`);
  if (!panel) return;

  const counts = countThemeStages(theme);
  const total = theme.questions.length;

  ["triple", "double", "hit", "miss", "new"].forEach(key => {
    panel.querySelector(`[data-seg="${key}"]`).style.width = `${(counts[key] / total) * 100}%`;
    panel.querySelector(`[data-count="${key}"]`).textContent = String(counts[key]);
    panel.querySelector(`[data-stage-count="${key}"]`).textContent = String(counts[key]);
  });

  const triplePercent = Math.round((counts.triple / total) * 100);
  document.getElementById(`${id}-headline`).textContent =
    `トリプル ${counts.triple} / ${total}　（${triplePercent}%）`;

  const bar = document.getElementById(`${id}-bar`);
  bar.setAttribute("aria-valuenow", String(triplePercent));
  bar.setAttribute(
    "aria-valuetext",
    `公開テーマ全${total}問中、トリプル${counts.triple}問、ダブル${counts.double}問、` +
    `ヒット${counts.hit}問、ミス${counts.miss}問、未出題${counts.new}問`
  );

  // 出題範囲の一括ボタン表記（過去問と同じ）
  const rangeInputs = [...panel.querySelectorAll(`input[name="${id}-range"]`)];
  document.getElementById(`${id}-range-toggle`).textContent =
    rangeInputs.every(input => input.checked) ? "すべて解除" : "すべて選択";

  // 条件に応じて選べる問数を制御（過去問の updateAvailableCounts と同じ規則）
  const filters = readThemeFilters(theme);
  const ready = filters.ranges.length > 0 && filters.stages.length > 0;
  const available = ready ? filterThemeQuestions(theme, filters).length : 0;
  const countInputs = [...panel.querySelectorAll(`input[name="${id}-count"]`)];

  countInputs.forEach(input => {
    input.disabled = input.value === "all" ? available === 0 : Number(input.value) > available;
  });
  panel.querySelector("[data-count-all]").textContent = String(available);

  const selected = panel.querySelector(`input[name="${id}-count"]:checked`);
  if (!selected || selected.disabled) {
    const fallback = countInputs.find(input => input.value !== "all" && !input.disabled) ??
      countInputs.find(input => !input.disabled);
    if (fallback) fallback.checked = true;
  }

  document.getElementById(`${id}-count-availability`).textContent =
    available === 0 ? "条件に合う問題がありません" : `1つ選択・現在の対象は${available}問`;

  document.getElementById(`${id}-start`).disabled = available === 0;
  hideThemeError(id);
}

function resetThemeProgress(themeId) {
  const theme = findTheme(themeId);
  if (!theme) return;

  const answered = theme.questions.length - countThemeStages(theme).new;
  if (answered === 0) return;

  const ok = window.confirm(
    `公開テーマ「${theme.manifest.title}」の${answered}問分の進捗を消して、未出題に戻します。` +
    "過去問の進捗は消えません。よろしいですか。"
  );
  if (!ok) return;

  // このテーマのキーだけを空にする（過去問の kk2-progress-v1 には触れない）
  theme.progress = {};
  saveThemeProgress(theme);
  updateThemePanel(theme);
}

// -----------------------
// 出題開始
// -----------------------
function startTheme(themeId) {
  const theme = findTheme(themeId);
  if (!theme) return;

  hideThemeError(themeId);

  const panel = document.getElementById(`${themeId}-panel`);
  const countValue = panel.querySelector(`input[name="${themeId}-count"]:checked`)?.value;
  const filters = readThemeFilters(theme);

  if (!countValue) {
    showThemeError(themeId, "出題問数を選択してください。");
    return;
  }
  if (filters.ranges.length === 0) {
    showThemeError(themeId, "出題範囲を1つ以上選択してください。");
    return;
  }
  if (filters.stages.length === 0) {
    showThemeError(themeId, "出題状態を1つ以上選択してください。");
    return;
  }

  const pool = filterThemeQuestions(theme, filters);

  if (pool.length === 0) {
    showThemeError(themeId, "選択した条件に該当する問題がありません。");
    return;
  }

  const questionCount = countValue === "all" ? pool.length : Number(countValue);

  if (countValue !== "all" && pool.length < questionCount) {
    showThemeError(
      themeId,
      `選択した条件には${pool.length}問しかありません。出題問数を${pool.length}問以下にしてください。`
    );
    return;
  }

  // ここから先（出題・回答・採点・解説）は app.js の共通実装をそのまま使う
  state.session = { kind: "theme", themeId };
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

function showThemeError(themeId, message) {
  const area = document.getElementById(`${themeId}-error`);
  if (!area) return;
  area.textContent = message;
  area.hidden = false;
}

function hideThemeError(themeId) {
  const area = document.getElementById(`${themeId}-error`);
  if (!area) return;
  area.textContent = "";
  area.hidden = true;
}

function escapeThemeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
