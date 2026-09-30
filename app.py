from flask import Flask, render_template, request, redirect, jsonify, flash, Response
import sqlite3
import os
import sys
import re
import shutil
import base64
import subprocess
import json as _json
import xml.etree.ElementTree as ET
import requests
from werkzeug.utils import secure_filename
from datetime import datetime

BASE_PATH = '/tools/PlanPrincipe'

app = Flask(__name__, static_url_path=f'{BASE_PATH}/static')
app.secret_key = "supersecretkey"

DB_NAME       = "PLANDB.db"
TABLE         = "Plan_DB"
UPLOAD_FOLDER = "static/uploads"

# Max annotation number — columns added on-demand, never pre-created
MAX_VUE_ECLATEE = 200

# Largeur cible (px) du système de coordonnées PDF → SVG/PNG
PDF_TARGET_WIDTH = 4000

# ✅ Chemins possibles de pdftocairo (Poppler) — le premier trouvé est utilisé.
# RECOMMANDÉ : mettre Poppler DANS le projet (dossier ./poppler à côté de
# app.py) → il est déployé avec le code, rien à installer sur le serveur.
# Télécharger : https://github.com/oschwartz10612/poppler-windows/releases
PDFTOCAIRO_CANDIDATES = [
    r"C:\poppler\Library\bin\pdftocairo.exe",
    r"C:\poppler\bin\pdftocairo.exe",
    "pdftocairo",  # si présent dans le PATH (Linux/Mac ou PATH Windows)
]

# Dossiers scannés récursivement pour trouver pdftocairo(.exe),
# quel que soit le niveau d'imbrication créé par l'extraction du zip
PDFTOCAIRO_SCAN_DIRS = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'poppler'),  # ./poppler dans le projet
    r"C:\poppler",
]

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Odoo session check (internal, same host as backend.tecnibo.com's /api/me)
ODOO_ME_URL = "http://192.168.30.92:3001/api/me"

# Login gate: always ON in production (gunicorn), OFF for local development
# (`flask run` / `python app.py`), so nobody has to comment it out to work locally.
#   PLANPRINCIPE_AUTH=on  → turn it on locally, to test the gate itself
#   nothing can turn it off under gunicorn (PLANPRINCIPE_AUTH=off is ignored there)
_UNDER_GUNICORN = 'gunicorn' in sys.modules
_AUTH_ENV = os.environ.get('PLANPRINCIPE_AUTH', '').strip().lower()
AUTH_ENABLED = True if _UNDER_GUNICORN else _AUTH_ENV in ('on', '1', 'true', 'yes')
if _UNDER_GUNICORN and _AUTH_ENV in ('off', '0', 'false', 'no'):
    print('[AUTH] PLANPRINCIPE_AUTH=off ignored: the login gate is always on under gunicorn', flush=True)
print(f"[AUTH] Odoo login gate {'ON' if AUTH_ENABLED else 'OFF (local development)'}", flush=True)


def base_url():
    return BASE_PATH


def is_authenticated():
    """Validate the visitor's session_id cookie against the real Odoo session."""
    session_id = request.cookies.get('session_id')
    if not session_id:
        return False
    try:
        r = requests.get(ODOO_ME_URL, cookies={'session_id': session_id}, timeout=5)
        return bool(r.json().get('authenticated'))
    except (requests.RequestException, ValueError):
        return False


@app.before_request
def require_auth():
    if not AUTH_ENABLED:
        return None
    if request.path.startswith('/static/') or request.path.startswith(f'{BASE_PATH}/static/'):
        return None
    if not is_authenticated():
        return redirect('https://backend.tecnibo.com/')


def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Base table only — number_N/description_N added on demand."""
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT NOT NULL UNIQUE,
            ref_client        TEXT,
            projet            TEXT,
            Plan_de_principe  TEXT,
            adress            TEXT,
            Nom_du_fichier    TEXT,
            Date_de_creation  TEXT,
            plan              TEXT,
            plan_count        INTEGER DEFAULT 0
        )
    """)
    # Add new columns to existing DB if missing
    existing = {row[1] for row in c.execute(f"PRAGMA table_info({TABLE})").fetchall()}
    new_cols = {
        'ref_client':       'TEXT',
        'projet':           'TEXT',
        'Plan_de_principe': 'TEXT',
        'adress':           'TEXT',
        'Nom_du_fichier':   'TEXT',
        'Date_de_creation': 'TEXT',
    }
    for col, typ in new_cols.items():
        if col not in existing:
            c.execute(f"ALTER TABLE {TABLE} ADD COLUMN {col} {typ}")
    conn.commit()
    conn.close()


