#!/usr/bin/env node
// Prints a 1-hour installation token that can set an issue assignee and nothing else.
// Env: GITHUB_ASSIGN_APP_ID, GITHUB_ASSIGN_INSTALLATION_ID, GITHUB_ASSIGN_PRIVATE_KEY.
// stdout is the token only. A token with any other permission is discarded.
import crypto from "node:crypto";
const PERMS = { metadata: "read", issues: "write" };
const APP_ID = process.env.GITHUB_ASSIGN_APP_ID;
const INSTALL_ID = process.env.GITHUB_ASSIGN_INSTALLATION_ID;
if (!APP_ID || !INSTALL_ID) process.exit(1);
const raw = process.env.GITHUB_ASSIGN_PRIVATE_KEY || "";
const m = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
if (!m) process.exit(1);
const key = `-----BEGIN ${m[1]}-----\n${m[2].replace(/\s+/g, "").match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = b({ alg: "RS256", typ: "JWT" }) + "." + b({ iat: now - 60, exp: now + 540, iss: APP_ID });
const jwt = unsigned + "." + crypto.createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
const r = await fetch(`https://api.github.com/app/installations/${INSTALL_ID}/access_tokens`, {
  method: "POST",
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json",
             "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
  body: JSON.stringify({ permissions: PERMS }) });
const j = await r.json();
if (!j.token) process.exit(1);
const perms = j.permissions || {};
const bad = Object.entries(perms).filter(([k, v]) => PERMS[k] !== v);
if (perms.issues !== "write" || bad.length) process.exit(2);
process.stdout.write(j.token);
