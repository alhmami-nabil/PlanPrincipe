// ============================================
// GLOBAL VARIABLES FOR EDITOR
// ============================================
let editorCanvas, editorCtx;
let editorImage = null;
let editorAnnotations = [];
let editorFilename = '';
let nextAnnotationId = 1;
let editorDirty = false;
let pendingImageFile = null;
let pendingImageDataUrl = null;
let currentVueEclateeImage = null;
let editorImgW = 1500;
let editorImgH = 1300;

// Annotation size
let annotationSize = 1.0;
const SIZE_MIN = 0.2;
const SIZE_MAX = 3.0;

// ✅ Zoom / Pan de l'éditeur
let editorZoom = 1;
let editorPanX = 0;
let editorPanY = 0;
const EZOOM_MIN = 1;
const EZOOM_MAX = 12;
let isPanningEditor = false;
let panStartCx = 0, panStartCy = 0, panOrigX = 0, panOrigY = 0, panMoved = false;

// Two-click placement state
let placementMode = 'idle';
let pendingDot = null;

// Drag state
let isDragging = false;
let dragTarget = null;

const getBasePath = () => {
    return (typeof window !== 'undefined' && window.location.pathname.startsWith('/tools/PlanPrincipe'))
        ? '/tools/PlanPrincipe' : '';
};

// ============================================
// ANNOTATION INPUT MODAL
// ============================================
function _showAnnotationModal(defaultId, callback) {
    const existing = document.getElementById('annotationInputModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'annotationInputModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55)';

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:10px;padding:28px 32px;min-width:340px;
                  box-shadow:0 8px 32px rgba(0,0,0,0.35);font-family:Arial,sans-serif;">
        <h6 style="margin:0 0 18px;font-size:15px;font-weight:700;color:#1a1a2e;">
          🔢 Numéro &amp; Description
        </h6>
        <div style="margin-bottom:14px;">
          <label style="font-size:12px;font-weight:600;color:#555;display:block;margin-bottom:4px;">
            Numéro d'annotation
          </label>
          <input id="_ann_num" type="number" min="1" value="${defaultId}"
                 style="width:100%;padding:8px 10px;border:1.5px solid #ccc;border-radius:6px;
                        font-size:15px;font-weight:700;color:#1565C0;outline:none;"
                 onkeydown="if(event.key==='Enter')document.getElementById('_ann_desc').focus()">
        </div>
        <div style="margin-bottom:22px;">
          <label style="font-size:12px;font-weight:600;color:#555;display:block;margin-bottom:4px;">
            Description
          </label>
          <input id="_ann_desc" type="text"
                 placeholder="ex: Profil aluminium, Joint EPDM…"
                 style="width:100%;padding:8px 10px;border:1.5px solid #ccc;border-radius:6px;
                        font-size:14px;outline:none;"
                 onkeydown="if(event.key==='Enter')document.getElementById('_ann_ok').click()">
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_ann_cancel"
                  style="padding:8px 20px;border:1.5px solid #ccc;border-radius:6px;
                         background:#f5f5f5;font-size:14px;cursor:pointer;">Annuler</button>
          <button id="_ann_ok"
                  style="padding:8px 22px;border:none;border-radius:6px;
                         background:#1565C0;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">OK</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const numInput  = document.getElementById('_ann_num');
    const descInput = document.getElementById('_ann_desc');
    const okBtn     = document.getElementById('_ann_ok');
    const cancelBtn = document.getElementById('_ann_cancel');

    // ✅ Pré-remplir la description depuis le formulaire par NUMÉRO d'annotation
    // (le champ description_N du formulaire est indexé par slot, pas par numéro)
    const byNum = _formDescriptionsByNumber();
    if (byNum[defaultId]) descInput.value = byNum[defaultId];

    // ✅ Si le numéro change dans le modal, recharger la description correspondante
    numInput.addEventListener('input', function () {
        const n = parseInt(numInput.value);
        if (!isNaN(n) && byNum[n] !== undefined) descInput.value = byNum[n];
    });

    setTimeout(() => numInput.focus(), 50);

    function _confirm() {
        const id   = parseInt(numInput.value);
        const desc = descInput.value.trim();
        overlay.remove();
        if (isNaN(id) || id < 1) { callback(null, null); return; }
        callback(id, desc);
    }
    function _cancel() { overlay.remove(); callback(null, null); }

    okBtn.addEventListener('click', _confirm);
    cancelBtn.addEventListener('click', _cancel);
    overlay.addEventListener('click', e => { if (e.target === overlay) _cancel(); });
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); _cancel(); }
    });
}

