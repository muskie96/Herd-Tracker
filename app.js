/* Herd Tracker — phone app (works on Android + iPhone as an installed web app).
   Data lives in the Google Sheet; this phone keeps a copy so the app works without signal.
   Changes made without signal wait in a queue and are sent automatically when signal returns.
   (Built from the files in src/ — edit those, then join them into app.js.) */
(function () {
  'use strict';

  // ==========================================================================
  // Constants
  // ==========================================================================
  var CFG = window.HERD_CONFIG || {};
  var API_URL = CFG.API_URL || '';
  var VERSION = CFG.APP_VERSION || '1.0.0';
  var GESTATION_DAYS = 283;
  var DUE_SOON_DAYS = 60;

  // Animal statuses. Stored text → how it shows in the app.
  var STATUS_INFO = {
    'In herd':      { label: 'In herd',          short: 'In herd',   pill: 'p-herd',  btn: 's-herd',  emoji: '🐄' },
    'With cows':    { label: '🐂 In with cows',   short: 'With cows', pill: 'p-ready', btn: 's-ready', emoji: '🐂' },
    'Ready steak':  { label: '🥩 Ready – Steak',  short: '🥩 Ready',  pill: 'p-ready', btn: 's-ready', emoji: '🥩' },
    'Ready burger': { label: '🍔 Ready – Burger', short: '🍔 Ready',  pill: 'p-ready', btn: 's-ready', emoji: '🍔' },
    'Harvested':    { label: 'Harvested',        short: 'Harvested', pill: 'p-harv',  btn: 's-harv' },
    'Sold':         { label: 'Sold',             short: 'Sold',      pill: 'p-harv',  btn: 's-harv' },
    'Deceased':     { label: 'Deceased',         short: 'Deceased',  pill: 'p-dead',  btn: 's-dead' }
  };
  var CATTLE_STATUSES = ['In herd', 'Ready steak', 'Ready burger', 'Harvested', 'Sold', 'Deceased'];
  var BULL_STATUSES = ['With cows', 'In herd', 'Ready burger', 'Harvested', 'Sold', 'Deceased'];
  var ACTIVE = ['In herd', 'With cows', 'Ready steak', 'Ready burger'];
  var HEAT_CYCLE = 21;
  var OVERDUE_GRACE = 14;
  var PAST = ['Harvested', 'Sold', 'Deceased'];
  var SEXES = ['Cow', 'Heifer', 'Steer', 'Calf'];
  var ORIGINS = ['Born on farm', 'Purchased'];
  var SHARE_HEAD = { Whole: 1, Half: 0.5, Quarter: 0.25 };
  var BEEF_SHARES = ['Whole', 'Half', 'Quarter', 'Burger'];
  var PORK_SHARES = ['Whole', 'Half', 'Quarter'];
  var BREED_OPTIONS = ['Angus', 'Red Angus', 'Hereford'];   // Mix is the button beside the dropdown

  // Saved numbers (Settings tab). Key → [label, default, input type]
  var SETTING_DEFAULTS = {
    haul_auction: '', auction_commission_pct: '', haul_butcher: '',
    price_hanging: '', price_burger: '', price_pork: '',
    deposit_beef: '', deposit_pork: '',
    butcher_name: 'Matt’s Meats', butcher_city: 'Longview, WA', butcher_phone: '', butcher_cutwrap: '', butcher_kill: '',
    ladder_weights: '600, 650, 700, 750, 800', ladder_weights_pork: '160, 180, 200, 220, 240',
    hanging_pct: '60', burger_pct: '70'
  };
  // Letterhead + where invoices go (admin only; saved in the Settings tab too)
  var INVOICE_KEYS = ['farm_name', 'farm_address', 'farm_phone', 'venmo', 'invoice_email', 'invoice_auto'];
  var INVOICE_DEFAULTS = { farm_name: 'Musgrove Farms', farm_address: '164 Summit Butte Rd\nWoodland, WA 98674', farm_phone: '(360) 430-2145' };
  function invSetting(k) { var r = byId('Settings', k); return r && r.value !== '' ? r.value : (INVOICE_DEFAULTS[k] || ''); }
  function orderNoText(o) { return o.order_no ? 'Order ' + o.order_no : 'Order # after sync'; }

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
  function emptyDb() {
    return { Animals: [], Breedings: [], Calvings: [], Orders: [], Prices: [], Photos: [], Treatments: [], Settings: [], BullPeriods: [] };
  }

  var S = {
    db: emptyDb(),
    queue: [],
    lastSync: '',
    who: ls('herd.who'),
    token: ls('herd.token'),
    role: ls('herd.role') || 'admin',
    prefs: (function () { try { return JSON.parse(ls('herd.prefs') || 'null') || {}; } catch (e) { return {}; } })(),
    syncing: false,
    offline: false,
    lastError: '',
    authFailed: false,
    meta: {}
  };
  var UI = {
    search: '', sex: 'All', status: '', breedTab: 'due',
    salesMode: ls('herd.salesMode') || 'Beef', salesTab: 'waiting',
    custSort1: ls('herd.custSort1') || 'last:asc', custSort2: ls('herd.custSort2') || 'paid:desc', custSearch: '',
    market: 'all', marketView: 'prices', checkingPrices: false
  };
  var formPhoto = null;      // base64 jpeg picked in the new-animal form
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
        S.meta = st.meta || {};
      }
    });
  }
  function persist() {
    return idb.set('state', { db: S.db, queue: S.queue, lastSync: S.lastSync, meta: S.meta }).catch(function () {});
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
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, action === 'uploadPhoto' || action === 'refreshPrices' ? 90000 : action === 'save' || action === 'invoice' ? 60000 : 25000);
    var body = Object.assign({ action: action, token: S.token, who: S.who }, payload || {});
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
    if (!list) { S.db[c.table] = list = []; }
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
    if (!S.token) return Promise.resolve(false);
    if (syncPromise) return syncPromise;
    var ok = false;
    S.syncing = true;
    renderStatus();
    syncPromise = flushQueue().then(function () {
      return api('pull');
    }).then(function (res) {
      S.db = Object.assign(emptyDb(), res.data || {});
      S.meta = res.meta || {};
      if (S.meta.role && S.meta.role !== S.role) { S.role = S.meta.role; lsSet('herd.role', S.role); }
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
        S.token = '';
        lsSet('herd.token', '');
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
          base64: blob.base64, mimeType: blob.mime || 'image/jpeg', name: first.name || 'photo'
        }).then(function (res) {
          var realId = res.photo_id, localId = first.localId;
          return idb.set('photo:' + realId, blob).then(function () {
            idb.del('photo:' + localId).catch(function () {});
            if (photoMem.has(localId)) photoMem.set(realId, photoMem.get(localId));
            S.queue.slice(1).forEach(function (c) {
              if (c.row && c.row.photo_id === localId) c.row.photo_id = realId;
            });
            Object.keys(S.db).forEach(function (t) {
              (S.db[t] || []).forEach(function (r) { if (r.photo_id === localId) r.photo_id = realId; });
            });
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
    }).then(function (res) {
      (res && res.invoices || []).forEach(function (iv) {
        if (typeof toast === 'function') toast(iv.error ? 'Invoice not sent: ' + iv.error : '🧾 ' + iv.result);
      });
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
      if (id.indexOf('local-') === 0 || !S.token) return null;
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

  /** Save a picked photo for an animal: queue the upload + a Photos row (+ main photo if it has none). */
  function photoChanges(animal, b64, takenDate, makeMain) {
    var localId = 'local-' + uuid();
    return idb.set('photo:' + localId, { base64: b64, mime: 'image/jpeg' }).then(function () {
      photoMem.set(localId, 'data:image/jpeg;base64,' + b64);
      var ch = [
        { kind: 'photo', localId: localId, name: 'tag-' + (animal.tag || animal.name || 'animal') },
        { table: 'Photos', op: 'upsert', row: { id: uuid(), animal_id: animal.id, photo_id: localId, taken_date: takenDate || today() } }
      ];
      if (makeMain) ch.push({ table: 'Animals', op: 'upsert', row: { id: animal.id, photo_id: localId } });
      return ch;
    });
  }

  // ==========================================================================
  // Helpers: text, dates, numbers
  // ==========================================================================
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isAdmin() { return S.role !== 'farm'; }
  function byId(table, id) { return id ? (S.db[table] || []).find(function (r) { return r.id === id; }) : null; }

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
  function monthsBetween(from, to) {
    var b = parseD(from), n = parseD(to);
    if (!b || !n) return null;
    var m = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
    if (n.getDate() < b.getDate()) m--;
    return m;
  }
  function monthsOld(birth) { return monthsBetween(birth, today()); }
  /** "3 days", "7 mo", "4 yrs 2 mo" — age on `asOf` (default today). */
  function ageText(birth, short, asOf) {
    asOf = asOf || today();
    var m = monthsBetween(birth, asOf);
    if (m === null) return '';
    if (m < 0) return 'before birth';
    if (m < 1) { var d = daysBetween(birth, asOf); return d + (d === 1 ? ' day' : ' days'); }
    if (m < 24) return m + ' mo';
    var y = Math.floor(m / 12), r = m % 12;
    return short || !r ? y + ' yrs' : y + ' yrs ' + r + ' mo';
  }
  function relTime(isoStamp) {
    if (!isoStamp) return 'never';
    var s = (Date.now() - new Date(isoStamp).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    return fmtDate(localDateOf(isoStamp));
  }
  function sinceText(date) {
    var n = daysBetween(date, today());
    if (n === null) return '';
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n < 60) return n + ' days ago';
    var m = Math.round(n / 30.4);
    return m < 24 ? m + ' mo ago' : Math.floor(m / 12) + ' yrs ago';
  }
  function fmtHead(x) {
    var q = Math.round(x * 4) / 4;
    var whole = Math.floor(q), frac = q - whole;
    var f = frac === 0.25 ? '¼' : frac === 0.5 ? '½' : frac === 0.75 ? '¾' : '';
    if (!whole && f) return f;
    return whole + f;
  }
  function num(v) { var n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; }
  function hasNum(v) { return isFinite(parseFloat(String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, ''))); }
  function money(x, cents) {
    var n = Number(x);
    if (!isFinite(n)) return '—';
    var neg = n < 0; n = Math.abs(n);
    var s = (cents || n % 1 !== 0) && n < 1000
      ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Math.round(n).toLocaleString('en-US');
    return (neg ? '−$' : '$') + s;
  }
  function lbs(x) { return Math.round(num(x)).toLocaleString('en-US') + ' lb'; }

  // ==========================================================================
  // Helpers: animals
  // ==========================================================================
  function st(a) {
    var s = (a && a.status) || 'In herd';
    if (s === 'With cows' && !isBull(a)) return 'In herd';
    if (s === 'Ready for harvest') return 'Ready steak';
    return STATUS_INFO[s] ? s : 'In herd';
  }
  function statusLabel(s, a) {
    if (a && isBull(a) && s === 'In herd') return 'Active · not with the cows';
    return (STATUS_INFO[s] || STATUS_INFO['In herd']).label;
  }
  function isOffsite(a) { return !!a && a.offsite === 'yes' && !isBull(a); }
  function isActive(a) { return ACTIVE.indexOf(st(a)) >= 0; }
  function isBull(a) { return a && a.sex === 'Bull'; }
  function isFemale(a) { return a.sex === 'Cow' || a.sex === 'Heifer' || (a.sex === 'Calf' && a.calf_sex === 'Heifer'); }
  function canBreed(a) { return (a.sex === 'Cow' || a.sex === 'Heifer') && !isOffsite(a); }
  function origin(a) { return a.origin === 'Purchased' || a.origin === 'Leased' || isBull(a) ? 'Purchased' : 'Born on farm'; }
  function cattle() { return S.db.Animals.filter(function (a) { return !isBull(a) && !isOffsite(a); }); }
  function offsiteAnimals() { return S.db.Animals.filter(isOffsite); }
  function bulls() { return S.db.Animals.filter(isBull); }
  function dispName(a) { return a ? (a.name || (a.tag ? 'Tag ' + a.tag : 'No tag yet')) : 'Unknown'; }
  function tagName(a) {
    if (!a) return 'Unknown';
    if (a.tag && a.name) return a.tag + ' · ' + a.name;
    return a.tag || a.name || 'No tag (' + (a.sex === 'Calf' ? 'calf' : (a.sex || 'animal').toLowerCase()) + (a.birth_date ? ', born ' + fmtDate(a.birth_date) : '') + ')';
  }
  function sexText(a) {
    if (a.sex === 'Calf') return a.calf_sex ? a.calf_sex + ' calf' : 'Calf';
    return a.sex || '—';
  }
  function byTag(x, y) {
    var a = String(x.tag || ''), b = String(y.tag || '');
    if (!a !== !b) return a ? -1 : 1;                 // tagged first
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) ||
      String(x.name || '').localeCompare(String(y.name || ''));
  }
  function animalPhotos(a) {
    var list = S.db.Photos.filter(function (p) { return p.animal_id === a.id && p.photo_id; })
      .sort(function (x, y) { return String(y.taken_date).localeCompare(String(x.taken_date)); });
    if (a.photo_id && !list.some(function (p) { return p.photo_id === a.photo_id; })) {
      list.unshift({ id: 'main-' + a.id, animal_id: a.id, photo_id: a.photo_id, taken_date: '', pseudo: true });
    }
    return list;
  }
  function doses(a) {
    return S.db.Treatments.filter(function (t) { return t.animal_id === a.id; })
      .sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); });
  }
  function lastIvermectin(a) {
    return doses(a).find(function (t) { return /iver/i.test(t.product || 'Ivermectin'); }) || null;
  }

  // ==========================================================================
  // Helpers: breeding
  // ==========================================================================
  function isExposure(b) { return !b.bred_date && !!b.exposure_start; }
  function bredOn(b) { return b.bred_date || b.exposure_start || ''; }
  /** Earliest and latest expected calving. A pasture exposure gives a window; a dated breeding gives one day. */
  function dueStart(b) { return b.bred_date ? (b.expected_calving || addDays(b.bred_date, GESTATION_DAYS)) : addDays(b.exposure_start, GESTATION_DAYS); }
  function dueEnd(b) {
    if (b.bred_date) return dueStart(b);
    var end = b.exposure_end || today();
    return addDays(end < b.exposure_start ? b.exposure_start : end, GESTATION_DAYS);
  }
  function expected(b) { return dueStart(b); }
  function dueText(b, withYear) {
    var a = dueStart(b), z = dueEnd(b);
    if (a === z) return fmtDate(a, withYear);
    return fmtDate(a, withYear) + ' – ' + fmtDate(z, withYear) + (b.exposure_end ? '' : ' (so far)');
  }
  function isOverdue(b) {
    if ((b.result || 'Pending') !== 'Pending') return false;
    var d = daysBetween(dueEnd(b), today());
    return d !== null && d > OVERDUE_GRACE && (!!b.bred_date || !!b.exposure_end);
  }
  function pendingBreedings() { return S.db.Breedings.filter(function (b) { return (b.result || 'Pending') === 'Pending'; }); }
  function pendingFor(cowId) {
    return pendingBreedings().filter(function (b) { return b.cow_id === cowId; })
      .sort(function (x, y) { return String(bredOn(y)).localeCompare(String(bredOn(x))); })[0] || null;
  }
  /** Next expected heat: 21-day cycles from the most recent heat you logged (rolled forward to today or later). */
  function nextHeat(cowId) {
    var last = S.db.Breedings.filter(function (b) { return b.cow_id === cowId && b.heat_date; })
      .map(function (b) { return b.heat_date; }).sort().pop();
    if (!last) return null;
    var d = last, t = today(), n = 0;
    do { d = addDays(d, HEAT_CYCLE); n++; } while (d < t && n < 60);
    return { last: last, next: d };
  }
  function periodsFor(bullId) {
    return S.db.BullPeriods.filter(function (p) { return p.bull_id === bullId; })
      .sort(function (x, y) { return String(y.start_date).localeCompare(String(x.start_date)); });
  }
  function openPeriod(bullId) { return periodsFor(bullId).find(function (p) { return !p.end_date; }) || null; }
  /** Cows and heifers that a bull going in today would be exposed to. */
  function exposableCows() {
    var pend = {};
    pendingBreedings().forEach(function (b) { pend[b.cow_id] = true; });
    return S.db.Animals.filter(function (a) {
      if (!canBreed(a) || st(a) !== 'In herd' || pend[a.id]) return false;
      var m = monthsOld(a.birth_date);
      return a.sex === 'Cow' || m === null || m >= 12;
    });
  }
  function bullLabel(b) {
    if (b.method === 'AI') return 'AI';
    var bull = byId('Animals', b.bull_id);
    return bull ? dispName(bull) + (bull.tag && bull.name ? ' (' + bull.tag + ')' : '') : 'unknown bull';
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
  // Helpers: settings + orders
  // ==========================================================================
  function setting(key) {
    var row = byId('Settings', key);
    if (row && row.value !== '') return row.value;
    return SETTING_DEFAULTS[key] !== undefined ? SETTING_DEFAULTS[key] : '';
  }
  function product(o) { return o.product === 'Pork' ? 'Pork' : 'Beef'; }
  function splitName(full) {
    var s = String(full || '').trim().replace(/\s+/g, ' ');
    if (!s) return ['', ''];
    if (/ (family|farms?|ranch)$/i.test(s)) return [s, ''];
    var i = s.lastIndexOf(' ');
    return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
  }
  function firstName(o) { return o.first_name || (o.last_name ? '' : splitName(o.name)[0]); }
  function lastName(o) { return o.last_name || (o.first_name ? '' : splitName(o.name)[1]); }
  function fullName(o) { return [firstName(o), lastName(o)].filter(Boolean).join(' ') || o.name || 'No name'; }
  function depositPaid(o) { return !!o.deposit_paid_date || o.deposit_status === 'Paid'; }
  function finalPaid(o) { return !!o.final_paid_date || o.status === 'Filled' || o.status === 'Complete'; }
  function stage(o) {
    if (o.status === 'Cancelled') return 'Cancelled';
    if (finalPaid(o)) return 'Complete';
    if (o.assigned_animal_id && product(o) === 'Beef') return 'Assigned';
    return 'Waiting';
  }
  function isBurger(o) { return o.share === 'Burger'; }
  function orderHead(o) { return isBurger(o) ? 0 : (SHARE_HEAD[o.share] || 0) * (parseFloat(o.quantity) || 1); }
  function shareLabel(o) {
    if (isBurger(o)) return '🍔 ' + lbs(o.burger_lbs) + ' burger';
    var q = parseFloat(o.quantity) || 1;
    var unit = product(o) === 'Pork' ? ' hog' : '';
    return (product(o) === 'Beef' ? '🥩 ' : '') + (o.share || '—') + unit + (q > 1 ? ' ×' + q : '');
  }
  function requestDate(o) { return o.request_date || localDateOf(o.created_at) || ''; }
  function paidTotal(o) {
    return (depositPaid(o) ? num(o.deposit_amount) : 0) + (o.final_paid_date ? num(o.final_amount) : 0);
  }
  /** How much of an animal is already spoken for: head (steak) and lbs (burger). */
  function claimedHead(animalId, exceptOrderId) {
    return S.db.Orders.filter(function (o) {
      return o.assigned_animal_id === animalId && o.id !== exceptOrderId && stage(o) !== 'Cancelled' && !isBurger(o) && product(o) === 'Beef';
    }).reduce(function (s, o) { return s + orderHead(o); }, 0);
  }
  function claimedLbs(animalId, exceptOrderId) {
    return S.db.Orders.filter(function (o) {
      return o.assigned_animal_id === animalId && o.id !== exceptOrderId && stage(o) !== 'Cancelled' && isBurger(o);
    }).reduce(function (s, o) { return s + num(o.burger_lbs); }, 0);
  }
  function isBurgerAnimal(a) { return st(a) === 'Ready burger' || (st(a) === 'Harvested' && a.harvest_for === 'Burger'); }
  function isSteakAnimal(a) { return st(a) === 'Ready steak' || (st(a) === 'Harvested' && a.harvest_for !== 'Burger' && !!a.hanging_weight); }
  /** Suggested total for an order once the butcher's weights are in. */
  function suggestedTotal(o) {
    var a = byId('Animals', o.assigned_animal_id);
    if (isBurger(o)) {
      var p = num(setting('price_burger'));
      if (!p || !num(o.burger_lbs)) return null;
      return { total: num(o.burger_lbs) * p, how: lbs(o.burger_lbs) + ' × ' + money(p, true) + '/lb' };
    }
    if (product(o) !== 'Beef' || !a || !num(a.hanging_weight)) return null;
    var ph = num(setting('price_hanging'));
    if (!ph) return null;
    var frac = orderHead(o);
    return { total: num(a.hanging_weight) * frac * ph, how: lbs(a.hanging_weight) + ' hanging × ' + fmtHead(frac) + ' × ' + money(ph, true) + '/lb' };
  }
  function digits(s) { return String(s || '').replace(/[^\d+]/g, ''); }
  function custKey(o) {
    var d = String(o.phone || '').replace(/\D/g, '');
    if (d.length >= 7) return 'p' + d.slice(-10);
    if (o.email) return 'e' + String(o.email).toLowerCase().trim();
    return 'n' + fullName(o).toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
    warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 2),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 2),
    link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    market: svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    chev: svg('<path d="M6 9l6 6 6-6"/>', 2),
    right: svg('<path d="M9 6l6 6-6 6"/>', 2),
    syringe: svg('<path d="M18 2l4 4M17 7l3-3M19 9L9 19l-4 1 1-4L16 6zM12 9l3 3M9 12l3 3M3 21l3-3"/>'),
    knife: svg('<path d="M3 21L14 10M14 10l6-6a2 2 0 0 1 0 3l-4 5-2-2z"/>'),
    star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    sort: svg('<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>'),
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>'),
    order: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>'),
    heat: svg('<path d="M12 3c2 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-7.5z"/>'),
    more: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', 2.2),
    chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    scale: svg('<path d="M12 3v18M5 21h14M4 7h16M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z"/>')
  };

  // ==========================================================================
  // Shared pieces
  // ==========================================================================
  function earTag(tag, size) {
    var t = String(tag || '');
    if (!t) return '<span class="tag notag ' + (size || '') + '" aria-label="No ear tag">—</span>';
    return '<span class="tag ' + (size || '') + (t.length > 3 ? ' long' : '') + (t.length > 5 ? ' xlong' : '') + '">' + esc(t) + '</span>';
  }
  function thumb(a) {
    return '<span class="thumb"><span class="ph"' + (a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' +
      I.camera + '</span>' + earTag(a.tag, 'sm') + '</span>';
  }
  function statusPill(s, a) {
    var m = STATUS_INFO[s] || STATUS_INFO['In herd'];
    if (m.emoji) return '<span class="emo-badge" role="img" aria-label="' + esc(statusLabel(s, a).replace(/^\S+ /, '')) + '" title="' + esc(statusLabel(s, a)) + '">' + m.emoji + '</span>';
    return '<span class="pill ' + m.pill + '">' + esc(m.short) + '</span>';
  }
  function animalSub(a) {
    var parts = [];
    if (a.breed) parts.push(a.breed);
    parts.push(sexText(a));
    var age = ageText(a.birth_date, true);
    if (age) parts.push(age);
    return parts.join(' · ');
  }
  function animalRow(a) {
    var s = st(a), info = STATUS_INFO[s] || {};
    var mark = s === 'In herd' ? '' : info.emoji
      ? '<span class="emo-badge sm" role="img" aria-label="' + esc(statusLabel(s, a).replace(/^\S+ /, '')) + '">' + info.emoji + '</span>'
      : '<span class="pill ' + info.pill + '">' + esc(info.short) + '</span>';
    return '<a class="row" href="#/animal/' + esc(a.id) + '"><span class="thumb solo"><span class="ph"' + (a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' +
      I.camera + '</span></span>' +
      '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
      '<span class="row-sub">' + esc(animalSub(a)) + '</span>' + (mark && !info.emoji ? '<span class="row-sub">' + mark + '</span>' : '') + '</span>' +
      '<span class="row-end">' + (info.emoji && s !== 'In herd' ? mark : '') + earTag(a.tag, 'md') + '</span></a>';
  }

  var NAV_ITEMS = {
    herd: ['#/herd', 'Herd', I.herd], breeding: ['#/breeding', 'Breeding', I.cal], bulls: ['#/bulls', 'Bulls', I.bull],
    sales: ['#/sales', 'Sales', I.sales], market: ['#/market', 'Market', I.market], add: ['#/add', 'Add', I.add],
    customers: ['#/customers', 'Customers', I.users], neworder: ['#/order/new', 'New order', I.order],
    logheat: ['#/breeding/new', 'Log heat', I.heat], compare: ['#/compare', 'VS.', I.scale],
    reports: ['#/reports', 'Reports', I.chart],
    settings: ['#/settings', 'Settings', I.gear],
    more: ['', 'More', I.more]
  };
  var NAV_DEFAULT = ['herd', 'breeding', 'bulls', 'sales', 'market', 'add'];
  var SIDE_DEFAULT = ['herd', 'breeding', 'bulls', 'sales', 'customers', 'market', 'reports', 'add', 'neworder', 'logheat'];
  var NAV_ALL = ['herd', 'breeding', 'bulls', 'sales', 'market', 'add', 'reports', 'customers', 'neworder', 'logheat', 'compare', 'settings', 'more'];
  var NAV_MAX = { bar: 6, side: NAV_ALL.length };
  function isDesk() { return !!(window.matchMedia && matchMedia('(min-width: 1024px)').matches); }
  function navLabel(k, kind) { return kind === 'side' && k === 'add' ? 'Add animal' : NAV_ITEMS[k][1]; }
  /** This device's bottom bar ('bar') or computer left menu ('side'), chosen in Settings and saved per device name. */
  /** Before v1.12, "More" on the bar was just a link to Settings (saved as 'settings'). Turn it into the real More. */
  function migrateNavPrefs() {
    if (!S.prefs || S.prefs.navV >= 2) return;
    var n = Array.isArray(S.prefs.nav) ? S.prefs.nav.map(function (k) { return k === 'settings' ? 'more' : k; }) : S.prefs.nav;
    S.prefs = Object.assign({}, S.prefs, { nav: n, navV: 2 });
    if (S.token && typeof savePrefs === 'function') savePrefs(); else lsSet('herd.prefs', JSON.stringify(S.prefs));
  }
  function navOrder(kind) {
    kind = kind || 'bar';
    migrateNavPrefs();
    var saved = S.prefs && Array.isArray(S.prefs[kind === 'side' ? 'side' : 'nav']) ? S.prefs[kind === 'side' ? 'side' : 'nav'] : null;
    var list = (saved || (kind === 'side' ? SIDE_DEFAULT : NAV_DEFAULT)).filter(function (k, i, arr) { return NAV_ITEMS[k] && arr.indexOf(k) === i; });
    if (!list.length) list = (kind === 'side' ? SIDE_DEFAULT : NAV_DEFAULT).slice();
    return list;
  }
  /** What the More pop-out lists: every page not already on the bar/menu, A→Z. */
  function moreKeys(list, kind) {
    return NAV_ALL.filter(function (k) { return k !== 'more' && list.indexOf(k) < 0 && !(kind === 'side' && k === 'settings'); })
      .sort(function (a, b) { return navLabel(a, kind).localeCompare(navLabel(b, kind)); });
  }
  function navLink(k, active, kind, list) {
    var it = NAV_ITEMS[k];
    if (k === 'more') {
      var inMore = moreKeys(list, kind).indexOf(active) >= 0;
      return '<button type="button" class="nav-more' + (inMore ? ' on' : '') + '" data-action="more-menu" data-kind="' + kind + '" aria-haspopup="true" aria-expanded="false">' + it[2] + it[1] + '</button>';
    }
    return '<a href="' + it[0] + '"' + (k === active ? ' class="on" aria-current="page"' : '') + '>' + it[2] + navLabel(k, kind) + '</a>';
  }
  function nav(active) {
    var keys = navOrder('bar');
    // With no Herd page (its gear opens Settings) and no Settings/More on the bar, add More so nothing is out of reach.
    if (keys.indexOf('herd') < 0 && keys.indexOf('settings') < 0 && keys.indexOf('more') < 0) keys = keys.concat(['more']);
    return '<nav class="nav" aria-label="Main" style="grid-template-columns:repeat(' + keys.length + ', minmax(0, 1fr))">' +
      keys.map(function (k) { return navLink(k, active, 'bar', keys); }).join('') + '</nav>';
  }
  /** Computer screens: a fixed menu down the left (the bottom bar hides). Settings is always at the bottom. */
  function sideNav(active) {
    var keys = navOrder('side').filter(function (k) { return k !== 'settings'; });
    return '<nav class="side-nav" aria-label="Main menu"><a class="side-brand" href="#/herd"><img src="brand/emblem-color.png" alt="">' +
      '<span>Musgrove Farms</span></a><div class="side-group">' +
      keys.map(function (k) { return navLink(k, active, 'side', keys); }).join('') + '</div>' +
      '<div class="side-foot"><a href="#/settings"' + (active === 'settings' ? ' class="on" aria-current="page"' : '') + '>' + I.gear + 'Settings</a></div></nav>';
  }
  /** The More pop-out, anchored to the button that opened it. */
  function openMoreMenu(btn) {
    closeMoreMenu();
    var kind = btn.dataset.kind;
    var list = kind === 'side' ? navOrder('side').filter(function (k) { return k !== 'settings'; }) : navOrder('bar');
    var keys = moreKeys(list, kind);
    var box = document.createElement('div');
    box.className = 'more-pop more-' + kind;
    box.id = 'more-pop';
    box.setAttribute('role', 'menu');
    box.innerHTML = '<span class="more-title">More</span>' + (keys.length ? keys.map(function (k) {
      var it = NAV_ITEMS[k];
      return '<a role="menuitem" href="' + it[0] + '">' + it[2] + navLabel(k, kind) + '</a>';
    }).join('') : '<span class="hint">Everything is already on your ' + (kind === 'side' ? 'menu' : 'bar') + '.</span>');
    document.body.appendChild(box);
    var r = btn.getBoundingClientRect();
    if (kind === 'side') {
      box.style.left = (r.right + 8) + 'px';
      box.style.top = Math.max(8, Math.min(r.top - 8, window.innerHeight - box.offsetHeight - 8)) + 'px';
    } else {
      box.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      box.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    }
    btn.setAttribute('aria-expanded', 'true');
    var first = box.querySelector('a'); if (first) first.focus();
  }
  function closeMoreMenu() {
    var box = document.getElementById('more-pop');
    if (box) box.remove();
    document.querySelectorAll('[data-action="more-menu"][aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
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
  function backHeader(title, href) {
    return '<header class="form-hdr"><a class="link-btn left" href="' + href + '" data-action="back">' + I.back + 'Back</a>' +
      '<h1 class="h2">' + esc(title) + '</h1><span></span></header>';
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
  function dateField(name, label, value, opts2) {
    opts2 = opts2 || {};
    return '<label class="field"><span class="lbl">' + esc(label) + '</span><span class="date-row">' +
      '<input class="inp" type="date" name="' + name + '" value="' + esc(value || '') + '"' + (opts2.max ? ' max="' + opts2.max + '"' : '') + '>' +
      (opts2.todayBtn ? '<button type="button" class="btn btn-line btn-sm" data-action="set-today" data-for="' + name + '">Today</button>' : '') +
      '</span>' + (opts2.hint ? '<span class="hint">' + opts2.hint + '</span>' : '') + '</label>';
  }
  function moneyField(name, label, value, hint, ph) {
    return '<label class="field"><span class="lbl">' + esc(label) + '</span><span class="money-inp"><span aria-hidden="true">$</span>' +
      '<input class="inp" name="' + name + '" inputmode="decimal" value="' + esc(value || '') + '" placeholder="' + esc(ph || '0.00') + '"></span>' +
      (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>';
  }

  // ==========================================================================
  // Screen: sign-in (kept deliberately bare — it's the only screen strangers can see)
  // ==========================================================================
  function viewSetup() {
    return '<div class="setup"><form class="setup-inner" data-form="setup" novalidate>' +
      '<img class="setup-emblem" src="brand/emblem-color.png" alt="Musgrove Farms" width="280" height="200">' +
      '<div><h1 class="h1">Herd Tracker</h1></div>' +
      '<label class="field"><span class="lbl">Device Name:</span>' +
      '<input class="inp" name="who" autocomplete="off" autocapitalize="words" placeholder="e.g. Shop Phone" value="' + esc(S.who) + '" required></label>' +
      '<label class="field"><span class="lbl">Access Code</span>' +
      '<input class="inp" name="passcode" type="password" autocomplete="current-password" required></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button class="btn btn-accent btn-block" type="submit">Sign in</button></form></div>';
  }

  // ==========================================================================
  // Screen: herd list (cows, heifers, steers, calves — bulls live on their own page,
  // offsite purchases and past animals behind their own chips)
  // ==========================================================================
  var HERD_TILES = [['In herd', '🐄', 'In herd'], ['Ready steak', '🥩', 'Ready for steak'], ['Ready burger', '🍔', 'Ready for burger']];
  var HERD_CHIPS = ['All', 'Cows', 'Heifers', 'Steers', 'Calves', 'Offsite', 'Past'];
  /** Only offer the filters that match something in the herd right now. */
  function chipCount(c) {
    if (c === 'Offsite') return offsiteAnimals().length;
    if (c === 'Past') return cattle().filter(function (a) { return PAST.indexOf(st(a)) >= 0; }).length;
    var pool = cattle().filter(isActive);
    if (UI.status && UI.sex !== 'Offsite' && UI.sex !== 'Past') pool = pool.filter(function (a) { return st(a) === UI.status; });
    return pool.filter(function (a) { return sexMatch(a, c); }).length;
  }
  function herdPool() {
    if (UI.sex === 'Offsite') return offsiteAnimals();
    if (UI.sex === 'Past') return cattle().filter(function (a) { return PAST.indexOf(st(a)) >= 0; });
    var all = cattle().filter(isActive);
    return UI.status ? all.filter(function (a) { return st(a) === UI.status; }) : all;
  }
  function sexMatch(a, chip) {
    if (chip === 'All' || chip === 'Offsite' || chip === 'Past') return true;
    return a.sex === { Cows: 'Cow', Heifers: 'Heifer', Steers: 'Steer', Calves: 'Calf' }[chip];
  }
  function herdListHTML() {
    var q = UI.search.trim().toLowerCase();
    var list = herdPool().filter(function (a) { return sexMatch(a, UI.sex); }).filter(function (a) {
      if (!q) return true;
      return [a.tag, a.name, a.breed, a.tag_history].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    }).sort(byTag);
    if (!cattle().length && !offsiteAnimals().length) {
      return '<div class="empty"><b>No animals yet</b>Add your first cow, or paste rows into the Animals tab of the Sheet.' +
        '<a class="btn btn-accent" href="#/add">' + I.plus + 'Add an animal</a></div>';
    }
    if (!list.length) {
      return '<div class="empty"><b>' + (UI.sex === 'Offsite' ? 'No offsite purchases' : UI.sex === 'Past' ? 'No past animals yet' : 'No matches') + '</b>' +
        (UI.sex === 'Offsite' ? 'Animals bought to go straight to the butcher show up here.' : 'Try a different search or filter.') + '</div>';
    }
    return list.map(animalRow).join('');
  }
  function viewHerd() {
    var all = cattle();
    var count = function (k) { return all.filter(function (a) { return st(a) === k; }).length; };
    var chips = HERD_CHIPS.filter(function (c) { return c === 'All' || c === UI.sex || chipCount(c) > 0; });
    if (chips.indexOf(UI.sex) < 0) UI.sex = 'All';
    var special = UI.sex === 'Offsite' || UI.sex === 'Past';
    var note = UI.sex === 'Offsite' ? 'Bought offsite to go straight to the butcher — not part of the herd'
      : UI.sex === 'Past' ? 'Harvested, sold and deceased'
      : UI.status ? 'Showing ' + statusLabel(UI.status).replace(/^\S+ /, '').toLowerCase() + ' · tap the box again to show everyone' : '';
    return '<div class="screen">' +
      '<header class="hdr home-hdr"><div class="hdr-row brand-row"><img class="emblem" src="brand/emblem-color.png" alt="Musgrove Farms" width="98" height="70">' +
      '<div class="hdr-titles"><h1 class="h1">Our Herd</h1><span class="sync-ind" id="sync-ind">' + syncIndHTML() + '</span></div>' +
      '<a class="icon-btn" href="#/settings" aria-label="Settings">' + I.gear + '</a></div>' +
      '<div class="stats three">' + HERD_TILES.map(function (t) {
        var on = !special && UI.status === t[0];
        return '<button type="button" class="stat emo' + (on ? ' on' : '') + '" data-action="status-filter" data-v="' + esc(t[0]) +
          '" aria-pressed="' + on + '" aria-label="' + esc(t[2]) + ': ' + count(t[0]) + '"><span class="stat-emo" aria-hidden="true">' + t[1] + '</span><b>' + count(t[0]) + '</b></button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' +
      '<label class="search">' + I.search + '<input id="herd-search" type="search" placeholder="Search tag, old tag, name or breed" aria-label="Search herd" value="' + esc(UI.search) + '"></label>' +
      (chips.length > 1 ? '<div class="chips" role="group" aria-label="Filter">' + chips.map(function (c) {
        var n = c === 'All' ? (special ? '' : herdPool().length) : chipCount(c);
        return '<button type="button" class="chip' + (UI.sex === c ? ' on' : '') + (c === 'Offsite' || c === 'Past' ? ' chip-alt' : '') +
          '" data-action="sex-filter" data-v="' + c + '">' + c + (n !== '' ? ' <span class="chip-n">' + n + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '') +
      (note ? '<span class="list-note">' + esc(note) + '</span>' : '') +
      '<div class="list" id="herd-list">' + herdListHTML() + '</div></div>' + nav('herd') + '</div>';
  }

  // ==========================================================================
  // Screen: animal profile (cattle and bulls)
  // ==========================================================================
  function statusChoices(a) {
    if (isBull(a)) return BULL_STATUSES;
    if (isOffsite(a)) return ['Ready steak', 'Ready burger', 'Harvested', 'Sold'];
    return CATTLE_STATUSES;
  }
  function viewAnimal(id) {
    var a = byId('Animals', id);
    if (!a) return viewNotFound('That animal isn’t here anymore.');
    var bull = isBull(a), offsite = isOffsite(a);
    var home = bull ? '#/bulls' : '#/herd';
    var offspring = S.db.Animals.filter(function (x) { return x.dam_id === a.id || x.sire_id === a.id; })
      .sort(function (x, y) { return String(y.birth_date).localeCompare(String(x.birth_date)); });
    var photos = animalPhotos(a);

    var html = '<div class="screen">' +
      '<div class="hero"><div class="ph"' + (a.photo_id ? ' data-photo="' + esc(a.photo_id) + '"' : '') + '>' + I.camera +
      '<span class="ph-label">No photo yet</span></div>' +
      '<div class="hero-btns"><a class="icon-btn" href="' + home + '" data-action="back" aria-label="Back">' + I.back + '</a>' +
      '<a class="btn btn-sm btn-pill" href="#/animal/' + esc(a.id) + '/edit">Edit</a></div>' +
      '<div class="hero-photo-btn"><label class="btn btn-sm btn-pill file-btn">' + I.camera + 'Add photo' +
      '<input type="file" accept="image/*" data-photo-input="gallery" data-id="' + esc(a.id) + '"></label></div></div>' +
      '<div class="hero-id">' + earTag(a.tag, 'lg') + '<div class="names"><h1 class="animal-name">' + esc(dispName(a)) + '</h1>' +
      '<span class="meta">' + esc((bull ? [a.breed, 'Bull'] : [a.breed, sexText(a), ageText(a.birth_date)]).filter(Boolean).join(' · ')) + '</span></div></div>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content" style="padding-top:20px">' +
      (offsite ? '<div class="info">' + I.info + '<span><strong>Offsite purchase.</strong> Bought to go straight to the butcher — not counted in the herd, but you can assign it to waitlist orders.</span></div>' : '') +

      (bull ? '<div class="info">' + I.bull + '<span><strong>' + esc(statusLabel(st(a), a)) + '.</strong> ' +
        (st(a) === 'With cows' || isActive(a) ? 'Put him in with the cows or take him out from the <a class="link-inline" href="#/breeding">Breeding page</a>.' : '') + '</span></div>'
      : '<section class="field"><h2 class="sec-title">Status</h2><div class="status-grid">' + statusChoices(a).map(function (s) {
        var on = st(a) === s;
        return '<button type="button" class="' + STATUS_INFO[s].btn + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-action="set-status" data-id="' + esc(a.id) + '" data-v="' + esc(s) + '">' +
          (on ? I.check : '') + esc(statusLabel(s, a)) + '</button>';
      }).join('') + '</div></section>');

    html += harvestCard(a);

    if (bull) {
      html += '<section class="card"><div class="kv">' +
        '<div><span>Ear tag</span><b>' + esc(a.tag || 'None') + '</b></div>' +
        '<div><span>Breed</span><b>' + esc(a.breed || '—') + '</b></div>' +
        (a.tag_history ? '<div style="grid-column:1/-1"><span>Previous tags</span><b>' + esc(a.tag_history) + '</b></div>' : '') +
        '</div></section>';
      html += bullPeriodsCard(a);
      html += bullStatsCard(a);
    } else {
      html += '<section class="card"><div class="kv">' +
        '<div><span>Ear tag</span><b>' + esc(a.tag || 'None yet') + '</b></div>' +
        '<div><span>Breed</span><b>' + esc(a.breed || '—') + '</b></div>' +
        '<div><span>Sex</span><b>' + esc(sexText(a)) + '</b></div>' +
        '<div><span>Born</span><b>' + esc(fmtDate(a.birth_date, true)) + '</b></div>' +
        '<div><span>Origin</span><b>' + esc(offsite ? 'Purchased · offsite' : origin(a)) + '</b></div>' +
        (origin(a) === 'Purchased' && !offsite ? '<div><span>Added to herd</span><b>' + esc(fmtDate(a.joined_date, true)) + '</b></div>' : '') +
        (origin(a) === 'Purchased' ? '<div><span>Purchase price</span><b>' + (hasNum(a.purchase_price) ? money(a.purchase_price) : '—') + '</b></div>' : '') +
        (a.tag_history ? '<div style="grid-column:1/-1"><span>Previous tags</span><b>' + esc(a.tag_history) + '</b></div>' : '') +
        '</div></section>';
    }

    if (!bull) html += ivermectinCard(a);
    html += photosCard(a, photos);

    if (canBreed(a)) html += femaleBreedingCard(a);

    if (!offsite) {
      html += '<section class="card"><div class="card-head"><h2 class="sec-title">' + (bull ? 'Offspring' : 'Lineage') + '</h2>' +
        (!bull ? '<a class="link-inline" href="#/animal/' + esc(a.id) + '/edit#lineage">Edit</a>' : '') + '</div>' +
        (!bull ? '<div class="lineage">' + parentBox('Dam (mother)', byId('Animals', a.dam_id), a.dam_name) + parentBox('Sire (father)', byId('Animals', a.sire_id), a.sire_name) + '</div>' : '') +
        '<div class="sub-list">' + (!bull ? '<span class="hint" style="padding-bottom:6px">Offspring (' + offspring.length + ')</span>' : '') +
        (offspring.length ? offspring.map(function (k) {
          var other = k.dam_id === a.id ? byId('Animals', k.sire_id) : byId('Animals', k.dam_id);
          var rel = k.dam_id === a.id ? (other ? ' · by ' + dispName(other) : '') : (other ? ' · out of ' + dispName(other) : '');
          return '<a href="#/animal/' + esc(k.id) + '"><span><strong>' + esc(k.tag || k.name || 'No tag') + '</strong> · ' + esc(sexText(k) + rel) + '</span><span class="when">' + esc(fmtMonth(k.birth_date)) + '</span></a>';
        }).join('') : '<span class="li muted">None recorded</span>') + '</div></section>';
    }

    if (canBreed(a)) {
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
    html += '</div>' + nav(bull ? 'bulls' : 'herd') + '</div>';
    return html;
  }

  function parentBox(label, p, typed) {
    if (!p) {
      return '<div><span class="lbl">' + label + '</span><span class="nm">' + esc(typed || 'Unknown') + '</span>' +
        (typed ? '<span class="gp">Not in the app</span>' : '') + '</div>';
    }
    var gp = [byId('Animals', p.dam_id), byId('Animals', p.sire_id)].filter(Boolean).map(dispName);
    return '<a href="#/animal/' + esc(p.id) + '"><span class="lbl">' + label + '</span><span class="nm">' + esc(tagName(p)) + '</span>' +
      '<span class="gp">' + esc(p.breed || '') + (gp.length ? (p.breed ? ' · ' : '') + 'from ' + gp.join(' & ') : '') + '</span></a>';
  }

  function harvestCard(a) {
    var s = st(a);
    if (s === 'In herd' || s === 'Deceased' || s === 'With cows') return '';
    var href = '#/animal/' + esc(a.id) + '/harvest';
    if (s === 'Sold') {
      return '<section class="card"><div class="card-head"><h2 class="sec-title">Sale</h2><a class="link-inline" href="' + href + '">Edit</a></div>' +
        '<div class="kv"><div><span>Sold on</span><b>' + esc(fmtDate(a.harvest_date, true)) + '</b></div>' +
        '<div><span>Sale price</span><b>' + (hasNum(a.sale_price) ? money(a.sale_price) : '—') + '</b></div></div></section>';
    }
    var has = a.harvest_date || a.hanging_weight || a.burger_lbs;
    if (!has) {
      return '<section class="card dark"><div class="card-head"><h2 class="sec-title">Butcher results</h2>' +
        (s !== 'Harvested' ? '<span class="pill p-accent">' + esc(STATUS_INFO[s].short) + '</span>' : '') + '</div>' +
        '<span class="muted" style="font-size:14px">' + (s === 'Harvested' ? 'Add the hanging weight' + (a.harvest_for === 'Burger' ? ' and burger lbs' : '') + ' when the butcher sends them.'
          : 'After harvest, log the weights the butcher gives you here.') + '</span>' +
        '<a class="btn btn-accent" href="' + href + '">' + I.knife + 'Log butcher results</a></section>';
    }
    var claimed = a.harvest_for === 'Burger' ? claimedLbs(a.id) : 0;
    return '<section class="card"><div class="card-head"><h2 class="sec-title">Butcher results</h2><a class="link-inline" href="' + href + '">Edit</a></div>' +
      '<div class="kv"><div><span>Harvested</span><b>' + esc(fmtDate(a.harvest_date, true)) + '</b></div>' +
      '<div><span>For</span><b>' + (a.harvest_for === 'Burger' ? '🍔 Burger' : '🥩 Steak shares') + '</b></div>' +
      '<div><span>Hanging weight</span><b>' + (hasNum(a.hanging_weight) ? lbs(a.hanging_weight) : '—') + '</b></div>' +
      (a.harvest_for === 'Burger' || hasNum(a.burger_lbs) ? '<div><span>Burger</span><b>' + (hasNum(a.burger_lbs) ? lbs(a.burger_lbs) + (claimed ? ' · ' + lbs(claimed) + ' sold' : '') : '—') + '</b></div>' : '') +
      (a.butcher ? '<div><span>Butcher</span><b>' + esc(a.butcher) + '</b></div>' : '') +
      '</div>' + (a.harvest_notes ? '<p class="hint" style="margin:0;font-size:14px">' + esc(a.harvest_notes) + '</p>' : '') + '</section>';
  }

  function ivermectinCard(a) {
    var last = lastIvermectin(a);
    var hist = doses(a).slice(0, 5);
    return '<section class="card"><div class="card-head"><h2 class="sec-title">Ivermectin</h2>' +
      '<a class="btn btn-dark btn-sm" href="#/animal/' + esc(a.id) + '/dose">' + I.syringe + 'Log dose</a></div>' +
      (last ? '<div class="dose-last"><b>' + esc(fmtDate(last.date, true)) + '</b><span>' + esc(sinceText(last.date)) + (last.dose ? ' · ' + esc(last.dose) : '') + '</span></div>'
        : '<p class="hint" style="margin:0;font-size:14px">No doses logged yet.</p>') +
      (hist.length > 1 ? '<div class="sub-list">' + hist.slice(1).map(function (t) {
        return '<span class="li"><span>' + esc(t.product || 'Ivermectin') + (t.dose ? ' · ' + esc(t.dose) : '') + '</span><span class="when">' + esc(fmtDate(t.date, true)) + '</span></span>';
      }).join('') + '</div>' : '') + '</section>';
  }

  function photosCard(a, photos) {
    return '<section class="card"><div class="card-head"><h2 class="sec-title">Photos (' + photos.length + ')</h2></div>' +
      '<div class="gallery">' + photos.map(function (p) {
        var age = p.taken_date && a.birth_date ? ageText(a.birth_date, false, p.taken_date) : '';
        var label = p.taken_date ? (age || fmtDate(p.taken_date)) : 'No date';
        return '<a class="g-item" href="#/photo/' + esc(p.id) + '"><span class="ph" data-photo="' + esc(p.photo_id) + '">' + I.camera + '</span>' +
          '<span class="g-age">' + esc(label) + '</span>' + (p.photo_id === a.photo_id ? '<span class="g-main" aria-label="Main photo">' + I.star + '</span>' : '') + '</a>';
      }).join('') +
      '<label class="g-add file-btn">' + I.plus + '<span>Add</span><input type="file" accept="image/*" data-photo-input="gallery" data-id="' + esc(a.id) + '"></label>' +
      '</div><span class="hint">' + (a.birth_date ? 'Each photo is tagged with ' + esc(dispName(a)) + '’s age on the day it was taken. ' : '') + 'Tap one to change its date.</span></section>';
  }

  function femaleBreedingCard(a) {
    var b = pendingFor(a.id);
    var lastCalf = S.db.Calvings.filter(function (c) { return c.cow_id === a.id; })
      .sort(function (x, y) { return String(y.calving_date).localeCompare(String(x.calving_date)); })[0];
    var lastLine = lastCalf ? 'Last calved ' + fmtDate(lastCalf.calving_date, true) : 'No calvings recorded';
    if (!b) {
      var h = nextHeat(a.id);
      return '<section class="card dark"><div class="card-head"><h2 class="sec-title">Breeding</h2><span class="pill p-harv">Open</span></div>' +
        '<span class="muted" style="font-size:14px">Not bred right now · ' + esc(lastLine) + '</span>' +
        (h ? '<span class="muted" style="font-size:14px">Next heat ≈ <strong class="hl">' + esc(fmtDate(h.next)) + '</strong> (21-day cycle from ' + esc(fmtDate(h.last)) + ')</span>' : '') +
        (isActive(a) ? '<a class="btn btn-accent" href="#/breeding/new?cow=' + esc(a.id) + '">' + I.plus + 'Log heat or breeding</a>' : '') + '</section>';
    }
    var exposure = isExposure(b);
    var start = bredOn(b);
    var elapsed = daysBetween(start, today()) || 0;
    var pct = Math.max(0, Math.min(100, Math.round(elapsed / GESTATION_DAYS * 100)));
    var over = isOverdue(b);
    return '<section class="card dark"><div class="card-head"><h2 class="sec-title">Breeding</h2><span class="pill ' + (over ? 'p-dead' : 'p-accent') + '">' + (over ? 'Overdue' : exposure ? 'Exposed' : 'Bred') + '</span></div>' +
      '<span class="muted" style="font-size:14px">' + (exposure
        ? 'In with <strong class="hl">' + esc(bullLabel(b)) + '</strong> ' + esc(fmtDate(b.exposure_start, true)) + (b.exposure_end ? ' – ' + esc(fmtDate(b.exposure_end, true)) : ' – still in')
        : 'Bred to <strong class="hl">' + esc(bullLabel(b)) + '</strong> on ' + esc(fmtDate(b.bred_date, true))) + '</span>' +
      '<span class="muted" style="font-size:14px">' + (exposure ? 'Calving window' : 'Expected calving') + '</span>' +
      '<span class="big-num accent-text"' + (exposure ? ' style="font-size:26px"' : '') + '>' + esc(dueText(b, true)) + '</span>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<span class="muted" style="font-size:12px">' + (over ? 'Window passed ' + daysBetween(dueEnd(b), today()) + ' days ago — record the calf or mark didn’t take'
        : elapsed + ' of ~' + GESTATION_DAYS + ' days' + (exposure ? ' since he went in' : '')) + ' · ' + esc(lastLine) + '</span>' +
      '<div class="btn-row"><a class="btn btn-accent" href="#/breeding/' + esc(b.id) + '/calve">Record calving</a>' +
      '<button type="button" class="btn btn-line" data-action="mark-open" data-id="' + esc(b.id) + '">Didn’t take</button></div></section>';
  }

  // ==========================================================================
  // Screen: add / edit animal (cattle form, or bull form from the Bulls page)
  // ==========================================================================
  /** Every breed the dropdown offers: the standard list plus any typed-in breed already used on the farm. */
  function breedChoices() {
    var list = BREED_OPTIONS.slice();
    S.db.Animals.forEach(function (x) {
      splitBreed(x.breed).forEach(function (p) { if (p && list.indexOf(p) < 0) list.push(p); });
    });
    return list;
  }
  /** "Hereford / Angus" → ['Hereford','Angus'] · "Hereford Mix" → ['Hereford',''] · "Mix" → ['',''] */
  function splitBreed(v) {
    v = String(v || '').trim();
    if (!v) return [];
    if (/^mix(ed)?$/i.test(v)) return ['', ''];
    if (v.indexOf(' / ') >= 0) return v.split(' / ').map(function (x) { return x.trim(); });
    var m = v.match(/^(.+?)\s+(mix|cross)$/i);
    if (m) return [m[1], ''];
    return [v];
  }
  /** Breed: a dropdown, and a Mix button that opens a second dropdown → saved as "Hereford / Angus". */
  function breedPicker(current) {
    var choices = breedChoices();
    var parts = splitBreed(current);
    var isMix = parts.length > 1;
    var one = function (name, value, empty) {
      var picked = value ? (choices.indexOf(value) >= 0 ? value : '__other') : '';
      return '<select class="inp" name="' + name + '" aria-label="' + (name === 'breed_pick' ? 'Breed' : 'Crossed with') + '">' +
        selectOpts(choices.map(function (c) { return { value: c, label: c }; }).concat([{ value: '__other', label: '+ Add your own' }]), picked, empty) + '</select>' +
        '<input class="inp" name="' + name.replace('pick', 'other') + '" data-show-when="' + name + ':__other" value="' + esc(picked === '__other' ? value : '') + '" placeholder="Type the breed" aria-label="Type the breed">';
    };
    return '<fieldset class="field breed-field"><legend class="lbl">Breed</legend>' +
      '<div class="breed-row"><div class="breed-main">' + one('breed_pick', parts[0] || '', isMix ? 'Not sure' : 'Choose…') + '</div>' +
      '<label class="mix-btn"><input type="checkbox" name="breed_mix" value="yes"' + (isMix ? ' checked' : '') + '><span>Mix</span></label></div>' +
      '<div class="breed-x" data-show-when="breed_mix:yes"><span class="breed-x-l">Crossed with</span><div class="breed-main">' + one('breed_pick2', parts[1] || '', 'Not sure') + '</div></div>' +
      '<span class="hint" data-show-when="breed_mix:yes">Saved like “Hereford / Angus”. Leave one as Not sure if you only know half.</span></fieldset>';
  }
  /** Turn the form's breed fields back into one value. */
  function breedFromForm(f) {
    var get = function (k) { return f['breed_pick' + k] === '__other' ? (f['breed_other' + k] || '') : (f['breed_pick' + k] || ''); };
    var a = get(''), b = f.breed_mix === 'yes' ? get('2') : null;
    if (b === null) return a;
    if (a && b && a !== b) return a + ' / ' + b;
    if (a || b) return (a || b) + ' Mix';
    return 'Mix';
  }
  function parentPicker(kind, a) {
    var isDam = kind === 'dam';
    var pool = isDam ? S.db.Animals.filter(function (x) { return canBreed(x) && x.id !== a.id; }) : bulls().filter(function (x) { return x.id !== a.id; });
    var list = pool.sort(byTag).map(function (x) { return { value: x.id, label: tagName(x) + (isActive(x) ? '' : ' (' + st(x).toLowerCase() + ')') }; });
    var id = a[kind + '_id'], typed = a[kind + '_name'];
    var sel = id || (typed ? '__other' : '');
    list.push({ value: '__other', label: 'Not in the app — type a name' });
    return '<label class="field"><span class="lbl">' + (isDam ? 'Dam (mother)' : 'Sire (father)') + '</span><select class="inp" name="' + kind + '_id">' +
      selectOpts(list, sel, 'Unknown') + '</select></label>' +
      '<label class="field" data-show-when="' + kind + '_id:__other"><span class="lbl">' + (isDam ? 'Dam' : 'Sire') + '’s name or tag</span>' +
      '<input class="inp" name="' + kind + '_name" value="' + esc(typed) + '" placeholder="e.g. Old Bessie #12"></label>';
  }
  function viewAnimalForm(id, q, asBull) {
    var a = id ? byId('Animals', id) : null;
    if (id && !a) return viewNotFound('That animal isn’t here anymore.');
    var bull = a ? isBull(a) : !!asBull;
    a = a || { sex: bull ? 'Bull' : 'Cow', status: 'In herd', origin: bull ? 'Purchased' : 'Born on farm' };
    var title = id ? 'Edit ' + dispName(a) : (bull ? 'New bull' : 'New animal');
    var cancel = id ? '#/animal/' + esc(id) : (bull ? '#/bulls' : '#/herd');
    var photoSrc = formPhoto ? 'data:image/jpeg;base64,' + formPhoto : '';
    var withCows = bull && st(a) === 'With cows';
    var calv = id ? S.db.Calvings.find(function (c) { return c.calf_id === id; }) : null;
    var calvB = calv ? byId('Breedings', calv.breeding_id) : null;

    var html = '<div class="screen">' + formHeader(title, 'f-animal', cancel) +
      '<form id="f-animal" class="form" data-form="animal" data-id="' + esc(id || '') + '" data-bull="' + (bull ? '1' : '') + '" novalidate>' +
      (!id ? '<div class="photo-pick' + (photoSrc ? ' has-img' : '') + '" id="form-photo">' +
        (photoSrc ? '<img alt="" src="' + photoSrc + '">' : '') + I.camera +
        '<label class="btn btn-dark btn-sm file-btn">' + (photoSrc ? 'Change photo' : 'Take or choose photo') +
        '<input type="file" accept="image/*" data-photo-input="form"></label></div>' : '') +

      '<div class="grid-2"><label class="field"><span class="lbl">Ear tag</span>' +
      '<input class="inp tag-inp" name="tag" value="' + esc(a.tag) + '" autocomplete="off" autocapitalize="characters" placeholder="None yet"></label>' +
      '<label class="field"><span class="lbl">Name (optional)</span><input class="inp" name="name" value="' + esc(a.name) + '" placeholder="e.g. Daisy"></label></div>' +
      '<span class="hint" style="margin-top:-10px">Leave the tag blank until it’s tagged. If a tag is lost and replaced, just type the new one — the old one is kept.</span>' +
      breedPicker(a.breed);

    if (bull) {
      html += '<input type="hidden" name="sex" value="Bull"><input type="hidden" name="origin" value="Purchased">' +
        '<label class="field"><span class="lbl">Status</span><select class="inp" name="status">' +
        selectOpts(['In herd', 'Sold', 'Deceased', 'Harvested'].concat(withCows ? ['With cows'] : []).map(function (s) { return { value: s, label: s === 'In herd' ? 'Active' : statusLabel(s, a) }; }), st(a) === 'Ready burger' ? 'In herd' : st(a)) + '</select>' +
        '<span class="hint">Putting him in with the cows and taking him out is done from the Breeding page.</span></label>';
      if (withCows) {
        html += '<div data-show-when="status:In herd|Ready burger|Harvested|Sold|Deceased">' + dateField('end_date', 'Came out on', today(), { max: today() }) + '</div>';
      }
    } else {
      html += '<fieldset class="field"><legend class="lbl">Sex</legend><div class="opts">' + opts('sex', SEXES, a.sex) + '</div></fieldset>' +
        '<fieldset class="field" data-show-when="sex:Calf"><legend class="lbl">Calf is a…</legend><div class="opts">' +
        opts('calf_sex', ['Heifer', 'Bull'], a.calf_sex || 'Heifer', ['Heifer calf', 'Bull calf']) + '</div></fieldset>' +
        '<label class="field"><span class="lbl">Birth date</span><input class="inp" type="date" name="birth_date" value="' + esc(a.birth_date) + '" max="' + today() + '">' +
        '<span class="hint" id="age-hint"></span></label>' +
        '<fieldset class="field"><legend class="lbl">Origin</legend><div class="opts">' + opts('origin', ORIGINS, origin(a)) + '</div></fieldset>' +
        '<div data-show-when="origin:Purchased" class="sub-fields">' +
        '<label class="check"><input type="checkbox" name="offsite" value="yes"' + (isOffsite(a) ? ' checked' : '') + '><span><strong>Offsite</strong> — bought to go straight to the butcher, not part of the herd</span></label>' +
        moneyField('purchase_price', 'Purchase price', a.purchase_price) +
        '<div data-show-when="offsite:">' + dateField('joined_date', 'Date added to herd', a.joined_date, { max: today(), todayBtn: true }) + '</div></div>' +
        '<section class="card" id="lineage" data-show-when="offsite:"><h2 class="sec-title">Lineage</h2>' +
        parentPicker('dam', a) + parentPicker('sire', a) +
        (calvB ? '<span class="hint">From the calving record: ' + esc(tagName(byId('Animals', calvB.cow_id))) + ' × ' + esc(bullLabel(calvB)) + '. Change it here if that’s wrong.</span>'
          : '<span class="hint">Filled in automatically when you record a calving. Set it by hand for animals you’re adding from before the app.</span>') +
        '</section>' +
        '<label class="field"><span class="lbl">Status</span><select class="inp" name="status">' +
        selectOpts(CATTLE_STATUSES.map(function (s) { return { value: s, label: STATUS_INFO[s].label }; }), st(a)) + '</select>' +
        '<span class="hint" data-show-when="offsite:yes">Offsite animals start as 🥩 Ready – Steak unless you pick 🍔.</span></label>';
    }

    if (!id && !bull) {
      html += '<section class="card"><h2 class="sec-title">Last ivermectin</h2><div class="grid-2">' +
        dateField('iver_date', 'Date given', '', { max: today() }) +
        '<label class="field"><span class="lbl">Dose</span><input class="inp" name="iver_dose" placeholder="e.g. 10 ml"></label></div>' +
        '<span class="hint">Optional — leave blank if you don’t know. Later doses are logged from the profile.</span></section>';
    }

    html += '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="3" placeholder="Anything worth remembering">' + esc(a.notes) + '</textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button>' +
      (id && isAdmin() ? '<button type="button" class="btn btn-danger btn-block" data-action="delete-animal" data-id="' + esc(id) + '">Delete this animal</button>' +
        '<p class="hint" style="margin:-8px 0 0;text-align:center">Only for mistakes. Use Harvested, Sold or Deceased to keep the record.</p>' : '') +
      '</form></div>';
    return html;
  }

  // ==========================================================================
  // Screen: one photo (date, age, main photo, delete)
  // ==========================================================================
  function viewPhoto(pid) {
    var p = byId('Photos', pid), a;
    if (!p && pid.indexOf('main-') === 0) {
      a = byId('Animals', pid.slice(5));
      if (a && a.photo_id) p = { id: pid, animal_id: a.id, photo_id: a.photo_id, taken_date: '', pseudo: true };
    }
    if (!p) return viewNotFound('That photo isn’t here anymore.');
    a = a || byId('Animals', p.animal_id);
    if (!a) return viewNotFound('That animal isn’t here anymore.');
    var isMain = a.photo_id === p.photo_id;
    return '<div class="screen">' + formHeader('Photo', 'f-photo', '#/animal/' + esc(a.id)) +
      '<div class="photo-full"><span class="ph" data-photo="' + esc(p.photo_id) + '">' + I.camera + '</span></div>' +
      '<form id="f-photo" class="form" data-form="photo" data-id="' + esc(p.id) + '" data-animal="' + esc(a.id) + '" novalidate>' +
      '<div class="info">' + I.info + '<span><strong>' + esc(dispName(a)) + '</strong>' + (a.birth_date ? ' · born ' + esc(fmtDate(a.birth_date, true)) : ' · birth date unknown') + '</span></div>' +
      dateField('taken_date', 'Date taken', p.taken_date, { max: today(), todayBtn: true, hint: '<span id="photo-age"></span>' }) +
      '<label class="field"><span class="lbl">Note (optional)</span><input class="inp" name="note" value="' + esc(p.note) + '" placeholder="e.g. Weaning day"></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button>' +
      (isMain ? '<p class="hint" style="text-align:center;margin:0">' + I.star.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"') + ' This is the main photo</p>'
        : '<button type="button" class="btn btn-line btn-block" data-action="photo-main" data-id="' + esc(p.id) + '">' + I.star + 'Make this the main photo</button>') +
      '<button type="button" class="btn btn-danger btn-block" data-action="photo-delete" data-id="' + esc(p.id) + '">' + I.trash + 'Delete photo</button>' +
      '</form></div>';
  }

  // ==========================================================================
  // Screen: log an ivermectin dose
  // ==========================================================================
  function viewDose(id) {
    var a = byId('Animals', id);
    if (!a) return viewNotFound('That animal isn’t here anymore.');
    var last = lastIvermectin(a);
    return '<div class="screen">' + formHeader('Log dose', 'f-dose', '#/animal/' + esc(a.id)) +
      '<form id="f-dose" class="form" data-form="dose" data-id="' + esc(a.id) + '" novalidate>' +
      '<div class="info">' + I.syringe + '<span><strong>' + esc(tagName(a)) + '</strong>' +
      (last ? ' · last ivermectin ' + esc(fmtDate(last.date, true)) + (last.dose ? ' (' + esc(last.dose) + ')' : '') : ' · no doses logged yet') + '</span></div>' +
      '<label class="field"><span class="lbl">Product</span><input class="inp" name="product" value="Ivermectin" list="product-list">' +
      '<datalist id="product-list"><option value="Ivermectin"><option value="Ivermectin pour-on"><option value="Ivermectin injectable"></datalist></label>' +
      dateField('date', 'Date given *', today(), { max: today(), todayBtn: true }) +
      '<label class="field"><span class="lbl">Dose</span><input class="inp" name="dose" value="' + esc(last ? last.dose : '') + '" placeholder="e.g. 10 ml"></label>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2"></textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save dose</button></form></div>';
  }

  // ==========================================================================
  // Screen: butcher results / sale
  // ==========================================================================
  function viewHarvest(id) {
    var a = byId('Animals', id);
    if (!a) return viewNotFound('That animal isn’t here anymore.');
    var sold = st(a) === 'Sold';
    var forVal = a.harvest_for || (st(a) === 'Ready burger' || isBull(a) ? 'Burger' : 'Steak');
    if (sold) {
      return '<div class="screen">' + formHeader('Sale', 'f-harvest', '#/animal/' + esc(a.id)) +
        '<form id="f-harvest" class="form" data-form="harvest" data-id="' + esc(a.id) + '" data-sold="1" novalidate>' +
        '<div class="info">' + I.info + '<span><strong>' + esc(tagName(a)) + '</strong> · sold</span></div>' +
        dateField('harvest_date', 'Date sold', a.harvest_date || today(), { max: today(), todayBtn: true }) +
        moneyField('sale_price', 'Sale price (after fees)', a.sale_price) +
        '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="harvest_notes" rows="2" placeholder="e.g. Chehalis, 1,240 lb at $198/cwt">' + esc(a.harvest_notes) + '</textarea></label>' +
        '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
    }
    return '<div class="screen">' + formHeader('Butcher results', 'f-harvest', '#/animal/' + esc(a.id)) +
      '<form id="f-harvest" class="form" data-form="harvest" data-id="' + esc(a.id) + '" novalidate>' +
      '<div class="info">' + I.knife + '<span><strong>' + esc(tagName(a)) + '</strong> · saving marks it Harvested</span></div>' +
      '<fieldset class="field"><legend class="lbl">Harvested for</legend><div class="opts">' +
      opts('harvest_for', ['Steak', 'Burger'], forVal, ['🥩 Steak shares', '🍔 Burger']) + '</div></fieldset>' +
      dateField('harvest_date', 'Harvest date', a.harvest_date || today(), { max: today(), todayBtn: true }) +
      '<div class="grid-2"><label class="field"><span class="lbl">Hanging weight (lb)</span><input class="inp" name="hanging_weight" inputmode="decimal" value="' + esc(a.hanging_weight) + '" placeholder="From the butcher"></label>' +
      '<label class="field"><span class="lbl">Burger (lb)</span><input class="inp" name="burger_lbs" inputmode="decimal" value="' + esc(a.burger_lbs) + '" placeholder="If ground"></label></div>' +
      '<span class="hint" style="margin-top:-10px">Fill these in whenever the butcher calls — they can be blank for now. Hanging weight works out what share customers owe; burger lbs go toward burger orders.</span>' +
      '<label class="field"><span class="lbl">Butcher</span><input class="inp" name="butcher" value="' + esc(a.butcher || setting('butcher_name')) + '"></label>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="harvest_notes" rows="2">' + esc(a.harvest_notes) + '</textarea></label>' +
      '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
  }

  // ==========================================================================
  // Screen: breeding & calving
  // ==========================================================================
  function breedingCard(b) {
    var cow = byId('Animals', b.cow_id) || { tag: '' };
    var exposure = isExposure(b);
    var left = daysBetween(today(), dueStart(b));
    var leftEnd = daysBetween(today(), dueEnd(b));
    var start = bredOn(b);
    var elapsed = daysBetween(start, today()) || 0;
    var pct = Math.max(0, Math.min(100, Math.round(elapsed / GESTATION_DAYS * 100)));
    var over = isOverdue(b);
    var days;
    if (over) days = Math.abs(leftEnd) + ' days late';
    else if (left === null) days = '—';
    else if (left > 0) days = left + (left === 1 ? ' day' : ' days');
    else if (exposure && leftEnd >= 0) days = 'Due now';
    else days = (-left) + ' over';
    return '<article class="card b-card"><div class="b-top">' + earTag(cow.tag) +
      '<a class="row-main" href="#/animal/' + esc(cow.id || '') + '"><span class="row-title">' + esc(dispName(cow)) + '</span>' +
      '<span class="row-sub">' + (exposure ? 'With ' + esc(bullLabel(b)) + ' ' + esc(fmtDate(b.exposure_start)) + (b.exposure_end ? '–' + esc(fmtDate(b.exposure_end)) : ' – now')
        : 'Bred to ' + esc(bullLabel(b)) + ' · ' + esc(fmtDate(b.bred_date))) + '</span></a>' +
      '<div class="b-days' + (over || (left !== null && left < 0 && !exposure) ? ' over' : '') + '"><b>' + days + '</b><span>' + (exposure ? 'Window ' : 'Due ') + esc(dueText(b)) + '</span></div></div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<div class="btn-row"><a class="btn btn-dark btn-sm" href="#/breeding/' + esc(b.id) + '/calve">Record calving</a>' +
      '<button type="button" class="btn btn-line btn-sm" data-action="mark-open" data-id="' + esc(b.id) + '">Didn’t take</button></div></article>';
  }
  function openCows() {
    var bredIds = {};
    pendingBreedings().forEach(function (b) { bredIds[b.cow_id] = true; });
    return S.db.Animals.filter(function (a) {
      if (!canBreed(a) || st(a) !== 'In herd' || bredIds[a.id]) return false;
      var m = monthsOld(a.birth_date);
      return a.sex === 'Cow' || m === null || m >= 12;
    }).sort(byTag);
  }
  function viewBreeding() {
    var t = today();
    var pend = pendingBreedings().sort(function (x, y) { return dueStart(x).localeCompare(dueStart(y)); });
    var overdue = pend.filter(isOverdue);
    var due = pend.filter(function (b) { var d = daysBetween(t, dueStart(b)); return !isOverdue(b) && d !== null && d <= DUE_SOON_DAYS; });
    var open = openCows();
    var tabs = [['due', 'Due · ' + due.length], ['bred', 'Bred · ' + pend.length], ['open', 'Open · ' + open.length], ['overdue', 'Late · ' + overdue.length]];
    var body;
    if (UI.breedTab === 'open') {
      body = open.length ? open.map(function (a) {
        var last = S.db.Calvings.filter(function (c) { return c.cow_id === a.id; })
          .sort(function (x, y) { return String(y.calving_date).localeCompare(String(x.calving_date)); })[0];
        var h = nextHeat(a.id);
        return '<article class="card b-card"><div class="b-top">' + earTag(a.tag) +
          '<a class="row-main" href="#/animal/' + esc(a.id) + '"><span class="row-title">' + esc(dispName(a)) + '</span>' +
          '<span class="row-sub">' + esc(a.sex) + ' · ' + esc(last ? 'last calved ' + fmtDate(last.calving_date, true) : 'no calvings recorded') + '</span></a>' +
          (h ? '<div class="b-days"><b>' + esc(fmtDate(h.next)) + '</b><span>Next heat ≈</span></div>' : '') + '</div>' +
          '<a class="btn btn-dark btn-sm" href="#/breeding/new?cow=' + esc(a.id) + '">Log heat or breeding</a></article>';
      }).join('') : '<div class="empty"><b>No open cows</b>Every cow and heifer old enough is bred or in with a bull.</div>';
    } else {
      var list = UI.breedTab === 'bred' ? pend : UI.breedTab === 'overdue' ? overdue : due;
      var emptyMsg = UI.breedTab === 'bred' ? ['No cows bred yet', 'Put a bull in with the cows from the Bulls page, or log a breeding with the red button.']
        : UI.breedTab === 'overdue' ? ['Nobody is late', 'Cows show up here when their calving window has passed by ' + OVERDUE_GRACE + ' days with no calf recorded.']
        : ['Nobody due in the next ' + DUE_SOON_DAYS + ' days', 'Log a breeding with the red button.'];
      body = list.length ? list.map(breedingCard).join('') : '<div class="empty"><b>' + emptyMsg[0] + '</b>' + emptyMsg[1] + '</div>';
    }
    var bullRows = bulls().filter(isActive).sort(byTag).map(function (a) {
      var op = openPeriod(a.id), last = periodsFor(a.id)[0];
      return '<div class="bull-ctl">' + earTag(a.tag, 'sm') + '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
        '<span class="row-sub">' + esc(op ? '🐂 In with the cows since ' + fmtDate(op.start_date) : last && last.end_date ? 'Out since ' + fmtDate(last.end_date, true) : 'Not in yet') + '</span></span>' +
        (op ? '<a class="btn btn-dark btn-sm" href="#/animal/' + esc(a.id) + '/period?to=In%20herd">Take out</a>'
          : '<a class="btn btn-accent btn-sm" href="#/animal/' + esc(a.id) + '/period">Put in</a>') + '</div>';
    }).join('');
    var bullCard = '<section class="card bulls-card"><div class="card-head"><h2 class="sec-title">Bulls</h2><a class="link-inline" href="#/bulls">All bulls</a></div>' +
      (bullRows || '<p class="hint" style="margin:0">No bulls yet. <a class="link-inline" href="#/bulls/add">Add one</a> to put him in with the cows.</p>') + '</section>';
    return '<div class="screen"><header class="hdr"><div class="hdr-titles"><span class="eyebrow">Season ' + new Date().getFullYear() +
      '</span><h1 class="h1">Breeding &amp; Calving</h1></div>' +
      '<div class="seg-dark tight" role="group" aria-label="Breeding views">' + tabs.map(function (tb) {
        return '<button type="button" class="' + (UI.breedTab === tb[0] ? 'on' : '') + '" aria-pressed="' + (UI.breedTab === tb[0]) + '" data-action="breed-tab" data-v="' + tb[0] + '">' + tb[1] + '</button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' + bullCard + '<div class="list">' + body + '</div><div style="height:64px"></div></div>' +
      '<a class="fab" href="#/breeding/new">' + I.plus + 'Log heat / breeding</a>' + nav('breeding') + '</div>';
  }

  function viewBreedingForm(q) {
    var cows = S.db.Animals.filter(function (a) { return canBreed(a) && isActive(a); }).sort(byTag)
      .map(function (a) { return { value: a.id, label: tagName(a) }; });
    var bullList = bulls().filter(isActive).sort(byTag).map(function (a) { return { value: a.id, label: tagName(a) }; });
    return '<div class="screen">' + formHeader('Log heat / breeding', 'f-breed', '#/breeding') +
      '<form id="f-breed" class="form" data-form="breeding" novalidate>' +
      '<label class="field"><span class="lbl">Cow or heifer *</span><select class="inp" name="cow_id" required>' +
      selectOpts(cows, q.cow || '', 'Choose…') + '</select></label>' +
      '<fieldset class="field"><legend class="lbl">What happened</legend><div class="opts">' +
      opts('method', ['Heat', 'Natural', 'AI'], 'Heat', ['Heat seen', 'Bred · bull', 'Bred · AI']) + '</div></fieldset>' +
      '<label class="field" data-show-when="method:Natural"><span class="lbl">Bull</span><select class="inp" name="bull_id">' +
      selectOpts(bullList, bullList.length === 1 ? bullList[0].value : '', 'Choose…') + '</select>' +
      (bullList.length ? '' : '<span class="hint">No bulls yet — add them on the Bulls page.</span>') + '</label>' +
      '<label class="field" data-show-when="method:AI"><span class="lbl">AI sire / straw</span><input class="inp" name="ai_sire" placeholder="Bull name or straw code"></label>' +
      '<p class="warn" id="rel-warn" hidden></p>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Heat seen</span><input class="inp" type="date" name="heat_date" value="' + today() + '" max="' + today() + '"></label>' +
      '<label class="field" data-show-when="method:Natural|AI"><span class="lbl">Bred on *</span><input class="inp" type="date" name="bred_date" value="' + today() + '" max="' + today() + '"></label></div>' +
      '<div class="info">' + I.cal + '<span id="exp-text">—</span></div>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2"></textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
  }

  function viewCalving(bid) {
    var b = byId('Breedings', bid);
    if (!b) return viewNotFound('That breeding record isn’t here anymore.');
    var cow = byId('Animals', b.cow_id) || {};
    var bull = byId('Animals', b.bull_id);
    var breed = cow.breed && bull && bull.breed ? (cow.breed === bull.breed ? cow.breed : splitBreed(cow.breed).length === 1 && splitBreed(bull.breed).length === 1 ? cow.breed + ' / ' + bull.breed : 'Mix') : (cow.breed || '');
    return '<div class="screen">' + formHeader('Record calving', 'f-calve', '#/breeding') +
      '<form id="f-calve" class="form" data-form="calving" data-id="' + esc(b.id) + '" novalidate>' +
      '<div class="info">' + I.info + '<span><strong>' + esc(tagName(cow)) + '</strong> × ' + esc(bullLabel(b)) + ' · ' +
      (isExposure(b) ? 'in together ' + esc(fmtDate(b.exposure_start, true)) + (b.exposure_end ? ' – ' + esc(fmtDate(b.exposure_end, true)) : '') : 'bred ' + esc(fmtDate(b.bred_date, true))) + '</span></div>' +
      '<label class="field"><span class="lbl">Calving date *</span><input class="inp" type="date" name="calving_date" value="' + today() + '" max="' + today() + '" required></label>' +
      '<fieldset class="field"><legend class="lbl">Calf</legend><div class="opts">' + opts('alive', ['yes', 'no'], 'yes', ['Born alive', 'Stillborn']) + '</div></fieldset>' +
      '<fieldset class="field"><legend class="lbl">Calf is a…</legend><div class="opts">' + opts('calf_sex', ['Heifer', 'Bull'], 'Heifer', ['Heifer calf', 'Bull calf']) + '</div></fieldset>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Ear tag</span><input class="inp tag-inp" name="tag" autocomplete="off" autocapitalize="characters" placeholder="None yet"></label>' +
      '<label class="field"><span class="lbl">Name (optional)</span><input class="inp" name="name"></label></div>' +
      breedPicker(breed) +
      '<fieldset class="field"><legend class="lbl">How did it go?</legend><div class="opts wrap">' +
      opts('ease', ['Unassisted', 'Assisted', 'Hard pull', 'Vet / C-section'], 'Unassisted') + '</div></fieldset>' +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2"></textarea></label>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save calving</button>' +
      '<p class="hint" style="margin:-8px 0 0;text-align:center">This creates the calf’s profile with its dam and sire filled in. The tag can be added later.</p></form></div>';
  }

  // ==========================================================================
  // Bulls: stats, in/out periods with season fees
  // ==========================================================================
  function bullStats(a) {
    var yr = String(new Date().getFullYear());
    var bred = S.db.Breedings.filter(function (b) { return b.bull_id === a.id && b.result !== 'Heat' && String(bredOn(b)).slice(0, 4) === yr; });
    var sired = S.db.Animals.filter(function (x) { return x.sire_id === a.id; }).length;
    var per = periodsFor(a.id).filter(function (p) { return String(p.start_date).slice(0, 4) === yr; });
    var season = '—';
    if (per.length) {
      var m = function (d) { var x = parseD(d); return x ? x.toLocaleDateString('en-US', { month: 'short' }) : ''; };
      var first = per[per.length - 1], last = per[0];
      season = m(first.start_date) + '–' + (last.end_date ? m(last.end_date) : 'now');
    }
    return { bred: bred.length, sired: sired, season: season, yr: yr };
  }
  function periodCalves(p) {
    var ids = {};
    S.db.Breedings.forEach(function (b) { if (b.period_id === p.id) ids[b.id] = true; });
    return S.db.Calvings.filter(function (c) { return ids[c.breeding_id]; }).length;
  }
  function periodCows(p) { return S.db.Breedings.filter(function (b) { return b.period_id === p.id; }).length; }
  function bullStatsCard(a) {
    var s = bullStats(a);
    var cows = pendingBreedings().filter(function (b) { return b.bull_id === a.id; })
      .sort(function (x, y) { return dueStart(x).localeCompare(dueStart(y)); });
    return '<section class="card"><h2 class="sec-title">Breeding</h2><div class="mini-stats">' +
      '<div><b>' + s.bred + '</b><span>Bred ' + s.yr + '</span></div><div><b>' + s.sired + '</b><span>Calves sired</span></div>' +
      '<div><b>' + esc(s.season) + '</b><span>With cows ' + s.yr + '</span></div></div>' +
      (cows.length ? '<div class="sub-list"><span class="hint" style="padding-bottom:6px">Cows expecting his calves</span>' + cows.map(function (b) {
        var cow = byId('Animals', b.cow_id);
        return '<a href="#/animal/' + esc(b.cow_id) + '"><span>' + esc(tagName(cow)) + '</span><span class="when">' + esc(dueText(b)) + '</span></a>';
      }).join('') + '</div>' : '') + '</section>';
  }
  function bullPeriodsCard(a) {
    var list = periodsFor(a.id);
    var open = openPeriod(a.id);
    return '<section class="card"><div class="card-head"><h2 class="sec-title">In with the cows</h2>' +
      (isActive(a) ? '<a class="link-inline" href="#/breeding">Breeding page</a>' : '') + '</div>' +
      (list.length ? '<div class="sub-list">' + list.map(function (p) {
        var calves = periodCalves(p), cowsN = periodCows(p), fee = num(p.fee);
        var sub = [cowsN + (cowsN === 1 ? ' cow' : ' cows'), calves + (calves === 1 ? ' calf' : ' calves')];
        if (fee) sub.push(money(fee) + (calves ? ' · ' + money(fee / calves) + '/calf' : ''));
        return '<a href="#/period/' + esc(p.id) + '"><span><strong>' + esc(fmtDate(p.start_date, true)) + ' – ' + (p.end_date ? esc(fmtDate(p.end_date, true)) : 'now') + '</strong>' +
          '<br><span class="hint">' + esc(sub.join(' · ')) + '</span></span><span class="when">Edit</span></a>';
      }).join('') + '</div>' : '<p class="hint" style="margin:0;font-size:14px">No dates logged yet. When he goes in with the cows, every cow and heifer in the herd gets a calving window on the Breeding page.</p>') +
      '</section>';
  }

  function viewBulls() {
    var all = bulls().sort(byTag);
    var act = all.filter(isActive), past = all.filter(function (a) { return !isActive(a); });
    var inNow = act.filter(function (a) { return st(a) === 'With cows'; }).length;
    var cards = act.map(function (a) {
      var s = bullStats(a);
      var op = openPeriod(a.id), last = periodsFor(a.id)[0];
      var line = op ? 'In with the cows since ' + fmtDate(op.start_date) + (num(op.fee) ? ' · ' + money(op.fee) + ' fee' : '')
        : last ? 'Last out ' + fmtDate(last.end_date, true) : 'Not in with the cows yet';
      return '<a class="card b-card" href="#/animal/' + esc(a.id) + '"><div class="b-top">' + thumb(a) +
        '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
        '<span class="row-sub">' + esc(a.breed || 'Bull') + '</span>' +
        '<span class="row-sub">' + esc(line) + '</span></span>' + statusPill(st(a), a) + '</div>' +
        '<div class="mini-stats"><div><b>' + s.bred + '</b><span>Bred ' + s.yr + '</span></div><div><b>' + s.sired + '</b><span>Calves sired</span></div>' +
        '<div><b>' + esc(s.season) + '</b><span>With cows</span></div></div></a>';
    }).join('');
    return '<div class="screen"><header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">' +
      act.length + (act.length === 1 ? ' bull' : ' bulls') + (inNow ? ' · ' + inNow + ' in with the cows' : '') + '</span><h1 class="h1">Bulls</h1></div>' +
      '<a class="btn btn-accent btn-pill btn-sm" href="#/bulls/add">' + I.plus + 'Add bull</a></div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content"><div class="list">' + (cards || '<div class="empty"><b>No bulls yet</b>Add the bulls that run with your cows so their calves link to them.</div>') + '</div>' +
      (past.length ? '<h2 class="section-title">Past bulls</h2><div class="list">' + past.map(animalRow).join('') + '</div>' : '') +
      '</div>' + nav('bulls') + '</div>';
  }

  /** Put a bull in (no ?to) or take him out (?to=<new status>). */
  function viewPeriodChange(id, q) {
    var a = byId('Animals', id);
    if (!a || !isBull(a)) return viewNotFound('That bull isn’t here anymore.');
    var op = openPeriod(a.id);
    if (!q.to) {
      var cows = exposableCows();
      return '<div class="screen">' + formHeader('Put ' + dispName(a) + ' in', 'f-period', '#/breeding') +
        '<form id="f-period" class="form" data-form="period-start" data-id="' + esc(a.id) + '" novalidate>' +
        dateField('start_date', 'Went in with the cows on *', today(), { max: today(), todayBtn: true }) +
        moneyField('fee', 'Season fee', '', 'Lease, rental or service cost for this stretch — shows up as cost per calf.') +
        '<div class="info">' + I.info + '<span><strong>' + cows.length + (cows.length === 1 ? ' cow or heifer' : ' cows and heifers') + '</strong> in the herd will be marked as with ' + esc(dispName(a)) +
        ' and get a calving window on the Breeding page (283 days after he goes in to 283 days after he comes out).' +
        (cows.length ? '<br><span class="hint">' + esc(cows.sort(byTag).map(function (c) { return c.tag || c.name || 'no tag'; }).join(', ')) + '</span>' : '') + '</span></div>' +
        '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2" placeholder="e.g. North pasture"></textarea></label>' +
        '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-accent btn-block">🐂 Put him in</button></form></div>';
    }
    var to = q.to;
    var n = op ? S.db.Breedings.filter(function (b) { return b.period_id === op.id && (b.result || 'Pending') === 'Pending'; }).length : 0;
    return '<div class="screen">' + formHeader('Take ' + dispName(a) + ' out', 'f-period', '#/breeding') +
      '<form id="f-period" class="form" data-form="period-end" data-id="' + esc(a.id) + '" data-to="' + esc(to) + '" novalidate>' +
      '<div class="info">' + I.info + '<span>In since <strong>' + esc(op ? fmtDate(op.start_date, true) : '—') + '</strong>' +
      (n ? ' · closes the calving window for ' + n + (n === 1 ? ' cow' : ' cows') : '') + '. New status: <strong>' + esc(statusLabel(to, a)) + '</strong></span></div>' +
      dateField('end_date', 'Came out on *', today(), { max: today(), todayBtn: true }) +
      '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
  }

  function viewPeriodEdit(pid) {
    var p = byId('BullPeriods', pid);
    if (!p) return viewNotFound('Those dates aren’t here anymore.');
    var a = byId('Animals', p.bull_id);
    return '<div class="screen">' + formHeader('Dates with the cows', 'f-pedit', '#/animal/' + esc(p.bull_id)) +
      '<form id="f-pedit" class="form" data-form="period-edit" data-id="' + esc(p.id) + '" novalidate>' +
      '<div class="info">' + I.bull + '<span><strong>' + esc(a ? dispName(a) : 'Bull') + '</strong> · ' + periodCows(p) + ' cows · ' + periodCalves(p) + ' calves so far</span></div>' +
      '<div class="grid-2">' + dateField('start_date', 'Went in *', p.start_date, { max: today() }) + dateField('end_date', 'Came out', p.end_date, { max: today() }) + '</div>' +
      '<span class="hint" style="margin-top:-10px">Leave “Came out” blank if he’s still in. Changing dates updates every cow’s calving window.</span>' +
      moneyField('fee', 'Season fee', p.fee) +
      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2">' + esc(p.notes) + '</textarea></label>' +
      '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-accent btn-block">Save</button></form></div>';
  }

  // ==========================================================================
  // Screen: sales (Beef / Pork waitlists, archive, customers)
  // ==========================================================================
  function modeOrders() {
    return S.db.Orders.filter(function (o) { return product(o) === UI.salesMode; });
  }
  function byRequest(x, y) {
    return String(requestDate(x)).localeCompare(String(requestDate(y))) || String(x.created_at).localeCompare(String(y.created_at));
  }
  function beefSupply() {
    var waiting = S.db.Orders.filter(function (o) { return product(o) === 'Beef' && stage(o) === 'Waiting'; });
    var steakWanted = waiting.filter(function (o) { return !isBurger(o); }).reduce(function (s, o) { return s + orderHead(o); }, 0);
    var burgerWanted = waiting.filter(isBurger).reduce(function (s, o) { return s + num(o.burger_lbs); }, 0);
    var steakAnimals = S.db.Animals.filter(function (a) { return st(a) === 'Ready steak'; });
    var steakOpen = steakAnimals.reduce(function (s, a) { return s + Math.max(0, 1 - claimedHead(a.id)); }, 0);
    var burgerAnimals = S.db.Animals.filter(isBurgerAnimal);
    var burgerOpen = 0, pending = 0;
    burgerAnimals.forEach(function (a) {
      if (hasNum(a.burger_lbs) && num(a.burger_lbs) > 0) burgerOpen += Math.max(0, num(a.burger_lbs) - claimedLbs(a.id));
      else pending++;
    });
    var mix = { Whole: 0, Half: 0, Quarter: 0 };
    waiting.forEach(function (o) { if (mix[o.share] !== undefined) mix[o.share] += parseFloat(o.quantity) || 1; });
    return { steakWanted: steakWanted, steakOpen: steakOpen, steakReady: steakAnimals.length, burgerWanted: burgerWanted,
      burgerOpen: burgerOpen, burgerPending: pending, burgerReady: burgerAnimals.length, mix: mix };
  }
  function barRow(label, value, pct, color) {
    return '<div class="bar-row"><div class="bar-top"><span>' + label + '</span><b>' + value + '</b></div>' +
      '<div class="bar"><div style="width:' + Math.round(pct) + '%;background:' + color + '"></div></div></div>';
  }
  function beefSupplyCard() {
    var n = beefSupply();
    var sScale = Math.max(n.steakWanted, n.steakOpen, 1);
    var sDiff = n.steakOpen - n.steakWanted;
    var steakCall = !n.steakWanted && !n.steakReady ? ''
      : sDiff < 0
        ? '<div class="callout">' + I.warn + '<span><strong>Short ' + fmtHead(-sDiff) + ' head</strong> (' + Math.round(-sDiff * 4) + ' quarter shares). Tag more animals 🥩 Ready, or let the last few on the list know they’re next.</span></div>'
        : '<div class="callout ok">' + I.check + '<span><strong>' + (sDiff === 0 ? 'Exactly covered.' : 'Covered, with ' + fmtHead(sDiff) + ' head to spare.') + '</strong></span></div>';
    var bScale = Math.max(n.burgerWanted, n.burgerOpen, 1);
    var bDiff = n.burgerOpen - n.burgerWanted;
    var burgerCall = !n.burgerWanted && !n.burgerReady ? ''
      : bDiff < 0
        ? '<div class="callout">' + I.warn + '<span><strong>' + lbs(-bDiff) + ' more burger wanted</strong> than the butcher has reported.' +
          (n.burgerPending ? ' ' + n.burgerPending + ' 🍔 animal' + (n.burgerPending === 1 ? ' is' : 's are') + ' still waiting on butcher weights.' : '') + '</span></div>'
        : '<div class="callout ok">' + I.check + '<span><strong>Covered</strong>, with ' + lbs(bDiff) + ' to spare' +
          (n.burgerPending ? ' — plus ' + n.burgerPending + ' 🍔 animal' + (n.burgerPending === 1 ? '' : 's') + ' not weighed yet' : '') + '.</span></div>';
    return '<section class="card" aria-label="Orders compared with animals ready"><h2 class="sec-title">🥩 Shares wanted vs. ready</h2>' +
      barRow('Waitlist wants', fmtHead(n.steakWanted) + ' head', n.steakWanted / sScale * 100, 'var(--surface)') +
      barRow('🥩 Ready, not yet claimed', fmtHead(n.steakOpen) + ' head', n.steakOpen / sScale * 100, 'var(--accent)') +
      steakCall +
      '<div class="mini-stats"><div><b>' + n.mix.Whole + '</b><span>Whole</span></div><div><b>' + n.mix.Half + '</b><span>Half</span></div><div><b>' + n.mix.Quarter + '</b><span>Quarter</span></div></div>' +
      '<h2 class="sec-title" style="margin-top:6px">🍔 Burger wanted vs. on hand</h2>' +
      barRow('Waitlist wants', lbs(n.burgerWanted), n.burgerWanted / bScale * 100, 'var(--surface)') +
      barRow('Logged by the butcher, unclaimed', lbs(n.burgerOpen), n.burgerOpen / bScale * 100, 'var(--accent)') +
      burgerCall + '</section>';
  }
  function porkSummaryCard() {
    var waiting = modeOrders().filter(function (o) { return stage(o) === 'Waiting'; });
    var mix = { Whole: 0, Half: 0, Quarter: 0 };
    waiting.forEach(function (o) { if (mix[o.share] !== undefined) mix[o.share] += parseFloat(o.quantity) || 1; });
    var hogs = waiting.reduce(function (s, o) { return s + (SHARE_HEAD[o.share] || 0) * (parseFloat(o.quantity) || 1); }, 0);
    var deps = waiting.filter(depositPaid).reduce(function (s, o) { return s + num(o.deposit_amount); }, 0);
    return '<section class="card"><h2 class="sec-title">Pork waitlist</h2>' +
      '<div class="kv"><div><span>Hogs to source</span><b>' + fmtHead(hogs) + '</b></div><div><span>Deposits held</span><b>' + money(deps) + '</b></div></div>' +
      '<div class="mini-stats"><div><b>' + mix.Whole + '</b><span>Whole</span></div><div><b>' + mix.Half + '</b><span>Half</span></div><div><b>' + mix.Quarter + '</b><span>Quarter</span></div></div></section>';
  }
  function sharePill(o) {
    var cls = isBurger(o) ? 'p-burger' : ({ Whole: 'p-whole', Half: 'p-half', Quarter: 'p-quarter' }[o.share] || 'p-harv');
    return '<span class="pill ' + cls + '">' + esc(shareLabel(o)) + '</span>';
  }
  function contactBtns(o, name) {
    var html = '', who = esc(name || fullName(o));
    if (o.phone) {
      html += '<a class="sq-btn" href="tel:' + esc(digits(o.phone)) + '" aria-label="Call ' + who + '">' + I.phone + '</a>' +
        '<a class="sq-btn" href="sms:' + esc(digits(o.phone)) + '" aria-label="Text ' + who + '">' + I.text + '</a>';
    }
    if (o.email) html += '<a class="sq-btn" href="mailto:' + esc(o.email) + '" aria-label="Email ' + who + '">' + I.mail + '</a>';
    return html;
  }
  function payLine(o) {
    var s = stage(o);
    var parts = [];
    if (s === 'Complete') {
      parts.push('<span class="pay ok">' + I.check + 'Paid in full' + (o.final_paid_date ? ' ' + esc(fmtDate(o.final_paid_date)) : '') + ' · ' + money(paidTotal(o)) + '</span>');
      return parts.join('');
    }
    if (s === 'Cancelled') return '<span class="pay">Cancelled' + (depositPaid(o) && num(o.deposit_amount) ? ' · deposit ' + money(o.deposit_amount) : '') + '</span>';
    parts.push(depositPaid(o)
      ? '<span class="pay ok">' + I.check + 'Deposit ' + (num(o.deposit_amount) ? money(o.deposit_amount) : '') + (o.deposit_paid_date ? ' · ' + esc(fmtDate(o.deposit_paid_date)) : '') + '</span>'
      : '<span class="pay due">No deposit yet</span>');
    var sug = suggestedTotal(o);
    if (sug) parts.push('<span class="pay">Balance ≈ ' + money(Math.max(0, sug.total - (depositPaid(o) ? num(o.deposit_amount) : 0))) + '</span>');
    return parts.join('');
  }
  function orderCard(o, pos) {
    var s = stage(o);
    var a = byId('Animals', o.assigned_animal_id);
    var sub = [(o.order_no ? 'Order ' + o.order_no + ' · ' : '') + 'Requested ' + fmtDate(requestDate(o))];
    if (o.wanted_by && !/next available/i.test(o.wanted_by) && s === 'Waiting') sub.push('wants ' + o.wanted_by);
    var action = '';
    if (s === 'Waiting' && product(o) === 'Beef') action = '<a class="btn btn-accent btn-sm" style="flex:1" href="#/order/' + esc(o.id) + '/assign">Assign an animal</a>';
    else if (s === 'Waiting' || s === 'Assigned') action = '<a class="btn btn-dark btn-sm" style="flex:1" href="#/order/' + esc(o.id) + '?pay=1">Payments</a>';
    else action = '<a class="btn btn-line btn-sm" style="flex:1" href="#/order/new?product=' + esc(product(o)) + '&cust=' + encodeURIComponent(custKey(o)) + '">Order again</a>';
    return '<article class="card b-card"><a class="order-top" href="#/order/' + esc(o.id) + '">' +
      (pos ? '<span class="pos">#' + pos + '</span>' : '') +
      '<span class="row-main"><span class="row-title">' + esc(fullName(o)) + '</span><span class="row-sub">' + esc(sub.join(' · ')) + '</span></span>' +
      sharePill(o) + '</a>' +
      (a ? '<span class="assigned-line">' + earTag(a.tag, 'sm') + '<span>' + esc(tagName(a)) + (a.hanging_weight ? ' · ' + lbs(a.hanging_weight) + ' hanging' : '') + '</span>' +
        (s === 'Assigned' ? '<button type="button" class="link-inline" data-action="order-unassign" data-id="' + esc(o.id) + '">Unassign</button>' : '') + '</span>' : '') +
      '<div class="pay-line">' + payLine(o) + '</div>' +
      '<div class="btn-row" style="align-items:center">' + contactBtns(o) + action + '</div></article>';
  }

  function viewSales() {
    var beef = UI.salesMode !== 'Pork';
    var all = modeOrders();
    var waiting = all.filter(function (o) { return stage(o) === 'Waiting'; }).sort(byRequest);
    var assigned = all.filter(function (o) { return stage(o) === 'Assigned'; }).sort(byRequest);
    var archive = all.filter(function (o) { return stage(o) === 'Complete' || stage(o) === 'Cancelled'; })
      .sort(function (x, y) { return String(y.final_paid_date || y.updated_at).localeCompare(String(x.final_paid_date || x.updated_at)); });
    if (!beef && UI.salesTab === 'assigned') UI.salesTab = 'waiting';
    var tabs = [['waiting', 'Waiting · ' + waiting.length]];
    if (beef) tabs.push(['assigned', 'Assigned · ' + assigned.length]);
    tabs.push(['archive', 'Archive'], ['customers', 'Customers']);

    var body;
    if (UI.salesTab === 'customers') body = customersHTML();
    else {
      var list = UI.salesTab === 'assigned' ? assigned : UI.salesTab === 'archive' ? archive : waiting;
      body = '<div class="list">' + (list.length ? list.map(function (o, i) { return orderCard(o, UI.salesTab === 'waiting' ? i + 1 : 0); }).join('')
        : '<div class="empty"><b>' + (UI.salesTab === 'waiting' ? 'Nobody waiting' : UI.salesTab === 'assigned' ? 'No assigned orders' : 'Nothing in the archive yet') + '</b>' +
          (UI.salesTab === 'waiting' ? 'Add an order when someone asks for ' + (beef ? 'beef' : 'pork') + '.' : UI.salesTab === 'archive' ? 'Orders land here once the final payment is recorded.' : '') + '</div>') + '</div>';
    }
    return '<div class="screen"><header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">' +
      waiting.length + ' waiting' + (beef ? ' · ' + assigned.length + ' assigned' : '') + '</span><h1 class="h1">Sales</h1></div>' +
      '<a class="btn btn-accent btn-pill btn-sm" href="#/order/new?product=' + UI.salesMode + '">' + I.plus + 'Add order</a></div>' +
      '<div class="seg-dark" role="group" aria-label="Beef or pork">' + ['Beef', 'Pork'].map(function (m) {
        return '<button type="button" class="' + (UI.salesMode === m ? 'on' : '') + '" aria-pressed="' + (UI.salesMode === m) + '" data-action="sales-mode" data-v="' + m + '">' + m + '</button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' + (UI.salesTab === 'customers' ? '' : (beef ? beefSupplyCard() : porkSummaryCard())) +
      '<div class="seg-light" role="group" aria-label="Order lists">' + tabs.map(function (tb) {
        return '<button type="button" class="' + (UI.salesTab === tb[0] ? 'on' : '') + '" aria-pressed="' + (UI.salesTab === tb[0]) + '" data-action="sales-tab" data-v="' + tb[0] + '">' + tb[1] + '</button>';
      }).join('') + '</div>' + body + '</div>' + nav('sales') + '</div>';
  }

  // ---------- Customers (everyone who has paid in full, beef or pork) ----------
  var CUST_FIELDS = [['last', 'Last name'], ['first', 'First name'], ['paid', 'Last paid'], ['total', 'Total spent'], ['orders', '# of orders']];
  function customers() {
    var map = {};
    S.db.Orders.slice().sort(function (x, y) { return String(x.created_at).localeCompare(String(y.created_at)); }).forEach(function (o) {
      var k = custKey(o);
      var c = map[k] || (map[k] = { key: k, first: '', last: '', phone: '', email: '', orders: [], paid: '', total: 0, products: {}, complete: 0 });
      c.orders.push(o);
      if (firstName(o) || lastName(o)) { c.first = firstName(o); c.last = lastName(o); }
      if (o.phone) c.phone = o.phone;
      if (o.email) c.email = o.email;
      c.total += paidTotal(o);
      if (stage(o) === 'Complete') {
        c.complete++;
        c.products[product(o)] = true;
        var d = o.final_paid_date || localDateOf(o.updated_at);
        if (d > c.paid) c.paid = d;
      }
    });
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (c) { return c.complete > 0; });
  }
  function custCompare(spec) {
    var p = spec.split(':'), f = p[0], dir = p[1] === 'desc' ? -1 : 1;
    return function (x, y) {
      var a, b;
      if (f === 'first') { a = x.first.toLowerCase(); b = y.first.toLowerCase(); }
      else if (f === 'paid') { a = x.paid; b = y.paid; }
      else if (f === 'total') { return dir * (x.total - y.total); }
      else if (f === 'orders') { return dir * (x.orders.length - y.orders.length); }
      else { a = (x.last || x.first).toLowerCase(); b = (y.last || y.first).toLowerCase(); }
      if (!a !== !b) return a ? -1 : 1;     // blanks last
      return dir * a.localeCompare(b);
    };
  }
  function sortControl(n, spec) {
    var p = spec.split(':');
    return '<div class="sort-ctl"><label class="field"><span class="lbl">' + (n === 1 ? 'Sort by' : 'Then by') + '</span>' +
      '<select class="inp" data-sort="' + n + '">' + CUST_FIELDS.map(function (f) {
        return '<option value="' + f[0] + '"' + (f[0] === p[0] ? ' selected' : '') + '>' + f[1] + '</option>';
      }).join('') + '</select></label>' +
      '<button type="button" class="sq-btn dir-btn" data-action="sort-dir" data-n="' + n + '" aria-label="' + (p[1] === 'desc' ? 'Descending, tap for ascending' : 'Ascending, tap for descending') + '">' +
      (p[1] === 'desc' ? (p[0] === 'paid' ? 'New' : p[0] === 'total' || p[0] === 'orders' ? 'High' : 'Z–A') : (p[0] === 'paid' ? 'Old' : p[0] === 'total' || p[0] === 'orders' ? 'Low' : 'A–Z')) + '</button></div>';
  }
  function customerRowsHTML() {
    var q = UI.custSearch.trim().toLowerCase();
    var c1 = custCompare(UI.custSort1), c2 = custCompare(UI.custSort2);
    var list = customers().filter(function (c) {
      return !q || [c.first, c.last, c.phone, c.email].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    }).sort(function (x, y) { return c1(x, y) || c2(x, y); });
    if (!list.length) return '<div class="empty"><b>' + (q ? 'No matches' : 'No past customers yet') + '</b>' + (q ? '' : 'Customers show up here once an order is paid in full.') + '</div>';
    return list.map(function (c) {
      var name = c.last ? c.last + ', ' + c.first : c.first;
      return '<a class="row cust-row" href="#/customer/' + encodeURIComponent(c.key) + '">' +
        '<span class="row-main"><span class="row-title">' + esc(name || 'No name') + '</span>' +
        '<span class="row-sub">' + esc([c.phone, c.email].filter(Boolean).join(' · ') || 'No contact info') + '</span>' +
        '<span class="row-sub">Last paid ' + esc(fmtDate(c.paid, true)) + ' · ' + c.orders.length + (c.orders.length === 1 ? ' order' : ' orders') + ' · ' + money(c.total) + '</span></span>' +
        '<span class="prod-tags">' + Object.keys(c.products).map(function (p) { return '<span class="pill ' + (p === 'Pork' ? 'p-pork' : 'p-herd') + '">' + p + '</span>'; }).join('') + '</span></a>';
    }).join('');
  }
  function customersHTML() {
    return '<div class="sort-row">' + sortControl(1, UI.custSort1) + sortControl(2, UI.custSort2) + '</div>' +
      '<label class="search">' + I.search + '<input id="cust-search" type="search" placeholder="Search name, phone or email" aria-label="Search customers" value="' + esc(UI.custSearch) + '"></label>' +
      '<div class="list" id="cust-list">' + customerRowsHTML() + '</div>';
  }
  function viewCustomersPage() {
    return '<div class="screen"><header class="hdr"><div class="hdr-titles"><span class="eyebrow">Past sales</span><h1 class="h1">Customers</h1></div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div><div class="content">' + customersHTML() + '</div>' + nav('customers') + '</div>';
  }
  function viewCustomer(key) {
    var c = customers().find(function (x) { return x.key === key; });
    if (!c) {
      var any = S.db.Orders.filter(function (o) { return custKey(o) === key; });
      if (!any.length) return viewNotFound('That customer isn’t here anymore.');
      c = { key: key, first: firstName(any[0]), last: lastName(any[0]), phone: any[0].phone, email: any[0].email, orders: any, paid: '', total: 0 };
    }
    var orders = c.orders.slice().sort(function (x, y) { return String(requestDate(y)).localeCompare(String(requestDate(x))); });
    return '<div class="screen">' + backHeader('Customer', '#/sales') +
      '<div class="content"><section class="card"><h1 class="h1 cust-name">' + esc([c.first, c.last].filter(Boolean).join(' ') || 'No name') + '</h1>' +
      '<div class="kv"><div><span>Phone</span><b>' + esc(c.phone || '—') + '</b></div><div><span>Email</span><b>' + esc(c.email || '—') + '</b></div>' +
      '<div><span>Last paid in full</span><b>' + esc(fmtDate(c.paid, true)) + '</b></div><div><span>Total spent</span><b>' + money(c.total) + '</b></div></div>' +
      '<div class="btn-row" style="align-items:center">' + contactBtns(c, [c.first, c.last].join(' ')) + '</div>' +
      '<div class="btn-row"><a class="btn btn-accent btn-sm" href="#/order/new?product=Beef&cust=' + encodeURIComponent(key) + '">' + I.plus + 'Beef order</a>' +
      '<a class="btn btn-dark btn-sm" href="#/order/new?product=Pork&cust=' + encodeURIComponent(key) + '">' + I.plus + 'Pork order</a></div></section>' +
      '<h2 class="section-title">Orders</h2><div class="list">' + orders.map(function (o) {
        return '<a class="row" href="#/order/' + esc(o.id) + '"><span class="row-main"><span class="row-title">' + esc(product(o)) + ' · ' + esc(shareLabel(o)) + '</span>' +
          '<span class="row-sub">Requested ' + esc(fmtDate(requestDate(o), true)) + ' · ' + esc(stage(o) === 'Complete' ? 'paid ' + fmtDate(o.final_paid_date, true) : stage(o).toLowerCase()) + '</span></span>' +
          '<span class="pr-val"><b>' + (paidTotal(o) ? money(paidTotal(o)) : '—') + '</b></span></a>';
      }).join('') + '</div>' +
      (isAdmin() ? '<button type="button" class="btn btn-danger btn-block" data-action="delete-customer" data-key="' + esc(key) + '">Delete this customer</button>' : '') +
      '</div>' + nav('sales') + '</div>';
  }

  function invoiceCardHTML(o) {
    var on = invSetting('invoice_email') && invSetting('invoice_auto') !== 'no';
    var row = function (kind, title, sent) {
      sent = String(sent || '');
      var line = /^Failed/.test(sent) ? '<span class="form-err" style="display:block;margin:0">' + esc(sent) + '</span>'
        : sent ? 'Emailed ' + esc(relTime(sent)) + '.'
        : on ? 'Emails once this saves and syncs.' : 'Invoice emails are off (Settings).';
      return '<div class="inv-row"><div><b>' + title + '</b><br><span class="hint">' + line + '</span></div>' +
        '<div class="btn-row"><button type="button" class="btn btn-line btn-sm" data-action="invoice-view" data-kind="' + kind + '" data-id="' + esc(o.id) + '">View PDF</button>' +
        (invSetting('invoice_email') ? '<button type="button" class="btn btn-line btn-sm" data-action="invoice-send" data-kind="' + kind + '" data-id="' + esc(o.id) + '">Email again</button>' : '') + '</div></div>';
    };
    var rows = [];
    if (depositPaid(o) && !(o.final_paid_date && !o.deposit_invoice_sent)) rows.push(row('deposit', 'Deposit invoice', o.deposit_invoice_sent));
    if (o.final_paid_date) rows.push(row('final', 'Paid-in-full invoice', o.invoice_sent));
    return rows.length ? '<section class="card"><h2 class="sec-title">🧾 Invoices · ' + esc(orderNoText(o)) + '</h2>' + rows.join('') + '</section>' : '';
  }

  // ---------- Order form (new / edit, with both payments) ----------
  function viewOrderForm(id, q) {
    var o = id ? byId('Orders', id) : null;
    if (id && !o) return viewNotFound('That order isn’t here anymore.');
    var prod = o ? product(o) : (q.product === 'Pork' ? 'Pork' : (q.product === 'Beef' ? 'Beef' : UI.salesMode));
    var beef = prod === 'Beef';
    if (!o) {
      o = { share: 'Half', quantity: '1', request_date: today(), deposit_amount: setting(beef ? 'deposit_beef' : 'deposit_pork') };
      if (q.cust) {
        var prev = S.db.Orders.filter(function (x) { return custKey(x) === q.cust; }).pop();
        if (prev) { o.first_name = firstName(prev); o.last_name = lastName(prev); o.phone = prev.phone; o.email = prev.email; }
      }
    }
    var s = id ? stage(o) : 'Waiting';
    var y = new Date().getFullYear();
    var shares = beef ? BEEF_SHARES : PORK_SHARES;
    var labels = beef ? ['🥩 Whole', '🥩 Half', '🥩 Quarter', '🍔 Burger'] : ['Whole hog', 'Half hog', 'Quarter hog'];
    var sug = id ? suggestedTotal(o) : null;
    var depositAmt = depositPaid(o) ? num(o.deposit_amount) : 0;
    var waitingCount = S.db.Orders.filter(function (x) { return product(x) === prod && stage(x) === 'Waiting'; }).length;

    return '<div class="screen">' + formHeader(id ? 'Edit ' + prod.toLowerCase() + ' order' : 'New ' + prod.toLowerCase() + ' order', 'f-order', '#/sales') +
      '<form id="f-order" class="form" data-form="order" data-id="' + esc(id || '') + '" novalidate>' +
      '<input type="hidden" name="product" value="' + prod + '">' +
      (id ? '<p class="order-no">' + esc(orderNoText(o)) + '</p>' : '') +
      (id && s !== 'Waiting' ? '<div class="info">' + I.info + '<span>' + esc(s === 'Complete' ? 'Paid in full — in the archive.' : s === 'Cancelled' ? 'This order was cancelled.' : 'Assigned to an animal.') + '</span></div>' : '') +
      '<section class="field" style="gap:12px"><h2 class="sec-title">Customer</h2>' +
      '<div class="grid-2"><label class="field"><span class="lbl">First name *</span><input class="inp" name="first_name" value="' + esc(firstName(o)) + '" autocomplete="off" required></label>' +
      '<label class="field"><span class="lbl">Last name</span><input class="inp" name="last_name" value="' + esc(lastName(o)) + '" autocomplete="off"></label></div>' +
      '<label class="field"><span class="lbl">Phone *</span><input class="inp" type="tel" name="phone" value="' + esc(o.phone) + '" placeholder="(555) 555-0100" autocomplete="off" required></label>' +
      '<label class="field"><span class="lbl">Email</span><input class="inp" type="email" name="email" value="' + esc(o.email) + '" placeholder="name@example.com" autocomplete="off"></label>' +
      dateField('request_date', 'Date of request', requestDate(o) || today(), { max: today() }) + '</section>' +

      '<section class="card"><h2 class="sec-title">What they want</h2>' +
      '<fieldset class="field"><legend class="lbl sr">Share size</legend><div class="opts' + (beef ? ' four' : '') + '">' + opts('share', shares, o.share, labels) + '</div></fieldset>' +
      '<div data-show-when="share:Whole|Half|Quarter" style="display:flex;justify-content:space-between;align-items:center"><span class="lbl" id="qty-lbl">How many</span>' +
      '<div class="stepper"><button type="button" data-action="qty" data-v="-1" aria-label="Fewer">−</button>' +
      '<input name="quantity" inputmode="numeric" value="' + esc(o.quantity || '1') + '" aria-labelledby="qty-lbl">' +
      '<button type="button" data-action="qty" data-v="1" aria-label="More">+</button></div></div>' +
      (beef ? '<label class="field" data-show-when="share:Burger"><span class="lbl">How many lbs of burger? *</span>' +
        '<input class="inp" name="burger_lbs" inputmode="decimal" value="' + esc(o.burger_lbs) + '" placeholder="e.g. 25"></label>' : '') +
      dateField('harvest_date', 'Harvest date (once it’s scheduled)', o.harvest_date, { hint: 'Shown on the deposit invoice. If an animal is assigned, its harvest date is used when this is blank.' }) +
      '</section>' +

      '<section class="card" id="payments"><h2 class="sec-title">Payments</h2>' +
      '<h3 class="pay-step"><span>1</span>Deposit</h3>' +
      '<div class="grid-2">' + moneyField('deposit_amount', 'Amount', o.deposit_amount, '', setting(beef ? 'deposit_beef' : 'deposit_pork') || '0.00') +
      dateField('deposit_paid_date', 'Date paid', o.deposit_paid_date || (o.deposit_status === 'Paid' ? requestDate(o) : ''), { max: today() }) + '</div>' +
      '<button type="button" class="btn btn-line btn-sm" data-action="paid-today" data-for="deposit_paid_date">' + I.check + 'Deposit paid today</button>' +
      '<h3 class="pay-step"><span>2</span>Final payment</h3>' +
      (sug ? '<div class="info">' + I.info + '<span>Total ≈ <strong>' + money(sug.total) + '</strong> (' + esc(sug.how) + ')' +
        (depositAmt ? ' − ' + money(depositAmt) + ' deposit = <strong>' + money(Math.max(0, sug.total - depositAmt)) + ' due</strong>' : '') + '</span></div>'
        : (beef && id ? '<p class="hint" style="margin:0">The balance works out once the animal’s hanging weight is logged and your prices are saved on the Market tab.</p>' : '')) +
      '<div class="grid-2">' + moneyField('final_amount', 'Amount', o.final_amount || (sug ? Math.max(0, sug.total - depositAmt).toFixed(2) : '')) +
      dateField('final_paid_date', 'Date paid', o.final_paid_date, { max: today() }) + '</div>' +
      '<button type="button" class="btn btn-line btn-sm" data-action="paid-today" data-for="final_paid_date">' + I.check + 'Paid in full today</button>' +
      '<span class="hint">Recording the final payment moves the order to the archive and the customer to Customers.</span></section>' +

      '<label class="field"><span class="lbl">Notes</span><textarea class="inp" name="notes" rows="2">' + esc(o.notes) + '</textarea></label>' +
      (!id ? '<div class="info">' + I.info + '<span>This order goes to the end of the ' + prod.toLowerCase() + ' list as <strong>#' + (waitingCount + 1) + '</strong> (by request date).</span></div>' : '') +
      (id && s !== 'Cancelled' ? invoiceCardHTML(o) : '') +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save</button>' +
      (id ? (s === 'Cancelled'
          ? '<button type="button" class="btn btn-line btn-block" data-action="order-reopen" data-id="' + esc(id) + '">Reopen order</button>'
          : isAdmin() ? '<button type="button" class="btn btn-line btn-block" data-action="order-cancel" data-id="' + esc(id) + '">Cancel order</button>' : '') +
        (isAdmin() ? '<button type="button" class="btn btn-danger btn-block" data-action="delete-order" data-id="' + esc(id) + '">Delete this order</button>' : '') : '') +
      '</form></div>';
  }

  function viewAssign(id) {
    var o = byId('Orders', id);
    if (!o) return viewNotFound('That order isn’t here anymore.');
    var burger = isBurger(o);
    var rows;
    if (burger) {
      var need = num(o.burger_lbs);
      rows = S.db.Animals.filter(isBurgerAnimal).sort(byTag).map(function (a) {
        var weighed = hasNum(a.burger_lbs) && num(a.burger_lbs) > 0;
        var left = weighed ? num(a.burger_lbs) - claimedLbs(a.id, o.id) : null;
        var fits = !weighed || left + 1e-9 >= need;
        return '<div class="row">' + thumb(a) + '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
          '<span class="row-sub">' + esc(animalSub(a)) + '</span><span class="row-sub">' + (weighed ? lbs(Math.max(0, left)) + ' burger left' : 'Weight pending from butcher') + '</span></span>' +
          '<button type="button" class="btn btn-sm ' + (fits ? 'btn-accent' : 'btn-line') + '" data-action="assign" data-id="' + esc(o.id) + '" data-animal="' + esc(a.id) + '"' + (fits ? '' : ' disabled') + '>Assign</button></div>';
      }).join('');
    } else {
      var head = orderHead(o);
      rows = S.db.Animals.filter(function (a) { return st(a) === 'Ready steak'; }).sort(byTag).map(function (a) {
        var left = 1 - claimedHead(a.id, o.id);
        var fits = left + 1e-9 >= head;
        return '<div class="row">' + thumb(a) + '<span class="row-main"><span class="row-title">' + esc(dispName(a)) + '</span>' +
          '<span class="row-sub">' + esc(animalSub(a)) + '</span><span class="row-sub">' + (left > 0 ? fmtHead(left) + ' left' : 'Fully claimed') + '</span></span>' +
          '<button type="button" class="btn btn-sm ' + (fits ? 'btn-accent' : 'btn-line') + '" data-action="assign" data-id="' + esc(o.id) + '" data-animal="' + esc(a.id) + '"' + (fits ? '' : ' disabled') + '>Assign</button></div>';
      }).join('');
    }
    return '<div class="screen">' + backHeader('Assign an animal', '#/sales') +
      '<div class="content"><div class="info">' + I.info + '<span><strong>' + esc(fullName(o)) + '</strong> wants ' + esc(shareLabel(o)) +
      (burger ? '' : ' (' + fmtHead(orderHead(o)) + ' head)') + '.</span></div>' +
      (!burger && orderHead(o) > 1 ? '<p class="warn">This order is more than one animal. Split it into separate orders so each can be assigned.</p>' : '') +
      '<div class="list">' + (rows || '<div class="empty"><b>No animals are ' + (burger ? '🍔 ready for burger' : '🥩 ready for steak') + '</b>Tag one on its profile and it will show here.</div>') + '</div></div>' + nav('sales') + '</div>';
  }

  // ==========================================================================
  // Screen: market — auction prices · butcher or auction? · our numbers
  // ==========================================================================
  var MARKET_CHIPS = [['all', 'All'], ['steers', 'Steers'], ['heifers', 'Heifers'], ['cows', 'Cows'], ['bulls', 'Bulls'], ['bred', 'Bred & pairs']];
  function marketMatch(it, chip) {
    if (chip === 'all') return true;
    var t = ((it.section || '') + ' ' + (it.cls || '')).toLowerCase();
    if (chip === 'steers') return /steer/.test(t);
    if (chip === 'heifers') return /heifer/.test(t) && !/bred|springer/.test(t);
    if (chip === 'bred') return /bred|pair|springer/.test(t);
    if (chip === 'bulls') return /\bbull/.test(t) && !/\bcows?\b/i.test(it.cls || '');
    if (chip === 'cows') return /\bcows?\b|slaughter|\bsla\b|butcher|dresser|shell/.test(t) && !/bred|pair/.test(t) &&
      !(/\bbull/i.test(it.cls || '') && !/\bcows?\b/i.test(it.cls || ''));
    return true;
  }
  var DAIRY_RE = /\b(dairy|holsteins?|jerseys?|springers?|fresh cows?|hol)\b/i;
  function priceItems(rec) {
    try {
      var a = JSON.parse(rec.lines_json || '[]');
      return Array.isArray(a) ? a.filter(function (it) { return !DAIRY_RE.test((it.section || '') + ' ' + (it.cls || '')); }) : [];
    } catch (e) { return []; }
  }
  function pmoney(x) {
    var n = Number(x);
    if (!isFinite(n)) return '—';
    return '$' + (n % 1 === 0 ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
  function priceText(it) {
    if (it.andDown) return 'up to ' + pmoney(it.high);
    if (Number(it.low) === Number(it.high)) return pmoney(it.high);
    return pmoney(it.low) + '–' + pmoney(it.high).replace('$', '');
  }
  function priceKey(it) { return ((it.section || '') + '|' + (it.cls || '') + '|' + (it.weight || '')).toLowerCase(); }
  function mid(it) { return it.andDown ? Number(it.high) : (Number(it.low) + Number(it.high)) / 2; }
  function saleWhen(rec) {
    var d = parseD(rec.sale_date);
    if (!d) return rec.sale_label || '—';
    var s = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (/special/i.test(rec.sale_label || '')) s += ' · special sale';
    return s;
  }
  function saleAge(rec) {
    var n = daysBetween(rec.sale_date, today());
    if (n === null) return { text: '', cls: 'p-harv' };
    var t = n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : n < 14 ? n + ' days ago' : Math.round(n / 7) + ' weeks ago';
    return { text: t, cls: n <= 8 ? 'p-herd' : 'p-harv' };
  }
  function priceRows(items, prevMap) {
    var groups = [], bySec = {};
    items.forEach(function (it) {
      var s = it.section || '';
      if (!bySec[s]) { bySec[s] = []; groups.push(s); }
      bySec[s].push(it);
    });
    return groups.map(function (s) {
      return (s ? '<h3 class="sec-title pr-sec">' + esc(s) + '</h3>' : '') + '<div class="price-list">' + bySec[s].map(function (it) {
        var name = [it.cls, it.weight].filter(Boolean).join(' · ') || s || 'Price';
        var chg = '';
        var p = prevMap && prevMap[priceKey(it)];
        if (p) {
          var diff = mid(it) - mid(p);
          if (Math.abs(diff) / (mid(p) || 1) >= 0.005) {
            var up = diff > 0;
            chg = '<span class="chg ' + (up ? 'up' : 'down') + '" aria-label="' + (up ? 'up ' : 'down ') + pmoney(Math.abs(diff)) + ' since last sale">' +
              (up ? '▲' : '▼') + ' ' + pmoney(Math.abs(Math.round(diff))).replace('$', '') + '</span>';
          }
        }
        return '<div class="pr"><span class="pr-name">' + esc(name) + (it.prev ? ' <span class="hint" title="Price from an earlier sale">*</span>' : '') +
          (it.head ? ' <span class="hint">· ' + it.head + ' hd</span>' : '') + '</span>' +
          '<span class="pr-val"><b>' + esc(priceText(it)) + '</b><small>/' + esc(it.unit === 'hd' ? 'head' : (it.unit || 'cwt')) + '</small>' + chg + '</span></div>';
      }).join('') + '</div>';
    }).join('');
  }
  function yardsNewestFirst() {
    var byYard = {};
    S.db.Prices.forEach(function (r) { (byYard[r.yard] = byYard[r.yard] || []).push(r); });
    return Object.keys(byYard).map(function (y) {
      return byYard[y].sort(function (a, b) { return String(b.sale_date).localeCompare(String(a.sale_date)); });
    }).sort(function (a, b) { return String(b[0].sale_date).localeCompare(String(a[0].sale_date)); });
  }

  function marketPricesHTML() {
    var yards = yardsNewestFirst();
    var run = S.meta && S.meta.pricesRun;
    var problems = run && run.results ? run.results.filter(function (r) { return /:\s/.test(r); }) : [];
    var shown = 0;
    var cards = yards.map(function (list) {
      var rec = list[0];
      var items = priceItems(rec).filter(function (it) { return marketMatch(it, UI.market); });
      // Compare with the most recent earlier sale that lists the same classes
      // (so a special feeder sale isn't compared with a regular Friday sale).
      var prevMap = {}, keys = {};
      priceItems(rec).forEach(function (it) { keys[priceKey(it)] = true; });
      for (var k = 1; k < list.length; k++) {
        var cand = {}, overlap = 0;
        priceItems(list[k]).forEach(function (it) { var key = priceKey(it); cand[key] = it; if (keys[key]) overlap++; });
        if (overlap >= 2) { prevMap = cand; break; }
      }
      if (!items.length && UI.market !== 'all') return '';
      shown++;
      var age = saleAge(rec);
      var older = list.slice(1).map(function (o) {
        var oi = priceItems(o).filter(function (it) { return marketMatch(it, UI.market); });
        if (!oi.length) return '';
        return '<details class="older"><summary>' + esc(saleWhen(o)) + I.chev + '</summary>' + priceRows(oi, null) + '</details>';
      }).join('');
      return '<details class="card yard"' + (shown <= 2 ? ' open' : '') + '><summary class="yard-head">' +
        '<span class="row-main"><span class="row-title">' + esc(rec.yard) + '</span>' +
        '<span class="row-sub">' + esc([rec.location, saleWhen(rec), rec.head_count].filter(Boolean).join(' · ')) + '</span></span>' +
        (age.text ? '<span class="pill ' + age.cls + '">' + esc(age.text) + '</span>' : '') + '<span class="yard-chev">' + I.chev + '</span></summary>' +
        '<div class="yard-body">' +
        (items.length ? priceRows(items, prevMap) : '<p class="hint" style="margin:0">No prices listed for this sale.</p>') +
        (rec.notes_text && UI.market === 'all' ? '<p class="market-note">' + esc(rec.notes_text) + '</p>' : '') +
        (older ? '<span class="hint">Earlier sales</span>' + older : '') +
        '<a class="src" href="' + esc(rec.source_url) + '" target="_blank" rel="noopener">' + I.link + 'From ' + esc(rec.source || 'source') + '</a>' +
        '</div></details>';
    }).join('');
    return (problems.length ? '<p class="warn">Last check had trouble: ' + esc(problems.join(' · ')) + '. Showing the newest prices saved before that.</p>' : '') +
      '<div class="chips" role="group" aria-label="Filter prices">' + MARKET_CHIPS.map(function (c) {
        return '<button type="button" class="chip' + (UI.market === c[0] ? ' on' : '') + '" data-action="market-filter" data-v="' + c[0] + '">' + c[1] + '</button>';
      }).join('') + '</div>' +
      '<span class="list-note">Newest sale first · $/cwt = dollars per 100 lb live weight · ▲▼ vs. that yard’s previous sale</span>' +
      '<div class="list">' + (yards.length
        ? (cards || '<div class="empty"><b>Nothing in that class</b>None of the latest reports list it.</div>')
        : '<div class="empty"><b>No prices yet</b>The farm Sheet checks Chehalis and the weekly roundup every 6 hours. Tap Check now to look right away.</div>') +
      '</div>';
  }

  // ---------- Butcher or auction? ----------
  function weightRange(w) {
    if (!w) return null;
    if (/heavy/i.test(w)) return [Infinity, Infinity, 'heavy'];
    var m = /(\d+)\s*-\s*(\d+)/.exec(w);
    if (m) return [Number(m[1]), Number(m[2])];
    m = /(under|up to|less than)\s*(\d+)/i.exec(w);
    if (m) return [0, Number(m[2])];
    m = /over\s*(\d+)/i.exec(w);
    if (m) return [Number(m[1]), Infinity];
    m = /(\d+)/.exec(w);
    return m ? [Number(m[1]), Number(m[1])] : null;
  }
  /** Best matching auction price ($/cwt) for a class + live weight, newest Chehalis sale first. */
  function autoPrice(cls, weight) {
    var yards = yardsNewestFirst();
    yards.sort(function (a, b) { return (/chehalis/i.test(b[0].yard) ? 1 : 0) - (/chehalis/i.test(a[0].yard) ? 1 : 0); });
    for (var y = 0; y < yards.length; y++) {
      for (var r = 0; r < yards[y].length; r++) {
        var rec = yards[y][r];
        if (/special/i.test(rec.sale_label || '') && yards[y].length > 1 && r === 0) continue;
        var items = priceItems(rec).filter(function (it) { return (it.unit || 'cwt') === 'cwt'; });
        var pick = null;
        var t = function (it) { return ((it.section || '') + ' ' + (it.cls || '')).toLowerCase(); };
        if (cls === 'Cow') {
          pick = items.find(function (it) { return /top 50/.test(t(it)); }) ||
                 items.find(function (it) { return /top 20/.test(t(it)); }) ||
                 items.find(function (it) { return marketMatch(it, 'cows'); });
        } else if (cls === 'Bull' && !weight) {
          pick = items.find(function (it) { return /average sla bull|slaughter bull/.test(t(it)); }) || items.find(function (it) { return marketMatch(it, 'bulls'); });
        } else {
          var key = cls === 'Steer' ? 'steers' : cls === 'Heifer' ? 'heifers' : 'bulls';
          var pool = items.filter(function (it) { return marketMatch(it, key) && !/holstein|dairy/.test(t(it)); });
          if (cls === 'Bull') {
            var sla = pool.filter(function (it) { return /sla|slaughter/.test(t(it)); });
            if (num(weight) >= 1000 && sla.length) pool = sla;
          }
          if (pool.length && num(weight)) {
            var w = num(weight), best = null, bestD = Infinity, maxHi = 0;
            pool.forEach(function (it) { var wr = weightRange(it.weight); if (wr && isFinite(wr[1])) maxHi = Math.max(maxHi, wr[1]); });
            pool.forEach(function (it) {
              var wr = weightRange(it.weight);
              if (!wr) return;
              var lo = wr[2] === 'heavy' ? maxHi : wr[0], hi = wr[2] === 'heavy' ? Infinity : wr[1];
              var d = w >= lo && w <= hi ? 0 : Math.min(Math.abs(w - lo), Math.abs(w - hi));
              if (d < bestD) { bestD = d; best = it; }
            });
            pick = best || pool[0];
          } else pick = pool[0];
        }
        if (pick) {
          return { price: Math.round(mid(pick) * 100) / 100, rec: rec,
            label: rec.yard.replace(/ Livestock.*$/, '') + ' ' + saleWhen(rec) + ' · ' + [pick.section, pick.cls, pick.weight].filter(Boolean).join(' · ') + ': ' + priceText(pick) + '/cwt' };
        }
      }
    }
    return null;
  }
  function calcHTML() {
    var animals = S.db.Animals.filter(isActive).sort(byTag).map(function (a) {
      return { value: a.id, label: tagName(a) + ' · ' + (isBull(a) ? 'Bull' : sexText(a)) + (st(a) !== 'In herd' ? ' · ' + STATUS_INFO[st(a)].short : '') };
    });
    var missing = [];
    if (!hasNum(setting('price_hanging'))) missing.push('your price per lb hanging');
    if (!hasNum(setting('haul_auction'))) missing.push('haul cost to the auction');
    return '<form class="card" data-form="calc" novalidate><h2 class="sec-title">Butcher or auction?</h2>' +
      (missing.length ? '<p class="warn">Add ' + esc(missing.join(' and ')) + ' under <a class="link-inline" href="#/settings/numbers">Settings → Our numbers</a> for a full comparison.</p>' : '') +
      '<label class="field"><span class="lbl">Animal (optional)</span><select class="inp" name="animal">' + selectOpts(animals, '', 'Just estimating') + '</select></label>' +
      '<fieldset class="field"><legend class="lbl">Sell to customers as</legend><div class="opts">' + opts('sell_as', ['Steak', 'Burger'], 'Steak', ['🥩 Steak shares', '🍔 Burger']) + '</div></fieldset>' +
      '<fieldset class="field"><legend class="lbl">Auction class</legend><div class="opts">' + opts('cls', ['Steer', 'Heifer', 'Cow', 'Bull'], 'Steer') + '</div></fieldset>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Est. live weight (lb)</span><input class="inp" name="weight" inputmode="numeric" placeholder="e.g. 1,150"></label>' +
      '<label class="field"><span class="lbl">Auction $/cwt</span><input class="inp" name="price" inputmode="decimal" placeholder="—"></label></div>' +
      '<span class="hint" id="calc-src"></span>' +
      '<div id="calc-out"></div>' +
      '<p class="hint" style="margin:0">Estimates only. Hanging weight is figured at ' + esc(setting('hanging_pct')) + '% of live weight and burger at ' + esc(setting('burger_pct')) +
      '% of hanging — change those under Our numbers. Customers pay the butcher’s cut &amp; wrap and kill fee, so they don’t come out of your side.</p></form>';
  }
  function calcResult(form) {
    var w = num(val(form, 'weight'));
    var p = num(val(form, 'price'));
    var asBurger = val(form, 'sell_as') === 'Burger';
    var hangPct = num(setting('hanging_pct')) || 60, burgPct = num(setting('burger_pct')) || 70;
    var haulA = num(setting('haul_auction')), comm = num(setting('auction_commission_pct')), haulB = num(setting('haul_butcher'));
    var ph = num(setting('price_hanging')), pb = num(setting('price_burger'));
    if (!w) return '<p class="hint" style="margin:0">Enter an estimated live weight to compare.</p>';
    var gross = w * p / 100, commAmt = Math.round(gross * comm / 100), aNet = gross - commAmt - haulA;
    var hang = w * hangPct / 100, burger = hang * burgPct / 100;
    var bGross = asBurger ? burger * pb : hang * ph;
    var bNet = bGross - haulB;
    var haveA = p > 0, haveB = asBurger ? pb > 0 : ph > 0;
    var diff = bNet - aNet;
    var verdict = haveA && haveB
      ? '<div class="callout' + (diff >= 0 ? ' ok' : '') + '">' + (diff >= 0 ? I.knife : I.market) + '<span><strong>' +
        (Math.abs(diff) < 25 ? 'About even.' : (diff > 0 ? 'Butcher' : 'Auction') + ' brings about ' + money(Math.abs(diff)) + ' more.') + '</strong></span></div>' : '';
    var allIn = '';
    if (!asBurger && ph) {
      var cw = num(setting('butcher_cutwrap')), kill = num(setting('butcher_kill'));
      var per = ph + cw + (kill && hang ? kill / hang : 0);
      allIn = '<p class="hint" style="margin:0">A customer’s all-in cost ≈ <strong>' + money(per, true) + '/lb hanging</strong> (your ' + money(ph, true) +
        (cw ? ' + cut &amp; wrap ' + money(cw, true) : '') + (kill ? ' + kill fee' : '') + ') · whole ≈ ' + money(per * hang) + '</p>';
    }
    return '<div class="compare">' +
      '<div class="cmp-col"><span class="sec-title">Auction</span><b>' + (haveA ? money(aNet) : '—') + '</b>' +
      '<span class="hint">' + lbs(w) + ' × ' + (p ? money(p, true) : '?') + '/cwt = ' + money(gross) +
      (comm ? '<br>− ' + comm + '% commission ' + money(commAmt) : '') + (haulA ? '<br>− haul ' + money(haulA) : '') + '</span></div>' +
      '<div class="cmp-col"><span class="sec-title">Butcher</span><b>' + (haveB ? money(bNet) : '—') + '</b>' +
      '<span class="hint">' + (asBurger ? '≈ ' + lbs(burger) + ' burger × ' + (pb ? money(pb, true) : '?') + '/lb'
        : '≈ ' + lbs(hang) + ' hanging × ' + (ph ? money(ph, true) : '?') + '/lb') + (haulB ? '<br>− haul ' + money(haulB) : '') + '</span></div>' +
      '</div>' + verdict + allIn;
  }
  function updateCalc(form, changed) {
    if (changed === 'animal') {
      var a = byId('Animals', val(form, 'animal'));
      if (a) {
        var cls = isBull(a) ? 'Bull' : a.sex === 'Cow' ? 'Cow' : a.sex === 'Heifer' ? 'Heifer' : a.sex === 'Calf' ? (a.calf_sex === 'Heifer' ? 'Heifer' : 'Steer') : 'Steer';
        var r1 = form.querySelector('input[name=cls][value="' + cls + '"]'); if (r1) r1.checked = true;
        var sell = st(a) === 'Ready burger' || isBull(a) || a.sex === 'Cow' ? 'Burger' : 'Steak';
        var r2 = form.querySelector('input[name=sell_as][value="' + sell + '"]'); if (r2) r2.checked = true;
      }
    }
    var priceEl = form.elements.price;
    if (changed !== 'price' && priceEl && !priceEl.dataset.touched) {
      var ap = autoPrice(val(form, 'cls'), val(form, 'weight'));
      priceEl.value = ap ? ap.price : '';
      var src = document.getElementById('calc-src');
      if (src) src.textContent = ap ? 'Using ' + ap.label + (/–/.test(ap.label) ? ' (middle of the range)' : '') + '. Type over it to use your own.' : 'No auction prices saved yet — type a price.';
    }
    if (changed === 'price' && priceEl) priceEl.dataset.touched = '1';
    var out = document.getElementById('calc-out');
    if (out) out.innerHTML = calcResult(form);
  }

  // ---------- Our numbers ----------
  function numbersHTML() {
    var f = function (key, label, hint, ph) { return moneyField(key, label, setting(key), hint, ph); };
    var pct = function (key, label, hint) {
      return '<label class="field"><span class="lbl">' + esc(label) + '</span><span class="money-inp pct"><input class="inp" name="' + key + '" inputmode="decimal" value="' + esc(setting(key)) + '"><span aria-hidden="true">%</span></span>' +
        (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>';
    };
    return '<form class="form" style="padding:0" data-form="settings" novalidate>' +
      '<section class="card"><h2 class="sec-title">Hauling</h2>' +
      '<div class="grid-2">' + f('haul_auction', 'To the auction, per head') + f('haul_butcher', 'To the butcher, per head') + '</div>' +
      pct('auction_commission_pct', 'Auction commission', 'What the sale barn keeps, if you want it counted.') + '</section>' +
      '<section class="card"><h2 class="sec-title">🐄 Beef prices</h2>' +
      '<div class="grid-2">' + f('price_hanging', 'Per lb hanging weight') + f('price_burger', '🍔 Burger per lb') + '</div>' +
      '<div class="grid-2">' + f('deposit_beef', 'Deposit') + '<span></span></div>' +
      '<label class="field"><span class="lbl">Hanging weights for the deposit-invoice estimate</span><input class="inp" name="ladder_weights" inputmode="numeric" value="' + esc(setting('ladder_weights')) + '" placeholder="600, 650, 700, 750, 800">' +
        '<span class="hint">Whole-animal hanging weights in lb, separated by commas.</span></label>' + '</section>' +
      '<section class="card"><h2 class="sec-title">🐖 Pork prices</h2>' +
      '<div class="grid-2">' + f('price_pork', 'Per lb hanging weight') + f('deposit_pork', 'Deposit') + '</div>' +
      '<label class="field"><span class="lbl">Hanging weights for the deposit-invoice estimate</span><input class="inp" name="ladder_weights_pork" inputmode="numeric" value="' + esc(setting('ladder_weights_pork')) + '" placeholder="160, 180, 200, 220, 240">' +
        '<span class="hint">Whole-animal hanging weights in lb, separated by commas.</span></label>' +
      '<span class="hint">Deposits fill in automatically on new orders. Per-lb prices work out each customer’s balance once hanging weights are logged, and the estimate table on deposit invoices.</span></section>' +
      '<section class="card"><h2 class="sec-title">Butcher</h2>' +
      '<div class="grid-2"><label class="field"><span class="lbl">Name</span><input class="inp" name="butcher_name" value="' + esc(setting('butcher_name')) + '"></label>' +
      '<label class="field"><span class="lbl">Phone</span><input class="inp" type="tel" name="butcher_phone" value="' + esc(setting('butcher_phone')) + '"></label></div>' +
      '<label class="field"><span class="lbl">Town</span><input class="inp" name="butcher_city" value="' + esc(setting('butcher_city')) + '"><span class="hint">The butcher’s name and town print on both invoices.</span></label>' +
      '<div class="grid-2">' + f('butcher_cutwrap', 'Cut & wrap per lb', 'Customer pays') + f('butcher_kill', 'Kill fee per head', 'Customer pays') + '</div>' +
      (setting('butcher_phone') ? '<a class="btn btn-line btn-sm" href="tel:' + esc(digits(setting('butcher_phone'))) + '">' + I.phone + 'Call ' + esc(setting('butcher_name') || 'butcher') + '</a>' : '') + '</section>' +
      '<section class="card"><h2 class="sec-title">Estimates</h2>' +
      '<div class="grid-2">' + pct('hanging_pct', 'Hanging ÷ live weight', 'Usually about 60%.') + pct('burger_pct', 'Burger ÷ hanging', 'For an all-burger animal.') + '</div></section>' +
      '<p class="form-err" role="alert"></p>' +
      '<button type="submit" class="btn btn-accent btn-block">Save numbers</button></form>';
  }

  function viewNumbersPage() {
    return '<div class="screen">' + backHeader('Our numbers', '#/settings') +
      '<div id="sync-banner">' + bannerHTML() + '</div><div class="content">' + numbersHTML() + '</div>' + nav('settings') + '</div>';
  }

  function viewMarket() {
    var run = S.meta && S.meta.pricesRun;
    if (UI.marketView !== 'compare') UI.marketView = 'prices';
    var views = [['prices', 'Regional Prices'], ['compare', 'VS.']];
    var body = UI.marketView === 'compare' ? calcHTML() : marketPricesHTML();
    return '<div class="screen"><header class="hdr"><div class="hdr-row"><div class="hdr-titles"><span class="eyebrow">' +
      (run && run.at ? 'Prices checked ' + esc(relTime(run.at)) : 'Auction prices') + '</span><h1 class="h1">Market</h1></div>' +
      (UI.marketView === 'prices' ? '<button type="button" class="btn btn-accent btn-pill btn-sm" data-action="refresh-prices"' + (UI.checkingPrices ? ' disabled' : '') + '>' +
        I.sync + (UI.checkingPrices ? 'Checking…' : 'Check now') + '</button>' : '') + '</div>' +
      '<div class="seg-dark" role="group" aria-label="Market views">' + views.map(function (v) {
        return '<button type="button" class="' + (UI.marketView === v[0] ? 'on' : '') + '" aria-pressed="' + (UI.marketView === v[0]) + '" data-action="market-view" data-v="' + v[0] + '">' + v[1] + '</button>';
      }).join('') + '</div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content">' + body + '</div>' + nav('market') + '</div>';
  }

  // ==========================================================================
  // Screen: reports (the desktop dashboard — also works on a phone)
  // Charts are plain HTML/CSS (bars, columns) plus one SVG line, so text stays
  // crisp at any width. Every chart has hover/tap details and a table view.
  // Series colours (validated for colour-blind separation on parchment):
  //   1 barn red #A71614 · 2 saddle #B27A2C · 3 creek blue #2F6CA3 · 4 pasture #5E8A2E
  // ==========================================================================
  var VIZ = ['#A71614', '#B27A2C', '#2F6CA3', '#5E8A2E'];

  function compact(n) {
    n = Number(n) || 0;
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  function monthKeys(n) {
    var out = [], d = new Date(); d.setDate(1);
    for (var i = n - 1; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(iso(x).slice(0, 7)); }
    return out;
  }
  function monthLabel(k, withYear) {
    var p = k.split('-'); var d = new Date(+p[0], +p[1] - 1, 1);
    return d.toLocaleDateString('en-US', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  function tableView(head, rows) {
    return '<details class="viz-table"><summary>Show table</summary><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      head.map(function (h, i) { return '<th' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table></div></details>';
  }
  function legend(items) {
    return '<div class="viz-legend">' + items.map(function (it) {
      return '<span><i style="background:' + it[1] + '"></i>' + esc(it[0]) + '</span>';
    }).join('') + '</div>';
  }

  /** Horizontal bars: [{label, value, tip}] — one colour, value at the tip. */
  function hbars(items, color, fmt) {
    fmt = fmt || compact;
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([0])) || 1;
    return '<div class="hbars">' + items.map(function (it) {
      var pct = it.value / max * 100;
      return '<div class="hbar" tabindex="0" data-tip="' + esc(it.tip || (it.label + ': ' + fmt(it.value))) + '"><span class="hb-l">' + esc(it.label) + '</span>' +
        '<span class="hb-track"><span class="hb-fill" style="width:' + (it.value ? Math.max(pct, 1.5) : 0) + '%;background:' + color + '"></span>' +
        '<span class="hb-v">' + esc(fmt(it.value)) + '</span></span></div>';
    }).join('') + '</div>';
  }

  /** Columns by month, optionally stacked: series [{name, color, values[]}] over keys. */
  function columns(keys, series, fmt, opts) {
    opts = opts || {};
    fmt = fmt || compact;
    var totals = keys.map(function (k, i) { return series.reduce(function (s, se) { return s + (se.values[i] || 0); }, 0); });
    var top = niceMax(Math.max.apply(null, totals.concat([0])));
    if (!opts.money && top % 2) top += 1;   // whole-number middle line for head counts
    var ticks = [top, top / 2, 0];
    var lastIdx = -1;
    totals.forEach(function (t, i) { if (t > 0) lastIdx = i; });
    return '<div class="cols-wrap"><div class="cols-axis">' + ticks.map(function (t) { return '<span>' + esc(opts.money ? '$' + compact(t) : compact(t)) + '</span>'; }).join('') + '</div>' +
      '<div class="cols"><div class="cols-grid"><i></i><i></i><i></i></div>' + keys.map(function (k, i) {
        var tip = monthLabel(k, true) + ': ' + series.map(function (se) { return (series.length > 1 ? se.name + ' ' : '') + fmt(se.values[i] || 0); }).join(' · ');
        return '<div class="col" tabindex="0" data-tip="' + esc(tip) + '"><div class="col-stack" style="height:' + (totals[i] / top * 100) + '%">' +
          series.map(function (se) {
            var v = se.values[i] || 0;
            return v ? '<span class="seg" style="flex:' + v + ' 1 0;background:' + se.color + '"></span>' : '';
          }).join('') + '</div>' +
          (i === lastIdx && totals[i] ? '<span class="col-val" style="bottom:calc(' + (totals[i] / top * 100) + '% + 4px)">' + esc(fmt(totals[i])) + '</span>' : '') +
          '<span class="col-l">' + esc(i % 2 === (keys.length % 2 ? 0 : 1) || keys.length <= 6 ? monthLabel(k, i === 0 || k.slice(5) === '01') : '') + '</span></div>';
      }).join('') + '</div></div>';
  }

  /** One-line trend: points [{date, value, tip}] — SVG line + HTML markers so labels stay sharp. */
  function trendLine(points, fmt) {
    if (points.length < 2) return '<p class="hint" style="margin:0">Needs at least two sales to draw a trend. It fills in as the farm Sheet saves more sale reports.</p>';
    var vals = points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
    lo = Math.max(0, lo - pad); hi = hi + pad;
    var t0 = parseD(points[0].date).getTime(), t1 = parseD(points[points.length - 1].date).getTime() || t0 + 1;
    var xy = points.map(function (p) {
      return { x: (parseD(p.date).getTime() - t0) / ((t1 - t0) || 1) * 100, y: 100 - (p.value - lo) / (hi - lo) * 100, p: p };
    });
    var d = xy.map(function (q, i) { return (i ? 'L' : 'M') + q.x.toFixed(2) + ' ' + q.y.toFixed(2); }).join(' ');
    var last = xy[xy.length - 1];
    return '<div class="trend"><div class="trend-axis"><span>' + esc(fmt(hi)) + '</span><span>' + esc(fmt((hi + lo) / 2)) + '</span><span>' + esc(fmt(lo)) + '</span></div>' +
      '<div class="trend-plot"><div class="cols-grid"><i></i><i></i><i></i></div>' +
      '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + ' L100 100 L0 100 Z" fill="' + VIZ[0] + '" opacity=".1" stroke="none"/>' +
      '<path d="' + d + '" fill="none" stroke="' + VIZ[0] + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      xy.map(function (q) {
        return '<span class="dot" tabindex="0" style="left:' + q.x + '%;top:' + q.y + '%;background:' + VIZ[0] + '" data-tip="' + esc(q.p.tip) + '"></span>';
      }).join('') +
      '<span class="trend-end" style="top:' + last.y + '%">' + esc(fmt(last.p.value)) + '</span></div>' +
      '<div class="trend-x"><span>' + esc(fmtDate(points[0].date, true)) + '</span><span>' + esc(fmtDate(points[points.length - 1].date, true)) + '</span></div></div>';
  }

  // ---------- data ----------
  function reportData() {
    var y = String(new Date().getFullYear());
    var act = cattle().filter(isActive), bl = bulls().filter(isActive);
    var makeup = [
      { label: 'Cows', value: act.filter(function (a) { return a.sex === 'Cow'; }).length },
      { label: 'Heifers', value: act.filter(function (a) { return a.sex === 'Heifer'; }).length },
      { label: 'Steers', value: act.filter(function (a) { return a.sex === 'Steer'; }).length },
      { label: 'Calves', value: act.filter(function (a) { return a.sex === 'Calf'; }).length },
      { label: 'Bulls', value: bl.length }
    ];
    var ages = [['Under 1 yr', 0, 12], ['1–2 yrs', 12, 24], ['2–5 yrs', 24, 60], ['5–8 yrs', 60, 96], ['8+ yrs', 96, 9999]].map(function (b) {
      return { label: b[0], value: act.concat(bl).filter(function (a) { var m = monthsOld(a.birth_date); return m !== null && m >= b[1] && m < b[2]; }).length };
    });
    var unknownAge = act.concat(bl).filter(function (a) { return monthsOld(a.birth_date) === null; }).length;
    if (unknownAge) ages.push({ label: 'Unknown', value: unknownAge });

    var keys = monthKeys(12);
    var born = keys.map(function (k) {
      return S.db.Animals.filter(function (a) { return origin(a) === 'Born on farm' && String(a.birth_date).slice(0, 7) === k; }).length;
    });
    var easeNames = ['Unassisted', 'Assisted', 'Hard pull', 'Vet / C-section'];
    var ease = easeNames.map(function (e) { return { label: e, value: S.db.Calvings.filter(function (c) { return (c.ease || 'Unassisted') === e; }).length }; });

    // Breeding outcome for everything bred/exposed in the last 15 months
    var cutoff = addDays(today(), -455);
    var recent = S.db.Breedings.filter(function (b) { return b.result !== 'Heat' && b.result !== 'Superseded' && bredOn(b) >= cutoff; });
    var outcome = [
      { label: 'Calved', value: recent.filter(function (b) { return b.result === 'Calved'; }).length },
      { label: 'Still waiting', value: recent.filter(function (b) { return (b.result || 'Pending') === 'Pending' && !isOverdue(b); }).length },
      { label: 'Late', value: recent.filter(isOverdue).length },
      { label: 'Didn’t take', value: recent.filter(function (b) { return b.result === 'Open'; }).length }
    ];
    var decided = outcome[0].value + outcome[3].value;
    var rate = decided ? Math.round(outcome[0].value / decided * 100) : null;

    // Money in by month (deposits on the day they were paid, final payments likewise)
    var beef = keys.map(function () { return 0; }), pork = keys.map(function () { return 0; });
    var yearIn = 0;
    S.db.Orders.forEach(function (o) {
      var arr = product(o) === 'Pork' ? pork : beef;
      [[depositPaid(o) ? o.deposit_paid_date : '', num(o.deposit_amount)], [o.final_paid_date, num(o.final_amount)]].forEach(function (pay) {
        if (!pay[0] || !pay[1]) return;
        var i = keys.indexOf(String(pay[0]).slice(0, 7));
        if (i >= 0) arr[i] += pay[1];
        if (String(pay[0]).slice(0, 4) === y) yearIn += pay[1];
      });
    });
    var held = S.db.Orders.filter(function (o) { return (stage(o) === 'Waiting' || stage(o) === 'Assigned') && depositPaid(o); })
      .reduce(function (s, o) { return s + num(o.deposit_amount); }, 0);
    var sup = beefSupply();

    var bullRows = bulls().map(function (b) {
      var per = periodsFor(b.id);
      var cows = per.reduce(function (s, p) { return s + periodCows(p); }, 0);
      var calves = S.db.Animals.filter(function (x) { return x.sire_id === b.id; }).length;
      var fees = per.reduce(function (s, p) { return s + num(p.fee); }, 0);
      return { name: dispName(b), seasons: per.length, cows: cows, calves: calves, fees: fees, perCalf: calves && fees ? fees / calves : null };
    }).filter(function (r) { return r.seasons || r.calves; });

    var custs = customers().sort(function (a, b) { return b.total - a.total; }).slice(0, 8);
    var calvesThisYear = S.db.Animals.filter(function (a) { return origin(a) === 'Born on farm' && String(a.birth_date).slice(0, 4) === y; }).length;

    return { y: y, act: act, bl: bl, makeup: makeup, ages: ages, keys: keys, born: born, ease: ease, outcome: outcome, rate: rate,
      beef: beef, pork: pork, yearIn: yearIn, held: held, sup: sup, bullRows: bullRows, custs: custs, calvesThisYear: calvesThisYear };
  }

  var TREND_CLASSES = [
    ['steer', 'Steers 500–650 lb', function (it) { return /steer/i.test(it.section + ' ' + it.cls) && /^5\d\d/.test(it.weight || ''); }],
    ['heifer', 'Heifers 500–650 lb', function (it) { return /heifer/i.test(it.section + ' ' + it.cls) && !/bred/i.test(it.cls || '') && /^5\d\d/.test(it.weight || ''); }],
    ['cow', 'Slaughter cows (top 50 avg)', function (it) { return /top 50/i.test(it.cls || ''); }]
  ];
  function trendPoints(which) {
    var match = (TREND_CLASSES.find(function (t) { return t[0] === which; }) || TREND_CLASSES[0])[2];
    return S.db.Prices.filter(function (r) { return /chehalis/i.test(r.yard) && !/special/i.test(r.sale_label || ''); })
      .sort(function (a, b) { return String(a.sale_date).localeCompare(String(b.sale_date)); })
      .map(function (r) {
        var it = priceItems(r).find(match);
        return it ? { date: r.sale_date, value: mid(it), tip: fmtDate(r.sale_date, true) + ': ' + priceText(it) + '/cwt' } : null;
      }).filter(Boolean);
  }


  // ---------- herd inventory (sortable, printable) ----------
  var INV_COLS = [
    ['tag', 'Tag', function (a) { return a.tag || ''; }],
    ['name', 'Name', function (a) { return a.name || ''; }],
    ['breed', 'Breed', function (a) { return a.breed || ''; }],
    ['sex', 'Type', function (a) { return isBull(a) ? 'Bull' : sexText(a); }],
    ['age', 'Age', function (a) { return a.birth_date ? ageText(a.birth_date, true) : ''; }, function (a) { return a.birth_date ? -parseD(a.birth_date).getTime() : -Infinity; }],
    ['status', 'Status', function (a) { return statusLabel(st(a), a).replace(/^[^A-Za-z0-9]+/, ''); }],
    ['dam', 'Dam', function (a) { var d = a.dam_id && byId('Animals', a.dam_id); return d ? tagName(d) : (a.dam_name || ''); }],
    ['sire', 'Sire', function (a) { var d = a.sire_id && byId('Animals', a.sire_id); return d ? tagName(d) : (a.sire_name || ''); }]
  ];
  function inventoryHTML() {
    var sort = UI.invSort || 'tag', dir = UI.invDir || 1;
    var col = INV_COLS.find(function (c) { return c[0] === sort; }) || INV_COLS[0];
    var key = col[3] || col[2];
    var rows = cattle().filter(isActive).concat(bulls().filter(isActive)).sort(function (x, y) {
      var a = key(x), b = key(y);
      if (a === b) return 0;
      if (a === '' || a === -Infinity) return 1;
      if (b === '' || b === -Infinity) return -1;
      return (typeof a === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })) * dir;
    });
    return '<section class="card viz span2 inv"><div class="card-head"><h2 class="sec-title">Herd inventory · ' + rows.length + ' head</h2>' +
      '<button type="button" class="btn btn-line btn-sm no-print" data-action="print-report">Print</button></div>' +
      (rows.length ? '<div class="tbl-wrap"><table class="tbl tbl-sort"><thead><tr>' + INV_COLS.map(function (c) {
        var on = c[0] === sort;
        return '<th' + (on ? ' aria-sort="' + (dir > 0 ? 'ascending' : 'descending') + '"' : '') + '><button type="button" data-action="inv-sort" data-k="' + c[0] + '">' + c[1] +
          (on ? (dir > 0 ? ' ▲' : ' ▼') : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>' + rows.map(function (a) {
        return '<tr>' + INV_COLS.map(function (c, i) {
          var v = c[2](a);
          return '<td>' + (i === 0 && v ? '<a class="link-inline" href="#/animal/' + esc(a.id) + '">' + esc(v) + '</a>' : esc(v) || '<span class="muted">—</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' : '<p class="hint" style="margin:0">No animals yet.</p>') + '</section>';
  }

  function viewReports() {
    var d = reportData();
    var tile = function (label, value, sub) {
      return '<div class="tile"><span class="tile-l">' + esc(label) + '</span><b class="tile-v">' + value + '</b>' + (sub ? '<span class="tile-s">' + sub + '</span>' : '') + '</div>';
    };
    var pts = trendPoints(UI.trend || 'steer');
    var moneyFmt = function (v) { return money(v); };
    var anyMoney = d.beef.concat(d.pork).some(function (v) { return v > 0; });

    return '<div class="screen wide"><header class="hdr"><div class="hdr-titles"><span class="eyebrow">Musgrove Farms</span><h1 class="h1">Reports</h1></div></header>' +
      '<div id="sync-banner">' + bannerHTML() + '</div>' +
      '<div class="content reports">' +
      '<div class="tiles">' +
      tile('Head in the herd', d.act.length + d.bl.length, d.bl.length ? d.bl.length + ' bull' + (d.bl.length === 1 ? '' : 's') : '') +
      (function () {
        var rs = d.act.filter(function (a) { return st(a) === 'Ready steak'; }).length, rb = d.act.filter(function (a) { return st(a) === 'Ready burger'; }).length;
        return tile('Ready for harvest', rs + rb, '🥩 ' + rs + ' steak · 🍔 ' + rb + ' burger');
      })() +
      tile('Calves born ' + d.y, d.calvesThisYear, d.rate !== null ? d.rate + '% of settled breedings calved' : '') +
      tile('Money in ' + d.y, money(d.yearIn), 'Deposits + final payments') +
      tile('Deposits held', money(d.held), 'On open orders') +
      tile('Waitlist', fmtHead(d.sup.steakWanted) + ' head', d.sup.burgerWanted ? lbs(d.sup.burgerWanted) + ' burger' : '') +
      '</div>' +

      '<div class="rgrid">' +
      '<section class="card viz"><h2 class="sec-title">Herd makeup</h2>' + hbars(d.makeup, VIZ[0]) +
      tableView(['Type', 'Head'], d.makeup.map(function (m) { return [m.label, m.value]; })) + '</section>' +

      '<section class="card viz"><h2 class="sec-title">Ages</h2>' + hbars(d.ages, VIZ[2]) +
      tableView(['Age', 'Head'], d.ages.map(function (m) { return [m.label, m.value]; })) + '</section>' +

      '<section class="card viz span2"><h2 class="sec-title">Calves born — last 12 months</h2>' + columns(d.keys, [{ name: 'Calves', color: VIZ[3], values: d.born }]) +
      tableView(['Month', 'Calves'], d.keys.map(function (k, i) { return [monthLabel(k, true), d.born[i]]; })) + '</section>' +

      '<section class="card viz"><h2 class="sec-title">Breeding results — last 15 months</h2>' + hbars(d.outcome, VIZ[1]) +
      (d.rate !== null ? '<p class="hint" style="margin:0"><strong>' + d.rate + '%</strong> of breedings that have settled produced a calf.</p>' : '') +
      tableView(['Result', 'Breedings'], d.outcome.map(function (m) { return [m.label, m.value]; })) + '</section>' +

      '<section class="card viz"><h2 class="sec-title">Calving ease</h2>' + hbars(d.ease, VIZ[2]) +
      tableView(['Ease', 'Calvings'], d.ease.map(function (m) { return [m.label, m.value]; })) + '</section>' +

      '<section class="card viz span2"><h2 class="sec-title">Money in — last 12 months</h2>' +
      (anyMoney ? legend([['Beef', VIZ[0]], ['Pork', VIZ[1]]]) + columns(d.keys, [{ name: 'Beef', color: VIZ[0], values: d.beef }, { name: 'Pork', color: VIZ[1], values: d.pork }], moneyFmt, { money: true })
        : '<p class="hint" style="margin:0">Nothing paid yet. Deposits and final payments show up here by the month they were paid.</p>') +
      tableView(['Month', 'Beef', 'Pork'], d.keys.map(function (k, i) { return [monthLabel(k, true), money(d.beef[i]), money(d.pork[i])]; })) + '</section>' +

      '<section class="card viz span2"><div class="card-head"><h2 class="sec-title">Chehalis prices over time</h2>' +
      '<label class="sr" for="trend-pick">Price class</label><select id="trend-pick" class="inp inp-sm" data-trend>' + TREND_CLASSES.map(function (t) {
        return '<option value="' + t[0] + '"' + ((UI.trend || 'steer') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
      }).join('') + '</select></div>' +
      trendLine(pts, function (v) { return '$' + Math.round(v); }) +
      '<p class="hint" style="margin:0">Middle of each sale’s price range, $/cwt. Regular sales only.</p>' +
      (pts.length ? tableView(['Sale', '$/cwt (middle)'], pts.map(function (p) { return [fmtDate(p.date, true), '$' + Math.round(p.value)]; })) : '') + '</section>' +

      '<section class="card viz"><h2 class="sec-title">Bulls</h2>' +
      (d.bullRows.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Bull</th><th class="num">Seasons</th><th class="num">Cows</th><th class="num">Calves</th><th class="num">Fees</th><th class="num">Per calf</th></tr></thead><tbody>' +
        d.bullRows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td class="num">' + r.seasons + '</td><td class="num">' + r.cows + '</td><td class="num">' + r.calves + '</td><td class="num">' +
            (r.fees ? money(r.fees) : '—') + '</td><td class="num">' + (r.perCalf !== null ? money(r.perCalf) : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="hint" style="margin:0">Fills in once bulls have time with the cows and calves are recorded.</p>') + '</section>' +

      '<section class="card viz"><h2 class="sec-title">Top customers</h2>' +
      (d.custs.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Customer</th><th class="num">Orders</th><th class="num">Total</th><th class="num">Last paid</th></tr></thead><tbody>' +
        d.custs.map(function (c) {
          return '<tr><td><a class="link-inline" href="#/customer/' + encodeURIComponent(c.key) + '">' + esc([c.first, c.last].filter(Boolean).join(' ') || 'No name') + '</a></td><td class="num">' +
            c.orders.length + '</td><td class="num">' + money(c.total) + '</td><td class="num">' + esc(fmtDate(c.paid, true)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="hint" style="margin:0">Customers appear once an order is paid in full.</p>') + '</section>' +
      inventoryHTML() +
      '</div><p class="hint print-only">Printed ' + esc(fmtDate(today(), true)) + ' · Musgrove Farms</p></div>' + nav('reports') + '</div>';
  }

  // ---------- one floating tooltip for every chart ----------
  (function () {
    var tip = null;
    function show(el) {
      if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tip'; tip.setAttribute('role', 'status'); document.body.appendChild(tip); }
      tip.textContent = el.getAttribute('data-tip');
      var r = el.getBoundingClientRect();
      tip.style.display = 'block';
      var w = tip.offsetWidth, x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      var yy = r.top - tip.offsetHeight - 8; if (yy < 8) yy = r.bottom + 8;
      tip.style.left = x + 'px'; tip.style.top = yy + 'px';
    }
    function hide() { if (tip) tip.style.display = 'none'; }
    document.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
    document.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el); });
    document.addEventListener('focusout', hide);
    document.addEventListener('touchstart', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el); else hide(); }, { passive: true });
    window.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('hashchange', hide);
  })();

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
    // On a computer the editor sets up the left menu; on a phone, the bottom bar.
    var kind = isDesk() ? 'side' : 'bar';
    var order = navOrder(kind).filter(function (k) { return !(kind === 'side' && k === 'settings'); });
    var pool = NAV_ALL.filter(function (k) { return !(kind === 'side' && k === 'settings'); });
    var hidden = pool.filter(function (k) { return order.indexOf(k) < 0; });
    var rows = order.concat(hidden).map(function (k, i) {
      var on = order.indexOf(k) >= 0, it = NAV_ITEMS[k], label = navLabel(k, kind);
      return '<div class="nav-row' + (on ? '' : ' off') + '"><label class="nav-check"><input type="checkbox" data-nav-toggle="' + k + '" data-kind="' + kind + '"' + (on ? ' checked' : '') +
        (on && order.length <= 3 ? ' disabled' : '') + '><span class="nav-ico">' + it[2] + '</span>' + label +
        (k === 'more' ? ' <span class="hint">· pop-out of everything else, A–Z</span>' : '') + '</label>' +
        (on ? '<button type="button" class="sq-btn" data-action="nav-move" data-kind="' + kind + '" data-k="' + k + '" data-d="-1" aria-label="Move ' + label + ' earlier"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="sq-btn" data-action="nav-move" data-kind="' + kind + '" data-k="' + k + '" data-d="1" aria-label="Move ' + label + ' later"' + (i === order.length - 1 ? ' disabled' : '') + '>↓</button>' : '') + '</div>';
    }).join('');
    var offBar = moreKeys(order, kind).filter(function (k) { return k !== 'settings'; });
    var where = kind === 'side' ? 'menu' : 'bar';
    return '<div class="screen">' + backHeader('Settings', '#/herd') +
      '<div class="content">' +
      '<section class="card"><h2 class="sec-title">Sync</h2><div id="settings-sync">' + settingsSyncHTML() + '</div>' +
      '<button type="button" class="btn btn-dark" data-action="sync">' + I.sync + 'Sync now</button></section>' +
      '<form class="card" data-form="who" novalidate><h2 class="sec-title">This device</h2>' +
      '<div class="kv"><div><span>Access</span><b>' + (isAdmin() ? 'Admin' : 'Farm') + '</b></div></div>' +
      '<label class="field"><span class="lbl">Device name (shown as who made each change)</span><input class="inp" name="who" value="' + esc(S.who) + '" required></label>' +
      '<button type="submit" class="btn btn-line">Save name</button></form>' +
      (isAdmin()
        ? '<section class="card"><h2 class="sec-title">Signed-in devices</h2><div id="device-list">' + (UI.devices ? devicesHTML(UI.devices) : '<p class="hint" style="margin:0">Loading…</p>') + '</div>' +
          '<p class="hint" style="margin:0">Remove any device you don’t recognize. Changing an access code in the Sheet’s script (and deploying) signs out every device that used it.</p></section>'
        : '<section class="card"><h2 class="sec-title">Admin</h2><p class="hint" style="margin:0;font-size:14px">This device can add and edit everything. Signed-in devices, deleting animals, bulls and customers, and taking orders off the waitlist are handled by the farm admin.</p></section>') +
      invoiceSettingsHTML() +
      '<section class="card"><h2 class="sec-title">Prices &amp; butcher</h2><p class="hint" style="margin:0;font-size:14px">Haul cost, your prices, deposits, the butcher (name, town and rates) and the deposit-invoice estimate.</p>' +
      '<a class="btn btn-line" href="#/settings/numbers">Open Our numbers</a></section>' +
      '<section class="card"><h2 class="sec-title">Install tips</h2>' +
      '<p class="hint" style="margin:0;font-size:14px;line-height:1.5"><strong>iPhone:</strong> open in Safari → Share → Add to Home Screen.<br><strong>Android:</strong> open in Chrome → ⋮ menu → Add to Home screen (or Install app).</p></section>' +
      '<section class="card"><h2 class="sec-title">Sign out</h2><p class="hint" style="margin:0;font-size:14px;line-height:1.5">Signs this device out and clears its copy of the herd. The Google Sheet is not touched.</p>' +
      '<button type="button" class="btn btn-danger" data-action="sign-out">Sign out of this device</button></section>' +
      '<section class="card"><h2 class="sec-title">' + (kind === 'side' ? 'Left menu on this computer' : 'Bottom bar on this device') + '</h2>' +
      '<p class="hint" style="margin:0;font-size:14px">Tick the pages and shortcuts you want and put them in order' + (kind === 'bar' ? ' (up to 6)' : '') + '. <strong>More</strong> opens a pop-out with everything you didn’t tick, A–Z. ' +
      (kind === 'side' ? 'Settings always sits at the bottom of the menu. The phone bottom bar is set up separately on the phone.' : 'The gear on the Herd page always opens Settings. On a computer, this list sets up the left menu instead.') +
      ' Saved for this device name.</p>' +
      '<div class="nav-list">' + rows + '</div></section>' +
      (offBar.length ? '<section class="card"><h2 class="sec-title">Pages not on the ' + where + '</h2><div class="btn-row wrap">' + offBar.map(function (k) {
        return '<a class="btn btn-line btn-sm" href="' + NAV_ITEMS[k][0] + '">' + NAV_ITEMS[k][2] + NAV_ITEMS[k][1] + '</a>';
      }).join('') + '</div></section>' : '') +
      '<p class="updated">Herd Tracker ' + esc(VERSION) + '</p></div>' + nav('settings') + '</div>';
  }
  function invoiceSettingsHTML() {
    var email = invSetting('invoice_email'), auto = invSetting('invoice_auto') !== 'no';
    if (!isAdmin()) {
      return '<section class="card"><h2 class="sec-title">Invoices</h2><p class="hint" style="margin:0;font-size:14px">' +
        (email && auto ? 'When an order is paid in full, a PDF invoice is emailed to ' + esc(email) + '.' : 'Invoice emails are off.') + ' The admin sets this up.</p></section>';
    }
    var t = function (k, label, ph, type) {
      return '<label class="field"><span class="lbl">' + label + '</span><input class="inp" name="' + k + '"' + (type ? ' type="' + type + '"' : '') +
        ' value="' + esc(invSetting(k)) + '" placeholder="' + ph + '" autocomplete="off"></label>';
    };
    return '<form class="card" data-form="invoice-settings" novalidate><h2 class="sec-title">Invoices</h2>' +
      '<p class="hint" style="margin:0;font-size:14px">When an order is marked paid in full, a one-page PDF invoice (with this letterhead) is emailed to the address below.</p>' +
      '<label class="nav-check"><input type="checkbox" name="invoice_auto" value="yes"' + (auto ? ' checked' : '') + '>Email an invoice when an order is paid in full</label>' +
      t('invoice_email', 'Send invoices to', 'you@example.com', 'email') +
      t('farm_name', 'Farm name on the invoice', 'Musgrove Farms') +
      '<label class="field"><span class="lbl">Address</span><textarea class="inp" name="farm_address" rows="2" placeholder="Street&#10;Town, WA 98629">' + esc(invSetting('farm_address')) + '</textarea></label>' +
      t('farm_phone', 'Phone', '(360) 555-0100', 'tel') +
      '<label class="field"><span class="lbl">Venmo (for getting paid)</span><span class="money-inp"><span aria-hidden="true">@</span><input class="inp" name="venmo" value="' + esc(invSetting('venmo')) + '" placeholder="Musgrove-Farms" autocomplete="off" autocapitalize="off" spellcheck="false"></span>' +
      '<span class="hint">Printed on both invoices. Deposit invoices get a Venmo QR code for the remaining balance.</span></label>' +
      '<p class="form-err" role="alert"></p><button type="submit" class="btn btn-line">Save invoice settings</button></form>';
  }
  function devicesHTML(list) {
    if (!list || !list.length) return '<p class="hint" style="margin:0">No devices found.</p>';
    return '<div class="sub-list">' + list.map(function (d) {
      return '<span class="li"><span><strong>' + esc(d.name) + '</strong>' + (d.role === 'admin' ? ' <span class="pill p-accent">Admin</span>' : '') + (d.me ? ' <span class="pill p-herd">This device</span>' : '') +
        '<br><span class="hint">Signed in ' + esc(fmtDate(localDateOf(d.created), true)) + ' · last used ' + esc(relTime(d.seen)) + '</span></span>' +
        (d.me ? '' : '<button type="button" class="btn btn-danger btn-sm" data-action="revoke-device" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Remove</button>') + '</span>';
    }).join('') + '</div>';
  }
  function loadDevices() {
    var box = document.getElementById('device-list');
    if (!box) return;
    api('devices').then(function (r) { UI.devices = r.devices; if (box.isConnected) box.innerHTML = devicesHTML(r.devices); },
      function (e) { if (box.isConnected) box.innerHTML = '<p class="hint" style="margin:0">' + esc(e.offline ? 'Needs signal to load.' : e.message) + '</p>'; });
  }
  function savePrefs(msg) {
    lsSet('herd.prefs', JSON.stringify(S.prefs));
    api('savePrefs', { prefs: S.prefs }).catch(function () { /* kept on this device; saved next time */ });
    if (msg) toast(msg);
  }

  function viewNotFound(msg) {
    return '<div class="screen"><header class="hdr"><h1 class="h1">Not found</h1></header><div class="content"><div class="empty"><b>' + esc(msg) + '</b>' +
      '<a class="btn btn-dark" href="#/herd">Back to the herd</a></div></div>' + nav('') + '</div>';
  }

  // ==========================================================================
  // Router
  // ==========================================================================
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, '').replace(/#.*$/, '');
    var parts = h.split('?');
    var q = {};
    new URLSearchParams(parts[1] || '').forEach(function (v, k) { q[k] = v; });
    return { p: parts[0].split('/').filter(Boolean).map(decodeURIComponent), q: q };
  }
  function route(r) {
    var p = r.p, q = r.q;
    switch (p[0]) {
      case 'animal':
        if (p[2] === 'edit') return { html: viewAnimalForm(p[1], q), form: true };
        if (p[2] === 'dose') return { html: viewDose(p[1]), form: true };
        if (p[2] === 'harvest') return { html: viewHarvest(p[1]), form: true };
        if (p[2] === 'period') return { html: viewPeriodChange(p[1], q), form: true };
        return { html: viewAnimal(p[1]) };
      case 'photo': return { html: viewPhoto(p[1]), form: true };
      case 'period': return { html: viewPeriodEdit(p[1]), form: true };
      case 'add': return { html: viewAnimalForm(null, q, false), form: true };
      case 'breeding':
        if (p[1] === 'new') return { html: viewBreedingForm(q), form: true };
        if (p[2] === 'calve') return { html: viewCalving(p[1]), form: true };
        return { html: viewBreeding() };
      case 'bulls':
        if (p[1] === 'add') return { html: viewAnimalForm(null, q, true), form: true };
        return { html: viewBulls() };
      case 'sales': return { html: viewSales() };
      case 'customer': return { html: viewCustomer(p[1]) };
      case 'customers': return { html: viewCustomersPage() };
      case 'compare': UI.marketView = 'compare'; return { html: viewMarket(), form: true };
      case 'order':
        if (p[1] === 'new') return { html: viewOrderForm(null, q), form: true };
        if (p[2] === 'assign') return { html: viewAssign(p[1]) };
        return { html: viewOrderForm(p[1], q), form: true };
      case 'market': return { html: viewMarket(), form: UI.marketView !== 'prices' };
      case 'reports': return { html: viewReports() };
      case 'settings':
        if (p[1] === 'numbers') return { html: viewNumbersPage(), form: true };
        return { html: viewSettings() };
      default: return { html: viewHerd() };
    }
  }
  function render() {
    var app = document.getElementById('app');
    if (!S.token) {
      if (currentKey !== '__setup') { app.innerHTML = viewSetup(); currentKey = '__setup'; }
      currentIsForm = true;
      return;
    }
    if (!location.hash && window.matchMedia && matchMedia('(min-width: 1024px)').matches) history.replaceState(null, '', '#/reports');
    var key = location.hash || '#/herd';
    var fresh = key !== currentKey;
    if (fresh) { formPhoto = null; currentKey = key; }
    var pr = parseRoute();
    var r = route(pr);
    var SIDE_OF = { animal: 'herd', photo: 'herd', add: 'add', order: pr.p[1] === 'new' ? 'neworder' : 'sales', customer: 'customers', period: 'breeding', compare: 'market' };
    var side = SIDE_OF[pr.p[0]] || (pr.p[0] === 'breeding' && pr.p[1] === 'new' ? 'logheat' : pr.p[0] || 'herd');
    r.html += sideNav(side);
    if (fresh && /#lineage$/.test(key)) setTimeout(function () { var l = document.getElementById('lineage'); if (l) l.scrollIntoView({ block: 'start' }); }, 30);
    currentIsForm = !!r.form;
    app.innerHTML = r.html;
    if (fresh) window.scrollTo(0, 0);
    afterRender(fresh);
  }
  function refreshView() {
    if (currentIsForm) { renderStatus(); return; }
    var y = window.scrollY;
    var ae = document.activeElement;
    if (ae && ae.id === 'herd-search') {                // don't steal focus while typing a search
      var l = document.getElementById('herd-list');
      if (l) { l.innerHTML = herdListHTML(); hydratePhotos(); }
      renderStatus();
      return;
    }
    if (ae && ae.id === 'cust-search') {
      var cl = document.getElementById('cust-list');
      if (cl) cl.innerHTML = customerRowsHTML();
      renderStatus();
      return;
    }
    render();
    window.scrollTo(0, y);
  }
  function afterRender(fresh) {
    hydratePhotos();
    if (fresh && parseRoute().p[0] === 'settings' && isAdmin()) loadDevices();
    document.querySelectorAll('form[data-form]').forEach(function (f) { onFormInput(f, null); });
    if (fresh && parseRoute().q.pay) {
      var pay = document.getElementById('payments');
      if (pay) setTimeout(function () { pay.scrollIntoView({ block: 'start' }); }, 30);
    }
  }

  // ==========================================================================
  // Form behavior (show/hide, live hints)
  // ==========================================================================
  function val(form, name) {
    var el = form.elements[name];
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked ? el.value : '';
    return el.value || '';
  }
  function onFormInput(form, changed) {
    var kind = form.dataset.form;
    if (kind === 'animal' && changed === 'origin' && val(form, 'origin') !== 'Purchased' && form.elements.offsite) form.elements.offsite.checked = false;
    form.querySelectorAll('[data-show-when]').forEach(function (el) {
      el.hidden = !el.getAttribute('data-show-when').split(';').every(function (cond) {
        var i = cond.indexOf(':');
        return cond.slice(i + 1).split('|').indexOf(val(form, cond.slice(0, i))) >= 0;
      });
    });
    if (kind === 'animal') {
      var h = document.getElementById('age-hint');
      var b = val(form, 'birth_date');
      if (h) h.textContent = b ? 'Age: ' + ageText(b) : 'Age is worked out from this date.';
    }
    if (kind === 'photo') {
      var a = byId('Animals', form.dataset.animal);
      var pa = document.getElementById('photo-age');
      var td = val(form, 'taken_date');
      if (pa) pa.textContent = td && a && a.birth_date ? esc(dispName(a)) + ' was ' + ageText(a.birth_date, false, td) + ' old' : '';
    }
    if (kind === 'breeding') {
      var bred = val(form, 'bred_date'), heat = val(form, 'heat_date');
      var e = document.getElementById('exp-text');
      if (e) e.innerHTML = val(form, 'method') === 'Heat'
        ? 'Next heat ≈ <strong>' + (heat ? esc(fmtDate(addDays(heat, HEAT_CYCLE), true)) : '—') + '</strong> (' + HEAT_CYCLE + '-day cycle)'
        : 'Expected calving: <strong>' + (bred ? esc(fmtDate(addDays(bred, GESTATION_DAYS), true)) : '—') + '</strong> (~' + GESTATION_DAYS + ' days)';
      var w = document.getElementById('rel-warn');
      var msg = val(form, 'method') === 'Natural' ? relatedness(val(form, 'cow_id'), val(form, 'bull_id')) : '';
      var cow = val(form, 'cow_id');
      var existing = cow && pendingFor(cow);
      if (existing) msg = (msg ? msg + ' ' : '') + 'She already has a breeding logged on ' + fmtDate(existing.bred_date, true) + ' — saving will mark that one as didn’t take.';
      if (w) { w.textContent = msg ? '⚠ ' + msg : ''; w.hidden = !msg; }
    }
    if (kind === 'calc') updateCalc(form, changed);
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
  function tagTaken(tag, exceptId) {
    if (!tag) return null;
    return S.db.Animals.find(function (a) {
      return a.id !== exceptId && isActive(a) && String(a.tag || '').toLowerCase() === tag.toLowerCase();
    }) || null;
  }

  // ==========================================================================
  // Form submits
  // ==========================================================================
  var forms = {
    setup: function (form) {
      var f = fields(form);
      if (!f.who) return formError(form, 'Enter a device name.');
      if (!f.passcode) return formError(form, 'Enter the access code.');
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      S.who = f.who;
      return api('login', { passcode: f.passcode }).then(function (res) {
        signedIn(res);
        currentKey = null;
        location.hash = '#/herd';
        render();
        return trySync();
      }, function (e) {
        btn.disabled = false; btn.textContent = 'Sign in';
        formError(form, e.code === 'AUTH' || e.code === 'LOCKED' ? e.message
          : e.offline ? 'Can’t connect. Check your signal and try again.' : e.message);
      });
    },

    who: function (form) {
      var f = fields(form);
      if (!f.who) return formError(form, 'Enter a device name.');
      S.who = f.who; lsSet('herd.who', f.who);
      api('savePrefs', { prefs: S.prefs }).then(loadDevices, function () {});
      toast('Name saved');
    },

    animal: function (form) {
      var f = fields(form);
      var id = form.dataset.id;
      var existing = id ? byId('Animals', id) : null;
      var bull = form.dataset.bull === '1';
      var breed = breedFromForm(f);
      var offsite = !bull && f.origin === 'Purchased' && f.offsite === 'yes';
      var status = f.status;
      if (offsite && ACTIVE.indexOf(status) >= 0 && status !== 'Ready burger') status = 'Ready steak';
      var dup = tagTaken(f.tag, id);
      if (dup && ACTIVE.indexOf(status) >= 0) return formError(form, 'Tag ' + f.tag + ' is already used by ' + dispName(dup) + '.');
      if (!bull && f.origin === 'Purchased' && !offsite && !f.joined_date) return formError(form, 'Add the date it joined the herd (or tick Offsite).');
      if (f.purchase_price && !hasNum(f.purchase_price)) return formError(form, 'Purchase price should be a number.');
      if (f.fee && !hasNum(f.fee)) return formError(form, 'The season fee should be a number.');
      var history = existing ? (existing.tag_history || '') : '';
      if (existing && existing.tag && existing.tag !== f.tag) {
        var list = history ? history.split(/,\s*/) : [];
        if (list.indexOf(existing.tag) < 0) list.unshift(existing.tag);
        history = list.join(', ');
      }
      var row = { id: id || uuid(), tag: f.tag, name: f.name, breed: breed, notes: f.notes, tag_history: history };
      var changes = [];
      if (bull) {
        Object.assign(row, { sex: 'Bull', origin: 'Purchased', status: status });
        var wasIn = existing && st(existing) === 'With cows';
        if (!id && f.in_now === 'yes') {
          if (!f.start_date) return formError(form, 'When did he go in with the cows?');
          row.status = 'With cows';
          changes = changes.concat(periodStartChanges(row, f.start_date, f.fee, ''));
        } else if (wasIn && status !== 'With cows') {
          changes = changes.concat(periodEndChanges(existing, f.end_date || today()));
        }
      } else {
        var dam = f.dam_id === '__other' ? '' : f.dam_id, sire = f.sire_id === '__other' ? '' : f.sire_id;
        Object.assign(row, {
          sex: f.sex, calf_sex: f.sex === 'Calf' ? (f.calf_sex || 'Heifer') : '',
          birth_date: f.birth_date, status: status, origin: f.origin, offsite: offsite ? 'yes' : '',
          purchase_price: f.origin === 'Purchased' && f.purchase_price ? String(num(f.purchase_price)) : '',
          joined_date: f.origin === 'Purchased' && !offsite ? f.joined_date : '', lease_until: '',
          dam_id: offsite ? '' : dam, sire_id: offsite ? '' : sire,
          dam_name: !offsite && f.dam_id === '__other' ? f.dam_name : '',
          sire_name: !offsite && f.sire_id === '__other' ? f.sire_name : ''
        });
      }
      if (!id && f.iver_date) {
        changes.push({ table: 'Treatments', op: 'upsert', row: { id: uuid(), animal_id: row.id, date: f.iver_date, product: 'Ivermectin', dose: f.iver_dose } });
      }
      var chain = Promise.resolve([]);
      if (!id && formPhoto) chain = photoChanges(row, formPhoto, today(), true);
      return chain.then(function (pch) {
        formPhoto = null;
        var all = [{ table: 'Animals', op: 'upsert', row: row }].concat(changes, pch);
        return commit(all, { go: '#/animal/' + row.id, msg: id ? 'Saved' : dispName(row) + ' added' });
      });
    },

    'period-start': function (form) {
      var f = fields(form);
      var a = byId('Animals', form.dataset.id);
      if (!a) return formError(form, 'That bull is gone.');
      if (!f.start_date) return formError(form, 'When did he go in with the cows?');
      if (f.fee && !hasNum(f.fee)) return formError(form, 'The season fee should be a number.');
      var ch = [{ table: 'Animals', op: 'upsert', row: { id: a.id, status: 'With cows' } }].concat(periodStartChanges(a, f.start_date, f.fee, f.notes));
      var n = ch.filter(function (c) { return c.table === 'Breedings'; }).length;
      return commit(ch, { go: '#/breeding', msg: dispName(a) + ' is in · ' + n + (n === 1 ? ' cow' : ' cows') + ' exposed' });
    },

    'period-end': function (form) {
      var f = fields(form);
      var a = byId('Animals', form.dataset.id);
      if (!a) return formError(form, 'That bull is gone.');
      if (!f.end_date) return formError(form, 'When did he come out?');
      var op = openPeriod(a.id);
      if (op && f.end_date < op.start_date) return formError(form, 'He can’t come out before he went in (' + fmtDate(op.start_date, true) + ').');
      var to = form.dataset.to || 'In herd';
      var row = { id: a.id, status: to };
      if (to === 'Harvested') row.harvest_for = 'Burger';
      var go = to === 'Harvested' || to === 'Sold' ? '#/animal/' + a.id + '/harvest' : '#/breeding';
      return commit([{ table: 'Animals', op: 'upsert', row: row }].concat(periodEndChanges(a, f.end_date)), { go: go, msg: dispName(a) + ' is out' });
    },

    'period-edit': function (form) {
      var f = fields(form);
      var p = byId('BullPeriods', form.dataset.id);
      if (!p) return formError(form, 'Those dates are gone.');
      if (!f.start_date) return formError(form, 'Enter the date he went in.');
      if (f.end_date && f.end_date < f.start_date) return formError(form, 'He can’t come out before he went in.');
      if (f.fee && !hasNum(f.fee)) return formError(form, 'The season fee should be a number.');
      var ch = [{ table: 'BullPeriods', op: 'upsert', row: { id: p.id, start_date: f.start_date, end_date: f.end_date, fee: f.fee ? String(num(f.fee)) : '', notes: f.notes } }];
      S.db.Breedings.forEach(function (b) {
        if (b.period_id === p.id) ch.push({ table: 'Breedings', op: 'upsert', row: { id: b.id, exposure_start: f.start_date, exposure_end: f.end_date } });
      });
      var bull = byId('Animals', p.bull_id);
      if (bull && !f.end_date && st(bull) !== 'With cows') ch.push({ table: 'Animals', op: 'upsert', row: { id: bull.id, status: 'With cows' } });
      if (bull && f.end_date && st(bull) === 'With cows' && openPeriod(bull.id) && openPeriod(bull.id).id === p.id) ch.push({ table: 'Animals', op: 'upsert', row: { id: bull.id, status: 'In herd' } });
      return commit(ch, { go: '#/animal/' + p.bull_id, msg: 'Dates saved' });
    },

    photo: function (form) {
      var f = fields(form);
      var pid = form.dataset.id, aid = form.dataset.animal;
      var p = byId('Photos', pid);
      var a = byId('Animals', aid);
      var row;
      if (p) row = { id: p.id, taken_date: f.taken_date, note: f.note };
      else row = { id: uuid(), animal_id: aid, photo_id: a && a.photo_id, taken_date: f.taken_date, note: f.note };   // main photo from before the gallery
      return commit([{ table: 'Photos', op: 'upsert', row: row }], { go: '#/animal/' + aid, msg: 'Photo saved' });
    },

    dose: function (form) {
      var f = fields(form);
      if (!f.date) return formError(form, 'Enter the date it was given.');
      return commit([{ table: 'Treatments', op: 'upsert', row: {
        id: uuid(), animal_id: form.dataset.id, date: f.date, product: f.product || 'Ivermectin', dose: f.dose, notes: f.notes
      } }], { go: '#/animal/' + form.dataset.id, msg: 'Dose logged' });
    },

    harvest: function (form) {
      var f = fields(form);
      var id = form.dataset.id;
      var row = { id: id, harvest_date: f.harvest_date, harvest_notes: f.harvest_notes };
      if (form.dataset.sold) {
        row.sale_price = f.sale_price ? String(num(f.sale_price)) : '';
        row.status = 'Sold';
      } else {
        if (f.hanging_weight && !hasNum(f.hanging_weight)) return formError(form, 'Hanging weight should be a number of pounds.');
        if (f.burger_lbs && !hasNum(f.burger_lbs)) return formError(form, 'Burger should be a number of pounds.');
        row.harvest_for = f.harvest_for;
        row.hanging_weight = f.hanging_weight ? String(num(f.hanging_weight)) : '';
        row.burger_lbs = f.burger_lbs ? String(num(f.burger_lbs)) : '';
        row.butcher = f.butcher;
        row.status = 'Harvested';
      }
      return commit([{ table: 'Animals', op: 'upsert', row: row }], { go: '#/animal/' + id, msg: 'Saved' });
    },

    breeding: function (form) {
      var f = fields(form);
      if (!f.cow_id) return formError(form, 'Choose the cow or heifer.');
      if (f.method === 'Heat') {
        if (!f.heat_date) return formError(form, 'Enter the date you saw her in heat.');
        UI.breedTab = 'open';
        return commit([{ table: 'Breedings', op: 'upsert', row: {
          id: uuid(), cow_id: f.cow_id, method: 'Heat', heat_date: f.heat_date, result: 'Heat', notes: f.notes
        } }], { go: '#/breeding', msg: 'Heat logged · next ≈ ' + fmtDate(addDays(f.heat_date, HEAT_CYCLE)) });
      }
      if (f.method === 'Natural' && !f.bull_id) return formError(form, 'Choose the bull, or switch to AI.');
      if (!f.bred_date) return formError(form, 'Enter the date she was bred.');
      var changes = [];
      var prev = pendingFor(f.cow_id);
      if (prev) changes.push({ table: 'Breedings', op: 'upsert', row: { id: prev.id, result: isExposure(prev) ? 'Superseded' : 'Open' } });
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
      var dup = tagTaken(f.tag);
      if (dup) return formError(form, 'Tag ' + f.tag + ' is already used by ' + dispName(dup) + '.');
      var cow = byId('Animals', b.cow_id);
      var calfId = uuid();
      var changes = [
        { table: 'Animals', op: 'upsert', row: {
          id: calfId, tag: f.tag, name: f.name, breed: breedFromForm(f), sex: 'Calf', calf_sex: f.calf_sex || 'Heifer', birth_date: f.calving_date,
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
      if (!f.first_name) return formError(form, 'Enter a first name.');
      if (!f.phone) return formError(form, 'Enter a phone number so you can reach them.');
      var burger = f.share === 'Burger';
      if (burger && !(num(f.burger_lbs) > 0)) return formError(form, 'How many lbs of burger do they want?');
      if (f.deposit_amount && !hasNum(f.deposit_amount)) return formError(form, 'The deposit amount should be a number.');
      if (f.final_amount && !hasNum(f.final_amount)) return formError(form, 'The final payment should be a number.');
      if (f.final_paid_date && !f.final_amount) return formError(form, 'Enter the final payment amount.');
      // Animals are assigned from the waitlist (Assign an animal), not on this form. Editing keeps the current one
      // unless the order switched between steak and burger.
      var assigned = existing && existing.assigned_animal_id && f.product === 'Beef' && isBurger(existing) === burger ? existing.assigned_animal_id : '';
      var qty = burger ? 1 : Math.max(1, parseInt(f.quantity, 10) || 1);
      var status = existing && existing.status === 'Cancelled' ? 'Cancelled'
        : f.final_paid_date ? 'Complete' : assigned ? 'Assigned' : 'Waiting';
      var row = {
        id: id || uuid(), product: f.product, first_name: f.first_name, last_name: f.last_name,
        name: [f.first_name, f.last_name].filter(Boolean).join(' '),
        phone: f.phone, email: f.email, request_date: f.request_date || today(),
        share: f.share, quantity: qty, burger_lbs: burger ? String(num(f.burger_lbs)) : '', harvest_date: f.harvest_date || '',
        deposit_amount: f.deposit_amount ? String(num(f.deposit_amount)) : '', deposit_paid_date: f.deposit_paid_date,
        deposit_status: f.deposit_paid_date ? 'Paid' : 'Not yet',
        final_amount: f.final_amount ? String(num(f.final_amount)) : '', final_paid_date: f.final_paid_date,
        assigned_animal_id: assigned, status: status, notes: f.notes
      };
      if (status === 'Cancelled' && !isAdmin()) delete row.status;   // already cancelled; farm devices can still fix details
      UI.salesMode = f.product; lsSet('herd.salesMode', f.product);
      UI.salesTab = status === 'Assigned' ? 'assigned' : status === 'Waiting' ? 'waiting' : 'archive';
      return commit([{ table: 'Orders', op: 'upsert', row: row }], {
        go: '#/sales', msg: status === 'Complete' ? 'Paid in full — moved to the archive' : id ? 'Order saved' : 'Added to the waitlist'
      });
    },

    settings: function (form) {
      var f = fields(form);
      var changes = [];
      var bad = '';
      Object.keys(SETTING_DEFAULTS).forEach(function (k) {
        if (f[k] === undefined) return;
        var v = f[k];
        if (k === 'ladder_weights' || k === 'ladder_weights_pork') {
          var w = String(v).split(/[^\d.]+/).map(Number).filter(function (n) { return n > 0; });
          if (v && !w.length) { bad = bad || k; return; }
          v = w.join(', ');
        } else if (v && ['butcher_name', 'butcher_phone', 'butcher_city'].indexOf(k) < 0) {
          if (!hasNum(v)) { bad = bad || k; return; }
          v = String(num(v));
        }
        var cur = byId('Settings', k);
        if ((cur ? cur.value : '') !== v) changes.push({ table: 'Settings', op: 'upsert', row: { id: k, value: v } });
      });
      if (bad) return formError(form, 'Numbers only, please — check the boxes for prices and percents.');
      if (!changes.length) { toast('Nothing changed'); return; }
      return commit(changes, { msg: 'Numbers saved' });
    },

    'invoice-settings': function (form) {
      var f = fields(form);
      f.invoice_auto = f.invoice_auto === 'yes' ? 'yes' : 'no';
      f.venmo = String(f.venmo || '').replace(/^.*venmo\.com\/(u\/)?/i, '').replace(/^@+/, '').replace(/[?#].*$/, '').trim();
      if (f.venmo && !/^[A-Za-z0-9_-]{2,30}$/.test(f.venmo)) return formError(form, 'A Venmo username is letters, numbers, dashes or underscores — no spaces.');
      if (f.invoice_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.invoice_email)) return formError(form, 'That email address doesn’t look right.');
      if (f.invoice_auto === 'yes' && !f.invoice_email) return formError(form, 'Add the email address invoices should go to.');
      var changes = INVOICE_KEYS.filter(function (k) {
        var cur = byId('Settings', k);
        return (cur ? cur.value : '') !== (f[k] || '');
      }).map(function (k) { return { table: 'Settings', op: 'upsert', row: { id: k, value: f[k] || '' } }; });
      if (!changes.length) { toast('Nothing changed'); return; }
      return commit(changes, { msg: 'Invoice settings saved' });
    },

    calc: function () { /* live calculator — nothing to save */ }
  };

  // ==========================================================================
  // Button actions
  // ==========================================================================
  var actions = {
    back: function (el) { if (history.length > 1) history.back(); else location.hash = el.getAttribute('href') || '#/herd'; },
    cancel: function (el) { formPhoto = null; if (history.length > 1) history.back(); else location.hash = el.getAttribute('href') || '#/herd'; },
    sync: function () {
      trySync().then(function (ok) {
        toast(ok ? 'All synced' : S.offline ? 'No signal — will keep trying' : 'Couldn’t sync: ' + S.lastError);
      });
    },
    'status-filter': function (el) {
      var v = el.dataset.v;
      if (UI.sex === 'Offsite' || UI.sex === 'Past') { UI.sex = 'All'; UI.status = v; }
      else UI.status = UI.status === v ? '' : v;
      render();
    },
    'sex-filter': function (el) {
      UI.sex = el.dataset.v;
      if (UI.sex === 'Offsite' || UI.sex === 'Past') UI.status = '';
      render();
    },
    'breed-tab': function (el) { UI.breedTab = el.dataset.v; render(); },
    'sales-tab': function (el) { UI.salesTab = el.dataset.v; render(); },
    'sales-mode': function (el) {
      UI.salesMode = el.dataset.v; lsSet('herd.salesMode', UI.salesMode);
      if (UI.salesMode === 'Pork' && UI.salesTab === 'assigned') UI.salesTab = 'waiting';
      render();
    },
    'sort-dir': function (el) {
      var k = el.dataset.n === '1' ? 'custSort1' : 'custSort2';
      var p = UI[k].split(':');
      UI[k] = p[0] + ':' + (p[1] === 'desc' ? 'asc' : 'desc');
      lsSet('herd.' + k, UI[k]);
      render();
    },
    'market-filter': function (el) { UI.market = el.dataset.v; render(); },
    'market-view': function (el) {
      UI.marketView = el.dataset.v;
      if (location.hash.indexOf('#/market') !== 0) location.hash = '#/market'; else render();
    },
    'set-today': function (el) {
      var inp = el.closest('form').elements[el.dataset.for];
      if (inp) { inp.value = today(); onFormInput(el.closest('form'), el.dataset.for); }
    },
    'paid-today': function (el) {
      var form = el.closest('form');
      var inp = form.elements[el.dataset.for];
      if (inp) inp.value = today();
      if (el.dataset.for === 'deposit_paid_date' && !form.elements.deposit_amount.value) {
        form.elements.deposit_amount.value = setting(val(form, 'product') === 'Pork' ? 'deposit_pork' : 'deposit_beef');
      }
      toast(el.dataset.for === 'deposit_paid_date' ? 'Deposit date set — tap Save' : 'Paid date set — tap Save');
    },
    'refresh-prices': function () {
      if (UI.checkingPrices) return;
      UI.checkingPrices = true;
      render();
      toast('Checking the sale barns — this takes a few seconds…');
      api('refreshPrices').then(function (res) {
        return trySync().then(function () { return res; });
      }).then(function (res) {
        var bad = (res.results || []).filter(function (r) { return /:\s/.test(r); });
        toast(bad.length ? 'Some prices couldn’t be read — see the note at the top' : 'Prices are up to date');
      }, function (e) {
        toast(e.offline ? 'No signal — showing the prices saved on this phone' : 'Couldn’t check prices: ' + e.message);
      }).then(function () {
        UI.checkingPrices = false;
        refreshView();
      });
    },
    'set-status': function (el) {
      var a = byId('Animals', el.dataset.id);
      var v = el.dataset.v;
      if (!a || st(a) === v) return;
      if (isBull(a) && v === 'With cows') { location.hash = '#/animal/' + a.id + '/period'; return; }
      if (isBull(a) && st(a) === 'With cows') { location.hash = '#/animal/' + a.id + '/period?to=' + encodeURIComponent(v); return; }
      if (v === 'Harvested' || v === 'Sold') {
        var row = { id: a.id, status: v };
        if (v === 'Harvested') row.harvest_for = a.harvest_for || (st(a) === 'Ready burger' || isBull(a) ? 'Burger' : 'Steak');
        commit([{ table: 'Animals', op: 'upsert', row: row }], { go: '#/animal/' + a.id + '/harvest', msg: dispName(a) + ': ' + statusLabel(v) });
        return;
      }
      commit([{ table: 'Animals', op: 'upsert', row: { id: a.id, status: v } }], { msg: dispName(a) + ': ' + statusLabel(v) });
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
      UI.salesTab = 'assigned';
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, assigned_animal_id: el.dataset.animal, status: 'Assigned' } }],
        { go: '#/sales', msg: 'Animal assigned' });
    },
    'order-unassign': function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, assigned_animal_id: '', status: 'Waiting' } }], { msg: 'Back on the waitlist' });
    },
    'order-cancel': function (el) {
      var o = byId('Orders', el.dataset.id);
      if (!o || !confirm('Cancel the order for ' + fullName(o) + '? It moves to the archive (you can reopen it).')) return;
      commit([{ table: 'Orders', op: 'upsert', row: { id: o.id, status: 'Cancelled', assigned_animal_id: '' } }], { go: '#/sales', msg: 'Order cancelled' });
    },
    'invoice-view': function (el) {
      if (S.queue.length) { toast('Waiting to sync first — try again in a moment'); trySync(); return; }
      el.disabled = true; el.textContent = 'Making PDF…';
      api('invoice', { id: el.dataset.id, kind: el.dataset.kind }).then(function (r) {
        var bytes = Uint8Array.from(atob(r.base64), function (c) { return c.charCodeAt(0); });
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        var a = document.createElement('a'); a.href = url; a.download = r.filename || 'invoice.pdf'; a.target = '_blank';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        el.disabled = false; el.textContent = 'View PDF';
      }).catch(function (e) { el.disabled = false; el.textContent = 'View PDF'; toast('Couldn’t make the invoice: ' + (e.message || e)); });
    },
    'invoice-send': function (el) {
      if (S.queue.length) { toast('Waiting to sync first — try again in a moment'); trySync(); return; }
      el.disabled = true; el.textContent = 'Sending…';
      api('invoice', { id: el.dataset.id, kind: el.dataset.kind, send: true }).then(function (r) {
        toast('🧾 ' + r.result); el.textContent = 'Sent'; trySync();
      }).catch(function (e) { el.disabled = false; el.textContent = 'Email again'; toast('Couldn’t send: ' + (e.message || e)); });
    },
    'order-reopen': function (el) {
      commit([{ table: 'Orders', op: 'upsert', row: { id: el.dataset.id, status: 'Waiting', final_paid_date: '' } }], { go: '#/sales', msg: 'Back on the waitlist' });
      UI.salesTab = 'waiting';
    },
    'photo-main': function (el) {
      var p = byId('Photos', el.dataset.id);
      if (!p) return;
      commit([{ table: 'Animals', op: 'upsert', row: { id: p.animal_id, photo_id: p.photo_id } }], { go: '#/animal/' + p.animal_id, msg: 'Main photo set' });
    },
    'photo-delete': function (el) {
      var pid = el.dataset.id;
      var p = byId('Photos', pid);
      var a = p ? byId('Animals', p.animal_id) : byId('Animals', pid.replace(/^main-/, ''));
      if (!a || !confirm('Delete this photo? It goes to the farm Drive’s trash for 30 days.')) return;
      var photoId = p ? p.photo_id : a.photo_id;
      var changes = [];
      if (p) changes.push({ table: 'Photos', op: 'delete', row: { id: p.id } });
      if (a.photo_id === photoId) {
        var next = animalPhotos(a).filter(function (x) { return x.photo_id !== photoId && !x.pseudo; })[0];
        changes.push({ table: 'Animals', op: 'upsert', row: { id: a.id, photo_id: next ? next.photo_id : '' } });
      }
      commit(changes, { go: '#/animal/' + a.id, msg: 'Photo deleted' });
    },
    'delete-animal': function (el) {
      var a = byId('Animals', el.dataset.id);
      if (!a || !confirm('Delete ' + dispName(a) + ' completely? This can’t be undone. (To keep the record, set the status to Harvested, Sold or Deceased instead.)')) return;
      commit([{ table: 'Animals', op: 'delete', row: { id: a.id } }], { go: isBull(a) ? '#/bulls' : '#/herd', msg: 'Deleted' });
    },
    'delete-customer': function (el) {
      var list = S.db.Orders.filter(function (o) { return custKey(o) === el.dataset.key; });
      if (!list.length) return;
      if (!confirm('Delete ' + fullName(list[0]) + ' and all ' + list.length + (list.length === 1 ? ' order' : ' orders') + ' (including paid ones in the archive)? This can’t be undone.')) return;
      commit(list.map(function (o) { return { table: 'Orders', op: 'delete', row: { id: o.id } }; }), { go: '#/customers', msg: 'Customer deleted' });
    },
    'delete-order': function (el) {
      var o = byId('Orders', el.dataset.id);
      if (!o || !confirm('Delete the order for ' + fullName(o) + '? This can’t be undone. (Cancel keeps it in the archive.)')) return;
      commit([{ table: 'Orders', op: 'delete', row: { id: o.id } }], { go: '#/sales', msg: 'Order deleted' });
    },
    'inv-sort': function (el) {
      var k = el.dataset.k;
      if (UI.invSort === k) UI.invDir = -(UI.invDir || 1); else { UI.invSort = k; UI.invDir = 1; }
      render();
    },
    'print-report': function () { window.print(); },
    'more-menu': function (el) {
      if (document.getElementById('more-pop') && el.getAttribute('aria-expanded') === 'true') { closeMoreMenu(); return; }
      openMoreMenu(el);
    },
    'nav-move': function (el) {
      var kind = el.dataset.kind === 'side' ? 'side' : 'bar';
      var order = navOrder(kind).filter(function (x) { return !(kind === 'side' && x === 'settings'); });
      var k = el.dataset.k, i = order.indexOf(k), j = i + parseInt(el.dataset.d, 10);
      if (i < 0 || j < 0 || j >= order.length) return;
      order.splice(i, 1); order.splice(j, 0, k);
      var upd = {}; upd[kind === 'side' ? 'side' : 'nav'] = order;
      S.prefs = Object.assign({}, S.prefs, upd);
      savePrefs(); render();
    },
    'revoke-device': function (el) {
      if (!confirm('Sign out “' + el.dataset.name + '”? It will need the access code to get back in.')) return;
      api('revokeDevice', { id: el.dataset.id }).then(function (r) {
        UI.devices = r.devices; var box = document.getElementById('device-list'); if (box) box.innerHTML = devicesHTML(r.devices);
        toast(el.dataset.name + ' signed out');
      }, function (e) { toast(e.offline ? 'Needs signal' : e.message); });
    },
    'sign-out': function () {
      var warn = S.queue.length ? ' ' + S.queue.length + ' change(s) haven’t reached the Sheet yet and will be lost.' : '';
      if (!confirm('Sign out of this phone?' + warn)) return;
      lsSet('herd.token', ''); lsSet('herd.passcode', '');
      S.token = ''; S.db = emptyDb(); S.queue = []; S.lastSync = '';
      persist().then(function () { currentKey = null; location.hash = ''; render(); });
    }
  };

  /** A bull goes in: a period row + a pasture-exposure breeding for every eligible cow/heifer. */
  function periodStartChanges(bull, start, fee, notes) {
    var pid = uuid();
    var ch = [{ table: 'BullPeriods', op: 'upsert', row: { id: pid, bull_id: bull.id, start_date: start, end_date: '', fee: fee ? String(num(fee)) : '', notes: notes || '' } }];
    exposableCows().forEach(function (c) {
      ch.push({ table: 'Breedings', op: 'upsert', row: {
        id: uuid(), cow_id: c.id, bull_id: bull.id, method: 'Pasture', exposure_start: start, exposure_end: '', period_id: pid, result: 'Pending'
      } });
    });
    return ch;
  }
  /** A bull comes out: close his open period and the calving windows it started. */
  function periodEndChanges(bull, end) {
    var op = openPeriod(bull.id);
    if (!op) return [];
    var ch = [{ table: 'BullPeriods', op: 'upsert', row: { id: op.id, end_date: end } }];
    S.db.Breedings.forEach(function (b) {
      if (b.period_id === op.id) ch.push({ table: 'Breedings', op: 'upsert', row: { id: b.id, exposure_end: end } });
    });
    return ch;
  }

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
      var lastMod = file.lastModified ? iso(new Date(file.lastModified)) : today();
      if (lastMod > today()) lastMod = today();
      return photoChanges(a, b64, lastMod, !a.photo_id).then(function (ch) {
        return commit(ch, { msg: 'Photo added — tap it to change the date' });
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
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // ==========================================================================
  // Wiring
  // ==========================================================================
  // More pop-out: closes on a tap elsewhere, a page change, Escape, or resizing.
  document.addEventListener('click', function (e) {
    var pop = document.getElementById('more-pop');
    if (pop && !e.target.closest('#more-pop') && !e.target.closest('[data-action="more-menu"]')) closeMoreMenu();
    if (pop && e.target.closest('#more-pop a')) setTimeout(closeMoreMenu, 0);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.getElementById('more-pop')) {
      var b = document.querySelector('[data-action="more-menu"][aria-expanded="true"]');
      closeMoreMenu(); if (b) b.focus();
    }
  });
  window.addEventListener('hashchange', closeMoreMenu);
  window.addEventListener('resize', closeMoreMenu);
  // Switching between phone and computer widths swaps which menu the Settings editor shows.
  if (window.matchMedia) {
    var deskMq = matchMedia('(min-width: 1024px)');
    var onDeskChange = function () { if (!currentIsForm && S.token) render(); };
    if (deskMq.addEventListener) deskMq.addEventListener('change', onDeskChange); else if (deskMq.addListener) deskMq.addListener(onDeskChange);
  }
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
    if (t.id === 'cust-search') {
      UI.custSearch = t.value;
      var cl = document.getElementById('cust-list');
      if (cl) cl.innerHTML = customerRowsHTML();
      return;
    }
    if (t.form && t.form.dataset.form) onFormInput(t.form, t.name);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('input[type=file][data-photo-input]')) { handlePhoto(t); return; }
    if (t.matches('input[data-nav-toggle]')) {
      var kind = t.dataset.kind === 'side' ? 'side' : 'bar';
      var order = navOrder(kind).filter(function (x) { return !(kind === 'side' && x === 'settings'); }), k = t.dataset.navToggle;
      var where = kind === 'side' ? 'menu' : 'bar';
      if (t.checked && order.length >= NAV_MAX[kind]) { t.checked = false; toast('Up to ' + NAV_MAX[kind] + ' on the bar — untick one first'); return; }
      if (t.checked && order.indexOf(k) < 0) order.push(k);
      if (!t.checked) order = order.filter(function (x) { return x !== k; });
      if (order.length < 3) { t.checked = true; toast('Keep at least 3 pages on the ' + where); return; }
      var upd = {}; upd[kind === 'side' ? 'side' : 'nav'] = order;
      S.prefs = Object.assign({}, S.prefs, upd);
      savePrefs(); render();
      return;
    }
    if (t.matches('select[data-trend]')) { UI.trend = t.value; render(); return; }
    if (t.matches('select[data-sort]')) {
      var k = t.dataset.sort === '1' ? 'custSort1' : 'custSort2';
      var dir = /^(paid|total|orders)$/.test(t.value) ? 'desc' : 'asc';
      UI[k] = t.value + ':' + dir;
      lsSet('herd.' + k, UI[k]);
      // never sort twice by the same field
      var other = k === 'custSort1' ? 'custSort2' : 'custSort1';
      if (UI[other].split(':')[0] === t.value) {
        UI[other] = t.value === 'last' ? 'paid:desc' : 'last:asc';
        lsSet('herd.' + other, UI[other]);
      }
      render();
      return;
    }
    if (t.form && t.form.dataset.form) onFormInput(t.form, t.name);
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

  function signedIn(res) {
    S.token = res.token; lsSet('herd.token', res.token);
    S.role = res.role || 'admin'; lsSet('herd.role', S.role);
    lsSet('herd.who', S.who); lsSet('herd.passcode', '');
    S.authFailed = false;
    if (res.prefs) { S.prefs = res.prefs; lsSet('herd.prefs', JSON.stringify(res.prefs)); }
  }

  loadState().catch(function () {}).then(function () {
    // Phones from before device sign-in kept the code; swap it for a device token once, then forget it.
    var old = ls('herd.passcode');
    if (!S.token && old) {
      return api('login', { passcode: old }).then(signedIn, function (e) {
        if (e.code === 'AUTH') lsSet('herd.passcode', '');
      });
    }
  }).then(function () {
    render();
    if (S.token) trySync();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
