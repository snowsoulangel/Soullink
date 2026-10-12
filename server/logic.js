// Soul Link logic: keeps a registry of every encounter per player and
// derives links, deaths and the team view from it. Pure functions on plain
// objects so they can be tested without Cloudflare.

export const PLAYERS = ["1", "2"];
const MAX_EVENTS = 300;
const DEFAULT_TITLE = "Soul Link";

export function emptyRoom(keys, now) {
  return {
    meta: { created: now, keys, title: DEFAULT_TITLE },
    players: { 1: emptyPlayer(), 2: emptyPlayer() },
    manual: { routes: {}, dead: {}, ignore: {} },
    events: [],
  };
}

function emptyPlayer() {
  return { info: null, party: [], registry: {}, fails: {}, lastUpdate: 0, lastSeen: 0 };
}

export function other(player) {
  return player === "1" ? "2" : "1";
}

export function routeKey(name) {
  return String(name || "Unbekannt").trim().toLowerCase().replace(/\s+/g, " ");
}

function displayName(entry) {
  return entry.name || entry.speciesName || "?";
}

// extra: optional fields, e.g. { mon } for deaths or { wild } for failed encounters
function pushEvent(room, player, type, text, now, extra = null) {
  room.events.push({ t: now, player, type, text, ...(extra || {}) });
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
}

// Cause of death as sent by the mod, reduced to known fields.
function cleanCause(c) {
  const s = (v) => (v === undefined || v === null ? undefined : String(v).slice(0, 60));
  return {
    by: s(c.by), byLevel: Number(c.by_level) || undefined, move: s(c.move),
    trainer: s(c.trainer), wild: !!c.wild, cause: s(c.cause), map: s(c.map),
  };
}

export function causeText(c) {
  if (!c) return null;
  if (!c.by) return `durch ${c.cause || "Unbekannt"}`;
  let text = `durch ${c.by}${c.byLevel ? ` (Lv. ${c.byLevel})` : ""}`;
  if (c.move) text += ` mit ${c.move}`;
  if (c.trainer) text += ` von ${c.trainer}`;
  else if (c.wild) text += " (wild)";
  return text;
}

function deathText(playerName, e) {
  const cause = causeText(e.deathCause);
  return `☠ ${playerName}: ${displayName(e)} (Lv. ${e.level}, ${e.route}) ist gestorben${cause ? ` – ${cause}` : ""}`;
}