// ============================================
// DOMContentLoaded
// ============================================
window.addEventListener('DOMContentLoaded', function () {
    const base = getBasePath();

    const btnEdit = document.getElementById('btnEditImage');
    if (btnEdit) {
        btnEdit.addEventListener('click', function (e) {
            e.preventDefault();
            // ✅ PDF déjà converti en PNG (affichage) → data URL en mémoire
            if (pendingImageDataUrl && pendingImageDataUrl.startsWith('data:')) {
                _openNewImageInEditor(pendingImageDataUrl);
                return;
            }
            if (currentVueEclateeImage) {
                _openEditorFromSVG(currentVueEclateeImage, base);
                return;
            }
            alert("Veuillez d'abord sélectionner un PDF.");
        });
    }

    // Intercept form submit to flush annotations
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('button[type="submit"], input[type="submit"]');
        if (!btn) return;
        const form = btn.form || document.getElementById('mainForm');
        if (!form) return;
        if (!editorDirty) return;
        if (!editorFilename && !pendingImageFile) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const formAction = btn.getAttribute('formaction') || form.action || '';
        const isAdd      = formAction.includes('add_fiche');
        _flushAnnotationsToServer(base, isAdd ? 'add' : 'update', function () {
            if (formAction) form.action = formAction;
            form.submit();
        });
    }, true);

    // Dropdown change → load fiche
    const updateRefSelect = document.getElementById("updateRef");
    if (updateRefSelect) {
        updateRefSelect.addEventListener("change", function () {
            const ref = this.value;
            if (!ref) { clearForm(); return; }
            const previousRefInput = document.getElementById("previous_ref");
            if (previousRefInput) previousRefInput.value = ref;
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) loadingOverlay.classList.add('active');
            document.querySelectorAll('input[name^="delete_"]').forEach(i => i.value = "false");
            _resetEditorState();

            fetch(`${base}/get_fiche/${encodeURIComponent(ref)}`)
                .then(r => r.json())
                .then(data => {
                    if (loadingOverlay) loadingOverlay.classList.remove('active');
                    if (data.error) { alert('Erreur: ' + data.error); return; }
                    const fr = data.fr || data || {};

                    for (const [k, v] of Object.entries(fr)) {
                        if (['id','langue','type'].includes(k)) continue;
                        if (k.startsWith('number_') || k.startsWith('description_')) continue;
                        const input = document.querySelector(`[name="${k}"]`);
                        if (input && input.type !== "file") input.value = v || "";
                    }

                    const sizeDisplay = document.getElementById('imageSizeDisplay');
                    if (sizeDisplay) sizeDisplay.style.display = 'none';

                    for (let i = 1; i <= 200; i++) {
                        const n = document.getElementById('number_' + i);
                        const d = document.getElementById('description_' + i);
                        if (n) n.value = '';
                        if (d) d.value = '';
                        const badge = document.getElementById('badge_' + i);
                        if (badge) badge.textContent = i;
                    }

                    const dbNums = Object.keys(fr)
                        .filter(k => k.startsWith('number_') && fr[k] && fr[k].toString().trim())
                        .map(k => parseInt(k.split('_')[1]))
                        .filter(n => !isNaN(n))
                        .sort((a, b) => a - b);

                    dbNums.forEach((num, idx) => {
                        const slot  = idx + 1;
                        const nEl   = document.getElementById('number_' + slot);
                        const dEl   = document.getElementById('description_' + slot);
                        const badge = document.getElementById('badge_' + slot);
                        if (nEl) nEl.value = String(num);
                        if (dEl) dEl.value = (fr[`description_${num}`] || '').toString().trim();
                        if (badge) badge.textContent = String(num);
                    });

                    _setImagePreview('explodedPreview', fr.plan);
                    currentVueEclateeImage = fr.plan || null;
                    if (currentVueEclateeImage) {
                        editorFilename = currentVueEclateeImage.split('/').pop();
                    }
                    const btn = document.getElementById('btnEditImage');
                    if (btn) {
                        btn.disabled = !currentVueEclateeImage;
                        btn.title = currentVueEclateeImage ? 'Éditer les annotations' : 'Aucune image à éditer';
                    }
                    if (typeof refreshComposantRows === 'function') refreshComposantRows();
                })
                .catch(err => {
                    if (loadingOverlay) loadingOverlay.classList.remove('active');
                    alert('Erreur de chargement: ' + err.message);
                });
        });
    }

    // Auto-load from URL ?name=
    const urlParams   = new URLSearchParams(window.location.search);
    const nameFromUrl = urlParams.get('name');
    if (nameFromUrl && updateRefSelect) {
        updateRefSelect.value = nameFromUrl;
        const selectedValueEl = document.getElementById('selectedValue');
        if (selectedValueEl) selectedValueEl.textContent = nameFromUrl;
        document.querySelectorAll('.dropdown-item-custom').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === nameFromUrl);
        });
        updateRefSelect.dispatchEvent(new Event('change'));
    }
});

// ============================================
// HELPERS
// ============================================
function _resetEditorState() {
    editorAnnotations      = [];
    editorFilename         = '';
    editorDirty            = false;
    nextAnnotationId       = 1;
    pendingImageFile       = null;
    pendingImageDataUrl    = null;
    currentVueEclateeImage = null;
    editorImgW = 1500; editorImgH = 1300;
    placementMode = 'idle';
    pendingDot    = null;
    editorZoom = 1; editorPanX = 0; editorPanY = 0;
    const inp = document.getElementById('plan_already_saved');
    if (inp) inp.value = '';
    const btn = document.getElementById('btnEditImage');
    if (btn) { btn.disabled = true; btn.title = 'Aucune image à éditer'; }
}

function _setImagePreview(previewId, imagePath) {
    const img = document.getElementById(previewId);
    if (!img) return;
    if (imagePath) {
        img.src = getBasePath() + '/static/' + imagePath + '?t=' + Date.now();
        img.classList.remove('d-none', 'deleted');
        img.style.border = ''; img.style.opacity = '1';
        // ✅ Clic sur la preview → visionneuse plein écran dans la page
        img.style.cursor = 'zoom-in';
        img.title = '🔍 Cliquer pour agrandir (molette = zoom, Retour pour revenir)';
        img.onclick = function () {
            _openSvgViewer(getBasePath() + '/static/' + imagePath);
        };
    } else {
        img.src = ''; img.classList.add('d-none');
        img.style.cursor = '';
        img.title = '';
        img.onclick = null;
    }
}

function _getCurrentCpid(action) {
    const nameInput = document.getElementById('name');
    const updateRef = document.getElementById('updateRef');
    if (action === 'add')    return (nameInput && nameInput.value.trim()) || (updateRef && updateRef.value.trim()) || '';
    if (action === 'update') return (updateRef && updateRef.value.trim()) || (nameInput && nameInput.value.trim()) || '';
    return (nameInput && nameInput.value.trim()) || (updateRef && updateRef.value.trim()) || '';
}

// ✅ Lit les descriptions actuellement saisies dans le formulaire COMPOSANTS,
// indexées par NUMÉRO d'annotation (valeur du champ number_N, pas le slot).
function _formDescriptionsByNumber() {
    const map = {};
    for (let i = 1; i <= 200; i++) {
        const n = document.getElementById('number_' + i);
        const d = document.getElementById('description_' + i);
        if (!n || !d) continue;
        const num  = parseInt((n.value || '').trim());
        const desc = (d.value || '').trim();
        if (!isNaN(num) && num >= 1 && desc) map[num] = desc;
    }
    return map;
}

// ✅ Fusionne les descriptions du FORMULAIRE (= base de données, source la
// plus récente) dans une liste d'annotations chargée depuis le SVG.
// Corrige le cas : description modifiée dans COMPOSANTS + Mettre à jour,
// puis ouverture de l'éditeur → l'éditeur reprenait l'ANCIENNE description
// stockée dans le SVG et l'imposait partout au moment d'Enregistrer.
function _mergeFormDescriptions(anns) {
    const byNum = _formDescriptionsByNumber();
    anns.forEach(a => {
        if (byNum[a.id] !== undefined) a.description = byNum[a.id];
    });
    return anns;
}

