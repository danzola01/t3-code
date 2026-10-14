import { GeminiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

export const geminiClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("gemini"),
  label: "Gemini",
  badgeLabel: "Early Access",
  settingsSchema: GeminiSettings,
  hasDefaultInstance: false,
});
