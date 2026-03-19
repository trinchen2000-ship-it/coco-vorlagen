# Coco Colours – Vorlagen Upload

Kunden-Upload-Portal für Referenzbilder & Nachrichten.
Speichert direkt in Dropbox mit automatischer Ordnerstruktur.

## Ordnerstruktur in Dropbox

```
Vorlagen/
  März 2026/
    Trine/
      2026-03-28_Müller_Jana/
        referenz.jpg
        referenz_notiz.txt
        Nachricht_2026-03-28T12-00-00.txt
```

## Setup auf Railway

### 1. Dropbox App erstellen
- https://www.dropbox.com/developers/apps
- „Create app" → Scoped access → Full Dropbox
- Unter „Permissions": `files.content.write` aktivieren
- Unter „Settings": „Generate access token" klicken → Token kopieren

### 2. Projekt auf Railway deployen
- GitHub Repo erstellen, diesen Ordner hochladen
- Railway → New Project → Deploy from GitHub Repo
- Unter „Variables" eintragen:
  - `DROPBOX_TOKEN` = dein Token von Schritt 1

### 3. Fertig
Railway gibt dir eine URL — die kannst du direkt an Kunden schicken.

## Lokaler Test
```
npm install
DROPBOX_TOKEN=dein_token node server.js
```
Dann: http://localhost:3000