// ============================================
// PDF UPLOAD — PNG serveur pour l'AFFICHAGE, PDF original conservé
// pour la conversion VECTORIELLE côté serveur (netteté A0).
// ✅ Les annotations de la fiche existante sont CONSERVÉES.
// ============================================
function handleImageUpload(input) {
    const file    = input.files[0];
    const preview = document.getElementById('explodedPreview');
    const btn     = document.getElementById('btnEditImage');
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
        input.value = '';
        if (preview) { preview.src = ''; preview.classList.add('d-none'); }
        if (btn) btn.disabled = true;
        const sizeDisplay = document.getElementById('imageSizeDisplay');
        if (sizeDisplay) {
            sizeDisplay.textContent = `❌ ${file.name} — seuls les fichiers PDF sont acceptés`;
            sizeDisplay.style.display      = 'inline-flex';
            sizeDisplay.style.background   = '#fef2f2';
            sizeDisplay.style.borderColor  = '#fecaca';
            sizeDisplay.style.color        = '#dc2626';
        }
        alert(`❌ Fichier refusé : ${file.name}\nSeuls les fichiers PDF sont acceptés.`);
        return;
    }

    // ✅ Capturer le SVG existant AVANT réinitialisation (annotations conservées)
    const prevSvg = currentVueEclateeImage;

    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.add('active');

    const fd = new FormData();
    fd.append('pdf', file);

    fetch(`${getBasePath()}/convert_pdf`, { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
            if (loadingOverlay) loadingOverlay.classList.remove('active');
            if (!data.success || !data.dataUrl) {
                input.value = '';
                if (preview) { preview.src = ''; preview.classList.add('d-none'); }
                if (btn) btn.disabled = true;
                alert('❌ Erreur conversion PDF : ' + (data.error || 'inconnue'));
                return;
            }

            // ── PNG = affichage éditeur/preview uniquement ──
            pendingImageDataUrl = data.dataUrl;

            // ✅ Le PDF ORIGINAL est conservé pour la conversion vectorielle serveur
            pendingImageFile = file;

            if (preview) {
                preview.src = data.dataUrl;
                preview.classList.remove('d-none', 'deleted');
                preview.style.border = ''; preview.style.opacity = '1';
            }
            if (btn) { btn.disabled = false; btn.title = 'Éditer ce plan'; }

            const sizeDisplay = document.getElementById('imageSizeDisplay');
            if (sizeDisplay) {
                sizeDisplay.textContent = `✓ PDF converti — ${data.width}×${data.height}px`;
                sizeDisplay.style.display      = 'inline-flex';
                sizeDisplay.style.background   = '#f0fdf4';
                sizeDisplay.style.borderColor  = '#bbf7d0';
                sizeDisplay.style.color        = '#059669';
            }

            const del = document.getElementById('delete_plan');
            if (del) del.value = "false";
            editorAnnotations      = [];
            editorDirty            = false;
            currentVueEclateeImage = null;
            editorFilename         = '';
            const alreadySaved = document.getElementById('plan_already_saved');
            if (alreadySaved) alreadySaved.value = '';

            if (data.width)  editorImgW = data.width;
            if (data.height) editorImgH = data.height;

            // ✅ Récupérer les annotations du SVG existant de la fiche
            // (descriptions du formulaire prioritaires)
            if (prevSvg) {
                fetch(`${getBasePath()}/get_svg_annotations/${prevSvg}`)
                    .then(r => r.json())
                    .then(a => {
                        const anns = _mergeFormDescriptions(
                            (a.annotations || []).map(x =>
                                _migrateAnnotation(x, a.width || editorImgW, a.height || editorImgH)));
                        if (anns.length) {
                            editorAnnotations = anns;
                            nextAnnotationId  = Math.max(...anns.map(v => v.id)) + 1;
                            editorDirty       = true;
                            _restoreSizeFromAnnotations(anns);
                            const s = document.getElementById('editorStatus');
                            if (s) {
                                s.textContent = `✔️ ${anns.length} annotation(s) existante(s) conservée(s) — cliquez sur Mettre à jour`;
                                s.style.color = '#4CAF50';
                            }
                        }
                    })
                    .catch(() => { /* pas d'annotations récupérables — plan neuf */ });
            }
        })
        .catch(err => {
            if (loadingOverlay) loadingOverlay.classList.remove('active');
            input.value = '';
            if (btn) btn.disabled = true;
            alert('❌ Erreur conversion PDF : ' + err.message);
        });
}

// ============================================
// EDITOR OPEN
// ============================================
function _openNewImageInEditor(dataUrl) {
    // ✅ Conserver les annotations récupérées de la fiche (pas de reset ici),
    // descriptions du formulaire prioritaires
    openEditorModal(dataUrl, _mergeFormDescriptions(editorAnnotations.slice()), null);
}

function _openEditorFromSVG(svgPath, base) {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.add('active');
    editorFilename = svgPath.split('/').pop();

    fetch(`${base}/get_svg_annotations/${svgPath}`)
        .then(r => r.json())
        .then(annData => {
            // ✅ Les descriptions du FORMULAIRE (= base, plus récentes) écrasent
            // celles stockées dans le SVG (potentiellement obsolètes)
            const existing = _mergeFormDescriptions(
                (annData.annotations || []).map(a =>
                    _migrateAnnotation(a, annData.width || 1500, annData.height || 1300)));
            editorAnnotations   = existing.slice();
            nextAnnotationId    = editorAnnotations.length
                ? Math.max(...editorAnnotations.map(a => a.id)) + 1 : 1;
            editorDirty = false;
            if (annData.width)  editorImgW = annData.width;
            if (annData.height) editorImgH = annData.height;
            _restoreSizeFromAnnotations(existing);

            // ✅ arrayBuffer + TextDecoder pour gérer correctement l'encodage UTF-8
            return fetch(`${getBasePath()}/static/uploads/${editorFilename}?t=${Date.now()}`)
                .then(r => r.arrayBuffer())
                .then(buf => {
                    if (loadingOverlay) loadingOverlay.classList.remove('active');

                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    const svgText = decoder.decode(buf);

                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');

                    const parseError = svgDoc.querySelector('parsererror');
                    if (parseError) {
                        console.warn('SVG parse error détecté, fallback blob URL:', parseError.textContent);
                    }

                    const imgEl = svgDoc.getElementById('source-image');
                    let imgHref = null;
                    if (imgEl) {
                        imgHref = imgEl.getAttribute('href') ||
                                  imgEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
                    }
                    if (imgHref && imgHref.startsWith('data:')) pendingImageDataUrl = imgHref;

                    // ✅ SVG vectoriel : retirer le groupe #annotations avant affichage
                    let imageSrc;
                    if (imgHref) {
                        imageSrc = imgHref;
                    } else {
                        const annGroup = svgDoc.getElementById('annotations');
                        if (annGroup && annGroup.parentNode) {
                            annGroup.parentNode.removeChild(annGroup);
                        }
                        const cleaned = new XMLSerializer().serializeToString(svgDoc);
                        const blob = new Blob([cleaned], { type: 'image/svg+xml' });
                        imageSrc = URL.createObjectURL(blob);
                    }
                    openEditorModal(imageSrc, existing, null);
                });
        })
        .catch(err => {
            if (loadingOverlay) loadingOverlay.classList.remove('active');
            alert('Erreur: ' + err.message);
        });
}

function _migrateAnnotation(a, imgW, imgH) {
    if (a.dotX !== undefined) return a;
    const lx = a.side === 'left' ? imgW * 0.07 : imgW * 0.93;
    const ann = { id: a.id, description: a.description || '',
                  dotX: a.x, dotY: a.y, labelX: a.labelX || lx, labelY: a.labelY || a.y };
    if (a.annotationSize) ann.annotationSize = a.annotationSize;
    return ann;
}

