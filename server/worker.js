// Cloudflare Worker + Durable Object for the Soul Link tracker.
// Every run ("room") is one Durable Object that stores its data in SQLite and
// pushes changes to the dashboard and the OBS overlays over WebSockets.

import { DurableObject } from "cloudflare:workers";
import { emptyRoom, applySnapshot, applyAction, buildView, PLAYERS } from "./logic.js";

const ROOM_RE = /^\/api\/rooms\/([a-z0-9]{6,32})(\/[a-z]+)?$/;
const MAX_BODY = 4 * 1024 * 1024;
const SPRITE_KEY_RE = /^[A-Za-z0-9-]{1,80}$/;
const MAX_SPRITE = 512 * 1024;
const MAX_SPRITES = 3000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      if (env.CREATE_PASSWORD) {
        const body = await request.json().catch(() => ({}));
        if (body.password !== env.CREATE_PASSWORD) return json({ error: "Falsches Passwort" }, 403);
      }
      const roomId = randomId(8);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(new Request(`https://room/api/rooms/${roomId}/init`, { method: "POST" }));
    }
    const match = url.pathname.match(ROOM_RE);
    if (match && match[2] !== "/init") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Nicht gefunden" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Sprites exported from the game, keyed by sprite variant (shared by both players).
    this.sql.exec("CREATE TABLE IF NOT EXISTS sprites (k TEXT PRIMARY KEY, png BLOB NOT NULL)");
    this.room = null;
    this.broadcastTimer = null;
  }

  load() {
    if (this.room) return this.room;
    const rows = this.sql.exec("SELECT k, v FROM kv").toArray();
    if (rows.length === 0) return null;
    const data = Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)]));
    if (!data.meta) return null;
    this.room = {
      meta: data.meta,
      manual: data.manual,
      events: data.events || [],
      players: { 1: data.p1, 2: data.p2 },
    };
    return this.room;
  }

  save(...parts) {
    const room = this.room;
    const values = {
      meta: room.meta,
      manual: room.manual,
      events: room.events,
      p1: room.players[1],
      p2: room.players[2],
    };
    for (const part of parts) {
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", part, JSON.stringify(values[part]));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, roomId, action = "/state"] = url.pathname.match(ROOM_RE) || [];
    if (!roomId) return json({ error: "Nicht gefunden" }, 404);

    if (action === "/init" && request.method === "POST") {
      if (this.load()) return json({ error: "Raum existiert bereits" }, 409);
      this.room = emptyRoom({ 1: randomId(16), 2: randomId(16) }, Date.now());
      this.save("meta", "manual", "events", "p1", "p2");
      return json({ room: roomId, keys: this.room.meta.keys });
    }

    const room = this.load();
    if (!room) return json({ error: "Diesen Run gibt es nicht" }, 404);

    // Public reads (no key needed)
    switch (action) {
      case "/state":
        return json(buildView(room, Date.now()));

      case "/ws": {
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "WebSocket erwartet" }, 426);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: "state", view: buildView(room, Date.now()) }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      case "/sprites":
        return json({ keys: this.sql.exec("SELECT k FROM sprites").toArray().map((r) => r.k) });

      case "/sprite": {
        const key = url.searchParams.get("key") || "";
        if (!SPRITE_KEY_RE.test(key)) return json({ error: "Ungültiger Sprite" }, 400);
        if (request.method === "GET") {
          const row = this.sql.exec("SELECT png FROM sprites WHERE k = ?", key).toArray()[0];
          if (!row) return json({ error: "Nicht gefunden" }, 404);
          return new Response(row.png, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
          });
        }
        break; // POST: upload, handled below
      }
    }

    // Writes (player key required)
    switch (action) {
      case "/sprite":
      case "/update":
      case "/ping": {
        if (request.method !== "POST") return json({ error: "POST erwartet" }, 405);
        const player = request.headers.get("X-Player");
        if (!PLAYERS.includes(player) || request.headers.get("X-Key") !== room.meta.keys[player]) {
          return json({ error: "Falscher Spieler oder Schlüssel" }, 403);
        }
        if (action === "/sprite") {
          const png = await request.arrayBuffer();
          const head = new Uint8Array(png, 0, Math.min(4, png.byteLength));
          if (png.byteLength > MAX_SPRITE) return json({ error: "Zu groß" }, 413);
          if (!PNG_MAGIC.every((b, i) => head[i] === b)) return json({ error: "Kein PNG" }, 400);
          const count = this.sql.exec("SELECT COUNT(*) AS n FROM sprites").one().n;
          if (count >= MAX_SPRITES) return json({ error: "Zu viele Sprites" }, 507);
          this.sql.exec("INSERT OR REPLACE INTO sprites (k, png) VALUES (?, ?)", url.searchParams.get("key"), png);
          return json({ ok: true });
        }
        const now = Date.now();
        if (action === "/ping") {
          const wasOffline = now - room.players[player].lastSeen > 120000;
          room.players[player].lastSeen = now;
          this.save(`p${player}`);
          if (wasOffline) this.scheduleBroadcast();
          return json({ ok: true });
        }
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: "Zu groß" }, 413);
        let snap;
        try {
          snap = JSON.parse(text);
        } catch {
          return json({ error: "Ungültiges JSON" }, 400);
        }
        applySnapshot(room, player, snap, now);
        this.save(`p${player}`, "events");
        this.scheduleBroadcast();
        return json({ ok: true });
      }

      case "/action": {
        if (request.method !== "POST") return json({ error: "POST erwartet" }, 405);
        const body = await request.json().catch(() => null);
        if (!body || !body.action) return json({ error: "Ungültige Anfrage" }, 400);
        const actor = PLAYERS.find((p) => body.key && body.key === room.meta.keys[p]);
        if (!actor) return json({ error: "Falscher Schlüssel" }, 403);
        if (body.action.type === "check") return json({ ok: true, player: actor });
        const error = applyAction(room, actor, body.action, Date.now());
        if (error) return json({ error }, 400);
        this.save("meta", "manual", "events", "p1", "p2");
        this.scheduleBroadcast();
        return json({ ok: true, player: actor });
      }

      default:
        return json({ error: "Nicht gefunden" }, 404);
    }
  }

  // Bundles quick successive updates (e.g. HP ticking down) into one message.
  scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const sockets = this.ctx.getWebSockets();
      if (sockets.length === 0) return;
      const message = JSON.stringify({ type: "state", view: buildView(this.room, Date.now()) });
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // socket already closed
        }
      }
    }, 250);
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code, "bye");
    } catch {
      // already closed
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function randomId(length) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}
