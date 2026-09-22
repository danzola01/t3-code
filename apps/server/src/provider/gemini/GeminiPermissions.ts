import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import type * as Acp from "effect-acp/schema";

function permissionOption(
  request: Acp.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
) {
  if (decision === "cancel") return undefined;
  if (decision === "acceptForSession") {
    // Gemini can also advertise server-wide and permanent grants. The shared
    // session decision must never silently widen to either of those scopes.
    return ["proceed_always_tool", "proceed_always"].flatMap((id) =>
      request.options.filter((option) => option.kind === "allow_always" && option.optionId === id),
    )[0];
  }
  const kind = decision === "accept" ? "allow_once" : "reject_once";
  return request.options.find((option) => option.kind === kind && option.optionId.trim());
}

export function geminiPermissionOptionId(
  request: Acp.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
) {
  return permissionOption(request, decision)?.optionId;
}

export function geminiApprovalOptions(
  request: Acp.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const decisions = ["accept", "acceptForSession", "decline"] as const;
  return [
    ...decisions.flatMap((decision) => {
      const option = permissionOption(request, decision);
      return option ? [{ decision, label: option.name.trim() || option.optionId }] : [];
    }),
    { decision: "cancel", label: "Cancel" },
  ];
}
