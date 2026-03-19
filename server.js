const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const cron    = require('node-cron');
const path    = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Umgebungsvariablen ───────────────────────────────────────
const DROPBOX_APP_KEY    = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
let   DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || null;
let   cachedAccessToken  = null;
let   tokenExpiresAt     = 0;

// ── Access Token holen (automatisch erneuern) ────────────────
async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  if (!DROPBOX_REFRESH_TOKEN) throw new Error('Kein Refresh-Token — bitte /auth aufrufen');

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id:     DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token-Refresh fehlgeschlagen: ' + JSON.stringify(data));

  cachedAccessToken = data.access_token;
  tokenExpiresAt    = Date.now() + (data.expires_in * 1000);
  console.log('[Auth] ✓ Access Token erneuert');
  return cachedAccessToken;
}

// ── Erlaubte Dateitypen (Whitelist) ──────────────────────────
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.pdf'
]);

// Prüft Dateiendung (MIME-Typ kann gefälscht werden, Endung reicht hier)
function isAllowedFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function checkFiles(files) {
  const blocked = files.filter(f => !isAllowedFile(f.originalname));
  return blocked.length > 0
    ? `Nicht erlaubte Dateitypen: ${blocked.map(f => path.extname(f.originalname) || f.originalname).join(', ')}. Erlaubt: JPG, PNG, GIF, WEBP, HEIC, PDF`
    : null;
}

// ── Monatsnamen ──────────────────────────────────────────────
const MONATE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember'
];

// ── Pfad-Helfer ──────────────────────────────────────────────
function getMonatOrdner(datumStr) {
  const d = new Date(datumStr + 'T12:00:00');
  return `${MONATE[d.getMonth()]} ${d.getFullYear()}`;
}

function getKundenOrdner(vorname, nachname, datumStr) {
  const d = new Date(datumStr + 'T12:00:00');
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  // Normalisiert: Kleinbuchstaben → Groß-/Kleinschreibung egal
  const norm  = s => s.trim().toLowerCase().replace(/[^a-z0-9äöüß\-_]/g, '_');
  return `${year}-${month}-${day}_${norm(nachname)}_${norm(vorname)}`;
}

function safeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