// Applies a snapshot written by the game mod. Returns true if something changed.
export function applySnapshot(room, player, snap, now) {
  const p = room.players[player];
  const saveId = snap.trainer && snap.trainer.id != null ? String(snap.trainer.id) : null;
  // after "new attempt" the old save file is ignored until a new one reports in
  if (p.blockedSave && saveId === p.blockedSave) {
    p.lastSeen = now;
    p.waitingNewSave = true;
    return false;
  }
  p.waitingNewSave = false;
  // Nuzlocke rule: fainting only counts once the player has received Poké Balls
  // (older mods don't report it: count as before)
  const ballsOk = snap.balls !== false;
  if (!p.preBallFainted) p.preBallFainted = {};
  const reg = p.registry;
  const firstSync = Object.keys(reg).length === 0;
  const playerName = (snap.trainer && snap.trainer.name) || `Spieler ${player}`;
  const seen = new Set();
  let newCount = 0;

  const mons = [];
  for (const m of snap.party || []) mons.push(m);
  for (const m of snap.boxes || []) mons.push(m);

  for (const m of mons) {
    const tags = (m.tags || []).filter((t) => t && t.id);
    const ids = tags.map((t) => String(t.id));
    for (const tag of tags) {
      const id = String(tag.id);
      if (seen.has(id)) continue;
      seen.add(id);
      let e = reg[id];
      const isNew = !e;
      if (isNew) {
        e = reg[id] = {
          id,
          seq: Number(tag.seq) || 0,
          route: String(tag.route || "Unbekannt"),
          routeKey: routeKey(tag.route),
          firstSeen: now,
          dead: false,
          deadAt: null,
        };
        newCount++;
      }
      const prev = { species: e.species, fusion: e.fusion, present: e.present, name: e.name };
      Object.assign(e, {
        species: m.species,
        speciesName: m.species_name,
        name: m.name,
        nicknamed: !!m.nicknamed,
        level: m.level,
        hp: m.hp,
        maxhp: m.maxhp,
        status: m.status,
        shiny: !!m.shiny,
        gender: m.gender,
        fusion: !!m.fusion,
        dex: Number(m.dex) || null,
        families: Array.isArray(m.families) ? m.families.slice(0, 4).map((x) => String(x).slice(0, 40)) : e.families || [],
        head: m.head || null,
        body: m.body || null,
        // exported game sprite; keep the last one while a new variant is not exported yet
        sprite: typeof m.sprite === "string" ? m.sprite : prev.fusion === !!m.fusion && prev.species === m.species ? e.sprite || null : null,
        fusedWith: ids.filter((x) => x !== id),
        loc: { box: m.box, slot: m.slot, boxName: m.box_name || null },
        present: true,
        lastSeen: now,
      });

      if (isNew && !firstSync) {
        pushEvent(room, player, "catch", `${playerName} hat ${displayName(e)} gefangen (${e.route})`, now);
      } else if (!isNew) {
        if (prev.fusion !== e.fusion) {
          pushEvent(room, player, e.fusion ? "fuse" : "unfuse",
            e.fusion ? `${playerName}: ${displayName(e)} ist jetzt eine Fusion` : `${playerName}: ${displayName(e)} wurde entfusioniert`, now);
        } else if (prev.species && prev.species !== e.species && !e.fusion) {
          pushEvent(room, player, "evolve", `${playerName}: ${prev.name || "?"} hat sich zu ${e.speciesName} entwickelt`, now);
        }
        if (prev.present === false) {
          pushEvent(room, player, "return", `${playerName}: ${displayName(e)} ist wieder da`, now);
        }
      }

      const primary = id === ids[0];   // a fusion carries several tags: one event per Pokémon
      if (!e.deathCause && m.death && typeof m.death === "object") {
        e.deathCause = cleanCause(m.death);
        // the cause often arrives a moment after HP hit 0: complete the event text
        const ev = primary && e.dead && room.events.find((x) => x.type === "death" && x.player === player && x.mon === id);
        if (ev) ev.text = deathText(playerName, e);
      }
      // fainted before the first Poké Balls: ignored until it is healed
      if (Number(m.hp) > 0) delete p.preBallFainted[id];
      else if (!ballsOk) p.preBallFainted[id] = true;
      if (Number(m.hp) <= 0 && !e.dead && ballsOk && !p.preBallFainted[id]) {
        e.dead = true;
        e.deadAt = now;
        if (primary) pushEvent(room, player, "death", deathText(playerName, e), now, { mon: id });
      }
    }
  }

  for (const e of Object.values(reg)) {
    if (!seen.has(e.id) && e.present !== false) {
      e.present = false;
      e.loc = null;
      if (!firstSync) pushEvent(room, player, "gone", `${playerName}: ${displayName(e)} ist nicht mehr im Team oder PC`, now);
    }
  }

  if (firstSync && newCount > 0) {
    pushEvent(room, player, "sync", `${playerName} ist verbunden (${newCount} Pokémon übernommen)`, now);
  }
  // quiet only for the very first snapshot (old failures from before the run started);
  // a player without any Pokémon yet must still get events
  applyFails(room, player, playerName, snap.fails, now, !p.lastUpdate);

  p.party = (snap.party || []).map((m) => (m.tags && m.tags[0] ? String(m.tags[0].id) : null)).filter(Boolean);
  p.info = {
    name: playerName,
    badges: (snap.trainer && snap.trainer.badges) || 0,
    money: (snap.trainer && snap.trainer.money) || 0,
    map: snap.map || "",
    inBattle: !!snap.in_battle,
    saveId,
    balls: ballsOk,
    gameVersion: snap.game_version || "?",
    modVersion: snap.mod_version || "?",
  };
  p.lastUpdate = now;
  p.lastSeen = now;
  return true;
}

