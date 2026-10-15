import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopForkAppearance from "./DesktopForkAppearance.ts";
import { setForkAppearance } from "../ipc/methods/forkAppearance.ts";

const terminal = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns";
const vscode = "/Applications/Visual Studio Code.app/Contents/Resources/Code.icns";
const defaultIcon = "/resources/icon.png";

function withAppearance<A, E, R>(
  program: Effect.Effect<
    A,
    E,
    R | DesktopForkAppearance.DesktopForkAppearance | DesktopAppSettings.DesktopAppSettings
  >,
  options: {
    readonly calls: string[];
    readonly available?: readonly string[];
    readonly initial?: DesktopAppSettings.DesktopSettings;
    readonly platform?: NodeJS.Platform;
    readonly failSave?: boolean;
    readonly failIcon?: boolean;
    readonly failConversion?: boolean;
  },
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const converted = new Map<string, string>();
    let conversionCount = 0;
    const initial = options.initial ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
    const settingsLayer = options.failSave
      ? Layer.mock(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.succeed(initial),
          setForkAppearance: () =>
            Effect.fail(
              new DesktopAppSettings.DesktopSettingsWriteError({
                operation: "replace-settings-file",
                path: "/tmp/test-settings.json",
                cause: new Error("disk full"),
              }),
            ),
        })
      : DesktopAppSettings.layerTest(initial);
    return yield* program.pipe(
      Effect.provide(
        DesktopForkAppearance.layer.pipe(
          Layer.provideMerge(settingsLayer),
          Layer.provide(
            DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/dist-electron",
              appPath: "/repo",
              resourcesPath: "/resources",
              platform: options.platform ?? "darwin",
              homeDirectory: "/Users/test",
              appVersion: "1.0.0",
              processArch: "arm64",
              isPackaged: true,
              runningUnderArm64Translation: false,
            }).pipe(
              Layer.provide(Layer.mergeAll(DesktopConfig.layerTest({}), NodePath.layerPosix)),
            ),
          ),
          Layer.provide(
            Layer.mock(DesktopAssets.DesktopAssets, {
              iconPaths: Effect.succeed({
                png: Option.some(defaultIcon),
                icns: Option.none(),
                ico: Option.none(),
              }),
            }),
          ),
          Layer.provide(
            Layer.mock(ElectronApp.ElectronApp, {
              setDockIcon: (icon) =>
                options.failIcon
                  ? Effect.die(new Error("invalid icon"))
                  : Effect.sync(() => {
                      options.calls.push(converted.get(icon) ?? icon);
                    }),
            }),
          ),
          Layer.provide(
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
              exitCode: (command) =>
                Effect.sync(() => {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") throw new Error("Expected sips command");
                  assert.equal(command.command, "/usr/bin/sips");
                  assert.deepEqual(command.args.slice(0, 3), ["-s", "format", "png"]);
                  const source = command.args[3];
                  const output = command.args[5];
                  if (!source || !output) throw new Error("Expected input and output icon paths");
                  assert.equal(command.args[4], "--out");
                  converted.set(output, source);
                  return ChildProcessSpawner.ExitCode(options.failConversion ? 1 : 0);
                }),
            }),
          ),
          Layer.provide(
            FileSystem.layerNoop({
              makeTempDirectoryScoped: () =>
                Effect.sync(() => path.join("/tmp", `test-dock-icon-${conversionCount++}`)),
              exists: (candidate) =>
                Effect.succeed((options.available ?? [terminal, vscode]).includes(candidate)),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodePath.layerPosix, Logger.layer([]))));
}

