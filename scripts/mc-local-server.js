#!/usr/bin/env node
// Mission Control local ring-buffer server for dev testing
// Usage: MC_LOCAL_SECRET=xxx node scripts/mc-local-server.js
import http from "http";

const MAX_EVENTS = 200;
const PORT = 3456;
const SECRET = process.env.MC_LOCAL_SECRET || null;

/** @type {Array<{id: string, type: string, wallet?: string, chain?: string, timestamp: number, [key: string]: unknown}>} */
const events = [];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function checkAuth(req) {
  if (!SECRET) return true; // dev mode — allow all
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${SECRET}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === "/api/mission-control-events") {
    if (req.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const filtered = since > 0
        ? events.filter((e) => e.timestamp > since)
        : events.slice();
      sendJson(res, 200, { events: filtered, serverTime: Date.now() });
      return;
    }

    if (req.method === "POST") {
      if (!checkAuth(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      let event;
      try {
        event = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      // Ensure timestamp
      if (!event.timestamp) event.timestamp = Date.now();

      events.push(event);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

      const { type = "?", wallet = "-", chain = "-" } = event;
      console.log(`[mc-server] EVENT ${type} ${wallet} ${chain}`);

      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  const mode = SECRET ? "auth-required" : "dev (no auth)";
  console.log(`[mc-server] listening on http://localhost:${PORT} [${mode}]`);
});
