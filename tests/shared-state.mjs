/* The local dashboard and MCP must operate on one board without snapshot imports.
   Uses a temporary store and a mocked GitHub boundary; no live data or mutations.
   usage: bun shared-state.mjs --head <checkout> [--base <unused>] */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : path.resolve(process.argv[at + 1]);
}
const head = option("head");
if (!head) throw new Error("usage: bun shared-state.mjs --head <checkout>");
const fromHead = (relative) => import(pathToFileURL(path.join(head, relative)).href);
const [{ BoardStore }, { createWebServer }, { createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
  fromHead("mcp/src/store.mjs"),
  fromHead("mcp/src/web.mjs"),
  fromHead("mcp/src/server.mjs"),
  fromHead("mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
  fromHead("mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js")
]);

const repo = "vllm-project/vllm";
const login = "mingboard-tester";
const secret = "test-secret-token-never-send-to-the-browser";
const upstreamCalls = [];
function repository(owner, name, number) {
  const now = new Date().toISOString();
  const oid = "a".repeat(40);
  return {
    ref: { compare: { aheadBy: 1, behindBy: 0 } },
    pullRequest: {
      id: `PR_${number}`, number, title: `Shared-state PR ${number}`,
      url: `https://github.com/${owner}/${name}/pull/${number}`,
      state: "OPEN", isDraft: false, updatedAt: now, closedAt: null,
      author: { login: "someone" }, authorAssociation: "MEMBER",
      baseRefName: "main", headRefOid: oid, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
      viewerCanUpdateBranch: true, autoMergeRequest: null, additions: 1, deletions: 1, changedFiles: 1,
      labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, reviewRequests: { nodes: [] }, comments: { nodes: [] },
      commits: { nodes: [{ commit: { oid, committedDate: now, statusCheckRollup: null } }] }
    }
  };
}
async function mockGitHub(input, init = {}) {
  const url = new URL(input);
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${secret}`);
  const method = init.method || "GET";
  upstreamCalls.push({ path: url.pathname, method });
  if (url.pathname === "/user") return Response.json({ login, id: 1 });
  if (url.pathname !== "/graphql") return Response.json([]);
  const { query, variables = {} } = JSON.parse(init.body || "{}");
  assert.ok(!/^\s*mutation\b/.test(query), "this integration test must not perform GitHub mutations");
  if (query.includes("pullRequest(number:")) {
    if ("number" in variables) return Response.json({ data: { repository: repository(variables.owner, variables.name, variables.number) } });
    const aliases = Object.keys(variables).filter((key) => /^number\d+$/.test(key)).map((key) => key.slice(6));
    return Response.json({ data: Object.fromEntries(aliases.map((i) => [`pr${i}`, repository(variables[`owner${i}`], variables[`name${i}`], variables[`number${i}`])])) });
  }
  if (query.includes("history(first:")) return Response.json({ data: { repository: { ref: { target: { history: { nodes: [] } } } } } });
  if (query.includes("search(")) return Response.json({ data: { search: { issueCount: 0, nodes: [] } } });
  return Response.json({ data: { repository: { object: null } } });
}
async function eventually(check, message, timeout = 5000) {
  const until = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < until);
  throw new Error(message);
}

const directory = await mkdtemp(path.join(tmpdir(), "mingboard-shared-state-"));
const store = new BoardStore(path.join(directory, "board.json"));
const mcp = createServer({ store: new BoardStore(store.filePath), github: {} });
const client = new Client({ name: "shared-state-browser-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const web = createWebServer({ store, token: secret, fetchImpl: mockGitHub, rootDirectory: head });
let browser;
try {
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, response.content?.[0]?.text);
    return response.structuredContent || JSON.parse(response.content[0].text);
  }
  const board = () => call("get_board", { refresh: false });
  await call("track_pr", { repo, number: 1 });
  await new Promise((resolve, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${web.address().port}`;
  browser = await chromium.launch();
  const context = await browser.newContext();
  // Fonts and any other external browser traffic are unnecessary for this check.
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  const browserLeaks = [];
  const responseChecks = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(`Browser error: ${error.message}`);
  });
  page.on("request", (request) => {
    if (JSON.stringify(request.headers()).includes(secret) || (request.postData() || "").includes(secret)) browserLeaks.push(request.url());
  });
  page.on("response", (response) => {
    if (new URL(response.url()).origin !== origin) return;
    responseChecks.push(response.text().then((body) => {
      if (body.includes(secret)) browserLeaks.push(response.url());
    }).catch(() => {}));
  });

  await page.goto(origin);
  await page.getByText("Shared-state PR 1", { exact: true }).first().waitFor();
  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 1)?.seen), "initial refresh was not saved");
  assert.equal(await page.getByLabel("GitHub classic token").count(), 0, "local mode should use the server session");
  console.log("Local dashboard loads the MCP board without a browser credential.");

  const started = Date.now();
  await call("track_pr", { repo, number: 2, group: "Review requests" });
  await page.getByText("Shared-state PR 2", { exact: true }).first().waitFor({ timeout: 2500 });
  assert.ok(Date.now() - started < 2500, "MCP additions should appear on the active dashboard within the polling window");
  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 2)?.seen), "new MCP pin was not refreshed");
  console.log("An MCP pin appears in the active browser without importing or reloading.");

  await page.getByRole("button", { name: "+ Add PRs", exact: true }).click();
  const input = page.getByPlaceholder(/^Search .* or paste PR numbers \/ URLs$/);
  await input.fill(`${repo}#3`);
  await input.press("Enter");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await eventually(async () => (await board()).board.pins.some((pin) => pin.number === 3), "browser pin was not visible through MCP");
  await page.getByText("Shared-state PR 3", { exact: true }).first().waitFor();
  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 3)?.seen), "browser pin refresh was not saved");
  await page.getByLabel("Sort pinned pull requests", { exact: true }).selectOption("updated");
  await eventually(async () => (await board()).prefs.sort === "updated", "browser preference was not visible through MCP");
  console.log("Browser pins and preferences persist through the same MCP store.");

  // Force a real stale-write race at the HTTP boundary, without invoking app internals.
  let interceptNextSave = true;
  let insertedDuringSave = false;
  await page.route(`${origin}/api/board`, async (route) => {
    if (interceptNextSave && route.request().method() === "PUT") {
      interceptNextSave = false;
      await call("track_pr", { repo, number: 4 });
      insertedDuringSave = true;
    }
    await route.continue();
  });
  await page.getByLabel("Sort pinned pull requests", { exact: true }).selectOption("number");
  await page.getByText(/board changed elsewhere/i).first().waitFor({ timeout: 5000 });
  assert.ok(insertedDuringSave, "the stale-write race was not exercised");
  await page.getByText("Shared-state PR 4", { exact: true }).first().waitFor();
  assert.equal((await board()).prefs.sort, "updated", "the stale browser edit must not be replayed over the MCP change");
  assert.ok((await board()).board.pins.some((pin) => pin.number === 4), "the concurrent MCP pin must survive");
  console.log("A stale browser save reports a conflict and retains the concurrent MCP change.");

  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 4)?.seen), "conflict reload was not refreshed");

  // An open dialog must keep editing the retained group after a polling snapshot.
  const requestedGroup = page.locator(".group").filter({ hasText: "Review requests" });
  await requestedGroup.locator(".group-head").hover();
  await requestedGroup.getByRole("button", { name: "Rename", exact: true }).click({ timeout: 5000 });
  const rename = page.getByRole("textbox", { name: 'Rename "Review requests"', exact: true });
  await rename.fill("Reviews in progress");
  await call("track_pr", { repo, number: 5, group: "Review requests" });
  await page.getByText("Shared-state PR 5", { exact: true }).first().waitFor({ timeout: 2500 });
  await page.getByRole("heading", { name: 'Rename "Review requests"', exact: true }).waitFor();
  await rename.press("Enter");
  await eventually(async () => {
    const saved = await board();
    return saved.board.groups.some((group) => group.name === "Reviews in progress")
      && saved.board.pins.some((pin) => pin.number === 5);
  }, "rename did not preserve the external MCP pin after a polling update");
  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 5)?.seen), "renamed group's new pin was not refreshed");
  console.log("An open rename dialog retains its group across external MCP updates.");

  // Hold only the browser's permission promise; never prompt for real permissions.
  await page.evaluate(() => {
    Object.defineProperty(window, "Notification", { configurable: true, value: class {
      static permission = "default";
      static requestPermission() {
        window.__mingboardNotificationRequested = true;
        return new Promise((resolve) => { window.__mingboardResolvePermission = resolve; });
      }
    } });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Refresh open PRs every").selectOption("120", { timeout: 5000 });
  await page.getByLabel("Following", { exact: true }).fill("alice bob");
  await page.getByLabel("Browser notification when CI finishes", { exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => window.__mingboardNotificationRequested === true);
  await call("track_pr", { repo, number: 6, group: "Reviews in progress" });
  await page.getByText("Shared-state PR 6", { exact: true }).first().waitFor({ timeout: 2500 });
  await page.evaluate(() => window.__mingboardResolvePermission("granted"));
  await eventually(async () => {
    const saved = await board();
    return saved.prefs.interval === 120 && saved.prefs.notify === true
      && saved.prefs.following.join(" ") === "alice bob"
      && saved.board.pins.some((pin) => pin.number === 6);
  }, "settings selected before permission await did not persist with the external MCP pin");
  await eventually(async () => Boolean((await board()).board.pins.find((pin) => pin.number === 6)?.seen), "settings race pin was not refreshed");
  console.log("Settings survive a permission await and retain intervening MCP changes.");

  await call("untrack_pr", { repo, number: 2 });
  await page.getByText("Shared-state PR 2", { exact: true }).first().waitFor({ state: "detached", timeout: 2500 });
  await page.reload();
  await page.getByText("Shared-state PR 3", { exact: true }).first().waitFor();
  await page.getByText("Shared-state PR 4", { exact: true }).first().waitFor();
  assert.equal(await page.getByLabel("Sort pinned pull requests", { exact: true }).inputValue(), "updated");
  const saved = await board();
  assert.deepEqual(saved.board.pins.map((pin) => pin.number).sort(), [1, 3, 4, 5, 6]);
  assert.equal(saved.prefs.interval, 120);
  assert.equal(saved.prefs.notify, true);
  assert.deepEqual(saved.prefs.following, ["alice", "bob"]);
  assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).includes(secret));
  await Promise.all(responseChecks);
  assert.deepEqual(browserLeaks, [], "GitHub credential leaked to browser traffic");
  assert.deepEqual(errors, [], "browser reported runtime errors");
  assert.ok(upstreamCalls.some((call) => call.path === "/user"));
  await context.close();
  console.log("Shared state survives reloads, MCP removals synchronize, and the GitHub token stays server-side.");
} finally {
  if (browser) await browser.close();
  await client.close();
  await mcp.close();
  web.closeAllConnections?.();
  await new Promise((resolve) => web.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
