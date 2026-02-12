import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { emailPlugin } from "./channel.js";
import { createEmailInboundHandler, getEmailClient } from "./email/monitor.js";
import { setEmailRuntime } from "./runtime.js";

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const plugin = {
  id: "email",
  name: "Email (Gmail)",
  description: "Email (Gmail) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setEmailRuntime(api.runtime);
    api.registerChannel({ plugin: emailPlugin });

    api.registerHttpRoute({
      path: "/email/inbound",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "", "http://localhost");
        const accountId = url.searchParams.get("accountId") ?? "default";

        const body = await parseBody(req);
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key] = Array.isArray(value) ? value[0] : value;
        }

        const handler = createEmailInboundHandler({
          getClient: async (id) => getEmailClient(id),
          accountId,
        });

        await handler(
          { body, headers },
          {
            status: (code: number) => {
              res.statusCode = code;
              return {
                json: (data: unknown) => {
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify(data));
                },
                end: () => res.end(),
              };
            },
          },
        );
      },
    });
  },
};

export default plugin;