function _restoreSizeFromAnnotations(anns) {
    for (const a of anns) {
        if (a.annotationSize) {
            annotationSize = a.annotationSize;
            const sd = document.getElementById('sizeDisplay');
            if (sd) sd.textContent = annotationSize.toFixed(1) + 'x';
            return;
        }
    }
}

// ============================================
// EDITOR MODAL
// ============================================
function openEditorModal(imageSrc, existingAnnotations, onCleanup) {
    const modal = document.getElementById('editorModal');
    if (!modal) return;
    editorCanvas = document.getElementById('editorCanvas');
    if (!editorCanvas) return;
    editorCtx = editorCanvas.getContext('2d');

    editorAnnotations = existingAnnotations ? existingAnnotations.slice() : [];
    nextAnnotationId  = editorAnnotations.length
        ? Math.max(...editorAnnotations.map(a => a.id)) + 1 : 1;
    placementMode = 'idle';
    pendingDot    = null;
    // ✅ Zoom réinitialisé à l'ouverture (vue entière)
    editorZoom = 1; editorPanX = 0; editorPanY = 0;
    const sd = document.getElementById('sizeDisplay');
    if (sd) sd.textContent = annotationSize.toFixed(1) + 'x';

    editorImage = new Image();
    editorImage.onload = function () {
        editorImgW = editorImage.naturalWidth  || editorImgW || 1500;
        editorImgH = editorImage.naturalHeight || editorImgH || 1300;
        modal.style.display = 'flex';
        document.body.classList.add('editor-open');
        _ensureEditorZoomControls();
        requestAnimationFrame(function () {
            _resizeCanvasToContainer();
            drawEditor();
            if (onCleanup) onCleanup();
            _updateStatus();
            _updateEditorZoomBadge();
        });
    };
    editorImage.onerror = function () {
        if (onCleanup) onCleanup();
        alert("⚠️ Image introuvable. Veuillez re-uploader le PDF.");
    };
    editorImage.src = imageSrc;

    editorCanvas.onclick       = handleEditorClick;
    editorCanvas.oncontextmenu = handleEditorRightClick;
    editorCanvas.onmousedown   = handleMouseDown;
    editorCanvas.onmousemove   = handleMouseMove;
    editorCanvas.onmouseup     = handleMouseUp;
    editorCanvas.onwheel       = handleEditorWheel;
    editorCanvas.ondblclick    = handleEditorDblClick;
}

// ============================================
// ✅ ZOOM / PAN DE L'ÉDITEUR
// ============================================
function _drawDims() {
    return {
        dW: editorCanvas.width  * editorZoom,
        dH: editorCanvas.height * editorZoom
    };
}

function _clampEditorPan() {
    const { dW, dH } = _drawDims();
    editorPanX = Math.min(0, Math.max(editorCanvas.width  - dW, editorPanX));
    editorPanY = Math.min(0, Math.max(editorCanvas.height - dH, editorPanY));
}

function _zoomEditorAt(factor, cx, cy) {
    const old = editorZoom;
    editorZoom = Math.min(EZOOM_MAX, Math.max(EZOOM_MIN, old * factor));
    if (editorZoom === old) return;
    if (cx === undefined) { cx = editorCanvas.width / 2; cy = editorCanvas.height / 2; }
    const r = editorZoom / old;
    editorPanX = cx - (cx - editorPanX) * r;
    editorPanY = cy - (cy - editorPanY) * r;
    _clampEditorPan();
    drawEditor();
    _updateEditorZoomBadge();
}

function handleEditorWheel(e) {
    e.preventDefault();
    const { cx, cy } = _getMousePos(e);
    _zoomEditorAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, cx, cy);
}

function handleEditorDblClick(e) {
    e.preventDefault();
    editorZoom = 1; editorPanX = 0; editorPanY = 0;
    drawEditor();
    _updateEditorZoomBadge();
}

function _updateEditorZoomBadge() {
    const b = document.getElementById('_ezoom_pct');
    if (b) b.textContent = Math.round(editorZoom * 100) + '%';
}

function _ensureEditorZoomControls() {
    if (document.getElementById('_ezoom_pct')) return;
    const toolbar = document.querySelector('.editor-toolbar');
    if (!toolbar) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-left:12px;';
    wrap.innerHTML = `
      <span style="font-size:13px;font-weight:600;color:#555;">🔍 Zoom:</span>
      <button type="button" id="_ezoom_minus"
              style="width:30px;height:30px;border:1px solid #ccc;border-radius:4px;
                     background:#fff;font-size:18px;font-weight:700;cursor:pointer;
                     line-height:1;padding:0;">−</button>
      <span id="_ezoom_pct"
            style="min-width:48px;text-align:center;font-weight:700;
                   font-size:14px;color:#1565C0;">100%</span>
      <button type="button" id="_ezoom_plus"
              style="width:30px;height:30px;border:1px solid #ccc;border-radius:4px;
                     background:#fff;font-size:18px;font-weight:700;cursor:pointer;
                     line-height:1;padding:0;">+</button>`;
    const closeBtn = toolbar.querySelector('.btn-close-editor');
    toolbar.insertBefore(wrap, closeBtn || null);
    document.getElementById('_ezoom_plus').onclick  = () => _zoomEditorAt(1.25);
    document.getElementById('_ezoom_minus').onclick = () => _zoomEditorAt(1 / 1.25);
}

// ============================================
// CANVAS SIZING
// ============================================
function _resizeCanvasToContainer() {
    if (!editorCanvas || !editorImgW || !editorImgH || !editorImage) return;
    const wrap = document.querySelector('.editor-canvas-wrap');
    if (!wrap) return;
    const W = wrap.offsetWidth, H = wrap.offsetHeight;
    if (W <= 0 || H <= 0) return;
    editorCanvas.width  = W;
    editorCanvas.height = H;
    editorCanvas.style.width  = W + 'px';
    editorCanvas.style.height = H + 'px';
    editorCtx = editorCanvas.getContext('2d');
    _clampEditorPan();
    drawEditor();
}

window.addEventListener('resize', function () {
    if (document.getElementById('editorModal').style.display === 'flex')
        requestAnimationFrame(_resizeCanvasToContainer);
});
window.addEventListener('orientationchange', function () {
    if (document.getElementById('editorModal').style.display === 'flex')
        setTimeout(_resizeCanvasToContainer, 200);
});
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
        if (document.getElementById('editorModal').style.display === 'flex')
            requestAnimationFrame(_resizeCanvasToContainer);
    });
}
(function () {
    const wrap = document.querySelector('.editor-canvas-wrap');
    if (!wrap || !window.ResizeObserver) return;
    new ResizeObserver(function () {
        if (document.getElementById('editorModal').style.display === 'flex')
            requestAnimationFrame(_resizeCanvasToContainer);
    }).observe(wrap);
})();

