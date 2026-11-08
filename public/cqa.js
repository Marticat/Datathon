(function () {
  'use strict';

  /* CQA workbench in the "CQA — шаблон интерфейса" design (shell / side / vw / dl / cl / card).

     Embeddable component (e.g. a Dynamics 365 HTML web resource):
       window.CQA.mount(rootElement, { request, filterDialogs, group, dialog }) → { reload, destroy, state }
     - renders only inside rootElement (gets class "cqa"; all styles in cqa.css / cqa-extra.css are scoped to .cqa);
     - no globals besides window.CQA, no absolute URLs, no inline styles (data-driven styles go through CSSOM in post());
     - all server calls go through opts.request (public/cqa-api.js, whose base address is configurable).
     cqa-init.js mounts it into [data-cqa] / #cqa-root and reads data-api-base, data-group, data-dialog. */

  var SP = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

  /* ---------- утилиты ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mmss(s) { s = Math.max(0, Math.round(s)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmtAt(s) {
    var d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  /* исходная метка времени: ISO 8601 показываем как ЧЧ:ММ:СС, MM:SS — как есть */
  function shortTs(ts) { var m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(ts || ''); return m ? m[1] : ts; }
  /* подпись критерия: если она изменилась, старый результат считается устаревшим (совпадает с cqa-api.js) */
  function critSig(c) {
    return JSON.stringify([c.title, c.desc || '', c.type, (c.steps || []).join(','), !!c.naAllowed, !!c.gross]);
  }
  function maxOf(c) { return c.type === 'scale' && c.steps && c.steps.length ? Math.max.apply(null, c.steps) : 1; }

  /* Описания ступеней шкалы живут в тексте правила («20: … 15: …»), который читает модель.
     Редактор разбирает их в отдельные поля и собирает обратно только при правке. */
  function splitSteps(desc, steps) {
    var text = String(desc || ''), re = /(^|\s)(\d+(?:[.,]\d+)?):\s/g, hits = [], m;
    while ((m = re.exec(text))) {
      var v = Number(m[2].replace(',', '.'));
      if (steps.indexOf(v) >= 0) hits.push({ v: v, at: m.index + m[1].length, body: re.lastIndex });
    }
    var labels = {};
    hits.forEach(function (h, i) { labels[h.v] = text.slice(h.body, i + 1 < hits.length ? hits[i + 1].at : text.length).trim(); });
    return { base: (hits.length ? text.slice(0, hits[0].at) : text).trim(), labels: labels };
  }
  function joinSteps(c) {
    var parts = c.steps.filter(function (s) { return (c._labels[s] || '').trim(); }).map(function (s) { return s + ': ' + c._labels[s].trim(); });
    return [c._base.trim()].concat(parts).filter(Boolean).join(' ');
  }
  function stepUI(c) {
    if (c.type === 'scale' && !c._labels) { var p = splitSteps(c.desc, c.steps || []); c._base = p.base; c._labels = p.labels; }
    return c;
  }

  /* диалог с сервера: raw = [секунды, роль, текст, исходная метка времени] */
  function prep(d) {
    d.voice = d.channel === 'voice call';
    d.msgs = d.raw.map(function (m) { return { t: m[0], sp: m[1], tx: m[2], ts: m[3] || mmss(m[0]) }; });
    return d;
  }

  /* ---------- компонент ---------- */
  function mount(root, opts) {
    opts = opts || {};
    var base = opts.api || '';
    var state = {
      view: 'dialogs', group: opts.group || '', did: null, filter: { query: '', language: '', gross: false },
      checklist: null, draft: null, dialogs: [], results: {}, appeals: {},
      drafts: {}, errs: {}, form: null, hl: null, focus: null,
      t: 0, playing: false, toast: '', loading: true, loadErr: '', busy: false
    };
    var audio = null, toastT = null;

    function dlg(id) { return state.dialogs.filter(function (d) { return d.id === id; })[0]; }
    function replaceDialogs(dialogs) {
      var previous = dlg(state.did), previousHash = previous && previous.hash, previousAudio = previous && previous.audio;
      state.dialogs = dialogs.map(prep);
      var selected = dlg(state.did);
      if (!selected || selected.hash !== previousHash || selected.audio !== previousAudio) {
        state.t = 0; state.playing = false; state.hl = null; setAudio(selected);
      }
    }

    /* --- сервер --- */
    function api(method, path, body) {
      if (opts.request) return opts.request(method, path, body);
      var o = { method: method, headers: {} };
      if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(base + path, o).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      });
    }
    /* rubricId: выбранный чек-лист (по умолчанию — последний выбранный в этом браузере) */
    function load(group, rubricId) {
      var first = !state.checklist, keep = state.did;
      rubricId = rubricId || lsGet(LS_RUBRIC, '');
      state.loading = true; state.loadErr = ''; state.playing = false; setAudio(null); render();
      return api('GET', '/api/bootstrap?group=' + encodeURIComponent(group || '') + (rubricId ? '&rubricId=' + encodeURIComponent(rubricId) : '')).then(function (data) {
        state.checklists = data.checklists || [];
        /* выбранный чек-лист скрыт в этом браузере или пропал → стандарт */
        if (hiddenNames().indexOf(data.checklist.name) >= 0 && standardList() && standardList().id !== data.checklist.id) {
          lsSet(LS_RUBRIC, standardList().id); return load(group, standardList().id);
        }
        lsSet(LS_RUBRIC, data.checklist.id);
        state.group = data.group; state.groups = data.groups || []; state.checklist = data.checklist; state.draft = null; state.newList = false; state.jobs = data.jobs || [];
        state.dialogs = data.dialogs.map(prep); state.results = data.results || {}; state.appeals = data.appeals || {};
        var wanted = first && state.dialogs.some(function (d) { return d.id === opts.dialog; });
        state.did = wanted ? opts.dialog : dlg(keep) ? keep : state.dialogs.length ? state.dialogs[0].id : null;
        if (wanted) state.view = 'analysis';
        state.t = 0; state.hl = null; state.form = null; state.loading = false;
        setAudio(dlg(state.did)); render();
      }).catch(function (e) { state.loading = false; state.loadErr = e.message; render(); });
    }
    function evalDialog(d, ids) {
      return api('POST', '/api/evaluate', { group: state.group, dialogId: d.id, criteria: ids, hashes: Object.fromEntries([[d.id, d.hash]]) }).then(function (res) {
        if (res.rubricId && res.rubricId !== state.checklist.id) return res;
        state.results[d.id] = res.results;
        if (res.dialog) {
          var changedSource = d.hash !== res.dialog.hash || d.audio !== res.dialog.audio;
          Object.assign(d, prep(res.dialog));
          if (changedSource && state.did === d.id) { state.t = 0; state.playing = false; state.hl = null; setAudio(d); }
        }
        Object.keys(state.appeals).forEach(function (key) { if (key.indexOf(d.id + '|') === 0) delete state.appeals[key]; });
        return res;
      });
    }

    /* --- звук --- */
    function setAudio(d) {
      if (audio) { audio.pause(); audio = null; }
      if (d && d.audio && d.seekable) {
        audio = new Audio(d.audio);
        audio.preload = 'none';
        audio.addEventListener('ended', function () { state.playing = false; updatePlayer(); });
      }
    }
    function seekTo(t) {
      state.t = t;
      if (audio) { try { audio.currentTime = t; } catch (e) { /* ещё не загружено */ } }
    }
    function play(on) {
      var cur = dlg(state.did);
      if (!cur || !audio) return;
      if (!on) { state.playing = false; audio.pause(); updatePlayer(); return; }
      if (state.t >= cur.duration - 0.3) seekTo(0);
      state.playing = true;
      audio.currentTime = state.t;
      audio.play().catch(function () {
        state.playing = false;
        toast('Не удалось воспроизвести запись. Проверьте доступность аудиофайла.');
        updatePlayer();
      });
      updatePlayer();
    }

    /* --- расчёт --- */
    function rnd(n) { if (n == null) return null; var p = Math.pow(10, state.checklist.rounding); return Math.round(n * p) / p; }
    function fmt(n) { return n == null ? '-' : String(rnd(n)).replace('.', ','); }
    function ans(c, v) {
      if (v === 'na') return 'N/A';
      if (c.gross) return v ? 'Выявлено' : 'Не выявлено';
      return c.type === 'binary' ? (v ? 'Да' : 'Нет') : (v + ' из ' + maxOf(c));
    }
    /* значок критерия в стиле макета: ✓ полный балл, ✕ ноль или нарушение, – N/A, ◐ частично */
    function mark(c, v) {
      if (v === 'na') return ['na', '–'];
      if (c.gross) return v ? ['no', '!'] : ['', '✓'];
      var n = c.type === 'binary' ? v : v / maxOf(c);
      return n >= 1 ? ['', '✓'] : n <= 0 ? ['no', '✕'] : ['part', '◐'];
    }

    function rowsFor(d) {
      var res = state.results[d.id] || {};
      return state.checklist.criteria.map(function (c) {
        var r = res[c.id];
        var ok = !!r && r.k === c.type && r.sig === critSig(c);
        if (ok && r.v === 'na' && !c.naAllowed) ok = false;
        var ap = state.appeals[d.id + '|' + c.id] || null;
        var fin = ok ? (r.finalValue == null ? r.v : r.finalValue) : null;
        if (ok && ap && ap.dec) fin = ap.dec.v;
        return { c: c, r: ok ? r : null, orig: ok ? r.v : null, fin: fin, ap: ap, pending: !ok };
      });
    }
    /* критерии с N/A выпадают, их вес делится между остальными, «грубая ошибка» в баллы не входит */
    function score(rows, useFin) {
      var live = rows.filter(function (x) { return !x.pending && !x.c.gross && (useFin ? x.fin : x.orig) !== 'na'; });
      var sum = live.reduce(function (a, x) { return a + x.c.weight; }, 0);
      var f = sum > 0 ? 100 / sum : 0;
      var out = { total: 0, byRow: {}, bySec: {} };
      rows.forEach(function (x) {
        var v = useFin ? x.fin : x.orig;
        if (x.pending || x.c.gross || v === 'na') { out.byRow[x.c.id] = null; return; }
        var norm = x.c.type === 'binary' ? v : v / maxOf(x.c);
        var eff = x.c.weight * f, pts = eff * norm;
        out.byRow[x.c.id] = { eff: eff, pts: pts };
        out.total += pts;
        var s = out.bySec[x.c.section] || (out.bySec[x.c.section] = { eff: 0, pts: 0 });
        s.eff += eff; s.pts += pts;
      });
      if (sum <= 0) out.total = null;
      return out;
    }
    function openCount() { return Object.keys(state.appeals).filter(function (k) { return !state.appeals[k].dec; }).length; }
    function openFor(id) { return Object.keys(state.appeals).filter(function (k) { return k.indexOf(id + '|') === 0 && !state.appeals[k].dec; }).length; }
    function shownDialogs() { return opts.filterDialogs ? opts.filterDialogs(state.dialogs, state.filter) : state.dialogs; }

    /* ================================================================ шаблоны */
    function sideHTML() {
      var n = openCount();
      function it(v, label, badge, off) {
        return '<button class="side-i' + (state.view === v ? ' on' : '') + '" data-act="view" data-v="' + v + '"' + (off ? ' disabled' : '') +
          (state.view === v ? ' aria-current="page"' : '') + '>' + label + (badge ? '<span class="side-n">' + badge + '</span>' : '') + '</button>';
      }
      return '<nav class="side" aria-label="Разделы CQA"><h1>CQA</h1>' +
        it('dialogs', 'Диалоги') + it('checklist', 'Чек-листы') + it('appeals', 'Апелляции', n || '') + it('analysis', 'Анализ', '', !state.did) +
        '<div class="side-b"><input class="file" id="cqa-file" type="file" accept=".json,application/json" data-upload="1" tabindex="-1" aria-hidden="true">' +
        '<button class="btn line" type="button" data-act="upload" title="Диалоги в формате API организаторов или массив записей; у звонков audio_url">Загрузить JSON</button></div></nav>';
    }

    function head(title, sub, tools) {
      return '<header class="head"><div><h2>' + title + '</h2><p>' + sub + '</p></div>' + (tools ? '<div class="tools">' + tools + '</div>' : '') + '</header>';
    }

    /* ---------- Диалоги ---------- */
    function dialogsView() {
      var pendingDialogs = state.dialogs.filter(function (d) { return rowsFor(d).some(function (x) { return x.pending; }); }).length;
      var h = head('Диалоги', 'Выберите диалог и откройте его анализ · набор ' + esc(state.group || 'не выбран') + ' · чек-лист «' + esc(state.checklist.name) + '»',
        state.dialogs.length ? '<button class="btn" data-act="ck-apply"' + (pendingDialogs ? '' : ' disabled') + '>' + (pendingDialogs ? 'Оценить неоценённые · ' + pendingDialogs : 'Все диалоги оценены') + '</button>' : '');
      if (!state.dialogs.length) {
        return h + '<div class="dash"><p>Диалогов пока нет.</p><p>Загрузите JSON с диалогами кнопкой «Загрузить JSON» слева внизу. Для звонков в записи укажите audio_url.</p>' +
          '<p><button class="btn" type="button" data-act="upload">Загрузить JSON</button></p></div>';
      }
      var shown = shownDialogs();
      var groups = state.groups || [];
      h += '<div class="tools filters">' +
        (groups.length > 1 ? '<select class="in" data-group="1" aria-label="Набор данных">' + groups.map(function (g) {
          return '<option value="' + esc(g) + '"' + (g === state.group ? ' selected' : '') + '>Набор ' + esc(g) + '</option>';
        }).join('') + '</select>' : '') +
        '<input id="cqa-search" class="in s" data-filter="query" type="search" placeholder="Найти диалог или реплику" aria-label="Поиск диалогов" value="' + esc(state.filter.query) + '">' +
        '<select class="in" data-filter="language" aria-label="Язык">' + [['', 'Все языки'], ['RU', 'Русский'], ['KZ', 'Қазақша'], ['EN', 'English']].map(function (p) {
          return '<option value="' + p[0] + '"' + (state.filter.language === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('') + '</select>' +
        '<label class="chk"><input type="checkbox" data-filter="gross"' + (state.filter.gross ? ' checked' : '') + '> Грубые ошибки AI</label>' +
        '<span class="cnt">Показано ' + shown.length + ' из ' + state.dialogs.length + '</span></div>';
      if (!shown.length) return h + '<div class="dash">По выбранным фильтрам диалоги не найдены. Неоценённые диалоги не считаются проверенными.</div>';
      return h + '<div id="dlist">' + shown.map(function (d) {
        var rows = rowsFor(d), sc = score(rows, true), pend = rows.filter(function (x) { return x.pending; }).length;
        var gross = rows.some(function (x) { return !x.pending && x.c.gross && x.fin === 1; }), nA = openFor(d.id);
        var job = (state.jobs || []).some(function (j) { return j.conversationIds && j.conversationIds.indexOf(d.id) >= 0; });
        var meta = (d.voice ? 'Звонок' : 'Чат') + ' · ' + esc(d.lang) + (Number.isFinite(d.duration) ? ' · ' + mmss(d.duration) : '') + ' · ' + d.msgs.length + ' реплик';
        return '<div class="dl' + (d.id === state.did ? ' cur' : '') + '"><b>' + esc(d.id) + '<br><small>' + meta + '</small></b>' +
          (gross ? '<span class="tag bad">Грубая ошибка</span>' : '') +
          (d.grossAI && !gross ? '<span class="tag warn">AI выявил · пересмотрено</span>' : '') +
          (nA ? '<span class="tag warn">Апелляция</span>' : '') +
          (job ? '<span class="tag">В очереди</span>' : '') +
          (pend === rows.length ? '<span class="tag">Не оценено</span>' : '<span class="tag ok">Оценка ' + fmt(pend ? null : sc.total) + '</span>') +
          (pend && pend < rows.length ? '<span class="tag">Без оценки: ' + pend + '</span>' : '') +
          '<button class="btn" data-act="open" data-id="' + esc(d.id) + '">Анализ</button></div>';
      }).join('') + '</div>';
    }

    /* ---------- Анализ диалога ---------- */
    /* Дорожка: схема активности по репликам, а не аудиограмма (столбики выше там, где кто-то говорит). */
    var BARS = 72;
    function bars(d) {
      var seed = 7, out = [];
      function r() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
      for (var i = 0; i < BARS; i++) {
        var t = (i + 0.5) * d.duration / BARS, on = false;
        for (var k = 0; k < d.msgs.length; k++) {
          var m = d.msgs[k], next = d.msgs[k + 1] ? d.msgs[k + 1].t : d.duration;
          if (t >= m.t && t < Math.min(next, m.t + Math.max(3, m.tx.length * 0.09))) { on = true; break; }
        }
        out.push(on ? 22 + Math.round(r() * 74) : 8 + Math.round(r() * 8));
      }
      var row = out.map(function (h) { return '<i data-h="' + h + '"></i>'; }).join('');
      return '<div class="l">' + row + '</div><div class="l f" id="cqa-fill">' + row + '</div>';
    }
    function evidenceMsgs(d) {
      var seen = {};
      rowsFor(d).forEach(function (x) { (x.r && x.r.evidence || []).forEach(function (i) { seen[i] = true; }); });
      return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    }
    function playerHTML(d) {
      if (!d.seekable) {
        return '<div id="player">' + (d.audio ? '<audio class="native" controls preload="none" src="' + esc(d.audio) + '"></audio>' : '<p class="hint">Аудиозапись не приложена. Доступен транскрипт.</p>') +
          '<p class="hint">Метки времени в транскрипте календарные, поэтому реплики не привязаны к позиции в записи.</p></div>';
      }
      var pins = evidenceMsgs(d).map(function (i) {
        var m = d.msgs[i];
        return '<button class="pin" type="button" data-act="goto" data-play="1" data-d="' + esc(d.id) + '" data-m="' + i + '" data-left="' + (m.t / d.duration * 100).toFixed(2) + '" aria-label="Реплика ' + esc(shortTs(m.ts)) + '" title="' + esc(SP[m.sp] + ' ' + shortTs(m.ts)) + '"></button>';
      }).join('');
      return '<div id="player"><div class="pl"><button class="btn pp" type="button" id="cqa-play" data-act="play"' + (d.audio ? '' : ' disabled') + ' aria-label="Воспроизвести">▶</button>' +
        '<div class="wv" id="cqa-wave" data-act="wave" title="Перейти к месту записи">' + bars(d) + '<div class="reg" id="cqa-region" hidden></div>' + pins + '</div>' +
        '<span id="ptime">00:00 / ' + mmss(d.duration) + '</span></div>' +
        '<p class="hint">' + (d.audio ? 'Метки на дорожке показывают реплики из обоснования оценки. Нажатие на метку или время реплики переводит запись на это место.' : 'Аудиозапись не приложена: дорожка показывает, где в разговоре звучат реплики.') + '</p></div>';
    }
    function chatHTML(d) {
      return '<div class="chat' + (d.voice ? ' call' : '') + '" id="cqa-tr">' + d.msgs.map(function (m, i) {
        return '<div class="m ' + esc(m.sp) + '" data-i="' + i + '"><time><button class="tbtn" data-act="goto" data-d="' + esc(d.id) + '" data-m="' + i + '"' +
          (d.voice && d.seekable ? ' data-play="1"' : '') + ' title="' + esc(m.ts) + '">' + esc(shortTs(m.ts)) + '</button></time>' +
          '<div><b>' + (SP[m.sp] || esc(m.sp)) + (m.sp === 'bot' || m.sp === 'system' ? ' <span class="ctx">контекст</span>' : '') + '</b><p>' + esc(m.tx) + '</p></div></div>';
      }).join('') + '</div>';
    }

    function evChips(d, x) {
      var r = x.r, out = '';
      (r.evidence || []).forEach(function (i) {
        var m = d.msgs[i]; if (!m) return;
        var listen = d.voice && d.seekable && d.audio;
        out += '<button class="chip" type="button" data-act="goto" data-d="' + esc(d.id) + '" data-m="' + i + '"' + (listen ? ' data-play="1"' : '') +
          ' title="' + esc(SP[m.sp] + ': ' + m.tx) + '">' + (listen ? '▶ Прослушать ' : '↗ ') + esc(shortTs(m.ts)) + ' · ' + esc(SP[m.sp] || m.sp) + '</button>';
      });
      if (r.range && r.range[0] >= 0 && r.range[1] >= 0) {
        out += '<button class="chip" type="button" data-act="indices" data-d="' + esc(d.id) + '" data-a="' + r.range[0] + '" data-b="' + r.range[1] + '">Проверенный участок: реплики ' + (r.range[0] + 1) + '–' + (r.range[1] + 1) + '</button>';
      }
      if (!x.ap) out += '<button class="chip" type="button" data-act="appeal-open" data-d="' + esc(d.id) + '" data-c="' + esc(x.c.id) + '">Оспорить</button>';
      if (x.ap) out += '<button class="chip" type="button" data-act="to-foot">' + (x.ap.dec ? (x.ap.dec.kind === 'changed' ? 'Изменено проверяющим' : 'Подтверждено проверяющим') : 'Апелляция ждёт решения') + '</button>';
      return out ? '<div class="ev">' + out + '</div>' : '';
    }
    function critHTML(d, x, sc) {
      var c = x.c, p = sc.byRow[c.id], r = x.r;
      if (x.pending) {
        return '<div class="cr" data-crit="' + esc(c.id) + '"><div class="cr-t"><i class="na">?</i><span>' + esc(c.title) + '</span><em>нет оценки</em></div>' +
          '<p>Для текущей версии чек-листа оценки ещё нет.</p></div>';
      }
      var mk = mark(c, x.fin), changed = x.fin !== x.orig;
      var pts = c.gross ? (x.fin ? 'нарушение' : 'нет') : x.fin === 'na' ? 'N/A' : p ? fmt(p.pts) + ' / ' + fmt(p.eff) : '-';
      return '<div class="cr' + (state.focus === d.id + '|' + c.id ? ' focus' : '') + (c.gross ? ' gross' : '') + '" data-crit="' + esc(c.id) + '">' +
        '<div class="cr-t"><i class="' + mk[0] + '">' + mk[1] + '</i><span>' + esc(c.title) + '</span><em>' + pts + '</em></div>' +
        '<p class="ans">Ответ: <b>' + esc(ans(c, x.fin)) + '</b>' + (changed ? ' · <s>было: ' + esc(ans(c, x.orig)) + '</s>' : '') +
        (c.gross ? ' · без баллов, отмечается отдельно' : ' · вес ' + c.weight) + '</p>' +
        (r.v === 'na' ? '<p><b>Почему N/A.</b> ' + esc(r.na || '') + (c.naRule ? ' <span class="rule">Условие: ' + esc(c.naRule) + '</span>' : '') + '</p>' : '<p>' + esc(r.why) + '</p>') +
        evChips(d, x) + '</div>';
    }
    function scoreHTML(d) {
      var rows = rowsFor(d), fin = score(rows, true), org = score(rows, false);
      var pend = rows.some(function (x) { return x.pending; });
      if (pend) fin.total = org.total = null;
      var diff = rnd(fin.total) !== rnd(org.total), gross = rows.some(function (x) { return !x.pending && x.c.gross && x.fin === 1; });
      var naN = rows.filter(function (x) { return !x.pending && x.fin === 'na'; }).length;
      var h = '<h3>Оценка качества</h3><div class="score"><div class="ring" data-p="' + (fin.total == null ? 0 : Math.max(0, Math.min(100, rnd(fin.total)))) + '">' +
        '<div><span><b>' + fmt(fin.total) + '</b><br><small>/ 100</small></span></div></div>' +
        '<p class="sum">' + (pend ? 'Для этой версии чек-листа нужна оценка. ' : '') +
        (diff ? 'Исходная оценка модели: <b>' + fmt(org.total) + '</b>. Итог пересчитан с учётом решений проверяющего. ' : !pend ? 'Первоначальные ответы модели сохранены. ' : '') +
        (naN ? 'Критерии с N/A (' + naN + ') не входят в итог: их вес перераспределён между остальными. ' : '') +
        'Чек-лист «' + esc(state.checklist.name) + '» v' + listVersion() + ', округление до ' + state.checklist.rounding + ' зн.</p></div>' +
        (gross ? '<p class="flag">⚑ Грубая ошибка зафиксирована. Флаг учитывается отдельно от балла.</p>' : '');
      state.checklist.sections.forEach(function (s) {
        var sr = rows.filter(function (x) { return x.c.section === s.id; });
        if (!sr.length) return;
        var t = fin.bySec[s.id];
        h += '<h4 class="grp sec">' + esc(s.title) + '<span>' + (t ? fmt(t.pts) + ' / ' + fmt(t.eff) : '-') + '</span></h4>' +
          sr.map(function (x) { return critHTML(d, x, fin); }).join('');
      });
      return h;
    }
    function selectOptions(c, cur) {
      var o = [];
      if (c.gross) { o.push(['1', 'Выявлено']); o.push(['0', 'Не выявлено']); }
      else if (c.type === 'binary') { o.push(['1', 'Да']); o.push(['0', 'Нет']); }
      else c.steps.forEach(function (s) { o.push([String(s), s + ' из ' + maxOf(c)]); });
      if (c.naAllowed) o.push(['na', 'N/A']);
      return o.map(function (p) { return '<option value="' + p[0] + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('');
    }
    function footHTML(d) {
      var rows = rowsFor(d).filter(function (x) { return x.ap; });
      var h = '<h3>Апелляция и решение проверяющего</h3>';
      if (!rows.length) return h + '<div class="dash">Апелляций по этому диалогу нет. Оспорить оценку можно у любого критерия.</div>';
      return h + '<div class="ap">' + rows.map(function (x) {
        var c = x.c, ap = x.ap, key = d.id + '|' + c.id, fid = esc('cqa-f-' + d.id + '-' + c.id);
        var row = '<div class="row" data-crit-ap="' + esc(c.id) + '"><b>' + esc(c.title) + '</b><span class="cm">«' + esc(ap.comment) + '»<small>' + esc(fmtAt(ap.at)) + ' · ответ модели: ' + esc(ans(c, x.orig)) + '</small></span>';
        if (ap.dec) {
          return row + '<span class="tag ok">' + (ap.dec.kind === 'changed' ? 'Изменено: ' + esc(ans(c, x.orig)) + ' → ' + esc(ans(c, ap.dec.v)) : 'Оценка подтверждена') + '</span>' +
            '<span class="why">Причина: ' + esc(ap.dec.reason) + ' · ' + esc(fmtAt(ap.dec.at)) + '</span></div>';
        }
        var cur = state.drafts[key + '|v'] != null ? state.drafts[key + '|v'] : x.orig;
        return row + '<div class="dec"><label for="' + fid + '-v">Оценка</label><select id="' + fid + '-v" class="in" data-draft="' + esc(key) + '|v">' + selectOptions(c, cur) + '</select>' +
          '<label for="' + fid + '-r" class="sr">Причина решения</label><textarea id="' + fid + '-r" class="in" data-draft="' + esc(key) + '|reason" placeholder="Причина решения (обязательно)">' + esc(state.drafts[key + '|reason'] || '') + '</textarea>' +
          (state.errs[key] ? '<p class="err">' + esc(state.errs[key]) + '</p>' : '') +
          '<div class="tools"><button class="btn" type="button" data-act="decide-keep" data-d="' + esc(d.id) + '" data-c="' + esc(c.id) + '">Оставить оценку</button>' +
          '<button class="btn line" type="button" data-act="decide-change" data-d="' + esc(d.id) + '" data-c="' + esc(c.id) + '">Изменить на выбранную</button></div></div></div>';
      }).join('') + '</div>';
    }
    function analysisView() {
      var d = dlg(state.did);
      if (!d) return head('Анализ диалога', 'Диалог не выбран') + '<div class="dash">Выберите диалог в разделе «Диалоги».</div>';
      var rows = rowsFor(d), pend = rows.filter(function (x) { return x.pending; }).length;
      var sub = esc(d.id) + ' · ' + (d.voice ? 'Звонок' : 'Чат') + ' · ' + esc(d.lang) + ' · ' + (Number.isFinite(d.duration) ? mmss(d.duration) : 'время не указано');
      return '<div class="vw grid on">' +
        head('Анализ диалога', sub, '<button class="btn line" data-act="view" data-v="dialogs">← К списку</button>' +
          '<button class="btn" data-act="eval-dialog" data-d="' + esc(d.id) + '">' + (pend ? 'Оценить с ИИ' : 'Оценить заново') + '</button>') +
        '<section class="card left"><h3>Расшифровка</h3>' + (d.voice ? playerHTML(d) : '') + chatHTML(d) + '</section>' +
        '<aside class="card right">' + scoreHTML(d) + '</aside>' +
        '<section class="card foot" id="cqa-foot">' + footHTML(d) + '</section></div>';
    }

    /* ---------- Апелляции ---------- */
    function appealsView() {
      var items = [];
      state.dialogs.forEach(function (d) {
        state.checklist.criteria.forEach(function (c) { var ap = state.appeals[d.id + '|' + c.id]; if (ap) items.push({ d: d, c: c, ap: ap }); });
      });
      items.sort(function (a, b) { return (a.ap.dec ? 1 : 0) - (b.ap.dec ? 1 : 0); });
      var h = head('Апелляции', 'Спорные оценки и решения проверяющего · открытых: ' + openCount());
      return h + '<div id="alist">' + items.map(function (it) {
        var st = it.ap.dec ? (it.ap.dec.kind === 'changed' ? 'Оценка изменена проверяющим' : 'Оценка подтверждена') : 'Ожидает решения';
        return '<div class="dl"><b>' + esc(it.d.id) + ' · ' + esc(it.c.title) + '<br><small>' + esc(it.ap.comment) + '</small></b>' +
          '<span class="tag' + (it.ap.dec ? ' ok' : ' warn') + '">' + st + '</span>' +
          '<button class="btn' + (it.ap.dec ? ' line' : '') + '" data-act="goto-appeal" data-d="' + esc(it.d.id) + '" data-c="' + esc(it.c.id) + '">' + (it.ap.dec ? 'Открыть' : 'Рассмотреть') + '</button></div>';
      }).join('') + (items.length ? '' : '<div class="dash">Пока пусто. Новые апелляции появятся здесь</div>') + '</div>';
    }

    /* ---------- Чек-листы ----------
       Каждый сохранённый вариант: неизменяемая версия на сервере; версии с одним названием образуют один чек-лист.
       Стандарт (официальный чек-лист) нельзя менять и удалять, его можно скопировать. Сервер не удаляет версии,
       поэтому «Удалить» скрывает чек-лист из списка в этом браузере (история оценок на сервере сохраняется). */
    var LS_HIDDEN = 'cqa.hiddenChecklists', LS_RUBRIC = 'cqa.rubricId';
    function lsGet(k, d) { try { var v = window.localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* хранилище недоступно */ } }
    function hiddenNames() { return lsGet(LS_HIDDEN, []); }
    function setHidden(name, hide) {
      var h = hiddenNames().filter(function (n) { return n !== name; }); if (hide) h.push(name); lsSet(LS_HIDDEN, h);
    }
    function visibleLists() {
      var h = hiddenNames();
      return (state.checklists || []).filter(function (l) { return l.standard || h.indexOf(l.name) < 0; });
    }
    function standardList() { return (state.checklists || []).filter(function (l) { return l.standard; })[0]; }
    /* номер версии внутри чек-листа (сервер нумерует все сохранения подряд) */
    function listVersion() {
      var l = (state.checklists || []).filter(function (x) { return x.name === state.checklist.name; })[0];
      return l ? l.versions : state.checklist.version;
    }
    function isStandard() { var s = standardList(); return !state.newList && !!s && s.name === state.checklist.name; }

    function sig(cl) {
      return JSON.stringify({ n: cl.name, r: cl.rounding, c: cl.criteria.map(function (c) {
        var o = {}; Object.keys(c).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = c[k]; }); return o;
      }) });
    }
    function isDirty() { return !!state.draft && (state.newList || sig(state.draft) !== sig(state.checklist)); }
    function weightSum() { return state.draft.criteria.reduce(function (a, x) { return a + (x.gross ? 0 : Number(x.weight) || 0); }, 0); }
    function updateDirty() {
      var dirty = isDirty();
      ['ck-save', 'ck-reset'].forEach(function (act) { var b = root.querySelector('[data-act="' + act + '"]'); if (b) b.disabled = !dirty; });
      var w = root.querySelector('#cqa-wsum');
      if (w) { var s = Math.round(weightSum() * 100) / 100; w.textContent = 'Сумма весов: ' + String(s).replace('.', ','); w.className = 'tag ' + (s === 100 ? 'ok' : 'warn'); }
    }
    function newCriterion(sectionId) {
      return { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), section: sectionId, title: 'Новый критерий', desc: '', weight: 10, type: 'binary', naAllowed: false, naRule: '' };
    }
    function sectionId(dr, title) {
      title = String(title || '').trim() || 'Общее';
      var s = dr.sections.filter(function (x) { return x.title === title; })[0];
      if (!s) { s = { id: 's' + Date.now().toString(36) + dr.sections.length, title: title }; dr.sections.push(s); }
      return s.id;
    }

    /* всплывающее окно «Список чек-листов»: выбрать готовый, создать новый, удалить (с подтверждением в окне) */
    function listsModalHTML() {
      if (!state.listsOpen) return '';
      var cur = state.checklist.name;
      var rows = visibleLists().map(function (l) {
        var on = l.name === cur, ask = state.listsConfirm === l.name;
        var row = '<div class="dl' + (on ? ' cur' : '') + '"><b>' + esc(l.name) + '<br><small>версия ' + l.versions + ' · критериев: ' + l.criteria + '</small></b>' +
          (l.standard ? '<span class="tag">Стандарт</span>' : '');
        if (ask) {
          return row + '<span class="ask">Удалить из списка? Оценки останутся в истории.</span>' +
            '<button class="btn" type="button" data-act="list-delete-yes" data-name="' + esc(l.name) + '">Да, удалить</button>' +
            '<button class="btn line" type="button" data-act="list-delete-no">Отмена</button></div>';
        }
        return row + (on && !state.newList ? '<span class="tag ok">Выбран для оценки</span>' : '<button class="btn" type="button" data-act="list-select" data-id="' + esc(l.id) + '">Выбрать</button>') +
          (!l.standard && on && !state.newList ? '<button class="chip" type="button" data-act="list-rename">Переименовать</button>' : '') +
          (l.standard ? '' : '<button class="chip" type="button" data-act="list-delete" data-name="' + esc(l.name) + '">Удалить</button>') + '</div>';
      }).join('');
      return '<div class="ov on"><button class="ov-bg" type="button" data-act="lists-close" aria-label="Закрыть"></button>' +
        '<div class="mdl lists-mdl" role="dialog" aria-modal="true" aria-labelledby="cqa-lt"><h3 id="cqa-lt">Список чек-листов</h3>' +
        '<p>Выберите готовый чек-лист для оценки или создайте свой.' + (state.newList ? ' Новый чек-лист ещё не сохранён: выбор готового отменит его создание.' : '') + '</p>' +
        '<div class="lists">' + rows + '</div>' +
        '<div class="row"><button class="btn line" type="button" data-act="list-new">+ Новый с нуля</button>' +
        '<button class="btn line" type="button" data-act="list-copy">Копия выбранного</button>' +
        '<button class="btn" type="button" data-act="lists-close">Закрыть</button></div></div></div>';
    }

    function checklistView() {
      if (!state.draft) state.draft = clone(state.checklist);
      var dr = state.draft, dirty = isDirty(), locked = isStandard(), sum = Math.round(weightSum() * 100) / 100, n = 0;
      var titles = dr.sections.map(function (s) { return '<option value="' + esc(s.title) + '"></option>'; }).join('');
      var body = dr.sections.map(function (s) {
        var list = dr.criteria.map(function (c, i) { return { c: stepUI(c), i: i }; }).filter(function (x) { return x.c.section === s.id; });
        if (!list.length) return '';
        return '<h3 class="grp">' + esc(s.title) + '</h3>' + list.map(function (x) {
          var c = x.c, i = x.i, tv = c.gross ? 'gross' : c.type;
          var steps = c.type === 'scale' ? c.steps.map(function (v, k) {
            return '<div class="st"><input class="in sc" value="' + v + '" inputmode="decimal" aria-label="Балл" data-ck="step" data-i="' + i + '" data-k="' + k + '">' +
              '<input class="in sd" value="' + esc(c._labels[v] || '') + '" placeholder="Описание ступени" aria-label="Описание ступени" data-ck="label" data-i="' + i + '" data-k="' + k + '">' +
              '<button class="chip" type="button" aria-label="Удалить ступень" data-act="step-del" data-i="' + i + '" data-k="' + k + '"' + (c.steps.length <= 2 ? ' disabled' : '') + '>×</button></div>';
          }).join('') + '<div class="st"><button class="chip" type="button" data-act="step-add" data-i="' + i + '">+ Ступень</button></div>' : '';
          return '<div class="cl"><div class="cf"><span class="num">' + pad(++n) + '</span>' +
            '<input class="in n" value="' + esc(c.title) + '" aria-label="Название критерия" data-ck="title" data-i="' + i + '">' +
            '<label>Вес <input class="in w" type="number" min="0" max="100" step="any" value="' + (c.gross ? 0 : c.weight) + '"' + (c.gross ? ' disabled' : '') + ' data-ck="weight" data-i="' + i + '"></label>' +
            '<select class="in" aria-label="Тип ответа" data-ck="type" data-i="' + i + '"><option value="binary"' + (tv === 'binary' ? ' selected' : '') + '>Да / Нет</option><option value="scale"' + (tv === 'scale' ? ' selected' : '') + '>Шкала</option><option value="gross"' + (tv === 'gross' ? ' selected' : '') + '>Грубая ошибка</option></select>' +
            '<label><input type="checkbox"' + (c.naAllowed ? ' checked' : '') + (c.gross ? ' disabled' : '') + ' data-ck="na" data-i="' + i + '"> N/A</label>' +
            (c.gross ? '<span class="tag">Без баллов · отметка отдельно</span>' : '') +
            '<button class="chip" type="button" data-act="ck-del" data-i="' + i + '"' + (dr.criteria.length < 2 ? ' disabled' : '') + '>Удалить</button></div>' +
            '<div class="cf sub"><label>Секция <input class="in" list="cqa-sections" value="' + esc(s.title) + '" data-ck="section" data-i="' + i + '" aria-label="Секция"></label></div>' +
            steps +
            '<textarea class="in" aria-label="Формулировка" placeholder="Правило оценки (его читает модель)" data-ck="' + (c.type === 'scale' ? 'base' : 'desc') + '" data-i="' + i + '">' + esc(c.type === 'scale' ? c._base : c.desc || '') + '</textarea>' +
            (c.naAllowed ? '<span class="cap">Когда ставится N/A</span><textarea class="in na" aria-label="Условие N/A" placeholder="Когда ставится N/A (обязательно)" data-ck="naRule" data-i="' + i + '">' + esc(c.naRule || '') + '</textarea>' : '') +
            '</div>';
        }).join('');
      }).join('');
      var sub = state.newList ? esc(dr.name) + ' · новый, ещё не сохранён · критериев: ' + dr.criteria.length
        : esc(state.checklist.name) + ' · версия ' + listVersion() + ' · критериев: ' + dr.criteria.length + (dirty ? ' · есть несохранённые правки' : '');
      return head('Чек-листы', sub,
          '<button class="btn" type="button" data-act="lists-open">Список чек-листов</button>' +
          '<button class="btn line" type="button" data-act="list-new">+ Новый с нуля</button>') +
        '<div id="clist"><div class="tools bar">' +
        '<span id="cqa-wsum" class="tag ' + (sum === 100 ? 'ok' : 'warn') + '">Сумма весов: ' + String(sum).replace('.', ',') + '</span>' +
        '<label class="chk">Округление <select class="in" data-ck="rounding"' + (locked ? ' disabled' : '') + '><option value="0"' + (dr.rounding === 0 ? ' selected' : '') + '>до целых</option><option value="1"' + (dr.rounding === 1 ? ' selected' : '') + '>до десятых</option><option value="2"' + (dr.rounding === 2 ? ' selected' : '') + '>до сотых</option></select></label>' +
        '<button class="btn line" type="button" data-act="ck-add"' + (locked ? ' disabled' : '') + '>+ Критерий</button>' +
        '<button class="btn line" type="button" data-act="ck-reset"' + (dirty ? '' : ' disabled') + '>' + (state.newList ? 'Отменить создание' : 'Отменить правки') + '</button>' +
        '<button class="btn" type="button" data-act="ck-save"' + (dirty ? '' : ' disabled') + '>' + (state.newList ? 'Создать чек-лист' : 'Сохранить чек-лист') + '</button>' +
        '<button class="btn line" type="button" data-act="ck-apply"' + (state.newList ? ' disabled' : '') + '>Применить к диалогам</button></div>' +
        (locked ? '<p class="note">Это стандарт, он защищён от изменений. Чтобы сделать свой вариант на его основе, откройте «Список чек-листов» и нажмите «Копия выбранного». Или создайте «Новый с нуля».</p>' : '') +
        '<datalist id="cqa-sections">' + titles + '</datalist>' +
        '<fieldset class="fs"' + (locked ? ' disabled' : '') + '>' + (body || '<div class="dash">Критериев пока нет. Нажмите «+ Критерий».</div>') + '</fieldset>' +
        '<div class="card calc"><h3>Порядок расчёта</h3><p>1. N/A ставится только там, где он разрешён и выполнено условие. 2. «Да» даёт полный вес, «Нет» даёт ноль, для шкалы выбирается одна из ступеней. ' +
        '3. Шкальные баллы пересчитываются пропорционально весу: верхняя ступень даёт полный вес. 4. Критерии с N/A исключаются, их вес перераспределяется между применимыми, максимум остаётся 100. ' +
        '5. Итог округляется по настройке; грубые ошибки отмечаются отдельно.</p>' +
        '<p class="small">ИИ оценивает диалоги по выбранному чек-листу. Сохранение создаёт новую версию; «Применить к диалогам» запускает оценку по ней (один запрос к модели на диалог). «Удалить» скрывает чек-лист из списка в этом браузере, история оценок на сервере сохраняется.</p></div></div>';
    }
    function validateDraft() {
      var dr = state.draft, i, c, name = String(dr.name || '').trim();
      if (!name) return 'Укажите название чек-листа';
      var renamed = state.newList || name !== state.checklist.name;
      if (renamed && visibleLists().some(function (l) { return l.name === name; })) return 'Чек-лист «' + name + '» уже есть, выберите другое название';
      if (!dr.criteria.length) return 'Добавьте хотя бы один критерий';
      for (i = 0; i < dr.criteria.length; i++) {
        c = dr.criteria[i];
        if (!String(c.title).trim()) return 'У критерия №' + (i + 1) + ' нет названия';
        if (!String(c.desc || '').trim()) return 'У критерия «' + c.title + '» нет правила оценки';
        if (c.type === 'scale') {
          if (!(c.steps && c.steps.length >= 2)) return 'У критерия «' + c.title + '» нужны минимум две ступени шкалы';
          if (c.steps.indexOf(0) < 0) return 'Шкала критерия «' + c.title + '» должна содержать ступень 0';
          if (new Set(c.steps).size !== c.steps.length) return 'Ступени шкалы «' + c.title + '» повторяются';
        }
        if (c.naAllowed && !String(c.naRule || '').trim()) return 'Укажите условие N/A для критерия «' + c.title + '»';
      }
      if (weightSum() <= 0) return 'Сумма весов должна быть больше нуля';
      return '';
    }

    /* ---------- модальное окно апелляции ---------- */
    function modalHTML() {
      if (!state.form) return '';
      var parts = state.form.split('|'), d = dlg(parts[0]);
      var x = d && rowsFor(d).filter(function (r) { return r.c.id === parts[1]; })[0];
      if (!x || !x.r) return '';
      var c = x.c, key = state.form, p = score(rowsFor(d), true).byRow[c.id];
      var ev = (x.r.evidence || []).map(function (i) { var m = d.msgs[i]; return m ? '<p class="q">' + esc(shortTs(m.ts)) + ' · ' + esc(SP[m.sp] || m.sp) + ': «' + esc(m.tx) + '»</p>' : ''; }).join('');
      return '<div class="ov on"><button class="ov-bg" type="button" data-act="appeal-cancel" aria-label="Закрыть"></button>' +
        '<div class="mdl" role="dialog" aria-modal="true" aria-labelledby="cqa-mt"><h3 id="cqa-mt">Апелляция: ' + esc(c.title) + '</h3>' +
        '<p><b>Оценка ИИ:</b> ' + esc(ans(c, x.orig)) + (p && !c.gross ? ' · ' + fmt(p.pts) + ' из ' + fmt(p.eff) : '') + '</p>' +
        '<p>' + esc(x.r.v === 'na' ? x.r.na : x.r.why) + '</p>' + ev +
        '<label class="sr" for="cqa-ap-text">Комментарий</label><textarea id="cqa-ap-text" class="in" data-draft="' + esc(key) + '|comment" placeholder="Почему вы не согласны с оценкой?">' + esc(state.drafts[key + '|comment'] || '') + '</textarea>' +
        (state.errs[key] ? '<p class="err">' + esc(state.errs[key]) + '</p>' : '') +
        '<div class="row"><button class="btn line" type="button" data-act="appeal-cancel">Отмена</button><button class="btn" type="button" data-act="appeal-send" data-d="' + esc(d.id) + '" data-c="' + esc(c.id) + '">Отправить апелляцию</button></div></div></div>';
    }

    /* ================================================================ отрисовка */
    function bodyHTML() {
      if (state.loading) return '<div class="dash">Загрузка данных…</div>';
      if (state.loadErr || !state.checklist) {
        return '<div class="dash"><p>Не удалось загрузить данные: ' + esc(state.loadErr || 'нет ответа сервера') + '</p><p>Проверьте адрес сервера CQA (атрибут data-api-base у элемента компонента) и что сервер запущен.</p></div>';
      }
      if (state.view === 'analysis') return analysisView();
      return '<div class="vw on">' + (state.view === 'appeals' ? appealsView() : state.view === 'checklist' ? checklistView() : dialogsView()) + '</div>';
    }
    function render() {
      var scroll = window.scrollY;
      root.classList.add('cqa');
      root.innerHTML = '<div class="shell">' + sideHTML() + '<main class="main">' + bodyHTML() + '</main></div>' + modalHTML() + listsModalHTML() + nameModalHTML() +
        (state.toast ? '<div class="toast" role="status">' + esc(state.toast) + '</div>' : '');
      window.scrollTo(0, scroll);
      post();
    }
    function toast(msg, sticky) {
      state.toast = msg;
      var el = root.querySelector('.toast');
      if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); root.appendChild(el); }
      el.textContent = msg;
      clearTimeout(toastT);
      if (!sticky) toastT = setTimeout(function () { if (state.toast === msg) { state.toast = ''; var t = root.querySelector('.toast'); if (t) t.remove(); } }, 3600);
    }
    /* стили, которые зависят от данных: только через CSSOM (CSP запрещает style="…") */
    function post() {
      Array.prototype.forEach.call(root.querySelectorAll('[data-h]'), function (el) { el.style.height = el.getAttribute('data-h') + '%'; });
      Array.prototype.forEach.call(root.querySelectorAll('[data-left]'), function (el) { el.style.left = el.getAttribute('data-left') + '%'; });
      Array.prototype.forEach.call(root.querySelectorAll('.ring[data-p]'), function (el) { el.style.setProperty('--p', el.getAttribute('data-p')); });
      applyHL();
      updatePlayer();
      var nameIn = root.querySelector('#cqa-name-in');
      if (nameIn && document.activeElement !== nameIn) { nameIn.focus(); nameIn.select(); }
      var modal = root.querySelector('#cqa-ap-text');
      if (modal && document.activeElement === document.body) modal.focus();
      if (state.focus) {
        var parts = state.focus.split('|');
        var el = root.querySelector('[data-crit-ap="' + parts[1] + '"]') || root.querySelector('[data-crit="' + parts[1] + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        state.focus = null;
      }
    }

    function applyHL() {
      var d = dlg(state.did);
      var idxs = state.hl && state.hl.d === state.did ? state.hl.idxs : [];
      Array.prototype.forEach.call(root.querySelectorAll('.m[data-i]'), function (el) {
        el.classList.toggle('hit', idxs.indexOf(Number(el.getAttribute('data-i'))) >= 0);
      });
      var region = root.querySelector('#cqa-region');
      if (region && d) {
        if (idxs.length) {
          var a = d.msgs[Math.min.apply(null, idxs)].t, lastI = Math.max.apply(null, idxs);
          var b = d.msgs[lastI + 1] ? d.msgs[lastI + 1].t : d.duration;
          region.hidden = false;
          region.style.left = (a / d.duration * 100) + '%';
          region.style.width = Math.max(1, (b - a) / d.duration * 100) + '%';
        } else region.hidden = true;
      }
      var list = root.querySelector('#cqa-tr');
      if (list && idxs.length) {
        var target = list.querySelector('[data-i="' + Math.min.apply(null, idxs) + '"]');
        if (target) list.scrollTop = Math.max(0, target.offsetTop - list.offsetTop - list.clientHeight / 3);
      }
    }
    function updatePlayer() {
      var d = dlg(state.did);
      if (!d || !d.voice || !d.seekable) return;
      var time = root.querySelector('#ptime');
      if (!time) return;
      time.textContent = mmss(state.t) + ' / ' + mmss(d.duration);
      var fill = root.querySelector('#cqa-fill');
      if (fill) fill.style.clipPath = 'inset(0 ' + (100 - Math.min(100, state.t / d.duration * 100)).toFixed(2) + '% 0 0)';
      var btn = root.querySelector('#cqa-play');
      if (btn) { btn.textContent = state.playing ? '❚❚' : '▶'; btn.setAttribute('aria-label', state.playing ? 'Пауза' : 'Воспроизвести'); }
      var now = -1;
      d.msgs.forEach(function (m, i) { if (m.t <= state.t) now = i; });
      Array.prototype.forEach.call(root.querySelectorAll('.m[data-i]'), function (el) {
        el.classList.toggle('now', (state.playing || state.t > 0) && Number(el.getAttribute('data-i')) === now);
      });
    }
    var timer = setInterval(function () {
      var d = dlg(state.did);
      if (!state.playing || !d) return;
      if (audio) { state.t = audio.currentTime; if (audio.ended) state.playing = false; }
      updatePlayer();
    }, 250);

    /* --- оценка --- */
    function runEval(d, ids) {
      if (state.busy || !ids.length) return;
      state.busy = true; toast('Оцениваю ' + d.id + '…', true); render();
      evalDialog(d, ids).then(function (res) {
        var n = Object.keys(res.errors || {}).length;
        toast(n ? 'Готово, но критериев с ошибкой модели: ' + n + '. Повторите оценку.' : 'Оценка готова.');
      }).catch(function (e) { toast('Ошибка: ' + e.message); }).then(function () { state.busy = false; render(); });
    }
    function applyAll() {
      var jobs = [];
      state.dialogs.forEach(function (x) {
        var ids = rowsFor(x).filter(function (r) { return r.pending; }).map(function (r) { return r.c.id; });
        if (ids.length) jobs.push({ d: x, ids: ids });
      });
      if (!jobs.length) { toast('Все критерии уже оценены.'); return; }
      state.busy = true;
      toast('Оценка: 0 из ' + jobs.length + ' диалогов. Задача сохраняется на сервере.', true);
      api('POST', '/api/batch', { dialogIds: jobs.map(function (j) { return j.d.id; }), hashes: Object.fromEntries(jobs.map(function (j) { return [j.d.id, j.d.hash]; })) }).then(function (data) {
        replaceDialogs(data.dialogs); state.results = data.results; state.appeals = data.appeals;
        toast('Проверка завершена. Диалогов: ' + jobs.length + ', ошибок: ' + data.errors.length + '.');
      }).catch(function (error) { toast(error.message); }).finally(function () { state.busy = false; render(); });
    }


    /* ---------- сохранение и название чек-листа ---------- */
    function saveDraft() {
      var err = validateDraft();
      if (err) { toast(err); render(); return; }
      var created = state.newList, oldName = state.checklist.name;
      state.draft.name = String(state.draft.name).trim();
      api('PUT', '/api/checklist', state.draft).then(function (cl) {
        state.checklists = cl.checklists || state.checklists; delete cl.checklists;
        setHidden(cl.name, false);
        if (!created && cl.name !== oldName && !(standardList() && standardList().name === oldName)) setHidden(oldName, true);  /* переименование */
        lsSet(LS_RUBRIC, cl.id);
        state.checklist = cl; state.draft = clone(cl); state.newList = false; state.results = {}; state.appeals = {};
        state.dialogs.forEach(function (dialog) { delete dialog.grossAI; delete dialog.grossFinal; });
        toast(created ? 'Чек-лист «' + cl.name + '» создан и выбран для оценки. Нажмите «Применить к диалогам», чтобы оценить по нему.'
          : cl.name !== oldName ? 'Чек-лист переименован в «' + cl.name + '».' : 'Чек-лист сохранён. Нажмите «Применить к диалогам», чтобы оценить по нему.');
        render();
      }).catch(function (e2) { toast('Ошибка: ' + e2.message); render(); });
    }
    /* новый чек-лист с нуля или копия выбранного, сразу с названием */
    function startDraft(mode, name) {
      var base = clone(state.checklist);
      if (mode === 'new') { base.sections = [{ id: 's1', title: 'Общее' }]; base.criteria = [newCriterion('s1')]; }
      else base.criteria.forEach(function (c) { delete c._labels; delete c._base; });
      base.name = name; delete base.id; delete base.version;
      state.newList = true; state.draft = base; render();
    }
    function nameOk() {
      var dlgState = state.nameDlg; if (!dlgState) return;
      var name = String(dlgState.value || '').trim();
      var taken = visibleLists().some(function (l) { return l.name === name && !(dlgState.mode === 'rename' && name === state.checklist.name); });
      dlgState.err = !name ? 'Укажите название' : taken ? 'Такое название уже есть' : '';
      if (dlgState.err) { render(); return; }
      state.nameDlg = null;
      if (dlgState.mode === 'rename') {
        if (name === state.checklist.name) { render(); return; }
        if (!state.draft) state.draft = clone(state.checklist);
        state.draft.name = name; saveDraft();
      } else startDraft(dlgState.mode, name);
    }
    function nameModalHTML() {
      var n = state.nameDlg; if (!n) return '';
      var title = n.mode === 'rename' ? 'Переименовать чек-лист' : n.mode === 'copy' ? 'Копия чек-листа' : 'Новый чек-лист';
      return '<div class="ov on"><button class="ov-bg" type="button" data-act="name-cancel" aria-label="Закрыть"></button>' +
        '<div class="mdl" role="dialog" aria-modal="true" aria-labelledby="cqa-nt"><h3 id="cqa-nt">' + title + '</h3>' +
        '<p>' + (n.mode === 'new' ? 'Начнём с пустого чек-листа: критерии и секции добавите сами.' : n.mode === 'copy' ? 'Копия «' + esc(state.checklist.name) + '» со всеми критериями, её можно менять.' : 'Сохранится под новым названием, оценки по старому останутся в истории.') + '</p>' +
        '<label class="sr" for="cqa-name-in">Название</label><input id="cqa-name-in" class="in s" data-ck="name" value="' + esc(n.value) + '" placeholder="Название чек-листа" maxlength="200">' +
        (n.err ? '<p class="err">' + esc(n.err) + '</p>' : '') +
        '<div class="row"><button class="btn line" type="button" data-act="name-cancel">Отмена</button><button class="btn" type="button" data-act="name-ok">' + (n.mode === 'rename' ? 'Переименовать' : 'Создать') + '</button></div></div></div>';
    }

    /* ================================================================ события */
    root.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el || !root.contains(el) || el.disabled) return;
      var a = el.getAttribute('data-act'), ds = el.getAttribute('data-d'), cid = el.getAttribute('data-c');
      var d = ds ? dlg(ds) : null;

      if (state.busy && ['upload', 'ck-save', 'ck-apply', 'eval-dialog', 'appeal-send', 'decide-change', 'decide-keep'].indexOf(a) >= 0) { toast('Дождитесь завершения текущей проверки. Задача сохранена на сервере.'); return; }
      if (a === 'view') {
        state.view = el.getAttribute('data-v');
        if (state.view === 'checklist' && !state.draft && state.checklist) state.draft = clone(state.checklist);
        render(); window.scrollTo(0, 0);
      } else if (a === 'upload') {
        var file = root.querySelector('#cqa-file'); if (file) file.click();
      } else if (a === 'open') {
        state.did = el.getAttribute('data-id'); state.view = 'analysis'; state.t = 0; state.playing = false; state.hl = null; state.form = null;
        setAudio(dlg(state.did)); render(); window.scrollTo(0, 0);
      } else if (a === 'goto' || a === 'indices') {
        var idxs = [], t0 = 0;
        if (a === 'goto') { var mi = Number(el.getAttribute('data-m')); idxs = [mi]; t0 = d.msgs[mi].t; }
        else {
          var first = Number(el.getAttribute('data-a')), last = Number(el.getAttribute('data-b')); t0 = d.msgs[first].t;
          for (var ix = first; ix <= last; ix++) idxs.push(ix);
        }
        state.hl = { d: d.id, idxs: idxs };
        if (d.voice && d.seekable) { seekTo(t0); if (el.getAttribute('data-play') && audio) play(true); }
        applyHL(); updatePlayer();
        var tr = root.querySelector('#cqa-tr');
        if (tr && tr.getBoundingClientRect().top < 0 && tr.scrollIntoView) tr.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (a === 'wave') {
        var cur = dlg(state.did), box = el.getBoundingClientRect();
        if (!cur || e.target.closest('.pin')) return;
        seekTo(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * cur.duration);
        if (state.playing && audio) audio.currentTime = state.t;
        updatePlayer();
      } else if (a === 'play') {
        play(!state.playing);
      } else if (a === 'appeal-open') {
        state.form = ds + '|' + cid; render();
      } else if (a === 'appeal-cancel') {
        state.form = null; render();
      } else if (a === 'to-foot') {
        var foot = root.querySelector('#cqa-foot'); if (foot) foot.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (a === 'appeal-send') {
        var key = ds + '|' + cid, text = (state.drafts[key + '|comment'] || '').trim();
        if (!text) { state.errs[key] = 'Опишите, с чем вы не согласны.'; render(); return; }
        state.errs[key] = ''; el.disabled = true;
        api('POST', '/api/appeals', { dialogId: ds, criterionId: cid, comment: text, evaluationId: state.results[ds][cid].evaluationId }).then(function (ap) {
          state.appeals[key] = ap; state.form = null; delete state.drafts[key + '|comment']; state.focus = key;
          toast('Апелляция сохранена. Проверяющий увидит её в очереди.'); render();
        }).catch(function (err) { state.errs[key] = err.message; render(); });
      } else if (a === 'decide-change' || a === 'decide-keep') {
        var k2 = ds + '|' + cid;
        var row = rowsFor(d).filter(function (x) { return x.c.id === cid; })[0];
        var reason = (state.drafts[k2 + '|reason'] || '').trim();
        if (!reason) { state.errs[k2] = 'Укажите причину решения.'; render(); return; }
        var nv = row.orig;
        if (a === 'decide-change') {
          var raw = state.drafts[k2 + '|v'] != null ? String(state.drafts[k2 + '|v']) : String(row.orig);
          nv = raw === 'na' ? 'na' : Number(raw);
          if (String(nv) === String(row.orig)) { state.errs[k2] = 'Выберите оценку, отличную от ответа модели, или нажмите «Оставить оценку».'; render(); return; }
        }
        state.errs[k2] = ''; el.disabled = true;
        var before = score(rowsFor(d), true).total;
        api('POST', '/api/appeals/decide', { dialogId: ds, criterionId: cid, v: nv, reason: reason, appealId: state.appeals[k2].id }).then(function (ap) {
          state.appeals[k2] = ap; delete state.drafts[k2 + '|reason']; delete state.drafts[k2 + '|v'];
          toast('Решение сохранено. Итог: ' + fmt(before) + ' → ' + fmt(score(rowsFor(d), true).total) + '.'); render();
        }).catch(function (err) { state.errs[k2] = err.message; render(); });
      } else if (a === 'goto-appeal') {
        state.view = 'analysis'; state.did = ds; state.t = 0; state.playing = false; state.hl = null; state.focus = ds + '|' + cid;
        setAudio(dlg(ds)); render();
      } else if (a === 'eval-dialog') {
        var pending = rowsFor(d).filter(function (x) { return x.pending; }).map(function (x) { return x.c.id; });
        runEval(d, pending.length ? pending : state.checklist.criteria.map(function (c) { return c.id; }));
      } else if (a === 'ck-add') {
        var dr0 = state.draft;
        var sec = dr0.criteria.length ? dr0.criteria[dr0.criteria.length - 1].section : sectionId(dr0, dr0.sections[0] ? dr0.sections[0].title : 'Общее');
        dr0.criteria.push(newCriterion(sec));
        render();
        var cls = root.querySelectorAll('.cl'); if (cls.length) { cls[cls.length - 1].scrollIntoView({ block: 'center' }); cls[cls.length - 1].querySelector('.n').select(); }
      } else if (a === 'ck-del') {
        state.draft.criteria.splice(Number(el.getAttribute('data-i')), 1); render();
      } else if (a === 'step-add' || a === 'step-del') {
        var sc = state.draft.criteria[Number(el.getAttribute('data-i'))];
        if (a === 'step-add') { var mx = Math.max.apply(null, sc.steps.concat([0])); sc.steps.unshift(mx + 5); }
        else { var gone = sc.steps.splice(Number(el.getAttribute('data-k')), 1)[0]; delete sc._labels[gone]; sc.desc = joinSteps(sc); }
        render();
      } else if (a === 'ck-reset') {
        state.newList = false; state.draft = clone(state.checklist); render();
      } else if (a === 'ck-save') {
        el.disabled = true; saveDraft();
      } else if (a === 'name-cancel') {
        state.nameDlg = null; render();
      } else if (a === 'name-ok') {
        nameOk();
      } else if (a === 'list-rename') {
        state.listsOpen = false; state.nameDlg = { mode: 'rename', value: state.checklist.name, err: '' }; render();
      } else if (a === 'ck-apply') {
        if (state.view === 'checklist' && isDirty()) { toast('Сначала сохраните чек-лист.'); return; }
        applyAll();
      } else if (a === 'lists-open') {
        state.listsOpen = true; state.listsConfirm = null; render();
      } else if (a === 'lists-close') {
        state.listsOpen = false; state.listsConfirm = null; render();
      } else if (a === 'list-select') {
        /* выбрать готовый можно всегда: незавершённое создание или правки просто отменяются */
        var pick = el.getAttribute('data-id'), dropped = isDirty();
        state.listsOpen = false; state.listsConfirm = null;
        if (pick === state.checklist.id) {
          state.newList = false; state.draft = clone(state.checklist);
          toast((dropped ? 'Изменения отменены. ' : '') + 'Выбран чек-лист «' + state.checklist.name + '».'); render(); return;
        }
        if (dropped) toast('Несохранённые изменения отменены.');
        load(state.group, pick);
      } else if (a === 'list-delete') {
        state.listsConfirm = el.getAttribute('data-name'); render();
      } else if (a === 'list-delete-no') {
        state.listsConfirm = null; render();
      } else if (a === 'list-delete-yes') {
        var nm = el.getAttribute('data-name');
        setHidden(nm, true); state.listsConfirm = null;
        if (nm === state.checklist.name && standardList()) { toast('Чек-лист «' + nm + '» удалён из списка. Выбран стандарт.'); load(state.group, standardList().id); }
        else { toast('Чек-лист «' + nm + '» удалён из списка.'); render(); }
      } else if (a === 'list-new' || a === 'list-copy') {
        state.listsOpen = false; state.listsConfirm = null;
        state.nameDlg = { mode: a === 'list-new' ? 'new' : 'copy', value: a === 'list-new' ? '' : state.checklist.name + ' (копия)', err: '' }; render();
      }
    });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (state.form || state.listsOpen || state.nameDlg)) { state.form = null; state.listsOpen = false; state.listsConfirm = null; state.nameDlg = null; render(); }
      if (e.key === 'Enter' && e.target.id === 'cqa-name-in') { e.preventDefault(); nameOk(); }
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.getAttribute('data-filter') === 'query') {
        var caret = t.selectionStart; state.filter.query = t.value; render();
        var search = root.querySelector('#cqa-search'); search.focus(); search.setSelectionRange(caret, caret); return;
      }
      if (t.getAttribute('data-draft')) { state.drafts[t.getAttribute('data-draft')] = t.value; return; }
      var f = t.getAttribute('data-ck');
      if (!f || !state.draft || f === 'rounding' || f === 'type' || f === 'section' || f === 'na') return;
      if (f === 'name') { if (state.nameDlg) state.nameDlg.value = t.value; return; }
      var c = state.draft.criteria[Number(t.getAttribute('data-i'))];
      if (f === 'title') c.title = t.value;
      if (f === 'desc') c.desc = t.value;
      if (f === 'naRule') c.naRule = t.value;
      if (f === 'weight') c.weight = Math.max(0, Number(t.value) || 0);
      if (f === 'base') { c._base = t.value; c.desc = joinSteps(c); }
      if (f === 'label') { c._labels[c.steps[Number(t.getAttribute('data-k'))]] = t.value; c.desc = joinSteps(c); }
      if (f === 'step') {
        var k = Number(t.getAttribute('data-k')), v = Number(String(t.value).replace(',', '.'));
        if (t.value.trim() !== '' && isFinite(v) && v >= 0) {
          var old = c.steps[k]; c.steps[k] = v;
          if (old !== v) { c._labels[v] = c._labels[old] || ''; delete c._labels[old]; c.desc = joinSteps(c); }
        }
      }
      updateDirty();
    });
    /* загрузка JSON с диалогами (звонки — с audio_url) */
    function upload(input) {
      var f = input.files && input.files[0];
      if (!f || state.busy) return;
      state.busy = true; toast('Загружаю ' + f.name + '…', true);
      f.text().then(function (text) {
        var payload;
        try { payload = JSON.parse(text); } catch (err) { throw new Error('Файл не является корректным JSON.'); }
        return api('POST', '/api/import-json', { payload: payload });
      }).then(function (data) {
        state.group = data.group; state.groups = data.groups || []; state.checklist = data.checklist; state.checklists = data.checklists || state.checklists;
        state.draft = null; state.newList = false; state.jobs = data.jobs || [];
        state.results = data.results || {}; state.appeals = data.appeals || {}; replaceDialogs(data.dialogs);
        if (!dlg(state.did)) { state.did = state.dialogs.length ? state.dialogs[0].id : null; setAudio(dlg(state.did)); }
        state.view = 'dialogs';
        toast('Загружено диалогов: ' + data.imported + ' (набор ' + data.group + ').');
      }).catch(function (err) { toast('Не удалось загрузить: ' + err.message); })
        .finally(function () { state.busy = false; input.value = ''; render(); });
    }

    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute('data-upload')) { upload(t); return; }
      if (t.getAttribute('data-group')) { load(t.value); return; }
      if (t.getAttribute('data-filter') === 'gross' || t.getAttribute('data-filter') === 'language') {
        state.filter[t.getAttribute('data-filter')] = t.type === 'checkbox' ? t.checked : t.value; render(); return;
      }
      if (t.getAttribute('data-draft')) { state.drafts[t.getAttribute('data-draft')] = t.value; return; }
      var f = t.getAttribute('data-ck');
      if (!f) return;
      if (f === 'rounding') { state.draft.rounding = Number(t.value); render(); return; }
      if (f === 'name') return;
      var c = state.draft.criteria[Number(t.getAttribute('data-i'))];
      if (f === 'step') { c.steps.sort(function (x, y) { return y - x; }); render(); return; }
      if (f === 'section') {  /* секция по названию: новая создаётся, пустые не попадают в сохранённый чек-лист */
        c.section = sectionId(state.draft, t.value);
        var used = state.draft.criteria.map(function (x) { return x.section; });
        state.draft.sections = state.draft.sections.filter(function (s) { return used.indexOf(s.id) >= 0; });
      }
      if (f === 'type') {
        if (t.value === 'gross') { c.type = 'binary'; c.gross = true; c.weight = 0; c.naAllowed = false; c.naRule = ''; if (c._base != null) c.desc = c._base; delete c.steps; delete c._labels; delete c._base; }
        else {
          if (c.gross) { c.gross = false; c.weight = 5; }
          c.type = t.value;
          if (c.type === 'scale') { c.steps = c.steps && c.steps.length >= 2 ? c.steps : [10, 5, 0]; delete c._labels; }
          else { if (c._base != null) c.desc = c._base; delete c.steps; delete c._labels; delete c._base; }
        }
      }
      if (f === 'na') { c.naAllowed = t.checked; if (!t.checked) c.naRule = ''; }
      if (f === 'title' || f === 'desc' || f === 'naRule' || f === 'weight' || f === 'base' || f === 'label') return;
      render();
    });

    var polling = false;
    var jobsTimer = setInterval(function () {
      if (polling || state.busy || !state.jobs || !state.jobs.length || state.form || root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      polling = true;
      api('GET', '/api/bootstrap?group=' + encodeURIComponent(state.group) + '&rubricId=' + encodeURIComponent(state.checklist.id)).then(function (data) {
        if (data.checklist.id !== state.checklist.id) return;
        state.jobs = data.jobs || []; replaceDialogs(data.dialogs); state.results = data.results || {}; state.appeals = data.appeals || {}; render();
      }).catch(function (e) { toast(e.message); }).finally(function () { polling = false; });
    }, 2500);
    load(state.group);
    return {
      destroy: function () { clearInterval(timer); clearInterval(jobsTimer); setAudio(null); root.innerHTML = ''; },
      reload: load,
      state: state
    };
  }
  window.CQA = { mount: mount };
})();