// Wild battles that ended without a catch. Each one gets a verdict once, when it
// first arrives:
//   "counts": first encounter on that route -> the route failed for this player
//   "dupe":   head or body belongs to an evolution line one of you already caught
//             -> dupe clause, the player may try again
//   "late":   the route already had an encounter -> nothing happens
function applyFails(room, player, playerName, fails, now, quiet) {
  const p = room.players[player];
  if (!p.fails) p.fails = {};
  if (!Array.isArray(fails)) return;
  for (const f of fails) {
    if (!f || !f.id || p.fails[f.id]) continue;
    const seq = Number(f.seq) || 0;
    const route = String(f.route || "Unbekannt").slice(0, 80);
    const key = routeKey(route);
    const wild = (Array.isArray(f.wild) ? f.wild : []).slice(0, 3).map((w) => ({
      name: String((w && w.name) || "?").slice(0, 40),
      families: (Array.isArray(w && w.families) ? w.families : []).slice(0, 4).map((x) => String(x).slice(0, 40)),
      fusion: !!(w && w.fusion),
      dex: Number(w && w.dex) || null,
      head: Number(w && w.head) || null,
      body: Number(w && w.body) || null,
      sprite: w && typeof w.sprite === "string" && /^[A-Za-z0-9-]{1,80}$/.test(w.sprite) ? w.sprite : null,
    }));
    const own = Object.values(p.registry);
    const caughtBefore = own.some((e) => e.routeKey === key && e.seq < seq);
    const failedBefore = Object.values(p.fails).some((x) => x.routeKey === key && x.verdict === "counts");
    // evolution lines caught so far by either player (own Pokémon only those caught before this battle)
    const families = new Set();
    for (const e of own) if (e.seq < seq) (e.families || []).forEach((x) => families.add(x));
    for (const e of Object.values(room.players[other(player)].registry)) (e.families || []).forEach((x) => families.add(x));
    const dupeOf = wild.find((w) => w.families.some((x) => families.has(x)));
    let verdict = "counts";
    if (caughtBefore || failedBefore) verdict = "late";
    else if (dupeOf) verdict = "dupe";
    p.fails[f.id] = { id: String(f.id), seq, route, routeKey: key, result: String(f.result || "gescheitert").slice(0, 20), wild, verdict, by: playerName, t: now };
    if (quiet) continue;
    const names = wild.map((w) => w.name).join(" / ") || "?";
    if (verdict === "counts") pushEvent(room, player, "fail", `✗ ${playerName} hat's verkackt: Begegnung auf ${route} gescheitert (${p.fails[f.id].result}: ${names})`, now, { wild });
    if (verdict === "dupe") pushEvent(room, player, "dupe", `↻ ${playerName}: ${dupeOf.name} auf ${route} ist ein Dupe – darf nochmal ins Gras`, now, { wild: [dupeOf] });
  }
}

function playerLabel(room, player) {
  const info = room.players[player].info;
  return (info && info.name) || `Spieler ${player}`;
}

export function failText(f) {
  const names = (f.wild || []).map((w) => w.name).join(" / ");
  return `${f.result}${names ? `: ${names}` : ""}`;
}

export function isDead(room, player, entry) {
  const override = room.manual.dead[`${player}:${entry.id}`];
  return typeof override === "boolean" ? override : !!entry.dead;
}

// Works out which encounter counts for which route.
// Returns { routes: Map(routeKey -> route), claimOf: {player: {tagId: routeKey}} }
export function computeRoutes(room) {
  const routes = new Map();
  const claimOf = { 1: {}, 2: {} };
  const getRoute = (key, name, firstSeen) => {
    let r = routes.get(key);
    if (!r) {
      r = { key, name, firstSeen, seq: Infinity, claims: { 1: null, 2: null }, failed: { 1: false, 2: false }, failInfo: { 1: null, 2: null }, failDetail: { 1: null, 2: null } };
      routes.set(key, r);
    }
    if (firstSeen < r.firstSeen) r.firstSeen = firstSeen;
    return r;
  };

  for (const player of PLAYERS) {
    const reg = room.players[player].registry;
    const manualAssigned = new Set();
    for (const [key, choice] of Object.entries(room.manual.routes)) {
      const value = choice && choice[player];
      if (!value || value === "auto" || value === "notfailed") continue;
      if (value === "failed") {
        const r = getRoute(key, choice.name || key, Infinity);
        r.failed[player] = true;
        r.failDetail[player] = { by: playerLabel(room, player), result: "von Hand markiert", wild: [] };
        continue;
      }
      const e = reg[value];
      if (!e) continue;
      const r = getRoute(key, choice.name || e.route, e.firstSeen);
      r.claims[player] = e.id;
      r.seq = Math.min(r.seq, e.seq);
      claimOf[player][e.id] = key;
      manualAssigned.add(e.id);
    }
    // failed encounters detected by the mod (unless corrected by hand)
    const autoFailed = new Set();
    for (const f of Object.values(room.players[player].fails || {})) {
      if (f.verdict !== "counts") continue;
      const value = room.manual.routes[f.routeKey] && room.manual.routes[f.routeKey][player];
      if (value && value !== "auto") continue;
      const r = getRoute(f.routeKey, f.route, f.t);
      r.failed[player] = true;
      r.failInfo[player] = failText(f);
      r.failDetail[player] = { by: f.by || playerLabel(room, player), result: f.result, wild: f.wild || [] };
      autoFailed.add(f.routeKey);
    }
    const entries = Object.values(reg).sort((a, b) => a.firstSeen - b.firstSeen || a.seq - b.seq);
    for (const e of entries) {
      if (manualAssigned.has(e.id)) continue;
      if (room.manual.ignore[`${player}:${e.id}`]) continue;
      if (autoFailed.has(e.routeKey)) continue;   // caught after the failed encounter: an extra
      const choice = room.manual.routes[e.routeKey];
      const overridden = choice && choice[player] && !["auto", "notfailed"].includes(choice[player]);
      const r = getRoute(e.routeKey, e.route, e.firstSeen);
      if (overridden || r.claims[player]) continue;
      r.claims[player] = e.id;
      r.seq = Math.min(r.seq, e.seq);
      claimOf[player][e.id] = e.routeKey;
    }
  }
  for (const r of routes.values()) {
    if (r.firstSeen === Infinity) r.firstSeen = Number.MAX_SAFE_INTEGER;
  }
  return { routes, claimOf };
}

