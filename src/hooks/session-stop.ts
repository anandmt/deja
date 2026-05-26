import { paths } from "../paths";
import { mapPayload } from "./map-payload";
import { trySendEvent, trySendRequest } from "./send";

const raw = JSON.parse(await Bun.stdin.text());
const payload = mapPayload(raw);

const requestId = `stop-${payload.session_id}-${Date.now()}`;

const response = await trySendRequest(
  paths.workerSock,
  { type: "request", id: requestId, hook: "Stop", payload },
  10000,
);

if (!response) {
  await trySendEvent(
    paths.workerSock,
    { type: "event", hook: "Stop", payload },
    paths.pendingWal,
    paths.walLock,
  );
}
