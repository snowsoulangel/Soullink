import {
  params, esc, spriteHtml, hpBar, animateHpBars, monName, speciesLabel, locationLabel,
  playerName, timeAgo, clockTime, connect,
} from "./common.js";

const app = document.getElementById("app");
const room = params.get("room");
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

let view = null;
let tab = storage.get("soullink-tab") || "teams";
let connState = "connecting";
let key = room ? storage.get(`soullink-key-${room}`) : null;
let myPlayer = room ? storage.get(`soullink-player-${room}`) : null;
let renderPending = false;

const PLAYERS = ["1", "2"];
const STATUS_LABEL = { alive: "lebt", dead: "tot", open: "offen", failed: "gescheitert" };

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Kopiert");
  } catch {
    toast("Kopieren nicht möglich – bitte manuell markieren");
  }
}

function configText(roomId, player, playerKey) {
  return [
    `# Soul Link Tracker – Konfiguration für Spieler ${player}`,
    `SERVER=${location.origin}`,
    `ROOM=${roomId}`,
    `PLAYER=${player}`,
    `KEY=${playerKey}`,
    "",
  ].join("\r\n");
}

//----------------------------------------------------------------------------
// Start page: create or open a run
//----------------------------------------------------------------------------
function renderLanding(needPassword = false) {
  app.innerHTML = `
    <div class="top"><div class="title"><h1>Soul Link Tracker</h1>
    <div class="muted">Pokémon Infinite Fusion · Live-Links, Tode und OBS-Overlays</div></div></div>
    <div class="grid2">
      <div class="panel stack">
        <h2>Neuen Run starten</h2>
        <p class="muted small">Erstellt einen Raum für euch beide. Danach bekommt jeder Spieler seine Konfiguration für das Hilfsprogramm.</p>
        ${needPassword ? `<input type="password" id="pw" placeholder="Passwort zum Erstellen">` : ""}
        <div><button class="btn primary" id="create">Run erstellen</button></div>
      </div>
      <div class="panel stack">
        <h2>Run öffnen</h2>
        <p class="muted small">Raum-Code oder Link eintragen.</p>
        <div class="copyrow"><input type="text" id="roomInput" placeholder="z. B. k7m2xq9a"><button class="btn" id="open">Öffnen</button></div>
      </div>
    </div>`;
  document.getElementById("create").onclick = async () => {
    const pw = document.getElementById("pw");
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw ? pw.value : undefined }),
    });
    if (res.status === 403) {
      if (needPassword) toast("Falsches Passwort");
      return renderLanding(true);
    }
    if (!res.ok) return toast("Fehler beim Erstellen");
    const data = await res.json();
    renderSetup(data.room, data.keys);
  };
  document.getElementById("open").onclick = () => {
    const value = document.getElementById("roomInput").value.trim();
    const m = value.match(/room=([a-z0-9]+)/) || value.match(/^([a-z0-9]+)$/);
    if (m) location.search = `?room=${m[1]}`;
    else toast("Ungültiger Raum-Code");
  };
}