// ============================================
// MOUSE POSITION — corrige le zoom navigateur
// ============================================
function _getMousePos(e) {
    const rect   = editorCanvas.getBoundingClientRect();
    const scaleX = editorCanvas.width  / rect.width;
    const scaleY = editorCanvas.height / rect.height;
    return {
        cx: (e.clientX - rect.left) * scaleX,
        cy: (e.clientY - rect.top)  * scaleY
    };
}

// ============================================
// COORDINATE HELPERS — stretch + zoom/pan
// ============================================
function _canvasToImageCoords(cx, cy) {
    const { dW, dH } = _drawDims();
    return {
        x: Math.max(0, Math.min(editorImgW, ((cx - editorPanX) / dW) * editorImgW)),
        y: Math.max(0, Math.min(editorImgH, ((cy - editorPanY) / dH) * editorImgH))
    };
}

function _dotHitTest(imgX, imgY, ann) {
    const { dW, dH } = _drawDims();
    const sx = dW / editorImgW;
    const sy = dH / editorImgH;
    const rx = 10 / sx, ry = 10 / sy;
    return ((imgX - ann.dotX)/rx)**2 + ((imgY - ann.dotY)/ry)**2 <= 1;
}

function _labelHitTest(imgX, imgY, ann) {
    const { dW, dH } = _drawDims();
    const sx     = dW / editorImgW;
    const sy     = dH / editorImgH;
    const baseR  = Math.max(14, dW / 55) * annotationSize;
    const rx = baseR / sx, ry = baseR / sy;
    return ((imgX - ann.labelX)/rx)**2 + ((imgY - ann.labelY)/ry)**2 <= 1;
}

// ============================================
// DRAW — image étirée + zoom/pan
// ============================================
function drawEditor() {
    if (!editorImage || !editorCtx) return;
    const W  = editorCanvas.width;
    const H  = editorCanvas.height;
    const { dW, dH } = _drawDims();
    const sx = dW / editorImgW;
    const sy = dH / editorImgH;

    editorCtx.clearRect(0, 0, W, H);
    editorCtx.fillStyle = '#ffffff';
    editorCtx.fillRect(0, 0, W, H);
    editorCtx.drawImage(editorImage, editorPanX, editorPanY, dW, dH);

    // Pending dot
    if (placementMode === 'waiting_label' && pendingDot) {
        const px = editorPanX + pendingDot.x * sx;
        const py = editorPanY + pendingDot.y * sy;
        const r  = Math.max(5, dW / 120) * annotationSize;
        editorCtx.fillStyle = '#FF6600';
        editorCtx.beginPath(); editorCtx.arc(px, py, r, 0, Math.PI * 2); editorCtx.fill();
        editorCtx.strokeStyle = '#FF6600'; editorCtx.lineWidth = 2;
        editorCtx.beginPath(); editorCtx.arc(px, py, r * 2.2, 0, Math.PI * 2); editorCtx.stroke();
    }

    // Annotations
    editorAnnotations.forEach(ann => {
        const dx = editorPanX + ann.dotX   * sx, dy = editorPanY + ann.dotY   * sy;
        const lx = editorPanX + ann.labelX * sx, ly = editorPanY + ann.labelY * sy;

        const lineW    = Math.max(1, dW / 600) * annotationSize;
        const dotR     = Math.max(4, dW / 180) * annotationSize;
        const circR    = Math.max(14, dW / 55)  * annotationSize;
        const fontSize = Math.max(10, dW / 60)  * annotationSize;

        editorCtx.strokeStyle = 'black';
        editorCtx.lineWidth   = lineW;
        editorCtx.beginPath(); editorCtx.moveTo(dx, dy); editorCtx.lineTo(lx, ly); editorCtx.stroke();

        editorCtx.fillStyle = 'black';
        editorCtx.beginPath(); editorCtx.arc(dx, dy, dotR, 0, Math.PI * 2); editorCtx.fill();

        editorCtx.fillStyle = 'black';
        editorCtx.beginPath(); editorCtx.arc(lx, ly, circR, 0, Math.PI * 2); editorCtx.fill();

        editorCtx.fillStyle    = 'white';
        editorCtx.font         = `bold ${fontSize}px Arial`;
        editorCtx.textAlign    = 'center';
        editorCtx.textBaseline = 'middle';
        editorCtx.fillText(ann.id, lx, ly);
    });
}

// ============================================
// CLICK HANDLER
// ============================================
function handleEditorClick(e) {
    if (isDragging) return;
    // ✅ Ne pas poser de point après un déplacement de vue (pan)
    if (panMoved) { panMoved = false; return; }
    if (e.ctrlKey || e.metaKey) return; // Ctrl réservé au pan
    const { cx, cy } = _getMousePos(e);
    const {x, y} = _canvasToImageCoords(cx, cy);

    if (placementMode === 'idle') {
        if (editorAnnotations.some(a => _labelHitTest(x, y, a))) return;
        pendingDot    = { x, y };
        placementMode = 'waiting_label';
        drawEditor();
        _updateStatus('🔶 Point posé — cliquez pour placer un cercle numéroté. Clic droit = nouveau point.');
        return;
    }

    if (placementMode === 'waiting_label') {
        if (editorAnnotations.some(a => _labelHitTest(x, y, a))) return;
        const labelX = x, labelY = y;
        _showAnnotationModal(nextAnnotationId, function(id, description) {
            if (id === null) {
                placementMode = 'idle'; pendingDot = null;
                drawEditor(); _updateStatus(); return;
            }
            editorAnnotations.push({
                id, description: description || '',
                dotX: pendingDot.x, dotY: pendingDot.y, labelX, labelY,
            });
            nextAnnotationId = Math.max(nextAnnotationId, id + 1);
            editorDirty = true;
            drawEditor();
            _updateStatus('🔶 Même point actif — cliquez encore pour un autre cercle. Clic droit = nouveau point.');
        });
    }
}

function handleEditorRightClick(e) {
    e.preventDefault();
    const { cx, cy } = _getMousePos(e);
    const {x, y} = _canvasToImageCoords(cx, cy);

    if (placementMode === 'waiting_label') {
        placementMode = 'idle'; pendingDot = null;
        drawEditor(); _updateStatus('✅ Point relâché — cliquez pour poser un nouveau point.');
        return false;
    }
    const idx = editorAnnotations.findIndex(a => _labelHitTest(x, y, a));
    if (idx !== -1) {
        editorAnnotations.splice(idx, 1);
        editorDirty = true;
        drawEditor(); _updateStatus();
        requestAnimationFrame(_syncFormFieldsFromAnnotations);
    }
    return false;
}

