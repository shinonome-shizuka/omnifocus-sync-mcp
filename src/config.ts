import os from "node:os";
import path from "node:path";

export interface Config {
  username: string;
  password: string;
  passphrase: string;
  syncBaseUrl: string;
  database: string;
  ofocusUrl: string;
  clientName: string;
  clientStateFile: string;
  readOnly: boolean;
  /** "digest" | "basic" | "auto" (default). auto picks from WWW-Authenticate. */
  authScheme: "digest" | "basic" | "auto";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const username = required("OMNIFOCUS_SYNC_USERNAME");
  const password = required("OMNIFOCUS_SYNC_PASSWORD");
  // By default OmniFocus derives the encryption passphrase from the sync password.
  const passphrase = process.env.OMNIFOCUS_ENCRYPTION_PASSPHRASE ?? password;
  const syncBaseUrl = (process.env.OMNIFOCUS_SYNC_URL ?? "https://sync.omnigroup.com").replace(
    /\/+$/,
    "",
  );
  const database = process.env.OMNIFOCUS_DATABASE ?? "OmniFocus.ofocus";
  // Self-hosted WebDAV often stores the .ofocus package at a custom path
  // (no /<username>/ segment). Point OMNIFOCUS_OFOCUS_URL at it directly.
  const ofocusUrl = (
    process.env.OMNIFOCUS_OFOCUS_URL ?? `${syncBaseUrl}/${encodeURIComponent(username)}/${database}/`
  ).replace(/\/+$/, "") + "/";
  const clientName = process.env.OMNIFOCUS_CLIENT_NAME ?? `omnifocus-sync-mcp@${os.hostname()}`;
  const clientStateFile =
    process.env.OMNIFOCUS_CLIENT_STATE_FILE ??
    path.join(os.homedir(), ".config", "omnifocus-sync-mcp", "client.json");
  const readOnly = /^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY ?? "");
  const authSchemeRaw = (process.env.OMNIFOCUS_SYNC_AUTH ?? "auto").toLowerCase();
  const authScheme: "digest" | "basic" | "auto" =
    authSchemeRaw === "digest" || authSchemeRaw === "basic" ? authSchemeRaw : "auto";
  return {
    username,
    password,
    passphrase,
    syncBaseUrl,
    database,
    ofocusUrl,
    clientName,
    clientStateFile,
    readOnly,
    authScheme,
  };
}