function renderSetup(roomId, keys) {
  const link = `${location.origin}/?room=${roomId}`;
  app.innerHTML = `
    <div class="top"><div class="title"><h1>Run erstellt 🎉</h1>
    <div class="muted">Raum-Code: <b>${esc(roomId)}</b></div></div></div>
    <div class="panel stack">
      <div><b>Link zur Run-Seite</b> (könnt ihr auch euren Zuschauern geben):
        <div class="copyrow"><input type="text" readonly value="${esc(link)}"><button class="btn" data-copy="${esc(link)}">Kopieren</button></div></div>
      <p class="small"><b>Wichtig:</b> Jeder Spieler kopiert <i>seinen</i> Block in die Datei <code>SoulLink/config.txt</code> im Spielordner.
      Die Schlüssel sind geheim. Zeigt sie nicht im Stream. Wer den Schlüssel kennt, kann die Daten verändern.
      Diese Seite zeigt die Schlüssel nur jetzt an, also speichert sie euch!</p>
      <div class="grid2">
        ${PLAYERS.map((p) => `
          <div class="stack">
            <b class="p${p}" style="color:var(--pc)">Spieler ${p}</b>
            <textarea rows="6" readonly>${esc(configText(roomId, p, keys[p]))}</textarea>
            <div><button class="btn" data-copy="${esc(configText(roomId, p, keys[p]))}">Kopieren</button>
            <button class="btn primary" data-me="${p}">Ich bin Spieler ${p} → zum Run</button></div>
          </div>`).join("")}
      </div>
    </div>`;
  app.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  app.querySelectorAll("[data-me]").forEach((b) => (b.onclick = () => {
    const p = b.dataset.me;
    storage.set(`soullink-key-${roomId}`, keys[p]);
    storage.set(`soullink-player-${roomId}`, p);
    location.search = `?room=${roomId}`;
  }));
}

