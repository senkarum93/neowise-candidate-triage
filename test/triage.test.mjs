import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createApp } from "../server.mjs";

let server;
let base;
before(async () => {
  server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(body, url = base) {
  const response = await fetch(`${url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}
const manualReview = { status: "manual_review", topic: null, draft: null };

for (const body of ["{", "", "null", "{}", '"text"', "[]", ...[
  "", " \n\t", 12, false, null, [], {},
].map(text => JSON.stringify({ text }))]) {
  test(`invalid input: ${JSON.stringify(body)}`, async () => {
    assert.deepEqual(await post(body), { status: 400, body: { status: "invalid_input" } });
  });
}
for (const [text, topic] of [["Когда доставка?", "delivery"], ["Какова стоимость?", "pricing"], ["Здравствуйте", "other"]]) {
  test(`valid topic: ${topic}`, async () => {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ready");
    assert.equal(response.body.topic, topic);
    assert.ok(response.body.draft.trim());
  });
}
for (const marker of ["timeout", "error", "bad-json", "bad-topic", "empty-draft"]) {
  test(`model failure: ${marker}`, async () => {
    const start = performance.now();
    assert.deepEqual(await post(JSON.stringify({ text: `[${marker}]` })), {
      status: 200, body: manualReview,
    });
    if (marker === "timeout") assert.ok(performance.now() - start < 1000, "must not wait for 1200 ms mock delay");
  });
}
test("request body size is bounded", async () => {
  assert.equal((await post(JSON.stringify({ text: "x".repeat(70_000) }))).status, 413);
});
test("timeout also handles a provider that ignores abort", async () => {
  const app = createApp({ classifyText: () => new Promise(() => {}) });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const response = await post('{"text":"hello"}', `http://127.0.0.1:${app.address().port}`);
    assert.deepEqual(response, { status: 200, body: manualReview });
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});
for (const value of [null, [], { topic: "other", draft: 42 }, { topic: "other", draft: "ok", status: "forged", extra: "ignored" }]) {
  test(`model response shape: ${JSON.stringify(value)}`, async () => {
    const app = createApp({ classifyText: async () => JSON.stringify(value) });
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    try {
      const response = await post('{"text":"hello"}', `http://127.0.0.1:${app.address().port}`);
      assert.deepEqual(response, { status: 200, body: value?.draft === "ok"
        ? { status: "ready", topic: "other", draft: "ok" } : manualReview });
    } finally {
      await new Promise(resolve => app.close(resolve));
    }
  });
}

// Run the actual page handler with a minimal DOM: no browser packages required.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function page(fetchReply) {
  let submit;
  const nodes = {
    form: { addEventListener: (_, handler) => { submit = handler; } },
    "#result": { textContent: "" },
    "#message": Object.assign(new EventTarget(), { value: "Когда доставка?" }),
    button: { disabled: false },
  };
  runInNewContext(script, {
    document: { querySelector: selector => nodes[selector] },
    fetch: fetchReply,
    AbortSignal,
  });
  return {
    nodes,
    submit: () => submit({ preventDefault() {} }),
    // Model native required validation: invalid fires instead of submit.
    requestSubmit: () => {
      if (nodes["#message"].value === "") {
        nodes["#message"].dispatchEvent(new Event("invalid", { cancelable: true }));
        return;
      }
      return submit({ preventDefault() {} });
    },
  };
}
for (const failure of ["manual_review", "network", "invalid-json", "http-error", "bad-ready"]) {
  test(`page clears previous draft on ${failure}`, async () => {
    let calls = 0;
    const ui = page(async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ status: "ready", topic: "delivery", draft: "Previous draft" }) };
      if (failure === "network") throw new Error("offline");
      return {
        ok: failure !== "http-error", status: failure === "http-error" ? 500 : 200,
        json: async () => {
          if (failure === "invalid-json") throw new SyntaxError("bad JSON");
          return failure === "bad-ready" ? { status: "ready", topic: "refund", draft: "unsafe" } : manualReview;
        },
      };
    });
    await ui.submit();
    assert.match(ui.nodes["#result"].textContent, /Previous draft/);
    const pending = ui.submit();
    assert.doesNotMatch(ui.nodes["#result"].textContent, /Previous draft/);
    assert.equal(ui.nodes.button.disabled, true);
    await pending;
    assert.match(ui.nodes["#result"].textContent, /Нужен ручной разбор/);
    assert.doesNotMatch(ui.nodes["#result"].textContent, /Previous draft/);
    assert.equal(ui.nodes.button.disabled, false);
  });
}
test("page rejects whitespace without an API request and clears draft", async () => {
  const ui = page(() => { assert.fail("must not fetch"); });
  ui.nodes["#message"].value = "   ";
  ui.nodes["#result"].textContent = "Previous draft";
  await ui.submit();
  assert.equal(ui.nodes["#result"].textContent, "Введите текст заявки.");
});

test("page clears a successful draft when required validation blocks empty input", async () => {
  assert.match(html, /<textarea\b[^>]*\bid="message"[^>]*\brequired\b/);
  let calls = 0;
  const ui = page(async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({
      status: "ready", topic: "delivery", draft: "Previous draft",
    }) };
  });
  await ui.requestSubmit();
  assert.match(ui.nodes["#result"].textContent, /Previous draft/);

  ui.nodes["#message"].value = "";
  await ui.requestSubmit();

  assert.equal(calls, 1, "empty input must not make another API request");
  assert.equal(ui.nodes["#result"].textContent, "Введите текст заявки.");
  assert.equal(ui.nodes.button.disabled, false);
});