function nowDE() {
  return new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

// ── Dropbox API ──────────────────────────────────────────────
async function dropboxRequest(buffer, dropboxPath, mode) {
  const token  = await getAccessToken();
  const apiArg = JSON.stringify({ path: dropboxPath, mode, autorename: mode === 'add', mute: false });
  console.log(`[Dropbox] Upload → ${dropboxPath} (mode: ${mode})`);
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Content-Type':    'application/octet-stream',
      'Dropbox-API-Arg': apiArg
    },
    body: buffer
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Dropbox] Fehler ${res.status}: ${body}`);
    throw new Error(`Dropbox ${res.status}: ${body}`);
  }
  console.log(`[Dropbox] ✓ Erfolgreich: ${dropboxPath}`);
  return JSON.parse(body);
}

// Für Bilddateien: add + autorename (nie überschreiben)
async function dropboxUploadNew(buffer, dropboxPath) {
  return dropboxRequest(buffer, dropboxPath, 'add');
}

// Für Textdateien (_info.txt, _notiz.txt): overwrite
async function dropboxUpload(buffer, dropboxPath) {
  return dropboxRequest(buffer, dropboxPath, 'overwrite');
}

async function dropboxListFolder(folderPath) {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath, recursive: false })
  });
  if (!res.ok) {
    const err = await res.text();
    if (err.includes('not_found') || err.includes('path/not_found')) return [];
    throw new Error(`Dropbox List: ${err}`);
  }
  return (await res.json()).entries || [];
}

async function dropboxDelete(dropboxPath) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dropboxPath })
  });
  if (!res.ok) throw new Error(`Dropbox Delete: ${await res.text()}`);
  return res.json();
}

async function dropboxDownloadText(dropboxPath) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${await getAccessToken()}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath })
    }
  });
  if (!res.ok) return null;
  return res.text();
}

// ── _info.txt aktualisieren ───────────────────────────────────
async function updateInfoFile(basePath, vorname, nachname, datum, artist, uploads) {
  const infoPath = `${basePath}/_info.txt`;
  let existing   = await dropboxDownloadText(infoPath) || '';

  const lines = [`📅 ${nowDE()}`];
  uploads.forEach(u => {
    if (u.type === 'file') {
      lines.push(`   ${u.name}`);
      if (u.note && u.note.trim())
        lines.push(`   → Notiz: "${u.note.replace(/\n/g, ' ')}"`);
    } else if (u.type === 'nachricht') {
      lines.push(`   💬 Nachricht: "${u.text.replace(/\n/g, ' ')}"`);
    }
  });
  const newEntry = lines.join('\n');

  let content;
  if (!existing.trim()) {
    content = [
      `╔══════════════════════════════════════════════╗`,
      `║  Coco Colours · Vorlagen-Übersicht           ║`,
      `╚══════════════════════════════════════════════╝`,
      ``,
      `Kunde    : ${vorname} ${nachname}`,
      `Termin   : ${datum}`,
      `Artist   : ${artist}`,
      ``,
      `── Uploads ─────────────────────────────────────`,
      ``,
      newEntry
    ].join('\n');
  } else {
    content = existing
      .replace(/\n── Zuletzt aktualisiert:.*──\s*$/s, '')
      .trimEnd() + '\n\n' + newEntry;
  }

  content += `\n\n── Zuletzt aktualisiert: ${nowDE()} ──`;
  await dropboxUpload(Buffer.from(content, 'utf8'), infoPath);
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Route: Upload mit Bildern ────────────────────────────────
app.post('/api/upload', upload.array('files'), async (req, res) => {
  try {
    const { vorname, nachname, datum, artist } = req.body;
    let notes = {};
    try { notes = JSON.parse(req.body.notes || '{}'); } catch {}

    if (!vorname || !nachname || !datum || !artist)
      return res.status(400).json({ success: false, error: 'Fehlende Pflichtfelder.' });
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ success: false, error: 'Keine Dateien empfangen.' });

    const typeError = checkFiles(req.files);
    if (typeError) return res.status(400).json({ success: false, error: typeError });

    const allgNotiz = (req.body.allgNotiz || '').trim();
    const base = `/Vorlagen/${getMonatOrdner(datum)}/${artist}/${getKundenOrdner(vorname, nachname, datum)}`;
    const uploadedItems = [];

    // Allgemeine Notiz als eigene Datei speichern
    if (allgNotiz) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const notizContent = [
        `Von      : ${vorname} ${nachname}`,
        `Termin   : ${datum}`,
        `Artist   : ${artist}`,
        `Eingang  : ${nowDE()}`,
        ``,
        `── Allgemeine Notiz ───────────────────`,
        allgNotiz
      ].join('\n');
      await dropboxUpload(Buffer.from(notizContent, 'utf8'), `${base}/Notiz_${ts}.txt`);
      uploadedItems.push({ type: 'nachricht', text: allgNotiz });
    }

    for (const file of req.files) {
      const fname = safeFilename(file.originalname);
      await dropboxUploadNew(file.buffer, `${base}/${fname}`);  // add+autorename: nie überschreiben

      const note = notes[file.originalname];
      if (note && note.trim()) {
        const notizText = [
          `Datei   : ${file.originalname}`,
          `Datum   : ${datum}`,
          `Kunde   : ${vorname} ${nachname}`,
          `Artist  : ${artist}`,
          ``, `── Notiz ──────────────────────────────`,
          note.trim()
        ].join('\n');
        await dropboxUpload(
          Buffer.from(notizText, 'utf8'),
          `${base}/${fname.replace(/\.[^.]+$/, '')}_notiz.txt`
        );
      }

      uploadedItems.push({ type: 'file', name: file.originalname, note: note || '' });
    }

    await updateInfoFile(base, vorname, nachname, datum, artist, uploadedItems);
    res.json({ success: true });

  } catch (e) {
    console.error('Upload-Fehler:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Route: Nur Nachricht ─────────────────────────────────────
app.post('/api/nachricht', async (req, res) => {
  try {
    const { vorname, nachname, datum, artist, nachricht } = req.body;

    if (!vorname || !nachname || !datum || !artist || !nachricht?.trim())
      return res.status(400).json({ success: false, error: 'Fehlende Pflichtfelder.' });

    const base = `/Vorlagen/${getMonatOrdner(datum)}/${artist}/${getKundenOrdner(vorname, nachname, datum)}`;
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const content = [
      `Von      : ${vorname} ${nachname}`,
      `Termin   : ${datum}`,
      `Artist   : ${artist}`,
      `Eingang  : ${nowDE()}`,
      ``, `── Nachricht ──────────────────────────`,
      nachricht.trim()
    ].join('\n');

    await dropboxUpload(Buffer.from(content, 'utf8'), `${base}/Nachricht_${ts}.txt`);
    await updateInfoFile(base, vorname, nachname, datum, artist,
      [{ type: 'nachricht', text: nachricht.trim() }]);

    res.json({ success: true });

  } catch (e) {
    console.error('Nachricht-Fehler:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── OAuth2 Setup (einmalig aufrufen) ─────────────────────────
const REDIRECT_URI = 'https://coco-vorlagen-production.up.railway.app/auth/callback';

app.get('/auth', (req, res) => {
  console.log('[Auth] redirect_uri:', REDIRECT_URI);
  const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
    client_id:         DROPBOX_APP_KEY,
    response_type:     'code',
    token_access_type: 'offline',
    redirect_uri:      REDIRECT_URI
  });
  console.log('[Auth] Vollständige URL:', url);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Fehler: Kein Code erhalten.');

  try {
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type:    'authorization_code',
        client_id:     DROPBOX_APP_KEY,
        client_secret: DROPBOX_APP_SECRET,
        redirect_uri:  REDIRECT_URI
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) return res.send('Fehler: ' + JSON.stringify(data));

    DROPBOX_REFRESH_TOKEN = data.refresh_token;
    cachedAccessToken     = data.access_token;
    tokenExpiresAt        = Date.now() + (data.expires_in * 1000);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee">
        <h2 style="color:#c9a84c">✓ Dropbox verbunden!</h2>
        <p>Trage diesen Refresh-Token als Railway-Variable ein:</p>
        <p><strong>Name:</strong> DROPBOX_REFRESH_TOKEN</p>
        <p><strong>Wert:</strong></p>
        <textarea style="width:100%;padding:10px;background:#222;color:#fff;border:1px solid #555;font-size:12px" rows="3">${data.refresh_token}</textarea>
        <p style="color:#aaa;margin-top:20px">Danach DROPBOX_TOKEN Variable in Railway löschen — wird nicht mehr benötigt.</p>
      </body></html>
    `);
  } catch(e) {
    res.send('Fehler: ' + e.message);
  }
});

