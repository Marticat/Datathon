const LANGUAGE_NAMES = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };
const ROLE_NAMES = { operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' };
const STATUS_NAMES = { queued: 'В очереди', running: 'Обработка', completed: 'Готово к проверке', done: 'Готово к проверке', ready: 'Готово к проверке', needs_review: 'Готово к проверке', confirmed: 'Диалог сохранён', failed: 'Ошибка обработки', error: 'Ошибка обработки', published: 'Диалог сохранён' };

export function timeLabel(seconds) {
  const total = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const minutes = Math.floor(total / 60000);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

function speakerIds(job) {
  return [...new Set([...(job.result?.speakers || []).map(s => typeof s === 'string' ? s : s.id), ...(job.result?.segments || []).map(s => s.speaker || 'unknown'), ...(job.draft?.segments || []).map(s => s.speaker || 'unknown')].filter(Boolean))];
}

export function makeDraft(job) {
  const saved = job.draft || {};
  const language = String(saved.language ?? job.result?.language ?? '').toUpperCase();
  const originals = new Map((job.result?.segments || []).map(segment => [segment.id, segment]));
  const entries = saved.segments?.length ? saved.segments : job.result?.segments || [];
  return {
    language: LANGUAGE_NAMES[language] ? language : language === 'KK' ? 'KZ' : '',
    roles: Object.fromEntries(speakerIds(job).map(id => [id, ROLE_NAMES[saved.roles?.[id]] ? saved.roles[id] : ''])),
    segments: entries.filter(edit => originals.has(edit.parentId || edit.id)).map(edit => {
      const source = originals.get(edit.parentId || edit.id);
      const boundedTime = (value, fallback) => Number.isFinite(value) ? Math.max(source.start, Math.min(source.end, value)) : fallback;
      return { id: edit.id, parentId: source.id, start: boundedTime(edit.start, source.start), end: boundedTime(edit.end, source.end), speaker: edit.speaker || source.speaker || 'unknown', role: ROLE_NAMES[edit.role] ? edit.role : '', text: edit.text ?? source.text ?? '', include: edit.include !== false };
    }),
  };
}

export function splitDraftSegment(draft, index, boundary, leftText, rightText) {
  const segment = draft.segments[index];
  if (!segment || !Number.isFinite(boundary) || boundary <= segment.start || boundary >= segment.end) throw new Error('Выберите время строго внутри реплики.');
  const parentId = segment.parentId || segment.id;
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const parts = [
    { ...segment, id: `${parentId.slice(0, 100)}-part-${unique}-a`, parentId, end: boundary, text: leftText },
    { ...segment, id: `${parentId.slice(0, 100)}-part-${unique}-b`, parentId, start: boundary, text: rightText },
  ];
  draft.segments.splice(index, 1, ...parts);
  return parts;
}

export function validateDraft(draft) {
  if (!LANGUAGE_NAMES[draft.language]) return 'Подтвердите язык записи перед публикацией.';
  const included = draft.segments.filter(segment => segment.include);
  if (!included.length) return 'Нет включённых реплик. Включите хотя бы одну реплику с текстом.';
  if (included.some(segment => !segment.text.trim())) return 'У включённой реплики пустой текст. Заполните её или снимите «Включить».';
  if (included.some(segment => !ROLE_NAMES[segment.role || draft.roles[segment.speaker]])) return 'Укажите роль каждого голоса или назначьте роль отдельно во включённых репликах.';
  return '';
}

function segmentWarnings(segment, segments) {
  const warnings = [];
  if (segment.uncertain) warnings.push('Требует проверки');
  if (!segment.speaker || /unknown|unassigned/i.test(segment.speaker)) warnings.push('Голос не определён');
  if (segment.overlap || segment.overlapping || segments.some(other => other.id !== segment.id && other.speaker !== segment.speaker && Number(other.start) < Number(segment.end) && Number(other.end) > Number(segment.start))) warnings.push('Возможное наложение голосов');
  return warnings;
}

export function transcriptText(job, draft) {
  const original = new Map((job.result?.segments || []).map(segment => [segment.id, segment]));
  const lines = [job.filename || 'Расшифровка', `Язык: ${LANGUAGE_NAMES[draft.language] || 'Не подтверждён'}`, 'Время относится к записи для проверки. Оригинал сохранён отдельно. Текст проверяется пользователем.', ''];
  for (const segment of draft.segments.filter(item => item.include)) {
    const parent = original.get(segment.parentId || segment.id) || {};
    const source = { ...parent, start: segment.start ?? parent.start, end: segment.end ?? parent.end };
    const warnings = segmentWarnings(source, job.result?.segments || []);
    lines.push(`[${timeLabel(source.start)} — ${timeLabel(source.end)}] ${ROLE_NAMES[segment.role || draft.roles[segment.speaker]] || 'Роль не назначена'} (${segment.speaker})${warnings.length ? ` [${warnings.join('; ').toLowerCase()}]` : ''}`, segment.text, '');
  }
  return lines.join('\n');
}

function startAudioPage() {
  const $ = id => document.getElementById(id);
  const state = { jobs: [], selected: null, job: null, draft: null, revision: 0, savedRevision: 0, busy: false, selecting: false, refreshing: false, listSignature: '', segmentElements: [], voiceNames: new Map() };
  const audio = $('source-audio');
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function status(id, message, error = false) {
    const node = $(id);
    node.textContent = message;
    node.classList.toggle('audio-error', error);
  }
  async function request(url, options) {
    let response;
    try { response = await fetch(url, options); }
    catch { throw new Error('Нет соединения с локальным сервером. Проверьте, что приложение запущено, и повторите попытку.'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Сервер вернул неожиданный ответ (${response.status}). Повторите попытку.`); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Ошибка запроса (${response.status}).`);
    return data;
  }
  function dirty() { return state.revision !== state.savedRevision; }
  function changed() {
    state.revision += 1;
    $('review-confirm').checked = false;
    $('evaluation-link').hidden = true;
    status('review-status', 'Есть несохранённые изменения.');
  }
  function setBusy(value) {
    state.busy = value;
    $('save-draft').disabled = value;
    $('publish-review').disabled = value;
  }
  function voiceName(id) { return state.voiceNames.get(id) || 'Неизвестный голос'; }
  function roleOption(value, label) {
    const option = element('option', '', label);
    option.value = value;
    return option;
  }
  function sourceUrl(id) { return `/api/audio/files/${encodeURIComponent(id)}`; }
  function mediaUrl(value, fallback) {
    try {
      const target = new URL(value || fallback, location.origin);
      if (target.origin === location.origin && target.pathname === sourceUrl(state.selected)) return target.pathname + target.search;
    } catch { /* Fall back to the local source if an invalid URL is returned. */ }
    return fallback;
  }
  function updateAudioSource(job) {
    const url = mediaUrl(job.audioUrl, sourceUrl(job.id));
    const originalUrl = mediaUrl(job.originalAudioUrl, `${sourceUrl(job.id)}?track=original&download=1`);
    $('download-original').href = originalUrl;
    if (audio.getAttribute('src') === url) return;
    audio.pause();
    audio.src = url;
    audio.load();
    status('playback-status', '');
    for (const { node } of state.segmentElements) node.classList.remove('is-playing');
  }
  function endpoint(id, action = '') { return `/api/audio/jobs/${encodeURIComponent(id)}${action}`; }
  function renderJobs() {
    const signature = JSON.stringify([state.selected, state.jobs]);
    if (signature === state.listSignature) return;
    state.listSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const job of state.jobs) {
      const item = element('li');
      const button = element('button', 'audio-job');
      button.type = 'button';
      button.dataset.jobId = job.id;
      button.setAttribute('aria-current', String(job.id === state.selected));
      button.append(element('span', 'audio-job-title', job.filename || 'Запись'), element('span', 'audio-help', STATUS_NAMES[job.status] || job.status || 'Сохранено'));
      if (job.createdAt) {
        const date = new Date(job.createdAt);
        if (!Number.isNaN(date.getTime())) button.append(element('span', 'audio-help', date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
      }
      button.addEventListener('click', () => selectJob(job.id));
      item.append(button);
      fragment.append(item);
    }
    const focusedId = document.activeElement?.dataset?.jobId;
    $('jobs-list').replaceChildren(fragment);
    if (focusedId) [...$('jobs-list').querySelectorAll('button')].find(button => button.dataset.jobId === focusedId)?.focus();
    status('jobs-status', state.jobs.length ? `${state.jobs.length} записей · сохранены на этом компьютере` : 'Загруженных записей пока нет.');
  }
  function renderJobStatus(job) {
    updateAudioSource(job);
    $('job-name').textContent = job.filename || 'Запись';
    const active = ['queued', 'running'].includes(job.status);
    const stageNames = { queued: 'Ожидание обработки', loading: 'Загрузка моделей', loading_models: 'Загрузка моделей', transcribing: 'Распознавание речи', diarizing: 'Разделение голосов', aligning: 'Уточнение временных меток', decoding: 'Подготовка аудио', complete: 'Расшифровка готова', needs_review: 'Подтвердите текст и роли', confirmed: 'Можно перейти к оценке', failed: 'Проверьте сообщение об ошибке' };
    const progress = Number(job.progress);
    const detail = job.stage ? stageNames[job.stage] || job.stage : '';
    status('job-status', [STATUS_NAMES[job.status] || job.status, detail].filter(Boolean).join(' · '));
    $('job-progress').hidden = !active;
    if (job.progress !== null && job.progress !== undefined && Number.isFinite(progress)) $('job-progress').value = Math.min(100, Math.max(0, progress));
    else $('job-progress').removeAttribute('value');
    $('job-error').hidden = !job.error;
    $('job-error').textContent = typeof job.error === 'string' ? job.error : job.error?.message || '';
  }
  function highlightTime() {
    const current = audio.currentTime;
    for (const { node, source } of state.segmentElements) node.classList.toggle('is-playing', current >= Number(source.start) && current < Number(source.end));
  }
  async function seekTo(source, node) {
    try {
      audio.currentTime = Math.max(0, Number(source.start) || 0);
      highlightTime();
      node.classList.add('is-playing');
      await audio.play();
      status('playback-status', `Источник: ${timeLabel(source.start)} — ${timeLabel(source.end)}.`);
    } catch { status('playback-status', 'Не удалось начать воспроизведение. Нажмите ▶ в плеере. Если формат не поддерживается браузером, откройте исходный файл.'); }
  }
  function renderReview(job, preserveEdits = false) {
    if (!preserveEdits) {
      state.draft = makeDraft(job);
      state.revision = 0;
      state.savedRevision = 0;
    }
    state.segmentElements = [];
    state.voiceNames = new Map(speakerIds(job).map((id, index) => [id, /unknown|unassigned/i.test(id) ? 'Неопределённый голос' : `Голос ${index + 1}`]));
    const draft = state.draft;
    $('review-panel').hidden = false;
    $('review-confirm').checked = false;
    $('review-language').value = draft.language;
    const knownVoices=[...state.voiceNames.keys()].filter(id=>!/unknown|unassigned/i.test(id)).length;
    $('source-meta').textContent = `Распознано голосов: ${knownVoices}${knownVoices<state.voiceNames.size?' · есть неопределённые фрагменты':''} · ${timeLabel(job.result.duration ?? Math.max(0, ...job.result.segments.map(s => Number(s.end) || 0)))}`;
    const roleFragment = document.createDocumentFragment();
    for (const [id, name] of state.voiceNames) {
      const label = element('label', 'audio-role', name);
      const select = element('select');
      select.dataset.voice = id;
      select.setAttribute('aria-label', `Роль: ${name}`);
      select.append(roleOption('', 'Выберите роль'), ...Object.entries(ROLE_NAMES).map(([value, label]) => roleOption(value, label)));
      select.value = draft.roles[id] || '';
      select.addEventListener('change', () => { draft.roles[id] = select.value; changed(); });
      label.append(select);
      roleFragment.append(label);
    }
    $('speaker-roles').replaceChildren(roleFragment);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < draft.segments.length; index++) {
      const segment = draft.segments[index];
      const parent = job.result.segments.find(original => original.id === (segment.parentId || segment.id));
      const source = { ...parent, start: segment.start, end: segment.end };
      const row = element('li', 'audio-segment');
      row.dataset.segmentId = segment.id;
      row.classList.toggle('is-excluded', !segment.include);
      const top = element('div', 'audio-segment-top');
      const jump = element('button', 'audio-time', `${timeLabel(source.start)} — ${timeLabel(source.end)}`);
      jump.type = 'button';
      jump.setAttribute('aria-label', `Слушать реплику ${index + 1} с ${timeLabel(source.start)}`);
      jump.addEventListener('click', () => seekTo(source, row));
      const speakerLabel = element('label', 'audio-segment-speaker', 'Голос');
      const speakerSelect = element('select');
      speakerSelect.setAttribute('aria-label', `Голос реплики ${index + 1}`);
      for (const [id, name] of state.voiceNames) speakerSelect.append(roleOption(id, name));
      speakerSelect.value = segment.speaker;
      speakerSelect.addEventListener('change', () => { segment.speaker = speakerSelect.value; changed(); });
      speakerLabel.append(speakerSelect);
      const includeLabel = element('label', 'audio-include');
      const include = element('input');
      include.type = 'checkbox';
      include.checked = segment.include;
      include.setAttribute('aria-label', `Включить реплику ${index + 1}`);
      include.addEventListener('change', () => { segment.include = include.checked; row.classList.toggle('is-excluded', !include.checked); updateCount(); changed(); });
      includeLabel.append(include, element('span', '', 'Включить'));
      top.append(jump, speakerLabel, includeLabel);
      row.append(top);
      const roleLabel = element('label', 'audio-segment-role', 'Роль реплики');
      const roleSelect = element('select');
      roleSelect.setAttribute('aria-label', `Роль реплики ${index + 1}`);
      roleSelect.append(roleOption('', 'По роли голоса'), ...Object.entries(ROLE_NAMES).map(([value, label]) => roleOption(value, label)));
      roleSelect.value = segment.role || '';
      roleSelect.addEventListener('change', () => { segment.role = roleSelect.value; changed(); });
      roleLabel.append(roleSelect);
      row.append(roleLabel);
      for (const warning of segmentWarnings(source, job.result.segments)) row.append(element('span', 'audio-marker', warning));
      const textLabel = element('label');
      const textarea = element('textarea');
      textarea.value = segment.text;
      textarea.rows = Math.min(8, Math.max(2, Math.ceil(segment.text.length / 75)));
      textarea.setAttribute('aria-label', `Текст реплики ${index + 1}`);
      textarea.addEventListener('input', () => { segment.text = textarea.value; changed(); });
      textLabel.append(textarea);
      row.append(textLabel);
      const splitButton = element('button', 'audio-quiet audio-split-button', 'Разделить');
      splitButton.type = 'button';
      splitButton.setAttribute('aria-label', `Разделить реплику ${index + 1}`);
      splitButton.disabled = segment.end - segment.start < 0.002;
      splitButton.addEventListener('click', () => openSplitDialog(segment, parent, textarea, row));
      row.append(splitButton);
      const original = element('details', 'audio-source-text');
      original.append(element('summary', '', 'Исходное распознавание'), element('p', '', source.text || '(пусто)'));
      row.append(original);
      fragment.append(row);
      state.segmentElements.push({ node: row, source });
    }
    $('transcript').replaceChildren(fragment);
    if (!draft.segments.length) $('transcript').append(element('li', 'audio-help', 'Речь не распознана. Попробуйте другую запись или укажите язык вручную.'));
    updateCount();
    status('review-status', job.draft ? 'Сохранённый черновик восстановлен. Проверьте его перед публикацией.' : 'Текст ещё не подтверждён. Назначьте роли и проверьте реплики.');
    $('evaluation-link').hidden = true;
    if (job.conversationId && !preserveEdits) showEvaluationLink(`/?group=AUDIO&dialog=${encodeURIComponent(job.conversationId)}`);
  }
  function openSplitDialog(segment, parent, textarea, row) {
    const dialog = element('dialog', 'audio-split-dialog');
    dialog.setAttribute('aria-labelledby', 'split-title');
    const form = element('form');
    const title = element('h2', '', 'Разделить реплику');
    title.id = 'split-title';
    form.append(title, element('p', 'audio-help', 'Если внутри одной реплики говорят разные люди, выберите момент смены говорящего. После разделения назначьте роль каждой части.'));
    const boundaries = [...new Set((parent.words || []).flatMap(word => [Number(word.start), Number(word.end)]).filter(time => Number.isFinite(time) && time > segment.start && time < segment.end))].sort((a, b) => a - b);
    const timeLabelNode = element('label', '', boundaries.length ? 'Граница по времени слов' : 'Время разделения, секунд от начала записи');
    const boundaryInput = element(boundaries.length ? 'select' : 'input');
    boundaryInput.id = 'split-time';
    boundaryInput.required = true;
    if (boundaries.length) {
      for (const time of boundaries) {
        const nextWord = (parent.words || []).find(word => Number(word.start) >= time && Number(word.start) < segment.end);
        boundaryInput.append(roleOption(String(time), `${timeLabel(time)}${nextWord ? ` · перед «${String(nextWord.text || nextWord.word || '').trim()}»` : ''}`));
      }
      const middle = (segment.start + segment.end) / 2;
      boundaryInput.value = String(boundaries.reduce((best, value) => Math.abs(value - middle) < Math.abs(best - middle) ? value : best));
    } else {
      boundaryInput.type = 'number';
      boundaryInput.step = 'any';
      boundaryInput.min = String(segment.start + 0.001);
      boundaryInput.max = String(segment.end - 0.001);
      boundaryInput.placeholder = `${segment.start} < время < ${segment.end}`;
    }
    timeLabelNode.append(boundaryInput);
    form.append(timeLabelNode, element('p', 'audio-help', `Диапазон: ${timeLabel(segment.start)} — ${timeLabel(segment.end)}. ${boundaries.length ? 'Границы взяты из временных меток распознавания; проверьте на слух.' : 'Временных меток слов нет. Прослушайте и введите время вручную.'}`));
    const listen = element('button', 'audio-quiet', 'Послушать место разделения');
    listen.type = 'button';
    listen.addEventListener('click', () => {
      const boundary = Number(boundaryInput.value);
      seekTo({ start: boundaryInput.value && boundary > segment.start && boundary < segment.end ? Math.max(segment.start, boundary - 1) : segment.start, end: segment.end }, row);
    });
    form.append(listen);
    const leftLabel = element('label', '', 'Первая часть');
    const left = element('textarea');
    left.id = 'split-left';
    left.rows = 3;
    leftLabel.append(left);
    const rightLabel = element('label', '', 'Вторая часть');
    const right = element('textarea');
    right.id = 'split-right';
    right.rows = 3;
    rightLabel.append(right);
    const cursor = textarea.selectionStart;
    const cursorInside = cursor > 0 && cursor < segment.text.length;
    let textEdited = false;
    function distributeText() {
      if (textEdited) return;
      let at = cursorInside ? cursor : Math.round(segment.text.length * (boundaryInput.value ? (Number(boundaryInput.value) - segment.start) / (segment.end - segment.start) : 0.5));
      if (!cursorInside) {
        const spaces = [...segment.text.matchAll(/\s+/g)].map(match => match.index + match[0].length).filter(index => index > 0 && index < segment.text.length);
        if (spaces.length) at = spaces.reduce((best, value) => Math.abs(value - at) < Math.abs(best - at) ? value : best);
      }
      left.value = segment.text.slice(0, at);
      right.value = segment.text.slice(at);
    }
    left.addEventListener('input', () => { textEdited = true; });
    right.addEventListener('input', () => { textEdited = true; });
    boundaryInput.addEventListener('change', distributeText);
    distributeText();
    form.append(leftLabel, rightLabel, element('p', 'audio-help', 'Текущий текст сохранён в двух полях. Проверьте, что слова находятся в нужной части; исправьте их при необходимости.'));
    const error = element('p', 'audio-error');
    error.setAttribute('role', 'alert');
    form.append(error);
    const buttons = element('div', 'audio-buttons');
    const confirm = element('button', 'audio-primary', 'Подтвердить разделение');
    confirm.type = 'submit';
    const cancel = element('button', '', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    buttons.append(confirm, cancel);
    form.append(buttons);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const boundary = Number(boundaryInput.value);
      if (!boundaryInput.value || !Number.isFinite(boundary) || boundary <= segment.start || boundary >= segment.end) { error.textContent = 'Выберите время строго внутри реплики.'; return; }
      const index = state.draft.segments.findIndex(item => item.id === segment.id);
      if (index < 0) { error.textContent = 'Реплика уже изменилась. Закройте окно и попробуйте снова.'; return; }
      splitDraftSegment(state.draft, index, boundary, left.value, right.value);
      dialog.close();
      renderReview(state.job, true);
      changed();
      status('review-status', 'Реплика разделена. Проверьте текст и назначьте роли обеих частей; затем сохраните черновик.');
      $('transcript').children[index]?.querySelector('.audio-segment-role select')?.focus();
    });
    dialog.addEventListener('close', () => { audio.pause(); dialog.remove(); });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  }
  function updateCount() {
    $('segment-count').textContent = `${state.draft.segments.filter(segment => segment.include).length} из ${state.draft.segments.length} реплик включено`;
  }
  async function saveDraft() {
    if (!state.draft || state.busy) return false;
    const selected = state.selected;
    const revision = state.revision;
    setBusy(true);
    status('review-status', 'Сохраняем черновик…');
    try {
      await request(endpoint(selected, '/draft'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.draft) });
      if (selected === state.selected) {
        state.savedRevision = revision;
        status('review-status', dirty() ? 'Черновик сохранён. Новые изменения ещё не сохранены.' : 'Черновик сохранён. Можно вернуться к записи позже.');
      }
      return !dirty();
    } catch (error) { status('review-status', error.message, true); return false; }
    finally { setBusy(false); }
  }
  async function selectJob(id) {
    if (id === state.selected || state.selecting || state.busy) return;
    state.selecting = true;
    try {
      if (dirty() && !await saveDraft()) {
        status('review-status', 'Не удалось сохранить все изменения. Сохраните черновик перед переходом к другой записи.', true);
        return;
      }
      const data = await request(endpoint(id));
      const job = data.job || data;
      state.selected = id;
      state.job = job;
      state.draft = null;
      state.revision = state.savedRevision = 0;
      state.segmentElements = [];
      $('empty-state').hidden = true;
      $('job-panel').hidden = false;
      $('review-panel').hidden = true;
      renderJobStatus(job);
      if (job.result) renderReview(job);
      renderJobs();
      history.replaceState(null, '', `/audio?job=${encodeURIComponent(id)}`);
    } catch (error) { status('jobs-status', error.message, true); }
    finally { state.selecting = false; }
  }
  async function refreshJobs(initial = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const data = await request('/api/audio/jobs');
      state.jobs = data.jobs || [];
      renderJobs();
      if (initial && !state.selected) {
        const requested = new URLSearchParams(location.search).get('job');
        if (requested || state.jobs.length) await selectJob(requested || state.jobs[0].id);
      } else if (state.selected && !state.selecting && !state.busy) {
        const selected = state.selected;
        const summary = state.jobs.find(job => job.id === selected);
        if (!state.draft || ['queued', 'running'].includes(summary?.status) || summary?.status !== state.job?.status || (summary?.audioUrl && summary.audioUrl !== state.job?.audioUrl)) {
          const response = await request(endpoint(selected));
          const job = response.job || response;
          if (selected !== state.selected || state.selecting) return;
          state.job = job;
          renderJobStatus(job);
          // A finished review is rendered once. Polling never replaces edited fields.
          if (job.result && !state.draft) renderReview(job);
        }
      }
    } catch (error) { status('jobs-status', error.message, true); }
    finally { state.refreshing = false; }
  }
  function showEvaluationLink(url) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin || target.pathname !== '/') throw new Error('Сервер вернул некорректную ссылку на диалог.');
    $('evaluation-link').href = target.pathname + target.search;
    $('evaluation-link').hidden = false;
  }
  $('upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const file = $('audio-file').files[0];
    if (!file) return;
    if (!/\.(ogg|mp3|wav|m4a|flac|webm)$/i.test(file.name)) { status('upload-status', 'Выберите файл OGG, MP3, WAV, M4A, FLAC или WebM.', true); return; }
    if (!file.size || file.size > 80 * 1024 * 1024) { status('upload-status', 'Файл должен быть непустым и не превышать 80 МБ.', true); return; }
    $('upload-button').disabled = true;
    status('upload-status', 'Загружаем запись… Длительность будет проверена при обработке.');
    try {
      const params = new URLSearchParams({ filename: file.name, language: $('upload-language').value, speakers: $('upload-speakers').value });
      const data = await request(`/api/audio/upload?${params}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const job = data.job || data;
      if (!job.id) throw new Error('Сервер не вернул идентификатор записи. Обновите список записей.');
      status('upload-status', 'Запись загружена. Обработка продолжается; можно вернуться к ней позже.');
      $('audio-file').value = '';
      await refreshJobs();
      await selectJob(job.id);
    } catch (error) { status('upload-status', error.message, true); }
    finally { $('upload-button').disabled = false; }
  });
  $('review-language').addEventListener('change', () => { if (state.draft) { state.draft.language = $('review-language').value; changed(); } });
  $('save-draft').addEventListener('click', saveDraft);
  $('refresh-jobs').addEventListener('click', () => refreshJobs(!state.selected));
  $('publish-review').addEventListener('click', async () => {
    if (!state.draft || state.busy) return;
    const invalid = validateDraft(state.draft);
    if (invalid) { status('review-status', invalid, true); return; }
    if (!$('review-confirm').checked) { status('review-status', 'Подтвердите, что вы проверили текст и роли включённых реплик.', true); $('review-confirm').focus(); return; }
    const revision = state.revision;
    setBusy(true);
    status('review-status', 'Сохраняем подтверждённый диалог…');
    try {
      const data = await request(endpoint(state.selected, '/publish'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.draft) });
      state.savedRevision = revision;
      if (dirty()) status('review-status', 'Диалог сохранён, но появились новые правки. Проверьте и подтвердите их ещё раз.');
      else {
        showEvaluationLink(data.url || `/?group=AUDIO&dialog=${encodeURIComponent(data.conversationId)}`);
        status('review-status', 'Диалог сохранён. Откройте его, чтобы запустить оценку и проверить цитаты по исходной записи.');
        $('evaluation-link').focus();
      }
      await refreshJobs();
    } catch (error) { status('review-status', error.message, true); }
    finally { setBusy(false); }
  });
  $('download-text').addEventListener('click', () => {
    if (!state.draft || !state.job) return;
    const url = URL.createObjectURL(new Blob(['\uFEFF', transcriptText(state.job, state.draft)], { type: 'text/plain;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = `${(state.job.filename || 'transcript').replace(/\.[^.]+$/, '')}-transcript.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  audio.addEventListener('timeupdate', highlightTime);
  audio.addEventListener('seeked', highlightTime);
  audio.addEventListener('error', () => {
    if (!state.selected) return;
    status('playback-status', 'Браузер не смог воспроизвести этот формат. ');
    const link = element('a', '', 'Открыть исходный файл');
    link.href = $('download-original').href;
    link.target = '_blank';
    link.rel = 'noopener';
    $('playback-status').append(link);
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  refreshJobs(true);
  setInterval(() => { if (state.jobs.some(job => ['queued', 'running'].includes(job.status)) || (state.selected && !state.draft && !['failed', 'error'].includes(state.job?.status))) refreshJobs(); }, 2000);
}

if (typeof document !== 'undefined' && document.getElementById('upload-form')) startAudioPage();
