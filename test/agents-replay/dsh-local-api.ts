import { isJsonString } from "../../src/json-value.js";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Real DSH SDK + deterministic loopback API. No model credentials or network model calls. */
const command = process.env.DEVSPACE_QA_DSH_COMMAND;

if (!command) throw new Error("Set DEVSPACE_QA_DSH_COMMAND to a compatible isolated DSH SDK executable.");

const root = await mkdtemp(join(tmpdir(), "devspace-dsh-api-"));
const home = join(root, "dsh");
const profile = join(home, "profiles", "sdk");

await mkdir(profile, { recursive: true });

await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-sdk", private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] } } }));

await writeFile(join(profile, "cordis.yml"), "[]\n");

await writeFile(join(profile, "cordis.patch.yml"), "[]\n");

let requests = 0;

const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  request.on("end", () => {
    try {
      const input = JSON.parse(body);
      requests++;
      const messages = JSON.stringify(input.messages);
      const last = input.messages?.at(-1)?.content;
      const hasResult = Array.isArray(last) && last.some((block: { type: string }) => block.type === "tool_result");
      let text = messages.includes("PAPAYA-7") ? "PAPAYA-7" : messages.includes("What is our project codename") ? "BLUEBIRD-4417" : "OK";
      let tool: { name: string; input: Record<string, string> } | undefined;

      if (messages.includes("first word")) {
        text = "MARIGOLD";

        if (!hasResult) tool = { name: "bash", input: { command: "cat README.md", description: "Read fixture README" } };
      } else if (messages.includes("sleep 20")) {
        if (!hasResult) tool = { name: "bash", input: { command: "sleep 20 && echo late > late.txt", description: "Delayed fixture write for cancellation" } };
        text = "SLEPT";
      } else if (messages.includes("probe.txt")) {
        if (!hasResult) tool = { name: "bash", input: { command: "printf hello > probe.txt", description: "Write isolated conformance probe" } };
        text = "DONE";
      }

      const events = [
        { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: input.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: `tool_fixture_${requests}`, name: tool.name, input: {} } : { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch { response.writeHead(400); response.end("invalid fixture request"); }
  });
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

const address = server.address();

if (!address || isJsonString(address)) throw new Error("No loopback API address");

try {
  console.log(`DSH SDK ${execFileSync(command, ["--version"], { encoding: "utf8" }).trim()}; local simulated API; no real-model acceptance`);

  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./conformance.ts", import.meta.url)), "dsh", ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, DEVSPACE_QA_DSH_COMMAND: command, DEVSPACE_QA_DSH_HOME: home,
      DEEPSEEK_API_KEY: "local-fixture-only", DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_TELEMETRY_DISABLED: "1", DEVSPACE_QA_RECORDING_SOURCE: "real DSH SDK 0.2.2-rc.1 with simulated loopback API; no real model" },
  });

  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
  process.exitCode = code ?? 1;
  await writeFile(join(root, "summary.json"), JSON.stringify({ sdk: "0.2.2-rc.1", source: "real SDK with simulated loopback API", requests, code }));
  console.log(`SDK validation state retained at ${root}`);
} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
