const AVAILABLE_MOCKS = [
  { id: '001', file: 'mock001.json', label: '第1回模試', note: '30問 / 4択20・記述8・論述2' }
];

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function getMockIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('mock') || AVAILABLE_MOCKS[0]?.id || '001';
}

function findMockMeta(mockId) {
  return AVAILABLE_MOCKS.find(m => m.id === mockId) || AVAILABLE_MOCKS[0];
}

async function fetchMockData(mockId) {
  const meta = findMockMeta(mockId);
  const path = `data/${meta.file}`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`模試データを取得できませんでした: ${path}`);
  const json = await res.json();
  json.__meta = meta;
  return json;
}

function countByType(questions) {
  const counts = {};
  for (const q of questions) counts[q.type] = (counts[q.type] || 0) + 1;
  return counts;
}

function buildMetaBlock(data) {
  const counts = countByType(data.questions || []);
  const typeSummary = Object.entries(counts).map(([k, v]) => `${k} ${v}問`).join(' / ');
  return `
    <h2>${escapeHtml(data.__meta?.label || data.title || '模試')}</h2>
    <p>${escapeHtml(data.title || '')}</p>
    <div class="meta-row">
      <span class="badge">問題数 ${escapeHtml(data.question_count ?? data.questions?.length ?? 0)}問</span>
      <span class="badge">${escapeHtml(typeSummary || '形式情報なし')}</span>
      <span class="badge">白背景・本番風レイアウト</span>
    </div>
  `;
}

