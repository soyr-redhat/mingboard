import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BoardStore, SnapshotConflictError } from "../src/store.mjs";

const repo = "mgoin/pingboard";
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "pingboard-store-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("pingboard-store-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "board.json");
  return { filePath, store: new BoardStore(filePath) };
}

test("concurrent stores persist unique pins; removals preserve groups and preferences", async (t) => {
  const { filePath, store } = await setup(t);
  const other = new BoardStore(filePath);
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    (i % 2 ? other : store).track({ repo, number: i + 1, group: "Release" })));
  const saved = await new BoardStore(filePath).read();
  assert.equal(saved.board.pins.length, 8);
  assert.equal(new Set(saved.board.pins.map((pin) => pin.key)).size, 8);
  assert.deepEqual(saved.board.groups.map((group) => group.name), ["Tracking", "Release"]);
  assert.equal((await store.track({ repo, number: 1, group: "Other" })).added, false);
  assert.deepEqual(await store.read(), saved);
  assert.equal((await store.untrack({ repo, number: 1 })).removed, 1);
  await assert.rejects(store.clear({ scope: "selected" }), /explicit/);
  assert.equal((await store.clear({ scope: "selected", keys: [`${repo}#2`] })).removed, 1);
  assert.equal((await store.clear()).removed, 6);
  assert.deepEqual(await store.read(), { ...saved, board: { ...saved.board, pins: [] } });
});

test("imports merge groups and pins, roundtrip exports, and exclude secret fields", async (t) => {
  const { filePath, store } = await setup(t);
  const original = await store.track({ repo, number: 1, group: "Release" });
  const backup = {
    pingboard: 1,
    board: {
      groups: [{ id: "external", name: "RELEASE" }],
      pins: [1, 2].map((number) => ({ repo, number, group: "external", addedAt: 123, token: "secret" }))
    },
    prefs: { interval: 120, sort: "status", filter: "requested", owner: "others", token: "secret" }
  };
  const merged = await store.importBoard(backup);
  assert.deepEqual(merged.board.groups.map((group) => group.name), ["Tracking", "Release"]);
  assert.deepEqual(merged.board.pins[0], original.pin);
  assert.equal(merged.board.pins[1].group, original.pin.group);
  const exported = await store.exportBoard();
  assert.equal(exported.pingboard, 1);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.equal(exported.prefs.interval, 120);
  assert.equal(exported.prefs.sort, "status");
  assert.equal(exported.prefs.filter, "requested");
  assert.equal(exported.prefs.owner, "others");
  assert.deepEqual(await new BoardStore(filePath).read(), merged);
  assert.ok(!JSON.stringify(exported).includes("secret"));
  assert.ok(!(await readFile(filePath, "utf8")).includes("secret"));
  await store.clear();
  assert.deepEqual(await store.importBoard(exported, { mode: "replace" }), merged);
  await assert.rejects(store.importBoard({ ...backup, pingboard: 2 }), /Unsupported/);
});

test("browser search groups preserve metadata and remap search-pinned sources across imports", async (t) => {
  const { filePath, store } = await setup(t);
  const fixture = JSON.parse(await readFile(new URL("../../tests/fixtures/v3-search-groups.json", import.meta.url), "utf8"));
  const backup = {
    board: fixture.localStorage[`pingboard.v3.${fixture.login}.board`],
    prefs: fixture.localStorage[`pingboard.v3.${fixture.login}.prefs`]
  };
  const original = await store.track({ repo, number: 99, group: "Review requests" });
  const merged = await store.importBoard(backup);
  const source = backup.board.groups.find((group) => group.query);
  const target = merged.board.groups.find((group) => group.id === original.pin.group);
  assert.notEqual(target.id, source.id);
  assert.equal(target.query, source.query);
  assert.deepEqual(target.dismissed, source.dismissed);
  assert.equal(merged.prefs.unpinClosed, true);
  for (const pin of backup.board.pins.filter((pin) => pin.via)) {
    const imported = merged.board.pins.find((item) => item.key === pin.key);
    assert.equal(imported.via, target.id);
    assert.equal(imported.group, pin.group === source.id ? target.id : "g1");
  }
  assert.deepEqual(await new BoardStore(filePath).read(), merged);
  const exported = await store.exportBoard();
  assert.deepEqual(exported.board, merged.board);
  assert.deepEqual(exported.prefs, merged.prefs);
  await store.clear();
  assert.deepEqual(await store.importBoard(exported, { mode: "replace" }), merged);

  const conflicting = structuredClone(backup);
  const conflictingGroup = conflicting.board.groups.find((group) => group.query);
  conflictingGroup.query = "repo:vllm-project/vllm author:someone";
  conflictingGroup.dismissed = [];
  assert.deepEqual(await store.importBoard(conflicting), merged);
});

