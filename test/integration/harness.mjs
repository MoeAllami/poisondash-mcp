/**
 * Shared plumbing for the live smoke script.
 *
 * Two halves: an MCP stdio client used to drive the server the way a real
 * client would, and a thin REST client used only to provision and tear down
 * the rows the run needs. Provisioning goes through the API rather than a
 * seed script so the smoke test is reproducible from a fresh checkout against
 * any dev instance, and so it can delete exactly what it created.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.join(HERE, "..", "..");

// Defaults target the bundled mock backend's demo admin (`npm run mock`).
export const API_URL = process.env.SMOKE_API_URL || "http://127.0.0.1:8321";
export const EMAIL = process.env.SMOKE_EMAIL || "admin@demo.local";
export const PASSWORD = process.env.SMOKE_PASSWORD || "demo-admin";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let failures = 0;

export function check(label, condition, extra = "") {
  if (condition) {
    console.log(`  ok   - ${label}`);
  } else {
    console.log(`  FAIL - ${label}${extra ? ` :: ${extra}` : ""}`);
    failures += 1;
  }
  return Boolean(condition);
}

export function section(title) {
  console.log(`\n== ${title} ==`);
}

export function failureCount() {
  return failures;
}

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

export function startServer({ useDist = false, env = {} } = {}) {
  const args = useDist
    ? [path.join(PACKAGE_ROOT, "dist", "index.js")]
    : [path.join(PACKAGE_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(PACKAGE_ROOT, "src", "index.ts")];

  const child = spawn(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, POISONDASH_API_URL: API_URL, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  const stderr = [];
  let nextId = 1;
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr.push(text);
    if (process.env.SMOKE_VERBOSE) process.stderr.write(`[server] ${text}`);
  });

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 60_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    child,
    send,
    stderrText: () => stderr.join(""),
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    async initialize() {
      const response = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "poisondash-smoke", version: "1.0.0" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      return response;
    },
    async listTools() {
      const response = await send("tools/list", {});
      return response.result?.tools ?? [];
    },
    async call(name, args = {}) {
      const response = await send("tools/call", { name, arguments: args });
      const result = response.result ?? { content: [{ type: "text", text: JSON.stringify(response.error) }], isError: true };
      return { ...result, text: result.content?.[0]?.text ?? "" };
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// REST helpers (provisioning and teardown only)
// ---------------------------------------------------------------------------

export async function login() {
  const body = new URLSearchParams({ username: EMAIL, password: PASSWORD });
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Could not log in as ${EMAIL} (${response.status}). Set SMOKE_EMAIL/SMOKE_PASSWORD, ` +
        "or start the mock backend with `npm run mock`."
    );
  }
  return (await response.json()).access_token;
}

export function restClient(token) {
  async function request(method, endpoint, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form;
    }
    const response = await fetch(`${API_URL}${endpoint}`, { method, headers, body });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const error = new Error(`${method} ${endpoint} -> ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  }

  return {
    get: (endpoint) => request("GET", endpoint),
    post: (endpoint, json) => request("POST", endpoint, { json }),
    put: (endpoint, json) => request("PUT", endpoint, { json }),
    del: (endpoint) => request("DELETE", endpoint),
    async uploadDataset(filename, bytes) {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/octet-stream" }), filename);
      form.append("description", "temporary fixture created by the MCP smoke test");
      return request("POST", "/api/datasets/upload", { form });
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal .npz writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Serialize a typed array as a v1.0 .npy member. */
function npy(array, descr, shape) {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  // The spec requires the header (magic through terminating newline) to be a
  // multiple of 64 bytes so the data section stays aligned.
  const preludeLength = 10;
  const padding = 64 - ((preludeLength + header.length + 1) % 64);
  header += " ".repeat(padding === 64 ? 0 : padding) + "\n";

  const out = Buffer.alloc(preludeLength + header.length + array.byteLength);
  out.write("\x93NUMPY", 0, "latin1");
  out.writeUInt8(1, 6);
  out.writeUInt8(0, 7);
  out.writeUInt16LE(header.length, 8);
  out.write(header, preludeLength, "latin1");
  Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(out, preludeLength + header.length);
  return out;
}

/** Build a stored (uncompressed) ZIP -- which is what an .npz is. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "latin1");
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);
    central.push(entry);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * A real, loadable .npz holding `count` 8x8 RGB uint8 images and int64 labels.
 * Small enough to upload instantly, well-formed enough that numpy and PIL can
 * decode it -- which is what get_sample_image exercises server-side.
 */
export function makeNpz(count = 6) {
  const pixels = new Uint8Array(count * 8 * 8 * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) % 256;
  const labels = new BigInt64Array(count);
  for (let i = 0; i < count; i += 1) labels[i] = BigInt(i % 10);

  return zip([
    ["x.npy", npy(pixels, "|u1", [count, 8, 8, 3])],
    ["y.npy", npy(labels, "<i8", [count])],
  ]);
}
