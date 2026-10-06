(() => {
  'use strict';

  const DATA_PATH = 'data/rekiken_core_250.json';
  const STORAGE_KEY = 'rin-japanese-history-essay-progress-v1';
  const PERIODS = ['原始・古代', '中世', '近世', '近現代'];
  const IMPORTANCES = ['S', 'A', 'B'];
  const STATUSES = [
    { id: 'new', label: '未着手' },
    { id: 'review', label: '要復習' },
    { id: 'learned', label: '習得' }
  ];
  const COUNTS = [5, 10, 20, 'all'];

  const $ = (id) => document.getElementById(id);
  const state = {
    data: null,
    items: [],
    progress: loadProgress(),
    periods: new Set(PERIODS),
    importances: new Set(IMPORTANCES),
    statuses: new Set(STATUSES.map(s => s.id)),
    count: 10,
    order: 'sequential',
    session: [],
    index: 0,
    drafts: new Map(),
    writingOpen: new Set(),
    revealed: new Set()
  };

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch (_) {
      // file:// や厳格なプライバシー設定では保存できない場合がある。学習自体は継続する。
    }
  }

  function statusOf(item) {
    const value = state.progress[String(item.id)];
    return value === 'review' || value === 'learned' ? value : 'new';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shuffle(array) {
    const a = [...array];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function countChars(text) {
    return Array.from(String(text || '').replace(/\r?\n/g, '')).length;
  }

  function candidateItems() {
    return state.items.filter(item =>
      state.periods.has(item.period) &&
      state.importances.has(item.importance) &&
      state.statuses.has(statusOf(item))
    );
  }

  function renderFilterGroup(containerId, values, selectedSet, labeler, classer) {
    const container = $(containerId);
    if (!container) return;
    container.innerHTML = values.map(value => {
      const active = selectedSet.has(value);
      const extra = classer ? classer(value) : '';
      return `<button type="button" class="filter-btn ${escapeHtml(extra)}" data-value="${escapeHtml(value)}" aria-pressed="${active}">${escapeHtml(labeler(value))}</button>`;
    }).join('');
    container.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.value;
        if (selectedSet.has(value)) {
          if (selectedSet.size > 1) selectedSet.delete(value);
        } else {
          selectedSet.add(value);
        }
        renderSetup();
      });
    });
  }

  function renderCountOptions() {
    const container = $('count-options');
    container.innerHTML = COUNTS.map(value => {
      const label = value === 'all' ? 'すべて' : String(value);
      return `<button type="button" class="count-btn" data-count="${value}" aria-pressed="${state.count === value}">${label}</button>`;
    }).join('');
    container.querySelectorAll('.count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.count;
        state.count = raw === 'all' ? 'all' : Number(raw);
        renderSetup();
      });
    });
  }

  function renderProgress() {
    const counts = { new: 0, review: 0, learned: 0 };
    for (const item of state.items) counts[statusOf(item)] += 1;
    const total = state.items.length || 1;
    const learnedPct = Math.round((counts.learned / total) * 100);
    $('progress-headline').textContent = `習得 ${counts.learned} / ${state.items.length}テーマ（${learnedPct}%）`;
    $('progress-fill').style.width = `${learnedPct}%`;
    $('count-new').textContent = counts.new;
    $('count-review').textContent = counts.review;
    $('count-learned').textContent = counts.learned;

    $('period-progress').innerHTML = PERIODS.map(period => {
      const items = state.items.filter(item => item.period === period);
      const learned = items.filter(item => statusOf(item) === 'learned').length;
      return `<div class="period-stat"><span>${escapeHtml(period)}</span><b>${learned} / ${items.length}</b></div>`;
    }).join('');
  }

  function renderThemeList() {
    const query = ($('theme-search')?.value || '').trim().toLowerCase();
    let items = candidateItems();
    if (query) {
      items = items.filter(item => {
        const hay = [item.theme, item.question, ...(item.knowledge_nodes || [])].join(' ').toLowerCase();
        return hay.includes(query);
      });
    }
    const list = $('theme-list');
    if (!items.length) {
      list.innerHTML = '<p class="empty-note">該当するテーマがありません。</p>';
      return;
    }
    list.innerHTML = items.map(item => `
      <button type="button" class="theme-list-btn" data-id="${item.id}">
        <span class="theme-no">#${String(item.id).padStart(3, '0')}</span>
        <span class="theme-list-title">${escapeHtml(item.theme)}</span>
        <span class="theme-list-meta">${escapeHtml(item.period)} / ${escapeHtml(item.importance)} / ${escapeHtml(statusLabel(statusOf(item)))}</span>
      </button>
    `).join('');
    list.querySelectorAll('.theme-list-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = state.items.find(x => String(x.id) === btn.dataset.id);
        if (item) startSession([item]);
      });
    });
  }

  function statusLabel(status) {
    return STATUSES.find(x => x.id === status)?.label || '未着手';
  }

  function renderSetup() {
    renderProgress();
    renderFilterGroup('period-options', PERIODS, state.periods, v => v);
    renderFilterGroup('importance-options', IMPORTANCES, state.importances, v => `${v}ランク`, v => `importance-${v}`);
    renderFilterGroup('status-options', STATUSES.map(s => s.id), state.statuses, statusLabel);
    renderCountOptions();
    const count = candidateItems().length;
    $('candidate-note').textContent = `対象 ${count}テーマ`;
    $('start-btn').disabled = count === 0;
    renderThemeList();
  }

  function startSession(explicitItems = null) {
    let items = explicitItems ? [...explicitItems] : candidateItems();
    state.order = document.querySelector('input[name="order"]:checked')?.value || 'sequential';
    if (!explicitItems && state.order === 'random') items = shuffle(items);
    if (!explicitItems && state.count !== 'all') items = items.slice(0, Number(state.count));
    if (!items.length) return;
    state.session = items;
    state.index = 0;
    state.drafts = new Map();
    state.writingOpen = new Set();
    state.revealed = new Set();
    showScreen('study');
    renderCurrent();
  }

  function showScreen(name) {
    $('screen-setup').hidden = name !== 'setup';
    $('screen-study').hidden = name !== 'study';
    document.body.dataset.screen = name;
    if (name === 'setup') renderSetup();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function currentItem() {
    return state.session[state.index];
  }

  function renderCurrent() {
    const item = currentItem();
    if (!item) return;
    const key = String(item.id);
    const draft = state.drafts.get(key) || '';
    const revealed = state.revealed.has(key);
    const writing = state.writingOpen.has(key) || Boolean(draft);

    $('study-meta').textContent = `日本史コア250  #${String(item.id).padStart(3, '0')}`;
    $('study-counter').textContent = `${state.index + 1} / ${state.session.length}`;
    $('session-progress-fill').style.width = `${((state.index + 1) / state.session.length) * 100}%`;
    $('study-period').textContent = item.period;
    $('study-theme').textContent = item.theme;
    $('study-importance').textContent = item.importance;
    $('study-importance').className = `importance-badge is-${item.importance}`;
    $('study-question').textContent = item.question;

    $('writing-panel').hidden = !writing;
    $('answer-input').value = draft;
    updateCharCount();

    $('answer-panel').hidden = !revealed;
    $('core-answer').textContent = item.answer;
    $('knowledge-nodes').innerHTML = (item.knowledge_nodes || []).map(node => `<span class="node-chip">${escapeHtml(node)}</span>`).join('');
    renderSelfAnswer();
    renderRating(item);
    $('ai-review-btn').disabled = !draft.trim();

    $('write-btn').textContent = writing ? '80字入力を閉じる' : '80字で書いてみる';
    $('reveal-btn').textContent = revealed ? '答えを表示中' : '答えを見る';
    $('reveal-btn').disabled = revealed;
    $('prev-btn').disabled = state.index === 0;
    $('next-btn').textContent = state.index === state.session.length - 1 ? '学習を終える' : '次へ';
  }

  function updateCharCount() {
    const count = countChars($('answer-input').value);
    const el = $('char-count');
    el.textContent = `${count} / 80字`;
    el.classList.toggle('is-over', count > 80);
  }

  function saveDraft() {
    const item = currentItem();
    if (!item) return;
    const value = $('answer-input').value;
    if (value) state.drafts.set(String(item.id), value);
    else state.drafts.delete(String(item.id));
  }

  function renderSelfAnswer() {
    const item = currentItem();
    const draft = item ? (state.drafts.get(String(item.id)) || '') : '';
    $('self-answer-compare').hidden = !draft.trim();
    $('self-answer-text').textContent = draft;
  }

  function renderRating(item) {
    const current = statusOf(item);
    document.querySelectorAll('.rating-btn').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.rate === current);
    });
    $('rating-note').textContent = current === 'new' ? 'まだ状態は記録されていません。' : `現在：${statusLabel(current)}`;
  }

  function rateCurrent(status) {
    const item = currentItem();
    if (!item) return;
    state.progress[String(item.id)] = status;
    saveProgress();
    renderRating(item);
  }

  function buildReviewPrompt(item, userAnswer) {
    return `私は歴史能力検定 日本史1級の論述対策をしています。\n\n【テーマ】\n${item.theme}\n\n【問題】\n${item.question}\n\n【私の答案】\n${userAnswer}\n\n【参考回答】\n${item.answer}\n\n【重要知識】\n${(item.knowledge_nodes || []).join('、')}\n\n私の答案を歴史能力検定日本史1級の80字論述として評価してください。\n・史実上の誤り\n・設問要求への対応\n・不足している重要論点\n・不要な記述\n・80字以内への改善方法\n・最後に改善答案（80字以内）\nを示してください。参考回答を絶対視せず、史実に照らして問題があれば指摘してください。`;
  }

  function buildDeepPrompt(item) {
    return `私は歴史能力検定 日本史1級を学習しています。\n\n【テーマ】\n${item.theme}\n\n【問題】\n${item.question}\n\n【コア回答】\n${item.answer}\n\n【重要知識】\n${(item.knowledge_nodes || []).join('、')}\n\nこのテーマを歴史能力検定日本史1級向けに深掘りしてください。\n・回答文の因果関係や構造\n・各重要語の役割\n・前後の時代とのつながり\n・混同しやすい事項\n・別角度ならどのような80字論述が出題できるか\nを簡潔に整理してください。最後に確認問題を2問作ってください。`;
  }

  async function copyText(text, successMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast(successMessage);
    } catch (_) {
      showToast('コピーできませんでした。ブラウザの権限を確認してください。');
    }
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
  }

  function validateData(json) {
    if (!json || !Array.isArray(json.items) || !json.items.length) throw new Error('items が見つかりません。');
    for (const item of json.items) {
      if (!item.id || !item.period || !item.theme || !item.question || !item.answer || !Array.isArray(item.knowledge_nodes)) {
        throw new Error(`ID ${item.id ?? '?'} の必須項目が不足しています。`);
      }
    }
    return json;
  }

  function initialize(json) {
    state.data = validateData(json);
    state.items = [...json.items].sort((a, b) => Number(a.id) - Number(b.id));
    $('total-theme-count').textContent = state.items.length;
    $('load-notice').hidden = true;
    renderSetup();
  }

  async function loadData() {
    try {
      const url = new URL(DATA_PATH, document.baseURI);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      initialize(await res.json());
    } catch (err) {
      const notice = $('load-notice');
      notice.hidden = false;
      notice.innerHTML = `論述対策データを自動で読み込めませんでした。GitHub Pages / HTTP では自動読込されます。<br><button type="button" class="small-btn" id="pick-core-json">rekiken_core_250.json を選択</button>`;
      $('pick-core-json').addEventListener('click', () => $('core-file-input').click());
      console.warn('core data load failed', err);
    }
  }

  function bindEvents() {
    $('start-btn').addEventListener('click', () => startSession());
    $('theme-search').addEventListener('input', renderThemeList);
    document.querySelectorAll('input[name="order"]').forEach(input => input.addEventListener('change', () => { state.order = input.value; }));

    $('write-btn').addEventListener('click', () => {
      const item = currentItem();
      if (!item) return;
      const key = String(item.id);
      if (state.writingOpen.has(key)) state.writingOpen.delete(key);
      else state.writingOpen.add(key);
      renderCurrent();
      if (state.writingOpen.has(key)) $('answer-input').focus();
    });

    $('reveal-btn').addEventListener('click', () => {
      saveDraft();
      const item = currentItem();
      if (!item) return;
      state.revealed.add(String(item.id));
      renderCurrent();
      $('answer-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    $('answer-input').addEventListener('input', () => {
      saveDraft();
      updateCharCount();
      renderSelfAnswer();
      $('ai-review-btn').disabled = !$('answer-input').value.trim();
    });

    document.querySelectorAll('.rating-btn').forEach(btn => {
      btn.addEventListener('click', () => rateCurrent(btn.dataset.rate));
    });

    $('prev-btn').addEventListener('click', () => {
      saveDraft();
      if (state.index > 0) { state.index -= 1; renderCurrent(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });

    $('next-btn').addEventListener('click', () => {
      saveDraft();
      if (state.index >= state.session.length - 1) {
        showScreen('setup');
      } else {
        state.index += 1;
        renderCurrent();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    $('quit-btn').addEventListener('click', () => { saveDraft(); showScreen('setup'); });

    $('ai-review-btn').addEventListener('click', () => {
      saveDraft();
      const item = currentItem();
      const draft = state.drafts.get(String(item.id)) || '';
      if (!draft.trim()) return;
      copyText(buildReviewPrompt(item, draft), 'AI添削用プロンプトをコピーしました');
    });

    $('ai-deep-btn').addEventListener('click', () => {
      const item = currentItem();
      copyText(buildDeepPrompt(item), 'AI深掘り用プロンプトをコピーしました');
    });

    $('reset-progress-btn').addEventListener('click', () => {
      if (!confirm('論述対策の進捗（要復習・習得）をすべて消しますか？')) return;
      state.progress = {};
      saveProgress();
      renderSetup();
    });

    $('core-file-input').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        initialize(json);
      } catch (err) {
        $('load-notice').hidden = false;
        $('load-notice').textContent = `JSONを読み込めませんでした: ${err.message}`;
      }
    });
  }

  bindEvents();
  loadData();
})();