function monView(room, player, e) {
  return {
    id: e.id,
    player,
    name: e.name,
    nicknamed: e.nicknamed,
    species: e.species,
    speciesName: e.speciesName,
    level: e.level,
    hp: e.hp,
    maxhp: e.maxhp,
    status: e.status,
    shiny: e.shiny,
    gender: e.gender,
    fusion: e.fusion,
    dex: e.dex || null,
    head: e.head,
    body: e.body,
    sprite: e.sprite || null,
    fusedWith: e.fusedWith || [],
    route: e.route,
    routeKey: e.routeKey,
    loc: e.loc,
    present: e.present !== false,
    inParty: false,
    dead: isDead(room, player, e),
    deadAt: e.deadAt,
    cause: causeText(e.deathCause),
    ignored: !!room.manual.ignore[`${player}:${e.id}`],
  };
}

// Builds everything the dashboard and the overlays need.
export function buildView(room, now) {
  const { routes, claimOf } = computeRoutes(room);
  const mons = { 1: {}, 2: {} };
  for (const player of PLAYERS) {
    const p = room.players[player];
    for (const e of Object.values(p.registry)) mons[player][e.id] = monView(room, player, e);
    for (const id of p.party) if (mons[player][id]) mons[player][id].inParty = true;
    // the second tag of a fusion is in the party too
    for (const id of p.party) {
      const m = mons[player][id];
      if (m) for (const f of m.fusedWith) if (mons[player][f]) mons[player][f].inParty = true;
    }
  }

  const routeList = [...routes.values()]
    .sort((a, b) => a.firstSeen - b.firstSeen || a.seq - b.seq || a.name.localeCompare(b.name))
    .map((r) => {
      const a = r.claims[1] ? mons[1][r.claims[1]] : null;
      const b = r.claims[2] ? mons[2][r.claims[2]] : null;
      let status;
      if (r.failed[1] || r.failed[2]) status = "failed";
      else if ((a && a.dead) || (b && b.dead)) status = "dead";
      else if (a && b) status = "alive";
      else status = "open";
      return {
        key: r.key,
        name: r.name,
        status,
        mon: { 1: r.claims[1], 2: r.claims[2] },
        failed: { 1: r.failed[1], 2: r.failed[2] },
        failInfo: r.failInfo,
        failDetail: r.failDetail,
        choice: room.manual.routes[r.key] || null,
      };
    });
  const routeByKey = Object.fromEntries(routeList.map((r) => [r.key, r]));

  // Partner info on every mon
  for (const player of PLAYERS) {
    for (const m of Object.values(mons[player])) {
      const key = claimOf[player][m.id];
      m.linkRoute = key || null;
      m.extra = !key;
      const r = key ? routeByKey[key] : null;
      m.partner = r ? r.mon[other(player)] : null;
      m.linkStatus = r ? r.status : "none";
      // the partner's encounter failed: who and against which wild Pokémon
      m.partnerFail = r && r.failed[other(player)] ? r.failDetail[other(player)] || null : null;
    }
  }

  const kills = countKills(mons);
  const offset = room.meta.killOffset || {};
  // killsTotal: carried over from earlier attempts or adjusted by hand + this attempt
  const killsTotal = { 1: kills[1] + (offset[1] || 0), 2: kills[2] + (offset[2] || 0) };
  const deaths = { pairs: 0, 1: 0, 2: 0, kills, killsTotal };
  for (const r of routeList) if (r.status === "dead") deaths.pairs++;
  // own Pokémon that died (a fusion counts once)
  for (const player of PLAYERS) deaths[player] = deadUnits(mons, player).length;

  const players = {};
  for (const player of PLAYERS) {
    const p = room.players[player];
    players[player] = {
      info: p.info,
      party: p.party.filter((id) => mons[player][id]),
      lastUpdate: p.lastUpdate,
      lastSeen: p.lastSeen,
      online: now - p.lastSeen < 120000,
      waitingNewSave: !!p.waitingNewSave,
    };
  }

  return {
    title: runTitle(room),
    created: room.meta.created,
    attempt: room.meta.attempt || 1,
    attemptStart: room.meta.attemptStart || room.meta.created,
    history: room.meta.history || [],
    now,
    players,
    mons,
    routes: routeList,
    deaths,
    events: room.events.slice(-100).reverse(),
  };
}

