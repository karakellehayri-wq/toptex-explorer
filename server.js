import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== CONFIG (zet deze in Render -> Environment Variables) ======
const TOPTEX_BASE = process.env.TOPTEX_BASE_URL || "https://api.toptex.io";
const API_KEY = process.env.TOPTEX_API_KEY;          // <-- TopTex API Key (server-side!)
const AUTH_BODY_RAW = process.env.TOPTEX_AUTH_BODY;  // <-- JSON string voor /v3/authenticate
// =================================================================

let cachedToken = null;
let tokenExpiresAt = 0;

function mustEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}

async function getToken() {
  mustEnv("TOPTEX_API_KEY");
  mustEnv("TOPTEX_AUTH_BODY");

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  let authBody;
  try {
    authBody = JSON.parse(AUTH_BODY_RAW);
  } catch {
    throw new Error("TOPTEX_AUTH_BODY must be valid JSON string");
  }

  const res = await fetch(`${TOPTEX_BASE}/v3/authenticate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "Accept": "application/json",
    },
    body: JSON.stringify(authBody),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${text}`);

  const data = JSON.parse(text);
  const token = data.access_token || data.token || data.id_token;
  const expiresIn = Number(data.expires_in || 3600);

  if (!token) throw new Error(`Auth response missing token. Keys: ${Object.keys(data).join(", ")}`);

  cachedToken = token;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  return cachedToken;
}

function buildUrl(path, query) {
  const qs =
    query && typeof query === "object"
      ? "?" + new URLSearchParams(
          Object.entries(query).filter(([, v]) => v !== "" && v != null)
        ).toString()
      : "";
  return `${TOPTEX_BASE}${path}${qs}`;
}

