import {
  type DesktopForkAppearanceState,
  type DesktopForkSettings,
  type DesktopStealthIcon,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopForkAppearanceError extends Schema.TaggedError<DesktopForkAppearanceError>()(
  "DesktopForkAppearanceError",
  { detail: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export class DesktopForkAppearance extends Context.Service<
  DesktopForkAppearance,
  {
    readonly get: Effect.Effect<DesktopForkAppearanceState>;
    readonly configure: Effect.Effect<void>;
    readonly set: (
      settings: DesktopForkSettings,
    ) => Effect.Effect<
      DesktopForkAppearanceState,
      DesktopForkAppearanceError | DesktopAppSettings.DesktopSettingsWriteError
    >;
  }
>()("@t3tools/desktop/app/DesktopForkAppearance") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const assets = yield* DesktopAssets.DesktopAssets;
  const app = yield* ElectronApp.ElectronApp;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const activeIcon = yield* Ref.make<DesktopForkAppearanceState["activeIcon"]>("default");
  const activeImage = yield* Ref.make<string | undefined>(undefined);
  const renderedImages = new Map<string, string>();
  const lock = yield* Semaphore.make(1);
  const supported = environment.platform === "darwin";
  // Reuse installed applications' full-resolution artwork; do not modify either application.
  const candidates: Record<DesktopStealthIcon, readonly string[]> = {
    terminal: [
      "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns",
      "/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns",
    ],
    vscode: [
      "/Applications/Visual Studio Code.app/Contents/Resources/Code.icns",
      environment.path.join(
        environment.homeDirectory,
        "Applications/Visual Studio Code.app/Contents/Resources/Code.icns",
      ),
    ],
  };
  const findIcon = Effect.fn("desktop.forkAppearance.findIcon")(function* (
    icon: DesktopStealthIcon,
  ) {
    if (!supported) return Option.none<string>();
    for (const candidate of candidates[icon]) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        return Option.some(candidate);
    }
    return Option.none<string>();
  });
  const resolveIcon = Effect.fn("desktop.forkAppearance.resolveIcon")(function* (
    icon: DesktopForkAppearanceState["activeIcon"],
  ) {
    const resolved =
      icon === "default"
        ? yield* assets.iconPaths.pipe(
            Effect.map((paths) => paths.png),
            Effect.mapError(
              (cause) =>
                new DesktopForkAppearanceError({
                  detail: "Could not load the default Dock icon.",
                  cause,
                }),
            ),
          )
        : yield* findIcon(icon);
    if (Option.isNone(resolved))
      return yield* new DesktopForkAppearanceError({
        detail:
          icon === "default"
            ? "The default Dock icon is unavailable."
            : `The ${icon === "terminal" ? "Terminal" : "VS Code"} icon is unavailable. Install the app in Applications first.`,
      });
    return resolved.value;
  });
  const apply = (path: string) =>
    Effect.gen(function* () {
      let imagePath = renderedImages.get(path) ?? path;
      if (path.endsWith(".icns") && !renderedImages.has(path)) {
        // Electron decodes PNG/JPEG, not ICNS. Convert the native artwork locally.
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dock-icon-" });
        imagePath = environment.path.join(directory, "icon.png");
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make("/usr/bin/sips", ["-s", "format", "png", path, "--out", imagePath], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        if (exitCode !== 0)
          return yield* new DesktopForkAppearanceError({
            detail: "Could not convert the application icon.",
          });
        renderedImages.set(path, imagePath);
      }
      yield* app.setDockIcon(imagePath);
      return imagePath;
    }).pipe(
      // Keep at most one converted image per installed app until the desktop exits.
      Effect.provideService(Scope.Scope, scope),
      Effect.catchCause(
        (cause) =>
          new DesktopForkAppearanceError({ detail: "Could not change the Dock icon.", cause }),
      ),
    );
  const get = Effect.gen(function* () {
    const availableIcons: DesktopStealthIcon[] = [];
    for (const icon of ["terminal", "vscode"] as const) {
      if (Option.isSome(yield* findIcon(icon))) availableIcons.push(icon);
    }
    return {
      settings: (yield* settings.get).forkAppearance,
      supported,
      availableIcons,
      activeIcon: yield* Ref.get(activeIcon),
    };
  });
  const set = Effect.fn("desktop.forkAppearance.set")(function* (value: DesktopForkSettings) {
    if (!supported)
      return yield* new DesktopForkAppearanceError({
        detail: "Dock appearance is available on macOS desktop only.",
      });
    const previous = yield* Ref.get(activeIcon);
    const next = value.stealthEnabled ? value.stealthIcon : "default";
    // Keep the displayed image available for rollback, even if its source app is removed.
    const previousPath =
      previous !== next
        ? ((yield* Ref.get(activeImage)) ?? (yield* resolveIcon("default")))
        : undefined;
    const nextPath =
      previous !== next ? yield* apply(yield* resolveIcon(next)) : yield* Ref.get(activeImage);
    yield* settings
      .setForkAppearance(value)
      .pipe(
        Effect.tapError(() =>
          previousPath === undefined ? Effect.void : apply(previousPath).pipe(Effect.ignoreCause),
        ),
      );
    yield* Ref.set(activeIcon, next);
    yield* Ref.set(activeImage, nextPath);
    return yield* get;
  });
  return DesktopForkAppearance.of({
    get,
    set: (value) => lock.withPermit(set(value)),
    configure: lock
      .withPermit(
        Effect.gen(function* () {
          const value = (yield* settings.get).forkAppearance;
          if (supported && value.stealthEnabled) {
            const image = yield* apply(yield* resolveIcon(value.stealthIcon));
            yield* Ref.set(activeImage, image);
            yield* Ref.set(activeIcon, value.stealthIcon);
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not restore the saved Dock appearance", { cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(DesktopForkAppearance, make);
