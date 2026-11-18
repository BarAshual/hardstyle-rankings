// Actual admin UI -> local Data API -> PostgreSQL regression.
// Run after the DB suite, against a disposable project with the repository's
// migrations and five synthetic identities. db_support enforces that boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.LOCAL_TEST_ROOT;
assert(root, "LOCAL_TEST_ROOT must point to a disposable local test copy");
const origin = new URL(process.env.BROWSER_TEST_URL || "http://127.0.0.1:57430");
assert.equal(origin.hostname, "127.0.0.1");
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : "playwright");
const fixture = JSON.parse(execFileSync("python3", ["-B", "-c", `
import json, uuid
from test_foundation import ADMIN, MEMBER, OUTSIDER, call
from test_http import DataAPI
from db_support import LOCAL
DataAPI.setUpClass()
http = DataAPI()
sid = call(ADMIN, 'create_season', 'Browser reveal synthetic', 2026, 4, 'Synthetic admin')
invite = call(ADMIN, 'invite_member', sid, 'fixture2@example.invalid')
call(MEMBER, 'accept_invitation', invite, 'Synthetic member')
track = call(ADMIN, 'add_track', sid, 'Synthetic anthem', ['Synthetic artist'])
call(ADMIN, 'transition_season', sid, 'VOTING')
call(MEMBER, 'cast_vote', sid, track, 'LIKE', 0, uuid.uuid4())
print(json.dumps({'season': str(sid), 'api': LOCAL['API_URL'], 'key': LOCAL['ANON_KEY'],
 'sessions': {user: {'access_token': http.token(user), 'refresh_token': 'synthetic-only',
 'expires_at': 4102444800, 'expires_in': 3600, 'token_type': 'bearer',
 'user': {'id': user, 'aud': 'authenticated', 'role': 'authenticated'}}
 for user in (ADMIN, MEMBER, OUTSIDER)}, 'admin': ADMIN, 'member': MEMBER, 'outsider': OUTSIDER}))
`], { cwd: root, env: { ...process.env, PYTHONPATH: [resolve(root, "tests/database"), process.env.PYTHONPATH || ""].join(":") }, encoding: "utf8" }));
assert.equal(new URL(fixture.api).hostname, "127.0.0.1");
async function rpc(user, name) {
  return fetch(fixture.api + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { apikey: fixture.key, Authorization: "Bearer " + fixture.sessions[user].access_token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_season: fixture.season }),
  });
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(session => localStorage.setItem("sb-127-auth-token", JSON.stringify(session)), fixture.sessions[fixture.admin]);
  const page = await context.newPage();
  const errors = [];
  const responseChecks = [];
  const forbiddenReads = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    // Chromium also logs HTTP failures to the console. Validate their actual
    // status/body below; keep independent JavaScript/console failures visible.
    if (message.text().startsWith("Failed to load resource:") &&
        /\/(rest\/v1\/rpc\/import_context|favicon\.ico)(?:\?|$)/.test(message.location().url)) return;
    errors.push(message.text());
  });
  page.on("response", response => {
    if (response.status() < 400) return;
    responseChecks.push((async () => {
      const path = new URL(response.url()).pathname;
      // The existing importer contract reports an unconfigured or closed
      // catalog as 400. These are expected in this lifecycle-only fixture.
      if (path === "/rest/v1/rpc/import_context" && response.status() === 400) {
        const body = await response.json();
        if (body.code === "P0001" && ["source_not_designated", "catalog_closed"].includes(body.message)) return;
      }
      if (path === "/favicon.ico" && response.status() === 404) return;
      errors.push(response.status() + " " + path);
    })());
  });
  page.on("request", request => {
    if (/\/rest\/v1\/(votes|vote_events)|get_love_similarity_results/.test(request.url())) forbiddenReads.push(request.url());
  });
  const path = origin.origin + "/seasons/" + fixture.season + "/admin";
  await page.goto(path);
  await page.getByRole("button", { name: "Close voting", exact: true }).waitFor();
  await page.getByText("Synthetic member", { exact: true }).waitFor();
  await page.getByText("Synthetic admin", { exact: true }).waitFor();
  assert.match(await page.locator(".admin-member-list").innerText(), /1\/1 rated/);
  assert.equal(await page.getByRole("heading", { name: "Love similarity", exact: true }).count(), 0);
  assert.equal((await rpc(fixture.member, "get_love_similarity_results")).status, 403);
  await page.getByRole("button", { name: "Close voting", exact: true }).click();
  await page.getByRole("button", { name: "Confirm close voting", exact: true }).click();
  await page.getByRole("button", { name: "Enter reveal", exact: true }).waitFor();
  assert.equal((await rpc(fixture.admin, "get_love_similarity_results")).status, 403);
  await page.getByRole("button", { name: "Enter reveal", exact: true }).click();
  await page.getByRole("button", { name: "Confirm enter reveal", exact: true }).click();
  await page.getByRole("link", { name: "See results", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "See results", exact: true }).getAttribute("href"), "/seasons/" + fixture.season + "/results");
  await page.reload();
  await page.getByRole("link", { name: "See results", exact: true }).waitFor();
  const result = await rpc(fixture.member, "get_love_similarity_results");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control"), /no-store/);
  assert.equal((await result.json()).algorithm, "taste-love-v1");
  const metadata = await (await rpc(fixture.admin, "get_love_similarity_visibility")).json();
  assert.deepEqual([metadata.visible, metadata.canChange, metadata.state], [true, false, "REVEAL"]);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "horizontal overflow at " + width);
  }
  assert.deepEqual(forbiddenReads, []);
  await Promise.all(responseChecks);
  assert.deepEqual(errors, []);
  for (const user of [fixture.member, fixture.outsider]) {
    const denied = await browser.newContext();
    await denied.addInitScript(session => localStorage.setItem("sb-127-auth-token", JSON.stringify(session)), fixture.sessions[user]);
    const p = await denied.newPage();
    await p.goto(path);
    await p.getByRole("alert").filter({ hasText: "aren’t available" }).waitFor();
    assert.equal(await p.getByRole("link", { name: "See results" }).count(), 0);
    await denied.close();
  }
  console.log("PASS: real browser close -> LOCKED secrecy -> REVEAL -> reload; member read; admin authorization; no preference reads by panel; 320/390/1280px.");
} finally {
  await browser.close();
}
