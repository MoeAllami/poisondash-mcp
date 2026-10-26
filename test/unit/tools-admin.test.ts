import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import "../../src/tools/admin.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { __resetAuthStateForTests } from "../../src/auth.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof mock.fn>;

beforeEach(() => {
  __resetAuthStateForTests({ token: "tok" });
  fetchMock = mock.method(globalThis, "fetch");
});

afterEach(() => {
  mock.restoreAll();
});

describe("admin tool visibility gate", () => {
  test("admin tools are registered regardless of POISONDASH_ADMIN (gate affects enabled(), not registration)", () => {
    assert.ok(ToolRegistry.has("list_pending_datasets"));
    assert.ok(ToolRegistry.has("get_system_stats"));
  });

  test("enabled() reflects config.adminToolsEnabled, defaulting to false in this test run", () => {
    const tool = ToolRegistry.get("get_system_stats")!;
    // POISONDASH_ADMIN is not set in the test environment, so the gate reads false --
    // this only hides the tool from tools/list; the tool is still directly callable
    // here (as index.ts would, since a client could still name it), matching the
    // documented "cosmetic gate, backend enforces real authority" behavior.
    assert.equal(tool.enabled?.(), false);
  });
});

describe("list_pending_datasets", () => {
  test("hits GET /api/admin/datasets?status=pending and resolves uploader usernames", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/admin/datasets") {
        assert.equal(parsed.searchParams.get("status"), "pending");
        return jsonResponse({
          datasets: [
            { id: 7, name: "suspect.npz", uploaded_by: 4, file_size_bytes: 4490, approval_status: "pending", created_at: "2026-07-31T00:00:00" },
          ],
          total: 1,
        });
      }
      if (parsed.pathname === "/api/admin/users/4") {
        return jsonResponse({ id: 4, username: "mcptest", email: "mcptest@poisondash.local", role: "registered" });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const tool = ToolRegistry.get("list_pending_datasets")!;
    const result = await tool.handler(tool.schema.parse({}));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /#7 suspect\.npz -- uploaded by mcptest/);
  });

  test("falls back to user#<id> when the username lookup fails", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/admin/datasets") {
        return jsonResponse({
          datasets: [{ id: 7, name: "suspect.npz", uploaded_by: 4, file_size_bytes: 4490, approval_status: "pending", created_at: null }],
          total: 1,
        });
      }
      return new Response(JSON.stringify({ detail: "User not found" }), { status: 404 });
    });

    const tool = ToolRegistry.get("list_pending_datasets")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.match((result.content[0] as { text: string }).text, /uploaded by user#4/);
  });

  test("empty pending queue reports the total without rows", async () => {
    fetchMock.mock.mockImplementation(async () => jsonResponse({ datasets: [], total: 0 }));
    const tool = ToolRegistry.get("list_pending_datasets")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.match((result.content[0] as { text: string }).text, /No pending datasets/);
  });
});

describe("get_system_stats", () => {
  test("formats role/status counts, storage, top users, and activity feed", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      assert.equal(new URL(url).pathname, "/api/admin/stats");
      return jsonResponse({
        user_count: 3,
        user_roles: { admin: 1, registered: 1, guest: 1 },
        dataset_count: 2,
        dataset_statuses: { pending: 2, approved: 0, rejected: 0 },
        experiment_count: 3,
        experiment_statuses: { pending: 0, running: 0, completed: 2, failed: 1, cancelled: 0 },
        storage_used_bytes: 8000,
        storage_cap_bytes: 5_000_000_000,
        top_storage_users: [{ user_id: 4, username: "mcptest", email: "mcptest@poisondash.local", used_bytes: 8000, quota_bytes: 1_000_000_000 }],
        recent_activity: [{ timestamp: "2026-07-31T00:00:00", type: "user_signup", actor: "mcptest", detail: "role=registered" }],
      });
    });

    const tool = ToolRegistry.get("get_system_stats")!;
    const result = await tool.handler(tool.schema.parse({}));
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Users: 3 \(admin=1, registered=1, guest=1\)/);
    assert.match(text, /Datasets: 2 \(pending=2, approved=0, rejected=0\)/);
    assert.match(text, /Experiments: 3 \(pending=0, running=0, completed=2, failed=1, cancelled=0\)/);
    assert.match(text, /Top storage users:/);
    assert.match(text, /mcptest \(mcptest@poisondash\.local\)/);
    assert.match(text, /Recent activity:/);
    assert.match(text, /user_signup -- mcptest: role=registered/);
  });
});

