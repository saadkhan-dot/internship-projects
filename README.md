# LeadIntel

LeadIntel is a small website URL discovery workspace. Phase 2A runs real Website scans: it checks robots.txt and sitemap locations, crawls same-host HTML links, and stores discovered URLs and request outcomes. Contact extraction, AI, person/company classification, enrichment, and non-Website scan execution are outside this phase.

## Stack and architecture

- Frontend: React, Vite, Tailwind CSS, responsive custom component styles.
- Backend: Node.js, Express, Socket.IO, REST API.
- Database: MongoDB through Mongoose.
- `ScanJobManager` owns the queue, running status, live log/progress writes, cancellation controllers, and queued-job recovery after restart.
- The queue claims jobs with a persisted per-attempt worker token. Database failures during queued-job reads/claims retry with bounded backoff; jobs that cannot be marked failed remain persisted as queued and appear as paused in `/api/health` until MongoDB recovery.
- `BuiltInDiscoveryAdapter` is the current provider. URL normalization, robots rules, sitemap parsing, HTTP fetch/redirect checks, and page crawling live in separate modules under `backend/src/discovery/`.
- `ScanPage` stores per-scan URLs, source, source URL, depth, fetch status, HTTP status, content type, and discovery time. A compound unique index prevents duplicate normalized URLs within a scan.
- Socket.IO emits `scan:update` snapshots at lifecycle boundaries. The frontend fetches data when its page is opened and polls only the active view while a scan is running; poll requests do not overlap.

## Folder structure

```text
backend/
  src/server.js
  src/models/index.js
  src/services/jobManager.js
  src/discovery/{url,robots,sitemaps,fetch,crawler,index}.js
  test/{discovery.test,api.integration.test}.js
  .env.example
frontend/
  src/App.jsx
  src/App.css
  src/index.css
```

## Prerequisites and setup

- Node.js 20.19+ and npm.
- MongoDB running locally or a MongoDB URI.
- `mongod` on PATH is needed for the Mongo-backed integration test.

```sh
cd backend
npm install
cp .env.example .env
# Set MONGODB_URI in backend/.env if not using local MongoDB.

cd ../frontend
npm install
```

When MongoDB is unavailable, `/api/health` reports `dbConnected: false`; data endpoints return HTTP 503. The backend retries initial/recovery setup with increasing delays, updates readiness on MongoDB connection events, and resumes queued jobs after recovery without a backend restart. Active scans are aborted on disconnect and reconciled to a terminal state after reconnect, preserving saved partial URLs. No scan data is represented as saved while the database is disconnected.

## Run

Open two terminals:

```sh
cd backend && npm run dev
cd frontend && npm run dev
```

Backend listens on `127.0.0.1:4000`; Vite uses port 5173. Backend environment variables include `HOST`, `PORT`, `MONGODB_URI`, and `CLIENT_ORIGIN`; the frontend uses `VITE_API_URL`.

The backend binds to `127.0.0.1` by default and CORS/Socket.IO accept only `CLIENT_ORIGIN` (default `http://localhost:5173`). Set `HOST` explicitly only when you intend to change the bind interface. The local MVP has no user authentication or per-job ownership. Do not expose it to a LAN, proxy, or shared deployment; remote/shared deployment requires authentication, authorization, and per-job ownership.

## Website scan behavior

1. Submit a website URL and page/depth limits from New Scan.
2. The worker validates and normalizes HTTP(S), fetches robots.txt, and applies matching basic Allow/Disallow rules plus `Crawl-delay`.
3. If enabled, it checks robots.txt sitemap references, `/sitemap.xml`, and `/sitemap_index.xml`. It recursively processes bounded sitemap indexes and deduplicates page URLs.
4. It fetches same-host pages with configurable concurrency, timeout, and minimum request interval. Outbound requests resolve all destination addresses, reject any non-public address, then pin the connection to a validated address. Redirects are limited to five hops, revalidated, and followed only when the destination hostname stays the same.
5. HTML links are normalized, fragments removed, resources filtered, and URLs outside the source hostname ignored. Query parameters and their order are preserved by default. Settings can instead remove common tracking parameters or remove all query parameters.
6. Each URL is persisted as soon as it is discovered. Attempted/fetched/failed counts represent actual page fetches; sitemap and robots requests are logged separately.
7. Cancel aborts active fetches, stops scheduling additional work, and leaves persisted partial results intact.

Monitor metrics are intentionally distinct: **URLs discovered** counts unique URL records; **URLs processed** counts a discovered URL once it has a final crawl outcome, including a robots.txt block; **HTTP attempts** counts actual page requests; **2xx fetched** counts successful page responses; and **failed page requests** counts failed page fetches. The percent uses processed URL outcomes divided by discovered URLs, not HTTP attempts divided by discovered URLs. Completed jobs report 100%; running, cancelling, and failed jobs are capped below 100%.

