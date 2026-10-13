// =======================
// 京都検定2級 出題地図
// =======================
const PLACES_URL = "data/places.json";
const PLACES_FALLBACK = "places.sample.json";
const QUESTIONS_URL = "data/questions.json";
const STORAGE_KEY = "kk2-progress-v1";
const MAX_STREAK = 3;

const KYOTO_CENTER = [35.011, 135.768];

// ラベルを出す地点数。狭い画面では絞る。
const LABELS_WIDE = 22;
const LABELS_NARROW = 10;

// 取っ手をこれ以上下げたら閉じる（px）
const DISMISS_DISTANCE = 60;

const state = {
  map: null,
  places: [],
  questionById: new Map(),
  progress: {},
  layer: null,
  narrow: null
};

function isNarrow() {
  return window.matchMedia("(max-width: 640px)").matches;
}

// =======================
// 習得度（四択トレーニングと同じ規則）
// =======================
function stageOf(questionId) {
  const streak = state.progress[questionId];

  if (streak === undefined) return { key: "new", label: "未出題" };
  if (streak >= MAX_STREAK) return { key: "triple", label: "トリプル" };
  if (streak === 2) return { key: "double", label: "ダブル" };
  if (streak === 1) return { key: "hit", label: "ヒット" };
  return { key: "miss", label: "ミス" };
}

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (error) {
    console.warn("進捗を読み込めませんでした", error);
    return {};
  }
}

