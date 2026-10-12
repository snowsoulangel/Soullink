// Shared helpers for the dashboard and the OBS overlays.

export const params = new URLSearchParams(location.search);

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Only Infinite Fusion sprites are shown:
//   1. the sprite exported from the game (exactly what the player sees)
//   2. the sprite from the official Infinite Fusion sprite archive (by dex number)
//   3. a neutral "?" placeholder
const SPRITE_ARCHIVE = "https://bitbucket.org/infinitefusionsprites/customsprites/raw/main";

export function gameSpriteUrl(mon) {
  const room = params.get("room");
  if (!mon || !mon.sprite || !room) return null;
  return `/api/rooms/${encodeURIComponent(room)}/sprite?key=${encodeURIComponent(mon.sprite)}`;
}

export function archiveSpriteUrl(mon) {
  if (!mon) return null;
  if (mon.fusion) {
    const head = mon.head && Number(mon.head.num);
    const body = mon.body && Number(mon.body.num);
    return head && body ? `${SPRITE_ARCHIVE}/CustomBattlers/${head}.${body}.png` : null;
  }
  return mon.dex ? `${SPRITE_ARCHIVE}/Other/BaseSprites/${Number(mon.dex)}.png` : null;
}

// Tries the next source when an image fails; ends with the placeholder.
window.soullinkSpriteError = (img) => {
  const rest = (img.dataset.next || "").split("|").filter(Boolean);
  if (rest.length) {
    img.dataset.next = rest.slice(1).join("|");
    img.parentNode.classList.toggle("archive", true);
    img.src = rest[0];
  } else {
    img.parentNode.classList.add("nosprite");
    img.remove();
  }
};

export function spriteHtml(mon, cls = "") {
  if (!mon) return `<div class="sprite ${cls} empty"></div>`;
  const own = gameSpriteUrl(mon);
  const archive = archiveSpriteUrl(mon);
  const title = mon.fusion && mon.head && mon.body ? ` title="Kopf: ${esc(mon.head.name)} / Körper: ${esc(mon.body.name)}"` : "";
  const first = own || archive;
  if (!first) return `<div class="sprite game nosprite ${cls}"${title}></div>`;
  const next = own && archive ? archive : "";
  return `<div class="sprite game ${own ? "" : "archive"} ${cls}"${title}><img src="${esc(first)}" alt="" decoding="sync" data-next="${esc(next)}" onerror="soullinkSpriteError(this)"></div>`;
}

// The wild Pokémon of a failed encounter, shaped like a mon so spriteHtml can draw it.
export function wildMon(w) {
  if (!w) return null;
  return {
    name: w.name, sprite: w.sprite, fusion: !!w.fusion, dex: w.dex,
    head: w.head ? { num: w.head, name: w.name } : null, body: w.body ? { num: w.body, name: "" } : null,
  };
}

// "Artur hat's verkackt" + "geflohen: Zubat/Ekans"
export function failLabels(detail) {
  const names = (detail.wild || []).map((w) => w.name).join(" / ");
  return { who: `${detail.by} hat's verkackt`, what: `${detail.result}${names ? `: ${names}` : ""}` };
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

// Display name set on the run page, otherwise the trainer name from the game
export function playerName(view, player) {
  const pl = view.players[player];
  if (pl && pl.displayName) return pl.displayName;
  return (pl && pl.info && pl.info.name) || `Spieler ${player}`;
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
