#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { WHOOP_AUTH_URL, WHOOP_SCOPES, exchangeCode } from "./whoop/auth.js";
import { FileTokenStore } from "./store/file-store.js";

const DEFAULT_PORT = 8788;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      shell: process.platform === "win32",
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      /* No browser available (headless, SSH). The URL is printed regardless. */
    });
    child.unref();
  } catch {
    /* Same - the printed URL is the fallback. */
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.WHOOP_REDIRECT_PORT ?? DEFAULT_PORT);
  const redirectUri = process.env.WHOOP_REDIRECT_URI ?? `http://127.0.0.1:${port}/callback`;

  let clientId = process.env.WHOOP_CLIENT_ID ?? "";
  let clientSecret = process.env.WHOOP_CLIENT_SECRET ?? "";

  if (!clientId) clientId = await prompt("WHOOP client ID: ");
  if (!clientSecret) clientSecret = await prompt("WHOOP client secret: ");

  if (!clientId || !clientSecret) {
    console.error("Both a client ID and client secret are required.");
    process.exit(1);
  }

  // WHOOP requires the state parameter to be at least 8 characters.
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(WHOOP_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", WHOOP_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");

      const finish = (status: number, message: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>WHOOP MCP</title>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem">
<h1>WHOOP MCP</h1><p>${message}</p></body>`);
      };

      if (error) {
        finish(400, `Authorisation failed: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`WHOOP returned an error: ${error}`));
        return;
      }

      // Guards against a forged callback being used to plant someone else's code.
      if (returnedState !== state) {
        finish(400, "State mismatch — the request did not originate here. You can close this tab.");
        server.close();
        reject(new Error("State parameter mismatch; aborting."));
        return;
      }

      if (!returnedCode) {
        finish(400, "No authorisation code in the callback. You can close this tab.");
        server.close();
        reject(new Error("No authorisation code returned."));
        return;
      }

      finish(200, "Authorised. You can close this tab and return to the terminal.");
      server.close();
      resolve(returnedCode);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Set WHOOP_REDIRECT_PORT to a free port and register the matching redirect URI in the WHOOP dashboard.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\nListening on ${redirectUri}`);
      console.log("\nOpen this URL to authorise (it should open automatically):\n");
      console.log(authUrl.toString() + "\n");
      openBrowser(authUrl.toString());
    });

    setTimeout(
      () => {
        server.close();
        reject(new Error("Timed out after 5 minutes waiting for authorisation."));
      },
      5 * 60 * 1000,
    ).unref();
  });

  console.log("Exchanging authorisation code for tokens...");
  const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });

  const store = new FileTokenStore();
  await store.save(tokens);

  console.log(`\nDone. Credentials saved to ${store.describe()} (permissions 0600).`);
  console.log(`Granted scopes: ${tokens.scope}`);
  if (!tokens.scope.includes("offline")) {
    console.warn(
      "\nWarning: the 'offline' scope was not granted, so no refresh token was issued.\n" +
        "Access will stop working in about an hour. Re-run the login and make sure the\n" +
        "consent screen includes offline access.",
    );
  }
}

main().catch((err) => {
  console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
