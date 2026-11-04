import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/store.mjs";
import { createWebServer } from "../src/web.mjs";
import { getStateFile, resolveGitHubToken } from "../src/config.mjs";

const credential = "test-server-credential-never-sent-to-browser";
const user = { login: "mingboard-tester", id: 123 };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mingboard-web-test-"));
  const rootDirectory = join(directory, "site");
  await mkdir(rootDirectory);
  await writeFile(join(rootDirectory, "index.html"), "<!doctype html><title>Mingboard</title>");
  await writeFile(join(rootDirectory, "app.js"), "console.log('Mingboard');");
  const store = new BoardStore(join(directory, "private", "board.json"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const server = createWebServer({ store, token: credential, rootDirectory, fetchImpl, ...options });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function send(path, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      // Preserve raw paths so traversal tests reach the server without URL normalization.
      const outgoing = request({ hostname: "127.0.0.1", port: server.address().port, path, method, headers }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (data) => { text += data; });
        response.on("end", () => {
          let value;
          try { value = JSON.parse(text); } catch { value = text; }
          resolve({ status: response.statusCode, headers: response.headers, text, value });
        });
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
  const session = () => send("/api/session");
  return { directory, rootDirectory, store, server, calls, origin, send, session };
}

test("configuration keeps the existing board path and resolves environment credentials first", async () => {
  assert.equal(getStateFile({}), join(homedir(), ".pingboard", "board.json"));
  const previous = join(tmpdir(), "old-board.json");
  const current = join(tmpdir(), "new-board.json");
  assert.equal(getStateFile({ PINGBOARD_STATE_FILE: previous }), previous);
  assert.equal(getStateFile({ PINGBOARD_STATE_FILE: previous, MINGBOARD_STATE_FILE: current }), current);
  assert.equal(await resolveGitHubToken({ GITHUB_TOKEN: " github-token ", GH_TOKEN: "cli-token" }), "github-token");
  assert.equal(await resolveGitHubToken({ GH_TOKEN: "cli-token" }), "cli-token");
});

test("session bootstraps shared state without exposing the GitHub credential", async (t) => {
  const { session, calls, send } = await fixture(t);
  const result = await session();
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.user, user);
  assert.match(result.value.csrfToken, /^[a-f0-9]{64}$/);
  assert.match(result.value.snapshot.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.value.snapshot.board.pins.length, 0);
  assert.equal(result.text.includes(credential), false);
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential}`);
  assert.equal(calls[0].init.redirect, "error");
  const board = await send("/api/board", { headers: { "X-Mingboard-Token": result.value.csrfToken } });
  assert.equal(board.status, 200);
  assert.deepEqual(board.value, result.value.snapshot);
  assert.equal(board.headers["cache-control"], "no-store");
  assert.equal(board.headers["access-control-allow-origin"], undefined);
});

test("host, origin, request methods and capability checks reject unrelated websites", async (t) => {
  const { session, send, origin, store } = await fixture(t);
  const { value } = await session();
  const headers = { "X-Mingboard-Token": value.csrfToken };
  for (const extra of [
    { Host: `attacker.example:${new URL(origin).port}` },
    { Origin: "https://attacker.example" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" }
  ]) assert.equal((await send("/api/board", { headers: { ...headers, ...extra } })).status, 403);
  assert.equal((await send("/api/board")).status, 403);
  assert.equal((await send("/api/board", { headers: { "X-Mingboard-Token": "wrong" } })).status, 403);
  assert.equal((await send("/api/github/user")).status, 403);
  assert.equal((await send("/api/session", { method: "POST" })).status, 405);
  assert.equal((await send("/api/board", { method: "POST", headers })).status, 405);
  assert.equal((await send("/api/board", { method: "OPTIONS", headers: { Origin: origin } })).status, 403);
  assert.equal((await store.read()).board.pins.length, 0);
});

test("browser saves are revision guarded against concurrent MCP writes", async (t) => {
  const { session, send, store, origin } = await fixture(t);
  const { value } = await session();
  const headers = { "X-Mingboard-Token": value.csrfToken, "Content-Type": "application/json", Origin: origin };
  const browser = structuredClone(value.snapshot);
  browser.board.groups[0].name = "My board";
  const saved = await send("/api/board", { method: "PUT", headers, body: JSON.stringify({ board: browser.board, prefs: browser.prefs, expectedRevision: browser.revision }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.board.groups[0].name, "My board");
  assert.notEqual(saved.value.revision, browser.revision);
  await store.track({ repo: "example/repository", number: 7 });
  const conflict = await send("/api/board", { method: "PUT", headers, body: JSON.stringify({ board: saved.value.board, prefs: saved.value.prefs, expectedRevision: saved.value.revision }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.value.snapshot.board.pins[0].key, "example/repository#7");
  assert.deepEqual(await store.readSnapshot(), conflict.value.snapshot);
});

test("malformed, oversized, or incomplete updates leave the board untouched", async (t) => {
  const { session, send, store } = await fixture(t);
  const { value } = await session();
  const headers = { "X-Mingboard-Token": value.csrfToken, "Content-Type": "application/json" };
  const initial = await store.readSnapshot();
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ board: initial.board, prefs: initial.prefs }), JSON.stringify({ ...initial, expectedRevision: initial.revision, arbitrary: true })]) {
    assert.equal((await send("/api/board", { method: "PUT", headers, body })).status, 400);
  }
  assert.equal((await send("/api/board", { method: "PUT", headers: { "X-Mingboard-Token": value.csrfToken }, body: "{}" })).status, 415);
  assert.equal((await send("/api/board", { method: "PUT", headers, body: "x".repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.deepEqual(await store.readSnapshot(), initial);
});

test("GitHub proxy preserves partial GraphQL results, errors and rate headers", async (t) => {
  const calls = [];
  const payload = { data: { pr0: { pullRequest: { number: 1 } }, pr1: null }, errors: [{ message: "Unavailable PR", path: ["pr1", "pullRequest"] }] };
  const { session, send } = await fixture(t, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.endsWith("/user") ? user : payload), { status: 200, headers: { "x-ratelimit-remaining": "4567", "x-ratelimit-reset": "1234", "set-cookie": "upstream-cookie=should-not-forward" } });
  } });
  const { value } = await session();
  const query = JSON.stringify({ query: "query{viewer{login}}", variables: {} });
  const result = await send("/api/github/graphql", { method: "POST", headers: { "X-Mingboard-Token": value.csrfToken, "Content-Type": "application/json", Authorization: "Bearer browser-value-must-be-ignored", Cookie: "browser-cookie=ignored" }, body: query });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, payload);
  assert.equal(result.headers["x-ratelimit-remaining"], "4567");
  assert.equal(result.headers["x-ratelimit-reset"], "1234");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(calls[1].url, "https://api.github.com/graphql");
  assert.equal(calls[1].init.body, query);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${credential}`);
  assert.equal(calls[1].init.headers.Cookie, undefined);
  assert.equal(result.text.includes(credential), false);
});

