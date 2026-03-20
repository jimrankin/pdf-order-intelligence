# PDF Order Intelligence

**Antigravity project** — Intelligent PDF sales order extraction pipeline for Business Central.

Replaces the Power Automate AI Builder custom model approach with a Claude-powered extraction engine that reasons about document layout rather than pattern-matching a trained model. The result is layout-change resilience, per-line confidence scoring, and a human review loop that eliminates silent errors.

---

## Architecture

```
SharePoint folder (per customer)
        │
        ▼  (poll via MS Graph)
  [Watcher] sharepointWatcher.js
        │
        ▼
  [Extractor] extract.js
     Claude reads PDF as image(s)
     Returns JSON + per-field confidence scores
        │
        ▼
  [Validator] validate.js
     Schema check + confidence threshold routing
        │
   ┌────┴──────┬──────────────┐
  AUTO       REVIEW         REJECT
   │            │              │
   ▼            ▼              ▼
 BC order   Review email   Fail email
 created    with flagged   to team
 + confirm  lines +
   email    Approve/Reject
            webhook links
                │
                ▼ (on Approve)
             BC order created
             + confirm email
```

**Disposition rules:**
| Disposition | Trigger | Outcome |
|-------------|---------|---------|
| `AUTO` | All fields ≥ confidence threshold | BC order created immediately |
| `REVIEW` | Any field below threshold | Email sent to team with flagged lines; reviewer approves or rejects |
| `REJECT` | Critical field missing / parse failure | Fail email; manual processing required |

---

## Project structure

```
pdf-order-intelligence/
├── prompts/
│   ├── extraction.md          # Master extraction prompt (injected into Claude calls)
│   └── customerHints.js       # Per-customer layout guidance
├── src/
│   ├── extractor/
│   │   └── extract.js         # PDF → Claude → JSON
│   ├── validator/
│   │   └── validate.js        # Confidence scoring + disposition
│   ├── bc/
│   │   └── createOrder.js     # BC API v2.0 order creation
│   ├── email/
│   │   └── notify.js          # Success / review / reject emails
│   ├── router/
│   │   └── pipeline.js        # Orchestrates the full flow
│   ├── watcher/
│   │   └── sharepointWatcher.js  # SharePoint poll trigger
│   ├── server/
│   │   └── webhookServer.js   # Express webhook for review responses
│   └── utils/
│       ├── logger.js
│       └── jobStore.js
├── docs/
│   └── adding-a-customer.md
├── tests/
├── .env.example
├── .gitignore
└── package.json
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/GO365Ltd/pdf-order-intelligence.git
cd pdf-order-intelligence
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Key settings:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `EXTRACTION_MODEL` | Default: `claude-opus-4-20250514` |
| `CONFIDENCE_THRESHOLD` | 0.85 recommended; lower = more auto, higher = more reviews |
| `WATCH_FOLDERS` | Comma-separated SharePoint folder paths |
| `BC_*` | Business Central API credentials |
| `SMTP_*` | Email transport |
| `APP_BASE_URL` | Public URL of this service (for review webhook links) |

### 3. Azure app registration

The service needs two app registrations (or one with both sets of permissions):

**MS Graph (SharePoint watcher):**
- `Sites.Read.All` (application permission)

**Business Central:**
- BC API permissions as configured in your BC admin centre
- Assign the service principal to a BC user with Sales Order creation rights

### 4. Run

```bash
# Development
npm run dev

# Production
npm start
```

---

## Adding a new customer

See [`docs/adding-a-customer.md`](docs/adding-a-customer.md).

In brief:
1. Create a SharePoint folder: `customers/<customer-id>/`
2. Add `<customer-id>` to `WATCH_FOLDERS` in `.env`
3. Add a hints block in `prompts/customerHints.js`
4. Drop a sample PDF in the folder and check the extraction log

---

## Confidence tuning

The `CONFIDENCE_THRESHOLD` (default 0.85) controls how many orders go via AUTO vs REVIEW.

- Start at **0.80** for a new customer until you're confident in the extraction quality
- Raise to **0.90** once you've seen consistent clean extractions
- The model's confidence scores are self-reported — review the logs after the first 20–30 orders per customer to calibrate

---

## Review workflow

When an order is routed to REVIEW, an email is sent to `MAIL_TEAM` containing:
- The flagged lines and the reason for each flag
- An **Approve** link — creates the BC order and sends a success confirmation
- A **Reject** link — sends a manual processing notification

Review links expire after `REVIEW_TIMEOUT_MINUTES` (default 240 minutes), after which the job escalates to `REVIEW_ESCALATION_EMAIL`.

---

## Deployment (Antigravity)

This service runs as a Node.js process on the Antigravity host alongside other GO365 services.

```bash
# Antigravity process manager (PM2 assumed)
pm2 start src/index.js --name pdf-order-intelligence
pm2 save
```

The webhook server needs to be reachable at `APP_BASE_URL` — ensure the Antigravity reverse proxy routes `/pdf-order-intelligence/*` to port `WEBHOOK_PORT`.

---

## Roadmap

- [ ] Persistent job store (replace in-memory Map with Azure Table Storage)
- [ ] Review UI — web page showing extraction detail, editable fields, approve/reject
- [ ] Duplicate PO detection (check BC before creating)
- [ ] Customer item cross-reference lookup against BC item catalogue
- [ ] Extraction quality dashboard (confidence trends per customer over time)
