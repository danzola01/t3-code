import { DesktopForkAppearanceStateSchema, DesktopForkSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopForkAppearance from "../../app/DesktopForkAppearance.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getForkAppearance = makeIpcMethod({
  channel: IpcChannels.GET_FORK_APPEARANCE_CHANNEL,
  payload: Schema.Void,
  result: DesktopForkAppearanceStateSchema,
  handler: Effect.fn("desktop.ipc.forkAppearance.get")(function* () {
    return yield* (yield* DesktopForkAppearance.DesktopForkAppearance).get;
  }),
});
export const setForkAppearance = makeIpcMethod({
  channel: IpcChannels.SET_FORK_APPEARANCE_CHANNEL,
  payload: DesktopForkSettingsSchema,
  result: DesktopForkAppearanceStateSchema,
  handler: Effect.fn("desktop.ipc.forkAppearance.set")(function* (settings) {
    return yield* (yield* DesktopForkAppearance.DesktopForkAppearance).set(settings);
  }),
});
