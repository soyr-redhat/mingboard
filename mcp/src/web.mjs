import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BoardStore } from "./store.mjs";
import { getStateFile, resolveGitHubToken } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const GITHUB_ROOT = "https://api.github.com";
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "application/javascript; charset=utf-8"]],
  ["/core.js", ["core.js", "application/javascript; charset=utf-8"]],
  ["/board-client.js", ["board-client.js", "application/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);
const PROXY_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function sameSecret(value, expected) {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    let length = 0;
    let failed = false;
    const chunks = [];
    const rejectBody = (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    const declared = Number(request.headers["content-length"]);
    if (declared > limit) {
      request.resume();
      rejectBody(Object.assign(new Error("Request body exceeds the 2 MiB limit."), { status: 413 }));
      return;
    }
    request.on("data", (chunk) => {
      if (failed) return;
      length += chunk.length;
      if (length > limit) {
        chunks.length = 0;
        rejectBody(Object.assign(new Error("Request body exceeds the 2 MiB limit."), { status: 413 }));
      } else chunks.push(chunk);
    });
    request.on("error", () => rejectBody(Object.assign(new Error("Request body could not be read."), { status: 400 })));
    request.on("aborted", () => rejectBody(Object.assign(new Error("Request body was interrupted."), { status: 400 })));
    request.on("end", () => {
      if (failed) return;
      try {
        resolveBody(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        rejectBody(Object.assign(new Error("Request body must be valid UTF-8."), { status: 400 }));
      }
    });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { fail(400, "Request body must be valid JSON."); }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function rawPath(request) {
  const target = request.url || "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) fail(400, "Invalid request path.");
  const path = target.split("?", 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { fail(400, "Invalid request path encoding."); }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some((part) => part === "." || part === "..")) fail(400, "Invalid request path.");
  return { path, target };
}

/** Local UI and stdio MCP share BoardStore; no GitHub token is sent to the browser. */
export function createWebServer({ store, token, fetchImpl = globalThis.fetch, rootDirectory = ROOT, requestTimeoutMs = 15000 } = {}) {
  if (!store || typeof store.readSnapshot !== "function" || typeof store.replaceSnapshot !== "function") throw new Error("A snapshot-capable BoardStore is required.");
  if (typeof token !== "string" || !token.trim()) throw new Error("A GitHub token is required for the local Mingboard server.");
  const credential = token.trim();
  const csrfToken = randomBytes(32).toString("hex");
  const cleanMessage = (message) => String(message || "Request failed.").split(credential).join("[redacted]").replace(/[\r\n]+/g, " ").slice(0, 1000);

  async function github(path, method = "GET", body) {
    const timeout = Math.min(60000, Math.max(1, Number(requestTimeoutMs) || 15000));
    let upstream;
    let text;
    try {
      upstream = await fetchImpl(`${GITHUB_ROOT}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mingboard"
        },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        ...(body ? { body } : {})
      });
      // A custom transport must not follow a redirect either.
      if (upstream.status >= 300 && upstream.status < 400) fail(502, "GitHub redirects are not allowed.");
      text = await upstream.text();
    } catch (error) {
      if (error.status === 502) throw error;
      fail(502, method === "GET"
        ? "GitHub request failed or timed out; check connectivity."
        : "GitHub request failed or timed out. The write outcome may be unknown; inspect the PR before retrying.");
    }
    return { upstream, text: text.split(credential).join("[redacted]") };
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
    try {
      const address = server.address();
      const origin = `http://127.0.0.1:${address?.port}`;
      const expectedHost = `127.0.0.1:${address?.port}`;
      const remote = request.socket.remoteAddress;
      if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") fail(403, "Only loopback clients are allowed.");
      if (request.headers.host !== expectedHost) fail(403, "Invalid local server host.");
      if (request.headers.origin && request.headers.origin !== origin) fail(403, "Cross-origin requests are not allowed.");
      if (request.headers["sec-fetch-site"] === "cross-site") fail(403, "Cross-site requests are not allowed.");
      const { path, target } = rawPath(request);
      const method = request.method;

      if (path === "/api/session") {
        if (method !== "GET") fail(405, "Method not allowed.");
        const { upstream, text } = await github("/user");
        if (!upstream.ok) fail(upstream.status === 401 || upstream.status === 403 ? 401 : 502, "GitHub authentication failed; check the server credential.");
        let user;
        try { user = JSON.parse(text); } catch { fail(502, "GitHub did not return a valid user identity."); }
        if (!user || typeof user.login !== "string" || !user.login) fail(502, "GitHub did not return a user identity.");
        json(response, 200, { user, csrfToken, snapshot: await store.readSnapshot() });
        return;
      }

      if (path.startsWith("/api/")) {
        if (!sameSecret(request.headers["x-mingboard-token"], csrfToken)) fail(403, "Missing or invalid Mingboard session token.");
        if (path === "/api/board") {
          if (method === "GET") json(response, 200, await store.readSnapshot());
          else if (method === "PUT") {
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) fail(415, "Board updates require application/json.");
            const payload = parseJson(await readBody(request));
            if (!payload || typeof payload !== "object" || Array.isArray(payload)
              || Object.keys(payload).some((key) => !["board", "prefs", "expectedRevision"].includes(key))) fail(400, "Expected board, prefs and expectedRevision.");
            json(response, 200, await store.replaceSnapshot({ board: payload.board, prefs: payload.prefs }, payload.expectedRevision));
          } else fail(405, "Method not allowed.");
          return;
        }
        if (path.startsWith("/api/github/")) {
          if (!PROXY_METHODS.has(method)) fail(405, "Method not allowed.");
          const githubPath = target.slice("/api/github".length);
          if (!(githubPath === "/user" && method === "GET")
            && !(githubPath === "/graphql" && method === "POST")
            && !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|\?|$)/.test(githubPath)) fail(400, "Unsupported GitHub API path.");
          let body;
          if (method !== "GET") {
            body = await readBody(request);
            if (body) {
              if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) fail(415, "GitHub writes require application/json.");
              parseJson(body);
            }
          }
          const { upstream, text } = await github(githubPath, method, body);
          for (const [name, value] of upstream.headers) {
            if (name.toLowerCase().startsWith("x-ratelimit-")) response.setHeader(name, value);
          }
          response.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
          response.end(text);
          return;
        }
        fail(404, "API route not found.");
      }

      if (method !== "GET" && method !== "HEAD") fail(405, "Method not allowed.");
      if (path === "/mingboard-config.js") {
        response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        response.end("globalThis.MINGBOARD_LOCAL = true;\n");
        return;
      }
      const asset = ASSETS.get(path);
      if (!asset) fail(404, "File not found.");
      const filePath = join(rootDirectory, asset[0]);
      let stat;
      try { stat = await lstat(filePath); } catch (error) { if (error.code === "ENOENT") fail(404, "File not found."); throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) fail(404, "File not found.");
      const [root, actual] = await Promise.all([realpath(rootDirectory), realpath(filePath)]);
      if (dirname(actual) !== root) fail(404, "File not found.");
      const body = await readFile(filePath);
      response.writeHead(200, { "Content-Type": asset[1], "Content-Length": body.length });
      response.end(body);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.end(); return; }
      const status = error.status || (/Timed out waiting for.*store lock/.test(error.message || "") ? 503 : 500);
      json(response, status >= 400 && status <= 599 ? status : 500, {
        error: cleanMessage(error.message),
        ...(status === 409 && error.snapshot ? { snapshot: error.snapshot } : {})
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

export async function startWebServer({ store, token, port = Number(process.env.MINGBOARD_PORT || 8787), ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("MINGBOARD_PORT must be an integer from 0 to 65535.");
  const server = createWebServer({
    store: store || new BoardStore(getStateFile()),
    token: token || await resolveGitHubToken(),
    ...options
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const server = await startWebServer();
    console.log(`Mingboard: http://127.0.0.1:${server.address().port}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(`Mingboard failed to start: ${error.message}`);
    process.exitCode = 1;
  }
}
