const http = require("http");

const WORKER_ID = process.env.WORKER_ID || "1";
const PORT = process.env.PORT || 3001;

// FIFO queue
const queue = [];
let active = false;
let reqCounter = 0;

// الحساب التقيل (CPU)
function calc(n) {
  const limit = n * 1e5;
  let sum = 0;

  for (let i = 1; i <= limit; i++) {
    sum += (Math.sqrt(i) * Math.sin(i)) / Math.log(i + 1);
  }

  return sum;
}

// enqueue request
function enqueue(n, seqNum, res) {
  reqCounter++;

  queue.push({
    n,
    seqNum,
    reqId: reqCounter,
    res,
    enqueuedAt: Date.now(),
  });

  drainQueue();
}

// process queue (one by one)
function drainQueue() {
  if (active || queue.length === 0) return;

  active = true;

  const job = queue.shift();
  const { n, seqNum, reqId, res, enqueuedAt } = job;

  const waitMs = Date.now() - enqueuedAt;
  const start = Date.now();

  const result = calc(n);

  const calcMs = Date.now() - start;
  const totalMs = Date.now() - enqueuedAt;

  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-Queue-Length": queue.length,
  });

  res.end(
    JSON.stringify({
      worker: WORKER_ID,
      request_seq: seqNum,
      local_req_id: reqId,
      n,
      result,
      queue_wait_ms: waitMs,
      calc_ms: calcMs,
      total_ms: totalMs,
    }),
  );

  active = false;

  drainQueue();
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/cal") {
    const n = parseFloat(url.searchParams.get("n")) || 5;
    const seqNum = parseInt(req.headers["x-request-seq"]) || 0;

    enqueue(n, seqNum, res);
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });

    res.end(
      JSON.stringify({
        status: "ok",
        worker: WORKER_ID,
        queue_length: queue.length,
        active,
        total_received: reqCounter,
      }),
    );
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Worker ${WORKER_ID} running on ${PORT}`);
});
