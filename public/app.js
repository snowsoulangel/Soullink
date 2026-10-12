import {
  params, esc, spriteHtml, hpBar, animateHpBars, monName, speciesLabel, locationLabel,
  playerName, timeAgo, clockTime, connect, wildMon, failLabels,
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
let teamMode = storage.get("soullink-teammode") || "pairs";

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
  const allCount = Object.keys(v.mons[1]).length + Object.keys(v.mons[2]).length;
  const tabs = [
    ["teams", "Teams"],
    ["links", "Links", v.routes.length],
    ["graveyard", "Friedhof", (v.deaths[1] || 0) + (v.deaths[2] || 0)],
    ["all", "Alle Pokémon", allCount],
    ["events", "Ereignisse"],
    ["obs", "OBS"],
    ["settings", "Einstellungen"],
  ];
  const connLabel = { live: "live", reconnecting: "verbinde neu …", connecting: "verbinde …" }[connState] || connState;
  app.innerHTML = `
    <div class="top">
      <div class="title"><h1>${esc(v.title)}</h1>
        <span class="conn"><span class="dot ${connState === "live" ? "on" : "warn"}"></span>${connLabel}${(v.attempt || 1) > 1 ? ` · Versuch #${v.attempt}` : ""}${key ? ` · Bearbeiten als Spieler ${esc(myPlayer || "?")}` : ""}</span></div>
      ${killBox(v)}
    </div>
    <div class="players">${PLAYERS.map((p) => playerInfo(v, p)).join("")}</div>
    <div class="tabs">${tabs.map(([id, label, count]) =>
      `<button class="tab ${tab === id ? "active" : ""}" data-tab="${id}">${label}${count !== undefined ? `<span class="count">${count}</span>` : ""}</button>`).join("")}</div>
    <div id="content">${renderTab(v)}</div>`;
  bind();
  animateHpBars(app);
}

// Kill counter: Pokémon each player has on their conscience (own + dragged partners)
function killBox(v) {
  const kills = v.deaths.kills || { 1: 0, 2: 0 };
  const total = v.deaths.killsTotal || kills;
  const carried = PLAYERS.some((p) => total[p] !== kills[p]);
  return `<div class="deathbox" title="Eigenes gestorbenes Pokémon + mitgerissene Partner${carried ? " (inkl. früherer Versuche)" : ""}">
    ${PLAYERS.map((p) => `<div class="kc p${p}"><span class="num">${total[p]}</span><span class="who">☠ ${esc(playerName(v, p))}</span>
      ${carried ? `<span class="run">${kills[p]} in Versuch #${v.attempt || 1}</span>` : ""}</div>`).join(`<span class="vs">vs</span>`)}
  </div>`;
}

function playerInfo(v, p) {
  const pl = v.players[p];
  const info = pl.info;
  if (!info) {
    return `<div class="panel pinfo p${p}"><div class="pname">${esc(playerName(v, p))}</div>
      <div class="facts">Noch keine Daten. Spiel mit Mod starten und Hilfsprogramm (start.bat) laufen lassen.</div></div>`;
  }
  const online = pl.online ? `<span class="dot on"></span> online` : `<span class="dot"></span> offline`;
  const waiting = pl.waitingNewSave ? `<div class="warn">⏳ Warte auf neuen Spielstand – der alte wird für Versuch #${v.attempt} ignoriert.</div>`
    : info.balls === false ? `<div class="muted small">🔴 Noch keine Pokébälle – K.O. und Fluchten zählen noch nicht.</div>` : "";
  return `<div class="panel pinfo p${p}">
    <div class="pname">${esc(playerName(v, p))}${pl.customName && info.name !== pl.customName ? ` <span class="muted small">(im Spiel: ${esc(info.name)})</span>` : ""}</div>${waiting}
    <div class="facts">
      <span>${online}</span>
      <span>🏅 ${info.badges} Orden</span>
      <span>📍 ${esc(info.map || "?")}${info.inBattle ? " · ⚔ im Kampf" : ""}</span>
      <span>☠ ${v.deaths[p]} eigene Tode · ${(v.deaths.kills || {})[p] || 0} Kills</span>
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

function teamsTab(v) {
  const toggle = `<div class="seg" role="group" aria-label="Ansicht">
    <button class="${teamMode === "box" ? "" : "active"}" data-teammode="team">⛓ Im Team</button>
    <button class="${teamMode === "box" ? "active" : ""}" data-teammode="box">📦 In der Box</button></div>`;
  return toggle + (teamMode === "box" ? boxView(v) : teamPairsView(v));
}

//----------------------------------------------------------------------------
// Pair views: linked Pokémon side by side with big sprites
// A row is { sides: {1: [mon], 2: [mon]}, routes: [name], dead, reason: {1, 2}, context }
//----------------------------------------------------------------------------
const tagsOf = (m) => [m.id, ...(m.fusedWith || [])];

function pairHead(v) {
  return `<div class="pairhead">${PLAYERS.map((p) =>
    `<div class="p${p}"><span class="pdot"></span>${esc(playerName(v, p))}</div>`).join(`<div></div>`)}</div>`;
}

function pairList(v, rows, emptyText) {
  if (!rows.length) return `<div class="panel empty">${emptyText}</div>`;
  return `<div class="pairs">${pairHead(v)}${rows.map((r) => pairRow(v, r)).join("")}</div>`;
}

// Every party Pokémon of both players with its partner(s), wherever they are.
function teamPairsView(v) {
  const shown = { 1: new Set(), 2: new Set() };
  const rows = [];
  for (const p of PLAYERS) {
    const op = p === "1" ? "2" : "1";
    for (const id of v.players[p].party) {
      const mon = v.mons[p][id];
      if (!mon || shown[p].has(id)) continue;
      tagsOf(mon).forEach((t) => shown[p].add(t));
      const links = [];
      const partners = [];
      for (const t of tagsOf(mon)) {
        const tm = v.mons[p][t];
        if (!tm) continue;
        const pm = tm.partner ? v.mons[op][tm.partner] : null;
        links.push(tm);
        if (pm && !partners.some((x) => tagsOf(x).includes(pm.id))) {
          partners.push(pm);
          tagsOf(pm).forEach((x) => shown[op].add(x));
        }
      }
      const reason = links.some((l) => l.linkStatus === "failed") ? "Begegnung gescheitert"
        : links.every((l) => l.extra) ? "kein Link (Zusatz)" : "wartet auf Partner";
      const fail = links.map((l) => l.partnerFail).find(Boolean);
      rows.push({
        sides: { [p]: [mon], [op]: partners },
        routes: [...new Set(links.map((l) => l.route))],
        dead: links.some((l) => l.linkStatus === "dead"),
        reason: { [op]: reason },
        failDetail: { [op]: fail || null },
        context: "team",
      });
    }
  }
  return pairList(v, rows, "Noch keine Teams. Spiel mit Mod starten und start.bat laufen lassen.");
}

function routeRow(v, r, context) {
  const sides = {};
  const reason = {};
  for (const p of PLAYERS) {
    const m = r.mon[p] ? v.mons[p][r.mon[p]] : null;
    sides[p] = m ? [m] : [];
    const info = r.failInfo && r.failInfo[p];
    reason[p] = r.failed[p] ? `Begegnung gescheitert${info ? ` (${info})` : ""}` : "keine Begegnung";
  }
  return { sides, routes: [r.name], dead: r.status === "dead", reason, context, deadAt: deathTime(v, r) };
}

function deathTime(v, r) {
  let t = 0;
  for (const p of PLAYERS) {
    const m = r.mon[p] ? v.mons[p][r.mon[p]] : null;
    if (m && m.dead && m.deadAt) t = Math.max(t, m.deadAt);
  }
  return t;
}

// Living links where neither Pokémon is in the team.
function boxView(v) {
  const rows = v.routes
    .filter((r) => r.status === "alive" || r.status === "open")
    .filter((r) => PLAYERS.every((p) => {
      const m = r.mon[p] ? v.mons[p][r.mon[p]] : null;
      return !m || !m.inParty;
    }))
    .filter((r) => PLAYERS.some((p) => r.mon[p]))
    .map((r) => routeRow(v, r, "box"));
  return pairList(v, rows, "Keine Paare in der Box.");
}

function pairRow(v, row) {
  const side = (p) => {
    const list = row.sides[p];
    const fail = row.failDetail && row.failDetail[p];
    if (!list.length && fail) return `<div class="side p${p}">${failCard(fail)}</div>`;
    if (!list.length) return `<div class="side p${p}"><div class="bigmon ghost"><div class="stage"><span class="q">?</span></div>
      <div class="meta"><div class="sub">${esc(row.reason[p] || "")}</div></div></div></div>`;
    return `<div class="side p${p} ${list.length > 1 ? "multi" : ""}">${list.map((m) => bigCard(v, m, row.context)).join("")}</div>`;
  };
  const when = row.context === "grave" && row.deadAt
    ? `<span class="route when">${new Date(row.deadAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>` : "";
  return `<div class="pair ${row.dead ? "dead" : ""}">
    ${side("1")}
    <div class="linkmid"><span class="ring">${row.dead ? "☠" : "⛓"}</span>${row.routes.map((r) => `<span class="route">${esc(r)}</span>`).join("")}${when}</div>
    ${side("2")}
  </div>`;
}

// Failed encounter in place of the partner: the wild Pokémon greyed out, and who failed
function failCard(detail) {
  const w = (detail.wild || [])[0];
  const { who, what } = failLabels(detail);
  return `<div class="bigmon ghost failed">
    <div class="stage">${w ? spriteHtml(wildMon(w), "xl") : ""}<span class="x">✗</span></div>
    <div class="meta"><div class="name">${esc(who)}</div><div class="sub">${esc(what)}</div></div></div>`;
}

function bigCard(v, mon, context) {
  let note = "";
  if (mon.dead) note = `<span class="chip bad">☠ tot</span>${mon.cause ? `<div class="cause">${esc(mon.cause)}</div>` : ""}`;
  else if (context === "grave") note = `<span class="chip bad">mit in den Tod gerissen</span>`;
  else if (mon.linkStatus === "dead") note = `<span class="chip bad">muss weg (Partner tot)</span>`;
  else if (!mon.inParty && context === "team") note = `<span class="chip warn">⚠ ${esc(locationLabel(mon))}</span>`;
  else if (!mon.inParty) note = `<span class="chip">📦 ${esc(locationLabel(mon))}</span>`;
  const away = context === "team" && !mon.inParty && !mon.dead;
  return `<div class="bigmon ${mon.dead ? "dead" : ""} ${away ? "away" : ""}">
    <div class="stage">${spriteHtml(mon, "xl")}
      ${mon.shiny ? `<span class="shiny" title="Shiny">✨</span>` : ""}
      <span class="lv">Lv. ${mon.level}</span></div>
    <div class="meta">
      <div class="name">${esc(monName(mon))}</div>
      <div class="sub">${esc(speciesLabel(mon))}</div>
      ${mon.dead || context === "grave" ? "" : hpBar(mon)}
      ${note}
    </div></div>`;
}

function monCell(v, p, id, route) {
  const mon = id ? v.mons[p][id] : null;
  let html;
  if (route.failed[p]) {
    const detail = route.failDetail && route.failDetail[p];
    const w = detail && (detail.wild || [])[0];
    const labels = detail ? failLabels(detail) : { who: "gescheitert", what: "" };
    html = `<div class="cellmon failcell">${w ? spriteHtml(wildMon(w), "small") : ""}<div class="info">
      <div><b class="bad">✗ ${esc(labels.who)}</b></div><div class="muted small">${esc(labels.what)}</div></div></div>`;
  }
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
        <option value="notfailed" ${choice === "notfailed" ? "selected" : ""}>Zählt nicht als gescheitert</option>
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
  ${key ? `<p class="muted small">„Automatisch“ nimmt das erste Pokémon, das auf dieser Route gefangen wurde. Endet der erste wilde Kampf auf einer Route ohne Fang, gilt sie automatisch als gescheitert, außer bei einem Dupe (Kopf oder Körper aus einer schon gefangenen Entwicklungsreihe). Über die Auswahl könnt ihr ein anderes Pokémon zuordnen, eine Begegnung als gescheitert markieren oder mit „Zählt nicht als gescheitert“ eine automatische Erkennung aufheben.</p>` : ""}
  </div>`;
}

// One row per Pokémon that died (a fusion once), with every partner it dragged along.
// If both partners died, the one that died first owns the row.
function graveyardTab(v) {
  const unit = (m) => [m.id, ...(m.fusedWith || [])].sort().join("+");
  const dead = PLAYERS.flatMap((p) => Object.values(v.mons[p]).filter((m) => m.dead).map((m) => ({ p, m })))
    .sort((a, b) => (a.m.deadAt || 0) - (b.m.deadAt || 0));
  const shown = new Set();
  const rows = [];
  for (const { p, m } of dead) {
    if (shown.has(`${p}:${unit(m)}`)) continue;
    shown.add(`${p}:${unit(m)}`);
    const op = p === "1" ? "2" : "1";
    const partners = [];
    const routes = [];
    for (const t of tagsOf(m)) {
      const tm = v.mons[p][t];
      if (!tm) continue;
      routes.push(tm.route);
      const pm = tm.partner ? v.mons[op][tm.partner] : null;
      if (pm && !shown.has(`${op}:${unit(pm)}`)) {
        shown.add(`${op}:${unit(pm)}`);
        partners.push(pm);
      }
    }
    rows.push({
      sides: { [p]: [m], [op]: partners }, routes: [...new Set(routes)], dead: true,
      reason: { [op]: "kein Partner" }, context: "grave", deadAt: m.deadAt || 0,
    });
  }
  rows.sort((a, b) => b.deadAt - a.deadAt);   // most recent first
  return pairList(v, rows, "Noch niemand gestorben. Weiter so! 🍀");
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
    `<li><span class="t">${clockTime(e.t)}</span>${(e.wild || []).slice(0, 1).map((w) => spriteHtml(wildMon(w), "small icon")).join("")}<span class="${e.type === "death" || e.type === "fail" ? "death" : ""}">${esc(e.text)}</span></li>`).join("")}</ul></div>`;
}

function obsTab() {
  const base = `${location.origin}/overlay.html?room=${room}`;
  const frame = `${location.origin}/frame.html?room=${room}`;
  const items = [
    ["Szenen-Hintergrund (ganz unten in der Szene)", `${frame}&layer=bg`, "1920 × 1080"],
    ["Rahmen um Spielfenster und Facecams (über Spiel und Cams, unter den Overlays)", `${frame}&layer=frame`, "1920 × 1080"],
    ["Team-Leiste Spieler 1 (große Sprites, Partner als Blase)", `${base}&player=1&layout=strip`, "1040 × 250"],
    ["Team-Leiste Spieler 2 (große Sprites, Partner als Blase)", `${base}&player=2&layout=strip`, "1040 × 250"],
    ["Beide Team-Leisten untereinander", `${base}&view=both&layout=strip`, "1040 × 540"],
    ["Friedhof-Leiste (die letzten 8 Tode mit Partner und Ursache)", `${base}&view=grave`, "1900 × 150"],
    ["Box-Leiste (lebende Paare im PC, keiner im Team)", `${base}&view=box`, "1900 × 150"],
    ["Team-Leiste Spieler 1 + Kill-Counter rechts daneben", `${base}&player=1&layout=strip&kills=1`, "1300 × 250"],
    ["Team-Leiste Spieler 2 + Kill-Counter rechts daneben", `${base}&player=2&layout=strip&kills=1`, "1300 × 250"],
    ["Team Spieler 1 mit Partnern (nebeneinander)", `${base}&player=1`, "1000 × 340"],
    ["Team Spieler 2 mit Partnern (nebeneinander)", `${base}&player=2`, "1000 × 340"],
    ["Team Spieler 1 (untereinander, für den Rand)", `${base}&player=1&layout=column`, "300 × 1000"],
    ["Team Spieler 2 (untereinander, für den Rand)", `${base}&player=2&layout=column`, "300 × 1000"],
    ["Beide Teams (nur Teams, ohne Partner-Zeile)", `${base}&view=both&partner=0`, "1000 × 420"],
    ["Kill-Counter (wer hat wie viele auf dem Gewissen)", `${base}&view=deaths`, "460 × 110"],
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
      <h3 style="margin:6px 0 0;font-size:15px">Anzeigenamen</h3>
      <p class="muted small" style="margin:0">Stehen im Kill-Counter, in den Overlays, Rahmen und im Titel. Leer lassen = Name aus dem Spiel.</p>
      <div class="killedit">${PLAYERS.map((p) => {
        const pl = v.players[p];
        const ingame = (pl.info && pl.info.name) || `Spieler ${p}`;
        return `<label class="p${p}"><span style="color:var(--pc)">Spieler ${p}</span>
          <input type="text" maxlength="24" id="name${p}" value="${esc(pl.customName || "")}" placeholder="${esc(ingame)}" ${key ? "" : "disabled"} style="width:150px"></label>`;
      }).join("")}<button class="btn" id="saveNames" ${key ? "" : "disabled"}>Namen speichern</button></div>
      ${key && myPlayer ? `<details><summary>Meine config.txt anzeigen</summary><textarea rows="6" readonly>${esc(configText(room, myPlayer, key))}</textarea></details>` : ""}
      ${key ? `<details><summary class="bad">Gefahrenzone</summary><p class="small">Löscht alle Daten eines Spielers, z. B. nach einem Neustart des Spielstands. Die Daten kommen beim nächsten Update aus dem Spiel neu rein.</p>
        ${PLAYERS.map((p) => `<button class="btn danger" data-reset="${p}">Spieler ${p} zurücksetzen</button>`).join(" ")}</details>` : ""}
    </div>
    ${attemptsPanel(v)}
  </div>`;
}

// Ending an attempt, the kill counter across attempts and the list of past attempts
function attemptsPanel(v) {
  const total = v.deaths.killsTotal || v.deaths.kills;
  const date = (t) => new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  const days = (a, b) => Math.max(1, Math.round((b - a) / 86400000));
  const rows = [...(v.history || [])].reverse().map((h) => `<tr>
    <td><b>#${h.attempt}</b></td><td class="muted small">${date(h.start)} – ${date(h.end)} (${days(h.start, h.end)} T.)</td>
    <td>${PLAYERS.map((p) => `<span class="p${p}" style="color:var(--pc)">${esc(h.names[p])}</span> ${h.kills[p]}`).join(" · ")}</td>
    <td class="muted small">${h.links} Links</td></tr>`).join("");
  return `<div class="panel stack attempts">
    <h2>Versuch #${v.attempt || 1}</h2>
    <p class="muted small">Ist der Run vorbei, startet hier ein neuer Versuch: Teams, Links, Friedhof und Log werden geleert, der alte Versuch kommt in die Liste unten.
      <b>Run-Seite, OBS-Links und config.txt bleiben gleich.</b> Danach startet ihr beide im Spiel einen neuen Spielstand. Der alte wird automatisch ignoriert.</p>
    ${key ? `<label class="small"><input type="checkbox" id="carryKills" checked> Kill-Counter in den neuen Versuch übernehmen</label>
      <div><button class="btn danger" id="newRun">🏁 Run beenden & neuen Versuch starten</button></div>
      <h3>Kill-Counter anpassen</h3>
      <div class="killedit">${PLAYERS.map((p) => `<label class="p${p}"><span style="color:var(--pc)">${esc(playerName(v, p))}</span>
        <input type="number" min="0" max="9999" id="kills${p}" value="${total[p]}"></label>`).join("")}
        <button class="btn" id="saveKills">Speichern</button></div>` : `<p class="muted small">Zum Beenden oder Anpassen erst oben den Schlüssel eintragen.</p>`}
    ${rows ? `<h3>Bisherige Versuche</h3><div class="tablewrap"><table><tbody>${rows}</tbody></table></div>` : ""}
  </div>`;
}

function bind() {
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    storage.set("soullink-tab", tab);
    render();
  }));
  app.querySelectorAll("[data-teammode]").forEach((b) => (b.onclick = () => {
    teamMode = b.dataset.teammode;
    storage.set("soullink-teammode", teamMode);
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
  const newRun = document.getElementById("newRun");
  if (newRun) newRun.onclick = async () => {
    const carry = document.getElementById("carryKills").checked;
    const answer = prompt(`Versuch #${view.attempt || 1} wirklich beenden? Teams, Links und Log werden geleert${carry ? ", der Kill-Counter bleibt" : " und der Kill-Counter beginnt bei 0"}.\nZum Bestätigen NEU eintippen.`);
    if (answer !== "NEU") return;
    if (await act({ type: "newRun", carry, confirm: "NEU" })) toast("Neuer Versuch gestartet – jetzt neue Spielstände anlegen");
  };
  const saveNames = document.getElementById("saveNames");
  if (saveNames) saveNames.onclick = async () => {
    const names = { 1: document.getElementById("name1").value, 2: document.getElementById("name2").value };
    if (await act({ type: "setNames", names })) toast("Namen gespeichert");
  };
  const saveKills = document.getElementById("saveKills");
  if (saveKills) saveKills.onclick = async () => {
    const totals = { 1: Number(document.getElementById("kills1").value), 2: Number(document.getElementById("kills2").value) };
    if (await act({ type: "setKills", totals })) toast("Kill-Counter gespeichert");
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
