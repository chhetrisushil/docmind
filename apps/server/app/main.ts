import { app } from "./config";
import { createHttpServer } from "./server";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const server = createHttpServer();

server.listen(port, host, () => console.log(`docmind server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void app.close();
  });
}
