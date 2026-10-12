import test from "node:test";
import assert from "node:assert/strict";
import { emptyRoom, applySnapshot, applyAction, buildView } from "../server/logic.js";

const tag = (id, seq, route) => ({ id, seq, route });
const mon = (tags, species, extra = {}) => ({
  tags, species, species_name: species[0] + species.slice(1).toLowerCase(), name: species[0] + species.slice(1).toLowerCase(),
  level: 5, hp: 20, maxhp: 20, status: "NONE", fusion: false, box: -1, slot: 0, ...extra,
});
const snap = (party, boxes = [], name = "Ash") => ({ trainer: { name, badges: 0 }, map: "Route 1", party, boxes });

function setup() {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR")]), 1000);
  applySnapshot(room, "2", snap([mon([tag("b1", 1, "Pallet Town")], "CHARMANDER")], [], "Gary"), 1000);
  return room;
}

test("links encounters on the same route", () => {
  const room = setup();
  applySnapshot(room, "1", snap([
    mon([tag("a1", 1, "Pallet Town")], "BULBASAUR"),
    mon([tag("a2", 2, "Route 1")], "RATTATA", { slot: 1 }),
  ]), 2000);
  applySnapshot(room, "2", snap([
    mon([tag("b1", 1, "Pallet Town")], "CHARMANDER"),
    mon([tag("b2", 2, "Route 1")], "PIKACHU", { slot: 1 }),
  ], [], "Gary"), 3000);
  const v = buildView(room, 3000);
  assert.equal(v.routes.length, 2);
  assert.deepEqual(v.routes.map((r) => r.name), ["Pallet Town", "Route 1"]);
  assert.equal(v.routes[1].mon[1], "a2");
  assert.equal(v.routes[1].mon[2], "b2");
  assert.equal(v.routes[1].status, "alive");
  assert.equal(v.mons[1].a2.partner, "b2");
  assert.equal(v.mons[2].b2.partner, "a2");
  assert.ok(v.events.some((e) => e.text.includes("Rattata gefangen")));
});

test("first catch on a route counts, later ones are extras", () => {
  const room = setup();
  applySnapshot(room, "1", snap([
    mon([tag("a1", 1, "Pallet Town")], "BULBASAUR"),
    mon([tag("a2", 2, "Route 1")], "RATTATA"),
    mon([tag("a3", 3, "Route 1")], "PIDGEY"),
  ]), 2000);
  const v = buildView(room, 2000);
  assert.equal(v.routes.find((r) => r.name === "Route 1").mon[1], "a2");
  assert.equal(v.mons[1].a3.extra, true);
  assert.equal(v.routes.find((r) => r.name === "Route 1").status, "open");
});

test("a fainted Pokémon dies and takes its partner's link with it", () => {
  const room = setup();
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", { hp: 0 })]), 2000);
  const v = buildView(room, 2000);
  assert.equal(v.mons[1].a1.dead, true);
  assert.equal(v.routes[0].status, "dead");
  assert.equal(v.deaths.pairs, 1);
  assert.equal(v.deaths[1], 1);
  assert.equal(v.deaths[2], 0);
  // healing afterwards does not bring it back
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", { hp: 20 })]), 3000);
  assert.equal(buildView(room, 3000).mons[1].a1.dead, true);
});

test("a fusion carries both links", () => {
  const room = setup();
  applySnapshot(room, "2", snap([
    mon([tag("b1", 1, "Pallet Town")], "CHARMANDER"),
    mon([tag("b2", 2, "Route 1")], "PIKACHU"),
  ], [], "Gary"), 2000);
  const fused = mon([tag("a1", 1, "Pallet Town"), tag("a2", 2, "Route 1")], "B1H19", {
    fusion: true, head: { species: "RATTATA", name: "Rattata" }, body: { species: "BULBASAUR", name: "Bulbasaur" },
  });
  applySnapshot(room, "1", snap([fused]), 3000);
  let v = buildView(room, 3000);
  assert.equal(v.mons[1].a1.partner, "b1");
  assert.equal(v.mons[1].a2.partner, "b2");
  assert.deepEqual(v.mons[1].a1.fusedWith, ["a2"]);
  assert.equal(v.mons[1].a2.inParty, true);
  // the fusion faints -> both links are dead
  applySnapshot(room, "1", snap([{ ...fused, hp: 0 }]), 4000);
  v = buildView(room, 4000);
  assert.equal(v.deaths.pairs, 2);
});