test("corrupt files reject writes without losing data, and the queue recovers", async (t) => {
  const { filePath, store } = await setup(t);
  const saved = await store.exportBoard();
  const malformed = { ...saved, board: { ...saved.board, pins: [{ repo: "invalid", number: 1 }] } };
  for (const bad of ["{invalid JSON", JSON.stringify(malformed)]) {
    await writeFile(filePath, bad);
    await assert.rejects(store.track({ repo, number: 1 }), /original file was left unchanged/);
    assert.equal(await readFile(filePath, "utf8"), bad);
  }
  await writeFile(filePath, JSON.stringify(saved));
  assert.equal((await store.track({ repo, number: 1 })).added, true);
});

test("default repository switches preserve mixed pins and independent repository profiles", async (t) => {
  const { filePath, store } = await setup(t);
  await store.track({ repo: "vllm-project/vllm", number: 1 });
  await store.track({ repo, number: 2, group: "Release" });
  await store.setProfile(repo, { ciPrefix: "custom/", ciCommands: { run: "/test" } });
  const before = await store.read();
  const switched = await store.setDefaultRepo(repo);
  assert.equal(switched.previousDefaultRepo, "vllm-project/vllm");
  assert.equal(switched.profile.ciCommands.run, "/test");
  assert.equal(switched.profile.ciPrefix, "custom/");
  assert.deepEqual(await new BoardStore(filePath).read(), { ...before, prefs: { ...before.prefs, defaultRepo: repo } });
  const generic = await store.setDefaultRepo("other/repo");
  assert.equal(generic.previousDefaultRepo, repo);
  assert.equal(generic.profile.ciPrefix, null);
  assert.equal(generic.profile.ciCommands, null);
  const expected = { ...before, prefs: { ...before.prefs, defaultRepo: "other/repo" } };
  await assert.rejects(store.setDefaultRepo("invalid"), /owner\/repo/);
  assert.deepEqual(await new BoardStore(filePath).read(), expected);
});

test("stale browser snapshots cannot erase a pin added by the MCP store", async (t) => {
  const { filePath, store } = await setup(t);
  await store.track({ repo, number: 1 });
  const browser = await store.readSnapshot();
  const mcp = new BoardStore(filePath);
  await mcp.track({ repo, number: 2 });
  const authoritative = await mcp.readSnapshot();
  const unchanged = await readFile(filePath, "utf8");
  assert.notEqual(authoritative.revision, browser.revision);
  browser.board.groups[0].name = "Browser edit";
  await assert.rejects(store.replaceSnapshot(browser, browser.revision), (error) => {
    assert.ok(error instanceof SnapshotConflictError);
    assert.equal(error.status, 409);
    assert.deepEqual(error.snapshot, authoritative);
    return true;
  });
  assert.equal(await readFile(filePath, "utf8"), unchanged);
  assert.deepEqual((await store.read()).board.pins.map((pin) => pin.number), [1, 2]);
});

