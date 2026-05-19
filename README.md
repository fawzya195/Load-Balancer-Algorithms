#  Distributed Load Balancer

A high-performance, fully containerised **Load Balancer** built in pure Node.js  no external frameworks. The system routes incoming HTTP requests across a pool of **10 worker nodes** using **5 distinct scheduling algorithms**, all orchestrated with Docker Compose for isolated and reproducible benchmarking.

---

##  Project Overview

| Detail | Value |
|---|---|
| **Author** | Fawzya Said  Section 3 |
| **Runtime** | Pure Node.js (`http` module only) |
| **Workers** | 10 identical containerised nodes |
| **Algorithms** | Round Robin, Random, IP Hashing, Least Connection, Weighted Round Robin |
| **Orchestration** | Docker Compose |
| **Benchmark Tool** | Apache Bench (`ab`) |

**Key design goals:**
-  Zero external framework dependency  raw `http` module throughout
-  CPU-bound workload: ` (i  sin(i) / ln(i+1))` for `i = 1..n10`
-  FIFO in-process queue per worker to serialise concurrent requests safely
-  One load-balancer container per algorithm, all running simultaneously on separate ports
-  Full observability via `/health` endpoints + Apache Bench stress tests

---

##  System Architecture

```
CLIENT (Apache Bench)
          HTTP GET /calc?n=5
        

  LOAD BALANCER  (ports 80908094)                       
  Round-Robin / Random / Hash / LeastConn / WRR          

              lb-net (Docker bridge)

  W1    W2    W3    W4    W5    W6    W7    W8    W9    W10 

         Workers 110  (FIFO queue + calc() + /health)
```

### System Components

| Component | Count | Role |
|---|---|---|
| **Worker Node** | 10 | Handles actual computation; runs a FIFO queue |
| **Load Balancer** | 5 (one/algo) | Routes requests using selected algorithm |
| **Docker Network** | 1 (bridge) | `lb-net`  isolated for internal DNS resolution |
| **Exposed Ports** | 5 | `80908094` (one per algorithm) |

---

##  File Structure

```
project-2/
 docker-compose.yml        # Spins up 10 workers + 5 LB instances
 worker/
    server.js             # Worker: computes H(n) formula with FIFO queue
    Dockerfile
 lb/
     lb.js                 # Load Balancer with all 5 algorithms
     Dockerfile
```

---

##  Request & Response Flow

Every HTTP request follows a **6-step lifecycle:**

| # | Stage | Description |
|---|---|---|
| 1 | **Client sends request** | Apache Bench issues `GET /calc?n=5` to the LB port (80908094) |
| 2 | **LB selects worker** | LB applies its active algorithm to pick a backend worker |
| 3 | **LB proxies request** | LB forwards the request to `worker<N>:3001` via Docker DNS, injecting `X-Request-Seq` |
| 4 | **Worker enqueues job** | Worker pushes the job onto its FIFO queue |
| 5 | **Worker processes job** | `drainQueue()` runs `calc(n)`, records timings, returns JSON |
| 6 | **Response returns** | Response travels back through LB (reads `X-Queue-Length`) to the client |

### Worker Internals

| Property | Detail |
|---|---|
| **Endpoint** | `GET /cal?n=<number>` |
| **Queue Type** | FIFO  requests processed strictly in arrival order |
| **Workload** | ` (i  sin(i) / ln(i+1))` for `i=1..n10` |
| **Response** | JSON: `worker_id`, `result`, `queue_wait_ms`, `calc_ms`, `total_ms` |
| **Health** | `GET /health`  `queue_length`, `active` flag, `total_received` |

---

##  Load Balancing Algorithms

Algorithms are configured via the `ALGO` environment variable (15) on each LB container.

### 1  Round Robin `(port 8090)`
Distributes requests sequentially. A global `rrIndex` counter cycles through all workers with modulo  guarantees equal distribution over time.

| Complexity | O(1) |
|---|---|
| **State** | Single integer pointer (`rrIndex`) |
| **Best for** | Homogeneous workers with similar request durations |
| **Weakness** | Ignores real-time load; long-running jobs cause imbalance |

### 2  Random `(port 8091)`
Picks a worker using `Math.random()`. Stateless and simple  distribution converges to uniform over large volumes.

| Complexity | O(1) |
|---|---|
| **State** | Stateless |
| **Best for** | Simple deployments where strict ordering is not required |
| **Weakness** | Statistical variance; same worker can be hit consecutively |

### 3  IP / Key Hashing `(port 8092)`
Computes an MD5 hash of the request URL, maps modulo 10 to a worker index. Identical URLs always route to the same worker  enables server-side caching.

