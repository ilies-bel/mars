import { createHmac, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";

const SECRET = process.env.GH_WEBHOOK_SECRET;
const REPO = process.env.MARS_REPO;
const PORT = Number(process.env.PORT ?? 7878);
const ONLY_FAILURES = process.env.ONLY_FAILURES === "1";

if (!SECRET) {
  console.error("GH_WEBHOOK_SECRET is required");
  process.exit(1);
}
if (!REPO) {
  console.error("MARS_REPO is required (absolute path to target repo)");
  process.exit(1);
}

function verifySignature(body: string, signatureHeader: string): boolean {
  const expected = "sha256=" + createHmac("sha256", SECRET!).update(body).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function enqueue(prompt: string): boolean {
  const r = spawnSync("mars", ["--repo", REPO!, "task", "add", prompt], {
    stdio: "inherit",
  });
  return r.status === 0;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const body = await req.text();
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    if (!verifySignature(body, sig)) {
      return new Response("bad signature", { status: 401 });
    }

    const event = req.headers.get("x-github-event");
    if (event === "ping") return new Response("pong");
    if (event !== "workflow_run") return new Response("ignored", { status: 200 });

    const payload = JSON.parse(body);
    if (payload.action !== "completed") return new Response("ignored", { status: 200 });

    const run = payload.workflow_run;
    const conclusion: string = run.conclusion ?? "unknown";
    const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
    if (ONLY_FAILURES && !FAILURE_CONCLUSIONS.has(conclusion)) {
      return new Response(`skipped (conclusion=${conclusion})`, { status: 200 });
    }

    const repo = payload.repository?.full_name ?? "unknown";
    const sha: string = run.head_sha ?? "";
    const prompt =
      `CI pipeline "${run.name}" failed with conclusion=${conclusion} ` +
      `on ${repo}@${run.head_branch} (${sha.slice(0, 7)}). ` +
      `Run: ${run.html_url}\n\n` +
      `Open the run, identify the failing job, read the logs, and propose a ` +
      `minimal fix in this repo. Run the project's verify command (e.g. ` +
      `\`npm test\`) before declaring done.\n\n` +
      `Save your work: stage and commit the change before exiting.`;

    const ok = enqueue(prompt);
    return new Response(ok ? "queued" : "failed to enqueue", { status: ok ? 200 : 500 });
  },
});

console.log(`ci-listener up on :${PORT} → ${REPO} (only_failures=${ONLY_FAILURES})`);
