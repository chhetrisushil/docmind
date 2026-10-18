import type { Server } from "node:http";

/**
 * Stops accepting requests, lets in-flight ones finish, and only then closes the app.
 * `server.close()` waits for idle keep-alive sockets too, and one that goes idle after the call is
 * not closed for us, so idle sockets are swept until the server is down.
 */
export async function shutdown(server: Server, app: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sweep = setInterval(() => server.closeIdleConnections(), 50);
    server.close((err) => {
      clearInterval(sweep);
      return err ? reject(err) : resolve();
    });
    server.closeIdleConnections();
  });
  await app.close();
}
