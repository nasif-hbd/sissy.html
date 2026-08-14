# Build with Gemini XPRIZE — What's Required

> **Source note:** `xprize.devpost.com` and `geminixprize.com` are both blocked by this
> sandbox's network egress proxy, so this document is compiled from web search results and
> secondary coverage. **Verify every line against the official rules before you rely on it:**
> https://xprize.devpost.com/rules and https://www.geminixprize.com/rules

---

## 1. The deadline — read this first

| Milestone | Date (Pacific Time) |
|---|---|
| Submissions opened | May 19, 2026, 10:00 am |
| **Submissions close** | **August 17, 2026, 1:00 pm** |
| Judging period | Aug 18 – Sep 15, 2026 |
| Finalist pitch + winners | ~Sep 25, 2026 (live, Los Angeles) |

Today is **August 14, 2026**. That leaves roughly **3 days**.

## 2. What the competition actually asks for

This is **not** a prototype hackathon. It is a 90-day sprint to launch a *real operating
business*. The stated bar is: real users, real revenue, and AI running in production.
Projections and mockups explicitly do not win.

Judging is on **three equally weighted criteria**:

1. **Business viability** — real customers, real money, a model that can keep running.
2. **AI-native operations** — autonomous agents making real decisions live in production,
   not a chatbot bolted onto a landing page.
3. **Category impact** — how much the chosen category's problem is genuinely moved.

## 3. Pick exactly one category

- Education & Human Potential
- Entrepreneurship & Job Creation
- Small Business Services
- Money & Financial Access
- Professional Services

## 4. Technical requirements (hard gates)

- [ ] If the project uses any LLM functionality, **at least one LLM call in the deployed
      app must go through the Gemini API.** Other providers may be used alongside it.
- [ ] **At least one Google Cloud product** must be used.
- [ ] Built with the required developer tools/platform (the Gemini-family agentic tooling —
      Gemini, Antigravity, Stitch, Flow).
- [ ] The application must be **deployed** — actually running, reachable by judges.

## 5. Submission checklist

- [ ] **Category selection** (one of the five above).
- [ ] **Code repository URL** for judging and testing. It must contain all necessary source
      code, and be either:
      - public with appropriate licensing, **or**
      - private and shared with `testing@devpost.com` **and** `judging@hacker.fund`.
- [ ] **Text description** covering how the project meets the project requirements and its
      relevance to the chosen category.
- [ ] **Demo video, under 3 minutes.** Judges are not obligated to watch past the 3-minute
      mark. It should be a fast technical walkthrough proving autonomous agents are
      executing real decisions in production.

## 6. Evidence pack (this is what separates entries)

Screening and verification is run by Hacker Fund before an expert panel picks five
finalists. Expect to provide:

- **Revenue evidence** — Stripe dashboard export or bank statement, plus a simple P&L.
- **Product evidence** — agent execution logs, API usage records, dashboard screenshots
  showing AI running continuously in production.
- **Customer evidence** — real customer contact details (name, email, phone), plus any
  testimonials or written feedback.
- **Expenses** — total spend during the hackathon period, including marketing and
  customer acquisition.

## 7. Eligibility

- Individuals at or above the **age of majority** where they reside, as of entry time.
- Small organizations with **fewer than 25 employees** (corporations, nonprofits, LLCs,
  partnerships, other legal entities) that already existed/were incorporated at entry time.
- Certain countries/territories are excluded — **the official rules carry the list; check it.**
- No purchase or payment necessary; paying does not improve odds.

## 8. Prize structure — $2,000,000 across ~25 winners

| Place | Amount |
|---|---|
| 1st | $500,000 |
| 2nd | $200,000 |
| 3rd / 4th / 5th | $100,000 each |
| 15 runner-ups | $50,000 each |
| 5 category winners | $50,000 each |

## 9. Honest gap assessment for this account

Both attached repositories — `nasif-hbd/Goku` and `nasif-hbd/sissy.html` — currently
contain a single static "Button Explosion Birthday" HTML animation page. No backend, no
Gemini API call, no Google Cloud product, no deployment, no users, no revenue.

Against the requirements above, the gap is:

| Requirement | Status |
|---|---|
| Deployed application | ✗ missing |
| Gemini API call in production | ✗ missing |
| Google Cloud product | ✗ missing |
| Autonomous agents in production | ✗ missing |
| Real users | ✗ missing |
| Real revenue + P&L | ✗ missing |
| Category selection | ✗ not chosen |
| Demo video (<3 min) | ✗ missing |
| Written description | ✗ missing |

The competition scores a 90-day operating history of real customers and real revenue.
With ~3 days remaining, an entry built from here cannot produce that history, and the
revenue/customer evidence pack cannot be fabricated — verification is an explicit
screening stage. A submission is still *possible* before the deadline, but it would be
competing on an empty evidence pack against teams with three months of live traction.

**Realistic options:**

1. **Submit anyway**, minimally: pick a category, ship something genuinely deployed that
   makes a real Gemini API call on a Google Cloud product, record the 3-minute video, and
   accept that it scores near zero on business viability. Costs a few days, wins nothing,
   but the artifact exists.
2. **Skip this cycle** and use the checklist above as the build spec for the next one —
   starting on day 1 of the window rather than day 87, so the revenue and agent-log
   evidence actually accumulates.

Option 2 is the one that can actually win. Option 1 is only worth it if the goal is to
have submitted rather than to place.
