/*
 * Sheet Thumbnail Generator — extension Qlik Sense Enterprise on Windows
 *
 * Capture le rendu réel d'une feuille (html2canvas), dépose l'image dans le
 * contenu de l'app (bibliothèque de médias) via l'API QRS, puis renseigne la
 * propriété "thumbnail" de la feuille. Même résultat qu'un ajout manuel
 * d'image via la bibliothèque de médias, mais automatique.
 */
define([
  'qlik',
  'jquery',
  './html2canvas.min',
  'text!./style.css'
], function (qlik, $, html2canvas, cssContent) {
  'use strict';

  if (!document.getElementById('stg-style')) {
    $('<style id="stg-style">').html(cssContent).appendTo('head');
  }

  // ---------------------------------------------------------------------------
  // Constantes et état global (le module survit aux changements de feuille,
  // ce qui permet au mode "toutes les feuilles" de continuer à tourner).
  // ---------------------------------------------------------------------------
  var FILE_PREFIX = 'stg_';
  // Zones candidates à capturer, dans l'ordre de préférence. Le DOM du client
  // Qlik n'est pas une API officielle : un sélecteur personnalisé peut être
  // défini dans les propriétés si aucun ne convient.
  var SHEET_SELECTORS = ['.qv-panel-sheet', '.qvt-sheet', '#grid-wrap', '#grid'];
  var QUIET_PERIOD_MS = 1000;   // durée sans modification du DOM avant capture
  var CHECK_INTERVAL_MS = 400;  // fréquence des contrôles de rendu
  var STABLE_CHECKS = 3;        // nb de contrôles consécutifs identiques exigés (≈ 1,2 s)
  var BLANK_GRACE_MS = 6000;    // au-delà, un canvas vide n'est plus considéré "en cours"
  // Indicateurs de chargement génériques (le nom exact des classes varie selon les versions)
  var LOADER_SELECTOR = '[class*="loader"], [class*="loading"], [class*="spinner"]';

  var state = { running: false, cancel: false };

  var TEMPLATE =
    '<div class="stg-root">' +
      '<div class="stg-heading">Vignettes des feuilles</div>' +
      '<div class="stg-actions">' +
        '<button type="button" class="lui-button stg-btn-current">Générer pour cette feuille</button>' +
        '<button type="button" class="lui-button lui-button--info stg-btn-all">Générer pour toutes les feuilles</button>' +
      '</div>' +
      '<div class="stg-status" role="status" aria-live="polite"></div>' +
    '</div>';

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  function readConfig(layout) {
    var c = (layout && layout.stg) || {};
    var width = parseInt(c.width, 10);
    var delay = parseInt(c.delay, 10);
    var maxWait = parseInt(c.maxWait, 10);
    return {
      width: isFinite(width) && width >= 200 ? Math.min(width, 2400) : 800,
      delay: isFinite(delay) && delay >= 500 ? delay : 2500,
      maxWaitMs: (isFinite(maxWait) && maxWait >= 5 ? Math.min(maxWait, 300) : 30) * 1000,
      onTimeout: c.onTimeout === 'skip' ? 'skip' : 'capture',
      overwrite: c.overwrite !== false,
      skipOwnSheet: c.skipOwnSheet !== false,
      selector: (c.selector || '').trim()
    };
  }

  function errorText(e) {
    if (!e) return 'erreur inconnue';
    if (typeof e === 'string') return e;
    return e.message || (e.error && e.error.message) || JSON.stringify(e);
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // Préfixe du proxy virtuel : /monprefixe/sense/app/... -> "/monprefixe"
  function getProxyPrefix() {
    var m = window.location.pathname.match(/^(.*?)\/(sense|extensions|single|hub)(\/|$)/i);
    return m ? m[1] : '';
  }

  function makeXrfKey() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var key = '';
    for (var i = 0; i < 16; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
    return key;
  }

  function getEnigmaApp(app) {
    var e = app && app.model && app.model.enigmaModel;
    if (!e) throw new Error("API moteur indisponible (app.model.enigmaModel). Version de Qlik Sense trop ancienne ?");
    return e;
  }

  // ---------------------------------------------------------------------------
  // API QRS (via le proxy, avec la session de l'utilisateur connecté)
  // ---------------------------------------------------------------------------
  function qrsFetch(method, path, body, contentType) {
    var key = makeXrfKey();
    var url = getProxyPrefix() + '/qrs' + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'xrfkey=' + key;
    var headers = { 'X-Qlik-Xrfkey': key };
    if (contentType) headers['Content-Type'] = contentType;
    return fetch(url, { method: method, headers: headers, body: body, credentials: 'same-origin' })
      .then(function (res) {
        if (res.ok) return res;
        return res.text().catch(function () { return ''; }).then(function (txt) {
          var hint = res.status === 403
            ? " (droits insuffisants sur le contenu de l'app : vérifiez les règles de sécurité dans la QMC)"
            : '';
          throw new Error('QRS ' + res.status + hint + (txt ? ' – ' + txt.slice(0, 200) : ''));
        });
      });
  }

  function uploadAppContent(appId, fileName, blob) {
    var path = '/appcontent/' + encodeURIComponent(appId) +
      '/uploadfile?externalpath=' + encodeURIComponent(fileName) + '&overwrite=true';
    return qrsFetch('POST', path, blob, 'image/png')
      .then(function (res) { return res.text(); })
      .then(function (txt) {
        // Le QRS renvoie le chemin du fichier déposé (ex. /appcontent/<id>/stg_xxx.png)
        var returned = (txt || '').trim().replace(/^"|"$/g, '');
        return /^\/appcontent\//i.test(returned)
          ? returned
          : '/appcontent/' + appId + '/' + fileName;
      });
  }

  function deleteAppContent(appId, fileName) {
    var path = '/appcontent/' + encodeURIComponent(appId) +
      '/deletecontent?externalpath=' + encodeURIComponent(fileName);
    return qrsFetch('DELETE', path);
  }

  // ---------------------------------------------------------------------------
  // Moteur (enigma) : liste des feuilles, lecture/écriture de la vignette
  // ---------------------------------------------------------------------------
  function listSheets(enigmaApp) {
    return enigmaApp.createSessionObject({
      qInfo: { qType: 'stg-sheetlist' },
      qAppObjectListDef: { qType: 'sheet', qData: { rank: '/rank', thumbnail: '/thumbnail' } }
    }).then(function (obj) {
      return obj.getLayout().then(function (layout) {
        var items = (layout.qAppObjectList && layout.qAppObjectList.qItems) || [];
        return items.map(function (it) {
          var meta = it.qMeta || {};
          var data = it.qData || {};
          var thumb = data.thumbnail || {};
          var thumbUrl = (thumb.qStaticContentUrl && thumb.qStaticContentUrl.qUrl) ||
            (thumb.qStaticContentUrlDef && thumb.qStaticContentUrlDef.qUrl) || '';
          var privileges = meta.privileges || [];
          return {
            id: it.qInfo.qId,
            title: meta.title || it.qInfo.qId,
            rank: Number(data.rank) || 0,
            thumbUrl: thumbUrl,
            // Si les privilèges ne sont pas exposés, on tente quand même.
            canUpdate: !privileges.length || privileges.indexOf('update') >= 0
          };
        }).sort(function (a, b) { return a.rank - b.rank; });
      }).then(function (list) {
        enigmaApp.destroySessionObject(obj.id).catch(function () {});
        return list;
      }, function (err) {
        enigmaApp.destroySessionObject(obj.id).catch(function () {});
        throw err;
      });
    });
  }

  function assertSheetEditable(enigmaApp, sheetId) {
    return enigmaApp.getObject(sheetId)
      .then(function (sheet) { return sheet.getLayout(); })
      .then(function (layout) {
        var p = (layout.qMeta && layout.qMeta.privileges) || [];
        if (p.length && p.indexOf('update') < 0) {
          throw new Error("cette feuille n'est pas modifiable (app publiée ou feuille approuvée). Travaillez sur une copie non publiée.");
        }
      });
  }

  function applyThumbnail(appId, enigmaApp, sheetId, blob) {
    var fileName = FILE_PREFIX + String(sheetId).replace(/[^A-Za-z0-9_-]/g, '') + '_' + Date.now() + '.png';
    var sheet, props, oldUrl;
    return enigmaApp.getObject(sheetId)
      .then(function (s) { sheet = s; return s.getProperties(); })
      .then(function (p) {
        props = p;
        oldUrl = (p.thumbnail && p.thumbnail.qStaticContentUrlDef && p.thumbnail.qStaticContentUrlDef.qUrl) || '';
        return uploadAppContent(appId, fileName, blob);
      })
      .then(function (url) {
        props.thumbnail = { qStaticContentUrlDef: { qUrl: url } };
        return sheet.setProperties(props);
      })
      .then(function () {
        // Nom de fichier horodaté = pas de problème de cache navigateur.
        // On supprime l'ancienne vignette seulement si elle a été créée par l'extension.
        var m = oldUrl.match(/\/appcontent\/[^/]+\/(stg_[^/?#]+\.png)/i);
        if (m && m[1] !== fileName) {
          deleteAppContent(appId, m[1]).catch(function (e) {
            console.warn('[SheetThumbnailGenerator] Ancienne vignette non supprimée :', e);
          });
        }
      });
  }

  function saveApp(enigmaApp) {
    return Promise.resolve()
      .then(function () { return enigmaApp.doSave(); })
      .catch(function (e) { console.warn('[SheetThumbnailGenerator] DoSave :', e); });
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------
  function findSheetElement(customSelector) {
    var selectors = customSelector ? [customSelector].concat(SHEET_SELECTORS) : SHEET_SELECTORS;
    for (var i = 0; i < selectors.length; i++) {
      var el;
      try { el = document.querySelector(selectors[i]); } catch (e) { el = null; }
      if (el) {
        var r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 120) return el;
      }
    }
    return null;
  }

  function findBackground(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var bg = window.getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg;
      node = node.parentElement;
    }
    return '#ffffff';
  }

  function captureElement(el, targetWidth) {
    var rect = el.getBoundingClientRect();
    var scale = Math.max(0.1, Math.min(2, targetWidth / rect.width));
    return html2canvas(el, {
      backgroundColor: findBackground(el),
      scale: scale,
      useCORS: true,
      logging: false,
      ignoreElements: function (node) {
        // L'extension elle-même ne doit pas apparaître dans la vignette.
        return !!(node.classList && node.classList.contains('qv-gridcell') &&
          node.querySelector && node.querySelector('.stg-root'));
      }
    }).then(function (canvas) {
      return new Promise(function (resolve, reject) {
        try {
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('conversion en PNG impossible'));
          }, 'image/png');
        } catch (e) {
          // Canvas "tainted" : contenu externe sans CORS (fond de carte, image distante…)
          reject(new Error('la feuille contient un contenu externe (ex. fond de carte) qui bloque la capture'));
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Vérification du rendu avant capture
  // ---------------------------------------------------------------------------

  // 1) Côté moteur : force le calcul de chaque objet de la feuille (GetLayout
  //    ne répond qu'une fois les données calculées).
  function waitForEngine(enigmaApp, sheetId, timeoutMs) {
    var work = enigmaApp.getObject(sheetId)
      .then(function (sheet) { return sheet.getProperties(); })
      .then(function (props) {
        var ids = (props.cells || []).map(function (c) { return c.name; }).filter(Boolean);
        return Promise.all(ids.map(function (id) {
          return enigmaApp.getObject(id)
            .then(function (o) { return o.getLayout(); })
            .catch(function () { return null; });
        }));
      })
      .catch(function () { return null; });
    return Promise.race([work, sleep(timeoutMs)]);
  }

  function isVisible(el) {
    if (!el.offsetWidth && !el.offsetHeight) return false;
    var cs = window.getComputedStyle(el);
    var opacity = parseFloat(cs.opacity);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && (isNaN(opacity) || opacity > 0.05);
  }

  var sampler = null;
  // Échantillonne un canvas en 24×24 : renvoie une empreinte et s'il contient un dessin.
  function sampleCanvas(canvas) {
    if (!canvas.width || !canvas.height) return { sig: '0', drawn: false };
    try {
      if (!sampler) {
        sampler = document.createElement('canvas');
        sampler.width = 24;
        sampler.height = 24;
      }
      var ctx = sampler.getContext('2d');
      ctx.clearRect(0, 0, 24, 24);
      ctx.drawImage(canvas, 0, 0, 24, 24);
      var data = ctx.getImageData(0, 0, 24, 24).data;
      var h = 0, drawn = false;
      for (var i = 0; i < data.length; i++) {
        h = (h * 31 + data[i]) | 0;
        if (!drawn && (i % 4 === 3) && data[i] > 0) drawn = true;
      }
      return { sig: String(h), drawn: drawn };
    } catch (e) {
      // Canvas avec contenu externe : illisible, on le considère dessiné.
      return { sig: canvas.width + 'x' + canvas.height, drawn: true };
    }
  }

  // 2) Côté navigateur : inspecte chaque objet visible de la feuille.
  function inspectSheet(sheetEl, blankCanvasIsPending) {
    var sheetRect = sheetEl.getBoundingClientRect();
    var cells = Array.prototype.slice.call(sheetEl.querySelectorAll('.qv-gridcell'));
    if (!cells.length) cells = [sheetEl];

    var pending = 0;
    var sig = [];

    cells.forEach(function (cell) {
      if (cell.querySelector('.stg-root')) return; // l'extension elle-même
      var r = cell.getBoundingClientRect();
      var inView = r.width > 0 && r.height > 0 && r.bottom > sheetRect.top && r.top < sheetRect.bottom;
      if (!inView) return; // objets hors écran (feuille étendue) : non capturés de toute façon

      var busy = false;

      // Indicateur de chargement visible
      var loaders = cell.querySelectorAll(LOADER_SELECTOR);
      for (var i = 0; i < loaders.length; i++) {
        if (isVisible(loaders[i])) { busy = true; break; }
      }

      // Images pas encore chargées
      var imgs = cell.querySelectorAll('img');
      for (var j = 0; j < imgs.length; j++) {
        if (!imgs[j].complete) { busy = true; break; }
      }

      // Graphiques canvas : au moins un doit être dessiné
      var canvases = Array.prototype.filter.call(cell.querySelectorAll('canvas'), isVisible);
      var anyDrawn = false;
      canvases.forEach(function (cv) {
        var s = sampleCanvas(cv);
        if (s.drawn) anyDrawn = true;
        sig.push(s.sig);
      });
      if (canvases.length && !anyDrawn && blankCanvasIsPending) busy = true;

      // Empreinte DOM (tableaux, KPI, textes…)
      sig.push(cell.getElementsByTagName('*').length + ':' + (cell.textContent || '').length);

      if (busy) pending++;
    });

    return { pending: pending, signature: sig.join('|') };
  }

  // Attend que la feuille cible soit affichée, calculée, dessinée et stable.
  // Résout { el, complete, pending } ; complete = false si le délai max est atteint.
  function waitForSheetReady(sheetId, cfg, opts) {
    opts = opts || {};
    var minDelay = opts.minDelay != null ? opts.minDelay : cfg.delay;
    var overlayEl = opts.overlayEl || null;
    var onWait = opts.onWait || function () {};
    var start = Date.now();
    var deadline = start + minDelay + cfg.maxWaitMs;
    var lastMutation = Date.now();

    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (!overlayEl || !overlayEl.contains(records[i].target)) {
          lastMutation = Date.now();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    onWait('Calcul des objets…');
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();

    return Promise.all([
      waitForEngine(opts.enigmaApp, sheetId, Math.max(1000, deadline - Date.now())),
      fontsReady
    ]).then(function () {
      return new Promise(function (resolve, reject) {
        var lastSig = null;
        var stable = 0;
        var lastPending = -1;

        (function tick() {
          var now = Date.now();
          var cur = qlik.navigation.getCurrentSheetId();
          var el = (cur && cur.sheetId === sheetId) ? findSheetElement(cfg.selector) : null;

          if (el) {
            var st = inspectSheet(el, now - start < minDelay + BLANK_GRACE_MS);
            if (st.signature === lastSig) stable++;
            else { stable = 0; lastSig = st.signature; }

            var ready = now - start >= minDelay &&
              now - lastMutation >= QUIET_PERIOD_MS &&
              st.pending === 0 &&
              stable >= STABLE_CHECKS;

            if (ready) {
              observer.disconnect();
              resolve({ el: el, complete: true, pending: 0 });
              return;
            }
            if (st.pending !== lastPending) {
              lastPending = st.pending;
              onWait(st.pending ? 'En attente de ' + st.pending + ' objet(s) en cours de chargement…' : 'Stabilisation du rendu…');
            }
            if (now > deadline) {
              observer.disconnect();
              resolve({ el: el, complete: false, pending: st.pending });
              return;
            }
          } else if (now > deadline) {
            observer.disconnect();
            reject(new Error("la feuille ne s'est pas affichée à temps"));
            return;
          }
          setTimeout(tick, CHECK_INTERVAL_MS);
        })();
      });
    }, function (e) {
      observer.disconnect();
      throw e;
    });
  }

  function timeoutMessage(res) {
    return res.pending
      ? res.pending + " objet(s) encore en chargement après le délai maximal"
      : "rendu encore instable après le délai maximal";
  }

  // ---------------------------------------------------------------------------
  // Interface : statut dans l'objet + panneau de progression flottant
  // ---------------------------------------------------------------------------
  function setStatus($root, text, kind) {
    $root.data('stg-status', { text: text, kind: kind || '' });
    $root.find('.stg-status')
      .removeClass('stg-ok stg-warn stg-error')
      .addClass(kind ? 'stg-' + kind : '')
      .text(text);
  }

  function setBusy($root, busy) {
    $root.find('button').prop('disabled', busy);
  }

  function createOverlay() {
    var $o = $(
      '<div class="stg-overlay" data-html2canvas-ignore="true" role="dialog" aria-label="Génération des vignettes">' +
        '<div class="stg-ov-head">' +
          '<span class="stg-ov-title">Génération des vignettes</span>' +
          '<button type="button" class="lui-button lui-button--small stg-ov-btn">Arrêter</button>' +
        '</div>' +
        '<div class="stg-ov-track"><div class="stg-ov-fill"></div></div>' +
        '<div class="stg-ov-current"></div>' +
        '<ul class="stg-ov-log"></ul>' +
      '</div>'
    ).appendTo(document.body);

    var finished = false;
    var onStop = null;
    $o.find('.stg-ov-btn').on('click', function () {
      if (finished) { $o.remove(); return; }
      if (onStop) onStop();
      $(this).prop('disabled', true).text('Arrêt en cours…');
    });

    return {
      el: $o[0],
      onStop: function (fn) { onStop = fn; },
      progress: function (done, total, label) {
        var pct = total ? Math.round((done / total) * 100) : 100;
        $o.find('.stg-ov-fill').css('width', pct + '%');
        $o.find('.stg-ov-current').text(label || '');
      },
      log: function (text, kind) {
        var $log = $o.find('.stg-ov-log');
        $('<li>').addClass(kind ? 'stg-' + kind : '').text(text).appendTo($log);
        $log.scrollTop($log[0].scrollHeight);
      },
      finish: function (summary) {
        finished = true;
        $o.find('.stg-ov-fill').css('width', '100%');
        $o.find('.stg-ov-current').text(summary);
        $o.find('.stg-ov-btn').prop('disabled', false).text('Fermer');
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function captureCurrentSheet(app, cfg, $root) {
    if (state.running) return;
    var cur = qlik.navigation.getCurrentSheetId();
    if (!cur || !cur.sheetId) { setStatus($root, 'Feuille courante introuvable.', 'error'); return; }

    var enigmaApp;
    try { enigmaApp = getEnigmaApp(app); } catch (e) { setStatus($root, errorText(e), 'error'); return; }

    state.running = true;
    setBusy($root, true);
    setStatus($root, 'Vérification du rendu…');
    var warning = '';

    assertSheetEditable(enigmaApp, cur.sheetId)
      .then(function () {
        if (!findSheetElement(cfg.selector)) {
          throw new Error('zone de la feuille introuvable. Renseignez le sélecteur CSS dans les propriétés.');
        }
        return waitForSheetReady(cur.sheetId, cfg, {
          enigmaApp: enigmaApp,
          minDelay: 300, // la feuille est déjà affichée
          onWait: function (msg) { setStatus($root, msg); }
        });
      })
      .then(function (res) {
        if (!res.complete) {
          if (cfg.onTimeout === 'skip') throw new Error(timeoutMessage(res) + ', capture annulée.');
          warning = timeoutMessage(res);
        }
        setStatus($root, 'Capture de la feuille…');
        return captureElement(res.el, cfg.width);
      })
      .then(function (blob) {
        setStatus($root, "Enregistrement de l'image…");
        return applyThumbnail(app.id, enigmaApp, cur.sheetId, blob);
      })
      .then(function () { return saveApp(enigmaApp); })
      .then(function () {
        if (warning) setStatus($root, 'Vignette mise à jour, mais ' + warning + '.', 'warn');
        else setStatus($root, 'Vignette mise à jour.', 'ok');
      })
      .catch(function (e) {
        console.error('[SheetThumbnailGenerator]', e);
        setStatus($root, 'Échec : ' + errorText(e), 'error');
      })
      .then(function () {
        state.running = false;
        setBusy($root, false);
      });
  }

  function captureAllSheets(app, cfg, $root) {
    if (state.running) return;
    var enigmaApp;
    try { enigmaApp = getEnigmaApp(app); } catch (e) { setStatus($root, errorText(e), 'error'); return; }

    var origin = (qlik.navigation.getCurrentSheetId() || {}).sheetId;
    var stats = { ok: 0, warned: 0, skipped: 0, failed: 0 };
    var ov;

    state.running = true;
    state.cancel = false;
    setBusy($root, true);
    setStatus($root, 'Préparation…');

    listSheets(enigmaApp).then(function (sheets) {
      if (cfg.skipOwnSheet && origin) {
        sheets = sheets.filter(function (s) { return s.id !== origin; });
      }
      if (!sheets.length) throw new Error('aucune feuille à traiter.');
      var msg = 'Générer les vignettes de ' + sheets.length + ' feuille(s) ?\n\n' +
        "L'application va afficher chaque feuille l'une après l'autre. " +
        "Ne changez pas d'onglet et n'utilisez pas l'app pendant l'opération.";
      if (!window.confirm(msg)) { state.cancel = true; return; }

      ov = createOverlay();
      ov.onStop(function () { state.cancel = true; ov.log('Arrêt demandé, fin de la feuille en cours…', 'warn'); });
      ov.log(sheets.length + ' feuille(s) à traiter.');

      if (qlik.navigation.getMode() !== 'analysis') qlik.navigation.setMode('analysis');

      var i = 0;
      function next() {
        if (state.cancel || i >= sheets.length) return Promise.resolve();
        var s = sheets[i];
        ov.progress(i, sheets.length, (i + 1) + ' / ' + sheets.length + ' : ' + s.title);
        i++;

        if (!s.canUpdate) {
          stats.skipped++;
          ov.log('« ' + s.title + ' » ignorée : feuille non modifiable.', 'warn');
          return next();
        }
        if (!cfg.overwrite && s.thumbUrl) {
          stats.skipped++;
          ov.log('« ' + s.title + ' » ignorée : vignette déjà présente.');
          return next();
        }

        var label = (i) + ' / ' + sheets.length + ' : ' + s.title;
        var warning = '';
        return Promise.resolve()
          .then(function () {
            var nav = qlik.navigation.gotoSheet(s.id);
            if (nav && nav.success === false) throw new Error(nav.errorMsg || 'navigation impossible (feuille masquée ?)');
            return waitForSheetReady(s.id, cfg, {
              enigmaApp: enigmaApp,
              overlayEl: ov.el,
              onWait: function (msg) { ov.progress(i - 1, sheets.length, label + ' (' + msg + ')'); }
            });
          })
          .then(function (res) {
            if (!res.complete) {
              if (cfg.onTimeout === 'skip') {
                var err = new Error(timeoutMessage(res) + ', non capturée');
                err.stgSkip = true;
                throw err;
              }
              warning = timeoutMessage(res);
            }
            ov.progress(i - 1, sheets.length, label + ' (capture…)');
            return captureElement(res.el, cfg.width);
          })
          .then(function (blob) { return applyThumbnail(app.id, enigmaApp, s.id, blob); })
          .then(function () {
            if (warning) {
              stats.warned++;
              ov.log('« ' + s.title + ' » : vignette mise à jour, mais ' + warning + '.', 'warn');
            } else {
              stats.ok++;
              ov.log('« ' + s.title + ' » : vignette mise à jour.', 'ok');
            }
          }, function (e) {
            if (e && e.stgSkip) {
              stats.skipped++;
              ov.log('« ' + s.title + ' » ignorée : ' + e.message + '.', 'warn');
              return;
            }
            stats.failed++;
            console.error('[SheetThumbnailGenerator]', s.id, e);
            ov.log('« ' + s.title + ' » : échec, ' + errorText(e), 'error');
          })
          .then(next);
      }

      return next().then(function () {
        if (stats.ok || stats.warned) {
          ov.progress(sheets.length, sheets.length, "Enregistrement de l'application…");
          return saveApp(enigmaApp);
        }
      });
    })
    .catch(function (e) {
      console.error('[SheetThumbnailGenerator]', e);
      if (ov) ov.log('Erreur : ' + errorText(e), 'error');
      else setStatus($root, 'Échec : ' + errorText(e), 'error');
    })
    .then(function () {
      var wasCancelledBeforeStart = !ov;
      state.running = false;
      if (!wasCancelledBeforeStart && origin) {
        // Retour à la feuille de départ (l'extension sera redessinée).
        try { qlik.navigation.gotoSheet(origin); } catch (e) { /* ignore */ }
      }
      if (ov) {
        var summary = (stats.ok + stats.warned) + ' mise(s) à jour' +
          (stats.warned ? ' (dont ' + stats.warned + ' avec avertissement)' : '') +
          ', ' + stats.skipped + ' ignorée(s), ' + stats.failed + ' en échec' +
          (state.cancel ? ' (arrêt demandé)' : '') + '.';
        ov.finish(summary);
      }
      // $root peut avoir été détruit par la navigation ; sans effet dans ce cas.
      setBusy($root, false);
      if (ov) setStatus($root, 'Traitement terminé.', 'ok');
      else if (!$root.find('.stg-status').hasClass('stg-error')) setStatus($root, 'Prêt.');
    });
  }

  // ---------------------------------------------------------------------------
  // Définition de l'extension
  // ---------------------------------------------------------------------------
  return {
    initialProperties: {
      stg: { width: 800, delay: 2500, maxWait: 30, onTimeout: 'capture', overwrite: true, skipOwnSheet: true, selector: '' }
    },
    definition: {
      type: 'items',
      component: 'accordion',
      items: {
        thumbnails: {
          label: 'Vignettes',
          type: 'items',
          items: {
            width: {
              ref: 'stg.width',
              label: 'Largeur de la vignette (px)',
              type: 'number',
              defaultValue: 800
            },
            delay: {
              ref: 'stg.delay',
              label: "Temps d'attente minimal par feuille (ms)",
              type: 'number',
              defaultValue: 2500
            },
            maxWait: {
              ref: 'stg.maxWait',
              label: "Temps d'attente maximal par feuille (s)",
              type: 'number',
              defaultValue: 30
            },
            onTimeout: {
              ref: 'stg.onTimeout',
              label: "Si une feuille n'est pas prête à temps",
              type: 'string',
              component: 'dropdown',
              options: [
                { value: 'capture', label: 'Capturer quand même (avec avertissement)' },
                { value: 'skip', label: 'Ne pas capturer la feuille' }
              ],
              defaultValue: 'capture'
            },
            overwrite: {
              ref: 'stg.overwrite',
              label: 'Remplacer les vignettes existantes',
              type: 'boolean',
              defaultValue: true
            },
            skipOwnSheet: {
              ref: 'stg.skipOwnSheet',
              label: 'Exclure la feuille qui contient cet objet',
              type: 'boolean',
              defaultValue: true
            },
            selector: {
              ref: 'stg.selector',
              label: 'Sélecteur CSS de la zone à capturer (avancé)',
              type: 'string',
              defaultValue: ''
            },
            help: {
              component: 'text',
              label: "Laissez le sélecteur vide pour la détection automatique. Les vignettes sont enregistrées dans la bibliothèque de médias de l'app (fichiers stg_*.png)."
            }
          }
        },
        settings: { uses: 'settings' }
      }
    },
    support: { snapshot: false, export: false, exportData: false },

    paint: function ($element, layout) {
      var self = this;
      self._stgApp = qlik.currApp(this);
      self._stgCfg = readConfig(layout);

      var $root = $element.find('.stg-root');
      if (!$root.length) {
        $element.html(TEMPLATE);
        $root = $element.find('.stg-root');
        $root.find('.stg-btn-current').on('click', function () {
          captureCurrentSheet(self._stgApp, self._stgCfg, $root);
        });
        $root.find('.stg-btn-all').on('click', function () {
          captureAllSheets(self._stgApp, self._stgCfg, $root);
        });
      }

      // Double sécurité : la cellule de l'extension est exclue de la capture.
      $element.closest('.qv-gridcell').attr('data-html2canvas-ignore', 'true');

      var editMode = qlik.navigation.getMode() === 'edit';
      $root.toggleClass('stg-edit', editMode);
      setBusy($root, editMode || state.running);

      if (editMode) {
        setStatus($root, 'Passez en mode analyse pour générer les vignettes.');
      } else if (state.running) {
        setStatus($root, 'Génération en cours…');
      } else {
        var last = $root.data('stg-status');
        if (!last || last.text === 'Passez en mode analyse pour générer les vignettes.') setStatus($root, 'Prêt.');
      }
      return qlik.Promise.resolve();
    }
  };
});
