#!/usr/bin/env node
// Behavioural tests for scripts/verify-remote-verifier.mjs, driven through
// the process boundary (spawn the script, observe exit code + stdout/stderr)
// against a REAL local HTTP server (node:http on 127.0.0.1) — not a stub —
// so the transport/auth/schema paths are exercised against an actual socket,
// per the repo's cross-boundary verification convention.
//
// Run: node scripts/verify-remote-verifier.test.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify-remote-verifier.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Config-only cases (no local server involved) can stay synchronous.
function runScriptSync(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// Cases that talk to an in-process HTTP server MUST spawn asynchronously:
// spawnSync blocks this process's event loop for its whole duration, which
// would starve the very server the child is trying to reach — a deadlock
// that reads as a false "transport timeout", not a real one.
function runScript(env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function withServer(handler, fn) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      Promise.resolve(fn(`http://127.0.0.1:${port}`))
        .then((value) => server.close(() => resolvePromise(value)))
        .catch((err) => server.close(() => reject(err)));
    });
  });
}

const VALID_RESULT = {
  passed: true,
  verdict: "PASS",
  steps: [{ name: "spec-verify-cmd", passed: true, output: "ok" }],
  modelAttribution: { provider: "mars-smoke-test", model: "verify-remote-verifier" },
};

async function main() {
  console.log("verify-remote-verifier.test.mjs\n");

  // 1. Config: MARS_VERIFIER_KIND unset -> resolves to the default "local",
  //    never even attempts a network call.
  {
    const result = runScriptSync({ MARS_VERIFIER_KIND: "", MARS_VERIFIER_REMOTE_URL: "" });
    check("no MARS_VERIFIER_KIND set -> exit 1, config diagnosis", result.status === 1, `status=${result.status}`);
    check("config diagnosis names the resolved kind", /config:.*"local"/.test(result.stderr), result.stderr);
  }

  // 2. Config: remote-http selected but the URL env var is unset.
  {
    const result = runScriptSync({ MARS_VERIFIER_KIND: "remote-http", MARS_VERIFIER_REMOTE_URL: "" });
    check("remote-http with no URL -> exit 1, config diagnosis", result.status === 1, `status=${result.status}`);
    check("config diagnosis names the missing env var", /config:.*MARS_VERIFIER_REMOTE_URL/.test(result.stderr), result.stderr);
  }

  // 3. Transport failure: nothing listening on the target port.
  {
    const result = runScriptSync({
      MARS_VERIFIER_KIND: "remote-http",
      MARS_VERIFIER_REMOTE_URL: "http://127.0.0.1:1/verify",
    });
    check("closed port -> exit 2, transport diagnosis", result.status === 2, `status=${result.status}`);
    check("transport diagnosis on stderr", /^transport:/m.test(result.stderr), result.stderr);
  }

  // 4. Auth failure: real server responds 401.
  await withServer(
    (req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    },
    async (url) => {
      const result = await runScript({
        MARS_VERIFIER_KIND: "remote-http",
        MARS_VERIFIER_REMOTE_URL: url,
        MARS_VERIFIER_REMOTE_TOKEN: "wrong-token",
      });
      check("401 response -> exit 3, auth diagnosis", result.status === 3, `status=${result.status}`);
      check("auth diagnosis on stderr", /^auth:/m.test(result.stderr), result.stderr);
      check("endpoint printed with credential redacted (no token value on stdout)", !result.stdout.includes("wrong-token"), result.stdout);
    },
  );

  // 5. Schema mismatch: real server responds 200 with a body missing required fields.
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (url) => {
      const result = await runScript({ MARS_VERIFIER_KIND: "remote-http", MARS_VERIFIER_REMOTE_URL: url });
      check("malformed body -> exit 5, schema diagnosis", result.status === 5, `status=${result.status}`);
      check("schema diagnosis names a missing field", /schema:.*\.verdict/.test(result.stderr), result.stderr);
    },
  );

  // 6. Schema mismatch: real server responds 200 with invalid JSON.
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not json");
    },
    async (url) => {
      const result = await runScript({ MARS_VERIFIER_KIND: "remote-http", MARS_VERIFIER_REMOTE_URL: url });
      check("invalid JSON body -> exit 5, schema diagnosis", result.status === 5, `status=${result.status}`);
      check("schema diagnosis mentions invalid JSON", /schema:.*not valid JSON/.test(result.stderr), result.stderr);
    },
  );

  // 7. Success: real server validates the request and returns a valid VerifierRunResult.
  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const auth = req.headers["authorization"];
        if (auth !== "Bearer right-token") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        const parsedRequest = JSON.parse(body);
        if (!Array.isArray(parsedRequest.steps) || typeof parsedRequest.cwd !== "string") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad request shape" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(VALID_RESULT));
      });
    },
    async (url) => {
      const result = await runScript({
        MARS_VERIFIER_KIND: "remote-http",
        MARS_VERIFIER_REMOTE_URL: url,
        MARS_VERIFIER_REMOTE_TOKEN: "right-token",
      });
      check("valid response -> exit 0", result.status === 0, `status=${result.status}\n${result.stderr}`);
      check("prints PASS summary", /verify-remote-verifier: PASS/.test(result.stdout), result.stdout);
      check("prints the parsed VerifierRunResult", result.stdout.includes('"verdict": "PASS"'), result.stdout);
      check("does not print the bearer token", !result.stdout.includes("right-token"), result.stdout);
    },
  );

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("all checks passed");
}

main();
