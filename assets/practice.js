/*
  歴史能力検定 日本史1級模擬試験 ― 演習モード
  - 問題データは data/mockXXX.json（模試モードと同一の正本）だけを読む
  - 4択：選択で即採点 / 記述：accepted_answers との完全一致 / 論述：cloze の全空欄完全一致
  - 習得度：未出題・ミス・ヒット・ダブル・トリプル（localStorage）
  依存：assets/exam.js（AVAILABLE_MOCKS, escapeHtml, nl2br, renderRomanItems, renderImages,
        renderExamDifficultyMark）を先に読み込むこと。
*/
(() => {
  'use strict';

  // =======================
  // 設定
  // =======================
  const PROGRESS_KEY = 'rin-japanese-history-practice-progress-v1';
  const SETTINGS_KEY = 'rin-japanese-history-practice-settings-v1';
  const MAX_STREAK = 3;
  const CHOICE_LABELS = ['①', '②', '③', '④'];
  const TYPES = ['4択', '記述', '論述'];
  const COUNT_OPTIONS = ['1', '3', '5', '10', '20', '30', 'all'];
  const DEFAULT_COUNT = '5';

  // 表示順（進捗バー・凡例）
  const STAGES = [
    { key: 'triple', label: 'トリプル' },
    { key: 'double', label: 'ダブル' },
    { key: 'hit', label: 'ヒット' },
    { key: 'miss', label: 'ミス' },
    { key: 'new', label: '未出題' }
  ];
  // 出題状態フィルターの並び（旅行業務アプリと同じく「未出題」から）
  const STAGE_FILTER_ORDER = ['new', 'miss', 'hit', 'double', 'triple'];

  // =======================
  // 状態
  // =======================
  const state = {
    all: [],            // 演習可能な全問題（正規化済み）
    mocks: [],          // 読み込めた回次 { id, no, label, difficulty, ok }
    skipped: [],        // データ不備で除外した問題
    streaks: {},        // 問題ID → 連続正解数（0〜3）
    session: null,      // { questions, index, records, config }
    storageOk: true
  };

  const $ = id => document.getElementById(id);

  // =======================
  // localStorage（使えない環境でも動く）
  // =======================
  const storage = (() => {
    let ok = false;
    try {
      const k = '__rin_practice_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      ok = true;
    } catch (_) {
      ok = false;
    }
    return {
      ok,
      get(key) {
        if (!ok) return null;
        try { return window.localStorage.getItem(key); } catch (_) { return null; }
      },
      set(key, value) {
        if (!ok) return false;
        try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
      },
      remove(key) {
        if (!ok) return;
        try { window.localStorage.removeItem(key); } catch (_) { /* noop */ }
      }
    };
  })();

  function loadProgress() {
    const raw = storage.get(PROGRESS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      const src = parsed && typeof parsed === 'object' && parsed.streaks && typeof parsed.streaks === 'object'
        ? parsed.streaks : {};
      const out = {};
      for (const [id, v] of Object.entries(src)) {
        const n = Number(v);
        if (/^mock\d{3}-q\d{2}$/.test(id) && Number.isInteger(n) && n >= 0 && n <= MAX_STREAK) out[id] = n;
      }
      return out;
    } catch (err) {
      console.warn('演習の進捗を読み込めませんでした', err);
      return {};
    }
  }

  function saveProgress() {
    const ok = storage.set(PROGRESS_KEY, JSON.stringify({ version: 1, streaks: state.streaks }));
    if (!ok && state.storageOk) {
      state.storageOk = false;
      showStorageWarning();
    }
  }

  function showStorageWarning() {
    const note = $('mastery-note');
    if (note) {
      note.textContent = 'このブラウザでは進捗を保存できません（プライベートブラウズ等）。ページを閉じると記録は消えます。';
      note.classList.add('is-warning');
    }
  }

  function stageOf(id) {
    const s = state.streaks[id];
    if (s === undefined) return 'new';
    if (s >= MAX_STREAK) return 'triple';
    if (s === 2) return 'double';
    if (s === 1) return 'hit';
    return 'miss';
  }

  function stageLabel(key) {
    return STAGES.find(s => s.key === key)?.label ?? '';
  }

  // 習得度の遷移（正解：未出題/ミス→ヒット→ダブル→トリプル（打ち止め）／不正解：→ミス）は
  // gradeSession() の一括採点時にのみ適用する。

  // =======================
  // 採点（前後空白の除去 → 完全一致のみ）
  // =======================
  function normalizeInput(value) {
    return String(value ?? '').trim();
  }

  function isAccepted(input, accepted) {
    const v = normalizeInput(input);
    return v !== '' && accepted.includes(v);
  }

  // =======================
  // データ読み込みと正規化
  // =======================
  function questionId(mockId, number) {
    return `mock${mockId}-q${String(number).padStart(2, '0')}`;
  }

  function cleanList(list) {
    if (!Array.isArray(list)) return null;
    const out = list.filter(v => typeof v === 'string' && v.trim() !== '');
    return out.length ? out : null;
  }

  function normalizeQuestion(raw, mock) {
    const id = questionId(mock.id, raw.number);
    const base = {
      id,
      mockId: mock.id,
      mockNo: mock.no,
      number: Number(raw.number),
      type: raw.type,
      period: raw.period || '',
      difficulty: raw.difficulty || '',
      raw
    };

    if (raw.type === '4択') {
      if (!CHOICE_LABELS.includes(raw.answer)) return { error: `${id}: 4択の answer が不正` };
      if (Array.isArray(raw.choices) && raw.choices.length >= 2) {
        return { ...base, kind: 'choice', options: raw.choices.map(c => ({ label: c.label, text: c.text })) };
      }
      const imgs = Array.isArray(raw.images) ? raw.images : [];
      const labelled = imgs.filter(img => CHOICE_LABELS.includes(img.label) && img.src);
      if (labelled.length >= 2) {
        return { ...base, kind: 'image-choice', options: labelled.map(img => ({ label: img.label, src: img.src, alt: img.alt })) };
      }
      return { error: `${id}: 4択の選択肢（choices / 画像選択肢）がありません` };
    }

    if (raw.type === '記述') {
      let accepted = cleanList(raw.accepted_answers);
      if (!accepted) {
        if (typeof raw.answer === 'string' && raw.answer.trim()) {
          console.warn(`${id}: accepted_answers がないため answer のみで採点します`);
          accepted = [raw.answer.trim()];
        } else {
          return { error: `${id}: 記述の正答データがありません` };
        }
      }
      return { ...base, kind: 'text', accepted };
    }

    if (raw.type === '論述') {
      const cz = raw.cloze;
      if (!cz || typeof cz.text !== 'string' || !Array.isArray(cz.blanks)) {
        return { error: `${id}: cloze がありません` };
      }
      const blanks = [];
      for (const b of cz.blanks) {
        const acc = cleanList(b?.accepted_answers) || (typeof b?.answer === 'string' && b.answer.trim() ? [b.answer.trim()] : null);
        if (!acc || typeof b.answer !== 'string' || !cz.text.includes(`{{${b.id}}}`)) {
          return { error: `${id}: cloze の空欄データが不正です` };
        }
        blanks.push({ id: b.id, answer: b.answer, accepted: acc });
      }
      if (blanks.length < 2 || blanks.length > 4) return { error: `${id}: 空欄数が2〜4ではありません` };
      return { ...base, kind: 'cloze', cloze: { text: cz.text, blanks } };
    }

    return { error: `${id}: 未対応の問題種類「${raw.type}」` };
  }

  // practice.html の位置を基準に data/mockXXX.json を解決する（ルート絶対パスは使わない）
  function dataUrl(meta) {
    return new URL(`data/${meta.file}`, document.baseURI).href;
  }

  async function fetchJson(url) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async function fetchAllMocks() {
    return Promise.all(AVAILABLE_MOCKS.map(async meta => {
      try {
        const data = await fetchJson(dataUrl(meta));
        if (!Array.isArray(data.questions)) throw new Error('questions がありません');
        return { meta, data };
      } catch (error) {
        return { meta, error };
      }
    }));
  }

  // fetch 結果・ファイル選択結果の共通取り込み
  function ingest(results) {
    state.mocks = [];
    state.all = [];
    state.skipped = [];
    const failed = [];
    for (const r of results) {
      const no = Number(r.meta.id);
      const mock = {
        id: r.meta.id,
        no,
        label: `第${no}回`,
        difficulty: r.data?.exam_difficulty || '普通',
        ok: !r.error
      };
      state.mocks.push(mock);
      if (r.error) {
        failed.push(`${mock.label}（${r.error.message}）`);
        console.error(`data/${r.meta.file} を読み込めませんでした`, r.error);
        continue;
      }
      for (const raw of r.data.questions) {
        try {
          const q = normalizeQuestion(raw, mock);
          if (q.error) {
            state.skipped.push(q.error);
            console.warn(q.error);
          } else {
            state.all.push(q);
          }
        } catch (err) {
          state.skipped.push(`${mock.label}の問題を読み込めませんでした`);
          console.warn(err);
        }
      }
    }
    state.all.sort(compareQuestions);
    state.loadStats = {
      requested: results.length,
      ok: results.filter(r => !r.error).length,
      failed: failed.length,
      total: state.all.length,
      byType: Object.fromEntries(TYPES.map(t => [t, state.all.filter(q => q.type === t).length]))
    };
    return failed;
  }

  function compareQuestions(a, b) {
    return a.mockNo - b.mockNo || a.number - b.number;
  }

  // =======================
  // 設定画面
  // =======================
  function chip({ type, name, value, id, html, checked, disabled, extraClass }) {
    return `
      <input type="${type}" name="${name}" value="${escapeHtml(value)}" id="${id}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <label class="chip${extraClass ? ` ${extraClass}` : ''}" for="${id}">${html}</label>
    `;
  }

  function renderSetupControls(saved) {
    const mockArea = $('mock-options');
    mockArea.innerHTML = state.mocks.map(m => chip({
      type: 'checkbox',
      name: 'mock',
      value: m.id,
      id: `mock-${m.id}`,
      html: `${escapeHtml(m.label)}${renderExamDifficultyMark(m.difficulty)}${m.ok ? '' : '<span class="chip-sub">読込失敗</span>'}`,
      checked: m.ok && (!saved?.mocks || saved.mocks.includes(m.id)),
      disabled: !m.ok,
      extraClass: 'chip-mock'
    })).join('');

    $('type-options').innerHTML = TYPES.map((t, i) => chip({
      type: 'checkbox',
      name: 'qtype',
      value: t,
      id: `qtype-${i}`,
      html: `${escapeHtml(t)}<span class="chip-count" data-type-count="${escapeHtml(t)}">0</span>`,
      checked: !saved?.types || saved.types.includes(t)
    })).join('');

    $('stage-options').innerHTML = STAGE_FILTER_ORDER.map(key => chip({
      type: 'checkbox',
      name: 'stage',
      value: key,
      id: `stage-${key}`,
      html: `<span class="dot dot-${key}" aria-hidden="true"></span>${escapeHtml(stageLabel(key))}<span class="chip-count" data-stage-count="${key}">0</span>`,
      checked: !saved?.stages || saved.stages.includes(key)
    })).join('');

    const savedCount = COUNT_OPTIONS.includes(saved?.count) ? saved.count : DEFAULT_COUNT;
    $('count-options').innerHTML = COUNT_OPTIONS.map(v => chip({
      type: 'radio',
      name: 'count',
      value: v,
      id: `count-${v}`,
      html: v === 'all' ? '対象すべて<span class="chip-count" id="count-all-num">0</span>' : `${v}問`,
      checked: v === savedCount,
      extraClass: ['1', '3', '5'].includes(v) ? 'chip-count-quick' : (v === 'all' ? 'chip-count-all' : '')
    })).join('');

    const order = saved?.order === 'sequential' ? 'sequential' : 'random';
    $(`order-${order}`).checked = true;
  }

  function readSettings() {
    const values = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
    return {
      mocks: values('mock'),
      types: values('qtype'),
      stages: values('stage'),
      count: values('count')[0] || DEFAULT_COUNT,
      order: values('order')[0] || 'random'
    };
  }

  function saveSettings(settings) {
    storage.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadSettings() {
    try {
      const raw = storage.get(SETTINGS_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      const arr = v => (Array.isArray(v) ? v.map(String) : undefined);
      return { mocks: arr(s.mocks), types: arr(s.types), stages: arr(s.stages), count: String(s.count ?? ''), order: s.order };
    } catch (_) {
      return null;
    }
  }

  function filterPool(settings) {
    return state.all.filter(q =>
      settings.mocks.includes(q.mockId) &&
      settings.types.includes(q.type) &&
      settings.stages.includes(stageOf(q.id))
    );
  }

  function updateSetup() {
    const s = readSettings();
    saveSettings(s);

    // 種類別の件数（選択中の回次の範囲）
    for (const t of TYPES) {
      const el = document.querySelector(`[data-type-count="${t}"]`);
      if (el) el.textContent = String(state.all.filter(q => s.mocks.includes(q.mockId) && q.type === t).length);
    }
    // 状態別の件数（選択中の回次×種類の範囲）
    const scope = state.all.filter(q => s.mocks.includes(q.mockId) && s.types.includes(q.type));
    for (const key of STAGE_FILTER_ORDER) {
      const el = document.querySelector(`[data-stage-count="${key}"]`);
      if (el) el.textContent = String(scope.filter(q => stageOf(q.id) === key).length);
    }

    const pool = filterPool(s);
    const allNum = $('count-all-num');
    if (allNum) allNum.textContent = String(pool.length);
    const avail = $('count-availability');
    if (avail) avail.textContent = `1つ選択・現在の対象は${pool.length}問`;
    const summary = $('target-summary');
    const start = $('start-btn');
    let message = '';
    if (state.all.length === 0) message = '問題データを読み込めませんでした';
    else if (s.mocks.length === 0) message = '回次を1つ以上選んでください';
    else if (s.types.length === 0) message = '問題種類を1つ以上選んでください';
    else if (s.stages.length === 0) message = '出題状態を1つ以上選んでください';
    else if (pool.length === 0) message = 'この条件に該当する問題はありません';

    if (message) {
      summary.innerHTML = `<span class="target-empty">${escapeHtml(message)}</span>`;
      start.disabled = true;
    } else {
      const n = s.count === 'all' ? pool.length : Math.min(Number(s.count), pool.length);
      const shortage = s.count !== 'all' && Number(s.count) > pool.length
        ? `<span class="target-sub">（指定より少ないため、ある問題だけ出題します）</span>` : '';
      summary.innerHTML = `対象：<strong>${pool.length}</strong>問 <span aria-hidden="true">→</span><span class="visually-hidden">、</span> 出題：<strong>${n}</strong>問${shortage}`;
      start.disabled = false;
    }
  }

  function renderMastery() {
    const total = state.all.length;
    const counts = { triple: 0, double: 0, hit: 0, miss: 0, new: 0 };
    for (const q of state.all) counts[stageOf(q.id)] += 1;

    for (const s of STAGES) {
      const seg = document.querySelector(`[data-seg="${s.key}"]`);
      if (seg) seg.style.width = total ? `${(counts[s.key] / total) * 100}%` : '0%';
      const c = document.querySelector(`[data-count="${s.key}"]`);
      if (c) c.textContent = String(counts[s.key]);
    }
    const pct = total ? (counts.triple / total) * 100 : 0;
    const pctText = `${pct.toFixed(1)}%`;
    $('mastery-headline').innerHTML =
      `トリプル <strong>${counts.triple}</strong> / ${total} <span class="mastery-pct">（${pctText}）</span>`;
    const bar = $('mastery-bar');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    bar.setAttribute('aria-valuetext',
      `全${total}問中、トリプル${counts.triple}問（${pctText}）、ダブル${counts.double}問、` +
      `ヒット${counts.hit}問、ミス${counts.miss}問、未出題${counts.new}問`);
    $('reset-progress-btn').disabled = counts.new === total;
  }

  function resetProgress() {
    const answered = state.all.filter(q => stageOf(q.id) !== 'new').length;
    if (answered === 0) return;
    const ok = window.confirm(`${answered}問分の進捗をすべて消して、全問を「未出題」に戻します。\nこの操作は取り消せません。よろしいですか？`);
    if (!ok) return;
    state.streaks = {};
    storage.remove(PROGRESS_KEY);
    renderMastery();
    updateSetup();
  }

  // =======================
  // セッション
  // =======================
  function shuffle(items) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 順番：対象を回次→問番号順に並べ、先頭から指定数（「未出題」と組み合わせると続きから解ける）
  // ランダム：対象からランダムに指定数
  function pickQuestions(pool, count, order) {
    const n = count === 'all' ? pool.length : Math.min(Number(count) || 1, pool.length);
    if (order === 'sequential') return [...pool].sort(compareQuestions).slice(0, n);
    return shuffle(pool).slice(0, n);
  }

  // =======================
  // セッション（回答フェーズ → 採点フェーズ）
  // 回答フェーズでは responses に「ユーザーの回答だけ」を保持する。
  // 正誤・習得度（correct / before / after）は gradeSession() で初めて確定する。
  // =======================
  function startSession(questions, config) {
    if (!questions.length) return;
    state.session = {
      questions,
      index: 0,
      responses: questions.map(() => null), // { choice } / { text } / { blanks:[{id,value}] } ＋ gaveUp
      phase: 'answering',                    // 'answering' → 'graded'
      graded: false,
      results: null,
      config
    };
    showScreen('screen-quiz');
    try { history.pushState({ practice: 'quiz' }, '', ''); } catch (_) { /* noop */ }
    renderQuestion();
  }

  function startFromSettings() {
    const s = readSettings();
    const pool = filterPool(s);
    if (!pool.length) { updateSetup(); return; }
    startSession(pickQuestions(pool, s.count, s.order), { settings: s });
  }

  function sessionActive() {
    const ss = state.session;
    return !!ss && ss.phase === 'answering' && !$('screen-quiz').hidden;
  }

  function isResponseComplete(q, resp) {
    if (!resp) return false;
    if (resp.gaveUp) return true;
    if (q.kind === 'choice' || q.kind === 'image-choice') return !!resp.choice;
    if (q.kind === 'text') return normalizeInput(resp.text) !== '';
    if (q.kind === 'cloze') {
      return q.cloze.blanks.every(b => normalizeInput(resp.blanks?.find(x => x.id === b.id)?.value) !== '');
    }
    return false;
  }

  function answeredCount() {
    const ss = state.session;
    if (!ss) return 0;
    return ss.questions.filter((q, i) => isResponseComplete(q, ss.responses[i])).length;
  }


  // =======================
  // 出題画面
  // =======================
  function metaLine(q) {
    return [
      `<span id="quiz-qlabel" class="quiz-qlabel" tabindex="-1">第${q.mockNo}回　第${q.number}問</span>`,
      `<span class="meta-tag">${escapeHtml(q.type)}</span>`,
      q.period ? `<span class="meta-tag">${escapeHtml(q.period)}</span>` : '',
      q.difficulty ? `<span class="meta-tag">難易度${escapeHtml(q.difficulty)}</span>` : '',
      `<span class="stage-tag stage-${stageOf(q.id)}">${escapeHtml(stageLabel(stageOf(q.id)))}</span>`
    ].filter(Boolean).join('');
  }

  function materialHtml(q) {
    const r = q.raw;
    const parts = [];
    parts.push(`<p class="question-text">${nl2br(r.text || '')}</p>`);
    parts.push(renderRomanItems(r));
    if (r.visual_material && !(r.images?.length)) {
      parts.push(`<div class="visual-box"><strong>使用資料</strong><br>${nl2br(r.visual_material)}</div>`);
    }
    if (q.kind !== 'image-choice') parts.push(renderImages(r));
    if (r.source) parts.push(`<div class="source-box practice-source"><strong>史料</strong><br>${nl2br(r.source)}</div>`);
    return parts.join('');
  }

  function choiceButtonsHtml(q) {
    if (q.kind === 'choice') {
      return `
        <div class="choice-buttons" role="group" aria-label="選択肢（選択は「次へ」まで変更できます。採点は最後にまとめて行います）">
          ${q.options.map((o, i) => `
            <button type="button" class="choice-btn" data-label="${escapeHtml(o.label)}" data-key="${i + 1}">
              <span class="choice-mark" aria-hidden="true">${i + 1}</span>
              <span class="choice-main">
                <span class="visually-hidden">${escapeHtml(o.label)}</span>
                <span class="choice-body">${escapeHtml(o.text)}</span>
                <span class="choice-state" aria-hidden="true"></span>
              </span>
            </button>
          `).join('')}
        </div>`;
    }
    // 画像4択：画像カード自体が選択肢ボタン
    return `
      <div class="image-choice-grid" role="group" aria-label="画像の選択肢（選択は「次へ」まで変更できます。採点は最後にまとめて行います）">
        ${q.options.map((o, i) => `
          <div class="image-choice-cell">
            <button type="button" class="choice-btn image-choice-btn" data-label="${escapeHtml(o.label)}" data-key="${i + 1}">
              <span class="image-choice-frame">
                <img src="${escapeHtml(o.src)}" alt="${escapeHtml(o.alt || `選択肢${o.label}の画像`)}" loading="eager" decoding="async">
                <span class="image-fallback" hidden>画像を読み込めません</span>
              </span>
              <span class="image-choice-caption">
                <span class="choice-mark" aria-hidden="true">${i + 1}</span><span class="visually-hidden">${escapeHtml(o.label)}</span>
                <span class="choice-state" aria-hidden="true"></span>
              </span>
            </button>
            <button type="button" class="zoom-btn" data-zoom-src="${escapeHtml(o.src)}" data-zoom-alt="${escapeHtml(o.alt || '')}" data-zoom-label="${escapeHtml(o.label)}">
              ${escapeHtml(o.label)}を拡大
            </button>
          </div>
        `).join('')}
      </div>`;
  }

  const INPUT_ATTRS = 'type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"';

  function textInputHtml() {
    return `
      <div class="answer-form" data-answer-form>
        <label for="text-answer" class="answer-label">解答を入力</label>
        <input id="text-answer" class="answer-input" ${INPUT_ATTRS} aria-describedby="text-answer-hint">
        <p id="text-answer-hint" class="input-hint">漢字・かなの表記どおりに入力してください（前後の空白は無視）。採点は全問回答後にまとめて行います。</p>
      </div>`;
  }

  function charCount(s) {
    return Array.from(s).length;
  }

  function clozeTextHtml(cz, filled) {
    // filled: null（未回答）または { id: {value, ok} }
    const parts = cz.text.split(/(\{\{\d+\}\})/);
    return parts.map(part => {
      const m = part.match(/^\{\{(\d+)\}\}$/);
      if (!m) return escapeHtml(part);
      const id = Number(m[1]);
      if (!filled) return `<span class="cloze-slot">【空欄${id}】</span>`;
      const b = cz.blanks.find(x => Number(x.id) === id);
      const r = filled[id];
      return `<span class="cloze-slot is-filled ${r?.ok ? 'is-ok' : 'is-ng'}"><span class="cloze-slot-no">${id}</span>${escapeHtml(b?.answer ?? '')}</span>`;
    }).join('');
  }

  function clozeInputHtml(q) {
    const cz = q.cloze;
    return `
      <div class="cloze-box">
        <p class="cloze-title">模範解答の空欄を埋めてください</p>
        <p class="cloze-text">${clozeTextHtml(cz, null)}</p>
      </div>
      <div class="answer-form" data-answer-form>
        ${cz.blanks.map((b, i) => `
          <div class="cloze-field">
            <label for="blank-${b.id}" class="answer-label">空欄${b.id} <span class="input-len">（${charCount(b.answer)}文字）</span></label>
            <input id="blank-${b.id}" class="answer-input" data-blank-id="${b.id}" data-blank-index="${i}" ${INPUT_ATTRS}
              enterkeyhint="${i === cz.blanks.length - 1 ? 'done' : 'next'}">
          </div>
        `).join('')}
        <p class="input-hint">空欄がすべて合っている場合のみ得点（部分点なし）。前後の空白は無視します。採点は全問回答後にまとめて行います。</p>
      </div>`;
  }

  function renderQuestion() {
    const ss = state.session;
    const q = ss.questions[ss.index];
    const total = ss.questions.length;
    const current = ss.index + 1;
    const isLast = current === total;

    $('quiz-counter').innerHTML = `<strong>${current}</strong> / ${total}`;
    const bar = $('quiz-progress');
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(current));
    bar.setAttribute('aria-valuetext', `${total}問中${current}問目`);
    $('quiz-progress-fill').style.width = `${(current / total) * 100}%`;

    let answerHtml = '';
    if (q.kind === 'choice' || q.kind === 'image-choice') answerHtml = choiceButtonsHtml(q);
    else if (q.kind === 'text') answerHtml = textInputHtml();
    else answerHtml = clozeInputHtml(q);

    $('quiz-meta').innerHTML = metaLine(q);
    $('quiz-card').innerHTML = `
      ${materialHtml(q)}
      <div class="practice-answer">${answerHtml}</div>
      <div class="answer-aux">
        <button type="button" class="btn-pill-small giveup-btn" data-giveup aria-pressed="false">わからない</button>
        <p class="giveup-note" data-giveup-note hidden>「わからない」（未回答）として記録します。入力・選択すると取り消されます。</p>
      </div>
      <p class="input-error" data-input-error role="alert" hidden></p>
    `;

    bindQuestion(q);
    restoreResponse(q, ss.responses[ss.index]);

    $('prev-btn').disabled = ss.index === 0;
    $('next-btn').textContent = isLast ? '採点して結果を見る' : '次へ';
    $('next-btn').classList.toggle('is-grade', isLast);
    $('next-btn').disabled = false;
    $('nav-hint').textContent = isLast
      ? '全問の回答をまとめて採点し、結果画面で答え合わせをします。'
      : `回答は採点まで何度でも修正できます（残り${total - current}問）。`;

    scrollTopNow();
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (fine) {
      const firstInput = $('quiz-card').querySelector('.answer-input');
      (firstInput || $('quiz-qlabel'))?.focus({ preventScroll: true });
    }
  }

  // IME変換中のEnterを無視する
  const ime = { composing: false, endedAt: 0 };
  function isImeEnter(e) {
    return e.isComposing || e.keyCode === 229 || ime.composing || (Date.now() - ime.endedAt < 50);
  }

  function currentQ() {
    const ss = state.session;
    return ss.questions[ss.index];
  }

  // 現在の入力欄の値をセッションへ保存（採点はしない）
  function captureInputs(q) {
    const ss = state.session;
    const card = $('quiz-card');
    const prev = ss.responses[ss.index];
    if (q.kind === 'text') {
      const v = card.querySelector('#text-answer')?.value ?? '';
      ss.responses[ss.index] = v !== '' ? { text: v } : (prev?.gaveUp ? { text: '', gaveUp: true } : { text: '' });
    } else if (q.kind === 'cloze') {
      const blanks = q.cloze.blanks.map(b => ({ id: b.id, value: card.querySelector(`[data-blank-id="${b.id}"]`)?.value ?? '' }));
      const any = blanks.some(b => b.value !== '');
      ss.responses[ss.index] = any ? { blanks } : (prev?.gaveUp ? { blanks, gaveUp: true } : { blanks });
    }
    updateGiveUpUi();
  }

  function restoreResponse(q, resp) {
    const card = $('quiz-card');
    if (resp) {
      if ((q.kind === 'choice' || q.kind === 'image-choice') && resp.choice) markSelected(resp.choice);
      if (q.kind === 'text') card.querySelector('#text-answer').value = resp.text ?? '';
      if (q.kind === 'cloze') {
        (resp.blanks || []).forEach(b => {
          const input = card.querySelector(`[data-blank-id="${b.id}"]`);
          if (input) input.value = b.value ?? '';
        });
      }
    }
    updateGiveUpUi();
  }

  function markSelected(label) {
    $('quiz-card').querySelectorAll('.choice-btn').forEach(btn => {
      const on = btn.dataset.label === label;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', String(on));
      const st = btn.querySelector('.choice-state');
      if (st) st.textContent = on ? '選択中' : '';
    });
  }

  function updateGiveUpUi() {
    const ss = state.session;
    const gave = !!ss.responses[ss.index]?.gaveUp;
    const btn = $('quiz-card').querySelector('[data-giveup]');
    const note = $('quiz-card').querySelector('[data-giveup-note]');
    if (btn) {
      btn.classList.toggle('is-on', gave);
      btn.setAttribute('aria-pressed', String(gave));
    }
    if (note) note.hidden = !gave;
  }

  function clearError() {
    const err = $('quiz-card').querySelector('[data-input-error]');
    if (err) err.hidden = true;
  }

  function selectChoice(q, label) {
    const ss = state.session;
    ss.responses[ss.index] = { choice: label }; // 選択の変更は自由。正誤はまだ判定しない
    markSelected(label);
    updateGiveUpUi();
    clearError();
  }

  function giveUp(q) {
    const ss = state.session;
    const card = $('quiz-card');
    if (q.kind === 'choice' || q.kind === 'image-choice') {
      ss.responses[ss.index] = { choice: null, gaveUp: true };
      markSelected(null);
    } else if (q.kind === 'text') {
      card.querySelector('#text-answer').value = '';
      ss.responses[ss.index] = { text: '', gaveUp: true };
    } else if (q.kind === 'cloze') {
      card.querySelectorAll('[data-blank-id]').forEach(i => { i.value = ''; });
      ss.responses[ss.index] = { blanks: q.cloze.blanks.map(b => ({ id: b.id, value: '' })), gaveUp: true };
    }
    updateGiveUpUi();
    clearError();
    // 最終問題以外はそのまま次へ（採点はしない）
    if (ss.index < ss.questions.length - 1) goNext();
  }

  function bindQuestion(q) {
    const card = $('quiz-card');

    card.querySelectorAll('.choice-btn').forEach(btn => {
      btn.addEventListener('click', () => selectChoice(q, btn.dataset.label));
    });
    card.querySelectorAll('.image-choice-btn img').forEach(img => {
      img.addEventListener('error', () => {
        img.hidden = true;
        const fb = img.parentElement.querySelector('.image-fallback');
        if (fb) fb.hidden = false;
      });
    });
    card.querySelectorAll('.zoom-btn').forEach(btn => {
      btn.addEventListener('click', () => openZoom(btn.dataset.zoomSrc, btn.dataset.zoomAlt, `${btn.dataset.zoomLabel}`));
    });
    // 資料画像（question-images）もタップで拡大
    card.querySelectorAll('.question-images img').forEach(img => {
      img.classList.add('is-zoomable');
      img.setAttribute('tabindex', '0');
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', `${img.alt || '資料画像'}（拡大表示）`);
      const open = () => openZoom(img.getAttribute('src'), img.alt, img.alt || '資料画像');
      img.addEventListener('click', open);
      img.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    card.querySelector('[data-giveup]')?.addEventListener('click', () => giveUp(q));

    const inputs = [...card.querySelectorAll('.answer-input')];
    inputs.forEach((input, i) => {
      input.addEventListener('compositionstart', () => { ime.composing = true; });
      input.addEventListener('compositionend', () => { ime.composing = false; ime.endedAt = Date.now(); captureInputs(q); });
      input.addEventListener('input', () => { captureInputs(q); clearError(); });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (isImeEnter(e)) return; // 変換確定のEnterでは進まない
        captureInputs(q);
        if (i < inputs.length - 1) inputs[i + 1].focus();
        else goNext();
      });
    });
  }

  // 「次へ」：未回答なら案内。最終問題では一括採点へ。
  function goNext() {
    const ss = state.session;
    if (!ss || ss.phase !== 'answering') return;
    const q = currentQ();
    if (q.kind === 'text' || q.kind === 'cloze') captureInputs(q);
    if (!isResponseComplete(q, ss.responses[ss.index])) {
      const err = $('quiz-card').querySelector('[data-input-error]');
      const msg = q.kind === 'cloze'
        ? '回答を入力してください（未入力の空欄があります。わからない場合は「わからない」を押してください）。'
        : '回答を入力してください（わからない場合は「わからない」を押してください）。';
      err.textContent = msg;
      err.hidden = false;
      const firstEmpty = [...$('quiz-card').querySelectorAll('.answer-input')].find(i => normalizeInput(i.value) === '');
      (firstEmpty || err).focus?.({ preventScroll: false });
      return;
    }
    if (ss.index < ss.questions.length - 1) {
      ss.index += 1;
      renderQuestion();
    } else {
      gradeSession();
    }
  }

  function goPrev() {
    const ss = state.session;
    if (!ss || ss.phase !== 'answering' || ss.index === 0) return;
    const q = currentQ();
    if (q.kind === 'text' || q.kind === 'cloze') captureInputs(q);
    ss.index -= 1;
    renderQuestion();
  }

  // =======================
  // 一括採点（ここで初めて正誤判定・習得度更新・保存を行う）
  // =======================
  function gradeQuestion(q, resp) {
    const r = resp || {};
    if (q.kind === 'choice' || q.kind === 'image-choice') {
      return { correct: !r.gaveUp && !!r.choice && r.choice === q.raw.answer, response: { choice: r.choice ?? null, gaveUp: !!r.gaveUp } };
    }
    if (q.kind === 'text') {
      const text = r.gaveUp ? '' : normalizeInput(r.text);
      return { correct: !r.gaveUp && isAccepted(text, q.accepted), response: { text, gaveUp: !!r.gaveUp } };
    }
    const blanks = q.cloze.blanks.map(b => {
      const value = r.gaveUp ? '' : normalizeInput(r.blanks?.find(x => x.id === b.id)?.value);
      return { id: b.id, value, ok: !r.gaveUp && isAccepted(value, b.accepted) };
    });
    return { correct: blanks.every(b => b.ok), response: { blanks, gaveUp: !!r.gaveUp } };
  }

  function gradeSession() {
    const ss = state.session;
    // 二重採点防止：連打・戻る→再実行でも1回だけ
    if (!ss || ss.graded || ss.phase !== 'answering') return;
    ss.graded = true;
    ss.phase = 'graded';
    $('next-btn').disabled = true;

    const graded = ss.questions.map((q, i) => ({ q, ...gradeQuestion(q, ss.responses[i]) }));
    // 習得度は全問まとめて更新し、localStorage へは1回だけ保存する
    for (const g of graded) {
      g.before = stageOf(g.q.id);
      const cur = state.streaks[g.q.id] ?? 0;
      state.streaks[g.q.id] = g.correct ? Math.min(cur + 1, MAX_STREAK) : 0;
      g.after = stageOf(g.q.id);
    }
    saveProgress();
    ss.results = graded;
    showResult();
  }

  function choiceText(q, label) {
    const o = q.options.find(x => x.label === label);
    if (!o) return label || '—';
    if (q.kind === 'image-choice') return `${label}（画像）`;
    return `${label} ${o.text}`;
  }

  function detailsBlock(summary, bodyHtml, open = false) {
    if (!bodyHtml) return '';
    return `<details class="practice-details"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary><div class="practice-details-body">${bodyHtml}</div></details>`;
  }

  function extraNotesHtml(r) {
    const parts = [];
    if (r.focus) parts.push(`<p><strong>着眼点</strong><br>${nl2br(r.focus)}</p>`);
    if (r.trap) parts.push(`<p><strong>迷いどころ</strong><br>${nl2br(r.trap)}</p>`);
    if (r.visual_details) parts.push(`<p><strong>資料の要点</strong><br>${nl2br(r.visual_details)}</p>`);
    return parts.join('');
  }

  // 結果画面の「問題と解説を見る」の中身（採点後のみ呼ばれる）
  function feedbackBodyHtml(q, rec) {
    const r = q.raw;
    const rows = [];
    if (q.kind === 'cloze') {
      rows.push(clozeResultTable(q, rec));
      rows.push(`<div class="model-answer"><strong class="answer-title">模範解答</strong><p>${clozeTextHtml(q.cloze, Object.fromEntries(rec.response.blanks.map(b => [b.id, b])))}</p></div>`);
    }
    if (r.explanation) rows.push(`<div class="explanation"><strong class="answer-title">解説</strong>${nl2br(r.explanation)}</div>`);
    if ((q.kind === 'choice' || q.kind === 'image-choice') && r.choice_explanations?.length) {
      rows.push(detailsBlock('各選択肢の解説', `<ul class="choice-exp-list">${r.choice_explanations.map(c =>
        `<li><strong>${escapeHtml(c.label)}</strong> ${nl2br(c.explanation)}</li>`).join('')}</ul>`));
    }
    if (q.kind === 'text' && r.accepted_variants) rows.push(detailsBlock('表記・正答の範囲（補足）', `<p>${nl2br(r.accepted_variants)}</p>`));
    if (q.kind === 'cloze' && r.grading_points) rows.push(detailsBlock('採点のポイント', `<p>${nl2br(r.grading_points)}</p>`));
    const notes = extraNotesHtml(r);
    if (notes) rows.push(detailsBlock('着眼点・補足', notes));
    return rows.join('');
  }

  function clozeResultTable(q, rec) {
    return `
      <table class="cloze-result">
        <caption class="visually-hidden">空欄ごとの採点結果</caption>
        <thead><tr><th scope="col">空欄</th><th scope="col">あなたの回答</th><th scope="col">正答</th><th scope="col">判定</th></tr></thead>
        <tbody>
          ${q.cloze.blanks.map(b => {
            const r = rec.response.blanks.find(x => x.id === b.id) || { value: '', ok: false };
            return `<tr class="${r.ok ? 'is-ok' : 'is-ng'}">
              <th scope="row">${b.id}</th>
              <td>${r.value ? escapeHtml(r.value) : '<span class="muted">（未入力）</span>'}</td>
              <td>${escapeHtml(b.answer)}</td>
              <td class="judge">${r.ok ? '○ 正解' : '× 不正解'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // =======================
  // 生成AI相談プロンプト（コピーのみ。外部送信なし）
  // =======================
  function buildPrompt(q, rec) {
    const r = q.raw;
    const L = [
      '歴史能力検定 日本史1級（非公式模擬試験）の次の問題について解説してください。',
      '',
      '【出典】', `第${q.mockNo}回模試 第${q.number}問（${q.type}／${q.period || '時代不明'}）`,
      '', '【問題】', String(r.text || '').trim()
    ];
    if (r.roman_items?.length) {
      L.push('', '【年代整序などの項目】', ...r.roman_items.map(i => `${i.label} ${i.text}`));
    }
    if (r.source) L.push('', '【史料】', r.source);
    if (r.visual_material) L.push('', '【資料】', r.visual_material);
    if (q.kind === 'choice') {
      L.push('', '【選択肢】', ...q.options.map(o => `${o.label} ${o.text}`));
    } else if (q.kind === 'image-choice') {
      L.push('', '【選択肢】', '①〜④は画像の選択肢です。', ...q.options.map(o => `${o.label} ${o.alt || '（画像）'}`));
    }
    if (q.kind === 'choice' || q.kind === 'image-choice') {
      L.push('', '【正解】', choiceText(q, r.answer), '', '【私の解答】', choiceText(q, rec.response.choice));
    } else if (q.kind === 'text') {
      L.push('', '【正解】', r.answer, '', '【私の回答】', rec.response.gaveUp ? '（わからなかった）' : rec.response.text);
    } else if (q.kind === 'cloze') {
      L.push('', '【虫食いにした模範解答】', q.cloze.text.replace(/\{\{(\d+)\}\}/g, '（空欄$1）'));
      L.push('', '【空欄ごとの正答と私の回答】');
      q.cloze.blanks.forEach(b => {
        const mine = rec.response.blanks.find(x => x.id === b.id);
        L.push(`空欄${b.id}：正答「${b.answer}」／私の回答「${mine?.value || '未入力'}」（${mine?.ok ? '正解' : '不正解'}）`);
      });
      L.push('', '【模範解答】', r.model_answer);
    }
    L.push('', `【判定】${rec.correct ? '正解' : '不正解'}`);
    if (r.explanation) L.push('', '【参考：サイトの解説】', r.explanation);
    L.push('',
      '正解の根拠、関連する史実・用語、紛らわしい事項との違いを、日本史1級レベルで解説してください。',
      '私の回答が誤っている場合は、どこで判断を誤ったかと覚え方も教えてください。');
    return L.join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;font-size:16px;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } finally { ta.remove(); }
    if (!ok) throw new Error('copy failed');
  }

  function bindAiCopy(container, q, rec) {
    const btn = container.querySelector('[data-ai-copy]');
    const status = container.querySelector('.ai-prompt-status');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await copyText(buildPrompt(q, rec));
        status.textContent = 'コピーしました';
      } catch (err) {
        console.warn('プロンプトをコピーできませんでした', err);
        status.textContent = 'コピーできませんでした';
      }
      window.setTimeout(() => { status.textContent = ''; }, 2500);
    });
  }

  // =======================
  // 結果画面（採点後にのみ表示）
  // =======================
  function showResult() {
    const ss = state.session;
    if (!ss || !ss.results) return;
    const done = ss.results.map(g => ({ q: g.q, rec: g }));
    const total = done.length;
    const correct = done.filter(x => x.rec.correct).length;
    const wrong = total - correct;
    const pct = total ? Math.round((correct / total) * 1000) / 10 : 0;

    $('score-line').innerHTML = `得点 <span class="score-num">${correct}</span> / ${total}`;
    $('result-stats').innerHTML = `
      <div><dt>出題数</dt><dd>${total}<small>問</small></dd></div>
      <div><dt>正解</dt><dd>${correct}<small>問</small></dd></div>
      <div><dt>不正解</dt><dd>${wrong}<small>問</small></dd></div>
      <div><dt>正答率</dt><dd>${pct}<small>%</small></dd></div>`;

    const up = done.filter(x => x.rec.correct).length;
    const promoted = done.filter(x => x.rec.after === 'triple' && x.rec.before !== 'triple').length;
    const dropped = done.filter(x => !x.rec.correct && !['new', 'miss'].includes(x.rec.before)).length;
    const changes = [];
    if (up) changes.push(`習得度アップ ${up}問`);
    if (promoted) changes.push(`トリプル到達 ${promoted}問`);
    if (dropped) changes.push(`ミスに後退 ${dropped}問`);
    $('result-changes').textContent = changes.join('　／　');

    $('result-list').innerHTML = done.map(({ q, rec }, i) => resultItemHtml(q, rec, i)).join('');
    $('result-list').querySelectorAll('[data-result-index]').forEach(el => {
      const i = Number(el.dataset.resultIndex);
      const { q, rec } = done[i];
      bindAiCopy(el, q, rec);
    });

    $('retry-wrong-btn').hidden = wrong === 0;
    $('retry-wrong-btn').textContent = `間違えた問題をもう一度（${wrong}問）`;
    ss.done = done;

    showScreen('screen-result');
    renderMastery();
    updateSetup();
    scrollTopNow();
    $('result-heading').focus({ preventScroll: true });
  }

  function resultChoicesHtml(q, rec) {
    const chosen = rec.response.choice;
    const ans = q.raw.answer;
    const stateText = (label) => {
      const a = label === ans; const c = label === chosen;
      return a && c ? '○ 正解（あなたの解答）' : a ? '○ 正解' : c ? '× あなたの解答' : '';
    };
    const cls = (label) => `${label === ans ? ' is-answer' : ''}${label === chosen && label !== ans ? ' is-wrong' : ''}`;
    if (q.kind === 'choice') {
      return `<ol class="result-choices">${q.options.map((o, i) => `
        <li class="result-choice${cls(o.label)}">
          <span class="choice-mark" aria-hidden="true">${i + 1}</span>
          <span class="choice-main"><span class="visually-hidden">${escapeHtml(o.label)}</span><span class="choice-body">${escapeHtml(o.text)}</span>
          ${stateText(o.label) ? `<span class="choice-state">${stateText(o.label)}</span>` : ''}</span>
        </li>`).join('')}</ol>`;
    }
    return `<div class="image-choice-grid result-image-choices">${q.options.map((o, i) => `
      <div class="result-choice image-result${cls(o.label)}">
        <span class="image-choice-frame"><img src="${escapeHtml(o.src)}" alt="${escapeHtml(o.alt || `選択肢${o.label}の画像`)}" loading="lazy"></span>
        <span class="image-choice-caption"><span class="choice-mark" aria-hidden="true">${i + 1}</span><span class="visually-hidden">${escapeHtml(o.label)}</span>
        ${stateText(o.label) ? `<span class="choice-state">${stateText(o.label)}</span>` : ''}</span>
      </div>`).join('')}</div>`;
  }

  function resultItemHtml(q, rec, index) {
    const r = q.raw;
    let answerRows = '';
    if (q.kind === 'choice' || q.kind === 'image-choice') {
      answerRows = `
        <div><dt>あなたの解答</dt><dd class="${rec.correct ? 'is-ok' : 'is-ng'}">${rec.response.gaveUp || !rec.response.choice ? '（わからない）' : nl2br(choiceText(q, rec.response.choice))}</dd></div>
        <div><dt>正答</dt><dd class="is-answer">${nl2br(choiceText(q, r.answer))}</dd></div>`;
    } else if (q.kind === 'text') {
      answerRows = `
        <div><dt>あなたの回答</dt><dd class="${rec.correct ? 'is-ok' : 'is-ng'}">${rec.response.gaveUp ? '（わからない）' : escapeHtml(rec.response.text)}</dd></div>
        <div><dt>正答</dt><dd class="is-answer">${escapeHtml(r.answer)}</dd></div>`;
    } else {
      answerRows = q.cloze.blanks.map(b => {
        const m = rec.response.blanks.find(x => x.id === b.id) || {};
        return `<div><dt>空欄${b.id}</dt><dd>あなた「${m.value ? escapeHtml(m.value) : '未入力'}」／正答「${escapeHtml(b.answer)}」 <span class="judge-inline ${m.ok ? 'is-ok' : 'is-ng'}">${m.ok ? '○ 正解' : '× 不正解'}</span></dd></div>`;
      }).join('');
    }
    const transition = `<p class="stage-transition">習得度：<span class="stage-tag stage-${rec.before}">${escapeHtml(stageLabel(rec.before))}</span> → <span class="stage-tag stage-${rec.after}">${escapeHtml(stageLabel(rec.after))}</span></p>`;
    const body = `
      ${materialHtml(q)}
      ${q.kind === 'choice' || q.kind === 'image-choice' ? resultChoicesHtml(q, rec) : ''}
      ${feedbackBodyHtml(q, rec)}
      <div class="ai-prompt-row"><button type="button" class="btn-quiet ai-prompt-btn" data-ai-copy>生成AIに相談するプロンプトをコピー</button><span class="ai-prompt-status" aria-live="polite"></span></div>`;
    return `
      <li class="result-item ${rec.correct ? 'is-correct' : 'is-wrong'}" data-result-index="${index}">
        <p class="result-head">
          <span class="result-mark ${rec.correct ? 'is-correct' : 'is-wrong'}"><span aria-hidden="true">${rec.correct ? '○' : '×'}</span>${rec.correct ? '正解' : '不正解'}</span>
          <span class="result-meta">第${q.mockNo}回 第${q.number}問 ・ ${escapeHtml(q.type)}${q.period ? ` ・ ${escapeHtml(q.period)}` : ''}</span>
        </p>
        <dl class="result-answers">${answerRows}</dl>
        ${transition}
        ${detailsBlock('問題と解説を見る', body, !rec.correct)}
      </li>`;
  }

  // =======================
  // 画面遷移
  // =======================
  function showScreen(id) {
    ['screen-setup', 'screen-quiz', 'screen-result'].forEach(s => { $(s).hidden = s !== id; });
    document.body.dataset.screen = id;
  }

  function scrollTopNow() {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  }

  function backToSetup() {
    state.session = null;
    showScreen('screen-setup');
    renderMastery();
    updateSetup();
    scrollTopNow();
  }

  const QUIT_MESSAGE = '演習を中断しますか？\nこのセッションの回答は採点されず、習得度にも反映されません。';

  function quitSession() {
    if (!window.confirm(QUIT_MESSAGE)) return;
    backToSetup(); // 採点・習得度更新は一切しない
  }

  function confirmLeave() {
    if (!sessionActive()) return true;
    return window.confirm(QUIT_MESSAGE + '\n（模試モードへ移動します）');
  }


  // =======================
  // 画像拡大
  // =======================
  function openZoom(src, alt, title) {
    const dlg = $('image-dialog');
    if (!dlg || typeof dlg.showModal !== 'function') {
      window.open(src, '_blank', 'noopener');
      return;
    }
    $('image-dialog-img').src = src;
    $('image-dialog-img').alt = alt || '';
    $('image-dialog-title').textContent = title || '';
    dlg.showModal();
  }

  // =======================
  // キーボード
  // =======================
  function onKeydown(e) {
    if ($('screen-quiz').hidden || !state.session || state.session.phase !== 'answering') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ($('image-dialog')?.open) return;
    const t = e.target;
    const inField = t?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (inField) return;
    const q = currentQ();

    if ((q.kind === 'choice' || q.kind === 'image-choice') && /^[1-4]$/.test(e.key)) {
      const btn = $('quiz-card').querySelector(`.choice-btn[data-key="${e.key}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      const interactive = t?.matches?.('button, a, summary, [role="button"]');
      if (!interactive) { e.preventDefault(); goNext(); }
    }
  }


  // =======================
  // 初期化
  // =======================
  function showLoadNotice(lines) {
    const box = $('load-notice');
    if (!lines.length) { box.hidden = true; return; }
    box.innerHTML = `<div class="notice" role="alert">${lines.map(l => `<p>${l}</p>`).join('')}</div>`;
    box.hidden = false;
  }

  function afterLoad(failed) {
    const notices = [];
    if (failed.length) notices.push(`読み込めなかった回次があります：${failed.map(escapeHtml).join('、')}。他の回次は演習できます。`);
    if (state.all.length === 0) notices.push('問題データを読み込めませんでした。通信状況を確認して再読み込みしてください。');
    if (state.skipped.length) notices.push(`データに不備のある${state.skipped.length}問を演習の対象から除外しました。`);
    showLoadNotice(notices);
    $('total-question-count').textContent = String(state.all.length);
    renderSetupControls(loadSettings());
    renderMastery();
    updateSetup();
  }

  function showFileModeNotice() {
    const box = $('load-notice');
    box.innerHTML = `
      <div class="notice notice-file" role="alert">
        <p><strong>このページはファイルとして直接開かれています（file://）。</strong></p>
        <p>ブラウザの安全上の制限で、この状態では問題データ（data/mock001.json〜）を自動で読み込めません。
        GitHub Pages などの Web サーバー経由で開くか、リポジトリのフォルダで <code>python3 -m http.server</code> を実行して
        <code>http://localhost:8000/practice.html</code> を開いてください。</p>
        <p>このまま使う場合は、<strong>data フォルダ内の mock001.json〜mock029.json をすべて選択</strong>して読み込めます。</p>
        <p><button type="button" class="btn-pill-small" id="pick-json-btn">data フォルダのJSONを選んで読み込む</button></p>
      </div>`;
    box.hidden = false;
    $('mastery-headline').textContent = '問題データ未読込';
    $('target-summary').innerHTML = '<span class="target-empty">問題データを読み込むと開始できます</span>';
    $('start-btn').disabled = true;
    const input = $('folder-input');
    $('pick-json-btn').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = [...input.files];
      const results = await Promise.all(AVAILABLE_MOCKS.map(async meta => {
        const f = files.find(x => x.name === meta.file);
        if (!f) return { meta, error: new Error('未選択') };
        try {
          const data = JSON.parse(await f.text());
          if (!Array.isArray(data.questions)) throw new Error('questions がありません');
          return { meta, data };
        } catch (error) {
          return { meta, error };
        }
      }));
      afterLoad(ingest(results));
    });
  }

  async function init() {
    if (!$('screen-setup')) return;

    state.storageOk = storage.ok;
    state.streaks = loadProgress();
    if (!storage.ok) showStorageWarning();

    // モード切替リンク：演習中は確認
    document.querySelectorAll('[data-mode-link="mock"]').forEach(a => {
      a.addEventListener('click', e => { if (!confirmLeave()) e.preventDefault(); });
    });

    if (window.location.protocol === 'file:') {
      // ブラウザは file:// からの fetch を禁止しているため、HTTP 配信か data フォルダの選択を案内する
      ingest([]);
      showFileModeNotice();
    } else {
      let results;
      try {
        results = await fetchAllMocks();
      } catch (err) {
        console.error(err);
        results = AVAILABLE_MOCKS.map(meta => ({ meta, error: err }));
      }
      afterLoad(ingest(results));
    }

    $('screen-setup').addEventListener('change', e => {
      if (e.target.matches('input')) updateSetup();
    });
    $('mock-select-all').addEventListener('click', () => {
      document.querySelectorAll('input[name="mock"]:not(:disabled)').forEach(i => { i.checked = true; });
      updateSetup();
    });
    $('mock-clear-all').addEventListener('click', () => {
      document.querySelectorAll('input[name="mock"]').forEach(i => { i.checked = false; });
      updateSetup();
    });
    $('reset-progress-btn').addEventListener('click', resetProgress);
    $('start-btn').addEventListener('click', startFromSettings);
    $('next-btn').addEventListener('click', goNext);
    $('prev-btn').addEventListener('click', goPrev);
    $('quit-btn').addEventListener('click', quitSession);
    $('back-setup-btn').addEventListener('click', backToSetup);
    $('retry-same-btn').addEventListener('click', () => {
      const s = state.session?.config?.settings || readSettings();
      const pool = filterPool(s);
      if (!pool.length) {
        backToSetup();
        return;
      }
      startSession(pickQuestions(pool, s.count, s.order), { settings: s });
    });
    $('retry-wrong-btn').addEventListener('click', () => {
      const wrong = (state.session?.done || []).filter(x => !x.rec.correct).map(x => x.q);
      if (wrong.length) startSession(wrong, state.session.config);
    });
    document.addEventListener('keydown', onKeydown);

    // 画像ダイアログ：背景タップで閉じる
    const dlg = $('image-dialog');
    dlg?.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

    // ブラウザの「戻る」で演習中なら確認
    window.addEventListener('popstate', () => {
      if (sessionActive()) {
        if (window.confirm(QUIT_MESSAGE)) {
          backToSetup(); // 採点しない・習得度に反映しない
        } else {
          try { history.pushState({ practice: 'quiz' }, '', ''); } catch (_) { /* noop */ }
        }
      } else if (!$('screen-result').hidden) {
        backToSetup();
      }
    });
  }

  // テスト用に最小限のAPIを公開（UIの動作には不要）
  window.RinPractice = {
    PROGRESS_KEY,
    isAccepted,
    normalizeInput,
    stageOf,
    get questions() { return state.all; },
    get loadStats() { return state.loadStats; },
    get streaks() { return { ...state.streaks }; },
    get sessionPhase() { return state.session ? state.session.phase : null; },
    get sessionResponses() { return state.session ? JSON.parse(JSON.stringify(state.session.responses)) : null; }
  };

  window.addEventListener('DOMContentLoaded', init);
})();