// ---- JSON proxy for ANY /v3/... endpoint (except /pdf) ----
app.post("/api/proxy", async (req, res) => {
  try {
    const { method, path, query, body } = req.body || {};
    const m = String(method || "GET").toUpperCase();

    if (!path || !String(path).startsWith("/v3/")) {
      return res.status(400).json({ error: "path moet starten met /v3/ (bv. /v3/invoices)" });
    }
    if (String(path).endsWith("/pdf")) {
      return res.status(400).json({ error: "Gebruik /api/pdf voor PDF endpoints" });
    }

    const token = await getToken();
    const url = buildUrl(path, query);

    const headers = {
      "Accept": "application/json",
      "x-api-key": "3WnBaihpTSqDe7FCgDAbaHLYsS3GqgRar7swJ2th"
    };


    let fetchBody;
    if (!["GET", "HEAD"].includes(m) && body != null) {
      headers["Content-Type"] = "application/json";
      fetchBody = typeof body === "string" ? body : JSON.stringify(body);
    }

    const r = await fetch(url, { method: m, headers, body: fetchBody });
    console.log("TOPTEX URL:", url);
    console.log("TOPTEX STATUS:", r.status, r.statusText);
    console.log("TOPTEX RESP:", raw);

    const ct = r.headers.get("content-type") || "";
    const raw = await r.text();

    const out = {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      contentType: ct,
      body: raw,
    };

    if (ct.includes("application/json")) {
      try { out.json = JSON.parse(raw); } catch {}
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- PDF proxy: streams /v3/.../pdf safely ----
app.get("/api/pdf", async (req, res) => {
  try {
    const path = String(req.query.path || "");
    if (!path.startsWith("/v3/") || !path.endsWith("/pdf")) {
      return res.status(400).send("Gebruik: /api/pdf?path=/v3/invoices/{id}/pdf");
    }

    const token = await getToken();
    const url = buildUrl(path, null);

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/pdf",
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).send(txt);
    }

    res.setHeader("Content-Type", r.headers.get("content-type") || "application/pdf");
    const cd = r.headers.get("content-disposition");
    if (cd) res.setHeader("Content-Disposition", cd);

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ---- Single-page UI (inline HTML) ----
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TopTex API Explorer</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f6f7f9;margin:0;padding:22px}
    h1{margin:0 0 8px}
    .muted{color:#666}
    .card{background:#fff;border-radius:14px;padding:14px;box-shadow:0 6px 20px rgba(0,0,0,.06);max-width:1200px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    select,input,textarea,button{border-radius:10px;border:1px solid #ddd;padding:10px;font-size:14px}
    input{min-width:240px;flex:1}
    textarea{width:100%;min-height:140px;font-family:ui-monospace,Menlo,Consolas,monospace}
    button{background:#1f3c88;color:#fff;border:0;cursor:pointer;padding:10px 14px}
    button.secondary{background:#e9ecf5;color:#1f3c88}
    pre{white-space:pre-wrap;word-break:break-word;background:#0b1020;color:#d6e0ff;padding:12px;border-radius:12px;overflow:auto;margin-top:10px}
    .err{color:#b00020;font-weight:700}
  </style>
</head>
<body>
  <h1>TopTex API Explorer</h1>
  <div class="muted">Kies endpoint → Run. PDF endpoints → Open PDF.</div>

  <div class="card" style="margin-top:12px;">
    <div class="row">
      <select id="method">
        <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
      </select>

      <select id="preset">
        <optgroup label="Catalog">
          <option value="/v3/attributes">GET /v3/attributes</option>
          <option value="/v3/products">GET /v3/products</option>
          <option value="/v3/products/all">GET /v3/products/all</option>
          <option value="/v3/products/deleted">GET /v3/products/deleted</option>
        </optgroup>

        <optgroup label="Delivery">
          <option value="/v3/deliveries">GET /v3/deliveries</option>
          <option value="/v3/deliveries/{id}">GET /v3/deliveries/{id}</option>
          <option value="/v3/deliveries/{id}/pdf">GET /v3/deliveries/{id}/pdf</option>
        </optgroup>

        <optgroup label="Invoice">
          <option value="/v3/invoices">GET /v3/invoices</option>
          <option value="/v3/invoices/{id}">GET /v3/invoices/{id}</option>
          <option value="/v3/invoices/{id}/pdf">GET /v3/invoices/{id}/pdf</option>
        </optgroup>

        <optgroup label="Order">
          <option value="/v3/orders">GET /v3/orders</option>
          <option value="/v3/orders/{id}">GET /v3/orders/{id}</option>
          <option value="/v3/orders (POST)">POST /v3/orders</option>
          <option value="/v3/orders/{id}/pdfpacking (PUT)">PUT /v3/orders/{id}/pdfpacking</option>
        </optgroup>

        <optgroup label="Inventory">
          <option value="/v3/products/inventory">GET /v3/products/inventory</option>
          <option value="/v3/products/{sku}/inventory">GET /v3/products/{sku}/inventory</option>
        </optgroup>

        <optgroup label="Price">
          <option value="/v3/products/price">GET /v3/products/price</option>
          <option value="/v3/products/{sku}/price">GET /v3/products/{sku}/price</option>
        </optgroup>
      </select>

      <input id="path" placeholder="Path (bv. /v3/invoices/123)" />
      <button id="run">Run</button>
      <button id="openPdf" class="secondary" style="display:none;">Open PDF</button>

      <span id="status" class="muted"></span>
    </div>

    <div class="row" style="margin-top:10px;">
      <input id="id" placeholder="{id} (bv. 123)" />
      <input id="sku" placeholder="{sku} (bv. SKU123)" />
      <input id="q1k" placeholder="Query key 1" />
      <input id="q1v" placeholder="Query val 1" />
      <input id="q2k" placeholder="Query key 2" />
      <input id="q2v" placeholder="Query val 2" />
    </div>

    <div style="margin-top:10px;">
      <textarea id="body" placeholder='Body JSON (voor POST/PUT/PATCH)'></textarea>
    </div>

    <pre id="out">Klaar.</pre>
  </div>

<script>
const methodEl = document.getElementById("method");
const presetEl = document.getElementById("preset");
const pathEl = document.getElementById("path");
const outEl = document.getElementById("out");
const statusEl = document.getElementById("status");
const openPdfBtn = document.getElementById("openPdf");
const bodyEl = document.getElementById("body");

const idEl = document.getElementById("id");
const skuEl = document.getElementById("sku");
const q1k = document.getElementById("q1k");
const q1v = document.getElementById("q1v");
const q2k = document.getElementById("q2k");
const q2v = document.getElementById("q2v");

function isPdfPath(p){ return String(p).endsWith("/pdf"); }

function applyPreset() {
  const v = presetEl.value;

  if (v.includes("(POST)")) {
    methodEl.value = "POST";
    pathEl.value = "/v3/orders";
  } else if (v.includes("(PUT)")) {
    methodEl.value = "PUT";
    pathEl.value = "/v3/orders/{id}/pdfpacking";
  } else {
    methodEl.value = "GET";
    pathEl.value = v;
  }

  openPdfBtn.style.display = isPdfPath(pathEl.value) ? "inline-block" : "none";
}
presetEl.addEventListener("change", applyPreset);
applyPreset();

function resolvePath() {
  let p = pathEl.value.trim();
  if (p.includes("{id}")) p = p.replaceAll("{id}", (idEl.value.trim() || "123"));
  if (p.includes("{sku}")) p = p.replaceAll("{sku}", (skuEl.value.trim() || "SKU123"));
  return p;
}

function buildQuery(){
  const q = {};
  if (q1k.value.trim()) q[q1k.value.trim()] = q1v.value.trim();
  if (q2k.value.trim()) q[q2k.value.trim()] = q2v.value.trim();
  return q;
}

document.getElementById("run").addEventListener("click", async () => {
  const path = resolvePath();
  openPdfBtn.style.display = isPdfPath(path) ? "inline-block" : "none";

  if (isPdfPath(path)) {
    outEl.textContent = "PDF endpoint. Klik 'Open PDF'.";
    return;
  }

  statusEl.className = "muted";
  statusEl.textContent = "Bezig...";
  outEl.textContent = "";

  const method = methodEl.value.trim().toUpperCase();
  const query = buildQuery();

  let body = null;
  if (!["GET","HEAD"].includes(method)) {
    const raw = bodyEl.value.trim();
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
  }

  try {
    const r = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, path, query, body })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Proxy error");

    statusEl.textContent = data.ok ? "OK" : "Niet OK";
    statusEl.className = data.ok ? "muted" : "err";
    outEl.textContent = data.json ? JSON.stringify(data.json, null, 2) : (data.body || "");
  } catch (e) {
    statusEl.textContent = "Fout";
    statusEl.className = "err";
    outEl.textContent = e.message;
  }
});

openPdfBtn.addEventListener("click", () => {
  const path = resolvePath();
  window.open("/api/pdf?path=" + encodeURIComponent(path), "_blank");
});

[pathEl, idEl, skuEl].forEach(el => el.addEventListener("input", () => {
  const p = resolvePath();
  openPdfBtn.style.display = isPdfPath(p) ? "inline-block" : "none";
}));
</script>
</body>
</html>`);
});

app.get("/health", (req, res) => res.send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on :" + port));
