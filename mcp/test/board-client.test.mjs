import test from "node:test";
import assert from "node:assert/strict";
import Client from "../../board-client.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
const snapshot = (revision, pins = []) => ({ revision, board: { groups: [{ id: "g1", name: "Tracking", collapsed: false }], pins }, prefs: {} });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(handle) {
  const applied = [];
  const errors = [];
  const requests = [];
  const client = Client.createBoardClient({
    fetchImpl: async (path, options) => {
      requests.push({ path, ...options });
      if (path === "/api/session") return reply({ user: { login: "tester" }, csrfToken: "local-capability", snapshot: snapshot("r1") });
      return handle(path, options);
    },
    onSnapshot: (value, reason) => applied.push({ value, reason }),
    onError: (message) => errors.push(message)
  });
  return { client, applied, errors, requests };
}

test("coalesces synchronous edits and serializes later writes against the acknowledged revision", async () => {
  const first = deferred();
  const puts = [];
  const { client, applied, errors } = fixture(async (path, options) => {
    assert.equal(path, "/api/board");
    const body = JSON.parse(options.body);
    puts.push(body);
    if (puts.length === 1) return first.promise;
    return reply({ ...body, revision: "r3" });
  });
  await client.load();
  client.save(snapshot("ignored", [{ number: 1 }]));
  client.save(snapshot("ignored", [{ number: 2 }]));
  await Promise.resolve();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].board.pins, [{ number: 2 }]);
  client.save(snapshot("ignored", [{ number: 3 }]));
  first.resolve(reply(snapshot("r2", [{ number: 2 }])));
  await client.flush();
  assert.deepEqual(puts.map((body) => body.expectedRevision), ["r1", "r2"]);
  assert.deepEqual(applied.at(-1).value.board.pins, [{ number: 3 }]);
  assert.deepEqual(errors, []);
  client.stop();
});

test("a polling response started before a local edit cannot overwrite the edit", async () => {
  const oldPoll = deferred();
  const { client, applied } = fixture(async (path, options) => {
    if (!options.method) return oldPoll.promise;
    const body = JSON.parse(options.body);
    return reply({ ...body, revision: "r2" });
  });
  await client.load();
  const polling = client.poll();
  client.save(snapshot("ignored", [{ number: 7 }]));
  await client.flush();
  oldPoll.resolve(reply(snapshot("external-old", [{ number: 8 }])));
  await polling;
  assert.deepEqual(applied.at(-1).value.board.pins, [{ number: 7 }]);
  assert.ok(!applied.some((item) => item.value.revision === "external-old"));
  client.stop();
});

test("a conflict adopts the MCP board and discards queued stale writes without retrying them", async () => {
  const pending = deferred();
  let puts = 0;
  const { client, applied, errors } = fixture(async () => { puts += 1; return pending.promise; });
  await client.load();
  client.save(snapshot("ignored", [{ number: 1 }]));
  await Promise.resolve();
  client.save(snapshot("ignored", [{ number: 2 }]));
  pending.resolve(reply({ error: "Changed elsewhere", snapshot: snapshot("mcp", [{ number: 99 }]) }, 409));
  await client.flush();
  assert.equal(puts, 1);
  assert.deepEqual(applied.at(-1), { value: snapshot("mcp", [{ number: 99 }]), reason: "conflict" });
  assert.match(errors[0], /last edit was not saved/);
  assert.equal(client.isWritable(), true);
  client.stop();
});

test("an ambiguous failed save disconnects, then reloads authoritative state before further writes", async () => {
  let sessions = 0;
  let puts = 0;
  const applied = [];
  const errors = [];
  const requests = [];
  const client = Client.createBoardClient({
    fetchImpl: async (path, options) => {
      requests.push({ path, options });
      if (path === "/api/session") {
        sessions += 1;
        return reply({ user: { login: "tester" }, csrfToken: `cap-${sessions}`,
          snapshot: sessions === 1 ? snapshot("r1") : snapshot("r2", [{ number: 4 }]) });
      }
      puts += 1;
      if (puts === 1) throw new Error("Connection closed");
      const body = JSON.parse(options.body);
      assert.equal(body.expectedRevision, "r2");
      assert.equal(options.headers["X-Mingboard-Token"], "cap-2");
      return reply({ ...body, revision: "r3" });
    },
    onSnapshot: (value) => applied.push(clone(value)), onError: (message) => errors.push(message)
  });
  await client.load();
  client.save(snapshot("ignored", [{ number: 4 }]));
  await client.flush();
  assert.equal(client.isWritable(), false);
  assert.equal(client.save(snapshot("ignored", [{ number: 5 }])), false);
  await client.poll();
  assert.equal(client.isWritable(), true);
  assert.deepEqual(applied.at(-1).board.pins, [{ number: 4 }]);
  client.save(snapshot("ignored", [{ number: 4 }, { number: 5 }]));
  await client.flush();
  assert.equal(puts, 2);
  assert.match(errors[0], /Could not confirm/);
  assert.ok(requests.every(({ options }) => !options.headers.Authorization));
  client.stop();
});

test("the client stays unwritable until the initial board has loaded", async () => {
  const ready = deferred();
  const client = Client.createBoardClient({ fetchImpl: () => ready.promise });
  const loading = client.load();
  assert.equal(client.isWritable(), false);
  ready.resolve(reply({ user: { login: "tester" }, csrfToken: "local-capability", snapshot: snapshot("r1") }));
  await loading;
  assert.equal(client.isWritable(), true);
  client.stop();
});

test("a poll arriving during an unfinished pointer edit waits for a later idle poll", async () => {
  const pending = deferred();
  const applied = [];
  let active = true;
  let polls = 0;
  const client = Client.createBoardClient({
    isActive: () => active,
    onSnapshot: (value) => applied.push(value),
    fetchImpl: async (path) => {
      if (path === "/api/session") return reply({ user: { login: "tester" }, csrfToken: "cap", snapshot: snapshot("r1") });
      polls += 1;
      return polls === 1 ? pending.promise : reply(snapshot("r2", [{ number: 4 }]));
    }
  });
  await client.load();
  const polling = client.poll();
  active = false;
  pending.resolve(reply(snapshot("r2", [{ number: 4 }])));
  await polling;
  assert.equal(applied.at(-1).revision, "r1");
  active = true;
  await client.poll();
  assert.equal(applied.at(-1).revision, "r2");
  client.stop();
});