init_db()


def _existing_columns(conn):
    rows = conn.execute(f"PRAGMA table_info({TABLE})").fetchall()
    return {row[1] for row in rows}


def ensure_columns(conn, numbers):
    """Add number_N and description_N columns for each N if missing."""
    existing = _existing_columns(conn)
    for n in numbers:
        if f'number_{n}' not in existing:
            conn.execute(f"ALTER TABLE {TABLE} ADD COLUMN number_{n} TEXT")
        if f'description_{n}' not in existing:
            conn.execute(f"ALTER TABLE {TABLE} ADD COLUMN description_{n} TEXT")
    conn.commit()


def count_vue_eclatee(data):
    return sum(
        1 for k, v in data.items()
        if k.startswith('number_') and str(v or '').strip()
    )


def _find_pdftocairo():
    """
    Retourne le premier exécutable pdftocairo disponible, sinon None.
    1) Chemins connus (PDFTOCAIRO_CANDIDATES)
    2) ✅ Scan récursif des dossiers PDFTOCAIRO_SCAN_DIRS — en priorité
       le dossier ./poppler embarqué dans le projet (déployé avec le code)
    """
    for cand in PDFTOCAIRO_CANDIDATES:
        if os.path.sep in cand or (os.altsep and os.altsep in cand):
            if os.path.exists(cand):
                return cand
        else:
            found = shutil.which(cand)
            if found:
                return found

    for scan_root in PDFTOCAIRO_SCAN_DIRS:
        if os.path.isdir(scan_root):
            for dirpath, _dirs, files in os.walk(scan_root):
                for fn in files:
                    if fn.lower() in ('pdftocairo.exe', 'pdftocairo'):
                        return os.path.join(dirpath, fn)
    return None


