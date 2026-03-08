"""
LLDPviz Flask API server.

Serves the static frontend and provides a share API backed by SQLite.
Each shared site gets a UUID. Multiple revisions can be saved per site.
"""

import os
import uuid
import json
import sqlite3
from datetime import datetime, timezone

from flask import Flask, request, jsonify, send_from_directory, g

app = Flask(__name__, static_folder='.', static_url_path='')

DATABASE = os.environ.get('LLDPVIZ_DB', 'lldpviz.db')


def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA journal_mode=WAL')
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.executescript('''
        CREATE TABLE IF NOT EXISTS shared_sites (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL REFERENCES shared_sites(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(site_id, revision)
        );
    ''')
    db.close()


# ── Static files ──────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


# ── Share API ─────────────────────────────────────────────────────

@app.route('/api/share', methods=['POST'])
def create_share():
    """Create a new shared site. Returns the UUID."""
    body = request.get_json(silent=True)
    if not body or 'data' not in body:
        return jsonify(error='Missing "data" field'), 400

    data = body['data']
    if isinstance(data, dict):
        name = data.get('name', '')
    else:
        name = ''

    site_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    db = get_db()
    db.execute(
        'INSERT INTO shared_sites (id, name, created_at) VALUES (?, ?, ?)',
        (site_id, name, now),
    )
    db.execute(
        'INSERT INTO revisions (site_id, revision, data, created_at) VALUES (?, 1, ?, ?)',
        (site_id, json.dumps(data, ensure_ascii=False), now),
    )
    db.commit()

    return jsonify(uuid=site_id, revision=1), 201


@app.route('/api/share/<site_id>', methods=['GET'])
def get_share(site_id):
    """Get a shared site. ?rev=N for a specific revision, otherwise latest."""
    db = get_db()

    site = db.execute(
        'SELECT * FROM shared_sites WHERE id = ?', (site_id,)
    ).fetchone()
    if not site:
        return jsonify(error='Not found'), 404

    rev_param = request.args.get('rev')
    if rev_param:
        row = db.execute(
            'SELECT * FROM revisions WHERE site_id = ? AND revision = ?',
            (site_id, int(rev_param)),
        ).fetchone()
    else:
        row = db.execute(
            'SELECT * FROM revisions WHERE site_id = ? ORDER BY revision DESC LIMIT 1',
            (site_id,),
        ).fetchone()

    if not row:
        return jsonify(error='Revision not found'), 404

    revisions = db.execute(
        'SELECT revision, created_at FROM revisions WHERE site_id = ? ORDER BY revision DESC',
        (site_id,),
    ).fetchall()

    return jsonify(
        uuid=site_id,
        name=site['name'],
        revision=row['revision'],
        data=json.loads(row['data']),
        created_at=row['created_at'],
        revisions=[
            {'revision': r['revision'], 'created_at': r['created_at']}
            for r in revisions
        ],
    )


@app.route('/api/share/<site_id>', methods=['POST'])
def save_revision(site_id):
    """Save a new revision to an existing shared site."""
    db = get_db()

    site = db.execute(
        'SELECT * FROM shared_sites WHERE id = ?', (site_id,)
    ).fetchone()
    if not site:
        return jsonify(error='Not found'), 404

    body = request.get_json(silent=True)
    if not body or 'data' not in body:
        return jsonify(error='Missing "data" field'), 400

    data = body['data']
    now = datetime.now(timezone.utc).isoformat()

    last_rev = db.execute(
        'SELECT MAX(revision) as max_rev FROM revisions WHERE site_id = ?',
        (site_id,),
    ).fetchone()
    next_rev = (last_rev['max_rev'] or 0) + 1

    if isinstance(data, dict):
        name = data.get('name', site['name'])
    else:
        name = site['name']

    db.execute(
        'UPDATE shared_sites SET name = ? WHERE id = ?',
        (name, site_id),
    )
    db.execute(
        'INSERT INTO revisions (site_id, revision, data, created_at) VALUES (?, ?, ?, ?)',
        (site_id, next_rev, json.dumps(data, ensure_ascii=False), now),
    )
    db.commit()

    return jsonify(uuid=site_id, revision=next_rev), 201


# ── Boot ──────────────────────────────────────────────────────────

with app.app_context():
    init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug)