//----------------------------------------------------------------------------
// Run page
//----------------------------------------------------------------------------
async function act(action) {
  if (!key) return toast("Zum Bearbeiten erst unter „Einstellungen“ den Schlüssel eintragen");
  const res = await fetch(`/api/rooms/${room}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) toast(data.error || "Fehler");
  return res.ok ? data : null;
}

function render() {
  if (!view) return;
  const active = document.activeElement;
  if (active && app.contains(active) && ["SELECT", "INPUT", "TEXTAREA"].includes(active.tagName)) {
    // don't rebuild the page while someone is typing or choosing
    if (!renderPending) {
      renderPending = true;
      active.addEventListener("blur", () => { renderPending = false; setTimeout(render, 50); }, { once: true });
    }
    return;
  }
  const v = view;
  const dead = v.routes.filter((r) => r.status === "dead");
  const allCount = Object.keys(v.mons[1]).length + Object.keys(v.mons[2]).length;
  const tabs = [
    ["teams", "Teams"],
    ["links", "Links", v.routes.length],
    ["graveyard", "Friedhof", dead.length],
    ["all", "Alle Pokémon", allCount],
    ["events", "Ereignisse"],
    ["obs", "OBS"],
    ["settings", "Einstellungen"],
  ];
  const connLabel = { live: "live", reconnecting: "verbinde neu …", connecting: "verbinde …" }[connState] || connState;
  app.innerHTML = `
    <div class="top">
      <div class="title"><h1>${esc(v.title)}</h1>
        <span class="conn"><span class="dot ${connState === "live" ? "on" : "warn"}"></span>${connLabel}${key ? ` · Bearbeiten als Spieler ${esc(myPlayer || "?")}` : ""}</span></div>
      <div class="deathbox"><span class="num">☠ ${v.deaths.pairs}</span><span class="muted small">Tode<br>(gelinkte Paare)</span></div>
    </div>
    <div class="players">${PLAYERS.map((p) => playerInfo(v, p)).join("")}</div>
    <div class="tabs">${tabs.map(([id, label, count]) =>
      `<button class="tab ${tab === id ? "active" : ""}" data-tab="${id}">${label}${count !== undefined ? `<span class="count">${count}</span>` : ""}</button>`).join("")}</div>
    <div id="content">${renderTab(v)}</div>`;
  bind();
  animateHpBars(app);
}

function playerInfo(v, p) {
  const pl = v.players[p];
  const info = pl.info;
  if (!info) {
    return `<div class="panel pinfo p${p}"><div class="pname">Spieler ${p}</div>
      <div class="facts">Noch keine Daten. Spiel mit Mod starten und Hilfsprogramm (start.bat) laufen lassen.</div></div>`;
  }
  const online = pl.online ? `<span class="dot on"></span> online` : `<span class="dot"></span> offline`;
  return `<div class="panel pinfo p${p}">
    <div class="pname">${esc(info.name)}</div>
    <div class="facts">
      <span>${online}</span>
      <span>🏅 ${info.badges} Orden</span>
      <span>📍 ${esc(info.map || "?")}${info.inBattle ? " · ⚔ im Kampf" : ""}</span>
      <span>☠ ${v.deaths[p]} eigene Tode</span>
      <span>Update ${timeAgo(pl.lastUpdate)}</span>
    </div></div>`;
}

function renderTab(v) {
  switch (tab) {
    case "links": return linksTab(v);
    case "graveyard": return graveyardTab(v);
    case "all": return allTab(v);
    case "events": return eventsTab(v);
    case "obs": return obsTab();
    case "settings": return settingsTab(v);
    default: return teamsTab(v);
  }
}

function partnerLines(v, p, mon) {
  const op = p === "1" ? "2" : "1";
  return [mon.id, ...(mon.fusedWith || [])].map((id) => {
    const m = v.mons[p][id];
    if (!m) return "";
    if (!m.partner) {
      const text = m.linkStatus === "failed" ? "Partner-Begegnung gescheitert" : m.extra ? "kein Link (Zusatz-Pokémon)" : `wartet auf Partner (${esc(m.route)})`;
      return `<div class="partner"><span class="chain">⛓</span><span class="muted">${text}</span></div>`;
    }
    const pm = v.mons[op][m.partner];
    if (!pm) return "";
    let note = "";
    if (pm.dead) note = `<div class="bad">☠ tot</div>`;
    else if (mon.dead) note = `<div class="bad">muss weg (Partner tot)</div>`;
    else if (!pm.inParty) note = `<div class="warn">⚠ nicht im Team (${esc(locationLabel(pm))})</div>`;
    return `<div class="partner">${spriteHtml(pm, "small")}<div class="pn">
      <div><span class="chain">⛓</span> <b>${esc(monName(pm))}</b> Lv.${pm.level}</div>
      ${pm.dead ? "" : hpBar(pm, false)}${note}</div></div>`;
  }).join("");
}

function monCard(v, p, mon) {
  return `<div class="mon ${mon.dead ? "dead" : ""}">
    <div class="row">${spriteHtml(mon)}<div style="min-width:0;flex:1">
      <div class="name">${mon.dead ? "☠ " : ""}${esc(monName(mon))}</div>
      <div class="sub">${mon.nicknamed || mon.fusion ? `${esc(speciesLabel(mon))} · ` : ""}Lv.${mon.level}</div>
      <div class="sub">📍 ${esc(mon.route)}</div>
      ${hpBar(mon)}
    </div></div>
    ${partnerLines(v, p, mon)}
  </div>`;
}

function teamsTab(v) {
  return `<div class="teamgrid">${PLAYERS.map((p) => {
    const party = v.players[p].party.map((id) => v.mons[p][id]).filter(Boolean);
    return `<div class="panel p${p}"><h2 style="color:var(--pc)">Team ${esc(playerName(v, p))}</h2>
      ${party.length ? `<div class="mons">${party.map((m) => monCard(v, p, m)).join("")}</div>` : `<div class="empty">Kein Team</div>`}</div>`;
  }).join("")}</div>`;
}

function monCell(v, p, id, route) {
  const mon = id ? v.mons[p][id] : null;
  let html;
  if (route.failed[p]) html = `<span class="muted">✗ gescheitert</span>`;
  else if (!mon) html = `<span class="muted">—</span>`;
  else {
    html = `<div class="cellmon">${spriteHtml(mon, "small")}<div class="info">
      <div><b>${mon.dead ? "☠ " : ""}${esc(monName(mon))}</b> <span class="muted">Lv.${mon.level}</span></div>
      <div class="muted small">${esc(speciesLabel(mon))} · ${esc(locationLabel(mon))}</div></div></div>`;
  }
  if (key) {
    const choice = (route.choice && route.choice[p]) || "auto";
    const options = Object.values(v.mons[p])
      .sort((a, b) => a.route.localeCompare(b.route))
      .map((m) => `<option value="${esc(m.id)}" ${choice === m.id ? "selected" : ""}>${esc(monName(m))} (${esc(m.route)})</option>`);
    html += `<div class="edit">
      <select data-route="${esc(route.key)}" data-routename="${esc(route.name)}" data-player="${p}">
        <option value="auto" ${choice === "auto" ? "selected" : ""}>Automatisch</option>
        <option value="failed" ${choice === "failed" ? "selected" : ""}>Begegnung gescheitert</option>
        ${options.join("")}
      </select>
      ${mon ? `<button class="btn small" data-dead="${mon.dead ? 0 : 1}" data-player="${p}" data-id="${esc(mon.id)}">${mon.dead ? "wiederbeleben" : "☠ als tot markieren"}</button>` : ""}
    </div>`;
  }
  return html;
}

function linksTab(v) {
  if (!v.routes.length) return `<div class="panel empty">Noch keine Begegnungen.</div>`;
  return `<div class="panel tablewrap"><table>
    <thead><tr><th>#</th><th>Route</th><th class="p1" style="color:var(--pc)">${esc(playerName(v, "1"))}</th><th class="p2" style="color:var(--pc)">${esc(playerName(v, "2"))}</th><th>Status</th></tr></thead>
    <tbody>${v.routes.map((r, i) => `<tr class="st-${r.status}">
      <td class="muted">${i + 1}</td><td><b>${esc(r.name)}</b></td>
      <td>${monCell(v, "1", r.mon[1], r)}</td><td>${monCell(v, "2", r.mon[2], r)}</td>
      <td><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></td></tr>`).join("")}</tbody>
  </table>
  ${key ? `<p class="muted small">„Automatisch“ nimmt das erste Pokémon, das auf dieser Route gefangen wurde. Über die Auswahl könnt ihr ein anderes Pokémon zuordnen oder die Begegnung als gescheitert markieren.</p>` : ""}
  </div>`;
}

function graveyardTab(v) {
  const dead = v.routes.filter((r) => r.status === "dead");
  if (!dead.length) return `<div class="panel empty">Noch niemand gestorben. Weiter so! 🍀</div>`;
  return `<div class="panel tablewrap"><table>
    <thead><tr><th>Route</th><th>${esc(playerName(v, "1"))}</th><th>${esc(playerName(v, "2"))}</th><th>Wann</th></tr></thead>
    <tbody>${dead.map((r) => {
      const a = r.mon[1] ? v.mons[1][r.mon[1]] : null;
      const b = r.mon[2] ? v.mons[2][r.mon[2]] : null;
      const cell = (m) => (m ? `<div class="cellmon">${spriteHtml(m, "small")}<div class="info"><div><b>${m.dead ? "☠ " : ""}${esc(monName(m))}</b> Lv.${m.level}</div>
        <div class="muted small">${m.dead ? "gestorben" : "mit in den Tod gerissen"}</div></div></div>` : "—");
      const t = Math.max((a && a.dead && a.deadAt) || 0, (b && b.dead && b.deadAt) || 0);
      return `<tr><td><b>${esc(r.name)}</b></td><td>${cell(a)}</td><td>${cell(b)}</td><td class="muted small">${t ? new Date(t).toLocaleString("de-DE") : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function allTab(v) {
  return `<div class="teamgrid">${PLAYERS.map((p) => {
    const list = Object.values(v.mons[p]).sort((a, b) => a.route.localeCompare(b.route));
    return `<div class="panel p${p} tablewrap"><h2 style="color:var(--pc)">${esc(playerName(v, p))}</h2>
      ${list.length ? `<table><tbody>${list.map((m) => {
        let status = m.extra ? (m.ignored ? "ignoriert" : "Zusatz") : "gelinkt";
        if (m.dead) status = "tot";
        const actions = key ? `<div class="edit">
          ${m.extra ? `<button class="btn small" data-ignore="${m.ignored ? 0 : 1}" data-player="${p}" data-id="${esc(m.id)}">${m.ignored ? "wieder zählen" : "nicht zählen"}</button>` : ""}
          ${!m.present ? `<button class="btn small danger" data-forget="1" data-player="${p}" data-id="${esc(m.id)}">entfernen</button>` : ""}
        </div>` : "";
        return `<tr><td><div class="cellmon">${spriteHtml(m, "small")}<div class="info"><div><b>${esc(monName(m))}</b> <span class="muted">Lv.${m.level}</span></div>
          <div class="muted small">${esc(m.route)} · ${esc(locationLabel(m))}</div></div></div>${actions}</td><td><span class="badge">${status}</span></td></tr>`;
      }).join("")}</tbody></table>` : `<div class="empty">Noch keine Pokémon</div>`}
      <p class="muted small">„Zusatz“ sind Pokémon, die auf einer Route gefangen wurden, auf der es schon eine Begegnung gab (z. B. Geschenke oder Dupes). Mit „nicht zählen“ werden sie auch bei der automatischen Zuordnung ignoriert.</p></div>`;
  }).join("")}</div>`;
}

function eventsTab(v) {
  if (!v.events.length) return `<div class="panel empty">Noch keine Ereignisse.</div>`;
  return `<div class="panel"><ul class="events">${v.events.map((e) =>
    `<li><span class="t">${clockTime(e.t)}</span><span class="${e.type === "death" ? "death" : ""}">${esc(e.text)}</span></li>`).join("")}</ul></div>`;
}

function obsTab() {
  const base = `${location.origin}/overlay.html?room=${room}`;
  const items = [
    ["Team Spieler 1 mit Partnern (nebeneinander)", `${base}&player=1`, "1000 × 340"],
    ["Team Spieler 2 mit Partnern (nebeneinander)", `${base}&player=2`, "1000 × 340"],
    ["Team Spieler 1 (untereinander, für den Rand)", `${base}&player=1&layout=column`, "300 × 1000"],
    ["Team Spieler 2 (untereinander, für den Rand)", `${base}&player=2&layout=column`, "300 × 1000"],
    ["Beide Teams (nur Teams, ohne Partner-Zeile)", `${base}&view=both&partner=0`, "1000 × 420"],
    ["Todeszähler", `${base}&view=deaths`, "420 × 100"],
  ];
  return `<div class="panel stack">
    <p>In OBS: <b>Quelle hinzufügen → Browser</b>, die URL einfügen, Breite/Höhe wie angegeben setzen. Der Hintergrund ist durchsichtig.
    Mit <code>&amp;scale=0.8</code> am Ende der URL wird das Overlay kleiner, mit <code>&amp;partner=0</code> verschwinden die Partner-Zeilen.</p>
    ${items.map(([label, url, size]) => `<div><b>${label}</b> <span class="muted small">(${size})</span>
      <div class="copyrow"><input type="text" readonly value="${esc(url)}"><button class="btn" data-copy="${esc(url)}">Kopieren</button>
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Vorschau</a></div></div>`).join("")}
  </div>`;
}

function settingsTab(v) {
  return `<div class="grid2">
    <div class="panel stack">
      <h2>Bearbeiten freischalten</h2>
      <p class="muted small">Mit dem Schlüssel aus eurer <code>config.txt</code> könnt ihr Links korrigieren, Begegnungen als gescheitert markieren oder Tode korrigieren. Zuschauer brauchen keinen Schlüssel.</p>
      ${key ? `<p>✔ Freigeschaltet als Spieler ${esc(myPlayer || "?")}</p><div><button class="btn" id="logout">Schlüssel auf diesem Gerät vergessen</button></div>`
        : `<div class="copyrow"><input type="password" id="keyInput" placeholder="KEY aus config.txt"><button class="btn primary" id="saveKey">Freischalten</button></div>`}
    </div>
    <div class="panel stack">
      <h2>Run</h2>
      <div class="copyrow"><input type="text" id="titleInput" value="${esc(v.title)}" ${key ? "" : "disabled"}><button class="btn" id="saveTitle" ${key ? "" : "disabled"}>Titel speichern</button></div>
      <div class="copyrow"><input type="text" readonly value="${esc(location.href)}"><button class="btn" data-copy="${esc(location.href)}">Link kopieren</button></div>
      ${key && myPlayer ? `<details><summary>Meine config.txt anzeigen</summary><textarea rows="6" readonly>${esc(configText(room, myPlayer, key))}</textarea></details>` : ""}
      ${key ? `<details><summary class="bad">Gefahrenzone</summary><p class="small">Löscht alle Daten eines Spielers, z. B. nach einem Neustart des Spielstands. Die Daten kommen beim nächsten Update aus dem Spiel neu rein.</p>
        ${PLAYERS.map((p) => `<button class="btn danger" data-reset="${p}">Spieler ${p} zurücksetzen</button>`).join(" ")}</details>` : ""}
    </div>
  </div>`;
}

function bind() {
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    storage.set("soullink-tab", tab);
    render();
  }));
  app.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  app.querySelectorAll("select[data-route]").forEach((s) => (s.onchange = async () => {
    await act({ type: "setRoute", route: s.dataset.route, routeName: s.dataset.routename, player: s.dataset.player, value: s.value });
    s.blur();
  }));
  app.querySelectorAll("[data-dead]").forEach((b) => (b.onclick = () => {
    const dead = b.dataset.dead === "1";
    if (dead && !confirm("Dieses Pokémon als tot markieren?")) return;
    act({ type: "setDead", player: b.dataset.player, id: b.dataset.id, dead });
  }));
  app.querySelectorAll("[data-ignore]").forEach((b) => (b.onclick = () =>
    act({ type: "setIgnore", player: b.dataset.player, id: b.dataset.id, ignore: b.dataset.ignore === "1" })));
  app.querySelectorAll("[data-forget]").forEach((b) => (b.onclick = () => {
    if (confirm("Dieses Pokémon endgültig aus dem Tracker entfernen?")) act({ type: "forget", player: b.dataset.player, id: b.dataset.id });
  }));
  app.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = () => {
    const answer = prompt(`Alle Daten von Spieler ${b.dataset.reset} löschen? Zum Bestätigen RESET eintippen.`);
    if (answer === "RESET") act({ type: "resetPlayer", player: b.dataset.reset, confirm: "RESET" });
  }));
  const saveKey = document.getElementById("saveKey");
  if (saveKey) saveKey.onclick = async () => {
    const value = document.getElementById("keyInput").value.trim();
    const res = await fetch(`/api/rooms/${room}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: value, action: { type: "check" } }),
    });
    if (!res.ok) return toast("Falscher Schlüssel");
    const data = await res.json();
    key = value;
    myPlayer = data.player;
    storage.set(`soullink-key-${room}`, key);
    storage.set(`soullink-player-${room}`, myPlayer);
    toast(`Freigeschaltet als Spieler ${myPlayer}`);
    document.activeElement.blur();
    render();
  };
  const logout = document.getElementById("logout");
  if (logout) logout.onclick = () => {
    storage.del(`soullink-key-${room}`);
    storage.del(`soullink-player-${room}`);
    key = null;
    myPlayer = null;
    render();
  };
  const saveTitle = document.getElementById("saveTitle");
  if (saveTitle) saveTitle.onclick = async () => {
    if (await act({ type: "setTitle", title: document.getElementById("titleInput").value })) toast("Gespeichert");
  };
}

if (!room) {
  renderLanding();
} else {
  app.innerHTML = `<div class="panel empty">Lade Run …</div>`;
  connect(room, (v) => {
    view = v;
    render();
  }, (state) => {
    if (state === "missing") {
      app.innerHTML = `<div class="panel">Diesen Run gibt es nicht. <a href="/">Zur Startseite</a></div>`;
      return;
    }
    connState = state;
    render();
  });
  setInterval(render, 30000); // refresh "vor X Min." labels
}
