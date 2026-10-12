// Shared helpers for the dashboard and the OBS overlays.

export const params = new URLSearchParams(location.search);

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Infinite Fusion species symbols (e.g. "NIDORANfE", "HOOH") -> Showdown sprite ids.
export function spriteId(symbol) {
  const s = String(symbol || "");
  const special = { NIDORANfE: "nidoranf", NIDORANmA: "nidoranm" };
  if (special[s]) return special[s];
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function spriteUrl(symbol, shiny = false) {
  return `https://play.pokemonshowdown.com/sprites/${shiny ? "gen5-shiny" : "gen5"}/${spriteId(symbol)}.png`;
}

// The sprite exported from the game (exactly what the player sees), if any.
export function gameSpriteUrl(mon) {
  const room = params.get("room");
  if (!mon || !mon.sprite || !room) return null;
  return `/api/rooms/${encodeURIComponent(room)}/sprite?key=${encodeURIComponent(mon.sprite)}`;
}

// Game sprite if available; otherwise Showdown sprites (head + body for fusions).
export function spriteHtml(mon, cls = "") {
  if (!mon) return `<div class="sprite ${cls} empty"></div>`;
  const fallback = showdownSpriteHtml(mon, cls);
  const own = gameSpriteUrl(mon);
  if (!own) return fallback;
  const title = mon.fusion && mon.head && mon.body ? ` title="Kopf: ${esc(mon.head.name)} / Körper: ${esc(mon.body.name)}"` : "";
  // on error the Showdown version replaces this element
  return `<div class="sprite game ${cls}"${title}><img src="${esc(own)}" alt="" decoding="sync" data-fallback="${esc(fallback)}" onerror="this.parentNode.outerHTML=this.dataset.fallback"></div>`;
}

function showdownSpriteHtml(mon, cls) {
  const img = (sym, extra = "") =>
    `<img src="${spriteUrl(sym, mon.shiny)}" alt="" decoding="sync" class="${extra}" onerror="if(this.dataset.f){this.style.visibility='hidden'}else{this.dataset.f=1;this.src='${spriteUrl(sym, false)}'}">`;
  if (mon.fusion && mon.head && mon.body) {
    return `<div class="sprite fusion ${cls}" title="Kopf: ${esc(mon.head.name)} / Körper: ${esc(mon.body.name)}">${img(mon.body.species, "body")}${img(mon.head.species, "head")}</div>`;
  }
  return `<div class="sprite ${cls}">${img(mon.species)}</div>`;
}

export function hpPercent(mon) {
  if (!mon || !mon.maxhp) return 0;
  return Math.max(0, Math.min(100, (mon.hp / mon.maxhp) * 100));
}

export function hpClass(mon) {
  const p = hpPercent(mon);
  if (p <= 0) return "hp-zero";
  if (p <= 20) return "hp-red";
  if (p <= 50) return "hp-yellow";
  return "hp-green";
}

export function hpBar(mon, withText = true) {
  const p = hpPercent(mon);
  const key = mon ? `${mon.player}:${mon.id}` : "";
  return `<div class="hpbar ${hpClass(mon)}"><div class="hpfill" data-key="${key}" data-hp="${p}" style="width:${p}%"></div></div>` +
    (withText && mon ? `<div class="hptext">${mon.hp}/${mon.maxhp}</div>` : "");
}

// Lets HP bars slide from their previous value after the HTML was replaced.
const lastHp = new Map();
export function animateHpBars(container) {
  const bars = container.querySelectorAll(".hpfill[data-key]");
  for (const bar of bars) {
    const id = bar.dataset.key + (bar.closest(".partner") ? ":partner" : "");
    const target = Number(bar.dataset.hp);
    const prev = lastHp.get(id);
    lastHp.set(id, target);
    if (prev === undefined || prev === target) continue;
    bar.style.transition = "none";
    bar.style.width = `${prev}%`;
    void bar.offsetWidth;
    bar.style.transition = "";
    bar.style.width = `${target}%`;
  }
}

export function monName(mon) {
  if (!mon) return "—";
  return mon.name || mon.speciesName || "?";
}

export function speciesLabel(mon) {
  if (!mon) return "";
  if (mon.fusion && mon.head && mon.body) return `${mon.head.name}/${mon.body.name}`;
  return mon.speciesName || "";
}

export function locationLabel(mon) {
  if (!mon) return "";
  if (!mon.present) return "nicht mehr da";
  if (mon.inParty) return "im Team";
  if (mon.loc && mon.loc.boxName) return mon.loc.boxName;
  return "PC";
}

export function playerName(view, player) {
  const info = view.players[player] && view.players[player].info;
  return (info && info.name) || `Spieler ${player}`;
}

export function timeAgo(ts) {
  if (!ts) return "nie";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return new Date(ts).toLocaleDateString("de-DE");
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

// Live connection: WebSocket with automatic reconnect, polling as fallback.
export function connect(room, onView, onStatus = () => {}) {
  let ws = null;
  let pollTimer = null;
  let retry = 1000;
  let pingTimer = null;

  const poll = async () => {
    try {
      const res = await fetch(`/api/rooms/${room}/state`, { cache: "no-store" });
      if (res.status === 404) return onStatus("missing");
      if (res.ok) onView(await res.json());
    } catch {
      // offline, try again later
    }
  };

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/rooms/${room}/ws`);
    ws.onopen = () => {
      retry = 1000;
      onStatus("live");
      clearInterval(pollTimer);
      pollTimer = null;
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") onView(msg.view);
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      onStatus("reconnecting");
      if (!pollTimer) pollTimer = setInterval(poll, 5000);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30000);
    };
  };

  poll();
  open();
}
