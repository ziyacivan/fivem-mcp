import dgram from "node:dgram";
import { encodeRconRequest } from "../../src/protocol/rcon.js";

/**
 * Fake UDP rcon endpoint. By default it authenticates against `password` and
 * answers `print <outputFor(command)>`; tests can switch modes.
 */
export class FakeRconServer {
  readonly receivedRequests: Buffer[] = [];
  mode: "ok" | "silent" | "bad-password" | "no-rcon" = "ok";
  port = 0;

  private socket = dgram.createSocket("udp4");

  constructor(
    private readonly password: string,
    private readonly respond: (command: string) => string = (command) => `ran: ${command}`,
  ) {}

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.socket.on("message", (msg, rinfo) => {
        this.receivedRequests.push(Buffer.from(msg));
        if (this.mode === "silent") return;

        const prefix = Buffer.from([0xff, 0xff, 0xff, 0xff]);
        const text = msg.subarray(4).toString("utf8");

        // getinfo OOB needs no auth: answer it like FXServer does.
        if (text.startsWith("getinfo")) {
          const challenge = text.slice("getinfo".length).trim().split(/ /)[0] ?? "";
          const reply = `infoResponse\n\\sv_maxclients\\48\\clients\\0\\challenge\\${challenge}\\gamename\\CitizenFX\\protocol\\4\\hostname\\fake test server\\gametype\\\\mapname\\\\iv\\179740983`;
          this.socket.send(
            Buffer.concat([prefix, Buffer.from(reply, "utf8")]),
            rinfo.port,
            rinfo.address,
          );
          return;
        }

        let reply: string;
        if (this.mode === "no-rcon") {
          reply = "print The server must set rcon_password to be able to use this command.\n";
        } else {
          // Wire layout: 0xFFFFFFFF + "rcon\n" + "<password> <command>".
          // The server strips the handler key before RconOutOfBand::Process
          // splits password and command on the first space.
          const keyEnd = text.search(/[ \n]/);
          const payload = keyEnd === -1 ? "" : text.slice(keyEnd + 1);
          const spacePos = payload.search(/[ \n]/);
          const given = spacePos === -1 ? "" : payload.slice(0, spacePos);
          const command = spacePos === -1 ? "" : payload.slice(spacePos + 1).trim();
          if (given !== this.password) {
            reply = "print Invalid password.\n";
          } else {
            reply = `print ${this.respond(command)}`;
          }
        }
        this.socket.send(
          Buffer.concat([prefix, Buffer.from(reply, "utf8")]),
          rinfo.port,
          rinfo.address,
        );
      });
      this.socket.bind(0, "127.0.0.1", () => {
        const address = this.socket.address();
        this.port = address.port;
        resolve(address.port);
      });
    });
  }

  /** The exact bytes our client puts on the wire for this request. */
  expectedRequest(password: string, command: string): Buffer {
    return encodeRconRequest(password, command);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }
}
