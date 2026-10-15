import { useEffect, useState } from "react";
import type { DesktopForkAppearanceState, DesktopForkSettings } from "@t3tools/contracts";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ForkSettings() {
  const [state, setState] = useState<DesktopForkAppearanceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.desktopBridge;

  useEffect(() => {
    let cancelled = false;
    if (!bridge?.getForkAppearance) return;
    void bridge.getForkAppearance().then(
      (result) => {
        if (!cancelled) setState(result);
      },
      () => {
        if (!cancelled) setError("Could not load Dock appearance. Try reopening Settings.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const update = async (settings: DesktopForkSettings) => {
    if (!bridge?.setForkAppearance || busy) return;
    setBusy(true);
    setError(null);
    try {
      setState(await bridge.setForkAppearance(settings));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save Dock appearance.");
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !state?.supported;
  const settings = state?.settings ?? { stealthEnabled: false, stealthIcon: "terminal" };
  const available = state?.availableIcons ?? [];
  const unavailableMessage = !bridge?.getForkAppearance
    ? "Available in the macOS desktop app. If you already use it, update the desktop app to enable this setting."
    : state && !state.supported
      ? "Dock appearance is available on macOS desktop only."
      : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Desktop appearance">
        <SettingsRow
          id="fork-stealth-mode"
          title="Stealth mode"
          description="Use a Terminal or VS Code icon in this Mac’s Dock. Changes apply immediately and are remembered after restarting."
          status={unavailableMessage ?? (!state && !error ? "Loading appearance…" : undefined)}
          control={
            <Switch
              aria-label="Stealth mode"
              checked={settings.stealthEnabled}
              disabled={
                disabled || (!settings.stealthEnabled && !available.includes(settings.stealthIcon))
              }
              onCheckedChange={(stealthEnabled) => void update({ ...settings, stealthEnabled })}
            />
          }
        />
        <SettingsRow
          id="fork-stealth-icon"
          title="Stealth icon"
          description="Uses artwork from the installed app. VS Code must be installed in Applications or your user’s Applications folder."
          control={
            <Select
              value={settings.stealthIcon}
              disabled={disabled}
              onValueChange={(stealthIcon) => {
                if (stealthIcon === "terminal" || stealthIcon === "vscode")
                  void update({ ...settings, stealthIcon });
              }}
            >
              <SelectTrigger aria-label="Stealth icon">
                <SelectValue>
                  {settings.stealthIcon === "terminal" ? "Terminal" : "VS Code"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="terminal" disabled={!available.includes("terminal")}>
                  Terminal{available.includes("terminal") ? "" : " (not installed)"}
                </SelectItem>
                <SelectItem value="vscode" disabled={!available.includes("vscode")}>
                  VS Code{available.includes("vscode") ? "" : " (not installed)"}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state?.settings.stealthEnabled && state.activeIcon !== state.settings.stealthIcon ? (
        <p role="status" className="text-sm text-muted-foreground">
          The saved stealth icon could not be applied. Choose an installed app or turn stealth mode
          off.
        </p>
      ) : null}
      <p className="px-3 text-xs leading-relaxed text-muted-foreground sm:px-4">
        This changes the running Dock icon only. The app name, Finder icon, notifications, and
        process identity remain T3 Code. Turn stealth mode off to restore the T3 Code icon.
      </p>
    </SettingsPageContainer>
  );
}