test("proxy blocks foreign targets and redirects, and preserves safe GitHub failures", async (t) => {
  const { session, send } = await fixture(t, { fetchImpl: async (url) => {
    if (url.endsWith("/user")) return new Response(JSON.stringify(user));
    if (url.includes("redirect")) return new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
    return new Response(JSON.stringify({ message: `failed ${credential}` }), { status: 422, headers: { "x-ratelimit-remaining": "10" } });
  } });
  const { value } = await session();
  const headers = { "X-Mingboard-Token": value.csrfToken, "Content-Type": "application/json" };
  for (const path of ["/api/github/https://attacker.example", "/api/github//attacker.example", "/api/github/orgs/example", "/api/github/graphql/extra", "/api/github/repos/example/repository/%2e%2e/secret"]) {
    assert.equal((await send(path, { headers })).status, 400);
  }
  assert.equal((await send("/api/github/repos/example/repository/redirect", { headers })).status, 502);
  const failure = await send("/api/github/repos/example/repository/issues/1/comments", { method: "POST", headers, body: JSON.stringify({ body: "test" }) });
  assert.equal(failure.status, 422);
  assert.equal(failure.value.message, "failed [redacted]");
  assert.equal(failure.headers["x-ratelimit-remaining"], "10");
});

test("static serving exposes only approved assets and local mode configuration", async (t) => {
  const { send, rootDirectory, directory } = await fixture(t);
  await writeFile(join(rootDirectory, "board.json"), "private-board");
  await writeFile(join(rootDirectory, ".env"), credential);
  for (const path of ["/board.json", "/.env", "/.git/config", "/mcp/src/web.mjs", "/mcp/package.json"]) assert.equal((await send(path)).status, 404);
  assert.equal((await send("/%2e%2e/board.json")).status, 400);
  assert.equal((await send("/app.js")).status, 200);
  const home = await send("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.match(home.headers["content-security-policy"], /frame-ancestors 'none'/);
  const config = await send("/mingboard-config.js");
  assert.equal(config.text, "globalThis.MINGBOARD_LOCAL = true;\n");
  assert.equal(config.text.includes(credential), false);
  if (process.platform !== "win32") {
    await writeFile(join(directory, "private.css"), "secret");
    await symlink(join(directory, "private.css"), join(rootDirectory, "styles.css"));
    assert.equal((await send("/styles.css")).status, 404);
  }
});
