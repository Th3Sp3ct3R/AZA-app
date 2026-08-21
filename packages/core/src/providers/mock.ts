// MockEchoProvider — deterministic provider for tests and the M0 smoke test.
//
// Behavior:
//   - Reads the last user message text.
//   - Streams it back in 8-char chunks as text_delta events.
//   - Yields one message_done with stopReason "end_turn".
//
// Never produces tool_use blocks (so QueryEngine exits after one iteration).

import type { Message, StreamEvent } from "@ares/protocol";
import { messageText } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";

export class MockEchoProvider implements Provider {
  readonly name = "mock-echo";

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const inputText = lastUser ? messageText(lastUser) : "";
    if (inputText.includes("__mock_fail_provider__")) {
      throw new Error("injected mock provider failure");
    }
    if (inputText.includes("__mock_request_stats__")) {
      const totalChars = req.messages.reduce((sum, message) => sum + messageText(message).length, 0);
      const replyText = [
        `messages=${req.messages.length}`,
        `chars=${totalChars}`,
        `reasoning=${req.reasoningLevel ?? "unset"}`,
        `maxOutput=${req.maxOutputTokens ?? "unset"}`,
      ].join(" ");
      yield { type: "text_delta", text: replyText };
      yield {
        type: "message_done",
        message: {
          id: `msg_${Date.now().toString(36)}`,
          role: "assistant",
          content: [{ type: "text", text: replyText }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: totalChars, outputTokens: replyText.length },
        stopReason: "end_turn",
      };
      return;
    }
    if (inputText.includes("__mock_read_tool__")) {
      const filePath = mockReadToolPath(inputText);
      const toolInput = { file_path: filePath, limit: 1 };
      const toolId = "mock_read_1";
      yield { type: "tool_use_start", id: toolId, name: "Read" };
      yield { type: "tool_use_input_done", id: toolId, input: toolInput };
      yield {
        type: "message_done",
        message: {
          id: `msg_${Date.now().toString(36)}`,
          role: "assistant",
          content: [{ type: "tool_use", id: toolId, name: "Read", input: toolInput }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: inputText.length, outputTokens: 0 },
        stopReason: "tool_use",
      };
      return;
    }
    const replyText = `echo: ${inputText}`;

    const steeringWindow = inputText.includes("__mock_steer_window__");
    let chunkIndex = 0;
    for (const chunk of chunkString(replyText, 8)) {
      yield { type: "text_delta", text: chunk };
      // Deterministic daemon integration seam: let stdin deliver a correction
      // after the first visible delta without generating thousands of chunks or
      // depending on host CPU scheduling.
      if (steeringWindow && chunkIndex++ === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }

    const message: Message = {
      id: `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      createdAt: new Date().toISOString(),
    };

    yield {
      type: "message_done",
      message,
      usage: { inputTokens: inputText.length, outputTokens: replyText.length },
      stopReason: "end_turn",
    };
  }
}

function mockReadToolPath(inputText: string): string {
  const [, rawPath] = inputText.split("__mock_read_tool__", 2);
  return rawPath?.trim().split(/\s+/, 1)[0] || "package.json";
}

function chunkString(s: string, size: number): string[] {
  if (s.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