def _pdf_to_png_bytes(pdf_path):
    """
    Rend la 1ère page d'un PDF en PNG (PDF_TARGET_WIDTH px de large).
    Utilisé UNIQUEMENT pour l'affichage dans l'éditeur canvas / preview.
    Retourne (png_bytes, width, height).
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError("PyMuPDF non installé — exécutez : pip install PyMuPDF")
    doc  = fitz.open(pdf_path)
    if doc.page_count < 1:
        doc.close()
        raise RuntimeError("PDF vide — aucune page trouvée")
    page = doc[0]
    zoom = PDF_TARGET_WIDTH / page.rect.width
    pix  = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    png  = pix.tobytes('png')
    w, h = pix.width, pix.height
    doc.close()
    return png, w, h


def _pdf_page_size(pdf_path):
    """Retourne (width_pt, height_pt) de la 1ère page du PDF."""
    try:
        import fitz
    except ImportError:
        raise RuntimeError("PyMuPDF non installé — exécutez : pip install PyMuPDF")
    doc = fitz.open(pdf_path)
    if doc.page_count < 1:
        doc.close()
        raise RuntimeError("PDF vide — aucune page trouvée")
    w, h = doc[0].rect.width, doc[0].rect.height
    doc.close()
    return w, h


def _pdf_to_vector_svg(pdf_path):
    """
    ✅ Convertit la 1ère page d'un PDF en SVG 100% VECTORIEL et FIDÈLE via
    Poppler (pdftocairo) — qualité identique au PDF à toutes les échelles,
    y compris l'impression A0.
    Le SVG est ramené dans le système de coordonnées PDF_TARGET_WIDTH px
    (le même que le PNG de l'éditeur) → annotations parfaitement alignées.
    Retourne (svg_inner_markup, img_w, img_h). Lève une exception si
    Poppler est indisponible ou si la conversion échoue.
    """
    exe = _find_pdftocairo()
    if not exe:
        raise RuntimeError(
            "pdftocairo (Poppler) INTROUVABLE. Installez Poppler : "
            "https://github.com/oschwartz10612/poppler-windows/releases "
            "→ décompressez dans C:\\poppler → vérifiez que "
            "C:\\poppler\\Library\\bin\\pdftocairo.exe existe, ou ajoutez "
            "votre chemin dans PDFTOCAIRO_CANDIDATES (app.py). "
            "Diagnostic : ouvrez /check_poppler dans le navigateur."
        )

    page_w, page_h = _pdf_page_size(pdf_path)
    img_w = PDF_TARGET_WIDTH
    img_h = round(page_h / page_w * PDF_TARGET_WIDTH)

    out_svg = pdf_path + '.vec.svg'
    try:
        subprocess.run(
            [exe, '-svg', '-f', '1', '-l', '1', pdf_path, out_svg],
            check=True, capture_output=True, timeout=120
        )
        with open(out_svg, 'r', encoding='utf-8') as f:
            svg_text = f.read()
    finally:
        if os.path.exists(out_svg):
            os.remove(out_svg)

    # Retirer une éventuelle déclaration XML
    stripped = svg_text.lstrip()
    if stripped.startswith('<?xml'):
        svg_text = stripped.split('?>', 1)[1]

    # La balise <svg> imbriquée garde son viewBox natif (points PDF) ;
    # on force sa taille d'affichage à (img_w × img_h) → mise à l'échelle
    # automatique dans le système de coordonnées des annotations.
    def _fix_nested(mo):
        tag = mo.group(0)
        tag = re.sub(r'\swidth="[^"]*"',  '', tag)
        tag = re.sub(r'\sheight="[^"]*"', '', tag)
        return tag[:-1] + f' x="0" y="0" width="{img_w}" height="{img_h}" preserveAspectRatio="none">'
    svg_text = re.sub(r'<svg\b[^>]*>', _fix_nested, svg_text, count=1)

    return svg_text, img_w, img_h


def make_svg(file, name=None):
    """
    Crée le SVG du plan.
    PDF → conversion VECTORIELLE OBLIGATOIRE (pas de fallback raster :
    si Poppler manque, on échoue avec un message clair plutôt que de
    produire un plan pixelisé à l'impression A0).
    Images (png/jpg) → encapsulation raster classique.
    Retourne le chemin relatif, ou lève une exception avec la raison.
    """
    if not file or not file.filename:
        return None
    filename = secure_filename(file.filename)
    _, ext   = os.path.splitext(filename)
    svg_name = (secure_filename(name) if name else os.path.splitext(filename)[0]) + '.svg'

    raw_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(raw_path)

    try:
        if ext.lower() == '.pdf':
            # ✅ VECTORIEL OBLIGATOIRE — netteté identique au PDF en A0
            inner_markup, img_w, img_h = _pdf_to_vector_svg(raw_path)
            inner_markup = f'<g id="source-vector">{inner_markup}</g>'
            print(f"[PLANDB] ✅ Conversion VECTORIELLE réussie pour {svg_name}")
        else:
            try:
                from PIL import Image as PILImage
                with PILImage.open(raw_path) as im:
                    img_w, img_h = im.size
            except Exception:
                img_w, img_h = 700, 900

            with open(raw_path, 'rb') as f:
                img_b64 = base64.b64encode(f.read()).decode()

            mime = 'image/png' if ext.lower() == '.png' else 'image/jpeg'
            inner_markup = (
                f'<image id="source-image" x="0" y="0" width="{img_w}" height="{img_h}" '
                f'xlink:href="data:{mime};base64,{img_b64}" preserveAspectRatio="none"/>'
            )
    finally:
        if os.path.exists(raw_path):
            os.remove(raw_path)

    svg_content = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{img_w}" height="{img_h}" viewBox="0 0 {img_w} {img_h}" '
        'preserveAspectRatio="none">\n'
        f'  {inner_markup}\n'
        '  <g id="annotations"></g>\n'
        '</svg>'
    )
    svg_path = os.path.join(app.config['UPLOAD_FOLDER'], svg_name)
    with open(svg_path, 'w', encoding='utf-8') as f:
        f.write(svg_content)
    return f"uploads/{svg_name}"


def copy_svg(src_rel, new_name):
    if not src_rel or not new_name or not src_rel.lower().endswith('.svg'):
        return src_rel
    src = os.path.join('static', src_rel)
    if not os.path.exists(src):
        return src_rel
    dst_name = secure_filename(new_name) + '.svg'
    dst      = os.path.join(app.config['UPLOAD_FOLDER'], dst_name)
    try:
        shutil.copy2(src, dst)
        return f"uploads/{dst_name}"
    except Exception:
        return src_rel


def valid_svg_for_name(saved, name):
    if not saved or not name:
        return False
    return saved.strip() == secure_filename(name) + '.svg'


def inject_annotations(root, annotations):
    ns  = {'svg': 'http://www.w3.org/2000/svg'}
    old = root.find('.//svg:g[@id="annotations"]', ns)
    if old is not None:
        root.remove(old)
    grp = ET.SubElement(root, '{http://www.w3.org/2000/svg}g')
    grp.set('id', 'annotations')

    vb = root.get('viewBox', '0 0 700 900').split()
    try:
        img_w, img_h = float(vb[2]), float(vb[3])
    except Exception:
        img_w, img_h = 700, 900

    for ann in annotations:
        dx   = float(ann['x'])
        dy   = float(ann['y'])
        aid  = int(ann['id'])
        side = ann.get('side', 'free')
        sz   = float(ann.get('annotationSize', 1.0))

        if 'labelX' in ann and 'labelY' in ann:
            lx = float(ann['labelX'])
            ly = float(ann['labelY'])
        elif side == 'left':
            lx = img_w * 0.07
            ly = dy
        else:
            lx = img_w * 0.93
            ly = dy

        g    = ET.SubElement(grp, '{http://www.w3.org/2000/svg}g')
        desc = str(ann.get('description', '') or '')
        for k, v in [('data-id', str(aid)), ('data-x', str(dx)), ('data-y', str(dy)),
                     ('data-side', side), ('data-lx', str(lx)), ('data-ly', str(ly)),
                     ('data-size', str(sz)), ('data-desc', desc)]:
            g.set(k, v)

        line_w = max(0.2, (img_w / 350) * sz)
        ln = ET.SubElement(g, '{http://www.w3.org/2000/svg}line')
        for k, v in [('x1', str(dx)), ('y1', str(dy)), ('x2', str(lx)), ('y2', str(ly)),
                     ('stroke', 'black'), ('stroke-width', str(line_w))]:
            ln.set(k, v)

        dot_r = max(0.5, (img_w / 233) * sz)
        dot = ET.SubElement(g, '{http://www.w3.org/2000/svg}circle')
        for k, v in [('cx', str(dx)), ('cy', str(dy)), ('r', str(dot_r)), ('fill', 'black')]:
            dot.set(k, v)

        label_r = max(2, (img_w / 35) * sz)
        circle = ET.SubElement(g, '{http://www.w3.org/2000/svg}circle')
        for k, v in [('cx', str(lx)), ('cy', str(ly)), ('r', str(label_r)), ('fill', 'black')]:
            circle.set(k, v)

        font_sz = max(2, (img_w / 35) * sz)
        t = ET.SubElement(g, '{http://www.w3.org/2000/svg}text')
        for k, v in [('x', str(lx)), ('y', str(ly)),
                     ('text-anchor', 'middle'), ('dominant-baseline', 'central'),
                     ('fill', 'white'), ('font-size', str(font_sz)),
                     ('font-weight', 'bold'), ('font-family', 'Arial, sans-serif')]:
            t.set(k, v)
        t.text = str(aid)


_SKIP = frozenset({'previous_ref', 'updateRef', 'deleteRef', 'plan_already_saved'})

# Fields that are plain text columns (not composant slots)
_INFO_FIELDS = frozenset({
    'name', 'ref_client', 'projet', 'Plan_de_principe',
    'adress', 'Nom_du_fichier', 'Date_de_creation'
})


def _collect(form, name):
    """
    Collect form data.
    For number_N fields: the VALUE typed by user IS the annotation number.
    So if slot number_2 contains "50", we store it in column number_50.
    Empty slots are ignored — no column created.
    """
    data = {}

    # Non-composant fields
    for k, v in form.items():
        if k in _SKIP or k.startswith('delete_'):
            continue
        if k.startswith('number_') or k.startswith('description_'):
            continue  # handled below
        data[k] = v.strip() if v else None

    # Composant fields: remap slot → actual annotation number
    for k, v in form.items():
        if not k.startswith('number_'):
            continue
        val = (v or '').strip()
        if not val:
            continue
        try:
            slot = int(k.split('_', 1)[1])   # form slot index
            num  = int(val)                   # actual annotation number typed
            if num < 1:
                continue
        except ValueError:
            continue
        desc_val = (form.get(f'description_{slot}') or '').strip()
        # Store under the real annotation number
        data[f'number_{num}']      = str(num)
        data[f'description_{num}'] = desc_val if desc_val else None

    data['name'] = name
    data.pop('cpid', None)
    return data


def _svg_inline_for_plan(plan_rel):
    """
    Lit le fichier SVG du plan et le prépare pour une injection INLINE
    dans plan.html : suppression de la déclaration XML et forçage de
    width="100%" height="100%" sur la balise racine <svg>.
    Un SVG inline reste vectoriel à l'impression (netteté A0).
    """
    if not plan_rel:
        return None
    path = os.path.join(app.root_path, 'static', plan_rel)
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            svg = f.read()
        # Retirer la déclaration XML (interdite en HTML inline)
        stripped = svg.lstrip()
        if stripped.startswith('<?xml'):
            svg = stripped.split('?>', 1)[1]
        # Forcer width/height à 100% UNIQUEMENT sur la balise racine <svg>
        def _fix_root(mo):
            tag = mo.group(0)
            tag = re.sub(r'\swidth="[^"]*"',  ' width="100%"',  tag, count=1)
            tag = re.sub(r'\sheight="[^"]*"', ' height="100%"', tag, count=1)
            return tag
        svg = re.sub(r'<svg\b[^>]*>', _fix_root, svg, count=1)
        return svg
    except Exception:
        return None


# ─── ROUTES ───────────────────────────────────────────────────────────────────

@app.route('/', methods=['GET'])
@app.route(f'{BASE_PATH}/', methods=['GET'])
def home():
    name_selected = request.args.get('name', '').strip()
    base          = base_url()
    conn  = get_db()
    rows  = conn.execute(f"SELECT DISTINCT name FROM {TABLE} ORDER BY name").fetchall()
    conn.close()
    names = [r['name'] for r in rows if r['name']]
    if name_selected and name_selected not in names:
        names.append(name_selected)
    return render_template('home.html', names=names,
                           name_selected=name_selected, base=base,
                           max_vue=MAX_VUE_ECLATEE)


@app.route('/check_poppler')
@app.route(f'{BASE_PATH}/check_poppler')
def check_poppler():
    """
    ✅ Page de DIAGNOSTIC : vérifie l'installation de Poppler (pdftocairo).
    Ouvrez http://<serveur>:5000/check_poppler dans le navigateur.
    """
    lines = ['<h2>Diagnostic Poppler / pdftocairo</h2><pre style="font-size:14px">']
    exe = _find_pdftocairo()
    for cand in PDFTOCAIRO_CANDIDATES:
        if os.path.sep in cand or (os.altsep and os.altsep in cand):
            status = '✅ TROUVÉ' if os.path.exists(cand) else '❌ absent'
        else:
            status = f'✅ TROUVÉ ({shutil.which(cand)})' if shutil.which(cand) else '❌ absent du PATH'
        lines.append(f'{status}  —  {cand}')
    lines.append('')
    if not exe:
        lines.append('❌ RÉSULTAT : pdftocairo INTROUVABLE.')
        lines.append('→ Installez Poppler : https://github.com/oschwartz10612/poppler-windows/releases')
        lines.append('→ Décompressez dans C:\\poppler puis rechargez cette page.')
        lines.append('→ Si votre chemin est différent, ajoutez-le dans PDFTOCAIRO_CANDIDATES (app.py).')
    else:
        lines.append(f'✅ Exécutable retenu : {exe}')
        try:
            r = subprocess.run([exe, '-v'], capture_output=True, timeout=15)
            ver = (r.stderr or r.stdout).decode(errors='replace').strip().splitlines()[0]
            lines.append(f'✅ Version : {ver}')
            lines.append('')
            lines.append('✅ TOUT EST BON : la conversion vectorielle fonctionnera.')
            lines.append('→ Re-uploadez le PDF de chaque fiche puis Mettre à jour.')
        except Exception as e:
            lines.append(f'❌ Exécution impossible : {e}')
    lines.append('</pre>')
    return '<br>'.join(lines)


@app.route('/convert_pdf', methods=['POST'])
@app.route(f'{BASE_PATH}/convert_pdf', methods=['POST'])
def convert_pdf():
    """
    ✅ Reçoit un PDF, rend la 1ère page en PNG (PDF_TARGET_WIDTH px de large)
    et retourne un data URL — UNIQUEMENT pour l'affichage éditeur/preview.
    Vérifie aussi que Poppler est disponible pour prévenir immédiatement
    l'utilisateur si la conversion vectorielle finale échouera.
    """
    file = request.files.get('pdf')
    if not file or not file.filename:
        return jsonify({'success': False, 'error': 'Aucun fichier PDF fourni'}), 400
    if not file.filename.lower().endswith('.pdf'):
        return jsonify({'success': False, 'error': 'Seuls les fichiers PDF sont acceptés'}), 400

    # ✅ Contrôle Poppler dès l'upload — échec immédiat et explicite
    if not _find_pdftocairo():
        return jsonify({'success': False, 'error':
                        "Poppler (pdftocairo) est INTROUVABLE sur le serveur — "
                        "l'impression A0 serait pixelisée. Ouvrez /check_poppler "
                        "pour le diagnostic et installez Poppler."}), 500

    tmp_path = os.path.join(app.config['UPLOAD_FOLDER'],
                            '_tmp_' + secure_filename(file.filename))
    try:
        file.save(tmp_path)
        png_bytes, w, h = _pdf_to_png_bytes(tmp_path)
        b64 = base64.b64encode(png_bytes).decode()
        return jsonify({'success': True,
                        'dataUrl': f'data:image/png;base64,{b64}',
                        'width': w, 'height': h})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.route('/add_fiche', methods=['POST'])
@app.route(f'{BASE_PATH}/add_fiche', methods=['POST'])
def add_fiche():
    name         = (request.form.get('name') or '').strip()
    previous_ref = request.form.get('previous_ref', '').strip()
    base         = base_url()

    if not name:
        flash('Le champ Name est obligatoire.', 'warning')
        return redirect(f'{base}/')

    conn = get_db()
    if conn.execute(f"SELECT id FROM {TABLE} WHERE name=?", (name,)).fetchone():
        flash(f"Le Name « {name} » existe déjà. Utilisez « Mettre à jour ».", 'danger')
        conn.close()
        return redirect(f'{base}/')

    prev_imgs = {}
    if previous_ref:
        prev = conn.execute(f"SELECT * FROM {TABLE} WHERE name=?", (previous_ref,)).fetchone()
        if prev:
            prev_imgs = dict(prev)

    data  = _collect(request.form, name)
    saved = request.form.get('plan_already_saved', '').strip()
    vf    = request.files.get('plan')

    try:
        if valid_svg_for_name(saved, name):
            data['plan'] = f'uploads/{saved}'
        elif vf and vf.filename.strip():
            data['plan'] = make_svg(vf, name=name)
        else:
            old = prev_imgs.get('plan')
            data['plan'] = copy_svg(old, name) if old else None
    except Exception as e:
        conn.close()
        flash(f"Erreur conversion du plan : {e}", 'danger')
        return redirect(f'{base}/')

    data['plan_count'] = count_vue_eclatee(data)

    try:
        nums = [k.split('_', 1)[1] for k in data
                if k.startswith('number_') or k.startswith('description_')]
        if nums:
            ensure_columns(conn, list(set(nums)))
        data = {k: v for k, v in data.items() if v is not None}
        cols = ', '.join(data.keys())
        ph   = ', '.join(['?'] * len(data))
        conn.execute(f'INSERT INTO {TABLE} ({cols}) VALUES ({ph})', list(data.values()))
        conn.commit()
        flash(f"Name « {name} » ajouté !", 'success')
    except Exception as e:
        conn.rollback()
        flash(f"Erreur ajout : {e}", 'danger')
    finally:
        conn.close()

    return redirect(f'{base}/?name={name}')


@app.route('/get_fiche/<name>')
@app.route(f'{BASE_PATH}/get_fiche/<name>')
def get_fiche(name):
    conn = get_db()
    row  = conn.execute(f"SELECT * FROM {TABLE} WHERE name=?", (name,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Name introuvable'}), 404
    return jsonify({'fr': dict(row), 'en': None, 'nl': None})


@app.route('/update_fiche', methods=['POST'])
@app.route(f'{BASE_PATH}/update_fiche', methods=['POST'])
def update_fiche():
    name = (request.form.get('updateRef') or '').strip()
    base = base_url()

    if not name:
        flash('Sélectionnez un Name à mettre à jour.', 'warning')
        return redirect(f'{base}/')

    conn     = get_db()
    existing = conn.execute(f"SELECT * FROM {TABLE} WHERE name=?", (name,)).fetchone()
    if not existing:
        flash('Name introuvable.', 'danger')
        conn.close()
        return redirect(f'{base}/')

    data  = _collect(request.form, name)
    saved = request.form.get('plan_already_saved', '').strip()
    vf    = request.files.get('plan')

    try:
        if request.form.get('delete_plan') == 'true':
            data['plan'] = None
        elif valid_svg_for_name(saved, name):
            data['plan'] = f'uploads/{saved}'
        elif vf and vf.filename.strip():
            data['plan'] = make_svg(vf, name=name)
        else:
            data['plan'] = existing['plan']
    except Exception as e:
        conn.close()
        flash(f"Erreur conversion du plan : {e}", 'danger')
        return redirect(f'{base}/?name={name}')

    data['plan_count'] = count_vue_eclatee(data)

    try:
        nums = [k.split('_', 1)[1] for k in data
                if k.startswith('number_') or k.startswith('description_')]
        if nums:
            ensure_columns(conn, list(set(nums)))

        existing_cols = _existing_columns(conn)
        null_cols = [
            c for c in existing_cols
            if (c.startswith('number_') or c.startswith('description_'))
            and c not in data
        ]
        for col in null_cols:
            data[col] = None

        set_clause = ', '.join([f'{k}=?' for k in data])
        conn.execute(f"UPDATE {TABLE} SET {set_clause} WHERE name=?",
                     list(data.values()) + [name])
        conn.commit()
        flash(f"Name « {name} » mis à jour !", 'success')
    except Exception as e:
        conn.rollback()
        flash(f"Erreur mise à jour : {e}", 'danger')
    finally:
        conn.close()

    return redirect(f'{base}/?name={name}')


@app.route('/delete_fiche', methods=['POST'])
@app.route(f'{BASE_PATH}/delete_fiche', methods=['POST'])
def delete_fiche():
    name = (request.form.get('deleteRef') or '').strip()
    base = base_url()
    if not name:
        flash('Sélectionnez un Name à supprimer.', 'warning')
        return redirect(f'{base}/')
    try:
        conn = get_db()
        conn.execute(f"DELETE FROM {TABLE} WHERE name=?", (name,))
        conn.commit()
        conn.close()
        flash(f"Name « {name} » supprimé !", 'success')
    except Exception as e:
        flash(f"Erreur suppression : {e}", 'danger')
    return redirect(f'{base}/')


@app.route('/get_source_image/<filename>')
@app.route(f'{BASE_PATH}/get_source_image/<filename>')
def get_source_image(filename):
    sf   = secure_filename(filename)
    path = os.path.join(app.config['UPLOAD_FOLDER'], sf)
    if not sf.lower().endswith('.svg'):
        return 'Not an SVG', 404
    if not os.path.exists(path):
        return 'SVG not found', 404
    try:
        root = ET.parse(path).getroot()
        img  = (root.find('.//{http://www.w3.org/2000/svg}image[@id="source-image"]')
                or root.find('.//image[@id="source-image"]'))
        if img is None:
            return 'source-image not found', 404
        href = img.get('href') or img.get('{http://www.w3.org/1999/xlink}href') or ''
        if not href.startswith('data:'):
            return 'No embedded data URI', 404
        header, b64 = href.split(',', 1)
        mime = header.split(':')[1].split(';')[0]
        return Response(base64.b64decode(b64), mimetype=mime,
                        headers={'Cache-Control': 'no-cache'})
    except Exception as e:
        return f'Error: {e}', 500


@app.route('/get_svg_annotations/<path:filename>')
@app.route(f'{BASE_PATH}/get_svg_annotations/<path:filename>')
def get_svg_annotations(filename):
    if not filename.lower().endswith('.svg'):
        return jsonify({'annotations': []}), 200
    path = os.path.join(app.root_path, 'static', filename)
    if not os.path.exists(path):
        return jsonify({'annotations': []}), 200
    try:
        root = ET.parse(path).getroot()
        ns   = {'svg': 'http://www.w3.org/2000/svg'}
        anns = []
        grp  = root.find('.//svg:g[@id="annotations"]', ns)
        if grp is not None:
            for g in grp.findall('svg:g', ns):
                aid = g.get('data-id')
                ax  = g.get('data-x')
                ay  = g.get('data-y')
                sd  = g.get('data-side')
                alx = g.get('data-lx')
                aly = g.get('data-ly')
                if aid and ax and ay and sd:
                    ann = {'id': int(aid), 'x': float(ax), 'y': float(ay), 'side': sd}
                    if alx and aly:
                        ann['labelX'] = float(alx)
                        ann['labelY'] = float(aly)
                    asz = g.get('data-size')
                    if asz:
                        ann['annotationSize'] = float(asz)
                    adesc = g.get('data-desc')
                    if adesc:
                        ann['description'] = adesc
                    anns.append(ann)
        vb = root.get('viewBox', '0 0 700 900').split()
        try:
            w, h = float(vb[2]), float(vb[3])
        except Exception:
            w, h = 700, 900
        return jsonify({'annotations': anns, 'width': w, 'height': h})
    except Exception as e:
        return jsonify({'error': str(e), 'annotations': []}), 200


@app.route('/save_annotations', methods=['POST'])
@app.route(f'{BASE_PATH}/save_annotations', methods=['POST'])
def save_annotations():
    data     = request.json
    svg_file = data['filename']
    path     = os.path.join(app.config['UPLOAD_FOLDER'], svg_file)
    if not os.path.exists(path):
        return jsonify({'success': False, 'error': 'SVG not found'}), 404
    ET.register_namespace('',      'http://www.w3.org/2000/svg')
    ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
    try:
        tree = ET.parse(path)
        inject_annotations(tree.getroot(), data['annotations'])
        # ✅ FIX: utf-8 au lieu de unicode — évite l'encoding error dans le navigateur
        tree.write(path, encoding='utf-8', xml_declaration=True)
        return jsonify({'success': True, 'image_path': f'uploads/{svg_file}'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/create_exploded_view', methods=['POST'])
@app.route(f'{BASE_PATH}/create_exploded_view', methods=['POST'])
def create_exploded_view():
    file = request.files.get('plan')
    name = (request.form.get('name') or request.form.get('cpid') or '').strip()
    base = base_url()
    if not file or not file.filename:
        return jsonify({'error': 'No file provided'}), 400
    try:
        svg = make_svg(file, name=name or None)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    if not svg:
        return jsonify({'error': 'SVG creation failed'}), 500
    fn = svg.split('/')[-1]
    return jsonify({'success': True, 'redirect': f'{base}/editor/{fn}', 'filename': fn})


@app.route('/create_exploded_view_with_annotations', methods=['POST'])
@app.route(f'{BASE_PATH}/create_exploded_view_with_annotations', methods=['POST'])
def create_exploded_view_with_annotations():
    file = request.files.get('plan')
    name = (request.form.get('name') or request.form.get('cpid') or '').strip()
    anns = []
    try:
        anns = _json.loads(request.form.get('annotations', '[]'))
    except Exception:
        pass
    if not file or not file.filename:
        return jsonify({'error': 'No file provided'}), 400
    try:
        svg = make_svg(file, name=name or None)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    if not svg:
        return jsonify({'error': 'SVG creation failed'}), 500
    fn   = svg.split('/')[-1]
    path = os.path.join(app.config['UPLOAD_FOLDER'], fn)
    if anns:
        ET.register_namespace('',      'http://www.w3.org/2000/svg')
        ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
        try:
            tree = ET.parse(path)
            inject_annotations(tree.getroot(), anns)
            # ✅ FIX: utf-8 au lieu de unicode — évite l'encoding error dans le navigateur
            tree.write(path, encoding='utf-8', xml_declaration=True)
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    return jsonify({'success': True, 'filename': fn, 'image_path': f'uploads/{fn}'})


@app.route('/index')
@app.route(f'{BASE_PATH}/index')
def index():
    name = (request.args.get('name') or request.args.get('cpid') or '').strip()
    base = base_url()
    if not name:
        return 'Name introuvable', 404
    conn = get_db()
    row  = conn.execute(f"SELECT * FROM {TABLE} WHERE name=?", (name,)).fetchone()
    conn.close()
    if not row:
        return 'Référence introuvable', 404
    fiche = dict(row)
    # ✅ SVG inline pour impression A0 nette (vectoriel de bout en bout)
    svg_inline = _svg_inline_for_plan(fiche.get('plan'))
    return render_template('plan.html', fiche=fiche, base=base,
                           svg_inline=svg_inline)


@app.template_filter('date')
def date_filter(value, format='%Y-%m-%d'):
    if value == "now":
        return datetime.now().strftime(format)
    return value


@app.template_filter('remove_last_part')
def remove_last_part(v):
    return '_'.join(v.split('_')[:-1]) if v else ''


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=True)