// ── Test Dropbox ─────────────────────────────────────────────
app.get('/test-dropbox', async (req, res) => {
  try {
    const token = await getAccessToken();
    // Test: kleinen Text hochladen
    const testRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization':   `Bearer ${token}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: '/Vorlagen/test_verbindung.txt', mode: 'overwrite' })
      },
      body: Buffer.from('Verbindungstest ' + new Date().toISOString())
    });
    const body = await testRes.text();
    res.send(`<pre>Status: ${testRes.status}\n\nAntwort:\n${body}\n\nToken (erste 20 Zeichen): ${token.slice(0,20)}...</pre>`);
  } catch(e) {
    res.send(`<pre>Fehler: ${e.message}</pre>`);
  }
});

// ── Healthcheck ──────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ════════════════════════════════════════════════════════════
//  AUTO-CLEANUP — täglich 03:00 Uhr, löscht nach 6 Monaten
// ════════════════════════════════════════════════════════════

function parseDatumAusOrdner(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`) : null;
}

function aelterAlsSechsMonate(datum) {
  // Sicherer als setMonth() — vermeidet Feb/März Edge-Case bei Monatsletzten
  const SECHS_MONATE_MS = 6 * 30.4375 * 24 * 60 * 60 * 1000; // ~6 Monate in ms
  return (Date.now() - datum.getTime()) > SECHS_MONATE_MS;
}

async function runCleanup() {
  if (!DROPBOX_TOKEN) return;
  console.log(`\n[Cleanup] ▶ Start: ${nowDE()}`);
  let geloescht = 0, fehler = 0;

  try {
    const monatsOrdner = await dropboxListFolder('/Vorlagen');

    for (const monat of monatsOrdner) {
      if (monat['.tag'] !== 'folder') continue;
      const artistOrdner = await dropboxListFolder(monat.path_lower);

      for (const artist of artistOrdner) {
        if (artist['.tag'] !== 'folder') continue;
        const kundenOrdner = await dropboxListFolder(artist.path_lower);

        for (const kunde of kundenOrdner) {
          if (kunde['.tag'] !== 'folder') continue;
          const terminDatum = parseDatumAusOrdner(kunde.name);
          if (!terminDatum || !aelterAlsSechsMonate(terminDatum)) continue;

          try {
            await dropboxDelete(kunde.path_lower);
            console.log(`[Cleanup] ✓ ${kunde.path_display}`);
            geloescht++;
          } catch (e) {
            console.error(`[Cleanup] ✗ ${kunde.path_display} — ${e.message}`);
            fehler++;
          }
        }

        // Leeren Artist-Ordner aufräumen
        const rest = await dropboxListFolder(artist.path_lower);
        if (rest.length === 0) await dropboxDelete(artist.path_lower).catch(() => {});
      }

      // Leeren Monatsordner aufräumen
      const rest = await dropboxListFolder(monat.path_lower);
      if (rest.length === 0) await dropboxDelete(monat.path_lower).catch(() => {});
    }

  } catch (e) {
    console.error('[Cleanup] Allgemeiner Fehler:', e.message);
  }

  console.log(`[Cleanup] ■ Fertig — ${geloescht} gelöscht, ${fehler} Fehler.\n`);
}

// Täglich 03:00 Uhr Berliner Zeit
cron.schedule('0 3 * * *', runCleanup, { timezone: 'Europe/Berlin' });

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Vorlagen-Upload läuft auf Port ${PORT}`);
  console.log(`✓ Auto-Cleanup: täglich 03:00 Uhr (6 Monate nach Termindatum)`);
  if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET) console.warn('⚠ WARNUNG: DROPBOX_APP_KEY oder DROPBOX_APP_SECRET fehlt!');
  if (!DROPBOX_REFRESH_TOKEN) console.warn('⚠ Noch kein Refresh-Token — bitte /auth aufrufen!');
  else console.log('✓ Dropbox Refresh-Token vorhanden');
});