test("two concurrent browser writers using one revision produce one winner and one conflict", async (t) => {
  const { filePath, store } = await setup(t);
  const first = await store.readSnapshot();
  const second = structuredClone(first);
  first.board.groups[0].name = "First browser";
  second.board.groups[0].name = "Second browser";
  const attempts = await Promise.allSettled([
    store.replaceSnapshot(first, first.revision),
    new BoardStore(filePath).replaceSnapshot(second, second.revision)
  ]);
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  const conflicts = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.status, 409);
  assert.deepEqual(conflicts[0].reason.snapshot, winners[0].value);
  assert.deepEqual(await store.readSnapshot(), winners[0].value);
});

test("snapshot saves preserve normalized browser metadata and the legacy disk format", async (t) => {
  const { filePath, store } = await setup(t);
  const fixture = JSON.parse(await readFile(new URL("../../tests/fixtures/v3-search-groups.json", import.meta.url), "utf8"));
  await store.importBoard({
    board: fixture.localStorage[`pingboard.v3.${fixture.login}.board`],
    prefs: fixture.localStorage[`pingboard.v3.${fixture.login}.prefs`]
  }, { mode: "replace" });
  const before = await store.readSnapshot();
  const edited = structuredClone(before);
  edited.prefs.sort = "status";
  edited.prefs.filter = "requested";
  edited.prefs.owner = "others";
  const saved = await store.replaceSnapshot(edited, before.revision);
  assert.notEqual(saved.revision, before.revision);
  assert.deepEqual(saved.board, before.board);
  assert.deepEqual(saved.prefs, edited.prefs);
  assert.equal(saved.prefs.unpinClosed, true);
  assert.deepEqual(await new BoardStore(filePath).read(), { board: saved.board, prefs: saved.prefs });
  const disk = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(disk, { pingboard: 1, board: saved.board, prefs: saved.prefs });
  assert.deepEqual(await store.replaceSnapshot(saved, saved.revision), saved);

  const reordered = { prefs: Object.fromEntries(Object.entries(saved.prefs).reverse()), board: saved.board };
  assert.equal((await store.replaceSnapshot(reordered, saved.revision)).revision, saved.revision);
  await store.setDefaultRepo("other/repo");
  assert.notEqual((await store.readSnapshot()).revision, saved.revision);
});

test("incomplete or malformed snapshots fail without normalizing away stored data", async (t) => {
  const { filePath, store } = await setup(t);
  await store.track({ repo, number: 1 });
  const saved = await store.readSnapshot();
  const unchanged = await readFile(filePath, "utf8");
  const malformed = [undefined, {}, { board: saved.board }, { prefs: saved.prefs }];
  for (const change of [
    (value) => { delete value.board.pins; },
    (value) => { value.board.groups = []; },
    (value) => { value.board.groups.push(null); },
    (value) => { value.board.groups.push({ ...value.board.groups[0] }); },
    (value) => { value.board.pins.push({ ...value.board.pins[0] }); },
    (value) => { value.board.pins[0].number = 0; },
    (value) => { value.board.pins[0].key = "wrong/key#1"; },
    (value) => { value.board.pins[0].group = "missing"; },
    (value) => { value.board.pins[0].via = "missing"; },
    (value) => { value.board.pins[0].addedAt = Infinity; },
    (value) => { value.board.groups[0].query = "repo:mgoin/pingboard"; value.board.groups[0].dismissed = Array(201).fill(`${repo}#2`); },
    (value) => { delete value.prefs.defaultRepo; },
    (value) => { value.prefs.boardWidth = Infinity; },
    (value) => { value.prefs = null; }
  ]) {
    const value = structuredClone(saved);
    change(value);
    malformed.push(value);
  }
  for (const value of malformed) {
    await assert.rejects(store.replaceSnapshot(value, saved.revision), (error) => error.status === 400);
    assert.equal(await readFile(filePath, "utf8"), unchanged);
  }
  for (const revision of [undefined, null, "", "invalid"]) {
    await assert.rejects(store.replaceSnapshot(saved, revision), (error) => error.status === 400);
  }
  assert.deepEqual(await store.readSnapshot(), saved);
});
