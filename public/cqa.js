(function () {
  'use strict';

  var SP = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

  /* ---------- утилиты ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mmss(s) { s = Math.max(0, Math.round(s)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmtAt(s) {
    var d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  /* подпись критерия: если она изменилась, старый результат считается устаревшим.
     Должна совпадать с critSig в server.js */
  function critSig(c) {
    return JSON.stringify([c.title, c.desc || '', c.type, (c.steps || []).join(','), !!c.naAllowed, !!c.gross]);
  }
  function maxOf(c) { return c.type === 'scale' && c.steps && c.steps.length ? Math.max.apply(null, c.steps) : 1; }
  function parseSteps(str) {
    var a = String(str).split(/[\s,;]+/).filter(Boolean).map(Number).filter(function (x) { return isFinite(x) && x >= 0; });
    a = a.filter(function (x, i) { return a.indexOf(x) === i; }).sort(function (x, y) { return y - x; });
    return a.length >= 2 ? a : null;
  }
  function runPool(items, limit, fn, onProgress) {
    var idx = 0, active = 0, done = 0;
    return new Promise(function (resolve) {
      if (!items.length) return resolve();
      function pump() {
        while (active < limit && idx < items.length) {
          (function (it) {
            active++;
            fn(it).then(function () {
              active--; done++;
              if (onProgress) onProgress(done, items.length);
              if (done === items.length) resolve(); else pump();
            });
          })(items[idx++]);
        }
      }
      pump();
    });
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
      role: 'analyst', view: 'dialogs', group: opts.group || '', did: null,
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
    function load(group) {
      state.loading = true; state.loadErr = ''; state.playing = false; setAudio(null); render();
      return api('GET', '/api/bootstrap?group=' + encodeURIComponent(group || '')).then(function (data) {
        state.group = data.group; state.checklist = data.checklist; state.draft = null; state.jobs = data.jobs || [];
        state.dialogs = data.dialogs.map(prep); state.results = data.results || {}; state.appeals = data.appeals || {};
        state.did = state.dialogs.length ? state.dialogs[0].id : null;
        state.t = 0; state.hl = null; state.form = null; state.loading = false;
        setAudio(dlg(state.did)); render();
      }).catch(function (e) { state.loading = false; state.loadErr = e.message; render(); });
    }
    function evalDialog(d, ids) {
      return api('POST', '/api/evaluate', { group: state.group, dialogId: d.id, criteria: ids, hashes: Object.fromEntries([[d.id,d.hash]]) }).then(function (res) {
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

    /* --- расчёт --- */
    function rnd(n) { if (n == null) return null; var p = Math.pow(10, state.checklist.rounding); return Math.round(n * p) / p; }
    function fmt(n) { return n == null ? '—' : rnd(n).toFixed(state.checklist.rounding).replace('.', ','); }
    function tone(n) { return n == null ? 'warn' : n >= 80 ? 'good' : n >= 60 ? 'warn' : 'bad'; }
    function ans(c, v) {
      if (v === 'na') return 'N/A';
      if (c.gross) return v ? 'Выявлено' : 'Не выявлено';
      return c.type === 'binary' ? (v ? 'Да' : 'Нет') : (v + ' из ' + maxOf(c));
    }
    function ctone(c, v) {
      if (v === 'na') return 'na';
      if (c.gross) return v ? 'bad' : 'good';
      var n = c.type === 'binary' ? v : v / maxOf(c);
      return n >= 0.8 ? 'good' : n >= 0.5 ? 'warn' : 'bad';
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
    /* критерии с N/A выпадают, их вес делится между остальными, критерий «грубая ошибка» в баллы не входит */
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
    function openCount() {
      return Object.keys(state.appeals).filter(function (k) { return !state.appeals[k].dec; }).length;
    }
    function openFor(id) {
      return Object.keys(state.appeals).filter(function (k) { return k.indexOf(id + '|') === 0 && !state.appeals[k].dec; }).length;
    }

    /* --- шаблоны --- */
    function navHTML() {
      var n = openCount();
      function it(v, label, badge) {
        return '<button class="cqa-nav-item' + (state.view === v ? ' is-active' : '') + '" data-act="view" data-v="' + v + '">' +
          label + (badge ? '<span class="cqa-badge">' + badge + '</span>' : '') + '</button>';
      }
      function rb(r, label) {
        return '<button data-act="role" data-r="' + r + '" class="' + (state.role === r ? 'is-on' : '') + '" aria-pressed="' + String(state.role === r) + '">' + label + '</button>';
      }
      return '<nav class="cqa-nav" aria-label="Разделы CQA"><div class="cqa-brand">CQA</div>' +
        it('dialogs', 'Диалоги') + it('checklist', 'Чек-листы') + it('appeals', 'Апелляции', n || '') +
        '<a class="cqa-nav-item" href="/classic">Модель, импорт и история ↗</a><a class="cqa-nav-item" href="/api/export" download>Экспорт JSON ↓</a>' +
        '<div class="cqa-group"><label class="cqa-role-l" for="cqa-group">Набор данных</label>' +
        '<input id="cqa-group" class="cqa-in" type="text" value="' + esc(state.group) + '" placeholder="group_id">' +
        '<button class="cqa-btn" data-act="load-group">Загрузить</button></div>' +
        '<div class="cqa-role"><span class="cqa-role-l">Роль</span><div class="cqa-seg" role="group" aria-label="Роль в демонстрации">' +
        rb('analyst', 'Аналитик') + rb('reviewer', 'Проверяющий') + '</div></div></nav>';
    }

    function listHTML() {
      return '<ul class="cqa-list">' + state.dialogs.map(function (d) {
        var rows = rowsFor(d), sc = score(rows, true);
        var nA = openFor(d.id);
        var gross = rows.some(function (x) { return !x.pending && x.c.gross && x.fin === 1; });
        var pend = rows.filter(function (x) { return x.pending; }).length;
        return '<li><button class="cqa-item' + (d.id === state.did ? ' is-active' : '') + '" data-act="open" data-id="' + esc(d.id) + '">' +
          '<span class="cqa-item-top"><span class="cqa-item-id">' + esc(d.id) + '</span><span class="cqa-score-s ' + tone(sc.total) + '">' + (pend === rows.length ? '—' : fmt(sc.total)) + '</span></span>' +
          '<span class="cqa-item-meta">' + (d.voice ? 'Звонок' : 'Чат') + ' · ' + esc(d.lang) + (d.operator ? ' · ' + esc(d.operator) : '') + '</span>' +
          '<span class="cqa-tags">' +
          (gross ? '<span class="cqa-tag cqa-tag--bad">Грубая ошибка</span>' : '') +
          (nA ? '<span class="cqa-tag cqa-tag--warn">Апелляция</span>' : '') +
          (pend ? '<span class="cqa-tag">Не оценено: ' + pend + '</span>' : '') +
          '</span></button></li>';
      }).join('') + '</ul>';
    }

    /* Схема активности по текстовым репликам; не аудиограмма. */
    function wave(d) {
      var N = 150, step = d.duration / N, out = '', seed = 7;
      function r() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
      ['client', 'operator'].forEach(function (sp, lane) {
        var y0 = lane ? 42 : 0, cls = lane ? 'cqa-bar cqa-bar--op' : 'cqa-bar';
        for (var i = 0; i < N; i++) {
          var t = i * step, on = false;
          for (var k = 0; k < d.msgs.length; k++) {
            var m = d.msgs[k];
            if (m.sp === sp) {
              var next = d.msgs[k + 1] ? d.msgs[k + 1].t : d.duration;
              var end = Math.min(next - 1, m.t + Math.max(4, m.tx.length * 0.09));
              if (t >= m.t && t < end) { on = true; break; }
            }
          }
          var h = on ? 6 + r() * 24 : 2;
          out += '<rect class="' + cls + '" x="' + (i * 4) + '" y="' + (y0 + 17 - h / 2).toFixed(1) + '" width="2.4" height="' + h.toFixed(1) + '"/>';
        }
      });
      return out;
    }
    function playerHTML(d) {
      if (!d.seekable) return '<section class="cqa-card"><h3>Запись звонка</h3>' + (d.audio ? '<audio controls preload="none" src="' + esc(d.audio) + '"></audio>' : '<p>Аудиозапись не приложена.</p>') + '<p class="cqa-note">Календарные метки сохранены в транскрипте. Привязка реплик к позиции записи отсутствует.</p></section>';
      return '<section class="cqa-card" aria-label="Запись звонка"><p class="cqa-note">Схема реплик по транскрипту, не аудиограмма.</p><div class="cqa-wave-wrap"><div class="cqa-wave-labels"><span>Клиент</span><span>Оператор</span></div>' +
        '<div class="cqa-wave-box"><svg class="cqa-wave" viewBox="0 0 600 76" preserveAspectRatio="none" aria-hidden="true">' + wave(d) + '</svg>' +
        '<div class="cqa-region" id="cqa-region" hidden></div><div class="cqa-playhead" id="cqa-playhead"></div></div></div>' +
        '<div class="cqa-ctl"><button class="cqa-play" id="cqa-play" data-act="play"' + (d.audio ? '' : ' disabled') + ' aria-label="Воспроизвести">&#9654;</button>' +
        '<span class="cqa-time" id="cqa-time">00:00 / ' + mmss(d.duration) + '</span>' +
        '<input id="cqa-seek" class="cqa-seek" type="range" min="0" max="' + d.duration + '" step="1" value="0" data-seek="1" aria-label="Позиция записи"></div>' +
        (d.audio ? '' : '<p class="cqa-note">Аудиозапись не приложена. Доступен транскрипт.</p>') + '</section>';
    }

    function transcriptHTML(d) {
      return '<section class="cqa-card"><h3>Расшифровка</h3><ol class="cqa-tr" id="cqa-tr">' + d.msgs.map(function (m, i) {
        return '<li class="cqa-msg cqa-msg--' + m.sp + '" data-i="' + i + '">' +
          '<button class="cqa-msg-t" data-act="goto" data-d="' + esc(d.id) + '" data-m="' + i + '" title="' + esc(m.ts) + '">' + esc(m.ts) + '</button>' +
          '<div><span class="cqa-msg-sp">' + SP[m.sp] + '</span><p>' + esc(m.tx) + '</p></div></li>';
      }).join('') + '</ol></section>';
    }

    function ring(total) {
      var C = 2 * Math.PI * 34, p = total == null ? 0 : Math.max(0, Math.min(100, total)) / 100;
      return '<svg class="cqa-ring" viewBox="0 0 88 88" role="img" aria-label="Итог ' + fmt(total) + ' из 100">' +
        '<circle class="cqa-ring-bg" cx="44" cy="44" r="34"/>' +
        '<circle class="cqa-ring-fg ' + tone(total) + '" cx="44" cy="44" r="34" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 44 44)"/>' +
        '<text class="cqa-ring-n" x="44" y="47" text-anchor="middle">' + fmt(total) + '</text>' +
        '<text class="cqa-ring-s" x="44" y="61" text-anchor="middle">из 100</text></svg>';
    }

    function evHTML(d, r) {
      if (r.evidence || r.range) {
        var proof = (r.evidence || []).map(function (i) { return evHTML(d, {ev:{m:i}}); }).join('');
        if (r.range && r.range[0] >= 0 && r.range[1] >= 0) proof += '<button class="cqa-ev" data-act="indices" data-d="' + esc(d.id) + '" data-a="' + r.range[0] + '" data-b="' + r.range[1] + '">Проверенный диапазон: реплики ' + (r.range[0]+1) + '–' + (r.range[1]+1) + '</button>';
        return proof;
      }
      if (!r.ev) return '';
      if (r.ev.m != null) {
        var m = d.msgs[r.ev.m];
        if (!m) return '';
        return '<button class="cqa-ev" data-act="goto" data-d="' + esc(d.id) + '" data-m="' + r.ev.m + '">' +
          '<span class="cqa-ev-t">' + esc(m.ts) + '</span><span class="cqa-ev-q"><b>' + SP[m.sp] + ':</b> «' + esc(m.tx) + '»</span></button>';
      }
      return '<button class="cqa-ev" data-act="range" data-d="' + esc(d.id) + '" data-a="' + r.ev.r[0] + '" data-b="' + r.ev.r[1] + '">' +
        '<span class="cqa-ev-t">' + mmss(r.ev.r[0]) + '–' + mmss(r.ev.r[1]) + '</span><span class="cqa-ev-q">Участок разговора, на котором основан вывод.</span></button>';
    }

    function selectOptions(c, cur) {
      var o = [];
      if (c.gross) { o.push(['1', 'Выявлено']); o.push(['0', 'Не выявлено']); }
      else if (c.type === 'binary') { o.push(['1', 'Да']); o.push(['0', 'Нет']); }
      else { c.steps.forEach(function (s) { o.push([String(s), s + ' из ' + maxOf(c)]); }); }
      if (c.naAllowed) o.push(['na', 'N/A']);
      return o.map(function (p) { return '<option value="' + p[0] + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('');
    }

    function appealBlock(d, x) {
      var c = x.c, key = d.id + '|' + c.id, fid = esc('cqa-f-' + d.id + '-' + c.id), html = '';
      var ap = x.ap;
      if (ap) {
        html += '<div class="cqa-ap ' + (ap.dec ? 'cqa-ap--done' : 'cqa-ap--open') + '"><div><b>Апелляция</b> · ' + esc(fmtAt(ap.at)) + '</div><div>' + esc(ap.comment) + '</div>';
        if (ap.dec) {
          html += '<div><b>' + (ap.dec.kind === 'changed' ? 'Оценка изменена' : 'Оценка подтверждена') + '</b> · ' + esc(fmtAt(ap.dec.at)) + ': ' + esc(ans(c, x.orig)) + ' → ' + esc(ans(c, ap.dec.v)) + '</div><div>Причина: ' + esc(ap.dec.reason) + '</div>';
        } else {
          html += '<div>Ждёт решения проверяющего.</div>';
        }
        html += '</div>';
      }
      if (state.role === 'analyst' && !ap) {
        if (state.form === key) {
          html += '<div class="cqa-form"><label for="' + fid + '">Комментарий к апелляции</label>' +
            '<textarea id="' + fid + '" data-draft="' + esc(key) + '|comment" rows="3">' + esc(state.drafts[key + '|comment'] || '') + '</textarea>' +
            (state.errs[key] ? '<div class="cqa-err">' + esc(state.errs[key]) + '</div>' : '') +
            '<div class="cqa-row"><button class="cqa-btn cqa-btn--primary" data-act="appeal-send" data-d="' + esc(d.id) + '" data-c="' + c.id + '">Отправить</button>' +
            '<button class="cqa-btn" data-act="appeal-cancel">Отмена</button></div></div>';
        } else {
          html += '<div class="cqa-row"><button class="cqa-btn" data-act="appeal-open" data-d="' + esc(d.id) + '" data-c="' + c.id + '">Оспорить оценку</button></div>';
        }
      }
      if (state.role === 'reviewer' && ap && !ap.dec) {
        var cur = state.drafts[key + '|v'] != null ? state.drafts[key + '|v'] : x.orig;
        html += '<div class="cqa-form"><label for="' + fid + '-v">Оценка по критерию</label>' +
          '<select id="' + fid + '-v" data-draft="' + esc(key) + '|v">' + selectOptions(c, cur) + '</select>' +
          '<label for="' + fid + '-r">Причина решения</label>' +
          '<textarea id="' + fid + '-r" data-draft="' + esc(key) + '|reason" rows="3">' + esc(state.drafts[key + '|reason'] || '') + '</textarea>' +
          (state.errs[key] ? '<div class="cqa-err">' + esc(state.errs[key]) + '</div>' : '') +
          '<div class="cqa-row"><button class="cqa-btn cqa-btn--primary" data-act="decide-change" data-d="' + esc(d.id) + '" data-c="' + c.id + '">Изменить на выбранную</button>' +
          '<button class="cqa-btn" data-act="decide-keep" data-d="' + esc(d.id) + '" data-c="' + c.id + '">Подтвердить оценку модели</button></div></div>';
      }
      return html;
    }

    function critHTML(d, x, sc) {
      var c = x.c, p = sc.byRow[c.id], r = x.r;
      var h = '<article class="cqa-crit' + (state.focus === d.id + '|' + c.id ? ' is-focus' : '') + '" data-crit="' + c.id + '">' +
        '<div class="cqa-crit-head"><h4>' + esc(c.title) + '</h4><span class="cqa-w">' + (c.gross ? 'без баллов' : 'вес ' + c.weight) + '</span></div>';
      if (x.pending) {
        h += '<div class="cqa-pending">Для текущей версии чек-листа ещё нет оценки. ' +
          '<button class="cqa-btn" data-act="eval" data-d="' + esc(d.id) + '" data-c="' + c.id + '">Оценить</button></div></article>';
        return h;
      }
      var changed = x.fin !== x.orig;
      h += '<div class="cqa-crit-line"><span class="cqa-chip cqa-chip--' + ctone(c, x.fin) + '">' + ans(c, x.fin) + '</span>' +
        (changed ? '<span class="cqa-was">было: ' + ans(c, x.orig) + '</span>' : '') +
        (c.gross && x.fin === 1 ? '<span class="cqa-tag cqa-tag--bad">Грубая ошибка</span>' : '') +
        (r.stub ? '<span class="cqa-tag">заглушка</span>' : '') +
        '<span class="cqa-pts">' + (c.gross ? 'отмечается отдельно' : p ? fmt(p.pts) + ' из ' + fmt(p.eff) : 'не учитывается в итоге') + '</span></div>';
      if (r.v === 'na') h += '<p class="cqa-why cqa-why--na"><b>Почему N/A.</b> ' + esc(r.na || '') + '</p>';
      else h += '<p class="cqa-why">' + esc(r.why) + '</p>';
      h += evHTML(d, r) + appealBlock(d, x) + '</article>';
      return h;
    }

    function resultHTML(d) {
      var rows = rowsFor(d), fin = score(rows, true), org = score(rows, false);
      var diff = rnd(fin.total) !== rnd(org.total);
      if (rows.some(function (x) { return x.pending; })) fin.total = org.total = null;
      var h = '<section class="cqa-card"><h3>Оценка качества</h3><div class="cqa-sum">' + ring(fin.total) + '<div class="cqa-sum-txt">' +
        '<b>Итог: ' + fmt(fin.total) + ' из 100</b>' +
        (diff ? '<span>Исходная оценка модели: ' + fmt(org.total) + '. Итог пересчитан с учётом решений проверяющего.</span>' : rows.some(function (x) { return x.pending; }) ? '<span>Для этой версии чек-листа нужна новая проверка.</span>' : '<span>Первоначальные ответы модели сохранены.</span>') +
        '<span>Чек-лист: версия ' + state.checklist.version + ', округление до ' + state.checklist.rounding + ' зн. Вес критериев с N/A перераспределён между остальными.</span></div></div>';
      state.checklist.sections.forEach(function (s) {
        var sr = rows.filter(function (x) { return x.c.section === s.id; });
        if (!sr.length) return;
        var t = fin.bySec[s.id];
        h += '<div class="cqa-sec"><div class="cqa-sec-h"><h4>' + esc(s.title) + '</h4><span>' + (t ? fmt(t.pts) + ' / ' + fmt(t.eff) : '—') + '</span></div>' +
          sr.map(function (x) { return critHTML(d, x, fin); }).join('') + '</div>';
      });
      return h + '</section>';
    }

    function detailHTML(d) {
      var rows = rowsFor(d), pend = rows.filter(function (x) { return x.pending; }).length;
      return '<div class="cqa-detail-head"><h3>' + (d.voice ? 'Анализ разговора' : 'Анализ чата') + '</h3><span>' + esc(d.id) + ' · ' +
        (d.voice ? 'звонок' : 'чат') + ' · ' + esc(d.lang) + ' · ' + mmss(d.duration) + '</span></div>' +
        (pend ? '<div class="cqa-warnbar cqa-row">Не оценено критериев: ' + pend + '. <button class="cqa-btn" data-act="eval-dialog" data-d="' + esc(d.id) + '">Оценить диалог</button></div>' : '') +
        (d.voice ? playerHTML(d) : '') +
        '<div class="cqa-split">' + transcriptHTML(d) + resultHTML(d) + '</div>';
    }

    function dialogsView() {
      var head = '<div class="cqa-head"><h2>Диалоги</h2><p>Выберите диалог. Реплика-доказательство в оценке ведёт к нужному месту в расшифровке' +
        (state.role === 'reviewer' ? '. Вы смотрите как проверяющий: у спорных критериев есть форма решения.' : '. Любой критерий можно оспорить.') + '</p></div>';
      if (!state.dialogs.length) return head + '<div class="cqa-empty">В наборе нет диалогов.</div>';
      return head + listHTML() + detailHTML(dlg(state.did));
    }

    function appealsView() {
      var items = [];
      state.dialogs.forEach(function (d) {
        state.checklist.criteria.forEach(function (c) {
          var ap = state.appeals[d.id + '|' + c.id];
          if (ap) items.push({ d: d, c: c, ap: ap });
        });
      });
      var h = '<div class="cqa-head"><h2>Апелляции</h2><p>Спорные оценки. Проверяющий открывает карточку, смотрит фрагмент диалога и принимает решение.</p></div>';
      if (!items.length) return h + '<div class="cqa-empty">Апелляций пока нет. Оспорить оценку можно в карточке диалога.</div>';
      return h + '<div class="cqa-queue">' + items.map(function (it) {
        return '<div class="cqa-q-item"><div><h4>' + esc(it.c.title) + ' · ' + esc(it.d.id) + '</h4><p>' + esc(it.ap.comment) + '</p></div>' +
          '<div class="cqa-row"><span class="cqa-tag ' + (it.ap.dec ? '' : 'cqa-tag--warn') + '">' + (it.ap.dec ? (it.ap.dec.kind === 'changed' ? 'Изменена' : 'Подтверждена') : 'Ждёт решения') + '</span>' +
          '<button class="cqa-btn" data-act="goto-appeal" data-d="' + esc(it.d.id) + '" data-c="' + it.c.id + '">Открыть</button></div></div>';
      }).join('') + '</div>';
    }

    function sig(cl) { return JSON.stringify({ r: cl.rounding, c: cl.criteria }); }
    function updateDirty() {
      var dirty = state.draft && sig(state.draft) !== sig(state.checklist);
      ['ck-save','ck-reset'].forEach(function (act) {
        var button = root.querySelector('[data-act="' + act + '"]'); if (button) button.disabled = !dirty;
      });
    }
    function checklistView() {
      if (!state.draft) state.draft = clone(state.checklist);
      var dr = state.draft, dirty = sig(dr) !== sig(state.checklist);
      var sum = dr.criteria.reduce(function (a, c) { return a + (c.gross ? 0 : Number(c.weight) || 0); }, 0);
      var rows = dr.criteria.map(function (c, i) {
        var opts = state.checklist.sections.map(function (s) { return '<option value="' + s.id + '"' + (c.section === s.id ? ' selected' : '') + '>' + esc(s.title) + '</option>'; }).join('');
        var tv = c.gross ? 'gross' : c.type;
        return '<div class="cqa-ck-row">' +
          '<label class="cqa-fld cqa-fld--grow"><span>Название критерия</span><input class="cqa-in" type="text" value="' + esc(c.title) + '" data-ck="title" data-i="' + i + '"></label>' +
          '<label class="cqa-fld cqa-fld--s"><span>Секция</span><select class="cqa-in" data-ck="section" data-i="' + i + '">' + opts + '</select></label>' +
          '<label class="cqa-fld cqa-fld--s"><span>Тип ответа</span><select class="cqa-in" data-ck="type" data-i="' + i + '"><option value="binary"' + (tv === 'binary' ? ' selected' : '') + '>Да / Нет</option><option value="scale"' + (tv === 'scale' ? ' selected' : '') + '>Шкала</option><option value="gross"' + (tv === 'gross' ? ' selected' : '') + '>Грубая ошибка</option></select></label>' +
          '<label class="cqa-fld cqa-fld--s"><span>Ступени шкалы</span><input class="cqa-in" type="text" value="' + (c.type === 'scale' ? esc((c.steps || []).join(', ')) : '') + '"' + (c.type === 'scale' ? '' : ' disabled') + ' placeholder="20, 15, 10, 5, 0" data-ck="steps" data-i="' + i + '"></label>' +
          '<label class="cqa-fld cqa-fld--xs"><span>Вес</span><input class="cqa-in" type="number" min="0" max="100" value="' + (c.gross ? 0 : c.weight) + '"' + (c.gross ? ' disabled' : '') + ' data-ck="weight" data-i="' + i + '"></label>' +
          '<label class="cqa-fld cqa-fld--chk"><input type="checkbox"' + (c.naAllowed ? ' checked' : '') + (c.gross ? ' disabled' : '') + ' data-ck="na" data-i="' + i + '"><span>Разрешить N/A</span></label>' +
          '<button class="cqa-btn cqa-btn--danger" data-act="ck-del" data-i="' + i + '"' + (dr.criteria.length < 2 ? ' disabled' : '') + '>Удалить</button>' +
          '<label class="cqa-fld cqa-fld--full"><span>Правило оценки (его читает модель)</span><textarea class="cqa-in" rows="2" data-ck="desc" data-i="' + i + '">' + esc(c.desc || '') + '</textarea></label><label class="cqa-fld cqa-fld--full"><span>Условие N/A</span><textarea class="cqa-in" rows="2" data-ck="naRule" data-i="' + i + '">' + esc(c.naRule || '') + '</textarea></label></div>';
      }).join('');
      return '<div class="cqa-head"><h2>Чек-листы</h2><p>Меняйте формулировки, правила, веса и типы ответа. Изменения вступают в силу после сохранения конфигурации. Критерии, у которых изменились название, правило, тип или шкала, ждут повторной оценки.</p></div>' +
        '<div class="cqa-ck">' + rows + '</div>' +
        '<div class="cqa-ck-foot"><div class="cqa-ck-set">' +
        '<button class="cqa-btn" data-act="ck-add">Добавить критерий</button>' +
        '<label class="cqa-fld cqa-fld--s"><span>Округление итога</span><select class="cqa-in" data-ck="rounding"><option value="0"' + (dr.rounding === 0 ? ' selected' : '') + '>до целых</option><option value="1"' + (dr.rounding === 1 ? ' selected' : '') + '>до десятых</option><option value="2"' + (dr.rounding === 2 ? ' selected' : '') + '>до сотых</option></select></label>' +
        '<span id="cqa-wsum" class="cqa-w">Сумма весов: ' + sum + '. Итог приводится к 100.</span></div>' +
        '<div class="cqa-row"><button class="cqa-btn" data-act="ck-reset"' + (dirty ? '' : ' disabled') + '>Отменить правки</button>' +
        '<button class="cqa-btn cqa-btn--primary" data-act="ck-save"' + (dirty ? '' : ' disabled') + '>Сохранить конфигурацию</button>' +
        '<button class="cqa-btn" data-act="ck-apply">Применить к диалогам</button></div></div>' +
        '<p class="cqa-note">Версия ' + state.checklist.version + (dirty ? ', есть несохранённые правки.' : ', сохранена.') + ' «Применить к диалогам» оценивает все критерии без результата (один запрос к модели на диалог).</p>';
    }

    function validateDraft() {
      var dr = state.draft, i, c;
      for (i = 0; i < dr.criteria.length; i++) {
        c = dr.criteria[i];
        if (!String(c.title).trim()) return 'У критерия №' + (i + 1) + ' нет названия';
        if (c.type === 'scale' && !(c.steps && c.steps.length >= 2)) return 'У критерия «' + c.title + '» нужны минимум две ступени шкалы';
      }
      var sum = dr.criteria.reduce(function (a, x) { return a + (x.gross ? 0 : Number(x.weight) || 0); }, 0);
      if (sum <= 0) return 'Сумма весов должна быть больше нуля';
      return '';
    }

    /* --- отрисовка --- */
    function bodyHTML() {
      if (state.loading) return '<div class="cqa-empty">Загрузка данных…</div>';
      if (state.loadErr || !state.checklist) {
        return '<div class="cqa-empty">Не удалось загрузить данные: ' + esc(state.loadErr || 'нет ответа сервера') + '</div>';
      }
      return state.view === 'dialogs' ? dialogsView() : state.view === 'appeals' ? appealsView() : checklistView();
    }
    function render() {
      root.className = 'cqa';
      root.innerHTML = navHTML() + '<main class="cqa-main">' + bodyHTML() +
        (state.toast ? '<div class="cqa-toast" role="status">' + esc(state.toast) + '</div>' : '') + '</main>';
      post();
    }
    function toast(msg, sticky) {
      state.toast = msg;
      var el = root.querySelector('.cqa-toast');
      if (!el) {
        var main = root.querySelector('.cqa-main');
        if (main) { el = document.createElement('div'); el.className = 'cqa-toast'; el.setAttribute('role', 'status'); main.appendChild(el); }
      }
      if (el) el.textContent = msg;
      clearTimeout(toastT);
      if (!sticky) {
        toastT = setTimeout(function () {
          if (state.toast === msg) {
            state.toast = '';
            var t = root.querySelector('.cqa-toast');
            if (t) t.remove();
          }
        }, 3200);
      }
    }
    function post() {
      applyHL();
      updatePlayer();
      if (state.focus) {
        var parts = state.focus.split('|');
        var el = root.querySelector('[data-crit="' + parts[1] + '"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        state.focus = null;
      }
    }

    function applyHL() {
      var d = dlg(state.did);
      var msgs = root.querySelectorAll('.cqa-msg');
      var idxs = state.hl && state.hl.d === state.did ? state.hl.idxs : [];
      Array.prototype.forEach.call(msgs, function (el) {
        el.classList.toggle('cqa-msg--hl', idxs.indexOf(Number(el.getAttribute('data-i'))) >= 0);
      });
      var region = root.querySelector('#cqa-region');
      if (region && d) {
        if (idxs.length) {
          var a = d.msgs[Math.min.apply(null, idxs)].t;
          var lastI = Math.max.apply(null, idxs);
          var b = d.msgs[lastI + 1] ? d.msgs[lastI + 1].t : d.duration;
          region.hidden = false;
          region.style.left = (a / d.duration * 100) + '%';
          region.style.width = ((b - a) / d.duration * 100) + '%';
        } else {
          region.hidden = true;
        }
      }
      var list = root.querySelector('#cqa-tr');
      if (list && idxs.length) {
        var target = list.querySelector('[data-i="' + Math.min.apply(null, idxs) + '"]');
        if (target) list.scrollTop = Math.max(0, target.offsetTop - list.clientHeight / 3);
      }
    }
    function updatePlayer() {
      var d = dlg(state.did);
      if (!d || !d.voice) return;
      var time = root.querySelector('#cqa-time');
      if (!time) return;
      time.textContent = mmss(state.t) + ' / ' + mmss(d.duration);
      var seek = root.querySelector('#cqa-seek');
      if (seek) seek.value = state.t;
      var head = root.querySelector('#cqa-playhead');
      if (head) head.style.left = Math.min(100, state.t / d.duration * 100) + '%';
      var play = root.querySelector('#cqa-play');
      if (play) {
        play.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
        play.setAttribute('aria-label', state.playing ? 'Пауза' : 'Воспроизвести');
      }
      var now = -1;
      d.msgs.forEach(function (m, i) { if (m.t <= state.t) now = i; });
      Array.prototype.forEach.call(root.querySelectorAll('.cqa-msg'), function (el) {
        el.classList.toggle('cqa-msg--now', state.playing && Number(el.getAttribute('data-i')) === now);
      });
    }
    var timer = setInterval(function () {
      var d = dlg(state.did);
      if (!state.playing || !d) return;
      if (audio) { state.t = audio.currentTime; if (audio.ended) state.playing = false; }
      else {
        state.t += 0.25;
        if (state.t >= d.duration) { state.t = d.duration; state.playing = false; }
      }
      updatePlayer();
    }, 250);

    /* --- оценка --- */
    function runEval(d, ids) {
      if (state.busy || !ids.length) return;
      state.busy = true; toast('Оцениваю…', true);
      evalDialog(d, ids).then(function (res) {
        var n = Object.keys(res.errors || {}).length;
        toast(n ? 'Готово, но критериев с ошибкой модели: ' + n + '. Повторите оценку.' : 'Оценка готова.');
      }).catch(function (e) { toast('Ошибка: ' + e.message); }).then(function () { state.busy = false; render(); });
    }

    /* --- события --- */
    root.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el || !root.contains(el)) return;
      var a = el.getAttribute('data-act'), ds = el.getAttribute('data-d'), cid = el.getAttribute('data-c');
      var d = ds ? dlg(ds) : null;

      if (state.busy && ['load-group','ck-save','ck-apply','eval','eval-dialog','appeal-send','decide-change','decide-keep'].indexOf(a) >= 0) { toast('Дождитесь завершения текущей проверки. Задача сохранена на сервере.'); return; }
      if (a === 'view') {
        state.view = el.getAttribute('data-v');
        if (state.view === 'checklist' && !state.draft && state.checklist) state.draft = clone(state.checklist);
        render();
      } else if (a === 'load-group') {
        var inp = root.querySelector('#cqa-group');
        load(inp ? inp.value.trim() : '');
      } else if (a === 'role') {
        state.role = el.getAttribute('data-r'); state.form = null; render();
      } else if (a === 'open') {
        state.did = el.getAttribute('data-id'); state.t = 0; state.playing = false; state.hl = null; state.form = null;
        setAudio(dlg(state.did)); render();
      } else if (a === 'goto' || a === 'range' || a === 'indices') {
        var idxs = [], t0 = 0;
        if (a === 'goto') { var mi = Number(el.getAttribute('data-m')); idxs = [mi]; t0 = d.msgs[mi].t; }
        else if (a === 'indices') {
          var first = Number(el.getAttribute('data-a')), last = Number(el.getAttribute('data-b')); t0 = d.msgs[first].t;
          for (var ix = first; ix <= last; ix++) idxs.push(ix);
        } else {
          var lo = Number(el.getAttribute('data-a')), hi = Number(el.getAttribute('data-b')); t0 = lo;
          d.msgs.forEach(function (m, i) { if (m.t >= lo && m.t <= hi) idxs.push(i); });
        }
        state.hl = { d: d.id, idxs: idxs };
        if (d.voice && d.seekable) seekTo(t0);
        applyHL(); updatePlayer();
      } else if (a === 'play') {
        var cur = dlg(state.did);
        if (!cur || !audio) return;
        if (state.playing) {
          state.playing = false;
          if (audio) audio.pause();
        } else {
          if (state.t >= cur.duration - 0.3) seekTo(0);
          state.playing = true;
          if (audio) {
            audio.currentTime = state.t;
            audio.play().catch(function () {
              state.playing = false;
              toast('Не удалось воспроизвести запись. Проверьте доступность аудиофайла.');
              updatePlayer();
            });
          }
        }
        updatePlayer();
      } else if (a === 'appeal-open') {
        state.form = ds + '|' + cid; render();
      } else if (a === 'appeal-cancel') {
        state.form = null; render();
      } else if (a === 'appeal-send') {
        var key = ds + '|' + cid, text = (state.drafts[key + '|comment'] || '').trim();
        if (!text) { state.errs[key] = 'Опишите, с чем вы не согласны.'; render(); return; }
        state.errs[key] = '';
        api('POST', '/api/appeals', { dialogId: ds, criterionId: cid, comment: text, evaluationId: state.results[ds][cid].evaluationId }).then(function (ap) {
          state.appeals[key] = ap; state.form = null; delete state.drafts[key + '|comment'];
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
        }
        state.errs[k2] = '';
        api('POST', '/api/appeals/decide', { dialogId: ds, criterionId: cid, v: nv, reason: reason, appealId: state.appeals[k2].id }).then(function (ap) {
          state.appeals[k2] = ap; delete state.drafts[k2 + '|reason']; delete state.drafts[k2 + '|v'];
          toast('Решение сохранено, итог пересчитан.'); render();
        }).catch(function (err) { state.errs[k2] = err.message; render(); });
      } else if (a === 'goto-appeal') {
        state.view = 'dialogs'; state.did = ds; state.t = 0; state.playing = false; state.hl = null; state.focus = ds + '|' + cid;
        setAudio(dlg(ds)); render();
      } else if (a === 'eval') {
        runEval(d, [cid]);
      } else if (a === 'eval-dialog') {
        runEval(d, rowsFor(d).filter(function (x) { return x.pending; }).map(function (x) { return x.c.id; }));
      } else if (a === 'ck-add') {
        state.draft.criteria.push({ id: 'c' + Date.now().toString(36), section: state.checklist.sections[0].id, title: 'Новый критерий', desc: '', weight: 5, type: 'binary', naAllowed: false });
        render();
      } else if (a === 'ck-del') {
        state.draft.criteria.splice(Number(el.getAttribute('data-i')), 1); render();
      } else if (a === 'ck-reset') {
        state.draft = clone(state.checklist); render();
      } else if (a === 'ck-save') {
        var err = validateDraft();
        if (err) { toast(err); return; }
        api('PUT', '/api/checklist', state.draft).then(function (cl) {
          state.checklist = cl; state.draft = clone(cl); state.results = {}; state.appeals = {};
          var pend = 0;
          state.dialogs.forEach(function (x) { pend += rowsFor(x).filter(function (r) { return r.pending; }).length; });
          toast('Конфигурация сохранена, версия ' + cl.version + (pend ? '. Критериев без оценки: ' + pend : '.')); render();
        }).catch(function (e2) { toast('Ошибка: ' + e2.message); });
      } else if (a === 'ck-apply') {
        if (state.busy) return;
        var jobs = [];
        state.dialogs.forEach(function (x) {
          var ids = rowsFor(x).filter(function (r) { return r.pending; }).map(function (r) { return r.c.id; });
          if (ids.length) jobs.push({ d: x, ids: ids });
        });
        if (!jobs.length) { toast('Все критерии уже оценены.'); return; }
        state.busy = true;
        toast('Оценка: 0 из ' + jobs.length + ' диалогов', true);
        api('POST', '/api/batch', {dialogIds:jobs.map(function (j) { return j.d.id; }),hashes:Object.fromEntries(jobs.map(function (j) { return [j.d.id,j.d.hash]; }))}).then(function (data) {
          replaceDialogs(data.dialogs); state.results = data.results; state.appeals = data.appeals;
          toast('Проверка завершена. Диалогов: ' + jobs.length + ', ошибок: ' + data.errors.length + '.');
        }).catch(function (error) { toast(error.message); }).finally(function () { state.busy = false; render(); });
      }
    });

    root.addEventListener('keydown', function (e) {
      if (!state.busy && e.key === 'Enter' && e.target.id === 'cqa-group') load(e.target.value.trim());
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.getAttribute('data-draft')) { state.drafts[t.getAttribute('data-draft')] = t.value; return; }
      if (t.getAttribute('data-seek')) { seekTo(Number(t.value)); updatePlayer(); return; }
      var f = t.getAttribute('data-ck');
      if (f === 'title' || f === 'desc' || f === 'naRule' || f === 'weight' || f === 'steps') {
        var c = state.draft.criteria[Number(t.getAttribute('data-i'))];
        if (f === 'title') c.title = t.value;
        if (f === 'desc') c.desc = t.value;
        if (f === 'naRule') c.naRule = t.value;
        if (f === 'weight') c.weight = Math.max(0, Number(t.value) || 0);
        if (f === 'steps') { var st = parseSteps(t.value); if (st) c.steps = st; }
        updateDirty();
        var w = root.querySelector('#cqa-wsum');
        if (w) w.textContent = 'Сумма весов: ' + state.draft.criteria.reduce(function (a, x) { return a + (x.gross ? 0 : Number(x.weight) || 0); }, 0) + '. Итог приводится к 100.';
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute('data-draft')) { state.drafts[t.getAttribute('data-draft')] = t.value; return; }
      var f = t.getAttribute('data-ck');
      if (!f) return;
      if (f === 'rounding') { state.draft.rounding = Number(t.value); render(); return; }
      var c = state.draft.criteria[Number(t.getAttribute('data-i'))];
      if (f === 'section') c.section = t.value;
      if (f === 'type') {
        if (t.value === 'gross') { c.type = 'binary'; c.gross = true; c.weight = 0; c.naAllowed = false; delete c.steps; }
        else {
          if (c.gross) { c.gross = false; c.weight = 5; }
          c.type = t.value;
          if (c.type === 'scale') c.steps = c.steps && c.steps.length >= 2 ? c.steps : [5, 4, 3, 2, 1, 0]; else delete c.steps;
        }
      }
      if (f === 'na') c.naAllowed = t.checked;
      if (f === 'title' || f === 'desc' || f === 'naRule' || f === 'weight') return;
      render();
    });

    var polling = false;
    var jobsTimer = setInterval(function () {
      if (polling || state.busy || !state.jobs || !state.jobs.length || root.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
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