test("manual corrections: failed encounter, reassignment, revive", () => {
  const room = setup();
  applySnapshot(room, "1", snap([
    mon([tag("a1", 1, "Pallet Town")], "BULBASAUR"),
    mon([tag("a2", 2, "Route 1 Gate")], "RATTATA"),
  ]), 2000);
  assert.equal(applyAction(room, "1", { type: "setRoute", route: "Route 1", routeName: "Route 1", player: "1", value: "a2" }, 2100), null);
  assert.equal(applyAction(room, "1", { type: "setRoute", route: "Route 1", player: "2", value: "failed" }, 2200), null);
  let v = buildView(room, 2300);
  const r1 = v.routes.find((r) => r.key === "route 1");
  assert.equal(r1.mon[1], "a2");
  assert.equal(r1.status, "failed");
  assert.ok(!v.routes.find((r) => r.key === "route 1 gate"), "the gate route has no claim any more");

  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", { hp: 0 })]), 3000);
  assert.equal(buildView(room, 3000).routes[0].status, "dead");
  applyAction(room, "2", { type: "setDead", player: "1", id: "a1", dead: false }, 3100);
  assert.equal(buildView(room, 3100).routes[0].status, "alive");
  assert.equal(applyAction(room, "1", { type: "setRoute", route: "x", player: "1", value: "nope" }, 1), "Pokémon unbekannt");
});

test("Pokémon that disappear stay in the registry", () => {
  const room = setup();
  applySnapshot(room, "1", snap([]), 2000);
  const v = buildView(room, 2000);
  assert.equal(v.mons[1].a1.present, false);
  assert.equal(v.routes[0].mon[1], "a1");
  assert.equal(applyAction(room, "1", { type: "forget", player: "1", id: "a1" }, 2100), null);
  assert.equal(buildView(room, 2100).routes[0].mon[1], null);
});

test("first sync does not spam catch events", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "A")], "BULBASAUR")], [mon([tag("a2", 2, "B")], "PIDGEY", { box: 0 })]), 1);
  assert.equal(room.events.length, 1);
  assert.match(room.events[0].text, /2 Pokémon/);
});

test("cause of death completes the event and the kill counter charges both Pokémon", () => {
  const room = setup();
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", { hp: 0 })]), 2000);
  let v = buildView(room, 2000);
  assert.ok(v.events.some((e) => e.type === "death" && !e.text.includes("durch")));
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", {
    hp: 0, death: { by: "Taubsi", by_level: 7, move: "Tackle", trainer: "Käfersammler Rick", wild: false },
  })]), 2500);
  v = buildView(room, 2500);
  const ev = v.events.filter((e) => e.type === "death");
  assert.equal(ev.length, 1);
  assert.ok(ev[0].text.endsWith("durch Taubsi (Lv. 7) mit Tackle von Käfersammler Rick"));
  assert.equal(v.mons[1].a1.cause, "durch Taubsi (Lv. 7) mit Tackle von Käfersammler Rick");
  assert.deepEqual(v.deaths.kills, { 1: 2, 2: 0 });   // own Pokémon + dragged partner
});

