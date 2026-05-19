const http = require("http");
const crypto = require("crypto");

const PORT = process.env.LB_PORT || 8090;
const ALGO = parseInt(process.env.ALGO || "1"); // 1-5

// 10 backend workers
const WORKERS = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  host: `worker${i + 1}`,
  port: 3001,
  activeConnections: 0,
  weight: i < 3 ? 3 : i < 6 ? 2 : 1, // weights for weighted round robin
}));

let rrIndex = 0; // round robin pointer
let wrrIndex = 0; // weighted round robin pointer
let wrrCurrentWeight = 0;

// ── Algorithm implementations ──────────────────────────────────────────────

// 1. Round Robin
function roundRobin() {
  const worker = WORKERS[rrIndex % WORKERS.length];
  rrIndex++;
  return worker;
}

// 2. Random
function random() {
  return WORKERS[Math.floor(Math.random() * WORKERS.length)];
}

// 3. IP/Key Hashing  (hashes the request URL path+query)
function hashing(key) {
  const hash = crypto.createHash("md5").update(key).digest("hex");
  const index = parseInt(hash.substring(0, 8), 16) % WORKERS.length;
  return WORKERS[index];
}

// 4. Least Connections
function leastConnection() {
  return WORKERS.reduce((min, w) =>
    w.activeConnections < min.activeConnections ? w : min,
  );
}

// 5. Weighted Round Robin
function weightedRoundRobin() {
  for (let i = 0; i < WORKERS.length; i++) {
    if (WORKERS[wrrIndex % WORKERS.length].weight > wrrCurrentWeight) {
      wrrCurrentWeight++;
      return WORKERS[wrrIndex % WORKERS.length];
    }
    wrrIndex++;
    wrrCurrentWeight = 0;
  }
  wrrIndex = 0;
  wrrCurrentWeight = 1;
  return WORKERS[0];
}

const ALGO_NAMES = {
  1: "Round Robin",
  2: "Random",
  3: "Hashing",
  4: "Least Connection",
  5: "Weighted Round Robin",
};


//22
function selectWorker(reqUrl) {
  switch (ALGO) {
    case 1:
      return roundRobin();
    case 2:
      return random();
    case 3:
      return hashing(reqUrl);
    case 4:
      return leastConnection();
    case 5:
      return weightedRoundRobin();
    default:
      return roundRobin();
  }
}

// ── Proxy request ───────────────────────────────────────────────────────────
//33
function proxyRequest(worker, req, res) {
  worker.activeConnections++;

  const options = {
    hostname: worker.host,
    port: worker.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let body = "";
    proxyRes.on("data", (chunk) => (body += chunk));
    proxyRes.on("end", () => {
      const realQueue = parseInt(proxyRes.headers["x-queue-length"] ?? "0");
      worker.activeConnections = realQueue;
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": "application/json",
        "X-Worker-Id": worker.id,
        "X-Algorithm": ALGO_NAMES[ALGO],
      });
      res.end(body);
    });
  });

  proxyReq.on("error", (err) => {
    worker.activeConnections--;
    res.writeHead(502);
    res.end(
      JSON.stringify({
        error: "Backend error",
        worker: worker.id,
        msg: err.message,
      }),
    );
  });

  proxyReq.end();
}

// ── HTTP Server ─────────────────────────────────────────────────────────────
//11
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        algorithm: ALGO_NAMES[ALGO],
        algo_id: ALGO,
        workers: WORKERS.map((w) => ({
          id: w.id,
          connections: w.activeConnections,
        })),
      }),
    );
    return;
  }

  const worker = selectWorker(req.url);
  proxyRequest(worker, req, res);
});

server.listen(PORT, () => {
  console.log(
    `Load Balancer started on port ${PORT} | Algorithm: ${ALGO_NAMES[ALGO]} (${ALGO})`,
  );
});
