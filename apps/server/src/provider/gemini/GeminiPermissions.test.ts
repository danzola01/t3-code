import { assert, it } from "@effect/vitest";
import type * as Acp from "effect-acp/schema";
import { geminiApprovalOptions, geminiPermissionOptionId } from "./GeminiPermissions.ts";

const request = (
  options: Acp.RequestPermissionRequest["options"],
): Acp.RequestPermissionRequest => ({
  sessionId: "session",
  toolCall: { toolCallId: "call" },
  options,
});

it("only offers native approval decisions and maps the selected decision", () => {
  const native = request([{ kind: "allow_once", optionId: "once", name: "Allow once" }]);
  assert.deepEqual(
    geminiApprovalOptions(native).map((option) => option.decision),
    ["accept", "cancel"],
  );
  assert.equal(geminiPermissionOptionId(native, "accept"), "once");
  assert.isUndefined(geminiPermissionOptionId(native, "acceptForSession"));
});

it("chooses a tool-specific session grant without widening to all server tools or future sessions", () => {
  const native = request([
    {
      kind: "allow_always",
      optionId: "proceed_always_server",
      name: "Allow all server tools for this session",
    },
    { kind: "allow_always", optionId: "proceed_always_tool", name: "Allow tool for this session" },
    {
      kind: "allow_always",
      optionId: "proceed_always_and_save",
      name: "Allow tool for all future sessions",
    },
  ]);
  assert.deepEqual(geminiApprovalOptions(native)[0], {
    decision: "acceptForSession",
    label: "Allow tool for this session",
  });
  assert.equal(geminiPermissionOptionId(native, "acceptForSession"), "proceed_always_tool");
  assert.isUndefined(geminiPermissionOptionId(request([native.options[2]!]), "acceptForSession"));
});