describe("DesktopForkAppearance", () => {
  it.effect("can turn stealth off after its source app is removed", () => {
    const calls: string[] = [];
    const available = [terminal, vscode];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        yield* appearance.set({ stealthEnabled: true, stealthIcon: "vscode" });
        available.splice(1, 1);
        const state = yield* appearance.set({ stealthEnabled: false, stealthIcon: "vscode" });
        assert.equal(state.activeIcon, "default");
        assert.isFalse(state.settings.stealthEnabled);
        assert.deepEqual(calls, [vscode, defaultIcon]);
      }),
      { calls, available },
    );
  });

  it.effect("leaves the current icon and preference alone when conversion fails", () => {
    const calls: string[] = [];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        const error = yield* appearance
          .set({ stealthEnabled: true, stealthIcon: "terminal" })
          .pipe(Effect.flip);
        assert.instanceOf(error, DesktopForkAppearance.DesktopForkAppearanceError);
        const state = yield* appearance.get;
        assert.isFalse(state.settings.stealthEnabled);
        assert.equal(state.activeIcon, "default");
        assert.deepEqual(calls, []);
      }),
      { calls, failConversion: true },
    );
  });
  it.effect("leaves the normal packaged icon untouched at startup", () => {
    const calls: string[] = [];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        yield* appearance.configure;
        const state = yield* appearance.get;
        assert.isTrue(state.supported);
        assert.deepEqual(state.availableIcons, ["terminal", "vscode"]);
        assert.equal(state.activeIcon, "default");
        assert.deepEqual(calls, []);
      }),
      { calls },
    );
  });

  it.effect(
    "switches live between installed icons and restores the default without losing the choice",
    () => {
      const calls: string[] = [];
      return withAppearance(
        Effect.gen(function* () {
          const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
          assert.equal(
            (yield* appearance.set({ stealthEnabled: true, stealthIcon: "terminal" })).activeIcon,
            "terminal",
          );
          assert.equal(
            (yield* appearance.set({ stealthEnabled: true, stealthIcon: "vscode" })).activeIcon,
            "vscode",
          );
          const off = yield* appearance.set({ stealthEnabled: false, stealthIcon: "vscode" });
          assert.equal(off.activeIcon, "default");
          assert.equal(off.settings.stealthIcon, "vscode");
          yield* appearance.set({ stealthEnabled: true, stealthIcon: off.settings.stealthIcon });
          assert.deepEqual(calls, [terminal, vscode, defaultIcon, vscode]);
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          assert.isTrue((yield* settings.get).wslBackendEnabled);
        }),
        {
          calls,
          initial: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, wslBackendEnabled: true },
        },
      );
    },
  );

  it.effect("restores a saved stealth icon after startup", () => {
    const calls: string[] = [];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        yield* appearance.configure;
        assert.equal((yield* appearance.get).activeIcon, "vscode");
        assert.deepEqual(calls, [vscode]);
      }),
      {
        calls,
        initial: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          forkAppearance: { stealthEnabled: true, stealthIcon: "vscode" },
        },
      },
    );
  });

  it.effect("rejects unavailable artwork without changing the icon or saved settings", () => {
    const calls: string[] = [];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        const error = yield* appearance
          .set({ stealthEnabled: true, stealthIcon: "vscode" })
          .pipe(Effect.flip);
        assert.instanceOf(error, DesktopForkAppearance.DesktopForkAppearanceError);
        const state = yield* appearance.get;
        assert.deepEqual(state.availableIcons, ["terminal"]);
        assert.isFalse(state.settings.stealthEnabled);
        assert.equal(state.activeIcon, "default");
        assert.deepEqual(calls, []);
      }),
      { calls, available: [terminal] },
    );
  });

  it.effect(
    "keeps startup working when the saved application's icon is no longer installed",
    () => {
      const calls: string[] = [];
      return withAppearance(
        Effect.gen(function* () {
          const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
          yield* appearance.configure;
          const state = yield* appearance.get;
          assert.equal(state.activeIcon, "default");
          assert.isTrue(state.settings.stealthEnabled);
          yield* appearance.set({ ...state.settings, stealthEnabled: false });
          assert.isFalse((yield* appearance.get).settings.stealthEnabled);
          assert.deepEqual(calls, []);
        }),
        {
          calls,
          available: [terminal],
          initial: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            forkAppearance: { stealthEnabled: true, stealthIcon: "vscode" },
          },
        },
      );
    },
  );

  it.effect("rolls back the Dock icon when persisting the preference fails", () => {
    const calls: string[] = [];
    return withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        const error = yield* appearance
          .set({ stealthEnabled: true, stealthIcon: "terminal" })
          .pipe(Effect.flip);
        assert.instanceOf(error, DesktopAppSettings.DesktopSettingsWriteError);
        assert.deepEqual(calls, [terminal, defaultIcon]);
        assert.equal((yield* appearance.get).activeIcon, "default");
        assert.isFalse((yield* appearance.get).settings.stealthEnabled);
      }),
      { calls, failSave: true },
    );
  });

  it.effect("does not save an icon Electron cannot apply", () =>
    withAppearance(
      Effect.gen(function* () {
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        const error = yield* appearance
          .set({ stealthEnabled: true, stealthIcon: "terminal" })
          .pipe(Effect.flip);
        assert.instanceOf(error, DesktopForkAppearance.DesktopForkAppearanceError);
        assert.isFalse((yield* appearance.get).settings.stealthEnabled);
      }),
      { calls: [], failIcon: true },
    ),
  );

  it.effect.each(["linux", "win32"] as const)(
    "does not change desktop identity on %s",
    (platform) => {
      const calls: string[] = [];
      return withAppearance(
        Effect.gen(function* () {
          const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
          yield* appearance.configure;
          const state = yield* appearance.get;
          assert.isFalse(state.supported);
          assert.deepEqual(state.availableIcons, []);
          const error = yield* appearance
            .set({ stealthEnabled: true, stealthIcon: "terminal" })
            .pipe(Effect.flip);
          assert.instanceOf(error, DesktopForkAppearance.DesktopForkAppearanceError);
          assert.deepEqual(calls, []);
        }),
        { calls, platform },
      );
    },
  );

  it.effect("rejects unsupported icon values at the IPC boundary", () =>
    withAppearance(
      Effect.gen(function* () {
        const failure = yield* setForkAppearance
          .handler({ stealthEnabled: true, stealthIcon: "other" })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failure));
        const appearance = yield* DesktopForkAppearance.DesktopForkAppearance;
        assert.isFalse((yield* appearance.get).settings.stealthEnabled);
      }),
      { calls: [] },
    ),
  );
});
