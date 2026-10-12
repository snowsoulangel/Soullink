# Soul Link Tracker für Pokémon Infinite Fusion

Live-Tracking für Soul-Link-Runs zu zweit:

- **Automatische Links:** Fängst du auf Route 1 ein Rattfratz und dein Kumpel dort ein Pikachu, werden die beiden automatisch verlinkt.
- **Live-KP, Level und Team** im OBS-Overlay, bei jedem Pokémon auch mit seinem Partner.
- **Tode werden automatisch erkannt.** Fällt ein Pokémon auf 0 KP, ist es tot. Der Partner wird markiert, und der Todeszähler zählt hoch.
- **Todesursache:** Die Mod merkt sich, von welchem Pokémon (Level, Attacke) und welchem Trainer ein Pokémon besiegt wurde, bzw. Gift/Verbrennung.
- **Kill-Counter:** Wer ein Pokémon verliert, bekommt es und jeden mitgerissenen Partner angerechnet (jedes Pokémon einmal, eine Fusion zählt als ein Pokémon).
- **Titel:** Die Run-Seite heißt automatisch nach den Trainernamen aus dem Spiel, z. B. „Artur & Tim“.
- **Run-Seite** mit Teams, allen Links, Friedhof und Ereignis-Log, auch für Zuschauer.
- **Fusionen:** Ein fusioniertes Pokémon behält beide Links. Nach dem Entfusionieren bekommen beide Teile ihren Link zurück.
- **Echte Sprites aus dem Spiel:** Overlay und Run-Seite zeigen genau den Sprite, den das Spiel gerade anzeigt, inklusive gewähltem Alt-Sprite und Shiny-Färbung.

```
 Spieler 1: Infinite Fusion + Mod ──► state.json ──► Hilfsprogramm ──┐
                                                                      ├──► Server (Cloudflare, kostenlos)
 Spieler 2: Infinite Fusion + Mod ──► state.json ──► Hilfsprogramm ──┘        │
                                                                              ├──► OBS-Overlays (live)
                                                                              └──► Run-Seite (live)
```

Getestet gegen den Quellcode von **Infinite Fusion 6.7 und 6.8.2** (Kanto und Hoenn).

---

## 1. Server einrichten (einmalig, nur einer von euch)

Der Server läuft kostenlos bei Cloudflare. Ihr braucht dafür keine Kreditkarte.

### Variante A: per Klick über GitHub (empfohlen)

1. Kostenloses Konto auf <https://dash.cloudflare.com/sign-up> anlegen.
2. Im Dashboard links **Compute (Workers) → Workers & Pages** öffnen und dann **Erstellen / Create** klicken.
3. **„Import a repository“ / „Repository importieren“** wählen, GitHub verbinden und dieses Repository (`Soullink`) auswählen.
4. Einstellungen:
   - **Projektname:** `soullink`. Der Name muss genau so heißen wie `name` in `wrangler.jsonc`.
   - **Branch:** der Branch, auf dem dieser Code liegt, zum Beispiel `main`.
   - **Build-/Deploy-Befehl:** Standard lassen (`npx wrangler deploy`).
5. **Deploy** klicken. Nach etwa einer Minute bekommt ihr eine Adresse wie
   `https://soullink.<dein-name>.workers.dev`. Das ist eure **Server-Adresse**.

Bei jedem neuen Commit auf dem Branch aktualisiert Cloudflare den Server automatisch.

### Variante B: per Kommandozeile

