# PDF Order Intelligence

**Antigravity project** — Intelligent PDF sales order extraction pipeline for Business Central.

Replaces the Power Automate AI Builder custom model approach with a Claude-powered extraction engine that reasons about document layout rather than pattern-matching a trained model. The result is layout-change resilience, per-line confidence scoring, and a human review loop that eliminates silent errors.

---

## Architecture

```
SharePoint shared inbox folder (single folder)
        │
        ▼  (poll via MS Graph)
  [Watcher] sharepointWatcher.js
        │
        ▼
  [Extractor] extract.js
     Claude reads PDF as image(s)
     Step 1: Identifies customer from known list
     Step 2: Extracts JSON + per-field confidence scores
        │
        ▼
  [Validator] validate.js
     Schema check + confidence threshold routing
     + customer identification check
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

**Customer identification:** The model matches the PDF against a known customer list
(`prompts/customerHints.js`) and returns `customer_id` with a confidence score.
If identification fails (confidence < 0.80), the order routes to REVIEW where a
human selects the correct customer from an email link.

**Disposition rules:**
| Disposition | Trigger | Outcome |
|-------------|---------|---------|
| `AUTO` | All fields ≥ threshold AND customer identified | BC order created immediately |
| `REVIEW` | Any field below threshold OR customer unidentified | Email sent to team with flagged lines; reviewer approves or rejects |
| `REJECT` | Critical field missing / parse failure | Fail email; manual processing required |

---

## Project structure

```
pdf-order-intelligence/
├── prompts/
│   ├── extraction.md          # Master extraction prompt (with customer identification)
│   └── customerHints.js       # Known customer list + per-customer layout guidance
├── src/
│   ├── extractor/
│   │   └── extract.js         # PDF → Claude → JSON (customer ID extracted from PDF)
│   ├── validator/
│   │   └── validate.js        # Confidence scoring + disposition + CUSTOMER_UNIDENTIFIED
│   ├── bc/
│   │   └── createOrder.js     # BC API v2.0 order creation
│   ├── email/
│   │   └── notify.js          # Success / review / reject emails + review tokens
│   ├── router/
│   │   └── pipeline.js        # Orchestrates the full flow (trigger-agnostic)
│   ├── watcher/
│   │   └── sharepointWatcher.js  # SharePoint poll trigger (single folder)
│   ├── server/
│   │   └── webhookServer.js   # Express webhook for review responses
│   └── utils/
│       ├── logger.js
│       └── jobStore.js
├── tests/
│   └── extract.test.js
├── docs/                      # Original scaffold reference files
├── .env.example
├── .gitignore
└── package.json
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jimrankin/pdf-order-intelligence.git
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
| `CONFIDENCE_THRESHOLD` | 0.85 recommended; field-level AUTO vs REVIEW |
| `CUSTOMER_ID_THRESHOLD` | 0.80 recommended; customer identification confidence |
| `WATCH_FOLDER` | Single SharePoint folder path (e.g. `customers/incoming`) |
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
# Development (with --watch for auto-restart)
npm run dev

# Production
npm start

# Tests
npm test
```

---

## Adding a new customer

1. Add an entry to `customerList` in `prompts/customerHints.js` with `id`, `name`, and `identifiers`
2. Add a hints block in the `customerHints` map (same file) if the customer has layout quirks
3. Drop a sample PDF in the watched folder and check the extraction log
4. Verify the model identifies the customer correctly; adjust identifiers if needed

---

## Confidence tuning

The `CONFIDENCE_THRESHOLD` (default 0.85) controls field-level AUTO vs REVIEW routing.
The `CUSTOMER_ID_THRESHOLD` (default 0.80) controls customer identification confidence.

- Start at **0.80** for both until you're confident in the extraction quality
- Raise to **0.90** once you've seen consistent clean extractions
- The model's confidence scores are self-reported — review the logs after the first 20–30 orders per customer to calibrate

---

## Review workflow

When an order is routed to REVIEW, an email is sent to `MAIL_TEAM` containing:
- **If customer unidentified:** prominent customer selection section with a button per known customer
- The flagged lines and the reason for each flag
- An **Approve** link — creates the BC order and sends a success confirmation
- A **Reject** link — sends a manual processing notification

Review links expire after `REVIEW_TIMEOUT_MINUTES` (default 240 minutes), after which the job escalates to `REVIEW_ESCALATION_EMAIL`.

---

## Roadmap

- [ ] Persistent job store (replace in-memory Map with Azure Table Storage)
- [ ] Email capture trigger — monitor a shared mailbox instead of SharePoint folder
- [ ] Review UI — web page showing extraction detail, editable fields, approve/reject
- [ ] Duplicate PO detection (check BC before creating)
- [ ] Customer item cross-reference lookup against BC item catalogue
- [ ] Extraction quality dashboard (confidence trends per customer over time)