// ============================================
// DRAG (annotations) + PAN (vue)
// ============================================
function handleMouseDown(e) {
    // ✅ Pan : clic molette OU Ctrl + clic gauche
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
        const { cx, cy } = _getMousePos(e);
        isPanningEditor = true; panMoved = false;
        panStartCx = cx; panStartCy = cy;
        panOrigX = editorPanX; panOrigY = editorPanY;
        editorCanvas.style.cursor = 'grabbing';
        e.preventDefault(); e.stopPropagation();
        return;
    }
    if (placementMode !== 'idle') return;
    const { cx, cy } = _getMousePos(e);
    const {x, y} = _canvasToImageCoords(cx, cy);
    for (const ann of editorAnnotations) {
        if (_dotHitTest(x, y, ann)) {
            dragTarget = { ann, part: 'dot' }; isDragging = true;
            editorCanvas.style.cursor = 'move';
            e.preventDefault(); e.stopPropagation(); return;
        }
        if (_labelHitTest(x, y, ann)) {
            dragTarget = { ann, part: 'label' }; isDragging = true;
            editorCanvas.style.cursor = 'move';
            e.preventDefault(); e.stopPropagation(); return;
        }
    }
}

function handleMouseMove(e) {
    const { cx, cy } = _getMousePos(e);

    // ✅ Déplacement de la vue en cours
    if (isPanningEditor) {
        editorPanX = panOrigX + (cx - panStartCx);
        editorPanY = panOrigY + (cy - panStartCy);
        if (Math.abs(cx - panStartCx) > 3 || Math.abs(cy - panStartCy) > 3) panMoved = true;
        _clampEditorPan();
        drawEditor();
        e.preventDefault();
        return;
    }

    const {x, y} = _canvasToImageCoords(cx, cy);
    if (!isDragging || !dragTarget) {
        editorCanvas.style.cursor = (placementMode === 'waiting_label') ? 'crosshair'
            : (editorAnnotations.some(a => _dotHitTest(x, y, a) || _labelHitTest(x, y, a)) ? 'pointer' : 'crosshair');
        return;
    }
    const ix = Math.max(0, Math.min(editorImgW, x));
    const iy = Math.max(0, Math.min(editorImgH, y));
    if (dragTarget.part === 'dot')   { dragTarget.ann.dotX   = ix; dragTarget.ann.dotY   = iy; }
    else                             { dragTarget.ann.labelX = ix; dragTarget.ann.labelY = iy; }
    drawEditor(); e.preventDefault();
}

function handleMouseUp() {
    if (isPanningEditor) {
        isPanningEditor = false;
        editorCanvas.style.cursor = 'crosshair';
        return;
    }
    if (isDragging) {
        isDragging = false; dragTarget = null;
        editorCanvas.style.cursor = 'crosshair'; editorDirty = true;
    }
}

// ============================================
// TOOLBAR
// ============================================
function clearAllAnnotations() {
    if (confirm('Supprimer toutes les annotations ?')) {
        editorAnnotations = []; nextAnnotationId = 1; editorDirty = true;
        placementMode = 'idle'; pendingDot = null;
        drawEditor(); _updateStatus();
        requestAnimationFrame(_syncFormFieldsFromAnnotations);
    }
}

function saveEditorAnnotations() {
    // Canvas temporaire aux dimensions ORIGINALES de l'image (preview uniquement —
    // le SVG final est généré côté serveur en vectoriel)
    const tempCanvas  = document.createElement('canvas');
    tempCanvas.width  = editorImgW;
    tempCanvas.height = editorImgH;
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.fillStyle = '#ffffff';
    tempCtx.fillRect(0, 0, editorImgW, editorImgH);
    tempCtx.drawImage(editorImage, 0, 0, editorImgW, editorImgH);

    editorAnnotations.forEach(ann => {
        const dx = ann.dotX,   dy = ann.dotY;
        const lx = ann.labelX, ly = ann.labelY;

        const lineW    = Math.max(1,  editorImgW / 600) * annotationSize;
        const dotR     = Math.max(4,  editorImgW / 180) * annotationSize;
        const circR    = Math.max(14, editorImgW / 55)  * annotationSize;
        const fontSize = Math.max(10, editorImgW / 60)  * annotationSize;

        tempCtx.strokeStyle = 'black';
        tempCtx.lineWidth   = lineW;
        tempCtx.beginPath(); tempCtx.moveTo(dx, dy); tempCtx.lineTo(lx, ly); tempCtx.stroke();

        tempCtx.fillStyle = 'black';
        tempCtx.beginPath(); tempCtx.arc(dx, dy, dotR, 0, Math.PI * 2); tempCtx.fill();

        tempCtx.fillStyle = 'black';
        tempCtx.beginPath(); tempCtx.arc(lx, ly, circR, 0, Math.PI * 2); tempCtx.fill();

        tempCtx.fillStyle    = 'white';
        tempCtx.font         = `bold ${fontSize}px Arial`;
        tempCtx.textAlign    = 'center';
        tempCtx.textBaseline = 'middle';
        tempCtx.fillText(ann.id, lx, ly);
    });

    const preview = document.getElementById('explodedPreview');
    if (preview) {
        try {
            preview.src = tempCanvas.toDataURL('image/png');
        } catch (err) {
            console.warn('Preview non générée:', err.message);
        }
        preview.classList.remove('d-none', 'deleted');
        preview.style.border  = '2px solid #4CAF50';
        preview.style.opacity = '1';
        setTimeout(() => { if (preview) preview.style.border = ''; }, 2000);
    }

    editorDirty = true;
    _closeEditorKeepState();
    requestAnimationFrame(function () {
        _syncFormFieldsFromAnnotations();
        const s = document.getElementById('editorStatus');
        if (s) {
            s.textContent = '✔️ Annotations prêtes — cliquez sur Mettre à jour ou Ajouter';
            s.style.color = '#4CAF50';
        }
    });
}

function _closeEditorKeepState() {
    placementMode = 'idle'; pendingDot = null;
    const modal = document.getElementById('editorModal');
    if (modal) modal.style.display = 'none';
    document.body.classList.remove('editor-open');
    if (editorCanvas) {
        editorCanvas.onclick = editorCanvas.oncontextmenu =
        editorCanvas.onmousedown = editorCanvas.onmousemove =
        editorCanvas.onmouseup = editorCanvas.onwheel =
        editorCanvas.ondblclick = null;
    }
    isDragging = false; dragTarget = null;
    isPanningEditor = false;
}

function closeEditor() { _closeEditorKeepState(); editorDirty = false; }

function changeSize(delta) {
    annotationSize = Math.round(
        Math.min(SIZE_MAX, Math.max(SIZE_MIN, annotationSize + delta)) * 10
    ) / 10;
    document.getElementById('sizeDisplay').textContent = annotationSize.toFixed(1) + 'x';
    drawEditor();
}

