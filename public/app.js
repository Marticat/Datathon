'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const attr = escape;
  const formatNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) : '—';
  const formatDate = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  const languageName = (value) => ({ RU: 'Русский', KZ: 'Қазақша', EN: 'English' }[value] || value || 'Язык не указан');
  const channelName = (value) => ({ 'agent chat': 'Чат', 'voice call': 'Звонок' }[value] || value || 'Канал не указан');
  const state = { conversations: [], rubrics: [], evaluations: [], appeals: [], jobs: [], settings: {}, health: null, selectedId: null, rubricId: null, historicalId: null, selected: new Set(), expanded: new Set(), busy: new Set(), loaded: false, loadError: '', transcriptKey: '', pollTimer: null, pollBusy: false, pendingReviewRender: false, reviewDrafts: new Map(), editor: [] };

  async function api(path, body, timeout = 0) {
    const controller = timeout ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await fetch(path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ...(controller ? { signal: controller.signal } : {}) });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) throw new Error(`Сервер вернул неожиданный ответ (${response.status}). Проверьте, запущено ли приложение.`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Ошибка запроса: ${response.status}`);
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(path === '/api/jobs' ? 'Не удалось подтвердить постановку в очередь. Сервер мог сохранить задачу. Обновите данные, чтобы проверить очередь, прежде чем запускать проверку повторно.' : 'Сервер не ответил вовремя. Проверьте подключение и повторите запрос.');
      if (error instanceof TypeError) throw new Error(path === '/api/jobs' ? 'Соединение с сервером прервано. Сервер мог сохранить задачу в очереди. Обновите данные, прежде чем запускать проверку повторно.' : 'Не удалось связаться с локальным сервером. Проверьте, запущено ли приложение.');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function notify(message, error = false) {
    const notice = $('#notice'); notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`; notice.hidden = !message;
  }

  async function withBusy(key, button, action, errorTarget = null) {
    if (state.busy.has(key)) return;
    state.busy.add(key);
    const controls = button instanceof HTMLFormElement ? [...button.querySelectorAll('button,input,select,textarea')] : button ? [button] : [];
    const previous = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    if (errorTarget) errorTarget.textContent = '';
    updateActions();
    try { await action(); }
    catch (error) { if (errorTarget) errorTarget.textContent = error.message; else notify(error.message, true); }
    finally { state.busy.delete(key); controls.forEach((control, index) => { if (control.isConnected) control.disabled = previous[index]; }); updateActions(); }
  }

  function setData(data) {
    for (const key of ['conversations', 'rubrics', 'evaluations', 'appeals', 'jobs']) state[key] = Array.isArray(data[key]) ? data[key] : [];
    state.settings = data.settings || {};
    state.loaded = true; state.loadError = '';
    if (!state.rubrics.some((rubric) => rubric.id === state.rubricId)) state.rubricId = state.rubrics.at(-1)?.id ?? null;
    const visible = filteredConversations();
    if (!visible.some((conversation) => conversation.conversation_id === state.selectedId)) { state.selectedId = visible[0]?.conversation_id ?? null; state.historicalId = null; }
    state.selected = new Set([...state.selected].filter((id) => state.conversations.some((conversation) => conversation.conversation_id === id)));
  }

  async function refresh(options = {}) {
    const results = await Promise.allSettled([api('/api/state', undefined, 15000), api('/api/health', undefined, 15000)]);
    if (results[0].status === 'fulfilled') setData(results[0].value);
    else { state.loadError = results[0].reason.message; notify(state.loadError, true); }
    if (results[1].status === 'fulfilled') state.health = results[1].value;
    else state.health = { ollama: { online: false, models: [], error: results[1].reason.message }, model: state.settings.model };
    renderAll(); schedulePoll();
    if (options.announce && results[0].status === 'fulfilled') notify('Данные обновлены.');
  }

  function selectedConversation() { return state.conversations.find((conversation) => conversation.conversation_id === state.selectedId); }
  function selectedRubric() { return state.rubrics.find((rubric) => rubric.id === state.rubricId); }
  function currentEvaluation(conversation = selectedConversation()) {
    if (!conversation) return null;
    return [...state.evaluations].reverse().find((evaluation) => evaluation.conversationId === conversation.conversation_id && evaluation.conversationHash === conversation.hash && evaluation.rubricId === state.rubricId) || null;
  }
  function displayedEvaluation() {
    if (state.historicalId) return state.evaluations.find((evaluation) => evaluation.id === state.historicalId && evaluation.conversationId === state.selectedId) || null;
    return currentEvaluation();
  }
  function transcriptConversation() {
    return state.historicalId ? displayedEvaluation()?.conversationSnapshot || selectedConversation() : selectedConversation();
  }
  function activeJobForConversation(conversationId) {
    return state.jobs.find((job) => ['queued', 'running'].includes(job.status) && job.conversationIds.includes(conversationId));
  }
  function evaluationActivity(conversationId = state.selectedId) {
    if (state.busy.has(`evaluate:${conversationId}`)) return { kind: 'submitting', label: 'Добавляем в очередь…', detail: 'Сохраняем задачу на локальном сервере.' };
    const job = activeJobForConversation(conversationId);
    if (!job) return null;
    if (job.results.some((result) => result.conversationId === conversationId)) return { kind: 'finishing', label: 'Пакетная проверка выполняется…', detail: 'Результат этого диалога уже сохранён. Остальные диалоги пакета ещё проверяются.' };
    if (job.status === 'running' && job.currentConversationId === conversationId) return { kind: 'running', label: 'Модель анализирует диалог…', detail: 'Локальная модель проверяет каждый критерий. Результат сохраняется на сервере и появится автоматически.' };
    return { kind: 'queued', label: 'Диалог в очереди…', detail: 'Задача сохранена на сервере. Проверка начнётся, когда завершатся предыдущие диалоги. Можно продолжать работу или вернуться позже.' };
  }
  function evaluationButtonLabel() {
    const activity = evaluationActivity();
    return activity ? `<span class="spinner"></span> ${escape(activity.label)}` : displayedEvaluation() && !state.historicalId ? '↻ Оценить заново' : '✧ Оценить диалог';
  }
  function filteredConversations() {
    const search = $('#search').value.trim().toLocaleLowerCase();
    const language = $('#language-filter').value; const channel = $('#channel-filter').value;
    return state.conversations.filter((conversation) => (!language || conversation.language === language) && (!channel || conversation.channel === channel) && (!search || `${conversation.conversation_id} ${(conversation.transcript || []).map((message) => message.text).join(' ')}`.toLocaleLowerCase().includes(search)));
  }

  function applyConversationFilters() {
    const conversations = filteredConversations();
    if (!conversations.some((conversation) => conversation.conversation_id === state.selectedId)) {
      state.selectedId = conversations[0]?.conversation_id ?? null;
      state.historicalId = null;
      state.expanded.clear();
      renderTranscript(); renderReview();
    }
    renderList();
  }

  function renderAll() {
    const rubricSelect = $('#rubric-select');
    rubricSelect.innerHTML = state.rubrics.length ? state.rubrics.map((rubric) => `<option value="${attr(rubric.id)}">${escape(rubric.name)} · v${escape(rubric.version)}</option>`).join('') : '<option value="">Нет чек-листов</option>';
    rubricSelect.value = state.rubricId || '';
    renderHealth(); renderList(); renderTranscript(); renderReview(); renderJobs(); updateActions();
  }

  function empty(icon, title, text, extra = '', classes = '') {
    return `<div class="empty-state ${classes}"><div class="empty-icon" aria-hidden="true">${icon}</div><h3>${escape(title)}</h3><p>${escape(text)}</p>${extra}</div>`;
  }

  function renderList() {
    const conversations = filteredConversations();
    $('#conversation-count').textContent = conversations.length;
    $('#conversation-list').innerHTML = conversations.map((conversation) => {
      const evaluation = currentEvaluation(conversation);
      const activity = evaluationActivity(conversation.conversation_id);
      const queued = activity && activity.kind !== 'finishing';
      const preview = (conversation.transcript || []).find((message) => message.text)?.text || 'Транскрипт пуст';
      const score = evaluation?.finalScore?.total;
      return `<article class="conversation-row ${conversation.conversation_id === state.selectedId ? 'active' : ''}"><input type="checkbox" data-select="${attr(conversation.conversation_id)}" aria-label="Выбрать диалог ${attr(conversation.conversation_id)}" ${state.selected.has(conversation.conversation_id) ? 'checked' : ''}><button class="conversation-open" data-conversation="${attr(conversation.conversation_id)}" ${conversation.conversation_id === state.selectedId ? 'aria-current="true"' : ''}><div class="row-top"><span class="channel-icon" aria-hidden="true">${conversation.channel === 'voice call' ? '♧' : '▤'}</span><span class="conversation-id" title="${attr(conversation.conversation_id)}">${escape(conversation.conversation_id)}</span><span class="language-tag">${escape(conversation.language)}</span></div><div class="conversation-preview">${escape(preview)}</div><div class="row-bottom"><span>${(conversation.transcript || []).length} реплик · ${escape(channelName(conversation.channel))}</span><span class="row-status ${evaluation ? 'scored' : ''}">${queued ? `<span class="spinner"></span> ${activity.kind === 'running' ? 'Проверка' : activity.kind === 'submitting' ? 'Отправка' : 'В очереди'}` : evaluation ? `✓ ${score == null ? 'Нет применимых' : `${formatNumber(score)} / 100`}` : 'Не оценён'}</span></div></button></article>`;
    }).join('') || empty('▤', state.loadError ? 'Сервер недоступен' : state.conversations.length ? 'Ничего не найдено' : 'Начните с диалогов', state.loadError || (state.conversations.length ? 'Попробуйте другой запрос или измените фильтры.' : 'Импортируйте группу организатора или загрузите JSON для первой проверки.'), state.conversations.length || state.loadError ? '' : '<button class="button button-small" data-open-import>＋ Импортировать</button>');
    const all = $('#select-all'); all.checked = conversations.length > 0 && conversations.every((conversation) => state.selected.has(conversation.conversation_id)); all.indeterminate = !all.checked && conversations.some((conversation) => state.selected.has(conversation.conversation_id));
    $('#selected-count').textContent = state.selected.size ? `Выбрано: ${state.selected.size}` : 'Нет выбранных';
    updateActions();
  }

  function speakerKind(speaker) {
    const normalized = String(speaker || '').trim().toLocaleLowerCase();
    if (/^(operator|agent|assistant|оператор|менеджер|сотрудник|консультант|оператор\s*\d+)$/.test(normalized)) return 'operator';
    if (/^(system|система|системное сообщение)$/.test(normalized)) return 'system';
    return 'client';
  }
  function speakerName(speaker) { return ({ operator: 'Оператор', agent: 'Оператор', assistant: 'Оператор', client: 'Клиент', customer: 'Клиент', user: 'Клиент', system: 'Система' }[String(speaker).toLowerCase()] || speaker || 'Участник'); }
  function audioSeconds(timestamp) {
    const match = /^(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(String(timestamp ?? '').trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0) : null;
  }
  function safeAudioUrl(value) {
    if (!value) return '';
    try { const url = new URL(value, location.href); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }

  function renderTranscript() {
    const conversation = transcriptConversation();
    const key = conversation ? `${conversation.conversation_id}:${conversation.hash}:${conversation.audio_url}:${state.historicalId || ''}` : `empty:${state.loadError}`;
    if (key === state.transcriptKey) return;
    state.transcriptKey = key;
    if (!conversation) { $('#transcript').innerHTML = empty('≋', 'Диалог ждёт своего внимания', 'Выберите диалог слева. Здесь появятся исходные реплики, аудио и ссылки на доказательства.'); return; }
    const audio = safeAudioUrl(conversation.audio_url);
    const messages = conversation.transcript || [];
    $('#transcript').innerHTML = `<header class="detail-heading"><div class="detail-heading-top"><h2>${escape(conversation.conversation_id)}</h2><span class="live-label"><i class="status-dot green"></i> ТРАНСКРИПТ</span></div><div class="conversation-meta"><span>${escape(channelName(conversation.channel))}</span><span>·</span><span>${escape(languageName(conversation.language))}</span><span>·</span><span>${messages.length} реплик</span>${conversation.groupId ? `<span>·</span><span>${escape(conversation.groupId)}</span>` : ''}</div></header>${state.historicalId ? '<div class="history-warning">Исходный транскрипт выбранного исторического запуска.</div>' : ''}${audio ? `<div class="audio-panel"><span class="field-caption">ИСХОДНАЯ ЗАПИСЬ</span><audio id="conversation-audio" controls preload="none" src="${attr(audio)}">Браузер не поддерживает аудио.</audio><p class="audio-hint">Переход по времени доступен для отметок MM:SS. Календарные даты не используются как позиция в записи.</p><p id="audio-error" class="form-error" role="status"></p></div>` : conversation.channel === 'voice call' ? '<div class="audio-panel"><p class="audio-hint">Аудиозапись не приложена. Доступен исходный транскрипт.</p></div>' : ''}<div class="transcript-body"><div class="transcript-date">НАЧАЛО ДИАЛОГА</div>${messages.map((message) => {
      const seconds = audio ? audioSeconds(message.timestamp) : null;
      return `<article class="message ${speakerKind(message.speaker)}" id="message-${attr(message.id)}" data-message-id="${attr(message.id)}"><div class="message-meta"><span class="speaker">${escape(speakerName(message.speaker))}</span><span class="message-id">${escape(message.id)}</span><span class="message-time">${seconds != null ? `<button class="seek-button" data-seek="${seconds}" title="Перейти к этому времени в записи">${escape(message.timestamp)}</button>` : escape(message.timestamp)}</span></div><div class="message-text">${escape(message.text)}</div></article>`;
    }).join('') || empty('≋', 'Пустой транскрипт', 'В этом диалоге нет реплик для проверки.') }<div class="transcript-date">КОНЕЦ ДИАЛОГА</div></div>`;
    const audioPlayer = $('#conversation-audio');
    if (audioPlayer) audioPlayer.addEventListener('error', () => { $('#audio-error').textContent = 'Не удалось загрузить запись по исходной ссылке. Проверьте доступность файла.'; });
  }

  function answerLabel(answer) { return answer === 'yes' ? 'Да' : answer === 'no' ? 'Нет' : answer === 'na' ? 'Неприменимо' : typeof answer === 'number' ? formatNumber(answer) : 'Нет ответа'; }
  function answerOptions(criterion, selected) {
    const values = criterion.type === 'scale' ? criterion.scale || [] : ['yes', 'no'];
    return [...values, ...(criterion.allowNA && criterion.type !== 'flag' ? ['na'] : [])].map((value) => `<option value="${attr(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escape(answerLabel(value))}</option>`).join('');
  }
  function scoreText(score) { return score?.total == null ? 'Не рассчитан' : `${formatNumber(score.total)} / 100`; }

  function reviewDraftKey(form) {
    return form.dataset.resolve ? `resolve:${form.dataset.resolve}` : `appeal:${form.dataset.evaluation}:${form.dataset.appealForm}`;
  }
  function rememberReviewDrafts() {
    $$('.appeal-form,.decision-form', $('#review')).forEach((form) => {
      state.reviewDrafts.set(reviewDraftKey(form), { hidden: form.hidden, values: Object.fromEntries($$('[name]', form).map((control) => [control.name, control.value])) });
    });
  }
  function restoreReviewDrafts() {
    $$('.appeal-form,.decision-form', $('#review')).forEach((form) => {
      const draft = state.reviewDrafts.get(reviewDraftKey(form));
      if (!draft) return;
      for (const control of $$('[name]', form)) if (Object.hasOwn(draft.values, control.name)) control.value = draft.values[control.name];
      if (form.matches('.appeal-form')) form.hidden = draft.hidden;
    });
  }
  function flushPendingReview() {
    if (!state.pendingReviewRender || $('#review').contains(document.activeElement) || [...state.busy].some((key) => key.startsWith('appeal:') || key.startsWith('resolve:'))) return;
    renderTranscript(); renderReview();
  }
  function renderReview() {
    rememberReviewDrafts();
    state.pendingReviewRender = false;
    queueMicrotask(restoreReviewDrafts);
    const currentConversation = selectedConversation(); const conversation = transcriptConversation(); const rubric = selectedRubric(); const evaluation = displayedEvaluation();
    const histories = [...state.evaluations].filter((item) => item.conversationId === state.selectedId).reverse();
    const activity = evaluationActivity();
    const header = `<header class="review-header"><div class="title-line"><h2>Оценка качества</h2><span class="field-caption">AI + РЕВЬЮ</span></div><p>${rubric ? `${escape(rubric.name)} · версия ${escape(rubric.version)}` : 'Выберите или создайте чек-лист'}</p><button class="button button-primary evaluate-button" id="evaluate" ${!canEvaluate() ? 'disabled' : ''}>${evaluationButtonLabel()}</button>${!modelReady() ? '<p>Модель недоступна. Проверьте локальное подключение в настройках.</p>' : ''}${histories.length ? `<select class="evaluation-select" id="evaluation-select" aria-label="История оценок"><option value="">Последняя · выбранный чек-лист</option>${histories.map((item) => { const historyRubric = state.rubrics.find((r) => r.id === item.rubricId); return `<option value="${attr(item.id)}" ${state.historicalId === item.id ? 'selected' : ''}>${escape(formatDate(item.createdAt))} · v${escape(historyRubric?.version ?? '?')} · ${escape(item.model)}${item.conversationHash !== conversation?.hash ? ' · старый транскрипт' : ''}</option>`; }).join('')}</select>` : ''}</header>`;
    if (!conversation) { $('#review').innerHTML = header + empty('◌', 'Проверка с опорой на факты', 'После оценки здесь появятся баллы, объяснения по критериям и цитаты из диалога.', '', 'empty-review'); return; }
    if (!evaluation) { $('#review').innerHTML = header + empty('✧', activity ? activity.label : 'Готов к первой проверке', activity ? activity.detail : 'Для выбранной версии чек-листа и текущего транскрипта оценки пока нет. Запустите локальную модель.', '', 'empty-review'); return; }
    const evalRubric = state.rubrics.find((item) => item.id === evaluation.rubricId);
    if (!evalRubric) { $('#review').innerHTML = header + empty('!', 'Чек-лист оценки не найден', 'Невозможно достоверно отобразить критерии этой оценки. Обновите данные.'); return; }
    const finalScore = evaluation.finalScore; const originalScore = evaluation.originalScore;
    const total = finalScore?.total;
    const changed = state.appeals.some((appeal) => appeal.evaluationId === evaluation.id && appeal.status === 'resolved');
    const isOld = evaluation.rubricId !== state.rubricId || evaluation.conversationHash !== currentConversation?.hash;
    const warning = state.historicalId ? `<div class="history-warning">Исторический запуск · ${escape(evalRubric.name)} v${escape(evalRubric.version)}.${isOld ? ' Эта оценка относится к другой версии чек-листа или транскрипта.' : ''}</div>` : '';
    const score = `<section class="score-area"><div class="score-top"><div><div class="score-caption">ИТОГОВАЯ ОЦЕНКА</div><div class="score-large">${total == null ? '—' : formatNumber(total)}<span>/ 100</span></div></div><span class="score-state">${changed ? 'После ревью' : 'AI-оценка'}</span></div>${typeof total === 'number' ? `<progress class="score-progress" max="100" value="${Math.max(0, Math.min(100, total))}" aria-label="Итоговая оценка"></progress>` : '<p class="form-hint">Нет применимых взвешенных критериев.</p>'}<div class="original-score"><span>Исходная оценка модели</span><strong>${escape(scoreText(originalScore))}</strong></div><div class="original-score"><span>Итог с решениями ревьюера</span><strong>${escape(scoreText(finalScore))}</strong></div><div class="gross-flag ${finalScore?.grossViolation ? 'raised' : ''}">${finalScore?.grossViolation ? '⚑ Грубое нарушение зафиксировано' : '✓ Грубые нарушения не зафиксированы'}${changed && originalScore?.grossViolation !== finalScore?.grossViolation ? `<br>Исходный флаг: ${originalScore?.grossViolation ? 'да' : 'нет'}` : ''}<br>Флаг учитывается отдельно от итогового балла.</div></section>`;
    const sections = `<section class="section-scores" aria-label="Баллы по разделам">${(finalScore?.sections || []).map((section) => `<div class="section-score"><span>${escape(section.name)}</span><strong>${formatNumber(section.earned)} / ${formatNumber(section.possible)}</strong></div>`).join('')}</section>`;
    $('#review').innerHTML = header + warning + score + sections + `<h3 class="criteria-title">КРИТЕРИИ ОЦЕНКИ · ${evalRubric.criteria.length}</h3>` + evalRubric.criteria.map((criterion) => renderCriterion(criterion, evaluation, conversation)).join('') + `<div class="evaluation-provenance">Модель: ${escape(evaluation.model)}<br>Запуск: ${escape(formatDate(evaluation.createdAt))}${typeof evaluation.durationMs === 'number' ? ` · ${formatNumber(evaluation.durationMs / 1000)} с` : ''}<br>Промпт: ${escape(evaluation.promptVersion)} · чек-лист v${escape(evalRubric.version)}<br>Hash чек-листа: ${escape(evaluation.rubricHash)}<br>Hash диалога: ${escape(evaluation.conversationHash)}</div>`;
  }

  function renderCriterion(criterion, evaluation, conversation) {
    const answer = evaluation.answers.find((item) => item.criterionId === criterion.id);
    const scored = evaluation.finalScore?.criteria?.find((item) => item.criterionId === criterion.id);
    const original = evaluation.originalScore?.criteria?.find((item) => item.criterionId === criterion.id);
    const appeals = state.appeals.filter((appeal) => appeal.evaluationId === evaluation.id && appeal.criterionId === criterion.id);
    const open = state.expanded.has(criterion.id);
    const value = scored?.answer ?? answer?.answer;
    const symbol = value === 'na' ? '—' : criterion.type === 'flag' ? value === 'yes' ? '!' : '✓' : value === 'yes' || (typeof value === 'number' && value === Math.max(...(criterion.scale || [value]))) ? '✓' : '·';
    const symbolClass = value === 'na' ? 'na' : criterion.type === 'flag' ? value === 'yes' ? 'no' : '' : value === 'no' || value === 0 ? 'no' : '';
    const summary = criterion.type === 'flag' ? answerLabel(value) : value === 'na' ? 'Н/П' : `${formatNumber(scored?.contribution)} / ${formatNumber(scored?.effectiveWeight)}`;
    const evidence = (answer?.evidenceIds || []).map((id) => { const message = conversation.transcript.find((item) => item.id === id); return message && evaluation.conversationHash === conversation.hash ? `<button class="evidence-link" data-evidence="${attr(id)}"><span>↗ ${escape(speakerName(message.speaker))} · ${escape(message.timestamp)} · ${escape(id)}</span>«${escape(message.text)}»</button>` : `<p class="form-hint">Реплика ${escape(id)} недоступна в текущей версии транскрипта.</p>`; }).join('');
    return `<article class="criterion"><button class="criterion-toggle" data-criterion="${attr(criterion.id)}" aria-expanded="${open}" aria-controls="criterion-${attr(criterion.id)}"><span class="criterion-symbol ${symbolClass}">${symbol}</span><span class="criterion-name">${escape(criterion.title)}</span><span class="criterion-summary">${escape(summary)}</span><span class="criterion-chevron">${open ? '⌃' : '⌄'}</span></button><div class="criterion-detail" id="criterion-${attr(criterion.id)}" ${open ? '' : 'hidden'}><p class="criterion-description">${escape(criterion.description)}</p><div class="answer-chips"><span class="chip">Ответ: ${escape(answerLabel(value))}</span><span class="chip">Вес: ${formatNumber(criterion.weight)}</span>${criterion.type !== 'flag' ? `<span class="chip">Вклад в итог: ${formatNumber(scored?.contribution)}</span>` : ''}${original && String(original.answer) !== String(value) ? `<span class="chip">Исходно: ${escape(answerLabel(original.answer))}</span>` : ''}</div><p class="criterion-explanation">${escape(answer?.explanation || 'Объяснение отсутствует.')}</p>${answer?.checkedRange ? `<p class="checked-range">Проверенный диапазон: ${escape(answer.checkedRange.from)} — ${escape(answer.checkedRange.to)}</p>` : ''}${evidence ? `<div class="evidence-label">ДОКАЗАТЕЛЬСТВА ИЗ ДИАЛОГА</div>${evidence}` : '<p class="form-hint">Реплики-доказательства не указаны.</p>'}${value === 'na' ? `<p class="form-hint">Условие неприменимости: ${escape(criterion.naRule || 'Не задано')}</p>` : ''}${appeals.map((appeal) => renderAppeal(appeal, criterion)).join('')}<button class="appeal-toggle" data-appeal-toggle="${attr(criterion.id)}">＋ Оспорить оценку критерия</button><form class="appeal-form" data-appeal-form="${attr(criterion.id)}" data-evaluation="${attr(evaluation.id)}" hidden><label class="field-label">Комментарий к апелляции<textarea name="comment" placeholder="Что следует пересмотреть и почему?" required maxlength="10000"></textarea></label><button class="button button-small" type="submit">Отправить на ревью</button><p class="form-error" role="alert"></p></form></div></article>`;
  }

  function renderAppeal(appeal, criterion) {
    return `<div class="appeal-card"><div class="appeal-meta"><span>${appeal.status === 'resolved' ? 'РЕШЕНИЕ ПРИНЯТО' : 'ОЖИДАЕТ РЕВЬЮ'}</span><span>${escape(formatDate(appeal.createdAt))}</span></div><p>${escape(appeal.comment)}</p>${appeal.status === 'resolved' ? `<div class="decision-result"><strong>Ответ ревьюера: ${escape(answerLabel(appeal.decision?.answer))}</strong><br>${escape(appeal.decision?.reason)}</div>` : `<form class="decision-form" data-resolve="${attr(appeal.id)}" data-criterion-id="${attr(criterion.id)}"><label class="field-label">Ответ после проверки<select name="answer">${answerOptions(criterion, null)}</select></label><label class="field-label">Обоснование решения<textarea name="reason" placeholder="На какие реплики опирается решение?" required maxlength="10000"></textarea></label><button type="submit" class="button button-small button-primary">Сохранить решение</button><p class="form-error" role="alert"></p></form>`}</div>`;
  }

  function modelReady() { return !!(state.health?.ollama?.online && state.settings.model && state.health.ollama.models?.includes(state.settings.model)); }
  function canEvaluate() { return !!(selectedConversation() && selectedRubric() && modelReady() && !state.busy.has(`evaluate:${state.selectedId}`) && !activeJobForConversation(state.selectedId)); }
  function updateActions() {
    const evaluate = $('#evaluate'); if (evaluate) { evaluate.disabled = !canEvaluate(); evaluate.innerHTML = evaluationButtonLabel(); }
    $('#start-batch').disabled = !state.selected.size || !state.rubricId || !modelReady() || state.busy.has('batch') || state.jobs.some((job) => ['queued', 'running'].includes(job.status));
    $('#edit-rubric').disabled = !selectedRubric();
    $('#select-all').disabled = !filteredConversations().length;
  }

  function renderHealth() {
    const health = state.health; const model = state.settings.model || health?.model || '';
    const ready = modelReady();
    const node = $('#model-status');
    node.innerHTML = `<i class="status-dot ${ready ? 'green' : health ? 'red' : ''}"></i><span>${escape(ready ? `${model} · локально` : health ? 'Модель недоступна' : 'Проверяем модель…')}</span>`;
    $('#dataset-status').textContent = health?.datasetConfigured ? 'Источник организатора настроен на сервере.' : 'Источник организатора пока не настроен на сервере. Вы можете загрузить JSON.';
    const installed = health?.ollama?.models || [];
    $('#health-details').innerHTML = `<div class="health-card ${ready ? '' : 'offline'}"><strong>${ready ? '● Модель готова к проверке' : health?.ollama?.online ? '● Ollama доступна · выберите установленную модель' : '● Нет подключения к Ollama'}</strong><p>${escape(health?.ollama?.error || (ready ? 'Все запросы к модели выполняются локально.' : health?.ollama?.online ? 'Текущая модель не найдена среди установленных.' : 'Запустите Ollama и установите модель на этом компьютере.'))}</p><div class="health-endpoint">Сервер модели: ${escape(state.settings.ollamaUrl || 'не указан')}<br>Выбрана: ${escape(model || 'не выбрана')}<br>Установленных моделей: ${installed.length}</div></div>`;
    $('#model-select').innerHTML = installed.length ? installed.map((name) => `<option value="${attr(name)}">${escape(name)}</option>`).join('') : '<option value="">Нет установленных моделей</option>';
    if (installed.includes(model)) $('#model-select').value = model;
    $('#settings-form button[type="submit"]').disabled = !installed.length || state.busy.has('settings');
  }

  function renderJobs() {
    const jobs = [...state.jobs.filter((job) => ['queued', 'running'].includes(job.status)), ...[...state.jobs].reverse().filter((job) => job.status === 'completed').slice(0, 2)]; const node = $('#jobs'); node.hidden = !jobs.length;
    node.innerHTML = jobs.map((job) => { const completed = job.results.length; const errors = job.results.filter((result) => result.error); const status = ({ queued: 'В очереди', running: 'Проверка выполняется', completed: 'Проверка завершена' }[job.status] || job.status); return `<div class="job"><div class="job-head"><strong>${job.status === 'running' ? '<span class="spinner"></span> ' : ''}${escape(status)}</strong><span>${completed} / ${job.conversationIds.length} диалогов</span></div><progress class="job-bar" max="${job.conversationIds.length || 1}" value="${completed}" aria-label="Прогресс проверки"></progress><div class="job-details">${job.currentConversationId ? `Сейчас: ${escape(job.currentConversationId)} · ` : ''}${completed - errors.length} сохранено${errors.length ? ` · ${errors.length} с ошибкой` : ''} · чек-лист v${escape(state.rubrics.find((rubric) => rubric.id === job.rubricId)?.version ?? '?')}</div>${errors.map((result) => `<div class="job-error">${escape(result.conversationId)}: ${escape(result.error)}</div>`).join('')}</div>`; }).join('');
  }

  async function queueConversationEvaluation(conversationId, rubricId) {
    if (activeJobForConversation(conversationId) || state.busy.has(`evaluate:${conversationId}`)) return;
    return withBusy(`evaluate:${conversationId}`, null, async () => {
      if (state.selectedId === conversationId && state.rubricId === rubricId) state.historicalId = null;
      renderTranscript(); renderReview(); renderList();
      const job = await api('/api/jobs', { conversationIds: [conversationId], rubricId }, 15000);
      state.jobs.push(job);
      schedulePoll();
      notify(`Диалог ${conversationId} добавлен в очередь. Прогресс и результат сохраняются на сервере. Можно продолжать работу с другими диалогами.`);
    }).finally(() => { renderJobs(); renderList(); renderTranscript(); renderReview(); });
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.jobs.some((job) => ['running', 'queued'].includes(job.status))) state.pollTimer = setTimeout(pollJobs, 2200);
  }
  async function pollJobs() {
    if (state.pollBusy) return; state.pollBusy = true;
    try {
      const previousReview = JSON.stringify({ conversation: transcriptConversation(), evaluation: displayedEvaluation(), appeals: state.appeals, activity: evaluationActivity() });
      setData(await api('/api/state', undefined, 15000));
      renderJobs(); renderList();
      if (JSON.stringify({ conversation: transcriptConversation(), evaluation: displayedEvaluation(), appeals: state.appeals, activity: evaluationActivity() }) !== previousReview) state.pendingReviewRender = true;
      flushPendingReview();
      updateActions();
    } catch (error) { notify(`Обновление очереди: ${error.message} Повторим автоматически.`, true); }
    finally { state.pollBusy = false; schedulePoll(); }
  }

  function openImport() { $('#import-error').textContent = ''; $('#import-dialog').showModal(); }
  function openSettings() { $('#settings-error').textContent = ''; renderHealth(); $('#settings-dialog').showModal(); }
  function openRubric() {
    const rubric = selectedRubric();
    if (!rubric) return;
    state.editor = rubric.criteria.map((criterion) => ({ ...criterion, scale: [...(criterion.scale || [])], existing: true }));
    $('#rubric-name').value = rubric.name;
    $('#rubric-error').textContent = ''; renderEditor(); $('#rubric-dialog').showModal();
  }
  function renderEditor() {
    $('#criteria-editor').innerHTML = state.editor.map((criterion, index) => `<section class="editor-criterion" data-editor-index="${index}"><div class="editor-top"><strong>Критерий ${index + 1}</strong><button type="button" class="button button-small" data-remove-criterion="${index}">Удалить</button></div><div class="editor-grid"><label>ID критерия<input name="id" value="${attr(criterion.id)}" ${criterion.existing ? 'readonly' : ''} required pattern="[A-Za-z0-9_-]+" title="Латинские буквы, цифры, дефис и подчёркивание"></label><label class="span-2">Название<input name="title" value="${attr(criterion.title)}" required></label><label>Раздел<input name="section" value="${attr(criterion.section)}" required></label><label>Тип ответа<select name="type"><option value="binary" ${criterion.type === 'binary' ? 'selected' : ''}>Да / Нет</option><option value="scale" ${criterion.type === 'scale' ? 'selected' : ''}>Шкала</option><option value="flag" ${criterion.type === 'flag' ? 'selected' : ''}>Флаг нарушения</option></select></label><label>Вес<input name="weight" type="number" min="0" max="1000" step="any" value="${attr(criterion.weight)}" required></label><label class="span-3">Правило проверки<textarea name="description" rows="3" required>${escape(criterion.description)}</textarea></label><label class="span-2" data-scale-field ${criterion.type !== 'scale' ? 'hidden' : ''}>Значения шкалы через запятую<input name="scale" value="${attr((criterion.scale || []).join(', '))}" placeholder="0, 5, 10, 15, 20"></label><label class="checkbox-label"><input type="checkbox" name="allowNA" ${criterion.allowNA ? 'checked' : ''} ${criterion.type === 'flag' ? 'disabled' : ''}> Разрешить «Неприменимо»</label><label class="span-3">Когда критерий неприменим<textarea name="naRule" rows="2" placeholder="Укажите точное условие для ответа Н/П">${escape(criterion.naRule || '')}</textarea></label></div></section>`).join('');
  }
  function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }
  function readEditor() {
    return $$('.editor-criterion').map((node, index) => {
      const get = (name) => $(`[name="${name}"]`, node);
      const type = get('type').value; const scaleText = get('scale').value.trim();
      const scale = type === 'scale' && scaleText ? scaleText.split(/[,;\s]+/).filter(Boolean).map(Number) : [];
      return { id: get('id').value.trim(), title: get('title').value.trim(), section: get('section').value.trim(), description: get('description').value.trim(), type, weight: Number(get('weight').value), scale, allowNA: type !== 'flag' && get('allowNA').checked, naRule: get('naRule').value.trim(), existing: state.editor[index]?.existing || false };
    });
  }

  $('#open-import').addEventListener('click', openImport);
  $('#nav-workspace').addEventListener('click', () => { $('.workbench').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#nav-rubric').addEventListener('click', openRubric); $('#edit-rubric').addEventListener('click', openRubric);
  $('#nav-settings').addEventListener('click', openSettings); $('#model-status').addEventListener('click', openSettings);
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#refresh').addEventListener('click', (event) => withBusy('refresh', event.currentTarget, () => refresh({ announce: true })));
  $('#health-refresh').addEventListener('click', (event) => withBusy('health', event.currentTarget, () => refresh(), $('#settings-error')));
  for (const id of ['search', 'language-filter', 'channel-filter']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', applyConversationFilters);
  $('#rubric-select').addEventListener('change', (event) => { state.rubricId = event.target.value; state.historicalId = null; state.expanded.clear(); renderList(); renderTranscript(); renderReview(); });
  $('#select-all').addEventListener('change', (event) => { filteredConversations().forEach((conversation) => event.target.checked ? state.selected.add(conversation.conversation_id) : state.selected.delete(conversation.conversation_id)); renderList(); });
  $('#conversation-list').addEventListener('change', (event) => { if (event.target.dataset.select) { if (event.target.checked) state.selected.add(event.target.dataset.select); else state.selected.delete(event.target.dataset.select); renderList(); } });
  $('#conversation-list').addEventListener('click', (event) => {
    if (event.target.closest('[data-open-import]')) openImport();
    const button = event.target.closest('[data-conversation]'); if (!button) return;
    state.selectedId = button.dataset.conversation; state.historicalId = null; state.expanded.clear(); renderList(); renderTranscript(); renderReview();
  });

  $('#transcript').addEventListener('click', (event) => {
    const button = event.target.closest('[data-seek]'); const player = $('#conversation-audio');
    if (button && player) { const seconds = Number(button.dataset.seek); if (Number.isFinite(player.duration) && seconds > player.duration) { $('#audio-error').textContent = 'Эта временная отметка выходит за длительность записи.'; return; } player.currentTime = seconds; $('#audio-error').textContent = ''; player.play().catch(() => { $('#audio-error').textContent = 'Нажмите воспроизведение в плеере, чтобы прослушать запись.'; }); }
  });

  $('#review').addEventListener('focusout', () => { setTimeout(flushPendingReview, 0); });
  $('#review').addEventListener('change', (event) => { if (event.target.id === 'evaluation-select') { state.historicalId = event.target.value || null; state.expanded.clear(); renderTranscript(); renderReview(); } });
  $('#review').addEventListener('click', (event) => {
    const criterionButton = event.target.closest('[data-criterion]');
    if (criterionButton) { const id = criterionButton.dataset.criterion; const panel = document.getElementById(`criterion-${id}`); if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); panel.hidden = !state.expanded.has(id); criterionButton.setAttribute('aria-expanded', String(!panel.hidden)); $('.criterion-chevron', criterionButton).textContent = panel.hidden ? '⌄' : '⌃'; return; }
    const evidence = event.target.closest('[data-evidence]');
    if (evidence) { const message = $$('[data-message-id]').find((node) => node.dataset.messageId === evidence.dataset.evidence); if (message) { $$('.message.highlight').forEach((node) => node.classList.remove('highlight')); message.classList.add('highlight'); message.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => message.classList.remove('highlight'), 4500); } return; }
    const appealToggle = event.target.closest('[data-appeal-toggle]');
    if (appealToggle) { const form = appealToggle.nextElementSibling; form.hidden = !form.hidden; if (!form.hidden) $('textarea', form).focus(); return; }
    if (event.target.closest('#evaluate')) {
      const conversationId = state.selectedId; const rubricId = state.rubricId;
      if (!canEvaluate()) return;
      queueConversationEvaluation(conversationId, rubricId);
    }
  });

  $('#review').addEventListener('submit', (event) => {
    const form = event.target; event.preventDefault();
    if (form.matches('[data-appeal-form]')) {
      const data = new FormData(form); const comment = String(data.get('comment') || '').trim(); if (!comment) { $('.form-error', form).textContent = 'Добавьте комментарий к апелляции.'; return; }
      withBusy(`appeal:${form.dataset.evaluation}:${form.dataset.appealForm}`, form, async () => { const appeal = await api('/api/appeals', { evaluationId: form.dataset.evaluation, criterionId: form.dataset.appealForm, comment }); state.appeals.push(appeal); form.reset(); form.hidden = true; renderTranscript(); renderReview(); notify('Апелляция сохранена и ожидает решения ревьюера.'); }, $('.form-error', form)).finally(flushPendingReview);
    } else if (form.matches('[data-resolve]')) {
      const data = new FormData(form); const reason = String(data.get('reason') || '').trim(); const criterion = state.rubrics.find((rubric) => rubric.id === displayedEvaluation()?.rubricId)?.criteria.find((item) => item.id === form.dataset.criterionId); if (!criterion || !reason) { $('.form-error', form).textContent = 'Укажите обоснование решения.'; return; }
      const value = data.get('answer'); const answer = criterion.type === 'scale' && value !== 'na' ? Number(value) : value;
      withBusy(`resolve:${form.dataset.resolve}`, form, async () => { const result = await api(`/api/appeals/${encodeURIComponent(form.dataset.resolve)}/resolve`, { answer, reason }); state.appeals = state.appeals.map((appeal) => appeal.id === result.appeal.id ? result.appeal : appeal); state.evaluations = state.evaluations.map((evaluation) => evaluation.id === result.evaluation.id ? result.evaluation : evaluation); renderTranscript(); renderReview(); renderList(); state.reviewDrafts.delete(reviewDraftKey(form)); notify('Решение сохранено. Итог пересчитан, исходная оценка модели сохранена.'); }, $('.form-error', form)).finally(flushPendingReview);
    }
  });

  $('#start-batch').addEventListener('click', (event) => {
    const conversationIds = [...state.selected]; const rubricId = state.rubricId;
    withBusy('batch', event.currentTarget, async () => { const job = await api('/api/jobs', { conversationIds, rubricId }, 15000); state.jobs.push(job); renderJobs(); renderList(); schedulePoll(); notify(`Пакетная проверка запущена: ${conversationIds.length} диалогов. Каждый результат сохраняется отдельно.`); });
  });

  $('#organizer-form').addEventListener('submit', (event) => { event.preventDefault(); const groupId = $('#group-id').value.trim(); if (!groupId) return; withBusy('import', event.currentTarget, async () => { const result = await api('/api/import', { groupId }); await refresh(); $('#import-dialog').close(); notify(`Импортировано диалогов: ${result.imported}.`); }, $('#import-error')); });
  $('#upload-form').addEventListener('submit', (event) => { event.preventDefault(); const file = $('#json-file').files[0]; if (!file) return; withBusy('import', event.currentTarget, async () => { let payload; try { payload = JSON.parse(await file.text()); } catch { throw new Error('Не удалось прочитать JSON. Проверьте формат файла.'); } const result = await api('/api/import', { payload, groupId: 'UPLOAD' }); await refresh(); $('#import-dialog').close(); $('#json-file').value = ''; notify(`Импортировано диалогов: ${result.imported}.`); }, $('#import-error')); });
  $('#settings-form').addEventListener('submit', (event) => { event.preventDefault(); const model = $('#model-select').value; if (!model) return; withBusy('settings', event.currentTarget, async () => { state.settings = await api('/api/settings', { model }); renderHealth(); renderReview(); renderList(); $('#settings-dialog').close(); notify(`Выбрана локальная модель: ${model}.`); }, $('#settings-error')); });

  $('#criteria-editor').addEventListener('change', (event) => {
    if (event.target.name !== 'type') return;
    const node = event.target.closest('.editor-criterion'); const type = event.target.value; const scale = $('[data-scale-field]', node);
    scale.hidden = type !== 'scale';
    const na = $('[name="allowNA"]', node); na.disabled = type === 'flag'; if (type === 'flag') { na.checked = false; $('[name="weight"]', node).value = '0'; }
  });
  $('#criteria-editor').addEventListener('click', (event) => { const button = event.target.closest('[data-remove-criterion]'); if (button) { state.editor = readEditor(); state.editor.splice(Number(button.dataset.removeCriterion), 1); renderEditor(); } });
  $('#add-criterion').addEventListener('click', () => { state.editor = readEditor(); let index = state.editor.length + 1; while (state.editor.some((criterion) => criterion.id === `c${index}`)) index++; state.editor.push({ id: `c${index}`, title: '', section: 'Качество обслуживания', description: '', type: 'binary', weight: 10, scale: [], allowNA: false, naRule: '', existing: false }); renderEditor(); const last = $$('.editor-criterion').at(-1); $('[name="title"]', last).focus(); });
  $('#rubric-form').addEventListener('submit', (event) => {
    event.preventDefault(); const name = $('#rubric-name').value.trim(); const criteria = readEditor().map(({ existing, ...criterion }) => criterion);
    const error = $('#rubric-error'); error.textContent = '';
    if (!name || !criteria.length || criteria.length > 30) { error.textContent = 'Укажите название и добавьте от 1 до 30 критериев.'; return; }
    if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) { error.textContent = 'ID критериев должны быть уникальными.'; return; }
    for (const criterion of criteria) {
      if (!criterion.title || !criterion.description || !criterion.section) { error.textContent = `Заполните название, раздел и правило критерия ${criterion.id}.`; return; }
      if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 1000 || (criterion.type === 'flag' && criterion.weight !== 0)) { error.textContent = `Проверьте вес критерия ${criterion.id}. Вес флага должен быть равен 0.`; return; }
      if (criterion.type === 'scale' && (criterion.scale.length < 2 || criterion.scale.length > 30 || criterion.scale.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value <= criterion.scale[index - 1])) || new Set(criterion.scale).size !== criterion.scale.length || !criterion.scale.includes(0) || Math.max(...criterion.scale) <= 0)) { error.textContent = `Шкала ${criterion.id} должна начинаться с 0 и строго возрастать: от 2 до 30 значений.`; return; }
      if (criterion.allowNA && !criterion.naRule) { error.textContent = `Укажите условие неприменимости для ${criterion.id}.`; return; }
    }
    withBusy('rubric', event.currentTarget, async () => { const rubric = await api('/api/rubrics', { name, criteria }); state.rubrics.push(rubric); state.rubricId = rubric.id; state.historicalId = null; state.expanded.clear(); renderAll(); $('#rubric-dialog').close(); notify(`Версия ${rubric.version} сохранена. Запустите новую проверку для изменённого чек-листа.`); }, error);
  });

  renderAll(); refresh();
})();
