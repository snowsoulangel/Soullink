// Soul Link logic: keeps a registry of every encounter per player and
// derives links, deaths and the team view from it. Pure functions on plain
// objects so they can be tested without Cloudflare.

export const PLAYERS = ["1", "2"];
const MAX_EVENTS = 300;

export function emptyRoom(keys, now) {
  return {
    meta: { created: now, keys, title: "Soul Link" },
    players: { 1: emptyPlayer(), 2: emptyPlayer() },
    manual: { routes: {}, dead: {}, ignore: {} },
    events: [],
  };
}

function emptyPlayer() {
  return { info: null, party: [], registry: {}, lastUpdate: 0, lastSeen: 0 };
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

function pushEvent(room, player, type, text, now) {
  room.events.push({ t: now, player, type, text });
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
}

// Applies a snapshot written by the game mod. Returns true if something changed.
export function applySnapshot(room, player, snap, now) {
  const p = room.players[player];
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

      if (Number(m.hp) <= 0 && !e.dead) {
        e.dead = true;
        e.deadAt = now;
        pushEvent(room, player, "death", `☠ ${playerName}: ${displayName(e)} (Lv. ${e.level}, ${e.route}) ist gestorben`, now);
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

  p.party = (snap.party || []).map((m) => (m.tags && m.tags[0] ? String(m.tags[0].id) : null)).filter(Boolean);
  p.info = {
    name: playerName,
    badges: (snap.trainer && snap.trainer.badges) || 0,
    money: (snap.trainer && snap.trainer.money) || 0,
    map: snap.map || "",
    inBattle: !!snap.in_battle,
    gameVersion: snap.game_version || "?",
    modVersion: snap.mod_version || "?",
  };
  p.lastUpdate = now;
  p.lastSeen = now;
  return true;
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
      r = { key, name, firstSeen, seq: Infinity, claims: { 1: null, 2: null }, failed: { 1: false, 2: false } };
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
      if (!value || value === "auto") continue;
      if (value === "failed") {
        const r = getRoute(key, choice.name || key, Infinity);
        r.failed[player] = true;
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
    const entries = Object.values(reg).sort((a, b) => a.firstSeen - b.firstSeen || a.seq - b.seq);
    for (const e of entries) {
      if (manualAssigned.has(e.id)) continue;
      if (room.manual.ignore[`${player}:${e.id}`]) continue;
      const choice = room.manual.routes[e.routeKey];
      const overridden = choice && choice[player] && choice[player] !== "auto";
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
    }
  }

  const deaths = { pairs: 0, 1: 0, 2: 0 };
  for (const r of routeList) if (r.status === "dead") deaths.pairs++;
  for (const player of PLAYERS) for (const m of Object.values(mons[player])) if (m.dead) deaths[player]++;

  const players = {};
  for (const player of PLAYERS) {
    const p = room.players[player];
    players[player] = {
      info: p.info,
      party: p.party.filter((id) => mons[player][id]),
      lastUpdate: p.lastUpdate,
      lastSeen: p.lastSeen,
      online: now - p.lastSeen < 120000,
    };
  }

  return {
    title: room.meta.title,
    created: room.meta.created,
    now,
    players,
    mons,
    routes: routeList,
    deaths,
    events: room.events.slice(-100).reverse(),
  };
}

// Manual corrections from the dashboard. Returns an error string or null.
export function applyAction(room, actor, action, now) {
  const actorName = (room.players[actor].info && room.players[actor].info.name) || `Spieler ${actor}`;
  switch (action.type) {
    case "setTitle": {
      const title = String(action.title || "").slice(0, 80).trim();
      if (!title) return "Titel fehlt";
      room.meta.title = title;
      return null;
    }
    case "setRoute": {
      const player = String(action.player);
      if (!PLAYERS.includes(player)) return "Ungültiger Spieler";
      const key = routeKey(action.route);
      const value = String(action.value || "auto");
      if (value !== "auto" && value !== "failed" && !room.players[player].registry[value]) return "Pokémon unbekannt";
      const choice = room.manual.routes[key] || { name: action.routeName || action.route };
      choice[player] = value;
      const isAuto = (v) => !v || v === "auto";
      if (isAuto(choice[1]) && isAuto(choice[2])) delete room.manual.routes[key];
      else room.manual.routes[key] = choice;
      if (value === "failed") pushEvent(room, player, "failed", `${choice.name}: Begegnung von Spieler ${player} als gescheitert markiert (${actorName})`, now);
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
