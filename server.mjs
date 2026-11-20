import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";
import { pathToFileURL } from "node:url";

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const manualReview = { status: "manual_review", topic: null, draft: null };
const topics = new Set(["delivery", "pricing", "other"]);

async function modelResult(text, classifyText) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timeout"));
        controller.abort();
      }, 300);
    });
    const raw = await Promise.race([
      Promise.resolve().then(() => classifyText(text, { signal: controller.signal })),
      timeout,
    ]);
    const result = JSON.parse(raw);
    if (!result || !topics.has(result.topic) ||
        typeof result.draft !== "string" || !result.draft.trim()) {
      return manualReview;
    }
    return { status: "ready", topic: result.topic, draft: result.draft };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, classifyText) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      return json(response, 413, { status: "invalid_input" });
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  return json(response, 200, await modelResult(body.text, classifyText));
}

export function createApp({ classifyText = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifyText);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