function renderRomanItems(q) {
  if (!q.roman_items?.length) return '';
  return `
    <div class="roman-items">
      ${q.roman_items.map(item => `
        <div class="roman-item">
          <div class="roman-label">${escapeHtml(item.label)}</div>
          <div>${nl2br(item.text)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderChoices(q) {
  if (!q.choices?.length) return '';
  return `
    <ol class="choice-list">
      ${q.choices.map(choice => `
        <li>
          <div class="choice-label">${escapeHtml(choice.label)}</div>
          <div>${nl2br(choice.text)}</div>
        </li>
      `).join('')}
    </ol>
  `;
}

function renderQuestionCard(q) {
  return `
    <section class="question-card" id="q${q.number}">
      <div class="question-head">
        <div class="question-label">問${q.number}</div>
      </div>

      <p class="question-text">${nl2br(q.text || '')}</p>

      ${renderRomanItems(q)}

      ${q.visual_material ? `<div class="visual-box"><strong>使用資料</strong><br>${nl2br(q.visual_material)}</div>` : ''}
      ${q.source ? `<div class="source-box"><strong>史料</strong><br>${nl2br(q.source)}</div>` : ''}
      ${renderChoices(q)}
    </section>
  `;
}

function renderAnswerNotes(q) {
  const blocks = [];
  if (q.accepted_variants) blocks.push(`<p><strong>表記揺れ</strong><br>${nl2br(q.accepted_variants)}</p>`);
  if (q.grading_points) blocks.push(`<p><strong>採点のポイント</strong><br>${nl2br(q.grading_points)}</p>`);
  if (q.focus) blocks.push(`<p><strong>着眼点</strong><br>${nl2br(q.focus)}</p>`);
  if (q.trap) blocks.push(`<p><strong>迷いどころ</strong><br>${nl2br(q.trap)}</p>`);
  if (q.visual_details) blocks.push(`<p><strong>資料の要点</strong><br>${nl2br(q.visual_details)}</p>`);

  if (q.notes && typeof q.notes === 'object') {
    for (const [key, value] of Object.entries(q.notes)) {
      blocks.push(`<p><strong>${escapeHtml(key)}</strong><br>${nl2br(value)}</p>`);
    }
  }

  return blocks.length ? `<div class="answer-notes">${blocks.join('')}</div>` : '';
}

function renderChoiceExplanations(q) {
  if (!q.choice_explanations?.length) return '';
  return `
    <div class="choice-explanations answer-notes">
      <strong>誤答肢の確認</strong>
      <ul>
        ${q.choice_explanations.map(item => `<li><strong>${escapeHtml(item.label)}</strong> ${nl2br(item.explanation)}</li>`).join('')}
      </ul>
    </div>
  `;
}

function renderAnswerCard(q) {
  const mainAnswer = q.model_answer || q.answer || '—';
  return `
    <section class="answer-card" id="a${q.number}">
      <div class="question-head">
        <div class="question-label">問${q.number}</div>
        <div class="question-meta">
          ${q.period ? `<span class="badge">${escapeHtml(q.period)}</span>` : ''}
          ${q.type ? `<span class="badge">${escapeHtml(q.type)}</span>` : ''}
          ${q.difficulty ? `<span class="badge">難易度 ${escapeHtml(q.difficulty)}</span>` : ''}
        </div>
      </div>

      <p class="question-text">${nl2br(q.text || '')}</p>
      ${renderRomanItems(q)}
      ${q.visual_material ? `<div class="visual-box"><strong>使用資料</strong><br>${nl2br(q.visual_material)}</div>` : ''}
      ${q.source ? `<div class="source-box"><strong>史料</strong><br>${nl2br(q.source)}</div>` : ''}
      ${renderChoices(q)}

      <div class="answer-key">
        <div class="answer-title">解答</div>
        <div class="answer-main">${nl2br(mainAnswer)}</div>
      </div>

      ${q.explanation ? `<div class="explanation"><strong class="answer-title">解説</strong><br>${nl2br(q.explanation)}</div>` : ''}
      ${renderChoiceExplanations(q)}
      ${renderAnswerNotes(q)}
    </section>
  `;
}

function renderQuestionJumpLinks(questions, targetPrefix) {
  return questions.map(q => `<a href="#${targetPrefix}${q.number}">問${q.number}</a>`).join('');
}

function setupCrossLinks(mockId) {
  const answerHref = `answers.html?mock=${encodeURIComponent(mockId)}`;
  const questionHref = `exam.html?mock=${encodeURIComponent(mockId)}`;
  const topAnswerLink = byId('top-answer-link');
  const topQuestionLink = byId('top-question-link');
  if (topAnswerLink) topAnswerLink.href = answerHref;
  if (topQuestionLink) topQuestionLink.href = questionHref;
}

function setupBottomNav(mockId, isAnswers) {
  const container = byId(isAnswers ? 'answer-nav-bottom' : 'exam-nav-bottom');
  if (!container) return;
  container.innerHTML = `
    <a href="index.html">模試一覧へ戻る</a>
    <a href="${isAnswers ? `exam.html?mock=${encodeURIComponent(mockId)}` : `answers.html?mock=${encodeURIComponent(mockId)}`}">
      ${isAnswers ? '問題ページへ戻る' : '解答を見る'}
    </a>
  `;
}

function renderHomePage() {
  const mount = byId('mock-list');
  if (!mount) return;
  mount.innerHTML = AVAILABLE_MOCKS.map(mock => `
    <article class="mock-card">
      <h3>${escapeHtml(mock.label)}</h3>
      <div class="mock-meta">${escapeHtml(mock.note || '')}<br><code>data/${escapeHtml(mock.file)}</code></div>
      <div class="mock-actions">
        <a href="exam.html?mock=${encodeURIComponent(mock.id)}">問題ページ</a>
        <a href="answers.html?mock=${encodeURIComponent(mock.id)}">解答ページ</a>
      </div>
    </article>
  `).join('');
}

async function renderExamPage() {
  const mockId = getMockIdFromQuery();
  setupCrossLinks(mockId);
  try {
    const data = await fetchMockData(mockId);
    const meta = byId('exam-meta');
    const mount = byId('exam-container');
    const jumps = byId('exam-nav-top');
    byId('page-title').textContent = `問題ページ｜${data.__meta?.label || ''}`;
    meta.innerHTML = '';
    meta.style.display = 'none';
    jumps.innerHTML = '';
    jumps.style.display = 'none';
    mount.innerHTML = data.questions.map(renderQuestionCard).join('');
    setupBottomNav(mockId, false);
  } catch (err) {
    const mount = byId('exam-container');
    if (mount) mount.innerHTML = `<div class="notice">${escapeHtml(err.message)}</div>`;
  }
}

async function renderAnswersPage() {
  const mockId = getMockIdFromQuery();
  setupCrossLinks(mockId);
  try {
    const data = await fetchMockData(mockId);
    const meta = byId('exam-meta');
    const mount = byId('answers-container');
    const jumps = byId('answer-nav-top');
    byId('page-title').textContent = `解答ページ｜${data.__meta?.label || ''}`;
    meta.innerHTML = buildMetaBlock(data);
    jumps.innerHTML = renderQuestionJumpLinks(data.questions, 'a');
    mount.innerHTML = data.questions.map(renderAnswerCard).join('');
    setupBottomNav(mockId, true);
  } catch (err) {
    const mount = byId('answers-container');
    if (mount) mount.innerHTML = `<div class="notice">${escapeHtml(err.message)}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (byId('mock-list')) renderHomePage();
  if (byId('exam-container')) renderExamPage();
  if (byId('answers-container')) renderAnswersPage();
});