function _updateStatus(msg) {
    const s = document.getElementById('editorStatus');
    if (!s) return;
    if (msg) {
        s.textContent = msg; s.style.color = '#FF6600';
    } else if (placementMode === 'waiting_label') {
        s.textContent = '🔶 Point actif — cliquez pour ajouter un cercle | Clic droit = nouveau point';
        s.style.color = '#FF6600';
    } else {
        s.textContent = `${editorAnnotations.length} annotation(s) — Molette = zoom · Ctrl+glisser = déplacer`;
        s.style.color = '';
    }
}

// ============================================
// SYNC FORM FIELDS FROM ANNOTATIONS
// ============================================
function _syncFormFieldsFromAnnotations() {
    const maxVue = 200;

    // ✅ Sauvegarder les descriptions déjà saisies dans le formulaire
    const savedDescs = _formDescriptionsByNumber();

    for (let i = 1; i <= maxVue; i++) {
        const n     = document.getElementById('number_' + i);
        const d     = document.getElementById('description_' + i);
        const badge = document.getElementById('badge_' + i);
        if (n) n.value = '';
        if (d) d.value = '';
        if (badge) badge.textContent = i;
    }
    editorAnnotations.forEach((a, idx) => {
        const slot  = idx + 1;
        if (slot > maxVue) return;
        const n     = document.getElementById('number_' + slot);
        const d     = document.getElementById('description_' + slot);
        const badge = document.getElementById('badge_' + slot);
        if (n) n.value = String(a.id);
        // ✅ Priorité : description de l'annotation, sinon celle du formulaire
        if (d) d.value = (a.description || '').trim() || savedDescs[a.id] || '';
        if (badge) badge.textContent = String(a.id);
    });
    if (typeof refreshComposantRows === 'function') refreshComposantRows();
}

// ============================================
// FLUSH TO SERVER
// ============================================
function _annotationsForServer() {
    // ✅ Les descriptions saisies dans le formulaire COMPOSANTS sont prioritaires
    const formDescs = _formDescriptionsByNumber();
    return editorAnnotations.map(a => ({
        id: a.id,
        description: formDescs[a.id] !== undefined
            ? formDescs[a.id]
            : (a.description || ''),
        x: a.dotX, y: a.dotY, labelX: a.labelX, labelY: a.labelY,
        side: 'free', annotationSize: annotationSize,
    }));
}

function _flushAnnotationsToServer(base, submitAction, callback) {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.add('active');
    const cpid = _getCurrentCpid(submitAction);

    if (!cpid) {
        if (loadingOverlay) loadingOverlay.classList.remove('active');
        alert('Name introuvable. Veuillez saisir ou sélectionner un Name.');
        return;
    }

    function _doUpload(imageFile) {
        const fd = new FormData();
        fd.append("plan", imageFile);
        fd.append("annotations", JSON.stringify(_annotationsForServer()));
        fd.append("name", cpid); fd.append("cpid", cpid);
        fetch(`${base}/create_exploded_view_with_annotations`, { method: 'POST', body: fd })
            .then(r => r.json())
            .then(data => {
                if (loadingOverlay) loadingOverlay.classList.remove('active');
                if (data.success && data.filename) {
                    editorFilename      = data.filename;
                    editorDirty         = false;
                    pendingImageFile    = null;
                    pendingImageDataUrl = null;
                    const inp = document.getElementById('plan_already_saved');
                    if (inp) inp.value = editorFilename;
                    callback();
                } else { alert('Erreur SVG: ' + (data.error || 'Unknown')); }
            })
            .catch(err => {
                if (loadingOverlay) loadingOverlay.classList.remove('active');
                alert('Erreur: ' + err.message);
            });
    }

    // ✅ Un PDF a été uploadé → le serveur le convertit en SVG vectoriel
    if (pendingImageFile) { _doUpload(pendingImageFile); return; }

    // ✅ Fiche existante (SVG déjà sur le serveur) → réinjection des annotations
    if (editorFilename) {
        fetch(`${base}/save_annotations`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: editorFilename, annotations: _annotationsForServer() })
        })
            .then(r => r.json())
            .then(data => {
                if (loadingOverlay) loadingOverlay.classList.remove('active');
                if (data.success) {
                    editorDirty = false;
                    const targetSvgFilename = cpid.replace(/[^a-zA-Z0-9._-]/g, '_') + '.svg';
                    const inp = document.getElementById('plan_already_saved');
                    if (inp) inp.value = (editorFilename === targetSvgFilename) ? editorFilename : '';
                    callback();
                } else { alert('Erreur: ' + (data.error || 'Unknown')); }
            })
            .catch(err => {
                if (loadingOverlay) loadingOverlay.classList.remove('active');
                alert('Erreur: ' + err.message);
            });
        return;
    }

    if (loadingOverlay) loadingOverlay.classList.remove('active');
    alert('Image source introuvable en mémoire. Veuillez re-uploader le PDF.');
}

// ============================================
// FORM HELPERS
// ============================================
function clearForm() {
    document.querySelectorAll('#mainForm input[type="text"], #mainForm input[type="date"], #mainForm textarea')
        .forEach(i => { i.value = ''; });
    document.querySelectorAll('.preview').forEach(img => {
        img.src = ''; img.classList.add('d-none');
        img.classList.remove('deleted'); img.style.border = ''; img.style.opacity = '1';
    });
    document.querySelectorAll('input[name^="delete_"]').forEach(i => i.value = 'false');
    document.querySelectorAll('input[type="file"]').forEach(i => i.value = '');
    const prev = document.getElementById('previous_ref');
    if (prev) prev.value = '';
    const sizeDisplay = document.getElementById('imageSizeDisplay');
    if (sizeDisplay) sizeDisplay.style.display = 'none';
    _resetEditorState();
    if (typeof refreshComposantRows === 'function') refreshComposantRows();
}

function markImageForDeletion(fieldName, previewId) {
    if (!confirm('Êtes-vous sûr de vouloir supprimer cette image ?')) return;
    const del = document.getElementById(`delete_${fieldName}`);
    if (del) del.value = "true";
    const preview = document.getElementById(previewId);
    if (preview) {
        preview.classList.add('deleted');
        preview.style.border  = '3px solid red';
        preview.style.opacity = '0.5';
    }
    const fileInput = document.querySelector(`input[name="${fieldName}"]`);
    if (fileInput && fileInput.type === 'file') fileInput.value = '';
    if (fieldName === 'plan') {
        _resetEditorState();
        const sizeDisplay = document.getElementById('imageSizeDisplay');
        if (sizeDisplay) sizeDisplay.style.display = 'none';
    }
}

