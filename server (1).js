require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const webpush = require("web-push");

const CONFIG = {
  apiUrl: process.env.API_URL || "https://sensorinsar.ddns.net/api/lecturas",
  threshold: parseFloat(process.env.THRESHOLD || "1"),
  pollSeconds: Math.max(10, parseInt(process.env.POLL_SECONDS || "20", 10)),
  port: process.env.PORT || 3000,
};

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error("Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Genera unas con: npx web-push generate-vapid-keys");
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* ---------- persistencia simple en disco (JSON) ---------- */
const DATA_DIR = path.join(__dirname, "data");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const BASELINE_FILE = path.join(DATA_DIR, "baseline.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("No se pudo guardar", file, e.message);
  }
}

// subscriptions: { [endpoint]: { subscription, apiUrl, threshold } }
let subscriptions = loadJSON(SUBS_FILE, {});
// baseline: { [sensorId]: { pitch, roll, id, ts } }
let baseline = loadJSON(BASELINE_FILE, {});

/* ---------- servidor HTTP ---------- */
const app = express();
app.use(express.json());

// CORS abierto: el frontend puede vivir en cualquier dominio (GitHub Pages, etc.)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true, subscriptions: Object.keys(subscriptions).length, uptimeSec: process.uptime() });
});

app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post("/subscribe", (req, res) => {
  const { subscription, apiUrl, threshold, vibrate } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "falta 'subscription' con endpoint" });
  }
  subscriptions[subscription.endpoint] = {
    subscription,
    apiUrl: apiUrl || CONFIG.apiUrl,
    threshold: typeof threshold === "number" ? threshold : CONFIG.threshold,
    vibrate: Array.isArray(vibrate) && vibrate.length ? vibrate : [300, 120, 300, 120, 300, 120, 600],
  };
  saveJSON(SUBS_FILE, subscriptions);
  res.json({ ok: true });
});

app.post("/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint && subscriptions[endpoint]) {
    delete subscriptions[endpoint];
    saveJSON(SUBS_FILE, subscriptions);
  }
  res.json({ ok: true });
});

// Disparo manual / vía cron externo (cron-job.org) para mantener el servicio despierto
app.get("/tick", async (req, res) => {
  try {
    const result = await runCheck();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(CONFIG.port, () => {
  console.log(`InsarWatch backend escuchando en :${CONFIG.port}`);
  runCheck().catch((e) => console.error("primer chequeo falló:", e.message));
  setInterval(() => runCheck().catch((e) => console.error("chequeo falló:", e.message)), CONFIG.pollSeconds * 1000);
});

/* ---------- lógica de detección de picos (misma idea que el frontend) ---------- */
async function fetchReadings(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("respuesta inesperada del API");
  return data;
}

async function runCheck() {
  // Un mismo API puede ser compartido por varias suscripciones con distinto umbral;
  // para simplificar, agrupamos por apiUrl (normalmente todas usan el mismo).
  const apiUrls = new Set([CONFIG.apiUrl, ...Object.values(subscriptions).map((s) => s.apiUrl)]);
  let totalAlerts = [];

  for (const apiUrl of apiUrls) {
    let readings;
    try {
      readings = await fetchReadings(apiUrl);
    } catch (err) {
      console.error("Error consultando", apiUrl, err.message);
      continue;
    }

    const bySensor = {};
    for (const r of readings) {
      const sid = r.sensor_id || "desconocido";
      (bySensor[sid] = bySensor[sid] || []).push(r);
    }

    for (const sid of Object.keys(bySensor)) {
      const arr = bySensor[sid].slice().sort((a, b) => {
        if (typeof a.id === "number" && typeof b.id === "number") return a.id - b.id;
        return new Date(a.timestamp) - new Date(b.timestamp);
      });

      const key = apiUrl + "::" + sid;
      let last = baseline[key] || null;
      const lastSeenId = last ? last.id : null;

      for (const r of arr) {
        if (lastSeenId != null && typeof r.id === "number" && r.id <= lastSeenId) continue;

        if (last) {
          for (const metric of ["pitch", "roll"]) {
            const prev = last[metric];
            const next = r[metric];
            if (typeof prev === "number" && typeof next === "number") {
              const delta = next - prev;
              // Se evalúa por cada suscripción con su propio umbral
              for (const [endpoint, subInfo] of Object.entries(subscriptions)) {
                if (subInfo.apiUrl !== apiUrl) continue;
                const threshold = subInfo.threshold || CONFIG.threshold;
                if (Math.abs(delta) >= threshold) {
                  totalAlerts.push({ endpoint, sid, metric, prev, next, delta, threshold, ts: r.timestamp });
                }
              }
            }
          }
        }
        last = { pitch: r.pitch, roll: r.roll, id: r.id, ts: r.timestamp };
      }

      if (last) baseline[key] = last;
    }
  }

  saveJSON(BASELINE_FILE, baseline);

  if (totalAlerts.length) {
    await deliverAlerts(totalAlerts);
  }

  return { checkedApis: apiUrls.size, alertsSent: totalAlerts.length, subscriptions: Object.keys(subscriptions).length };
}

async function deliverAlerts(alerts) {
  // Agrupar alertas por endpoint (suscripción) para mandar una sola notificación si hay varias
  const byEndpoint = {};
  for (const a of alerts) (byEndpoint[a.endpoint] = byEndpoint[a.endpoint] || []).push(a);

  for (const [endpoint, list] of Object.entries(byEndpoint)) {
    const subInfo = subscriptions[endpoint];
    if (!subInfo) continue;

    let title, body;
    if (list.length === 1) {
      const a = list[0];
      title = `⚠️ Pico detectado — Sensor ${a.sid.toUpperCase()}`;
      body = `${a.metric === "roll" ? "Roll" : "Pitch"} cambió ${a.delta > 0 ? "+" : ""}${a.delta.toFixed(2)}° (umbral ${a.threshold.toFixed(2)}°)`;
    } else {
      const sensors = new Set(list.map((a) => a.sid));
      title = `⚠️ ${list.length} picos detectados`;
      body = `En ${sensors.size} sensor(es): ${[...sensors].map((s) => s.toUpperCase()).join(", ")}`;
    }

    try {
      await webpush.sendNotification(
        subInfo.subscription,
        JSON.stringify({ title, body, vibrate: subInfo.vibrate })
      );
    } catch (err) {
      console.error("push falló para", endpoint, err.statusCode, err.message);
      // Suscripción vencida o inválida: limpiarla
      if (err.statusCode === 404 || err.statusCode === 410) {
        delete subscriptions[endpoint];
        saveJSON(SUBS_FILE, subscriptions);
      }
    }
  }
}