test("a dying fusion is one death but charges every partner once", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "1", snap([
    mon([tag("a1", 1, "Route 1")], "PIDGEY"), mon([tag("a2", 2, "Route 2")], "RATTATA", { slot: 1 })]), 1000);
  applySnapshot(room, "2", snap([
    mon([tag("b1", 1, "Route 1")], "ZUBAT"), mon([tag("b2", 2, "Route 2")], "EKANS", { slot: 1 })], [], "Gary"), 1000);
  // player 1 fuses a1+a2, player 2 keeps two separate partners; the fusion dies
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Route 1"), tag("a2", 2, "Route 2")], "B16H19", { fusion: true, hp: 0 })]), 2000);
  const v = buildView(room, 2000);
  assert.equal(v.deaths[1], 1);
  assert.equal(v.deaths.pairs, 2);
  assert.deepEqual(v.deaths.kills, { 1: 3, 2: 0 });
  assert.equal(v.events.filter((e) => e.type === "death").length, 1);
});

test("title is built from the trainer names unless set by hand", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "1", snap([], [], "Tim"), 1000);
  applySnapshot(room, "2", snap([], [], "Artur"), 1000);
  assert.equal(buildView(room, 1000).title, "Artur & Tim");
  applyAction(room, "1", { type: "setTitle", title: "Unser Run" }, 1100);
  assert.equal(buildView(room, 1100).title, "Unser Run");
});

test("failed wild encounters: first one counts, dupes and later ones do not", () => {
  const room = setup();   // a1 BULBASAUR (Pallet Town) / b1 CHARMANDER
  room.players[1].registry.a1.families = ["BULBASAUR"];
  const fail = (id, seq, route, families, result = "geflohen") =>
    ({ id, seq, route, result, wild: [{ name: "Wild", families }] });
  applySnapshot(room, "1", { ...snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR", { families: ["BULBASAUR"] })]),
    fails: [
      fail("f2", 2, "Route 1", ["PIDGEY", "RATTATA"]),           // counts
      fail("f3", 3, "Route 1", ["ZUBAT"]),                       // route already failed -> late
      fail("f4", 4, "Route 2", ["BULBASAUR", "CATERPIE"]),       // dupe (Bulbasaur line caught)
      fail("f5", 5, "Pallet Town", ["WEEDLE"]),                  // route already has a catch -> late
    ] }, 2000);
  const verdicts = Object.fromEntries(Object.values(room.players[1].fails).map((f) => [f.id, f.verdict]));
  assert.deepEqual(verdicts, { f2: "counts", f3: "late", f4: "dupe", f5: "late" });
  let v = buildView(room, 2000);
  const r1 = v.routes.find((r) => r.name === "Route 1");
  assert.equal(r1.status, "failed");
  assert.equal(r1.failInfo[1], "geflohen: Wild");
  assert.ok(!v.routes.find((r) => r.name === "Route 2"));
  assert.ok(v.events.some((e) => e.type === "dupe"));
  // a catch on Route 1 after the failure is only an extra
  applySnapshot(room, "1", snap([mon([tag("a1", 1, "Pallet Town")], "BULBASAUR"), mon([tag("a6", 6, "Route 1")], "PIDGEY", { slot: 1 })]), 3000);
  v = buildView(room, 3000);
  assert.equal(v.mons[1].a6.extra, true);
  // corrected by hand
  applyAction(room, "1", { type: "setRoute", route: "Route 1", routeName: "Route 1", player: "1", value: "notfailed" }, 4000);
  v = buildView(room, 4000);
  assert.equal(v.routes.find((r) => r.name === "Route 1").mon[1], "a6");
});

test("a failure gets an event even if the player has not caught anything yet", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "2", snap([], [], "Artur"), 1000);
  applySnapshot(room, "2", { ...snap([], [], "Artur"),
    fails: [{ id: "f1", seq: 1, route: "Route 1", result: "geflohen", wild: [{ name: "Zubat", families: ["ZUBAT"] }] }] }, 2000);
  const v = buildView(room, 2000);
  assert.ok(v.events.some((e) => e.type === "fail" && e.text.startsWith("✗ Artur hat's verkackt")));
});

