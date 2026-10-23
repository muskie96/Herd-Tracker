/* Herd Tracker — phone app (works on Android + iPhone as an installed web app).
   Data lives in the Google Sheet; this phone keeps a copy so the app works without signal.
   Changes made without signal wait in a queue and are sent automatically when signal returns. */
(function () {
  'use strict';

  // ==========================================================================
  // Constants
  // ==========================================================================
  var CFG = window.HERD_CONFIG || {};
  var API_URL = CFG.API_URL || '';
  var VERSION = CFG.APP_VERSION || '1.0.0';
  var TABLES = ['Animals', 'Breedings', 'Calvings', 'Orders'];
  var GESTATION_DAYS = 283;
  var DUE_SOON_DAYS = 60;
  var STATUSES = ['In herd', 'Ready for harvest', 'Harvested', 'Deceased'];
  var ACTIVE = ['In herd', 'Ready for harvest'];
  var SEXES = ['Cow', 'Heifer', 'Bull', 'Steer'];
  var FEMALES = ['Cow', 'Heifer'];
  var SHARE_HEAD = { Whole: 1, Half: 0.5, Quarter: 0.25 };
  var COMMON_BREEDS = ['Angus', 'Black Angus', 'Red Angus', 'Hereford', 'Black Baldy', 'Charolais',
    'Simmental', 'Limousin', 'Shorthorn', 'Gelbvieh', 'Brahman', 'Highland', 'Wagyu', 'Holstein', 'Jersey'];

  // ==========================================================================
  // Tiny IndexedDB key/value store (holds the herd copy, the unsent queue, photos)
  // ==========================================================================
  var idb = (function () {
    var dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise(function (resolve, reject) {
          var r = indexedDB.open('herd-tracker', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { reject(r.error); };
        });
      }
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('kv', mode);
          var req = fn(t.objectStore('kv'));
          t.oncomplete = function () { resolve(req ? req.result : undefined); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
      set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
      del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); }
    };
  })();

  // ==========================================================================
  // State
  // ==========================================================================
  function emptyDb() { return { Animals: [], Breedings: [], Calvings: [], Orders: [] }; }

  var S = {
    db: emptyDb(),
    queue: [],
    lastSync: '',
    who: ls('herd.who'),
    passcode: ls('herd.passcode'),
    syncing: false,
    offline: false,
    lastError: '',
    authFailed: false
  };
  var UI = { search: '', sex: 'All', status: '', breedTab: 'due', salesTab: 'waiting' };
  var formPhoto = null;      // base64 jpeg picked in the add/edit animal form
  var currentKey = null;
  var currentIsForm = false;

  function ls(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }

  function loadState() {
    return idb.get('state').then(function (st) {
      if (st) {
        S.db = Object.assign(emptyDb(), st.db || {});
        S.queue = st.queue || [];
        S.lastSync = st.lastSync || '';
      }
    });
  }
  function persist() {
    return idb.set('state', { db: S.db, queue: S.queue, lastSync: S.lastSync }).catch(function () {});
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ==========================================================================
  // Server calls
  // ==========================================================================
  function api(action, payload) {
    if (!API_URL) return Promise.reject(new Error('The app is missing its server address (config.js).'));
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, action === 'uploadPhoto' ? 60000 : 25000);
    var body = Object.assign({ action: action, passcode: S.passcode, who: S.who }, payload || {});
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () {
        var err = new Error('The server sent back something unexpected. Try again in a minute.');
        err.offline = !res.ok;
        throw err;
      });
    }, function () {
      clearTimeout(timer);
      var err = new Error('No connection');
      err.offline = true;
      throw err;
    }).then(function (data) {
      if (!data.ok) {
        var err = new Error(data.error || 'Server error');
        err.code = data.code;
        throw err;
      }
      return data;
    });
  }

  // ==========================================================================
  // Local changes + sync queue
  // ==========================================================================
  function clean(row) {
    var o = {};
    Object.keys(row).forEach(function (k) {
      o[k] = row[k] === null || row[k] === undefined ? '' : String(row[k]).trim();
    });
    return o;
  }

  function applyLocal(c) {
    if (c.kind === 'photo') return;
    var list = S.db[c.table];
    if (!list) return;
    if (c.op === 'delete') {
      S.db[c.table] = list.filter(function (r) { return r.id !== c.row.id; });
      return;
    }
    var now = new Date().toISOString();
    var i = list.findIndex(function (r) { return r.id === c.row.id; });
    if (i >= 0) list[i] = Object.assign({}, list[i], c.row, { updated_at: now, updated_by: S.who });
    else list.push(Object.assign({ created_at: now }, c.row, { updated_at: now, updated_by: S.who }));
  }

  /** Apply changes on this phone right away, queue them for the Sheet, then try to send. */
  function commit(changes, opts) {
    opts = opts || {};
    changes.forEach(function (c) { if (c.row) c.row = clean(c.row); applyLocal(c); });
    changes.forEach(function (c) { c.qid = uuid(); S.queue.push(c); });
    return persist().then(function () {
      if (opts.go) location.replace(opts.go);
      else render();
      return trySync();
    }).then(function () {
      if (S.queue.length && !S.offline) return trySync();
    }).then(function () {
      toast(S.queue.length ? 'Saved on this phone — will sync when you have signal' : (opts.msg || 'Saved'));
    });
  }

  var syncPromise = null;
  function trySync() {
    if (!S.passcode) return Promise.resolve(false);
    if (syncPromise) return syncPromise;
    var ok = false;
    S.syncing = true;
    renderStatus();
    syncPromise = flushQueue().then(function () {
      return api('pull');
    }).then(function (res) {
      S.db = Object.assign(emptyDb(), res.data || {});
      S.queue.forEach(applyLocal);          // anything queued while we were pulling
      S.lastSync = new Date().toISOString();
      S.offline = false;
      S.lastError = '';
      ok = true;
      return persist();
    }).catch(function (e) {
      S.offline = !!e.offline;
      S.lastError = e.offline ? '' : e.message;
      if (e.code === 'AUTH') {
        S.authFailed = true;
        S.passcode = '';
        lsSet('herd.passcode', '');
      }
    }).then(function () {
      S.syncing = false;
      syncPromise = null;
      if (S.authFailed) render(); else refreshView();
      if (ok && S.queue.length) setTimeout(trySync, 0);
      return ok;
    });
    return syncPromise;
  }

  function flushQueue() {
    if (!S.queue.length) return Promise.resolve();
    var first = S.queue[0];

    if (first.kind === 'photo') {
      return idb.get('photo:' + first.localId).then(function (blob) {
        if (!blob) { S.queue.shift(); return persist(); }   // photo vanished; skip it
        return api('uploadPhoto', {
          base64: blob.base64, mimeType: blob.mime || 'image/jpeg',
          name: first.name || 'photo', replace_id: first.replaceId || ''
        }).then(function (res) {
          var realId = res.photo_id;
          return idb.set('photo:' + realId, blob).then(function () {
            idb.del('photo:' + first.localId).catch(function () {});
            if (photoMem.has(first.localId)) photoMem.set(realId, photoMem.get(first.localId));
            S.queue.slice(1).forEach(function (c) {
              if (c.row && c.row.photo_id === first.localId) c.row.photo_id = realId;
              if (c.kind === 'photo' && c.replaceId === first.localId) c.replaceId = realId;
            });
            S.db.Animals.forEach(function (a) { if (a.photo_id === first.localId) a.photo_id = realId; });
            S.queue.shift();
            return persist();
          });
        });
      }).then(flushQueue);
    }

    var n = 0;
    while (n < S.queue.length && S.queue[n].kind !== 'photo' && n < 40) n++;
    var batch = S.queue.slice(0, n);
    return api('save', {
      changes: batch.map(function (c) { return { table: c.table, op: c.op, row: c.row }; })
    }).then(function () {
      var sent = {};
      batch.forEach(function (c) { sent[c.qid] = true; });
      S.queue = S.queue.filter(function (c) { return !sent[c.qid]; });
      return persist();
    }).then(flushQueue);
  }

  // ==========================================================================
  // Photos — resized on the phone, kept private in Drive, cached on the phone
  // ==========================================================================
  var photoMem = new Map();
  var active = 0, waiting = [];
  function limit(fn) {
    return new Promise(function (resolve, reject) {
      function run() {
        active++;
        fn().then(resolve, reject).then(function () {
          active--;
          if (waiting.length) waiting.shift()();
        });
      }
      if (active < 2) run(); else waiting.push(run);
    });
  }

  function photoUrl(id) {
    if (!id) return Promise.resolve('');
    if (photoMem.has(id)) return Promise.resolve(photoMem.get(id));
    return idb.get('photo:' + id).then(function (p) {
      if (p) return p;
      if (id.indexOf('local-') === 0 || !S.passcode) return null;
      return limit(function () { return api('getPhoto', { photo_id: id }); }).then(function (r) {
        var obj = { base64: r.base64, mime: r.mimeType || 'image/jpeg' };
        idb.set('photo:' + id, obj).catch(function () {});
        return obj;
      }, function () { return null; });
    }).then(function (p) {
      if (!p) return '';
      var url = 'data:' + (p.mime || 'image/jpeg') + ';base64,' + p.base64;
      photoMem.set(id, url);
      return url;
    }).catch(function () { return ''; });
  }

  function hydratePhotos() {
    document.querySelectorAll('[data-photo]:not([data-loaded])').forEach(function (el) {
      el.setAttribute('data-loaded', '1');
      photoUrl(el.getAttribute('data-photo')).then(function (url) {
        if (!url || !el.isConnected) return;
        var img = new Image();
        img.alt = '';
        img.src = url;
        el.appendChild(img);
        el.classList.add('has-img');
      });
    });
  }

  function resizeImage(file, max, quality) {
    max = max || 1280; quality = quality || 0.8;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * s); h = Math.round(h * s);
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Couldn't read that photo. Try another one.")); };
      img.src = url;
    });
  }

  // ==========================================================================
  // Helpers: text, dates, lookups
  // ==========================================================================
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(table, id) { return id ? S.db[table].find(function (r) { return r.id === id; }) : null; }
  function st(a) { return (a && a.status) || 'In herd'; }
  function isActive(a) { return ACTIVE.indexOf(st(a)) >= 0; }
  function isFemale(a) { return FEMALES.indexOf(a.sex) >= 0; }
  function dispName(a) { return a ? (a.name || ('Tag ' + (a.tag || '?'))) : 'Unknown'; }
  function tagName(a) { return a ? ((a.tag || '—') + (a.name ? ' · ' + a.name : '')) : 'Unknown'; }
  function byTag(x, y) { return String(x.tag || '').localeCompare(String(y.tag || ''), undefined, { numeric: true, sensitivity: 'base' }); }

  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function today() { return iso(new Date()); }
  function parseD(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(s, n) { var d = parseD(s); if (!d) return ''; d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) {
    var x = parseD(a), y = parseD(b);
    if (!x || !y) return null;
    return Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 86400000);
  }
  function fmtDate(s, forceYear) {
    var d = parseD(s);
    if (!d) return '—';
    var withYear = forceYear || d.getFullYear() !== new Date().getFullYear();
    return d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  }
  function fmtMonth(s) { var d = parseD(s); return d ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'; }
  function localDateOf(isoStamp) { var d = new Date(isoStamp); return isNaN(d) ? '' : iso(d); }
  function monthsOld(birth) {
    var b = parseD(birth);
    if (!b) return null;
    var n = new Date();
    var m = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
    if (n.getDate() < b.getDate()) m--;
    return m;
  }
  function ageText(birth, short) {
    var m = monthsOld(birth);
    if (m === null) return '';
    if (m < 1) { var d = daysBetween(birth, today()); return d + (d === 1 ? ' day' : ' days'); }
    if (m < 24) return m + ' mo';
    var y = Math.floor(m / 12), r = m % 12;
    return short || !r ? y + ' yrs' : y + ' yrs ' + r + ' mo';
  }
  function isCalf(a) { var m = monthsOld(a.birth_date); return m !== null && m < 12; }
  function relTime(isoStamp) {
    if (!isoStamp) return 'never';
    var s = (Date.now() - new Date(isoStamp).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    return fmtDate(localDateOf(isoStamp));
  }
  function fmtHead(x) {
    var q = Math.round(x * 4) / 4;
    var whole = Math.floor(q), frac = q - whole;
    var f = frac === 0.25 ? '¼' : frac === 0.5 ? '½' : frac === 0.75 ? '¾' : '';
    if (!whole && f) return f;
    return whole + f;
  }

  function expected(b) { return b.expected_calving || addDays(b.bred_date, GESTATION_DAYS); }
  function pendingBreedings() { return S.db.Breedings.filter(function (b) { return (b.result || 'Pending') === 'Pending'; }); }
  function pendingFor(cowId) {
    return pendingBreedings().filter(function (b) { return b.cow_id === cowId; })
      .sort(function (x, y) { return String(y.bred_date).localeCompare(String(x.bred_date)); })[0] || null;
  }
  function bullLabel(b) {
    if (b.method === 'AI') return 'AI';
    var bull = byId('Animals', b.bull_id);
    return bull ? dispName(bull) + (bull.tag ? ' (' + bull.tag + ')' : '') : 'unknown bull';
  }
  function bulls() { return S.db.Animals.filter(function (a) { return a.sex === 'Bull'; }); }
  function orderHead(o) { return (SHARE_HEAD[o.share] || 0) * (parseFloat(o.quantity) || 1); }
  function shareLabel(o) { var q = parseFloat(o.quantity) || 1; return (o.share || '—') + (q > 1 ? ' ×' + q : ''); }
  function claimedOn(animalId, exceptOrderId) {
    return S.db.Orders.filter(function (o) {
      return o.assigned_animal_id === animalId && o.id !== exceptOrderId && (o.status === 'Assigned' || o.status === 'Filled');
    }).reduce(function (sum, o) { return sum + orderHead(o); }, 0);
  }
  function relatedness(cowId, bullId) {
    var cow = byId('Animals', cowId), bull = byId('Animals', bullId);
    if (!cow || !bull) return '';
    var dn = dispName(bull), cn = dispName(cow);
    if (cow.sire_id === bull.id) return dn + ' is ' + cn + "'s sire (father).";
    if (bull.dam_id === cow.id) return cn + ' is ' + dn + "'s dam (mother).";
    if (cow.sire_id && cow.sire_id === bull.sire_id) return 'They share a sire — half siblings.';
    if (cow.dam_id && cow.dam_id === bull.dam_id) return 'They share a dam — half siblings.';
    var dam = byId('Animals', cow.dam_id);
    if (dam && dam.sire_id === bull.id) return dn + ' is ' + cn + "'s grandsire.";
    var sire = byId('Animals', cow.sire_id);
    if (sire && sire.sire_id === bull.id) return dn + ' is ' + cn + "'s grandsire.";
    return '';
  }

  // ==========================================================================
  // Icons (inline, stroke style)
  // ==========================================================================
  function svg(paths, sw) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.8) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var I = {
    herd: svg('<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    cal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
    bull: svg('<path d="M3 5c0 4 2 6 5 6M21 5c0 4-2 6-5 6"/><path d="M8 9h8v6a4 4 0 0 1-8 0z"/>'),
    sales: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
    add: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 2.2),
    camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', 2),
    check: svg('<path d="M5 12l5 5 9-10"/>', 2.5),
    back: svg('<path d="M15 5l-7 7 7 7"/>', 2),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    cloudOff: svg('<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 1 8.8"/><path d="M3 3l18 18"/>'),
    sync: svg('<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>', 2),
    phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
    text: svg('<path d="M4 5h16v11H8l-4 4z"/>'),
    warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 2),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 2),
    link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>')
  };

  // ==========================================================================
  // Shared pieces
  // ==========================================================================
  function earTag(tag, size) {
    var t = String(tag || '?');
    return '<span class="tag ' + (size || '') + (t.length > 3 ? ' long' : '') + '">' + esc(t) + '</span>';
  }
  function thumb(a) {
    return '<span class="thumb"><span class="ph"' + (a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' +
      I.camera + '</span>' + earTag(a.tag, 'sm') + '</span>';
  }
  function statusPill(s) {
    var m = { 'In herd': ['p-herd', 'In herd'], 'Ready for harvest': ['p-ready', 'Ready'], 'Harvested': ['p-harv', 'Harvested'], 'Deceased': ['p-dead', 'Deceased'] }[s] || ['p-harv', s || '—'];
    return '<span class="pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function sharePill(o) {
    var cls = { Whole: 'p-whole', Half: 'p-half', Quarter: 'p-quarter' }[o.share] || 'p-harv';
    return '<span class="pill ' + cls + '">' + esc(shareLabel(o)) + '</span>';
  }
  function animalSub(a) {
    var parts = [];
    if (a.breed) parts.push(a.breed);
    parts.push((a.sex || '—') + (isCalf(a) && a.sex !== 'Bull' ? ' calf' : ''));
    var age = ageText(a.birth_date, true);
    if (age) parts.push(age);
    return parts.join(' · ');
  }
  function animalRow(a) {
    return '<a class="row" href="#/animal/' + esc(a.id) + '">' + thumb(a) +
      '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
      '<span class="row-sub">' + esc(animalSub(a)) + '</span></span>' + statusPill(st(a)) + '</a>';
  }

  function nav(active) {
    var items = [['herd', '#/herd', 'Herd', I.herd], ['breeding', '#/breeding', 'Breeding', I.cal],
      ['bulls', '#/bulls', 'Bulls', I.bull], ['sales', '#/sales', 'Sales', I.sales], ['add', '#/add', 'Add', I.add]];
    return '<nav class="nav" aria-label="Main">' + items.map(function (it) {
      return '<a href="' + it[1] + '"' + (it[0] === active ? ' class="on" aria-current="page"' : '') + '>' + it[3] + it[2] + '</a>';
    }).join('') + '</nav>';
  }

  function bannerHTML() {
    if (S.queue.length) {
      var n = S.queue.filter(function (c) { return c.kind !== 'photo'; }).length || S.queue.length;
      return '<div class="banner" role="status">' + I.cloudOff +
        '<span><strong>' + n + (n === 1 ? ' change' : ' changes') + ' not saved yet.</strong> ' +
        (S.syncing ? 'Saving now…' : 'Kept on this phone — they’ll save when you have signal.') + '</span>' +
        (S.syncing ? '' : '<button type="button" class="btn" data-action="sync">Retry</button>') + '</div>';
    }
    if (S.lastError) {
      return '<div class="banner err" role="status">' + I.warn + '<span><strong>Couldn’t sync.</strong> ' + esc(S.lastError) +
        '</span><button type="button" class="btn" data-action="sync">Retry</button></div>';
    }
    return '';
  }
  function syncIndHTML() {
    if (S.syncing) return I.sync + 'Syncing…';
    if (S.queue.length || S.offline) return I.cloudOff + 'Offline';
    if (S.lastSync) return I.check + 'Synced · ' + relTime(S.lastSync);
    return '';
  }
  function renderStatus() {
    var b = document.getElementById('sync-banner');
    if (b) b.innerHTML = bannerHTML();
    var ind = document.getElementById('sync-ind');
    if (ind) ind.innerHTML = syncIndHTML();
    var sp = document.getElementById('settings-sync');
    if (sp) sp.innerHTML = settingsSyncHTML();
  }

  function formHeader(title, formId, cancelHref) {
    return '<header class="form-hdr"><a class="link-btn left" href="' + cancelHref + '" data-action="cancel">Cancel</a>' +
      '<h1 class="h2">' + esc(title) + '</h1>' +
      '<button type="submit" form="' + formId + '" class="btn btn-accent btn-pill btn-sm right">Save</button></header>';
  }
  function opts(name, values, selected, labels) {
    return values.map(function (v, i) {
      return '<label class="opt"><input type="radio" name="' + name + '" value="' + esc(v) + '"' + (v === selected ? ' checked' : '') +
        '><span>' + esc(labels ? labels[i] : v) + '</span></label>';
    }).join('');
  }
  function selectOpts(list, selected, emptyLabel) {
    var html = emptyLabel !== undefined ? '<option value="">' + esc(emptyLabel) + '</option>' : '';
    return html + list.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.value === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  // ==========================================================================
  // Screen: setup (first launch / wrong passcode)
  // ==========================================================================
  function viewSetup() {
    return '<div class="setup"><form class="setup-inner" data-form="setup" novalidate>' +
      '<div>' + earTag('HT', 'lg') + '</div>' +
      '<div><h1 class="h1">Herd Tracker</h1></div>' +
      (S.authFailed
        ? '<p>The farm passcode was changed. Enter the new one to keep going — nothing on this phone was lost.</p>'
        : '<p>Connect this phone to the farm’s Google Sheet. You only do this once per phone.</p>') +
      '<label class="field"><span class="lbl">Who’s using this phone?</span>' +
      '<input class="inp" name="who" autocomplete="name" placeholder="e.g. Jordan" value="' + esc(S.who) + '" required></label>' +
      '<label class="field"><span class="lbl">Farm passcode</span>' +
      '<input class="inp" name="passcode" type="password" autocomplete="current-password" required>' +
      '<span class="hint">The passcode you set in the Google Sheet’s script.</span></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button class="btn btn-accent btn-block" type="submit">Connect</button></form></div>';
  }

  // ==========================================================================
  // Screen: herd list
  // ==========================================================================
  function herdPool() {
    var set = UI.status ? [UI.status] : ACTIVE;
    return S.db.Animals.filter(function (a) { return set.indexOf(st(a)) >= 0; });
  }
  function sexMatch(a, chip) {
    if (chip === 'All') return true;
    if (chip === 'Calves') return isCalf(a);
    return a.sex === { Cows: 'Cow', Heifers: 'Heifer', Bulls: 'Bull', Steers: 'Steer' }[chip];
  }
  function herdListHTML() {
    var q = UI.search.trim().toLowerCase();
    var list = herdPool().filter(function (a) { return sexMatch(a, UI.sex); }).filter(function (a) {
      if (!q) return true;
      return [a.tag, a.name, a.breed].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    }).sort(byTag);
    if (!S.db.Animals.length) {
      return '<div class="empty"><b>No animals yet</b>Add your first cow, or paste ear tags into the Animals tab of the Sheet.' +
        '<a class="btn btn-accent" href="#/add">' + I.plus + 'Add an animal</a></div>';
    }
    if (!list.length) return '<div class="empty"><b>No matches</b>Try a different search or filter.</div>';
    return list.map(animalRow).join('');
  }
  function viewHerd() {
    var all = S.db.Animals;
    var counts = {};
    STATUSES.forEach(function (s) { counts[s] = all.filter(function (a) { return st(a) === s; }).length; });
    var tiles = [['In herd', 'In herd', ''], ['Ready for harvest', 'Ready', ' ready'], ['Harvested', 'Harvested', ''], ['Deceased', 'Deceased', '']];
    var pool = herdPool();
    var chips = ['All', 'Cows', 'Heifers', 'Bulls', 'Steers', 'Calves'];
    var note = UI.status
      ? 'Showing ' + UI.status.toLowerCase() + ' · tap the box again to go back'
      : 'Showing animals in the herd and ready for harvest';
    return '<div class="screen">' +
      '<header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">Herd Tracker</span><h1 class="h1">The Herd</h1></div>' +
      '<div class="hdr-side"><a class="icon-btn" href="#/settings" aria-label="Settings">' + I.gear + '</a>' +
      '<span class="sync-ind" id="sync-ind">' + syncIndHTML() + '</span></div></div>' +
      '<div class="stats">' + tiles.map(function (t) {
        return '<button type="button" class="stat' + t[2] + (UI.status === t[0] ? ' on' : '') + '" data-action="status-filter" data-v="' + esc(t[0]) +
          '" aria-pressed="' + (UI.status === t[0]) + '"><b>' + counts[t[0]] + '</b><span>' + t[1] + '</span></button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' +
      '<label class="search">' + I.search + '<input id="herd-search" type="search" placeholder="Search tag, name or breed" aria-label="Search herd" value="' + esc(UI.search) + '"></label>' +
      '<div class="chips" role="group" aria-label="Filter by type">' + chips.map(function (c) {
        var n = pool.filter(function (a) { return sexMatch(a, c); }).length;
        return '<button type="button" class="chip' + (UI.sex === c ? ' on' : '') + '" data-action="sex-filter" data-v="' + c + '">' + c + (c === 'All' || UI.sex === c ? ' ' + n : '') + '</button>';
      }).join('') + '</div>' +
      '<span class="list-note">' + esc(note) + '</span>' +
      '<div class="list" id="herd-list">' + herdListHTML() + '</div></div>' + nav('herd') + '</div>';
  }

  // ==========================================================================
  // Screen: animal profile
  // ==========================================================================
  function viewAnimal(id) {
    var a = byId('Animals', id);
    if (!a) return viewNotFound('That animal isn’t here anymore.');
    var female = isFemale(a);
    var dam = byId('Animals', a.dam_id), sire = byId('Animals', a.sire_id);
    var offspring = S.db.Animals.filter(function (x) { return x.dam_id === a.id || x.sire_id === a.id; })
      .sort(function (x, y) { return String(y.birth_date).localeCompare(String(x.birth_date)); });
    var statusCls = { 'In herd': 's-herd', 'Ready for harvest': 's-ready', 'Harvested': 's-harv', 'Deceased': 's-dead' };

    var html = '<div class="screen">' +
      '<div class="hero"><div class="ph"' + (a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' + I.camera +
      '<span class="ph-label">No photo yet</span></div>' +
      '<div class="hero-btns"><a class="icon-btn" href="#/herd" data-action="back" aria-label="Back">' + I.back + '</a>' +
      '<a class="btn btn-sm btn-pill" href="#/animal/' + esc(a.id) + '/edit">Edit</a></div>' +
      '<div class="hero-photo-btn"><label class="btn btn-sm btn-pill file-btn">' + I.camera + (a.photo_id ? 'Change photo' : 'Add photo') +
      '<input type="file" accept="image/*" data-photo-input="animal" data-id="' + esc(a.id) + '"></label></div></div>' +
      '<div class="hero-id">' + earTag(a.tag, 'lg') + '<div class="names"><h1>' + esc(dispName(a)) + '</h1>' +
      '<span class="meta">' + esc([a.breed, a.sex, ageText(a.birth_date)].filter(Boolean).join(' · ')) + '</span></div></div>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content" style="padding-top:20px">' +

      '<section class="field"><h2 class="sec-title">Status</h2><div class="status-grid">' + STATUSES.map(function (s) {
        var on = st(a) === s;
        return '<button type="button" class="' + statusCls[s] + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-action="set-status" data-id="' + esc(a.id) + '" data-v="' + esc(s) + '">' +
          (on ? I.check : '') + esc(s) + '</button>';
      }).join('') + '</div></section>' +

      '<section class="card"><div class="kv">' +
      '<div><span>Breed</span><b>' + esc(a.breed || '—') + '</b></div>' +
      '<div><span>Sex</span><b>' + esc(a.sex || '—') + '</b></div>' +
      '<div><span>Born</span><b>' + esc(fmtDate(a.birth_date, true)) + '</b></div>' +
      '<div><span>Origin</span><b>' + esc(a.origin || 'Born on farm') + '</b></div>' +
      (a.joined_date ? '<div><span>Joined herd</span><b>' + esc(fmtDate(a.joined_date, true)) + '</b></div>' : '') +
      (a.lease_until ? '<div><span>Lease ends</span><b>' + esc(fmtDate(a.lease_until, true)) + '</b></div>' : '') +
      '</div></section>';

    if (female) html += femaleBreedingCard(a);
    if (a.sex === 'Bull') html += bullStatsCard(a);

    html += '<section class="card"><h2 class="sec-title">Lineage</h2><div class="lineage">' +
      parentBox('Dam (mother)', dam) + parentBox('Sire (father)', sire) + '</div>' +
      '<div class="sub-list"><span class="hint" style="padding-bottom:6px">Offspring (' + offspring.length + ')</span>' +
      (offspring.length ? offspring.map(function (k) {
        var other = k.dam_id === a.id ? byId('Animals', k.sire_id) : byId('Animals', k.dam_id);
        var rel = k.dam_id === a.id ? (other ? ' · by ' + dispName(other) : '') : (other ? ' · out of ' + dispName(other) : '');
        return '<a href="#/animal/' + esc(k.id) + '"><span><strong>' + esc(k.tag || '—') + '</strong> · ' + esc((k.sex || '') + rel) + '</span><span class="when">' + esc(fmtMonth(k.birth_date)) + '</span></a>';
      }).join('') : '<span class="li muted">None recorded</span>') + '</div></section>';

    if (female) {
      var calvings = S.db.Calvings.filter(function (c) { return c.cow_id === a.id; })
        .sort(function (x, y) { return String(y.calving_date).localeCompare(String(x.calving_date)); });
      if (calvings.length) {
        html += '<section class="card"><h2 class="sec-title">Calving history</h2><div class="sub-list">' + calvings.map(function (c) {
          var calf = byId('Animals', c.calf_id);
          return (calf ? '<a href="#/animal/' + esc(calf.id) + '">' : '<span class="li">') +
            '<span>' + esc(calf ? tagName(calf) : 'Calf') + (c.ease ? ' · ' + esc(c.ease) : '') + '</span><span class="when">' + esc(fmtDate(c.calving_date, true)) + '</span>' +
            (calf ? '</a>' : '</span>');
        }).join('') + '</div></section>';
      }
    }
    if (a.notes) html += '<section class="card"><h2 class="sec-title">Notes</h2><p style="margin:0;font-size:15px;line-height:1.5;white-space:pre-wrap">' + esc(a.notes) + '</p></section>';
    if (a.updated_at) html += '<p class="updated">Last changed ' + esc(relTime(a.updated_at)) + (a.updated_by ? ' by ' + esc(a.updated_by) : '') + '</p>';
    html += '</div>' + nav('herd') + '</div>';
    return html;
  }

  function parentBox(label, p) {
    if (!p) return '<div><span class="lbl">' + label + '</span><span class="nm">Unknown</span></div>';
    var gp = [byId('Animals', p.dam_id), byId('Animals', p.sire_id)].filter(Boolean).map(dispName);
    return '<a href="#/animal/' + esc(p.id) + '"><span class="lbl">' + label + '</span><span class="nm">' + esc(tagName(p)) + '</span>' +
      '<span class="gp">' + esc(p.breed || '') + (gp.length ? (p.breed ? ' · ' : '') + 'from ' + gp.join(' & ') : '') + '</span></a>';
  }

  function femaleBreedingCard(a) {
    var b = pendingFor(a.id);
    var lastCalf = S.db.Calvings.filter(function (c) { return c.cow_id === a.id; })
      .sort(function (x, y) { return String(y.calving_date).localeCompare(String(x.calving_date)); })[0];
    var lastLine = lastCalf ? 'Last calved ' + fmtDate(lastCalf.calving_date, true) : 'No calvings recorded';
    if (!b) {
      return '<section class="card dark"><div class="card-head"><h2 class="sec-title">Breeding</h2><span class="pill p-harv">Open</span></div>' +
        '<span class="muted" style="font-size:14px">Not bred right now · ' + esc(lastLine) + '</span>' +
        (isActive(a) ? '<a class="btn btn-accent" href="#/breeding/new?cow=' + esc(a.id) + '">' + I.plus + 'Log breeding</a>' : '') + '</section>';
    }
    var exp = expected(b);
    var elapsed = daysBetween(b.bred_date, today()) || 0;
    var pct = Math.max(0, Math.min(100, Math.round(elapsed / GESTATION_DAYS * 100)));
    return '<section class="card dark"><div class="card-head"><h2 class="sec-title">Breeding</h2><span class="pill p-accent">Bred</span></div>' +
      '<span class="muted" style="font-size:14px">Bred to <strong style="color:var(--on-surface)">' + esc(bullLabel(b)) + '</strong> on ' + esc(fmtDate(b.bred_date, true)) + '</span>' +
      '<span class="muted" style="font-size:14px">Expected calving</span>' +
      '<span class="big-num accent-text">' + esc(fmtDate(exp, true)) + '</span>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<span class="muted" style="font-size:12px">' + elapsed + ' of ~' + GESTATION_DAYS + ' days · ' + esc(lastLine) + '</span>' +
      '<div class="btn-row"><a class="btn btn-accent" href="#/breeding/' + esc(b.id) + '/calve">Record calving</a>' +
      '<button type="button" class="btn btn-line" style="color:var(--on-surface);border-color:var(--on-surface-muted)" data-action="mark-open" data-id="' + esc(b.id) + '">Didn’t take</button></div></section>';
  }

  function bullStats(a) {
    var yr = String(new Date().getFullYear());
    var bred = S.db.Breedings.filter(function (b) { return b.bull_id === a.id && String(b.bred_date).slice(0, 4) === yr; });
    var sired = S.db.Animals.filter(function (x) { return x.sire_id === a.id; }).length;
    var months = bred.map(function (b) { return parseD(b.bred_date); }).filter(Boolean).map(function (d) { return d.getMonth(); });
    var season = '—';
    if (months.length) {
      var mn = Math.min.apply(null, months), mx = Math.max.apply(null, months);
      var name = function (m) { return new Date(2000, m, 1).toLocaleDateString('en-US', { month: 'short' }); };
      season = mn === mx ? name(mn) : name(mn) + '–' + name(mx);
    }
    return { bred: bred.length, sired: sired, season: season, yr: yr };
  }
  function bullStatsCard(a) {
    var s = bullStats(a);
    var cows = pendingBreedings().filter(function (b) { return b.bull_id === a.id; });
    return '<section class="card"><h2 class="sec-title">Breeding</h2><div class="mini-stats">' +
      '<div><b>' + s.bred + '</b><span>Bred ' + s.yr + '</span></div><div><b>' + s.sired + '</b><span>Calves sired</span></div>' +
      '<div><b>' + esc(s.season) + '</b><span>With cows</span></div></div>' +
      (cows.length ? '<div class="sub-list"><span class="hint" style="padding-bottom:6px">Cows expecting his calves</span>' + cows.map(function (b) {
        var cow = byId('Animals', b.cow_id);
        return '<a href="#/animal/' + esc(b.cow_id) + '"><span>' + esc(tagName(cow)) + '</span><span class="when">Due ' + esc(fmtDate(expected(b))) + '</span></a>';
      }).join('') + '</div>' : '') + '</section>';
  }

  // ==========================================================================
  // Screen: add / edit animal
  // ==========================================================================
  function viewAnimalForm(id, q) {
    var a = id ? byId('Animals', id) : null;
    if (id && !a) return viewNotFound('That animal isn’t here anymore.');
    a = a || { sex: q.sex || 'Cow', status: 'In herd', origin: q.sex === 'Bull' ? 'Purchased' : 'Born on farm' };
    var title = id ? 'Edit ' + dispName(a) : (q.sex === 'Bull' ? 'New bull' : 'New animal');
    var breeds = COMMON_BREEDS.slice();
    S.db.Animals.forEach(function (x) { if (x.breed && breeds.indexOf(x.breed) < 0) breeds.push(x.breed); });
    var dams = S.db.Animals.filter(function (x) { return isFemale(x) && x.id !== a.id; }).sort(byTag)
      .map(function (x) { return { value: x.id, label: tagName(x) + (isActive(x) ? '' : ' (' + st(x).toLowerCase() + ')') }; });
    var sires = bulls().filter(function (x) { return x.id !== a.id; }).sort(byTag)
      .map(function (x) { return { value: x.id, label: tagName(x) + (isActive(x) ? '' : ' (' + st(x).toLowerCase() + ')') }; });
    var photoSrc = formPhoto ? 'data:image/jpeg;base64,' + formPhoto : '';

    return '<div class="screen">' + formHeader(title, 'f-animal', id ? '#/animal/' + esc(id) : '#/herd') +
      '<form id="f-animal" class="form" data-form="animal" data-id="' + esc(id || '') + '" novalidate>' +
      '<div class="photo-pick' + (photoSrc ? ' has-img' : '') + '" id="form-photo"' + (!photoSrc && a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' +
      (photoSrc ? '<img alt="" src="' + photoSrc + '">' : '') + I.camera +
      '<label class="btn btn-dark btn-sm file-btn">' + (a.photo_id || photoSrc ? 'Change photo' : 'Take or choose photo') +
      '<input type="file" accept="image/*" data-photo-input="form"></label></div>' +

      '<div class="grid-2"><label class="field"><span class="lbl">Ear tag *</span>' +
      '<input class="inp tag-inp" name="tag" value="' + esc(a.tag) + '" autocomplete="off" autocapitalize="characters" required></label>' +
      '<label class="field"><span class="lbl">Name (optional)</span><input class="inp" name="name" value="' + esc(a.name) + '" placeholder="e.g. Daisy"></label></div>' +

      '<label class="field"><span class="lbl">Breed</span><input class="inp" name="breed" list="breed-list" value="' + esc(a.breed) + '" placeholder="Start typing…">' +
      '<datalist id="breed-list">' + breeds.map(function (b) { return '<option value="' + esc(b) + '">'; }).join('') + '</datalist></label>' +

      '<fieldset class="field"><legend class="lbl">Sex</legend><div class="opts">' + opts('sex', SEXES, a.sex) + '</div></fieldset>' +

      '<label class="field"><span class="lbl">Birth date</span><input class="inp" type="date" name="birth_date" value="' + esc(a.birth_date) + '" max="' + today() + '">' +
      '<span class="hint" id="age-hint"></span></label>' +

      '<fieldset class="field"><legend class="lbl">Origin</legend><div class="opts">' + opts('origin', ['Born on farm', 'Purchased', 'Leased'], a.origin || 'Born on farm') + '</div></fieldset>' +
      '<div class="grid-2" data-show-when="origin:Purchased|Leased">' +
      '<label class="field"><span class="lbl">Joined herd</span><input class="inp" type="date" name="joined_date" value="' + esc(a.joined_date) + '"></label>' +
      '<label class="field" data-show-when="origin:Leased"><span class="lbl">Lease ends</span><input class="inp" type="date" name="lease_until" value="' + esc(a.lease_until) + '"></label></div>' +

      '<section class="card"><h2 class="sec-title">Lineage</h2>' +
      '<label class="field"><span class="lbl">Dam (mother)</span><select class="inp" name="dam_id">' + selectOpts(dams, a.dam_id, 'Unknown / not in herd') + '</select></label>' +
      '<label class="field"><span class="lbl">Sire (father)</span><select class="inp" name="sire_id">' + selectOpts(sires, a.sire_id, 'Unknown / not in herd') + '</select></label></section>' +

      '<label class="field"><span class="lbl">Status</span><select class="inp" name="status">' +
      selectOpts(STATUSES.map(function (s) { return { value: s, label: s }; }), st(a)) + '</select></label>' +

      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="3" placeholder="Anything worth remembering">' + esc(a.notes) + '</textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button>' +
      (id ? '<button type="button" class="btn btn-danger btn-block" data-action="delete-animal" data-id="' + esc(id) + '">Delete this animal</button>' +
        '<p class="hint" style="margin:-8px 0 0;text-align:center">Only for mistakes. Use Harvested or Deceased to keep the record.</p>' : '') +
      '</form></div>';
  }

  // ==========================================================================
  // Screen: breeding & calving
  // ==========================================================================
  function breedingCard(b) {
    var cow = byId('Animals', b.cow_id) || { tag: '?' };
    var exp = expected(b);
    var left = daysBetween(today(), exp);
    var elapsed = daysBetween(b.bred_date, today()) || 0;
    var pct = Math.max(0, Math.min(100, Math.round(elapsed / GESTATION_DAYS * 100)));
    var days = left === null ? '—' : left >= 0 ? left + (left === 1 ? ' day' : ' days') : (-left) + ' over';
    return '<article class="card b-card"><div class="b-top">' + earTag(cow.tag) +
      '<a class="row-main" href="#/animal/' + esc(cow.id || '') + '"><span class="row-title">' + esc(dispName(cow)) + '</span>' +
      '<span class="row-sub">Bred to ' + esc(bullLabel(b)) + ' · ' + esc(fmtDate(b.bred_date)) + '</span></a>' +
      '<div class="b-days' + (left !== null && left < 0 ? ' over' : '') + '"><b>' + days + '</b><span>Due ' + esc(fmtDate(exp)) + '</span></div></div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<div class="btn-row"><a class="btn btn-dark btn-sm" href="#/breeding/' + esc(b.id) + '/calve">Record calving</a>' +
      '<button type="button" class="btn btn-line btn-sm" data-action="mark-open" data-id="' + esc(b.id) + '">Didn’t take</button></div></article>';
  }
  function openCows() {
    var bredIds = {};
    pendingBreedings().forEach(function (b) { bredIds[b.cow_id] = true; });
    return S.db.Animals.filter(function (a) {
      if (!isFemale(a) || st(a) !== 'In herd' || bredIds[a.id]) return false;
      var m = monthsOld(a.birth_date);
      return a.sex === 'Cow' || m === null || m >= 12;
    }).sort(byTag);
  }
  function viewBreeding() {
    var t = today();
    var pend = pendingBreedings().sort(function (x, y) { return expected(x).localeCompare(expected(y)); });
    var due = pend.filter(function (b) { var d = daysBetween(t, expected(b)); return d !== null && d <= DUE_SOON_DAYS; });
    var open = openCows();
    var tabs = [['due', 'Due soon · ' + due.length], ['bred', 'Bred · ' + pend.length], ['open', 'Open · ' + open.length]];
    var body;
    if (UI.breedTab === 'open') {
      body = open.length ? open.map(function (a) {
        var last = S.db.Calvings.filter(function (c) { return c.cow_id === a.id; })
          .sort(function (x, y) { return String(y.calving_date).localeCompare(String(x.calving_date)); })[0];
        return '<article class="card b-card"><div class="b-top">' + earTag(a.tag) +
          '<a class="row-main" href="#/animal/' + esc(a.id) + '"><span class="row-title">' + esc(dispName(a)) + '</span>' +
          '<span class="row-sub">' + esc(a.sex) + ' · ' + esc(last ? 'last calved ' + fmtDate(last.calving_date, true) : 'no calvings recorded') + '</span></a></div>' +
          '<a class="btn btn-dark btn-sm" href="#/breeding/new?cow=' + esc(a.id) + '">Log breeding</a></article>';
      }).join('') : '<div class="empty"><b>No open cows</b>Every cow and heifer old enough is bred.</div>';
    } else {
      var list = UI.breedTab === 'bred' ? pend : due;
      body = list.length ? list.map(breedingCard).join('')
        : '<div class="empty"><b>' + (UI.breedTab === 'bred' ? 'No cows bred yet' : 'Nobody due in the next ' + DUE_SOON_DAYS + ' days') +
          '</b>Log a breeding with the yellow button.</div>';
    }
    return '<div class="screen"><header class="hdr"><div class="hdr-titles"><span class="eyebrow">Season ' + new Date().getFullYear() +
      '</span><h1 class="h1">Breeding &amp; Calving</h1></div>' +
      '<div class="seg-dark" role="group" aria-label="Breeding views">' + tabs.map(function (tb) {
        return '<button type="button" class="' + (UI.breedTab === tb[0] ? 'on' : '') + '" aria-pressed="' + (UI.breedTab === tb[0]) + '" data-action="breed-tab" data-v="' + tb[0] + '">' + tb[1] + '</button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content"><div class="list">' + body + '</div><div style="height:64px"></div></div>' +
      '<a class="fab" href="#/breeding/new">' + I.plus + 'Log heat / breeding</a>' + nav('breeding') + '</div>';
  }

  function viewBreedingForm(q) {
    var cows = S.db.Animals.filter(function (a) { return isFemale(a) && isActive(a); }).sort(byTag)
      .map(function (a) { return { value: a.id, label: tagName(a) }; });
    var bullList = bulls().filter(isActive).sort(byTag).map(function (a) { return { value: a.id, label: tagName(a) + (a.origin === 'Leased' ? ' (leased)' : '') }; });
    return '<div class="screen">' + formHeader('Log breeding', 'f-breed', '#/breeding') +
      '<form id="f-breed" class="form" data-form="breeding" novalidate>' +
      '<label class="field"><span class="lbl">Cow or heifer *</span><select class="inp" name="cow_id" required>' +
      selectOpts(cows, q.cow || '', 'Choose…') + '</select></label>' +
      '<fieldset class="field"><legend class="lbl">Method</legend><div class="opts">' + opts('method', ['Natural', 'AI'], 'Natural', ['Bull', 'AI']) + '</div></fieldset>' +
      '<label class="field" data-show-when="method:Natural"><span class="lbl">Bull</span><select class="inp" name="bull_id">' +
      selectOpts(bullList, bullList.length === 1 ? bullList[0].value : '', 'Choose…') + '</select></label>' +
      '<label class="field" data-show-when="method:AI"><span class="lbl">AI sire / straw</span><input class="inp" name="ai_sire" placeholder="Bull name or straw code"></label>' +
      '<p class="warn" id="rel-warn" hidden></p>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Heat seen</span><input class="inp" type="date" name="heat_date"></label>' +
      '<label class="field"><span class="lbl">Bred on *</span><input class="inp" type="date" name="bred_date" value="' + today() + '" max="' + today() + '" required></label></div>' +
      '<div class="info">' + I.cal + '<span id="exp-text">Expected calving: —</span></div>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2"></textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
  }

  function viewCalving(bid) {
    var b = byId('Breedings', bid);
    if (!b) return viewNotFound('That breeding record isn’t here anymore.');
    var cow = byId('Animals', b.cow_id) || {};
    var bull = byId('Animals', b.bull_id);
    var breed = cow.breed && bull && bull.breed ? (cow.breed === bull.breed ? cow.breed : cow.breed + ' × ' + bull.breed) : (cow.breed || '');
    return '<div class="screen">' + formHeader('Record calving', 'f-calve', '#/breeding') +
      '<form id="f-calve" class="form" data-form="calving" data-id="' + esc(b.id) + '" novalidate>' +
      '<div class="info">' + I.info + '<span><strong>' + esc(tagName(cow)) + '</strong> × ' + esc(bullLabel(b)) + ' · bred ' + esc(fmtDate(b.bred_date, true)) + '</span></div>' +
      '<label class="field"><span class="lbl">Calving date *</span><input class="inp" type="date" name="calving_date" value="' + today() + '" max="' + today() + '" required></label>' +
      '<fieldset class="field"><legend class="lbl">Calf</legend><div class="opts">' + opts('alive', ['yes', 'no'], 'yes', ['Born alive', 'Stillborn']) + '</div></fieldset>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Calf ear tag</span><input class="inp tag-inp" name="tag" autocomplete="off" autocapitalize="characters"></label>' +
      '<label class="field"><span class="lbl">Name (optional)</span><input class="inp" name="name"></label></div>' +
      '<fieldset class="field"><legend class="lbl">Calf sex</legend><div class="opts">' + opts('sex', ['Heifer', 'Bull', 'Steer'], 'Heifer') + '</div></fieldset>' +
      '<label class="field"><span class="lbl">Breed</span><input class="inp" name="breed" value="' + esc(breed) + '"></label>' +
      '<fieldset class="field"><legend class="lbl">How did it go?</legend><div class="opts wrap">' +
      opts('ease', ['Unassisted', 'Assisted', 'Hard pull', 'Vet / C-section'], 'Unassisted') + '</div></fieldset>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2"></textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save calving</button>' +
      '<p class="hint" style="margin:-8px 0 0;text-align:center">This creates the calf’s profile with its dam and sire filled in.</p></form></div>';
  }

  // ==========================================================================
  // Screen: bulls
  // ==========================================================================
  function viewBulls() {
    var all = bulls().sort(byTag);
    var act = all.filter(isActive), past = all.filter(function (a) { return !isActive(a); });
    var leased = act.filter(function (a) { return a.origin === 'Leased'; }).length;
    var cards = act.map(function (a) {
      var s = bullStats(a);
      var joined = a.joined_date ? 'Joined ' + fmtMonth(a.joined_date) : '';
      var origin = a.origin === 'Leased' ? (a.lease_until ? 'Returns ' + fmtMonth(a.lease_until) : 'Leased') : (a.origin || '');
      return '<a class="card b-card" href="#/animal/' + esc(a.id) + '"><div class="b-top">' + thumb(a) +
        '<span class="row-main"><span style="display:flex;align-items:center;gap:8px"><span class="row-title">' + esc(dispName(a)) + '</span>' +
        (a.origin === 'Leased' ? '<span class="pill p-lease">Leased</span>' : '') + '</span>' +
        '<span class="row-sub">' + esc([a.breed, ageText(a.birth_date, true)].filter(Boolean).join(' · ')) + '</span>' +
        '<span class="row-sub">' + esc([joined, origin].filter(Boolean).join(' · ')) + '</span></span></div>' +
        '<div class="mini-stats"><div><b>' + s.bred + '</b><span>Bred ' + s.yr + '</span></div><div><b>' + s.sired + '</b><span>Calves sired</span></div>' +
        '<div><b>' + esc(s.season) + '</b><span>With cows</span></div></div></a>';
    }).join('');
    return '<div class="screen"><header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">' +
      act.length + ' in herd' + (leased ? ' · ' + leased + ' leased' : '') + '</span><h1 class="h1">Bulls</h1></div>' +
      '<a class="btn btn-accent btn-pill btn-sm" href="#/add?sex=Bull">' + I.plus + 'Add bull</a></div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content"><div class="list">' + (cards || '<div class="empty"><b>No bulls yet</b>Add the bulls that run with your cows so their calves link to them.</div>') + '</div>' +
      (past.length ? '<h2 class="section-title">Past bulls</h2><div class="list">' + past.map(animalRow).join('') + '</div>' : '') +
      '</div>' + nav('bulls') + '</div>';
  }

  // ==========================================================================
  // Screen: sales waitlist
  // ==========================================================================
  function salesNumbers() {
    var waiting = S.db.Orders.filter(function (o) { return (o.status || 'Waiting') === 'Waiting'; });
    var wanted = waiting.reduce(function (s, o) { return s + orderHead(o); }, 0);
    var ready = S.db.Animals.filter(function (a) { return st(a) === 'Ready for harvest'; });
    var claimed = ready.reduce(function (s, a) { return s + Math.min(1, claimedOn(a.id)); }, 0);
    var open = Math.max(0, ready.length - claimed);
    var mix = { Whole: 0, Half: 0, Quarter: 0 };
    waiting.forEach(function (o) { if (mix[o.share] !== undefined) mix[o.share] += parseFloat(o.quantity) || 1; });
    return { wanted: wanted, ready: ready.length, claimed: claimed, open: open, mix: mix };
  }
  function orderCard(o, pos) {
    var a = byId('Animals', o.assigned_animal_id);
    var status = o.status || 'Waiting';
    var sub = ['Added ' + fmtDate(localDateOf(o.created_at) || today()), o.deposit_status === 'Paid' ? 'Deposit paid' : 'No deposit yet'];
    var actions = '';
    var contact = (o.phone ? '<a class="sq-btn" href="tel:' + esc(o.phone.replace(/[^\d+]/g, '')) + '" aria-label="Call ' + esc(o.name) + '">' + I.phone + '</a>' +
      '<a class="sq-btn" href="sms:' + esc(o.phone.replace(/[^\d+]/g, '')) + '" aria-label="Text ' + esc(o.name) + '">' + I.text + '</a>' : '');
    if (status === 'Waiting') actions = '<a class="btn btn-accent btn-sm" style="flex:1" href="#/order/' + esc(o.id) + '/assign">Assign an animal</a>';
    else if (status === 'Assigned') actions = '<button type="button" class="btn btn-dark btn-sm" style="flex:1" data-action="order-filled" data-id="' + esc(o.id) + '">Mark filled</button>' +
      '<button type="button" class="btn btn-line btn-sm" data-action="order-unassign" data-id="' + esc(o.id) + '">Unassign</button>';
    else actions = '<button type="button" class="btn btn-line btn-sm" style="flex:1" data-action="order-reopen" data-id="' + esc(o.id) + '">Move back to waitlist</button>';
    return '<article class="card b-card"><a class="order-top" href="#/order/' + esc(o.id) + '">' +
      (pos ? '<span class="pos">#' + pos + '</span>' : '') +
      '<span class="row-main"><span class="row-title">' + esc(o.name || 'No name') + '</span><span class="row-sub">' + esc(sub.join(' · ')) + '</span>' +
      (o.wanted_by ? '<span class="row-sub">Wants: ' + esc(o.wanted_by) + '</span>' : '') + '</span>' + sharePill(o) + '</a>' +
      (a ? '<span class="assigned-line">' + earTag(a.tag, 'sm') + 'Assigned to ' + esc(tagName(a)) + (status === 'Cancelled' ? ' · cancelled' : '') + '</span>' : (status === 'Cancelled' ? '<span class="assigned-line">Cancelled</span>' : '')) +
      '<div class="btn-row" style="align-items:center">' + contact + actions + '</div></article>';
  }
  function viewSales() {
    var n = salesNumbers();
    var all = S.db.Orders.slice().sort(function (x, y) { return String(x.created_at).localeCompare(String(y.created_at)); });
    var waiting = all.filter(function (o) { return (o.status || 'Waiting') === 'Waiting'; });
    var assigned = all.filter(function (o) { return o.status === 'Assigned'; });
    var done = all.filter(function (o) { return o.status === 'Filled' || o.status === 'Cancelled'; }).reverse();
    var scale = Math.max(n.wanted, n.open, 1);
    var diff = n.open - n.wanted;
    var callout = !n.wanted && !n.ready ? ''
      : diff < 0
        ? '<div class="callout">' + I.warn + '<span><strong>Short ' + fmtHead(-diff) + ' head</strong> (' + Math.round(-diff * 4) + ' quarter shares). Tag more animals ready, or let the last few on the list know they’re next season.</span></div>'
        : '<div class="callout ok">' + I.check + '<span><strong>' + (diff === 0 ? 'Exactly covered.' : 'Covered, with ' + fmtHead(diff) + ' head to spare.') + '</strong> ' +
          (diff > 0 ? 'Room for ' + Math.round(diff * 4) + ' more quarter ' + (Math.round(diff * 4) === 1 ? 'share.' : 'shares.') : 'Every waiting order has beef.') + '</span></div>';
    var list = UI.salesTab === 'assigned' ? assigned : UI.salesTab === 'done' ? done : waiting;
    var tabs = [['waiting', 'Waiting · ' + waiting.length], ['assigned', 'Assigned · ' + assigned.length], ['done', 'Done']];
    return '<div class="screen"><header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">' +
      all.length + (all.length === 1 ? ' order' : ' orders') + ' · ' + waiting.length + ' waiting</span><h1 class="h1">Sales Waitlist</h1></div>' +
      '<a class="btn btn-accent btn-pill btn-sm" href="#/order/new">' + I.plus + 'Add order</a></div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' +
      '<section class="card" aria-label="Orders compared with animals ready for harvest"><h2 class="sec-title">Wanted vs. ready for harvest</h2>' +
      '<div class="bar-row"><div class="bar-top"><span>Waitlist wants</span><b>' + fmtHead(n.wanted) + ' head</b></div>' +
      '<div class="bar"><div style="width:' + Math.round(n.wanted / scale * 100) + '%;background:var(--surface)"></div></div></div>' +
      '<div class="bar-row"><div class="bar-top"><span>Ready for harvest, not yet claimed</span><b>' + fmtHead(n.open) + ' head</b></div>' +
      '<div class="bar"><div style="width:' + Math.round(n.open / scale * 100) + '%;background:var(--accent)"></div></div>' +
      '<span class="hint">' + n.ready + ' tagged ready' + (n.claimed ? ' · ' + fmtHead(n.claimed) + ' already assigned to orders' : '') + '</span></div>' +
      callout +
      '<div class="mini-stats"><div><b>' + n.mix.Whole + '</b><span>Whole</span></div><div><b>' + n.mix.Half + '</b><span>Half</span></div><div><b>' + n.mix.Quarter + '</b><span>Quarter</span></div></div></section>' +
      '<div class="seg-light" role="group" aria-label="Order filter">' + tabs.map(function (tb) {
        return '<button type="button" class="' + (UI.salesTab === tb[0] ? 'on' : '') + '" aria-pressed="' + (UI.salesTab === tb[0]) + '" data-action="sales-tab" data-v="' + tb[0] + '">' + tb[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="list">' + (list.length ? list.map(function (o, i) { return orderCard(o, UI.salesTab === 'waiting' ? i + 1 : 0); }).join('')
        : '<div class="empty"><b>' + (UI.salesTab === 'waiting' ? 'Nobody waiting' : UI.salesTab === 'assigned' ? 'No assigned orders' : 'Nothing finished yet') + '</b>' +
          (UI.salesTab === 'waiting' ? 'Add an order when someone asks for beef.' : '') + '</div>') + '</div>' +
      '</div>' + nav('sales') + '</div>';
  }

  function viewOrderForm(id) {
    var o = id ? byId('Orders', id) : null;
    if (id && !o) return viewNotFound('That order isn’t here anymore.');
    o = o || { share: 'Half', quantity: '1', deposit_status: 'Not yet', status: 'Waiting' };
    var y = new Date().getFullYear();
    var wantOpts = ['Next available', 'Spring ' + (y + 1), 'Fall ' + y, 'Fall ' + (y + 1)];
    var ready = S.db.Animals.filter(function (a) { return st(a) === 'Ready for harvest' || a.id === o.assigned_animal_id; }).sort(byTag)
      .map(function (a) {
        var left = 1 - claimedOn(a.id, o.id);
        return { value: a.id, label: tagName(a) + ' · ' + (a.breed ? a.breed + ' ' : '') + (a.sex || '').toLowerCase() + ' · ' + (left > 0 ? fmtHead(left) + ' left' : 'fully claimed') };
      });
    var waitingCount = S.db.Orders.filter(function (x) { return (x.status || 'Waiting') === 'Waiting'; }).length;
    return '<div class="screen">' + formHeader(id ? 'Edit order' : 'New order', 'f-order', '#/sales') +
      '<form id="f-order" class="form" data-form="order" data-id="' + esc(id || '') + '" novalidate>' +
      '<section class="field" style="gap:12px"><h2 class="sec-title">Contact</h2>' +
      '<label class="field"><span class="lbl">Name *</span><input class="inp" name="name" value="' + esc(o.name) + '" placeholder="Person or family name" autocomplete="off" required></label>' +
      '<label class="field"><span class="lbl">Phone *</span><input class="inp" type="tel" name="phone" value="' + esc(o.phone) + '" placeholder="(555) 555-0100" autocomplete="off" required></label>' +
      '<label class="field"><span class="lbl">Email</span><input class="inp" type="email" name="email" value="' + esc(o.email) + '" placeholder="name@example.com" autocomplete="off"></label></section>' +

      '<section class="card"><h2 class="sec-title">What they want</h2>' +
      '<fieldset class="field"><legend class="lbl">Share size</legend><div class="opts">' + opts('share', ['Whole', 'Half', 'Quarter'], o.share) + '</div></fieldset>' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><span class="lbl" id="qty-lbl">How many</span>' +
      '<div class="stepper"><button type="button" data-action="qty" data-v="-1" aria-label="Fewer">−</button>' +
      '<input name="quantity" inputmode="numeric" value="' + esc(o.quantity || '1') + '" aria-labelledby="qty-lbl">' +
      '<button type="button" data-action="qty" data-v="1" aria-label="More">+</button></div></div>' +
      '<label class="field"><span class="lbl">Wanted by</span><input class="inp" name="wanted_by" list="want-list" value="' + esc(o.wanted_by || 'Next available') + '">' +
      '<datalist id="want-list">' + wantOpts.map(function (w) { return '<option value="' + esc(w) + '">'; }).join('') + '</datalist></label>' +
      '<label class="field"><span class="lbl">Cut / processing notes</span><textarea class="inp" name="cut_notes" rows="2" placeholder="e.g. extra ground beef, thick-cut steaks">' + esc(o.cut_notes) + '</textarea></label></section>' +

      '<section class="field" style="gap:12px"><h2 class="sec-title">Deposit</h2>' +
      '<div class="opts">' + opts('deposit_status', ['Not yet', 'Paid'], o.deposit_status || 'Not yet') + '</div>' +
      '<label class="field"><span class="lbl">Amount</span><input class="inp" name="deposit_amount" inputmode="decimal" value="' + esc(o.deposit_amount) + '" placeholder="$"></label></section>' +

      '<label class="field"><span class="lbl">Assign an animal (optional)</span><select class="inp" name="assigned_animal_id">' +
      selectOpts(ready, o.assigned_animal_id, 'Not yet — keep on waitlist') + '</select>' +
      '<span class="hint">Only animals tagged Ready for harvest show here.</span></label>' +
      (id ? '<label class="field"><span class="lbl">Order status</span><select class="inp" name="status">' +
        selectOpts(['Waiting', 'Assigned', 'Filled', 'Cancelled'].map(function (s) { return { value: s, label: s }; }), o.status || 'Waiting') + '</select></label>' : '') +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2">' + esc(o.notes) + '</textarea></label>' +
      (!id ? '<div class="info">' + I.info + '<span>This order goes to the end of the list as <strong>#' + (waitingCount + 1) + '</strong>.</span></div>' : '') +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button>' +
      (id ? '<button type="button" class="btn btn-danger btn-block" data-action="delete-order" data-id="' + esc(id) + '">Delete this order</button>' : '') +
      '</form></div>';
  }

  function viewAssign(id) {
    var o = byId('Orders', id);
    if (!o) return viewNotFound('That order isn’t here anymore.');
    var need = orderHead(o);
    var ready = S.db.Animals.filter(function (a) { return st(a) === 'Ready for harvest'; }).sort(byTag);
    var rows = ready.map(function (a) {
      var left = 1 - claimedOn(a.id, o.id);
      var fits = left + 1e-9 >= need;
      return '<div class="row">' + thumb(a) + '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
        '<span class="row-sub">' + esc(animalSub(a)) + '</span><span class="row-sub">' + (left > 0 ? fmtHead(left) + ' left' : 'Fully claimed') + '</span></span>' +
        '<button type="button" class="btn btn-sm ' + (fits ? 'btn-accent' : 'btn-line') + '" data-action="assign" data-id="' + esc(o.id) + '" data-animal="' + esc(a.id) + '"' + (fits ? '' : ' disabled') + '>Assign</button></div>';
    }).join('');
    return '<div class="screen"><header class="form-hdr"><a class="link-btn left" href="#/sales" data-action="back">' + I.back + 'Back</a>' +
      '<h1 class="h2">Assign an animal</h1><span></span></header>' +
      '<div class="content"><div class="info">' + I.info + '<span><strong>' + esc(o.name) + '</strong> wants ' + esc(shareLabel(o).toLowerCase()) + ' (' + fmtHead(need) + ' head).</span></div>' +
      (need > 1 ? '<p class="warn">This order is more than one animal. Split it into separate orders so each can be assigned.</p>' : '') +
      '<div class="list">' + (rows || '<div class="empty"><b>No animals are ready</b>Tag an animal “Ready for harvest” on its profile and it will show here.</div>') + '</div></div>' + nav('sales') + '</div>';
  }

  // ==========================================================================
  // Screen: settings
  // ==========================================================================
  function settingsSyncHTML() {
    var pend = S.queue.length;
    return '<div class="kv"><div><span>Connection</span><b>' + (S.syncing ? 'Syncing…' : S.offline ? 'No signal' : S.lastError ? 'Problem' : 'Online') + '</b></div>' +
      '<div><span>Last synced</span><b>' + esc(relTime(S.lastSync)) + '</b></div>' +
      '<div><span>Waiting to save</span><b>' + pend + (pend === 1 ? ' change' : ' changes') + '</b></div>' +
      '<div><span>On this phone</span><b>' + S.db.Animals.length + ' animals · ' + S.db.Orders.length + ' orders</b></div></div>' +
      (S.lastError ? '<p class="form-err" style="margin:0">' + esc(S.lastError) + '</p>' : '');
  }
  function viewSettings() {
    return '<div class="screen"><header class="form-hdr"><a class="link-btn left" href="#/herd" data-action="back">' + I.back + 'Back</a>' +
      '<h1 class="h2">Settings</h1><span></span></header>' +
      '<div class="content">' +
      '<section class="card"><h2 class="sec-title">Sync</h2><div id="settings-sync">' + settingsSyncHTML() + '</div>' +
      '<button type="button" class="btn btn-dark" data-action="sync">' + I.sync + 'Sync now</button></section>' +
      '<form class="card" data-form="who" novalidate><h2 class="sec-title">This phone</h2>' +
      '<label class="field"><span class="lbl">Your name (shown as who made each change)</span><input class="inp" name="who" value="' + esc(S.who) + '" required></label>' +
      '<button type="submit" class="btn btn-line">Save name</button></form>' +
      '<section class="card"><h2 class="sec-title">Install tips</h2>' +
      '<p class="hint" style="margin:0;font-size:14px;line-height:1.5"><strong>iPhone:</strong> open in Safari → Share → Add to Home Screen.<br><strong>Android:</strong> open in Chrome → ⋮ menu → Add to Home screen (or Install app).</p></section>' +
      '<section class="card"><h2 class="sec-title">Sign out</h2><p class="hint" style="margin:0;font-size:14px;line-height:1.5">Disconnects this phone and clears its copy of the herd. The Google Sheet is not touched.</p>' +
      '<button type="button" class="btn btn-danger" data-action="sign-out">Sign out of this phone</button></section>' +
      '<p class="updated">Herd Tracker ' + esc(VERSION) + '</p></div>' + nav('') + '</div>';
  }

  function viewNotFound(msg) {
    return '<div class="screen"><header class="hdr"><h1 class="h1">Not found</h1></header><div class="content"><div class="empty"><b>' + esc(msg) + '</b>' +
      '<a class="btn btn-dark" href="#/herd">Back to the herd</a></div></div>' + nav('') + '</div>';
  }

  // ==========================================================================
  // Router
  // ==========================================================================
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('?');
    var q = {};
    new URLSearchParams(parts[1] || '').forEach(function (v, k) { q[k] = v; });
    return { p: parts[0].split('/').filter(Boolean), q: q };
  }
  function route(r) {
    var p = r.p, q = r.q;
    switch (p[0]) {
      case 'animal':
        if (p[2] === 'edit') return { html: viewAnimalForm(p[1], q), form: true };
        return { html: viewAnimal(p[1]) };
      case 'add': return { html: viewAnimalForm(null, q), form: true };
      case 'breeding':
        if (p[1] === 'new') return { html: viewBreedingForm(q), form: true };
        if (p[2] === 'calve') return { html: viewCalving(p[1]), form: true };
        return { html: viewBreeding() };
      case 'bulls': return { html: viewBulls() };
      case 'sales': return { html: viewSales() };
      case 'order':
        if (p[1] === 'new') return { html: viewOrderForm(null), form: true };
        if (p[2] === 'assign') return { html: viewAssign(p[1]) };
        return { html: viewOrderForm(p[1]), form: true };
      case 'settings': return { html: viewSettings() };
      default: return { html: viewHerd() };
    }
  }
  function render() {
    var app = document.getElementById('app');
    if (!S.passcode) {
      if (currentKey !== '__setup') { app.innerHTML = viewSetup(); currentKey = '__setup'; }
      currentIsForm = true;
      return;
    }
    var key = location.hash || '#/herd';
    var fresh = key !== currentKey;
    if (fresh) { formPhoto = null; currentKey = key; }
    var r = route(parseRoute());
    currentIsForm = !!r.form;
    app.innerHTML = r.html;
    if (fresh) window.scrollTo(0, 0);
    afterRender();
  }
  function refreshView() {
    if (currentIsForm) { renderStatus(); return; }
    var y = window.scrollY;
    var searchFocused = document.activeElement && document.activeElement.id === 'herd-search';
    if (searchFocused) {                       // don't steal focus while typing a search
      var l = document.getElementById('herd-list');
      if (l) { l.innerHTML = herdListHTML(); hydratePhotos(); }
      renderStatus();
      return;
    }
    render();
    window.scrollTo(0, y);
  }
  function afterRender() {
    hydratePhotos();
    document.querySelectorAll('form[data-form]').forEach(onFormInput);
  }

  // ==========================================================================
  // Form behavior (show/hide, live hints)
  // ==========================================================================
  function val(form, name) { var el = form.elements[name]; return el ? (el.value || '') : ''; }
  function onFormInput(form) {
    form.querySelectorAll('[data-show-when]').forEach(function (el) {
      var parts = el.getAttribute('data-show-when').split(':');
      el.hidden = parts[1].split('|').indexOf(val(form, parts[0])) < 0;
    });
    if (form.dataset.form === 'animal') {
      var h = document.getElementById('age-hint');
      var b = val(form, 'birth_date');
      if (h) h.textContent = b ? 'Age: ' + ageText(b) : 'Age is worked out from this date.';
    }
    if (form.dataset.form === 'breeding') {
      var bred = val(form, 'bred_date');
      var e = document.getElementById('exp-text');
      if (e) e.innerHTML = 'Expected calving: <strong>' + (bred ? esc(fmtDate(addDays(bred, GESTATION_DAYS), true)) : '—') + '</strong> (~' + GESTATION_DAYS + ' days)';
      var w = document.getElementById('rel-warn');
      var msg = val(form, 'method') === 'Natural' ? relatedness(val(form, 'cow_id'), val(form, 'bull_id')) : '';
      var cow = val(form, 'cow_id');
      var existing = cow && pendingFor(cow);
      if (existing) msg = (msg ? msg + ' ' : '') + 'She already has a breeding logged on ' + fmtDate(existing.bred_date, true) + ' — saving will mark that one as didn’t take.';
      if (w) { w.textContent = msg ? '⚠ ' + msg : ''; w.hidden = !msg; }
    }
  }
  function formError(form, msg) {
    var el = form.querySelector('.form-err');
    if (el) { el.textContent = msg; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function fields(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { o[k] = typeof v === 'string' ? v.trim() : v; });
    return o;
  }

  // ==========================================================================
  // Form submits
  // ==========================================================================
  var forms = {
    setup: function (form) {
      var f = fields(form);
      if (!f.who) return formError(form, 'Enter your name.');
      if (!f.passcode) return formError(form, 'Enter the farm passcode.');
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Connecting…';
      S.passcode = f.passcode; S.who = f.who;
      return api('ping').then(function () {
        lsSet('herd.passcode', f.passcode);
        lsSet('herd.who', f.who);
        S.authFailed = false;
        currentKey = null;
        location.hash = '#/herd';
        render();
        return trySync();
      }, function (e) {
        S.passcode = '';
        btn.disabled = false; btn.textContent = 'Connect';
        formError(form, e.code === 'AUTH' ? 'That passcode didn’t work. Check it and try again.'
          : e.offline ? 'Can’t reach the farm’s Sheet. Check your signal and try again.' : e.message);
      });
    },

    who: function (form) {
      var f = fields(form);
      if (!f.who) return formError(form, 'Enter your name.');
      S.who = f.who; lsSet('herd.who', f.who);
      toast('Name saved');
    },

    animal: function (form) {
      var f = fields(form);
      var id = form.dataset.id;
      var existing = id ? byId('Animals', id) : null;
      if (!f.tag) return formError(form, 'Every animal needs an ear tag.');
      var dup = S.db.Animals.find(function (a) {
        return a.id !== id && isActive(a) && String(a.tag).toLowerCase() === f.tag.toLowerCase();
      });
      if (dup && f.status !== 'Harvested' && f.status !== 'Deceased') {
        return formError(form, 'Tag ' + f.tag + ' is already used by ' + dispName(dup) + '.');
      }
      var row = {
        id: id || uuid(), tag: f.tag, name: f.name, breed: f.breed, sex: f.sex, birth_date: f.birth_date,
        status: f.status, origin: f.origin,
        joined_date: f.origin === 'Born on farm' ? '' : f.joined_date,
        lease_until: f.origin === 'Leased' ? f.lease_until : '',
        dam_id: f.dam_id, sire_id: f.sire_id, notes: f.notes
      };
      var changes = [];
      var chain = Promise.resolve();
      if (formPhoto) {
        var localId = 'local-' + uuid();
        var b64 = formPhoto;
        chain = idb.set('photo:' + localId, { base64: b64, mime: 'image/jpeg' }).then(function () {
          photoMem.set(localId, 'data:image/jpeg;base64,' + b64);
          changes.push({ kind: 'photo', localId: localId, name: 'tag-' + row.tag,
            replaceId: existing && existing.photo_id && existing.photo_id.indexOf('local-') !== 0 ? existing.photo_id : '' });
          row.photo_id = localId;
        });
      }
      return chain.then(function () {
        changes.push({ table: 'Animals', op: 'upsert', row: row });
        formPhoto = null;
        return commit(changes, { go: '#/animal/' + row.id, msg: id ? 'Saved' : dispName(row) + ' added' });
      });
    },

    breeding: function (form) {
      var f = fields(form);
      if (!f.cow_id) return formError(form, 'Choose the cow or heifer.');
      if (f.method === 'Natural' && !f.bull_id) return formError(form, 'Choose the bull, or switch to AI.');
      if (!f.bred_date) return formError(form, 'Enter the date she was bred.');
      var changes = [];
      var prev = pendingFor(f.cow_id);
      if (prev) changes.push({ table: 'Breedings', op: 'upsert', row: { id: prev.id, result: 'Open' } });
      var notes = f.method === 'AI' && f.ai_sire ? 'AI sire: ' + f.ai_sire + (f.notes ? ' — ' + f.notes : '') : f.notes;
      changes.push({ table: 'Breedings', op: 'upsert', row: {
        id: uuid(), cow_id: f.cow_id, bull_id: f.method === 'Natural' ? f.bull_id : '', method: f.method,
        heat_date: f.heat_date, bred_date: f.bred_date, expected_calving: addDays(f.bred_date, GESTATION_DAYS),
        result: 'Pending', notes: notes
      } });
      UI.breedTab = 'bred';
      return commit(changes, { go: '#/breeding', msg: 'Breeding logged' });
    },

    calving: function (form) {
      var f = fields(form);
      var b = byId('Breedings', form.dataset.id);
      if (!b) return formError(form, 'That breeding record is gone.');
      if (!f.calving_date) return formError(form, 'Enter the calving date.');
      var alive = f.alive !== 'no';
      if (alive && !f.tag) return formError(form, 'Give the calf an ear tag (you can change it later).');
      if (f.tag) {
        var dup = S.db.Animals.find(function (a) { return isActive(a) && String(a.tag).toLowerCase() === f.tag.toLowerCase(); });
        if (dup) return formError(form, 'Tag ' + f.tag + ' is already used by ' + dispName(dup) + '.');
      }
      var cow = byId('Animals', b.cow_id);
      var calfId = uuid();
      var changes = [
        { table: 'Animals', op: 'upsert', row: {
          id: calfId, tag: f.tag, name: f.name, breed: f.breed, sex: f.sex, birth_date: f.calving_date,
          status: alive ? 'In herd' : 'Deceased', origin: 'Born on farm', dam_id: b.cow_id, sire_id: b.bull_id,
          notes: alive ? f.notes : ('Stillborn.' + (f.notes ? ' ' + f.notes : ''))
        } },
        { table: 'Calvings', op: 'upsert', row: { id: uuid(), breeding_id: b.id, cow_id: b.cow_id, calf_id: calfId, calving_date: f.calving_date, ease: f.ease, notes: f.notes } },
        { table: 'Breedings', op: 'upsert', row: { id: b.id, result: 'Calved' } }
      ];
      if (cow && cow.sex === 'Heifer') changes.push({ table: 'Animals', op: 'upsert', row: { id: cow.id, sex: 'Cow' } });
      return commit(changes, { go: '#/animal/' + calfId, msg: 'Calving recorded' });
    },

    order: function (form) {
      var f = fields(form);
      var id = form.dataset.id;
      var existing = id ? byId('Orders', id) : null;
      if (!f.name) return formError(form, 'Enter a name.');
      if (!f.phone) return formError(form, 'Enter a phone number so you can reach them.');
      var qty = Math.max(1, parseInt(f.quantity, 10) || 1);
      var status = f.status || (existing && existing.status) || 'Waiting';
      if (f.assigned_animal_id && status === 'Waiting') status = 'Assigned';
      if (!f.assigned_animal_id && status === 'Assigned') status = 'Waiting';
      var row = {
        id: id || uuid(), name: f.name, phone: f.phone, email: f.email, share: f.share, quantity: qty,
        wanted_by: f.wanted_by, cut_notes: f.cut_notes, deposit_status: f.deposit_status, deposit_amount: f.deposit_amount,
        assigned_animal_id: f.assigned_animal_id, status: status, notes: f.notes
      };
      UI.salesTab = status === 'Assigned' ? 'assigned' : status === 'Waiting' ? 'waiting' : 'done';
      return commit([{ table: 'Orders', op: 'upsert', row: row }], { go: '#/sales', msg: id ? 'Order saved' : 'Added to the waitlist' });
    }
  };

  // ==========================================================================
  // Button actions
  // ==========================================================================
  var actions = {
    back: function () { if (history.length > 1) history.back(); else location.hash = '#/herd'; },
    cancel: function (el) { formPhoto = null; if (history.length > 1) history.back(); else location.hash = el.getAttribute('href') || '#/herd'; },
    sync: function () {
      trySync().then(function (ok) {
        toast(ok ? 'All synced' : S.offline ? 'No signal — will keep trying' : 'Couldn’t sync: ' + S.lastError);
      });
    },
    'status-filter': function (el) { var v = el.dataset.v; UI.status = UI.status === v ? '' : v; render(); },
    'sex-filter': function (el) { UI.sex = el.dataset.v; render(); },
    'breed-tab': function (el) { UI.breedTab = el.dataset.v; render(); },
    'sales-tab': function (el) { UI.salesTab = el.dataset.v; render(); },
    'set-status': function (el) {
      var a = byId('Animals', el.dataset.id);
      if (!a || st(a) === el.dataset.v) return;
      commit([{ table: 'Animals', op: 'upsert', row: { id: a.id, status: el.dataset.v } }], { msg: dispName(a) + ': ' + el.dataset.v });
    },
    'mark-open': function (el) {
      var b = byId('Breedings', el.dataset.id);
      if (!b) return;
      var cow = byId('Animals', b.cow_id);
      if (!confirm('Mark this breeding as didn’t take? ' + dispName(cow) + ' will move to the Open list.')) return;
      commit([{ table: 'Breedings', op: 'upsert', row: { id: b.id, result: 'Open' } }], { msg: dispName(cow) + ' is open' });
    },
    qty: function (el) {
      var inp = el.closest('.stepper').querySelector('input');
      inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + parseInt(el.dataset.v, 10));
    },
    assign: function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, assigned_animal_id: el.dataset.animal, status: 'Assigned' } }],
        { go: '#/sales', msg: 'Animal assigned' });
      UI.salesTab = 'assigned';
    },
    'order-filled': function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, status: 'Filled' } }], { msg: 'Marked filled' });
    },
    'order-unassign': function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, assigned_animal_id: '', status: 'Waiting' } }], { msg: 'Back on the waitlist' });
    },
    'order-reopen': function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, assigned_animal_id: '', status: 'Waiting' } }], { msg: 'Back on the waitlist' });
    },
    'delete-animal': function (el) {
      var a = byId('Animals', el.dataset.id);
      if (!a || !confirm('Delete ' + dispName(a) + ' completely? This can’t be undone. (To keep the record, set the status to Harvested or Deceased instead.)')) return;
      commit([{ table: 'Animals', op: 'delete', row: { id: a.id } }], { go: '#/herd', msg: 'Deleted' });
    },
    'delete-order': function (el) {
      var o = byId('Orders', el.dataset.id);
      if (!o || !confirm('Delete the order for ' + o.name + '? This can’t be undone.')) return;
      commit([{ table: 'Orders', op: 'delete', row: { id: o.id } }], { go: '#/sales', msg: 'Order deleted' });
    },
    'sign-out': function () {
      var warn = S.queue.length ? ' ' + S.queue.length + ' change(s) haven’t reached the Sheet yet and will be lost.' : '';
      if (!confirm('Sign out of this phone?' + warn)) return;
      lsSet('herd.passcode', '');
      S.passcode = ''; S.db = emptyDb(); S.queue = []; S.lastSync = '';
      persist().then(function () { currentKey = null; location.hash = ''; render(); });
    }
  };

  function handlePhoto(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    toast('Getting photo ready…');
    resizeImage(file).then(function (b64) {
      if (input.dataset.photoInput === 'form') {
        formPhoto = b64;
        var box = document.getElementById('form-photo');
        if (box) {
          box.querySelectorAll('img').forEach(function (i) { i.remove(); });
          var img = new Image(); img.alt = ''; img.src = 'data:image/jpeg;base64,' + b64;
          box.insertBefore(img, box.firstChild);
          box.classList.add('has-img');
          var lbl = box.querySelector('.file-btn');
          if (lbl && lbl.firstChild && lbl.firstChild.nodeType === 3) lbl.firstChild.nodeValue = 'Change photo';
        }
        toast('Photo added — tap Save');
        return;
      }
      var a = byId('Animals', input.dataset.id);
      if (!a) return;
      var localId = 'local-' + uuid();
      return idb.set('photo:' + localId, { base64: b64, mime: 'image/jpeg' }).then(function () {
        photoMem.set(localId, 'data:image/jpeg;base64,' + b64);
        return commit([
          { kind: 'photo', localId: localId, name: 'tag-' + (a.tag || ''), replaceId: a.photo_id && a.photo_id.indexOf('local-') !== 0 ? a.photo_id : '' },
          { table: 'Animals', op: 'upsert', row: { id: a.id, photo_id: localId } }
        ], { msg: 'Photo saved' });
      });
    }).catch(function (err) { toast(err.message || 'Couldn’t use that photo'); })
      .then(function () { input.value = ''; });
  }

  // ==========================================================================
  // Toast
  // ==========================================================================
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ==========================================================================
  // Wiring
  // ==========================================================================
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var fn = forms[form.dataset.form];
    if (!fn) return;
    var btns = document.querySelectorAll('button[type=submit]');
    btns.forEach(function (b) { b.disabled = true; });
    Promise.resolve().then(function () { return fn(form); })
      .catch(function (err) { formError(form, err.message || 'Something went wrong.'); })
      .then(function () { btns.forEach(function (b) { if (b.isConnected && b.textContent !== 'Connecting…') b.disabled = false; }); });
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'herd-search') {
      UI.search = t.value;
      var l = document.getElementById('herd-list');
      if (l) { l.innerHTML = herdListHTML(); hydratePhotos(); }
      return;
    }
    if (t.form && t.form.dataset.form) onFormInput(t.form);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[type=file][data-photo-input]')) handlePhoto(t);
    else if (t.form && t.form.dataset.form) onFormInput(t.form);
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('online', function () { trySync(); });
  window.addEventListener('offline', function () { S.offline = true; renderStatus(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') trySync();
  });
  setInterval(function () { if (document.visibilityState === 'visible') trySync(); }, 120000);
  setInterval(function () { if (S.queue.length) trySync(); }, 30000);
  setInterval(renderStatus, 30000);

  loadState().catch(function () {}).then(function () {
    render();
    if (S.passcode) trySync();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