Dafür braucht ihr [Node.js](https://nodejs.org) (LTS):

```bash
npm install
npx wrangler login
npx wrangler deploy
```

### Optional: Passwort zum Erstellen von Runs

Ohne Passwort kann jeder, der eure Server-Adresse kennt, dort einen neuen Run anlegen. Fremde Runs verändern kann er nicht.
Wenn ihr das verhindern wollt, setzt in Cloudflare unter **Worker → Einstellungen → Variablen und Geheimnisse** die Variable `CREATE_PASSWORD`.

---

## 2. Run erstellen

1. Die Server-Adresse im Browser öffnen und auf **„Run erstellen“** klicken.
2. Ihr bekommt einen **Link zur Run-Seite** und für jeden Spieler einen **Konfigurations-Block** mit `SERVER`, `ROOM`, `PLAYER` und `KEY`.
3. Jeder speichert seinen Block. **Die Schlüssel sind geheim.** Zeigt sie nicht im Stream, sonst kann jemand eure Daten ändern.

Auf der Run-Seite kommt man mit dem Schlüssel später unter **Einstellungen → Meine config.txt anzeigen** wieder an den eigenen Block.

---

## 3. Mod und Hilfsprogramm installieren (jeder Spieler)

1. Dieses Repository als ZIP herunterladen (**Code → Download ZIP**) und entpacken.
2. Den **Spielordner** von Infinite Fusion öffnen, also den Ordner mit `Game.exe` bzw. `InfiniteFusion.exe` und dem Ordner `Data`.
3. Zwei Ordner aus dem ZIP hineinkopieren:

   | aus dem ZIP | in den Spielordner nach |
   |---|---|
   | `game/Data/Scripts/998_SoulLinkTracker` | `Data/Scripts/998_SoulLinkTracker` |
   | `game/SoulLink` | `SoulLink` |

   Danach sieht es so aus:

   ```
   InfiniteFusion/
   ├── Game.exe
   ├── Data/
   │   └── Scripts/
   │       ├── 001_Settings.rb
   │       ├── ...
   │       └── 998_SoulLinkTracker/
   │           └── 001_SoulLinkTracker.rb
   └── SoulLink/
       ├── config.txt
       ├── helper.ps1
       └── start.bat
   ```

   > ⚠️ Legt **keine anderen Dateien** in `Data/Scripts/998_SoulLinkTracker`, auch keine Notizen oder README. Das Spiel lädt jede Datei in diesem Ordner als Code.

4. `SoulLink/config.txt` öffnen, den Inhalt durch **deinen** Block von der Run-Seite ersetzen und speichern.
5. **`SoulLink/start.bat`** doppelklicken. Es öffnet sich ein Fenster, das während des Spielens offen bleibt.
   Falls Windows SmartScreen warnt: **„Weitere Informationen → Trotzdem ausführen“**.
6. Spiel starten und Spielstand laden. Im Fenster erscheint nach ein paar Sekunden `gesendet: 6 im Team, …`.

Beim nächsten Mal reicht: `start.bat` starten, dann das Spiel.

> **Nach Spiel-Updates:** Prüft, ob `Data/Scripts/998_SoulLinkTracker` noch da ist, und kopiert den Ordner sonst neu hinein.
> Eure Links gehen dabei nicht verloren. Sie sind im Spielstand und auf dem Server gespeichert.

---

## 4. OBS einrichten

Auf der Run-Seite unter **OBS** stehen alle Overlay-Links zum Kopieren. In OBS geht ihr so vor:
**Quelle hinzufügen → Browser**, URL einfügen, Breite und Höhe wie angegeben einstellen. Der Hintergrund ist transparent.

| Overlay | URL-Zusatz |
|---|---|
| Mein Team mit Partnern (nebeneinander) | `overlay.html?room=…&player=1` |
| Mein Team untereinander (für den Bildschirmrand) | `…&layout=column` |
| Beide Teams | `…&view=both&partner=0` |
| Todeszähler | `…&view=deaths` |

Weitere Optionen: `&scale=0.8` zum Verkleinern, `&partner=0` ohne Partner-Zeile und `&label=1` mit Spielernamen.

---

## 5. So funktioniert das Verlinken

- Die Mod gibt jedem Pokémon beim ersten Sehen eine unsichtbare Markierung mit seiner **Fang-Route**. Das ist der Ort, den das Spiel auch in der Pokémon-Übersicht anzeigt.
- **Das erste Pokémon pro Route** zählt als Begegnung. Haben beide Spieler auf derselben Route ihre Begegnung, sind die zwei gelinkt.
- **Gescheiterte Begegnungen werden automatisch erkannt:** Endet der erste wilde Kampf auf einer Route ohne Fang (besiegt, geflohen, verloren), ist die Route für diesen Spieler gescheitert. Später dort gefangene Pokémon zählen als „Zusatz“.
- **Dupe-Klausel:** Gehört Kopf oder Körper des wilden Pokémon zu einer Entwicklungsreihe, die einer von euch schon gefangen hat, zählt der Kampf nicht und man darf nochmal ins Gras.
- Weitere Pokémon von einer schon belegten Route, etwa Geschenke oder Dupes, gelten als **„Zusatz“** und sind nicht gelinkt.
- **Erst ab den ersten Pokébällen:** Vorher (z. B. Rivalenkampf, hohes Gras ohne Bälle) zählen weder K.O. noch Fluchten. Der Zeitpunkt wird einmalig gemerkt.
- **Tod:** Fällt ein Pokémon auf 0 KP, ist es tot. Das bleibt so, auch wenn es danach geheilt wird. Die Verbindung zum Partner wird als tot markiert. Auf der Run-Seite steht dann beim Partner **„muss weg (Partner tot)“**.
- **Partner nicht im Team:** Ist das Pokémon im Team, sein Partner aber in der Box, erscheint ein ⚠-Hinweis.
- **Fusionen:** Ein fusioniertes Pokémon trägt beide Links. Stirbt die Fusion, sterben beide Links.

### Korrekturen von Hand

Auf der Run-Seite unter **Einstellungen** einmal den eigenen `KEY` eintragen. Danach geht Folgendes:

- **Links:** pro Route ein anderes Pokémon zuordnen, zum Beispiel wenn ein Gebäude anders heißt als die Route, **„Begegnung gescheitert“** wählen oder eine automatisch erkannte gescheiterte Begegnung mit **„Zählt nicht als gescheitert“** aufheben.
- **Tod korrigieren:** Pokémon als tot markieren oder wiederbeleben.
- **Alle Pokémon:** Zusatz-Pokémon auf **„nicht zählen“** setzen. Pokémon, die es nicht mehr gibt, könnt ihr ganz entfernen.

---

## 6. Probleme

| Problem | Lösung |
|---|---|
| Fenster zeigt „Warte auf das Spiel …“ | Ist der Mod-Ordner richtig kopiert (siehe Baum oben)? Ist ein Spielstand geladen? Im Titelbildschirm wird noch nichts geschrieben. |
| „falscher Schlüssel oder Spieler“ | `config.txt` prüfen. Jeder Spieler braucht seinen eigenen Block, `PLAYER=1` bzw. `PLAYER=2`. |
| `SoulLink/error.log` existiert | Die Mod hatte einen Fehler. Das Spiel läuft weiter, aber schickt die Datei bitte zur Fehlersuche. |
| Overlay zeigt nicht den Sprite aus dem Spiel | Die Mod speichert den Sprite, den das Spiel zeigt (gewählter Alt-Sprite, Custom/Autogen, Shiny), in `SoulLink/sprites`, das Hilfsprogramm lädt ihn hoch. Team-Pokémon kommen außerhalb von Kämpfen nach ein paar Sekunden dran, PC-Pokémon erst, wenn das Spiel ihren Sprite schon einmal geladen hat. Bis dahin zeigt das Overlay den Sprite aus dem offiziellen Infinite-Fusion-Sprite-Archiv (nur Custom-Sprites; fehlt dort einer, erscheint ein „?“). Hüte von Pokémon werden nicht mit angezeigt. |
| Run vorbei, neuer Versuch | Run-Seite → Einstellungen → **„Run beenden & neuen Versuch starten“**. Der alte Versuch wird archiviert, der Kill-Counter übernommen (abwählbar, jederzeit von Hand anpassbar). Links, Overlays und `config.txt` bleiben gleich. Danach beide einen neuen Spielstand starten; der alte wird anhand der Trainer-ID ignoriert. |
| Nur ein Spieler hat neu angefangen | Run-Seite → Einstellungen → Gefahrenzone → „Spieler X zurücksetzen“. |

### Kostenlos-Limits

Der Gratis-Tarif von Cloudflare erlaubt 100.000 Anfragen pro Tag. Das Hilfsprogramm sendet nur, wenn sich im Spiel etwas ändert, plus einmal pro Minute ein Lebenszeichen. Für zwei Spieler reicht das locker für sehr lange Sessions.

---

## Entwicklung

```bash
npm install
npm test               # Server-Logik (Node)
ruby test/mod_test.rb  # Spiel-Mod gegen ein simuliertes Spiel
npx wrangler dev       # Server lokal auf http://localhost:8787
```

| Pfad | Inhalt |
|---|---|
| `game/Data/Scripts/998_SoulLinkTracker/` | Mod für Infinite Fusion (Ruby): liest Team und PC, markiert Pokémon, schreibt `SoulLink/state.json` |
| `game/SoulLink/` | Hilfsprogramm für Windows (PowerShell), schickt `state.json` an den Server |
| `server/` | Cloudflare Worker + Durable Object: Verlinken, Tode, Ereignisse, WebSockets |
| `public/` | Run-Seite (`index.html`) und OBS-Overlay (`overlay.html`) |