test("new attempt archives the run, carries kills over and ignores the old save file", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  const s = (name, id, party) => ({ trainer: { name, id }, map: "Route 1", party, boxes: [] });
  applySnapshot(room, "1", s("Tim", 111, [mon([tag("a1", 1, "Route 1")], "PIDGEY")]), 1000);
  applySnapshot(room, "2", s("Artur", 222, [mon([tag("b1", 1, "Route 1")], "ZUBAT")]), 1000);
  applySnapshot(room, "1", s("Tim", 111, [mon([tag("a1", 1, "Route 1")], "PIDGEY", { hp: 0 })]), 2000);
  assert.deepEqual(buildView(room, 2000).deaths.killsTotal, { 1: 2, 2: 0 });

  assert.equal(applyAction(room, "1", { type: "newRun", carry: true, confirm: "NEU" }, 3000), null);
  let v = buildView(room, 3000);
  assert.equal(v.attempt, 2);
  assert.equal(v.history.length, 1);
  assert.deepEqual(v.history[0].kills, { 1: 2, 2: 0 });
  assert.deepEqual(v.deaths.killsTotal, { 1: 2, 2: 0 });   // carried over
  assert.equal(v.routes.length, 0);
  assert.ok(v.players[1].waitingNewSave);

  // the old save keeps sending: ignored
  applySnapshot(room, "1", s("Tim", 111, [mon([tag("a1", 1, "Route 1")], "PIDGEY", { hp: 0 })]), 4000);
  assert.equal(Object.keys(room.players[1].registry).length, 0);
  // a new save file is accepted
  applySnapshot(room, "1", s("Tim", 333, [mon([tag("n1", 1, "Route 1")], "RATTATA")]), 5000);
  v = buildView(room, 5000);
  assert.ok(v.mons[1].n1);
  assert.equal(v.players[1].waitingNewSave, false);

  // adjusted by hand
  applyAction(room, "2", { type: "setKills", totals: { 1: 10, 2: 7 } }, 6000);
  assert.deepEqual(buildView(room, 6000).deaths.killsTotal, { 1: 10, 2: 7 });
});

test("fainting before the first Poké Balls does not count", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  const s = (hp, balls) => ({ trainer: { name: "Tim" }, map: "Route 1", balls, party: [mon([tag("a1", 1, "Oak's Lab")], "BULBASAUR", { hp })], boxes: [] });
  applySnapshot(room, "1", s(20, false), 1000);
  applySnapshot(room, "1", s(0, false), 2000);    // rival battle lost, no balls yet
  assert.equal(buildView(room, 2000).mons[1].a1.dead, false);
  applySnapshot(room, "1", s(0, true), 3000);     // got balls while still at 0 HP: still not a death
  assert.equal(buildView(room, 3000).mons[1].a1.dead, false);
  applySnapshot(room, "1", s(20, true), 4000);    // healed
  applySnapshot(room, "1", s(0, true), 5000);     // now it counts
  assert.equal(buildView(room, 5000).mons[1].a1.dead, true);
});

test("display names replace the trainer names", () => {
  const room = emptyRoom({ 1: "k1", 2: "k2" }, 0);
  applySnapshot(room, "1", snap([], [], "Test"), 1000);
  applySnapshot(room, "2", snap([], [], "Spieler2"), 1000);
  applyAction(room, "1", { type: "setNames", names: { 1: "Tim", 2: "Artur" } }, 1100);
  let v = buildView(room, 1100);
  assert.equal(v.players[1].displayName, "Tim");
  assert.equal(v.players[2].displayName, "Artur");
  assert.equal(v.players[1].info.name, "Test");   // the game name stays available
  assert.equal(v.title, "Artur & Tim");
  applyAction(room, "1", { type: "setNames", names: { 1: "", 2: "Artur" } }, 1200);
  assert.equal(buildView(room, 1200).players[1].displayName, "Test");
});