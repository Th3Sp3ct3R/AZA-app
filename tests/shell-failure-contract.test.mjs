import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../packages/core/dist/index.js";

const workspace = process.platform === "win32" ? "D:\\Ares" : "/tmp";
const now = () => new Date().toISOString();

function toolThenDoneProvider(onContinuation) {
  let round = 0;
  return {
    name: "shell-failure-contract-provider",
    async *stream(request) {
      round += 1;
      if (round === 1) {
        yield { type: "tool_use_start", id: "shell_1", name: "Bash" };
        yield {
          type: "tool_use_input_done",
          id: "shell_1",
          input: { command: "test-command", description: "exercise failure contract", timeout: 1000 },
        };
        yield {
          type: "message_done",
          message: {
            id: "assistant_tools",
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "shell_1",
              name: "Bash",
              input: { command: "test-command", description: "exercise failure contract", timeout: 1000 },
            }],
            createdAt: now(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }

      onContinuation(request);
      yield {
        type: "message_done",
        message: {
          id: "assistant_done",
          role: "assistant",
          content: [{ type: "text", text: "corrected" }],
          createdAt: now(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("declared tool failure settles failed while preserving structured diagnostics for the model", async () => {
  const shellOutput = {
    command: "bash -lc test-command",
    exitCode: 17,
    stdout: "stdout survives",
    stderr: "stderr survives",
    durationMs: 42,
    timedOut: false,
    truncated: true,
    fullOutputPath: `${workspace}/.ares/shell-output/sess_contract/full.log`,
  };
  const settlements = [];
  let continuationRequest;
  const tool = {
    schema: {
      name: "Bash",
      description: "contract fixture",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
      watchdogTimeoutMs: 0,
      maxResultSizeChars: 0,
    },
    async call() {
      return {
        output: shellOutput,
        failure: "Bash exited with code 17",
      };
    },
  };
  const engine = QueryEngine.forTesting(
    {
      provider: toolThenDoneProvider((request) => { continuationRequest = request; }),
      model: "test",
      systemPrompt: "test",
      tools: [tool],
      workspace,
      maxTurns: 3,
      afterToolExecution: async (settlement) => { settlements.push(settlement); },
    },
    "sess_shell_failure_contract",
  );
  engine.appendUserMessage("run it");

  const events = [];
  for await (const event of engine.streamTurn()) events.push(event);

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "failed");
  assert.equal(settlements[0].error, "Bash exited with code 17");
  assert.deepEqual(settlements[0].output, shellOutput);
  const errorEvent = events.find((event) => event.type === "tool_error" && event.error === "Bash exited with code 17");
  assert.ok(errorEvent);
  assert.deepEqual(errorEvent.output, shellOutput);
  assert.ok(!events.some((event) => event.type === "tool_end"), "a declared failure must not emit a success event");

  const result = continuationRequest.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && block.tool_use_id === "shell_1");
  assert.ok(result, "the next provider call receives the tool result");
  assert.equal(result.is_error, true);
  assert.equal(typeof result.content, "string");
  assert.match(result.content, /^Bash exited with code 17\n\n/);
  assert.deepEqual(JSON.parse(result.content.split("\n\n").slice(1).join("\n\n")), shellOutput);
});