There is no browser automation, login, CAPTCHA/Cloudflare bypass, or access-control bypass. robots.txt rules are applied with a practical path-prefix matcher; robots specifications can include more advanced matching syntax.

Outbound network safety permits only HTTP/HTTPS on ports 80 and 443. Loopback, private, link-local, multicast, reserved, unspecified, and mixed public/private DNS results are rejected. This is designed to prevent crawler access to internal services and metadata endpoints; DNS is resolved and the chosen validated address is used for the actual socket connection. Explicit local fixture allowance exists only when `NODE_ENV=test` and `LEADINTEL_ALLOW_LOCAL_FIXTURES=true` are both set by the test harness.

Safety limits: 2 MB decompressed HTML per page, 5 MB decompressed sitemap XML, 20,000 XML entries per sitemap, 100 child sitemap entries per index, 30 sitemap sources per scan, at most the configured page limit queued, and five redirect hops. Hitting a sitemap or URL queue limit is recorded in scan progress/logs and marks discovery as incomplete; URLs beyond the safety cap are not retained. Compressed response bodies are bounded after decompression.

## Settings

Defaults: 100 URLs, depth 3, concurrency 3, 10 second HTTP timeout, 1 second minimum request spacing, sitemap discovery on, internal link crawling on, and query policy `preserve`. Settings are stored in MongoDB. Limits: max 5000 URLs, depth 20, concurrency 1–5, timeout 1–60 seconds, delay 0–60 seconds. Per-scan page/depth limits can be supplied through the scan form.

## Screaming Frog investigation

The installed app is Screaming Frog SEO Spider **25.1.0**. Its bundled `ScreamingFrogSEOSpiderLauncher --help` advertises `--crawl`, `--headless`, `--output-folder`, `--export-format csv|xls|xlsx|gsheet`, `--export-tabs`, `--save-crawl`, and sitemap/list crawl options. The installed CLI also provides the supported export-tab list (`Internal:All` is present).

The CLI is a legitimate possible future adapter, but this phase does not claim to invoke it. The installation’s license behavior, headless execution on this host, per-job output/config isolation, export schema, and reliable process-tree cancellation were not validated by running a real crawl. The `getDiscoveryAdapter()` provider boundary keeps a future Screaming Frog adapter separable; the current and tested adapter is the built-in crawler.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | MongoDB readiness and worker queue health (`queuedJobs`, `pausedJobs`, last database error type) |
| GET | `/api/dashboard` | Backend-derived counts and recent scans |
| POST | `/api/scans` | Create a job; Website jobs enter the discovery queue |
| GET | `/api/scans` | Scan history |
| GET | `/api/scans/:id` | Job status and actual progress |
| GET | `/api/scans/:id/logs` | Job log events |
| GET | `/api/scans/:id/pages` | Search/filter stored URLs (`q`, `source`, `status`, `skip`, `limit`) |
| POST | `/api/scans/:id/cancel` | Cancel queued/running scan and retain partial pages |
| GET | `/api/leads` | Existing Phase 1 leads search/filter |
| GET | `/api/people` | Existing Phase 1 people list/search |
| GET | `/api/companies` | Existing Phase 1 company list/search |
| GET/PUT | `/api/settings` | Read and persist crawler configuration |

## Test and build

```sh
cd backend && npm test
cd ../frontend && npm run lint && npm run build
```

Backend tests use local fixture HTTP servers and a temporary MongoDB for end-to-end scan completion, cancellation, partial results, unreachable hosts, and persistence. They do not contact public websites. The fixture allowlist is enabled only by the test process.

## Known limitations

- Sitemap XML is parsed; HTML parsing uses Cheerio. Content extraction is intentionally not included.
- Only Website jobs run. Sitemap-only, Individual, and Company jobs are recorded as failed with a clear unsupported-phase message instead of staying queued.
- Robots matching supports user-agent groups, Allow/Disallow prefix paths, Sitemap, and Crawl-delay, not every extension in the robots standard.
- Selenium rendering is unavailable. The Settings UI no longer offers a fallback preference, and the settings API resets the legacy value to `false`.
- Scan logs retain the newest 200 entries per job, including terminal events. URL discovery counts advance from successful unique ScanPage upserts; progress updates use targeted MongoDB updates instead of reloading and saving the full job document for every event.
- The crawl worker is an in-process queue. Queued MongoDB jobs restart after backend startup; a running job interrupted by a process crash is marked failed with its partial URLs retained, rather than resumed.
- There is no authentication, rate-control coordination across multiple backend instances, or distributed job locking.