// A "unit" is one Pokémon as it exists in the game: a fusion carries several tags.
export function unitKey(m) {
  return [m.id, ...(m.fusedWith || [])].sort().join("+");
}

function deadUnits(mons, player) {
  const seen = new Set();
  const list = [];
  for (const m of Object.values(mons[player])) {
    if (!m.dead || seen.has(unitKey(m))) continue;
    seen.add(unitKey(m));
    list.push(m);
  }
  return list;
}

// Kill counter: whoever loses a Pokémon first is charged with it and with every
// partner Pokémon it drags into death. Each Pokémon is counted once.
export function countKills(mons) {
  const kills = { 1: 0, 2: 0 };
  const counted = new Set();
  const deaths = PLAYERS.flatMap((p) => deadUnits(mons, p).map((m) => ({ p, m })))
    .sort((a, b) => (a.m.deadAt || 0) - (b.m.deadAt || 0));
  for (const { p, m } of deaths) {
    const key = `${p}:${unitKey(m)}`;
    if (counted.has(key)) continue;
    counted.add(key);
    kills[p]++;
    const op = other(p);
    for (const t of [m.id, ...(m.fusedWith || [])]) {
      const tm = mons[p][t];
      const pm = tm && tm.partner ? mons[op][tm.partner] : null;
      if (!pm) continue;
      const pkey = `${op}:${unitKey(pm)}`;
      if (counted.has(pkey)) continue;
      counted.add(pkey);
      kills[p]++;
    }
  }
  return kills;
}

// Title of the run: set by hand, otherwise built from the trainer names ("Artur & Tim").
export function runTitle(room) {
  if (room.meta.titleSet || room.meta.title !== DEFAULT_TITLE) return room.meta.title;
  const names = PLAYERS.map((p) => room.players[p].info && room.players[p].info.name).filter(Boolean);
  if (!names.length) return DEFAULT_TITLE;
  return names.sort((a, b) => a.localeCompare(b, "de")).join(" & ");
}