function GOficheTechnique() {
    const name = document.getElementById("updateRef").value;
    const base = getBasePath();
    if (!name) { alert('Sélectionnez un Name'); return; }
    window.location.href = `${base}/index?name=${encodeURIComponent(name)}`;
}

function confirmDelete() {
    const ref = document.getElementById("updateRef").value;
    if (!ref) { alert('Sélectionnez un Name à supprimer'); return; }
    if (confirm(`Supprimer "${ref}" ?`)) {
        const base = getBasePath();
        const form = document.createElement("form");
        form.method = "POST"; form.action = `${base}/delete_fiche`;
        const i1 = document.createElement("input");
        i1.type = "hidden"; i1.name = "deleteRef"; i1.value = ref;
        form.appendChild(i1); document.body.appendChild(form); form.submit();
    }
}

// ============================================
// ✅ VISIONNEUSE SVG PLEIN ÉCRAN (dans la page)
// ============================================
let _vwZoom = 1;

function _openSvgViewer(url) {
    const old = document.getElementById('svgViewerOverlay');
    if (old) old.remove();
    _vwZoom = 1;

    const ov = document.createElement('div');
    ov.id = 'svgViewerOverlay';
    ov.style.cssText =
        'position:fixed;inset:0;z-index:99998;background:#fff;' +
        'display:flex;flex-direction:column;font-family:Inter,Arial,sans-serif;';

    ov.innerHTML = `
      <div style="flex:0 0 auto;display:flex;gap:10px;align-items:center;
                  padding:10px 14px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
        <button id="_vw_back"
                style="padding:8px 18px;border:1px solid #cbd5e1;border-radius:7px;
                       background:#fff;font-size:13px;font-weight:600;cursor:pointer;">
          ← Retour
        </button>
        <button id="_vw_minus"
                style="width:34px;height:34px;border:1px solid #cbd5e1;border-radius:7px;
                       background:#fff;font-size:18px;font-weight:700;cursor:pointer;">−</button>
        <span id="_vw_pct"
              style="min-width:56px;text-align:center;font-weight:700;
                     font-size:13px;color:#2563eb;">100%</span>
        <button id="_vw_plus"
                style="width:34px;height:34px;border:1px solid #cbd5e1;border-radius:7px;
                       background:#fff;font-size:18px;font-weight:700;cursor:pointer;">+</button>
        <span style="color:#94a3b8;font-size:12px;">
          Molette = zoom · Glisser = déplacer · Échap = retour
        </span>
      </div>
      <div id="_vw_scroll" style="flex:1;overflow:auto;background:#e9ecef;cursor:grab;">
        <img id="_vw_img" src="${url}"
             style="display:block;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.15);
                    margin:20px auto;" draggable="false">
      </div>`;

    document.body.appendChild(ov);

    const scroll = document.getElementById('_vw_scroll');
    const img    = document.getElementById('_vw_img');
    const pct    = document.getElementById('_vw_pct');

    function _apply() {
        img.style.width = Math.round((scroll.clientWidth - 40) * _vwZoom) + 'px';
        pct.textContent = Math.round(_vwZoom * 100) + '%';
    }
    _apply();

    function _zoomAt(factor, cx, cy) {
        const oldZoom = _vwZoom;
        _vwZoom = Math.min(20, Math.max(0.2, _vwZoom * factor));
        if (_vwZoom === oldZoom) return;
        const ratio = _vwZoom / oldZoom;
        const rect  = scroll.getBoundingClientRect();
        const px = (cx !== undefined ? cx - rect.left : rect.width  / 2);
        const py = (cy !== undefined ? cy - rect.top  : rect.height / 2);
        const sx = scroll.scrollLeft, sy = scroll.scrollTop;
        _apply();
        scroll.scrollLeft = (sx + px) * ratio - px;
        scroll.scrollTop  = (sy + py) * ratio - py;
    }

    scroll.addEventListener('wheel', function (e) {
        e.preventDefault();
        _zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY);
    }, { passive: false });

    document.getElementById('_vw_plus').onclick  = () => _zoomAt(1.25);
    document.getElementById('_vw_minus').onclick = () => _zoomAt(1 / 1.25);

    let panning = false, startX = 0, startY = 0, startL = 0, startT = 0;
    scroll.addEventListener('mousedown', function (e) {
        panning = true; startX = e.clientX; startY = e.clientY;
        startL = scroll.scrollLeft; startT = scroll.scrollTop;
        scroll.style.cursor = 'grabbing';
        e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
        if (!panning) return;
        scroll.scrollLeft = startL - (e.clientX - startX);
        scroll.scrollTop  = startT - (e.clientY - startY);
    });
    window.addEventListener('mouseup', function () {
        panning = false;
        scroll.style.cursor = 'grab';
    });

    function _close() {
        ov.remove();
        document.removeEventListener('keydown', _esc);
    }
    function _esc(e) { if (e.key === 'Escape') _close(); }
    document.getElementById('_vw_back').onclick = _close;
    document.addEventListener('keydown', _esc);
}

// ============================================
// DROPDOWN
// ============================================
document.addEventListener('DOMContentLoaded', function () {
    const dropdownHeader = document.getElementById('dropdownHeader');
    const dropdownMenu   = document.getElementById('dropdownMenu');
    const dropdownList   = document.getElementById('dropdownList');
    const selectedValue  = document.getElementById('selectedValue');
    const searchInput    = document.getElementById('searchInput');
    const hiddenSelect   = document.getElementById('updateRef');

    if (dropdownHeader) {
        dropdownHeader.addEventListener('click', () => {
            dropdownHeader.classList.toggle('active');
            dropdownMenu.classList.toggle('active');
            if (dropdownMenu.classList.contains('active') && searchInput) searchInput.focus();
        });
    }
    if (dropdownList) {
        dropdownList.addEventListener('click', (e) => {
            const item = e.target.closest('.dropdown-item-custom');
            if (!item) return;
            document.querySelectorAll('.dropdown-item-custom').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            if (selectedValue) selectedValue.textContent = item.querySelector('span').textContent;
            if (hiddenSelect) {
                hiddenSelect.value = item.dataset.value;
                hiddenSelect.dispatchEvent(new Event('change'));
            }
            if (dropdownHeader) dropdownHeader.classList.remove('active');
            if (dropdownMenu)   dropdownMenu.classList.remove('active');
            if (searchInput)    searchInput.value = '';
            document.querySelectorAll('.dropdown-item-custom').forEach(i => i.style.display = 'flex');
        });
    }
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('.dropdown-item-custom').forEach(item => {
                item.style.display = item.querySelector('span').textContent.toLowerCase().includes(term) ? 'flex' : 'none';
            });
        });
    }
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-dropdown')) {
            if (dropdownHeader) dropdownHeader.classList.remove('active');
            if (dropdownMenu)   dropdownMenu.classList.remove('active');
        }
    });
});