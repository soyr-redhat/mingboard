#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubClient } from "./github.mjs";
import { BoardStore } from "./store.mjs";
import { createServer } from "./server.mjs";
import { getStateFile, resolveGitHubToken } from "./config.mjs";

const server = createServer({
  store: new BoardStore(getStateFile()),
  // Local board tools remain available even without configured GitHub access.
  github: new GitHubClient({ token: await resolveGitHubToken().catch(() => "") })
});

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Mingboard MCP failed to start: ${error.message}`);
  process.exitCode = 1;
}