// Manual corrections from the dashboard. Returns an error string or null.
export function applyAction(room, actor, action, now) {
  const actorName = (room.players[actor].info && room.players[actor].info.name) || `Spieler ${actor}`;
  switch (action.type) {
    case "setTitle": {
      const title = String(action.title || "").slice(0, 80).trim();
      if (!title) return "Titel fehlt";
      room.meta.title = title;
      room.meta.titleSet = true;   // keep it even if it equals the default
      return null;
    }
    case "setRoute": {
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      const key = routeKey(action.route);
      const value = String(action.value || "auto");
      if (!["auto", "failed", "notfailed"].includes(value) && !room.players[player].registry[value]) return "Pokémon unbekannt";
      const choice = room.manual.routes[key] || { name: action.routeName || action.route };
      choice[player] = value;
      const isAuto = (v) => !v || v === "auto";
      if (isAuto(choice[1]) && isAuto(choice[2])) delete room.manual.routes[key];
      else room.manual.routes[key] = choice;
      if (value === "failed") pushEvent(room, player, "failed", `${choice.name}: Begegnung von Spieler ${player} als gescheitert markiert (${actorName})`, now);
      if (value === "notfailed") pushEvent(room, player, "failed", `${choice.name}: Begegnung von Spieler ${player} zählt doch nicht als gescheitert (${actorName})`, now);
      return null;
    }
    case "setDead": {
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      const e = room.players[player].registry[action.id];
      if (!e) return "Pokémon unbekannt";
      const dead = !!action.dead;
      if (dead === !!e.dead) delete room.manual.dead[`${player}:${e.id}`];
      else room.manual.dead[`${player}:${e.id}`] = dead;
      pushEvent(room, player, dead ? "death" : "revive",
        dead ? `☠ ${displayName(e)} wurde von ${actorName} als tot markiert` : `${displayName(e)} wurde von ${actorName} wiederbelebt (Korrektur)`, now);
      return null;
    }
    case "setIgnore": {
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      const e = room.players[player].registry[action.id];
      if (!e) return "Pokémon unbekannt";
      if (action.ignore) room.manual.ignore[`${player}:${e.id}`] = true;
      else delete room.manual.ignore[`${player}:${e.id}`];
      return null;
    }
    case "forget": {
      // removes a Pokémon that should never have been tracked (e.g. a test save)
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      const e = room.players[player].registry[action.id];
      if (!e) return "Pokémon unbekannt";
      if (e.present !== false) return "Nur Pokémon, die nicht mehr im Spiel sind, können entfernt werden";
      delete room.players[player].registry[action.id];
      delete room.manual.dead[`${player}:${e.id}`];
      delete room.manual.ignore[`${player}:${e.id}`];
      return null;
    }
    case "newRun": {
      // Ends the current attempt: archives its numbers, optionally carries the kill
      // counter over, and clears teams/links/log. Keys, links and overlays stay the same.
      if (action.confirm !== "NEU") return "Bestätigung fehlt";
      const v = buildView(room, now);
      const meta = room.meta;
      const attempt = meta.attempt || 1;
      const history = meta.history || (meta.history = []);
      history.push({
        attempt, start: meta.attemptStart || meta.created, end: now,
        names: { 1: playerLabel(room, "1"), 2: playerLabel(room, "2") },
        kills: { ...v.deaths.kills }, deaths: { 1: v.deaths[1], 2: v.deaths[2] },
        links: v.routes.filter((r) => r.status !== "failed").length,
      });
      if (history.length > 50) history.splice(0, history.length - 50);
      const offset = meta.killOffset || (meta.killOffset = { 1: 0, 2: 0 });
      if (action.carry !== false) for (const p of PLAYERS) offset[p] = (offset[p] || 0) + (v.deaths.kills[p] || 0);
      meta.attempt = attempt + 1;
      meta.attemptStart = now;
      for (const p of PLAYERS) {
        const info = room.players[p].info;
        room.players[p] = emptyPlayer();
        room.players[p].info = info;   // keep the names until the new save files report in
        room.players[p].blockedSave = (info && info.saveId) || null;
        room.players[p].waitingNewSave = !!(info && info.saveId);
      }
      room.manual = { routes: {}, dead: {}, ignore: {} };
      room.events = [];
      pushEvent(room, actor, "newrun", `🏁 Versuch #${attempt} beendet (${actorName}). Versuch #${attempt + 1} beginnt – neue Spielstände starten!`, now);
      return null;
    }
    case "setKills": {
      // sets the displayed kill totals by hand; stored as an offset to this attempt's kills
      const kills = buildView(room, now).deaths.kills;
      const offset = room.meta.killOffset || (room.meta.killOffset = { 1: 0, 2: 0 });
      for (const p of PLAYERS) {
        const total = Math.round(Number(action.totals && action.totals[p]));
        if (!Number.isFinite(total) || total < 0 || total > 9999) return "Ungültige Zahl";
        offset[p] = total - (kills[p] || 0);
      }
      pushEvent(room, actor, "kills", `Kill-Counter von ${actorName} angepasst: ${playerLabel(room, "1")} ${action.totals[1]}, ${playerLabel(room, "2")} ${action.totals[2]}`, now);
      return null;
    }
    case "resetPlayer": {
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      if (action.confirm !== "RESET") return "Bestätigung fehlt";
      room.players[player] = emptyPlayer();
      for (const key of Object.keys(room.manual.dead)) if (key.startsWith(`${player}:`)) delete room.manual.dead[key];
      for (const key of Object.keys(room.manual.ignore)) if (key.startsWith(`${player}:`)) delete room.manual.ignore[key];
      for (const choice of Object.values(room.manual.routes)) delete choice[player];
      pushEvent(room, player, "reset", `Daten von Spieler ${player} wurden von ${actorName} zurückgesetzt`, now);
      return null;
    }
    default:
      return "Unbekannte Aktion";
  }
}
