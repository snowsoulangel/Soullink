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
