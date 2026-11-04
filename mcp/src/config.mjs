import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function getStateFile(env = process.env) {
  const configured = env.MINGBOARD_STATE_FILE || env.PINGBOARD_STATE_FILE;
  return resolve(configured || join(homedir(), ".pingboard", "board.json"));
}

/** Credentials stay in process memory, including when supplied by the GitHub CLI. */
export async function resolveGitHubToken(env = process.env) {
  const configured = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  try {
    const { stdout } = await run("gh", ["auth", "token"], {
      encoding: "utf8", timeout: 10000, maxBuffer: 16384,
      env: { ...process.env, ...env }
    });
    if (stdout.trim()) return stdout.trim();
  } catch {
    // CLI stderr can contain account details; report only how to configure access.
  }
  throw new Error("Set GITHUB_TOKEN or GH_TOKEN, or sign in with gh auth login before starting Mingboard.");
}