// =======================
// 読み込み
// =======================
async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} の読込に失敗しました（HTTP ${response.status}）`);
  }

  return response.json();
}

async function loadPlaces() {
  try {
    return { places: await fetchJson(PLACES_URL), seeded: false };
  } catch (error) {
    return { places: await fetchJson(PLACES_FALLBACK), seeded: true };
  }
}

async function init() {
  const status = document.getElementById("map-status");

  // 引き出しの操作は地図データの成否と無関係なので、先に有効化しておく
  setupSheet();

  try {
    state.progress = loadProgress();
    state.narrow = isNarrow();

    const [{ places, seeded }, questions] = await Promise.all([
      loadPlaces(),
      fetchJson(QUESTIONS_URL)
    ]);

    state.places = places;
    questions.forEach(question => state.questionById.set(question.id, question));

    buildMap();
    render();

    const totalMentions = places.reduce((sum, place) => sum + place.count, 0);
    status.textContent = seeded
      ? `仮データ表示中：${places.length}地点／延べ${totalMentions}問`
      : `${places.length}地点／延べ${totalMentions}問`;

    document.getElementById("show-rare").addEventListener("change", render);
    document.getElementById("show-weak").addEventListener("change", render);

    // 画面幅が変わったら、吹き出し方式とラベル数を切り替え直す
    let timer = null;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (isNarrow() !== state.narrow) {
          state.narrow = isNarrow();
          closeSheet();
          render();
        }
      }, 200);
    });
  } catch (error) {
    status.textContent = error.message || "地図データを読み込めませんでした。";
    console.error(error);
  }
}

window.addEventListener("DOMContentLoaded", init);

// =======================
// 地図
// =======================
function buildMap() {
  state.map = L.map("map", {
    center: KYOTO_CENTER,
    zoom: 12,
    scrollWheelZoom: true
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>｜地点: Wikipedia',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(state.map);

  state.layer = L.layerGroup().addTo(state.map);
  state.map.on("click", closeSheet);
}

// 登場回数から球の見え方を決める。平方根で圧縮して差をつけすぎない。
function glowStyle(count) {
  const scale = Math.sqrt(count);

  return {
    size: Math.round(14 + scale * 9),
    opacity: Math.min(0.35 + scale * 0.2, 1),
    duration: Math.max(4.2 - scale * 0.55, 1.4)
  };
}

function hasUnlearned(place) {
  return place.questions.some(id => stageOf(id).key !== "triple");
}

// 上位N地点にだけラベルを出すための下限値を求める
function labelThreshold(places) {
  const limit = state.narrow ? LABELS_NARROW : LABELS_WIDE;
  const counts = places.map(place => place.count).sort((a, b) => b - a);

  return counts.length <= limit ? 0 : counts[limit - 1];
}

function render() {
  const showRare = document.getElementById("show-rare").checked;
  const showWeak = document.getElementById("show-weak").checked;

  state.layer.clearLayers();

  const visible = state.places.filter(place => {
    if (!showRare && place.count < 2) return false;
    if (showWeak && !hasUnlearned(place)) return false;
    return true;
  });

  const threshold = labelThreshold(visible);

  visible.forEach(place => {
    const { size, opacity, duration } = glowStyle(place.count);
    const labelled = threshold > 0 && place.count >= threshold;

    const html =
      `<span class="orb" style="--orb-size:${size}px;--orb-opacity:${opacity};--orb-duration:${duration}s"></span>` +
      (labelled ? `<span class="orb-label">${escapeHtml(place.name)}</span>` : "");

    const marker = L.marker([place.lat, place.lng], {
      icon: L.divIcon({
        className: "orb-icon",
        html,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      }),
      title: `${place.name}（${place.count}問）`,
      keyboard: true,
      alt: `${place.name}、${place.count}問`
    });

    if (state.narrow) {
      // スマホは地図を覆わないよう、画面下の引き出しに出す
      marker.on("click", () => openSheet(place));
    } else {
      marker.bindPopup(() => detailHtml(place), {
        maxWidth: 300,
        className: "orb-popup",
        autoPanPadding: [24, 24]
      });
    }

    marker.addTo(state.layer);
  });
}

// =======================
// 引き出し（スマホ）
// =======================
let dragStartY = null;

function setupSheet() {
  const sheet = document.getElementById("sheet");

  if (!sheet) {
    console.warn("#sheet がありません。map.html を確認してください。");
    return;
  }

  // 閉じる操作は委譲で拾う。ボタンが後から差し替わっても効く。
  sheet.addEventListener("click", event => {
    if (event.target.closest("#sheet-close")) {
      event.stopPropagation();
      closeSheet();
    }
  });

  // Escでも閉じる
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSheet();
  });

  // 引き出しの上での操作を地図に伝えない
  if (window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(sheet);
    L.DomEvent.disableScrollPropagation(sheet);
  }

  setupDrag(sheet);
}

// 取っ手を下にドラッグ／フリックで閉じる。取っ手が無ければ何もしない。
function setupDrag(sheet) {
  const handle = document.getElementById("sheet-handle");

  if (!handle) {
    console.warn("#sheet-handle がありません。閉じるボタンのみ有効です。");
    return;
  }

  handle.addEventListener("pointerdown", event => {
    dragStartY = event.clientY;
    sheet.style.transition = "none";

    try {
      handle.setPointerCapture(event.pointerId);
    } catch (error) {
      // 対応していない環境では捕捉なしで続行
    }
  });

  handle.addEventListener("pointermove", event => {
    if (dragStartY === null) return;

    const moved = Math.max(0, event.clientY - dragStartY);
    sheet.style.transform = `translateY(${moved}px)`;
  });

  const finish = event => {
    if (dragStartY === null) return;

    const moved = Math.max(0, event.clientY - dragStartY);
    dragStartY = null;

    sheet.style.transition = "";
    sheet.style.transform = "";

    if (moved > DISMISS_DISTANCE) {
      closeSheet();
    }
  };

  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function openSheet(place) {
  const sheet = document.getElementById("sheet");
  const body = document.getElementById("sheet-body");

  if (!sheet || !body) return;

  body.innerHTML = detailHtml(place);
  body.scrollTop = 0;
  sheet.hidden = false;

  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
    focusOrb(place, sheet.offsetHeight);
  });
}

// タップした球を、引き出しの上端より少し上・横は中央に持ってくる
function focusOrb(place, sheetHeight) {
  if (!state.map) return;

  const rect = document.getElementById("map").getBoundingClientRect();

  const sheetTop = window.innerHeight - sheetHeight;
  const visibleBottom = Math.min(rect.bottom, sheetTop);

  const targetX = rect.width / 2;
  let targetY = visibleBottom - rect.top - 44;
  targetY = Math.max(50, Math.min(targetY, rect.height - 20));

  const current = state.map.latLngToContainerPoint([place.lat, place.lng]);
  state.map.panBy([current.x - targetX, current.y - targetY], { animate: true });
}

function closeSheet() {
  const sheet = document.getElementById("sheet");

  if (!sheet || sheet.hidden) return;

  dragStartY = null;
  sheet.style.transition = "";
  sheet.style.transform = "";
  sheet.classList.remove("is-open");

  setTimeout(() => { sheet.hidden = true; }, 220);
}

// =======================
// 中身（吹き出しと引き出しで共通）
// =======================
function detailHtml(place) {
  const rows = place.questions
    .map(id => state.questionById.get(id))
    .filter(Boolean)
    .map(question => {
      const stage = stageOf(question.id);

      return `
        <li class="pop-item">
          <p class="pop-meta">
            <span>第${question.exam}回 第${question.questionNumber}問</span>
            <span class="stage-tag stage-${stage.key}">${stage.label}</span>
          </p>
          <p class="pop-q">${escapeHtml(question.question)}</p>
          <p class="pop-a">${escapeHtml(question.correct)}</p>
        </li>`;
    })
    .join("");

  return `
    <div class="pop">
      <h2 class="pop-title">${escapeHtml(place.name)}</h2>
      <p class="pop-count">過去問11回分で ${place.count}問</p>
      <ol class="pop-list">${rows}</ol>
    </div>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}