describe("list_pending_datasets fan-out", () => {
  test("caps concurrent uploader lookups instead of opening one socket per row", async () => {
    // limit=500 rows with distinct uploaders would otherwise fire 500
    // simultaneous requests at a single-process backend.
    let inFlight = 0;
    let peak = 0;
    const datasets = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      name: `ds-${i}`,
      uploaded_by: i + 1,
      file_size_bytes: 1024,
      created_at: null,
    }));

    fetchMock.mock.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/api/admin/datasets") {
        return jsonResponse({ datasets, total: datasets.length });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      const id = Number(pathname.split("/").pop());
      return jsonResponse({ id, username: `user${id}`, email: `u${id}@x`, role: "registered" });
    });

    const tool = ToolRegistry.get("list_pending_datasets")!;
    const result = await tool.handler(tool.schema.parse({}));
    assert.ok(peak <= 8, `peak concurrency was ${peak}, expected <= 8`);
    assert.match((result.content[0] as { text: string }).text, /uploaded by user1/);
  });

  test("counts failed uploader lookups rather than silently showing a raw id", async () => {
    fetchMock.mock.mockImplementation(async (url: string) => {
      const { pathname } = new URL(url);
      if (pathname === "/api/admin/datasets") {
        return jsonResponse({
          datasets: [{ id: 1, name: "orphan.npz", uploaded_by: 99, file_size_bytes: 10, created_at: null }],
          total: 1,
        });
      }
      return new Response(JSON.stringify({ detail: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const tool = ToolRegistry.get("list_pending_datasets")!;
    const text = ((await tool.handler(tool.schema.parse({}))).content[0] as { text: string }).text;
    assert.match(text, /uploaded by user#99/);
    assert.match(text, /1 uploader lookup\(s\) failed/);
  });
});

describe("dataset moderation", () => {
  test("approve_dataset POSTs to the approve endpoint with an optional reason", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/admin/datasets/12/approve");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body as string), { reason: "looks fine" });
      return jsonResponse({
        id: 12,
        name: "suspect.npz",
        type: "dataset",
        uploaded_by: 3,
        approval_status: "approved",
        approval_reason: "looks fine",
      });
    });
    const tool = ToolRegistry.get("approve_dataset")!;
    const text = (
      (await tool.handler(tool.schema.parse({ dataset_id: 12, reason: "looks fine" }))).content[0] as {
        text: string;
      }
    ).text;
    assert.match(text, /Approved:/);
    assert.match(text, /Approval: approved \(looks fine\)/);
  });

  test("reject_dataset POSTs to the reject endpoint and sends null when no reason is given", async () => {
    fetchMock.mock.mockImplementation(async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).pathname, "/api/admin/datasets/12/reject");
      assert.deepEqual(JSON.parse(init.body as string), { reason: null });
      return jsonResponse({
        id: 12,
        name: "suspect.npz",
        type: "dataset",
        uploaded_by: 3,
        approval_status: "rejected",
        approval_reason: null,
      });
    });
    const tool = ToolRegistry.get("reject_dataset")!;
    const text = (
      (await tool.handler(tool.schema.parse({ dataset_id: 12 }))).content[0] as { text: string }
    ).text;
    assert.match(text, /Rejected:/);
    assert.match(text, /Approval: rejected/);
  });

  test("moderation tools sit behind the same admin visibility gate", () => {
    assert.equal(ToolRegistry.get("approve_dataset")!.enabled?.(), false);
    assert.equal(ToolRegistry.get("reject_dataset")!.enabled?.(), false);
  });
});