| Complexity | O(1) MD5 hash per request |
|---|---|
| **State** | Stateless (deterministic) |
| **Best for** | Session affinity, cache locality |
| **Weakness** | Hash skew concentrates load on one worker for repetitive URLs |

### 4  Least Connection `(port 8093)`
Tracks active in-flight connections per worker and always routes to the least-loaded one. Seeds its counter from the `X-Queue-Length` response header for real-time accuracy.

| Complexity | O(n) scan of 10 workers |
|---|---|
| **State** | `activeConnections` counter per worker |
| **Best for** | Mixed workloads with varying processing times |
| **Weakness** | Slightly higher LB overhead; counter can lag under very high concurrency |

### 5  Weighted Round Robin `(port 8094)`
Assigns static weights: workers 13  weight 3, workers 46  weight 2, workers 710  weight 1. Higher-weight workers receive proportionally more requests per cycle.

| Complexity | O(n) worst case per cycle |
|---|---|
| **State** | `wrrIndex` + `wrrCurrentWeight` |
| **Best for** | Heterogeneous clusters with known capacity differences |
| **Weakness** | Static weights don't adapt to real-time load |

---

##  Benchmark Results

All five LB instances were stress-tested with **Apache Bench**: `10,000 requests` at `200 concurrent connections` against `GET /calc?n=5`.

| Algorithm | Port | Req/s | Mean (ms) | Max (ms) | Duration (s) |
|---|---|---|---|---|---|
| **Round Robin** | 8090 | 230.10 | 869 | 1905 | 43.459 |
| **Random** | 8091 | 289.23 | 691 | 1737 | 34.574 |
| **Hashing** | 8092 | 329.26 | 607 | 1280 | 30.371 |
| **Least Connection** | 8093 | **414.71** | **482** | **921** | **24.114** |
| **Weighted RR** | 8094 | 383.60 | 521 | 1151 | 26.069 |

>  **Least Connection wins** across all metrics: highest throughput, lowest mean latency, best tail latency.

---

##  Best Algorithm: Least Connection

**Least Connection** is the top performer in this benchmark:
-  Highest throughput: **414.71 req/s**
-  Lowest mean latency: **482 ms**
-  Best worst-case latency: **921 ms** (vs 1905 ms for Round Robin  a **2 improvement**)

**Why it wins:**
- **Real queue awareness**  reads `X-Queue-Length` header after every response, reflecting live load
- **CPU-bound FIFO queues**  queue length is the most accurate proxy for current worker load
- **Prevents pile-ups**  always routes to the shortest queue under high concurrency
- **Better tail latency**  avoids overloading already-busy workers

**Why Round Robin performs worst:**  
Round Robin cycles blindly without knowing which workers are backlogged. Under 200 concurrent CPU-bound requests, some workers accumulate deep queues while others sit idle  causing 869 ms mean latency and 1905 ms max.

### When to Choose Each Algorithm

| Algorithm | Recommended When |
|---|---|
| **Round Robin** | Identical workers; uniform workload; simplicity is valued |
| **Random** | Simple deployments; no strict ordering required |
| **Hashing** | Session affinity required; server-side caching is important |
| **Least Connection** | Mixed or unpredictable job durations; dynamic workloads |
| **Weighted RR** | Heterogeneous clusters with known capacity differences |

---

##  Docker Compose Setup

The `docker-compose.yml` orchestrates **15 containers**: 10 workers + 5 LB instances on the shared `lb-net` bridge network.

| Container | ALGO | Port | Algorithm |
|---|---|---|---|
| `lb-round-robin` | 1 | 8090 | Round Robin |
| `lb-random` | 2 | 8091 | Random |
| `lb-hashing` | 3 | 8092 | IP/Key Hashing |
| `lb-least-conn` | 4 | 8093 | Least Connection |
| `lb-weighted-rr` | 5 | 8094 | Weighted RR |
| `worker1worker10` |  | 3001 (internal) | Not exposed to host |

### Running the Project

```bash
# Start all containers
docker compose up --build

# Run benchmark against a specific algorithm (e.g. Least Connection)
ab -n 10000 -c 200 http://localhost:8093/calc?n=5

# Check worker health
curl http://localhost:8093/health
```

---

##  Tech Stack

- **Runtime:** Node.js (pure `http` module)
- **Containerisation:** Docker & Docker Compose
- **Benchmarking:** Apache Bench (`ab`)
- **Networking:** Docker bridge network (`lb-net`) with internal DNS
