import { app } from "./config";
import { createHttpServer } from "./server";
import { shutdown } from "./shutdown";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const server = createHttpServer();

server.listen(port, host, () => console.log(`docmind server listening on http://${host}:${port}`));

// One shutdown, shared by every signal: a second signal reuses the same promise instead of
// calling server.close() again, which would reject with ERR_SERVER_NOT_RUNNING.
let closing: Promise<void> | undefined;
const stop = () => {
  closing ??= shutdown(server, app).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, stop);
}
