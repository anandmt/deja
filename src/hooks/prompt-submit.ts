import { paths } from "../paths";
import { mapPayload } from "./map-payload";
import { trySendEvent } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

await trySendEvent(
  paths.workerSock,
  { type: "event", hook: payload.type, payload },
  paths.pendingWal,
  paths.walLock,
);
