# Money, Insights and Statements: redesign of Finance, Reports and Analytics

> **Guiding principle (owner):** "Make them what they are supposed to be used for:
> meaningful, insightful and correct."
>
> Every section below is tested against it. A section stays only if it supports a
> real decision the owner makes, shows a comparison and a plain one-line takeaway
> with a next step, and has a spec ID, one implementation, an oracle test and a
> real-data audit result of 0 unexplained mismatches.

Status: **design only** (no app code in this PR). Date: 26 Oct 2026.
Scope: the Finance, Reports and Analytics pages. They are replaced as a clean
slate, not tidied up. Today, Outstanding, Cash drawer, Stock and Rates stay; this
design only changes what they own and link to.

Inputs: `www/templates/{finance,reports,analytics}.html`,
`www/js/modules/{finance,reports,analytics}.js`, `utils/finance-calc.js`,
`utils/finance-breakdown.js`, `docs/calculations.md`, `tests/oracle`,
`tests/property`, `docs/role-permissions.md`, the UI audit of 25 Oct 2026
(findings F01–F38, cited as **UI-F14** etc.) and the real-data number audit of
25 Oct 2026 (cited as **NA**, counts only; no names or amounts are copied here).

## Contents

0. [Summary: the recommendation](#0-summary-the-recommendation)
1. [Inventory of today's three pages](#1-inventory-of-todays-three-pages)
2. [The owner's questions and decisions](#2-the-owners-questions-and-decisions)
3. [References: what well-known apps do](#3-references-what-well-known-apps-do)
4. [Scorecard: how we judge a page](#4-scorecard-how-we-judge-a-page)
5. [Proposed structure](#5-proposed-structure)
6. [Single home for every figure](#6-single-home-for-every-figure)
7. [One calculation layer](#7-one-calculation-layer-business-metricsjs)
8. [Wireframes](#8-wireframes)
9. [Performance and read budget](#9-performance-and-read-budget)
10. [Migration plan](#10-migration-plan)
11. [Open questions for the owner](#11-open-questions-for-the-owner)

---

## 0. Summary: the recommendation

Replace the three pages with three new ones, in the side menu's "Business" group:

| New page | English nav | Hindi nav | Icon | Answers | Replaces |
|---|---|---|---|---|---|
| **Money** | Money | हिसाब | 💰 | Am I making money, where did it go, what do I own and owe, how much can I take out? | Finance (all tabs), Reports › Overview profit/payments, Analytics › Overview |
| **Insights** | Insights | कारोबार | 💡 | What sells, to whom, when and at what margin; what should I act on this week? Includes **Rate trends** and **Product traffic**. | Analytics › Trends/Items/Insights, Reports › Purchases/Sales/Compare |
| **Statements** | Statements | बही-खाता | 🧾 | Show me the records: day book, month statement, party ledger, item ledger; print, PDF, WhatsApp, CSV. | Reports exports (CSV/PDF), Reports recent lists |

Why this shape (details in §4 and §5):

- **One question per page.** Money is the owner's "पैसा" view (profit and loss,
  cash, spending, worth). Insights is the trader's "माल" view (items, parties,
  seasons, actions). Statements are documents, not dashboards. This is the same
  split Vyapar, myBillBook and Tally make between a dashboard and a reports list
  (§3).
- **Every figure has one home** (§6). Today keeps today; Outstanding keeps dues;
  Stock keeps stock value; Rates keeps rate lines. The new pages link to them.
- **One calculation layer** (`www/js/utils/business-metrics.js`, §7) computes
  every figure once. It fixes the four known bugs (#49, #220, #47, UI-F14) and
  the opening-records leak (PR #18) for all pages at once.
- **Comparisons are built in.** Every headline shows "vs last month" and "vs the
  same month last year", from small monthly snapshots plus the weekly
  `rateStats` (2 years of history), with no full-history scans on open.
- **Safe rollout.** New pages ship behind an owner switch; the old pages stay
  until Phase 5 removes them (§10).

---

## 1. Inventory of today's three pages

Legend: ✅ correct and useful · ⚠️ correct but misleading or duplicated · ❌ wrong.
"Dup" lists the other places that show the same figure.

### 1.1 Finance (`finance.html`, `finance.js`, `finance-calc.js`, `finance-breakdown.js`)

Period buttons: All / Year / Month / Week / Custom. "Week" and "Month" are
*last 7 / last 30 days* in `finance.js:getRangeStart` (today − 7, today − 1
month), while the spec PERIOD says calendar week/month (#43 open). Bills belong
to the period by stock time (`timestamp`, else date).

| # | Card / number | Spec | What it means | Calculation | Dup | Verdict |
|---|---|---|---|---|---|---|
| F-a | Hero "Profit on goods sold" | F4 | Business profit | sales − COGS − business expenses − bad debts (`computeFinanceSummary`) | R3, A4 | ✅ the one proven definition (#36, #215). NA: differs from the oracle in 40 of 85 periods, all explained by "sold before bought" (AC8 data: 1,083 sale lines; 13 of 43 items end below zero). |
| F-b | "Profit after personal expenses" line | F4 − F5 | Profit left after family spending | F4 − F5 | — | ✅ |
| F-c | Uncosted warning ("x kg sold before its purchase was recorded") | — | Profit may be overstated | stock replay | — | ✅ honest; missing on Reports and Analytics (UI-F14) |
| F-d | Sales card (+ count, "still due") | F1 | Sales in period | Σ BILL-TOTAL, count | R2, A1, T2 | ⚠️ count includes opening records (NA: 12 of 13 migrated periods; fixed by PR #18) and disagrees with Reports (UI-F14) |
| F-e | Cost of goods sold | F2 | Buying cost of what was sold | AVG-COST replay | — | ✅ |
| F-f | Business expenses (+ entries) | F3 | Shop running costs | EXP-KIND business | A3 | ✅ (A3 is wrong, below) |
| F-g | Stock value now | F6 | Stock worth at cost | Σ qty × AVG-COST | S4, Assets | ⚠️ in 3 places; ₹0 with no hint when opening stock is missing (UI-F15) |
| F-h | Profit breakdown table | F1–F4 | Terms of the profit | rows | — | ✅ |
| F-i | Stock value table (opening + purchases − COGS ± adjustments = closing) | F8 | Check line | `stockMovement` | — | ✅ gap by design after refilled oversells (NA: 68 of 85 periods), but not explained in plain words |
| F-j | Cash flow table | F7 | Money in − money out | BILL-AT-SAVE + DUE-PAY + expenses | — | ✅ (approximate for long periods; it says so) |
| F-k | Personal expenses / Withdrawn / "Profit left after personal expenses and withdrawals" | F5, F11 | Owner's draw | sums | F-p | ✅ but buried at the bottom |
| F-l | Monthly profit chart (6 months) | F4 by month | Trend | 6 replays | A7 | ⚠️ no last-year comparison; "—" when history isn't loaded |
| F-m | Assets › Net worth | F12 | Total worth | stock + receivable − payable + "business balance" + custom accounts | — | ❌ counts dues twice (#39 open) |
| F-n | Assets › Stock value, Due to receive, Due to pay, Business balance | F6, F9, F10 | Parts of worth | — | S4, O3/O4, R6/R7, A5/A6 | ⚠️ dues shown on 4 pages |
| F-o | Custom accounts (Bank, Cash, Lent, Savings) | — | Owner-entered balances | stored doc | — | ✅ keep as "Other accounts" |
| F-p | Withdrawals tab: total, "Available to withdraw", form, history | F11 | Record and list draws | sums | F-k | ⚠️ "Available" = profit − withdrawals; ignores cash actually on hand |
| F-q | Tap any number → breakdown sheet (search, group, sort, 50 rows/page) | — | Traceability | `finance-breakdown.js` | — | ✅ **the best idea on any of the pages: keep and generalise** |

UI problems: sticky bars cover the tap hint and cut "Cus…" (UI-F09); English
tabs in Hindi mode (UI-F05); grey labels at 2.5:1 contrast (UI-F18).

### 1.2 Reports (`reports.html`, `reports.js`)

Period buttons: All / Year / Month / Week / Today / Custom; **default Week**
(Finance defaults to All). Filtering uses the bill **date** (`filterByDate`), not
Finance's stock time. "Week" = last 7 days.

| # | Card / number | Spec | What it means | Calculation | Dup | Verdict |
|---|---|---|---|---|---|---|
| R-a | Hero "Total Business Volume" | — | purchases + sales | adds both directions | — | ❌ meaningless: adds money in and money out |
| R-b | Purchases (₹, bills) | R1 | Bought in period | Σ BILL-TOTAL | A2, T1 | ⚠️ |
| R-c | Sales (₹, bills) | R2 | Sold in period | Σ `total` | F1, A1 | ❌ count disagrees with Finance and History (UI-F14: 5 vs 11); opening records counted (NA: 12 of 13 periods) |
| R-d | Profit on goods sold + "% margin" | R3 | = F4 | `FinanceManager.profitSummary` | F4, A4 | ⚠️ "100.0% margin" without the uncosted warning (UI-F14) |
| R-e | "Labor Cost: All labor charges" | R8 | Labour | Σ `laborCharges` on purchases **and** sales | T3 | ⚠️ unclear; spelling "Labor" (UI-F13) |
| R-f | Payment breakdown: Cash, Online | R4, R5 | Money moved | Σ current cash/online over purchases **and** sales | — | ❌ adds both directions; reads the bill's *current* cash, so a later due payment lands on the old bill's date (NA: R4 off in 2 of 13 migrated periods) |
| R-g | Payment breakdown: Due to pay / receive | R6, R7 | All-time dues | Σ BILL-DUE | F9/F10, A5/A6, O3/O4 | ⚠️ 4th copy of dues; all-time under a period filter |
| R-h | "Business Trends" chart ("Last 7 days") | — | Daily purchases vs sales | last 7 *active dates* in the period | — | ⚠️ label says last 7 days; it is the last 7 dates with bills |
| R-i | Top Items | — | Biggest items | Σ line totals of purchases **and** sales together | A-k | ❌ mixes buying and selling in one ranking; line totals before labour (#47) |
| R-j | Purchases tab: total, bills, avg bill, labour, outstanding, filters, item-wise, payment summary, recent | R1… | Purchase register | as above | R-b | ⚠️ all-time outstanding under a period filter; item rows before labour don't add up to the total (#47) |
| R-k | Sales tab: same set, "Labor" on sales | R2… | Sales register | as above | R-c | ⚠️ same |
| R-l | Recent lists | — | Last bills | `new Date(bill.date)` (`reports.js:954`) | History | ❌ DD/MM dates misread |
| R-m | Compare tab: purchases vs sales, "Sales above purchases", table, chart, item comparison | — | Buying vs selling | differences | — | ⚠️ "sales − purchases" is not profit and supports no decision |
| R-n | CSV / PDF export | — | Share | line CSV, printable HTML | — | ✅ needed: rebuilt as Statements |

UI problems: the whole page is English in Hindi mode (UI-F05); emoji squares (UI-F12).

### 1.3 Analytics (`analytics.html`, `analytics.js`)

Analytics has its own `parseDate` (`new Date(text)`), its own `getTotal` and
its own "this month" (1st to now).

| # | Card / number | Spec | What it means | Calculation | Dup | Verdict |
|---|---|---|---|---|---|---|
| A-a | "Today's Cash Prediction": expected purchases, sales, cash needed, confidence | — | Guess for today | mean of the same weekday over 4 weeks; confidence = 50 + 10 × days | — | ❌ title nearly invisible; "Confidence 60%" with ₹0 values (UI-F11); dates misread (#49) |
| A-b | This month: Total revenue (+ vs last month) | A1 | Sales month to date | `parseDate` filter | F1, R2 | ❌ #49 |
| A-c | This month: Total purchases | A2 | Bought month to date | same | R1 | ❌ #49 |
| A-d | This month: Profit + margin | A4 | = F4 | Finance summary | F4, R3 | ⚠️ no uncosted warning |
| A-e | This month: Expenses (+ count) | A3 | Business expenses | `parseDate` + `category !== 'personal'` | F3 | ❌ #49: NA found all 734 of 734 expenses dated `D/M/YYYY, h:mm:ss pm`; wrong in 10 of 24 months; about two thirds of entries missed |
| A-f | Outstanding: You owe / You'll receive (+ bills) | A5, A6 | Dues | `due || payment.due`, ignores `cleared` | F9/F10, R6/R7, O3/O4 | ❌ #220: counts cleared bills (NA: 64 cleared bills still carry a due; receivable count 57 where 10 is right) |
| A-g | Month-end projection: revenue, profit, cash required, days left | — | Straight-line guess | month to date ÷ day × days | — | ⚠️ ignores seasons (#144) |
| A-h | Profit trend 7D/30D/90D + profit/loss days | A7 | Daily profit | F4 by day | F-l | ✅ number; ⚠️ 22 px buttons (UI-F26) |
| A-i | Item rate trends (this month vs last) | — | Purchase-rate change | **simple mean** of line rates by raw name | RT1 | ❌ not kg-weighted, not catalogue-matched; a worse copy of Rates › Trends |
| A-j | Items to focus | — | Margin tips | "profit" = line sales − line purchases of the month | — | ❌ purchases are not the cost of what was sold |
| A-k | Top performers by revenue / quantity | — | Best sellers | line totals by raw name | R-i | ⚠️ |
| A-l | Smart suggestions | — | Tips | fixed thresholds (₹50k dues, ₹10k/day…) | — | ❌ dues from the #220 formula; "Low stock alert: <raw item id>" (UI-F03); "₹0 average daily sales" (UI-F27); English only |
| A-m | Customer insights: active buyers/sellers, avg per customer, top customers | — | Party activity | raw `buyer`/`seller` strings | — | ⚠️ case-different names counted twice (UI-F16) |

### 1.4 Cross-page problems

1. **The same figure in up to four places**: dues (F9/F10, R6/R7, A5/A6, O3/O4),
   sales (F1, R2, A1), profit (F4, R3, A4), stock value (F6, Assets, S4).
2. **Three date rules**: stock time (Finance), bill date (Reports), raw
   `new Date` (Analytics; Reports recent list).
3. **Three "this month"s**: last 30 days (Finance), last 7 days by default
   (Reports), 1st to now (Analytics).
4. **Three bill counts** (UI-F14), and opening records counted as activity (PR #18).
5. **Item figures by raw name and before labour** (#47) don't add up to totals.
6. **No comparison with last year** anywhere, though two years of bills and the
   weekly `rateStats` exist.
7. **Honesty only on Finance**: Reports and Analytics show "100% margin" or
   "Confidence 60%" over empty data.
8. **Hindi**: Reports and Analytics are English in Hindi mode (UI-F05).

---

## 2. The owner's questions and decisions

Each page section starts from one of these. "Decision" is what the owner does
differently after reading it.

| # | Question (plain words) | Hindi (as the shop says it) | Decision it supports | Answered in |
|---|---|---|---|---|
| Q1 | Am I making money this month? Better or worse than last month and last year? | इस महीने मुनाफ़ा हुआ? पिछले साल से कम या ज़्यादा? | Keep going, cut costs, change rates | Money › Profit |
| Q2 | Where does profit come from: which items, retail or wholesale? | मुनाफ़ा किस माल से, खुदरा या थोक? | Push or drop an item; change the mix | Insights › Items |
| Q3 | Where did the money go? | पैसा कहाँ गया? | Cut an expense; watch personal spending | Money › Spending |
| Q4 | How much money came in and went out? | कितना पैसा आया-गया? | Arrange cash for coming purchases | Money › Cash (one day: Cash drawer) |
| Q5 | What do I own and owe? How much can I safely take out? | कुल कितना है, कितना निकाल सकता हूँ? | Withdraw, invest or hold | Money › Worth |
| Q6 | Who owes me and whom do I owe? | किसका उधार बाकी है? | Which parties to chase this week | **Outstanding** (linked from Insights › Actions) |
| Q7 | Who are my best customers and suppliers? Who stopped coming? | सबसे अच्छे ग्राहक और किसान कौन? | Call a lapsed buyer; prefer a supplier | Insights › Parties |
| Q8 | What sells when? What to stock up before the season? | कौन सा माल कब बिकता है? | Buy ahead of the season; set rates | Insights › Seasons (+ Rate trends, Product traffic) |
| Q9 | Where am I losing margin? | घाटा कहाँ हो रहा है? | Raise a rate; stop selling below cost | Insights › Actions, Items |
| Q10 | What must I act on this week? | इस हफ़्ते क्या करना है? | A short to-do list | Insights › Actions |
| Q11 | Show me the records for a party, a day or a month; send them on WhatsApp | हिसाब दिखाओ, भेजो | Settle with a party; check a day; give a month to the accountant | Statements |

Dropped: "What will I sell today?" (A-a) has no reliable answer from four
same-weekday samples in a seasonal trade. "Projected month end" (A-g) is
replaced by the factual "the same month last year ended at …".


---

## 3. References: what well-known apps do

Collected 26 Oct 2026 from public product pages and help articles (sources
below). Only report *types* and presentation *patterns* are used; no design is
copied.

| App | Reports and metrics relevant to an aadhat | How they present them | We take | We skip |
|---|---|---|---|---|
| **Vyapar** [1][2] | Day book, party statement, profit and loss, stock summary, item-wise profit, cash flow, receivable/payable ageing, sale/purchase/expense reports, balance sheet | A reports list grouped by type; every report filtered by date range and party/item; export to Excel or print | Day book, party statement, item-wise profit, ageing as separate named statements | GST and tax reports; balance sheet jargon |
| **myBillBook** [3][4] | Profit and loss, item sales summary, party-wise outstanding, daybook, stock summary, daily summary | Dashboard + "Reports" section; filters by date, item, category, party; PDF share | A daily/monthly summary as a shareable document | Category taxonomies the shop doesn't use |
| **Khatabook / OkCredit** [5][6] | Party ledgers (udhar), balances per customer, WhatsApp/SMS reminders with payment links, PDF statements | One list of parties with the balance first; tap a party → ledger; "Remind" button | Party ledger with running balance; WhatsApp share of a statement; reminders stay on Outstanding | Payment links (no payment gateway here) |
| **Marg ERP** [7][8] | Item-wise gross profit (incl. a "gross-loss items" filter), stock ageing, outstanding analysis, MIS dashboard | Management reports menu; filters; drill to bills | "Sold below cost" / low-margin items as an action list; stock ageing → dead stock | Operator/terminal filters |
| **Busy** [9] | Stock ageing, item-wise gross profit, outstanding, MIS, cash/bank book, day book, ratio analysis | Summary ↔ detail toggle; export to Excel/PDF | Summary first, detail on tap | Ratio analysis |
| **Tally Prime** [10][11][12] | Day book, ledger, stock summary (opening, inward, outward, closing), ratio analysis (gross profit %), cash flow, outstandings ageing | **Drill down from any line to the voucher** (press Enter); period comparison columns | Drill-down from every number to the bills; the stock summary's opening + in − out = closing line | Accounting vocabulary (voucher, ledger groups) |
| **Zoho Books** [13][14] | Business overview: P&L, cash flow, receivables ageing, sales by customer, sales by item; compare reports by period/year | Dashboard widgets; "Compare with previous period / previous year" as a report option | Compare every headline with the previous period **and** the same period last year | Custom report builder |
| **QuickBooks** [13][15] | P&L with % change vs prior period, A/R ageing, sales by customer/product, cash flow | P&L dashboards with variance amount and percent | Show both the ₹ change and the % change | Accrual vs cash basis switch |
| **Shopify analytics** [16] | Sales, orders, top products; date range with a comparison period | Metric cards with % change and a sparkline; comparison range picker at the top | One period picker at the same place on every screen; % change on every card | Online-store metrics (sessions, conversion) |
| **Square dashboard** [17] | Sales summary, sales trends, top items, payment methods | Summary cards, then trends; reports list | Payment split (cash vs online) inside cash flow | Staff/location splits |
| **Stripe dashboard** [18] | Gross/net volume, payments; compare to previous period | Toggle "compare to previous period"; arrows and colour; chart overlays both periods | Overlay last year as a faint line on trend charts | — |
| **Aadhat / mandi software** (Arhatix, Katapatti, MandiGrow, Indian Comp Tech) [19][20][21][22] | Kisan (farmer) ledger, patti (sale statement), hamali/labour and commission deductions, buyer ledger, day book, cash book, lot-wise stock, P&L | Ledgers per party in Hindi/English; WhatsApp patti | Party ledger for farmers and buyers; labour shown as its own line | Commission, mandi fee, J-form compliance (not this shop's model) |
| **eNAM / Agmarknet** [23][24][25] | Commodity min / max / modal price by market and date; month-wise trends | Time series and monthly charts per commodity | Monthly rate trend per item with last year's line (already in Rates › Trends, RT1/RT2) | Market-to-market comparison (one shop) |

**Patterns adopted** (each is used in §5):

1. **Summary first, drill to the bill** (Tally, Busy, Finance today).
2. **Previous period and same period last year on every headline** (Zoho,
   QuickBooks, Shopify, Stripe).
3. **Named statements, not a dashboard of everything** (Vyapar, myBillBook,
   Tally): day book, party ledger, item ledger, month statement.
4. **Party ledger with running balance, shareable on WhatsApp** (Khatabook,
   OkCredit, mandi software).
5. **Item-wise gross profit with a "loss items" filter** (Marg, Busy).
6. **Ageing and dead stock as actions** (Vyapar, Marg, Busy).
7. **Stock summary line: opening + bought − sold = closing** (Tally).
8. **Season view per commodity** (Agmarknet/eNAM monthly trends).

**Sources**

1. Vyapar, "How to check transaction reports": https://vyaparapp.in/guides/how-to-check-transaction-reports-in-vyapar-app
2. Vyapar feature list: https://vyaparapp.in/blog/vyapar-app-features/
3. myBillBook business reports: https://mybillbook.in/s/features/business-reports/
4. myBillBook daily summary, balance sheet and P&L: https://knowledge.mybillbook.in/articles/9707273-comprehensive-financial-reporting-daily-summary-balance-sheet-and-pandl-statement
5. OkCredit (vs Khatabook): https://okcredit.in/khatabook-alternative
6. Khatabook vs OkCredit compared: https://blog.slantco.com/khatabook-vs-okcredit-indias-bookkeeping-apps-compared/
7. Marg ERP, item-wise gross profit: https://care.margcompusoft.com/margerp/management-reports/1729/1/how-to-view-item-wise-gross-profit-report-in-marg-erp-software
8. Marg ERP, stock ageing analysis: https://care.margcompusoft.com/margerp/stock-ageing-analysis/17409/1/How-to-view-stock-ageing
9. BUSY vs Marg ERP comparison: https://dmsoftwarehmt.com/busy-software-vs-marg-erp-practical-comparison/
10. TallyPrime, analysing business reports: https://tallysolutions.com/tally/easy-analysis-of-business-reports-with-tallyprime/
11. TallyPrime ratio analysis: https://help.tallysolutions.com/ratio-analysis-tally/
12. TallyPrime inventory reports: https://tallyprimebook.com/inventory-reports-and-statements-in-tallyprime-accounting-software/
13. Zoho Books reports: https://www.zoho.com/us/books/help/reports/
14. Zoho Books, compare reports: https://www.zoho.com/us/books/kb/reports/compare-reports.html
15. P&L dashboards in QuickBooks, Xero and Zoho: https://vidi-corp.com/profit-and-loss-dashboards/
16. Shopify, using the Analytics overview dashboard: https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/using-the-overview-dashboard
17. Square, sales summary, sales trends and payment methods: https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports
18. Stripe Dashboard docs: https://stripe.com/docs/dashboard
19. Arhatix aadhat mandi software: https://arhatix.com/
20. Katapatti mandi and adat software: https://katapatti.com/
21. MandiGrow commission agent software: https://www.mandigrow.com/commission-agent-software
22. Indian Comp Tech, Mandi (Aadhat) software: https://indiancomptech.com/mandiaadhat-software/
23. e-NAM Agmarknet price dashboard: https://enam.gov.in/dashboard/agmarknet
24. Agmarknet prices and arrivals: https://www.india.gov.in/category/agriculture-rural-environment/subcategory/agricultural-produce/details/prices-arrival-reports-agmarknet
25. CEDA agri market data (Agmarknet visualisations): https://agmarknet.ceda.ashoka.edu.in/

---

## 4. Scorecard: how we judge a page

### 4.1 Criteria

Each criterion is scored 0–3 per page (0 = absent or wrong, 1 = weak,
2 = good, 3 = exemplary). "Proposed" scores are **targets**; each phase's PR must
show them met (tests, audit, 5-second test, screenshots).

| # | Criterion | Score 3 means | Source |
|---|---|---|---|
| C1 | Decision value | Every section names the decision it supports (§2) | owner |
| C2 | Correctness | Every figure has a spec ID, one implementation, an oracle test, an accounting check, and 0 unexplained real-data audit mismatches | owner, #216 |
| C3 | No redundancy | Each figure in exactly one place; elsewhere a link chip (§6) | owner |
| C4 | Comparability | vs previous period **and** same period last year | Zoho, QuickBooks, Shopify |
| C5 | Actionability | A next step or link under every takeaway | owner |
| C6 | Drill-down / traceability | Any number → the bills that make it up → the bill | Tally, Finance today |
| C7 | Clarity for a non-accountant | Plain words, one takeaway sentence per section, no "COGS"/"accrual" | owner |
| C8 | Glanceability (5-second test) | The screen's one question is answered above the fold within 5 s on a 390 px phone | owner |
| C9 | Speed and read cost | Opens in < 1.5 s; ≤ 10 reads on a repeat open, ≤ 100 on the first open of the day (Spark 50k/day) | AGENTS, UI audit |
| C10 | Data completeness honesty | "Data incomplete" caveats (unknown cost, no opening stock, history not loaded) instead of misleading numbers | owner, Finance today |
| C11 | Role safety | Members see only what Roles & access allows; nothing leaks through deep links (UI-F23) | role-permissions.md |
| C12 | Language quality | One language at a time; natural Hindi (बिक्री, खरीद, उधार, मुनाफ़ा, माल की लागत) | AGENTS, UI-F05 |
| C13 | Print / export / share | PDF/print, CSV, WhatsApp text for every statement | Vyapar, Khatabook, Tally |
| C14 | Consistency with Today / Outstanding / Rates | Same terms, same numbers, same period rules; links not copies | owner |
| C15 | Accessibility | ≥ 4.5:1 text contrast, ≥ 44 px tap targets, ≥ 12 px text (UI-F18, F26) | UI audit |
| C16 | Trust / auditability | A visible "checks pass" line: totals reconcile with Outstanding, Cash, Stock | Tally, #216 |
| C17 | Seasonality awareness | Uses 2 years of history and weekly `rateStats` to compare seasons | owner, eNAM |
| C18 | Intuitiveness | A first-time user finds the answer without help: shop words, the most important thing first, the period picker and back button always in the same place | owner |
| C19 | Owner gut check | Takeaways match what an experienced shopkeeper expects; surprising numbers are explained ("profit is low because 40 kg was sold below cost") | owner |

### 4.2 Current pages vs proposed pages

| # | Criterion | Finance | Reports | Analytics | **Money** | **Insights** | **Statements** |
|---|---|---|---|---|---|---|---|
| C1 | Decision value | 2 | 1 | 1 | 3 | 3 | 2 |
| C2 | Correctness | 2 | 1 | 0 | 3 | 3 | 3 |
| C3 | No redundancy | 1 | 0 | 0 | 3 | 3 | 3 |
| C4 | Comparability | 1 | 0 | 1 | 3 | 3 | 1 |
| C5 | Actionability | 0 | 0 | 1 | 2 | 3 | 2 |
| C6 | Drill-down | 3 | 1 | 0 | 3 | 3 | 3 |
| C7 | Clarity | 2 | 1 | 1 | 3 | 2 | 3 |
| C8 | Glanceability | 2 | 1 | 1 | 3 | 3 | 2 |
| C9 | Speed and reads | 2 | 3 | 3 | 2 | 2 | 3 |
| C10 | Honesty | 3 | 0 | 0 | 3 | 3 | 3 |
| C11 | Role safety | 2 | 2 | 2 | 3 | 3 | 3 |
| C12 | Language | 1 | 0 | 0 | 3 | 3 | 3 |
| C13 | Export / share | 0 | 2 | 0 | 3 | 2 | 3 |
| C14 | Consistency | 2 | 1 | 0 | 3 | 3 | 3 |
| C15 | Accessibility | 1 | 1 | 0 | 3 | 3 | 3 |
| C16 | Trust / audit | 2 | 0 | 0 | 3 | 2 | 3 |
| C17 | Seasonality | 0 | 0 | 0 | 1 | 3 | 0 |
| C18 | Intuitiveness | 2 | 1 | 1 | 3 | 2 | 3 |
| C19 | Gut check | 2 | 0 | 0 | 3 | 3 | 2 |
| | **Total (of 57)** | **30** | **15** | **11** | **53** | **52** | **48** |

Reasons for the current scores (evidence in §1): Finance is the only page with a
proven profit, drill-down and honest warnings, but it has no comparisons, no
actions and it repeats dues and stock value. Reports adds both directions of
money ("Total business volume", R4/R5), counts bills differently (UI-F14) and
is English in Hindi mode. Analytics is wrong on three of its four "this month"
numbers (#49, #220) and gives tips from purchases instead of the cost of goods
sold.

Why the proposed pages don't score 3 everywhere: Money's first open reads up to
about 55 documents (C9); Insights' takeaways are about items and parties, which
are harder words for a first-time user (C7, C18); Statements are records, so
they have no season view (C17) and only "previous month" comparisons (C4).

### 4.3 Structures considered

| Option | Description | C1 | C3 | C8 | C18 | Verdict |
|---|---|---|---|---|---|---|
| **A (recommended)** | Money + Insights + Statements | 3 | 3 | 3 | 3 | One question per page; matches the dashboard/reports split of every reference app; Statements gives Reports' exports a clear home |
| B | One "Business" page with 8 tabs | 2 | 3 | 1 | 1 | Too many tabs for a 390 px phone (the Finance date row already overflows, UI-F09); one page owning everything makes the period picker serve unlike tasks (a ledger needs a party, not a month) |
| C | Keep Finance, Reports, Analytics and fix their bugs | 1 | 0 | 2 | 1 | Keeps the duplication (§1.4) that the owner asked to remove |
| D | Money + Insights, exports inside each page | 3 | 2 | 3 | 2 | Statements would be scattered; a party ledger isn't a Money or an Insights question |


---

## 5. Proposed structure

### 5.1 Rules every new screen follows

1. **Answer first.** The top card answers the screen's one question in a number
   plus one takeaway sentence; detail follows below (5-second test, §5.6).
2. **One period picker, same place on every screen**: a single sticky row under
   the page title: `‹  Oct 2026  ›` plus a preset menu (This month, Last month,
   This year, Last year, Pick months). Default **This month = calendar month to
   today** (#43, recommended). No horizontal button rows (UI-F09).
3. **Every headline carries two comparisons**: vs the previous period and vs the
   same period last year, as `▲ 12% vs Sep` and `▼ 3% vs Oct 2025`, with the ₹
   difference in the drill-down. Colour is only a second signal; arrows and words
   carry the meaning (C15). A change under 2% reads "about the same".
4. **Takeaway sentence**: one plain sentence built by `takeaways.js` (pure,
   i18n keys in both catalogues). Patterns are listed per section below.
5. **Next step**: every takeaway ends in a link or button ("See items",
   "Open Outstanding", "Record withdrawal").
6. **Tap any number → what makes it up**: the Finance breakdown sheet,
   generalised (`finance-breakdown.js` → `metric-breakdown.js`): rows of bills,
   expenses and payments with search, group (item / party / day), sort and 50 rows
   per page; tap a row to open the bill in History.
7. **Caveat chips instead of misleading numbers** (C10). When a figure is not
   reliable it shows "—" or the number with an amber chip that says why and what
   to do:
   - `Cost not known for 12 kg` → "sold before the purchase was recorded" → link
     to the item ledger;
   - `Opening stock not set` → link to Stock › Adjustment (UI-F15);
   - `Older months not loaded` → "Build month history" (owner, §7.6);
   - `Some expenses have no type` (#219) → link to Expenses.
8. **Gut-check notes**: when a figure would surprise an experienced shopkeeper,
   the takeaway says why (§5.5).
9. **Checks line** at the bottom of Money and Insights: `✓ Matches Outstanding,
   Cash drawer and Stock` (C16); on a mismatch it turns amber and links to
   Diagnostics › Number checks.
10. **Links instead of copies**: a figure owned elsewhere appears only as a
    small link chip, e.g. `To receive → Outstanding` (§6).
11. **Words**: English or Hindi, never both. Shop words: Sales/बिक्री,
    Purchases/ख़रीद, Dues/उधार, Profit/मुनाफ़ा, Cost of goods sold/बेचे माल
    की लागत (the catalogue's existing term), Expenses/खर्च, Personal
    expenses/निजी खर्च, Withdrawals/निकासी. Labour is "मज़दूरी" on Billing but
    "पल्लेदारी" on Finance today; the new pages use one word (Billing's
    "मज़दूरी", unless the owner prefers the other).
    "COGS", "accrual", "gross margin" never appear on screen; "margin" is
    "profit per ₹100 sold" / "₹100 की बिक्री पर मुनाफ़ा".

### 5.2 Money (💰 Money / हिसाब)

Route `money` with sections `money-profit` (default), `money-cash`,
`money-spending`, `money-worth`. Four segmented tabs that fit at 390 px.

| Section | Decision it supports | Contents | Takeaway pattern | Correctness proof |
|---|---|---|---|---|
| **Profit** (मुनाफ़ा) | Is the business doing better or worse; cut costs or change rates | Hero: Profit (M6) with both comparisons. "How we got here" ladder: Sales (M1) → − Cost of goods sold (M2) = Gross profit (M3) → − Business expenses (M4) − Bad debts (M5) = Profit (M6). Labour on purchases (M7) as a separate line under the ladder (not subtracted, owner decision pending). 13-month bar chart of M6 with last year as a faint line (M11). Stock movement line: opening + bought − cost of goods sold ± adjustments = closing (M17), collapsed. | "Profit ₹{p} in {month}, {▲/▼} {x}% vs {month} last year. Biggest change: {item} ({±₹})." · If M6 < 0: "Loss this month because {top reason}." | M1–M7, M11, M17 in `business-metrics.js`; oracle tests per ID; AC1, AC4, AC7, AC9; `audit:numbers` 0 unexplained |
| **Cash** (नकद) | Arrange cash for coming purchases; spot a cash drain | Hero: Net money in/out (M14) with comparisons. In (M12) / Out (M13), each split cash / online and by source (sales at save, dues received, purchases at save, dues paid, expenses). Daily bars for the month. Day row → **Cash drawer** for that day (C-IDs live there). | "{More/less} money came in than went out: {±₹}. Biggest outflow: {source}." | M12–M14; AC6, AC7 (same day = drawer); `complete` flag shows a caveat when cash sessions for the period weren't read |
| **Spending** (खर्च) | Cut an expense; control personal spending and withdrawals | Business expenses by category (M4) with comparisons; Personal expenses (M8); Withdrawals (M9); "Kept in business" = M6 − M8 − M9 (M10). "＋ Record withdrawal" bottom sheet (the old Withdrawals form) and the withdrawal list. | "Business expenses {▲/▼} {x}% vs last year, mostly {category}." · "You took out ₹{w}; ₹{k} of this month's profit stays in the business." | M4, M8–M10; oracle; AC4; expenses read via `utils/dates.js` only (#49) |
| **Worth** (कुल पूंजी) | How much can I safely take out; am I growing | Net worth (M15, #39 open) as one number with its terms: Stock value (link chip → Stock, S4), To receive (→ Outstanding, O4), To pay (→ Outstanding, O3), Cash in drawer at last count (→ Cash drawer), Other accounts (owner-entered: bank, lent, savings). Net worth at each month end (from snapshots) as a line chart. | "You are worth ₹{n}, {▲/▼} ₹{d} since {month} last year. ₹{r} of it is still with customers." | M15; AC5, AC11 (terms equal their homes); the terms are links, not copies (§6) |

Roles: the page needs permission `money` (replaces `finance`). Inside it,
`profit` gates Profit and M10, `stockValue` gates the stock term and M17,
`personalExpenses` gates M8–M10 and the withdrawal form. Defaults: owner all;
manager on; member off (as `finance` today).

Empty states: no sales in the period → "No sales in {month} yet. Profit shows
after the first sale." No last-year data → "No {month} {year−1} to compare;
comparisons start once a year of bills exists." No opening stock → amber chip,
not ₹0.

### 5.3 Insights (💡 Insights / कारोबार)

Route `insights` with sections `insights-actions` (default), `insights-items`,
`insights-parties`, `insights-seasons`. Inside Seasons, three sub-tabs:
**Calendar**, **Rate trends**, **Product traffic**.

| Section | Decision it supports | Contents | Takeaway pattern | Correctness proof |
|---|---|---|---|---|
| **Actions** (करना है) | What to do this week | Up to 6 cards, most urgent first, each with a button: (1) Overdue parties (count, oldest) → **Outstanding**, sorted by age; (2) Items sold below cost this period (I8) → item ledger; (3) Low-profit items (I7) → Items; (4) Items to stock up before the season (I9) → Rate trends for that item; (5) Dead stock (count) → **Stock › Not selling**; (6) Open anomalies (count) → **Anomalies**. Empty: "Nothing urgent this week ✓". | One sentence per card: "{n} parties owe ₹{x} for more than {d} days → Chase" · "{item} was sold below cost {k} times ({kg} kg) → Check rate" | I7–I9 here; counts owned by their homes are links. Oracle for I7–I9; AC9 |
| **Items** (माल) | Push or drop an item; fix a rate | Table: item, Sales ₹ (I1), Profit ₹ and "profit per ₹100" (I1), vs last year; toggle Retail / Wholesale / Both (I2). Retail vs wholesale split card. Row → item sheet: rate lines (embedded Rate trends for that item), item ledger link. kg moved lives in Product traffic, not here. | "{item} earned the most profit (₹{p}); {item2} sold a lot but earned only ₹{q} per ₹100." | I1, I2; Σ items = M1 and M3 (AC9); line amounts after labour share (#47) |
| **Parties** (पार्टी) | Thank or call a buyer; choose a supplier | Customers: sales ₹, bills, last bill date, vs last year; "stopped coming" flag (bought in each of the last 3 months last year, not in the last 60 days). Suppliers: purchases ₹, kg, labour, last bill. Party names merged case- and space-insensitively (UI-F16). Row → party ledger (Statements). Dues are a link chip → Outstanding. | "Top 5 customers gave {x}% of sales. {n} regular buyers haven't come for 60 days → See list." | I3, I4; Σ customers = M1, Σ suppliers = M16 (AC10) |
| **Seasons › Calendar** (मौसम) | Plan buying for the coming months | Heat map: items × 12 months, cell = kg sold that month vs the item's average month (season index I5), last 2 years. "Next 8 weeks" strip from RT5 (Rate trends' estimate). | "{item} usually sells {x}× more in {month}; you have {w} weeks of stock → Plan purchase." | I5 from `rateStats` months (RT4 kg); oracle on fixtures; no bill reads |
| **Seasons › Rate trends** | Set today's rates; judge a rate change | **The existing Rate trends view** (RT1–RT5), mounted here. | (the view's own) | RT1–RT5 unchanged; `tests/oracle/rate-trends.test.js` |
| **Seasons › Product traffic** | See what moved, by day/week | **The existing Product traffic view** (PT1–PT4), mounted here. | (the view's own) | PT1–PT4 unchanged |

**Trends and Product traffic in two places without duplication.** The owner
wants them in the Insights area and they also belong on Rates. Design:

- **One module, one view, two entry points.** `modules/rate-trends.js` gets a
  `mount(hostEl, { section, itemId, month })` API. The Rates page (routes
  `rates-trends`, `rates-traffic`) and Insights › Seasons (routes
  `insights-trends`, `insights-traffic`) both call it. The module is imported on
  first use (as today, lazy), its DOM is moved into the active host, so there is
  never a second copy of the code, the calculations or the DOM.
- **Single home rule:** RT*/PT* figures are owned by the `rate-trends` module
  (§6). Hosts may mount the module's view; they may not compute or render RT/PT
  figures themselves. The registry test enforces it.
- **Why keep both entry points:** on Rates the manager sets today's rate and
  needs the trend beside the rate list; in Insights the owner plans the season
  next to the Calendar heat map. Each entry point shows a small
  "Also in Rates" / "Also in Insights" link so the user learns it's the same view.

**Shared period and item picker (`insights-context.js`).**

- `AppState.insightsContext = { period: {from, to, preset}, itemId, partyKey }`,
  kept in `sessionStorage`; set by Money and Insights pickers, read by Statements
  defaults and by the hosted Rate trends / Product traffic.
- Money and Insights share the period: switching page keeps "Oct 2026".
- Product traffic's month = the selected month when the period is one month;
  for longer periods it uses the last month of the period.
- Rate trends keeps its own range buttons (12 / 26 / 52 / 104 weeks) because RT
  lines need weeks; the selected month is shaded on its chart.
- Item picker: tapping an item anywhere (Items row, Actions card, Calendar cell)
  sets `itemId`; Rate trends and Product traffic open on that item. Changing the
  item inside Rate trends writes back to the context.
- Route arguments go through `ui/navigation.js` (e.g.
  `showTab('insights-trends', { itemId })`), which also fixes back navigation for
  these screens (UI-F17).

Roles: permission `insights` (replaces `analytics`). Profit columns need
`profit`; purchase rates and supplier rates need `purchaseRates`; Rate trends and
Product traffic stay owner/manager (as today). Members: off by default.

### 5.4 Statements (🧾 Statements / बही-खाता)

Route `statements`; a list of five documents. Each opens a printable document
view with **Share on WhatsApp** (plain text summary + PDF via print),
**Print / Save PDF**, **CSV**.

| Statement | Decision it supports | Contents | Correctness proof |
|---|---|---|---|
| **Day book** (रोज़नामचा) | Check a past day; settle a dispute | Every bill, expense, due payment, withdrawal and drawer event of one day, in time order, with day totals. For today it links to Today instead of repeating it. | ST1 totals = T1–T16 for that day (AC7) |
| **Month statement** | Give the month to an accountant or partner | Money's Profit ladder, Cash in/out and Spending for one month as a document; the opening and closing stock line. | ST2 = M1–M17 for that month (AC4) |
| **Party ledger** (पार्टी खाता) | Settle with a farmer or buyer | Opening balance, every bill and payment with a running balance, closing balance; for one party and range. Includes opening records (old-app dues) as the opening balance. | ST3 closing = Outstanding O1/O2 for that party (AC5); payments once per id (DUE-PAY) |
| **Item ledger** (स्टॉक खाता) | Find why stock or cost looks wrong | Every purchase, sale and adjustment of one item with running kg and average cost; flags sales below cost and "sold before bought". | ST4 closing = S1/S2; replay = `stock-replay.js` (AC1, AC8) |
| **Export** | Back up or analyse in Excel | CSV of bills, lines, payments, expenses for a range; one row per line, labour per bill, plain ISO dates. | Σ CSV lines − labour = M1 / M16 (AC4) |

Roles: permission `statements` (replaces `reports`). A member with
`statements` sees ledgers and the day book without profit or cost columns unless
`profit` is on. Statements carry totals, but they are documents produced on
request, so the registry marks them `export` and they don't count as a second
home (§6).

### 5.5 Gut-check rules (C19)

The takeaway engine checks these before writing a sentence and explains the
surprise instead of hiding it:

| Surprise | Explanation shown |
|---|---|
| Profit down while sales are up | "Sales up {x}% but cost of goods rose more: {item} was bought dearer." |
| Profit higher than sales × the usual profit per ₹100 | "Cost not known for {kg} kg sold before it was bought; profit may be ₹{e} too high." |
| Loss on an item | "{item} sold below cost {k} times ({kg} kg)." |
| Stock value 0 or negative | "Opening stock not set for {n} items → Stock › Adjustment." |
| Cash flow far below profit | "₹{d} of this month's sales is still owed to you → Outstanding." |
| Expenses jump | "Expenses {▲} {x}% vs last year, mostly {category}." |
| Comparison month incomplete | "{month} last year is not loaded; compare after building month history." |

### 5.6 The 5-second test (C8)

| Screen | The one question | What answers it above the fold on a 390 × 844 phone |
|---|---|---|
| Money › Profit | Did I make money this month? | Hero profit + "▲ 12% vs Oct 2025" + takeaway |
| Money › Cash | Did more money come in than go out? | Net in/out hero + takeaway |
| Money › Spending | Where did the money go? | Top 3 expense categories bar + "Kept in business" |
| Money › Worth | What am I worth? | Net worth + change since last year |
| Insights › Actions | What must I do this week? | First 3 action cards |
| Insights › Items | Which items earn the most? | Top 5 items by profit |
| Insights › Parties | Who are my best customers? | Top 5 customers + "stopped coming" count |
| Seasons › Calendar | What's coming next? | "Next 8 weeks" strip |
| Statements | Which record do I need? | 5 big list rows |
| A statement | What is the balance? | Closing balance at the top, then the rows |

Each phase PR records the test: a screenshot at 390 × 844 with the answer
marked, in English and Hindi.


---

## 6. Single home for every figure

**Rule.** Each figure (spec ID) is rendered as a value by exactly one screen
section, its *home*. Any other screen may show it only as:

- a **link chip** (`To receive → Outstanding`), with no number, or with the
  number in the chip only when the chip's text names its home; or
- a **term inside a drill-down or a sum** whose label names the home
  (e.g. Net worth's terms), never as a headline card.

Statements are documents produced on request; their totals are computed by the
same layer and marked `export`, so they don't count as a second home.

| Figure | Spec ID | Home (the one place) | Linked from |
|---|---|---|---|
| Today's purchases, sales, labour, expenses, cash in/out, dues of today | T1–T16 | **Today** | Statements › Day book (today links to Today) |
| Sales in a period (₹, bills, retail/wholesale) | M1 | Money › Profit | Insights › Items (Σ check), Statements › Month |
| Cost of goods sold | M2 | Money › Profit | Item ledger |
| Gross profit, profit per ₹100 sold | M3 | Money › Profit | Insights › Items (per item = I1) |
| Business expenses (by category) | M4 | Money › Spending | Money › Profit (term in the ladder) |
| Bad debts written off | M5 | Money › Profit (ladder term) | Outstanding (write-off history) |
| **Profit** | M6 | Money › Profit | Insights (chip "Profit → Money"), Statements › Month |
| Labour on purchases | M7 | Money › Profit (separate line) | Parties › Suppliers (per supplier) |
| Personal expenses | M8 | Money › Spending | — |
| Withdrawals | M9 | Money › Spending | — |
| Kept in business | M10 | Money › Spending | Money › Worth (chip) |
| Profit by month, 13 months + last year | M11 | Money › Profit chart | — |
| Money in / out / net | M12–M14 | Money › Cash | Cash drawer (day row link) |
| Net worth | M15 | Money › Worth | — |
| Purchases in a period (₹, bills) | M16 | Money › Profit (stock movement line) | Insights › Parties › Suppliers (Σ check) |
| Stock movement check line | M17 | Money › Profit (collapsed) | Diagnostics › Number checks |
| Stock quantity, value per item, total | S1–S4 | **Stock** | Money › Worth (term), Item ledger |
| Dues per party, totals, ageing | O1–O4 | **Outstanding** | Money › Worth (terms), Insights › Actions (link), Party ledger closing |
| Cash drawer for a day | C1–C8 | **Cash drawer** | Money › Cash (day row), Money › Worth (last count term) |
| Rate lines, margin per kg, bought/sold kg, next weeks | RT1–RT5 | **Rate trends view** (module `rate-trends`) | Mounted on Rates and Insights › Seasons; Items row link |
| Product traffic | PT1–PT4 | **Product traffic view** (module `rate-trends`) | Mounted on Rates and Insights › Seasons |
| Item sales and profit | I1 | Insights › Items | Actions (I7) |
| Retail vs wholesale split | I2 | Insights › Items | — |
| Sales by customer | I3 | Insights › Parties | Party ledger |
| Purchases by supplier | I4 | Insights › Parties | Party ledger |
| Season index | I5 | Insights › Seasons › Calendar | Actions (I9) |
| Biggest driver of a change | I6 | (used inside takeaways only) | — |
| Low-profit items | I7 | Insights › Actions | Items (filter) |
| Sales below cost | I8 | Insights › Actions | Item ledger |
| Stock up before the season | I9 | Insights › Actions | Rate trends |
| Dead stock | (Stock › Not selling) | **Stock** | Actions (count link) |
| Anomalies | (Anomalies page) | **Anomalies** | Actions (count link) |

**Today keeps only today.** Today shows T1–T16 for the current day and nothing
period-based; the new pages never show a "today" headline. Today gets one chip:
`This month → Money`.

### 6.1 Guard: metric registry + Jest check

- `www/js/utils/metric-registry.js` (pure data):
  `{ M6: { home: 'money-profit', module: 'business-metrics', links: ['insights-*', 'statements-month'] }, … }`.
- Every element that renders a figure's **value** carries `data-metric="M6"`;
  a link chip carries `data-metric-ref="M6"`; a statement total carries
  `data-metric-export="M6"`.
- `tests/unit/metric-registry.test.js` scans `www/templates/*.html` and
  `www/js/modules/*.js` (string literals) and fails when:
  1. a `data-metric` ID appears on two different screens (template/route), or on
     a screen other than its registry `home`;
  2. a registry ID has no home element, or no entry in `docs/calculations.md`,
     or no oracle test name containing it;
  3. a `data-metric-ref` points to an unknown ID.
- In Phase 1 the old pages are allow-listed (they still duplicate); Phase 5
  removes the allow-list, so the guard is strict.

---

## 7. One calculation layer (`business-metrics.js`)

### 7.1 Shape

```
www/js/utils/business-metrics.js   pure; no DOM, no Firestore, no AppState
  periodRange(preset, now)          -> {from, to}                  (PERIOD, dates.js)
  comparisonRanges({from, to})      -> {previous, lastYear}        (CMP)
  activityBills(sources)            -> bills without opening/deleted/draft  (OPENING, PR #18)
  billCount(bills, range)           -> {retail, wholesale, purchases}       (BILL-COUNT)
  moneySummary(input, range)        -> M1..M17 (+ detail rows when asked)
  itemSummary(input, range)         -> I1, I2, I7, I8
  partySummary(input, range)        -> I3, I4
  seasonIndex(rateStatsMonths)      -> I5
  actions(input, range, context)    -> I7, I8, I9 (+ links for O/S/anomalies)
  reconcile(summary, homes)         -> AC5, AC9, AC10, AC11 results
www/js/utils/takeaways.js          pure; summary + comparisons -> [{key, params, link}]
www/js/utils/metric-registry.js    pure data (§6.1)
www/js/utils/month-snapshots.js    pure; build/merge/validate month snapshot docs (§7.6)
```

- Input is plain data: `{ purchases, wholesaleSales, retailSales,
  stockAdjustments, expenses, withdrawals, sessions, items, base, snapshots,
  rateStatsMonths }`. Modules pass `AppState` arrays in; tests pass fixtures.
- It reuses, not rewrites: `money.js` (`readPayment`, `round2`,
  `isOpeningRecord`/`activityBills` from PR #18), `stock-replay.js`,
  `finance-calc.js` (`stockMovement`, `computeFinanceSummary`, `profitByDay`
  become internal parts of `moneySummary`), `dates.js` (`parseAnyBillDate`,
  `parseLocalDate`, `toLocalISODate`), `aging.js`, `dead-stock.js`,
  `rate-trends.js` / `product-traffic.js` (RT/PT stay where they are).
- Every page module (Money, Insights, Statements, and in Phase 1 the old
  Finance/Reports/Analytics) calls these functions and only renders. No page
  module filters by date, sums totals or reads `payment.*` itself; review rule
  `no-page-math` (regex in `.github/review-rules.yml`) warns on
  `reduce(` + `total|grandTotal|payment` inside `www/js/modules/{money,insights,statements}.js`.

### 7.2 Building blocks (kept, plus four new)

Kept unchanged from `docs/calculations.md`: BILL-TOTAL, BILL-PAY, BILL-AT-SAVE,
BILL-DUE, DUE-PAY, EXP-KIND, DAY, PERIOD, AVG-COST, COGS.

| ID | Name | Definition |
|---|---|---|
| **BILL-TIME** | When a bill counts | The bill's stock time: numeric `timestamp`, else its date read by `dates.js` `parseAnyBillDate` (ISO, `DD/MM/YYYY`, `D/M/YYYY, h:mm:ss am`; all local IST). Expenses and withdrawals use the same parser on their `date`. **No other date parsing is allowed** (fixes #49, Reports' `new Date`). Sales and their cost always share a period. |
| **OPENING** | Opening records | Old-app dues written by `tools/migrate` (`openingBalance`, no lines). Left out of every period figure (sales, counts, cash, dues of the day); included in all-time dues (O*) and as the opening balance of a party ledger. Uses PR #18's `isOpeningRecord()`. |
| **BILL-COUNT** | Number of bills | Count of activity bills (not deleted, not drafts, not OPENING) whose BILL-TIME is in the period; each bill once whatever its lines; retail and wholesale counted separately and summed for "sales bills". The same count everywhere (fixes UI-F14). |
| **CMP** | Comparisons | For a period `[from, to)`: *previous* = the same length just before (for a calendar month: the previous calendar month up to the same day of month when the current month is not finished); *last year* = the same calendar dates one year earlier. % change = (now − then) ÷ \|then\| × 100, rounded; "—" when `then` = 0 or not loaded; "about the same" when \|change\| < 2%. |

### 7.3 Money metrics (M)

| ID | Name | Formula | Replaces (retired) |
|---|---|---|---|
| M1 | Sales | Σ BILL-TOTAL of activity wholesale + retail bills with BILL-TIME in the period; BILL-COUNT; split retail / wholesale; "of which still due" Σ BILL-DUE of those bills | F1, R2, A1 |
| M2 | Cost of goods sold | Σ COGS of the period's sale lines (AVG-COST replay from the month snapshot or checkpoint before `from`) | F2 |
| M3 | Gross profit | M1 − M2; profit per ₹100 sold = M3 ÷ M1 × 100 ("—" when M1 = 0 or M2 unknown) | — (new) |
| M4 | Business expenses | Σ expenses of kind business (EXP-KIND; untagged = business, #219), by category | F3, A3 |
| M5 | Bad debts | Σ dues to receive written off in the period, on the write-off date | part of F4 |
| M6 | **Profit** | M3 − M4 − M5 (owner decision #36; same as old F4). "—" with a caveat when M2 is unknown | F4, R3, A4 |
| M7 | Labour on purchases | Σ labour on the period's purchases; shown as its own line under M6, **not** subtracted (❓ open: labour in cost) | R8 (and T3 for periods) |
| M8 | Personal expenses | Σ expenses tagged personal | F5 |
| M9 | Withdrawals | Σ withdrawals dated in the period | F11 |
| M10 | Kept in business | M6 − M8 − M9 | "Profit left after personal expenses and withdrawals", "Available to withdraw" |
| M11 | Profit by month | M6 for each of the last 13 calendar months (current month to date) from month snapshots; last year's line from the same snapshots; by-day split for the selected month (sums to M6) | Finance monthly chart, A7 |
| M12 | Money in | BILL-AT-SAVE of the period's sales + DUE-PAYs received in the period; split cash / online | in-part of F7; R4/R5 retired (they added both directions) |
| M13 | Money out | BILL-AT-SAVE of the period's purchases + DUE-PAYs paid + all expenses; split cash / online (expenses cash until #117) | out-part of F7 |
| M14 | Net money in/out | M12 − M13 | F7 |
| M15 | Net worth | S4 + O4 + Other accounts + last counted drawer cash − O3 (❓ #39; each due counted once) | F12 |
| M16 | Purchases | Σ BILL-TOTAL (after labour) of activity purchases in the period; BILL-COUNT; line value before labour and M7 shown as its two parts | R1, A2 |
| M17 | Stock movement check | opening stock value + purchases at line rate − M2 ± adjustments = closing; gap shown per item with the plain reason "sold before it was bought" | F8 |

### 7.4 Insights metrics (I)

| ID | Name | Formula |
|---|---|---|
| I1 | Item sales and profit | Per catalogue item (id, else English/Hindi name, trimmed, any case): Σ sale line totals in the period, Σ their COGS (from M2 detail rows), profit = sales − COGS, profit per ₹100. Σ over items = M1 (sale line totals = bill totals for sales; NA found 0 bills where they differ by more than ₹1, and any bill-level difference is shown as a "Bill adjustments" row) and Σ COGS = M2 (AC9). |
| I2 | Retail vs wholesale | I1 split by bill type; Σ = M1. |
| I3 | Sales by customer | Per party key (name trimmed, case-folded, single spaces; walk-in grouped): Σ BILL-TOTAL, BILL-COUNT, last BILL-TIME; "stopped coming" = bought in ≥ 3 of the same 3 calendar months last year and no bill in the last 60 days. Σ = M1 (AC10). |
| I4 | Purchases by supplier | Same keys for purchases: Σ BILL-TOTAL (after labour), Σ line value, Σ labour, kg, last bill. Σ BILL-TOTAL = M16 (AC10). Item-level purchase amounts are line value **and** labour share (labour × line value ÷ Σ line value), so item rows add up to M16 (fixes #47). |
| I5 | Season index | For an item and a calendar month: kg sold in that month (RT4 from `rateStats` months) ÷ the item's average monthly kg over the same years; ≥ 1.5 "busy", ≤ 0.5 "quiet"; needs ≥ 12 months of data. |
| I6 | Driver of a change | For M1 or M6 vs a comparison period: the item (or expense category) with the largest absolute contribution to the change; used only inside takeaway sentences. |
| I7 | Low-profit items | Items with sales ≥ ₹ floor (default ₹5,000 in the period) and profit per ₹100 < threshold (default 3) or < 0. |
| I8 | Sales below cost | Sale lines whose rate < AVG-COST at the moment of sale (kg, ₹ lost, count), per item. |
| I9 | Stock up before the season | Items whose RT5 estimate is UP or whose next-8-weeks season index ≥ 1.5, and whose stock cover (S1 ÷ average weekly kg sold over the last 8 weeks) < weeks to the busy month. |

### 7.5 Statement totals (ST, export only)

ST1 Day book totals (= T1–T16 for that day), ST2 Month statement (= M1–M17 for
that month), ST3 Party ledger closing (= O1/O2 for that party), ST4 Item ledger
closing (= S1/S2), ST5 CSV sums (= M1, M16).

### 7.6 Month snapshots (`monthStats/{YYYY-MM}`)

Needed for "vs same month last year" and the 13-month chart without loading
two years of bills on open.

- **Contents** (one small doc per month, a few KB): M1–M17 values and counts,
  I1 per item (sales, COGS), I3/I4 top 50 parties, expense categories, and
  `closing: { itemId: { qty, value } }`, the stock state at month end, which is
  also the replay base for the next month (it replaces the "load full history"
  prompt for any month after the first snapshot).
- **Build:** owner-only "Build month history" button on Money (like the
  `rateStats` backfill): reads the full history once (~7k bill reads, resumable,
  daily budget guarded by `quota-guard.js`), writes 1 doc per month.
- **Roll:** on open, the current and previous month are recomputed from the
  loaded window (no extra bill reads) and written when they changed, at most every
  6 hours (≤ 2 writes).
- **Staleness:** saving, editing or deleting a bill, stock adjustment, expense or
  withdrawal dated before the current month marks its month `stale: true` (and,
  when its stock changed, every later month through the previous one): one merge
  write per month, after the record write, by any approved user. A stale month
  shows "not known" in comparisons and a "Build month history" hint, and is
  rebuilt with no bill reads by an owner/manager device that has all bills loaded
  (read after it saw the mark), in a transaction that keeps a newer mark
  (docs/calculations.md, "Stale month snapshots").
- **Rules:** new collection through `FirebaseService` (`getCollection`), read by
  `money`/`insights` holders, written by owner/manager; `rules-tests` cases added.
- **Checks:** AC12 (snapshot of a closed month = live recompute from the same
  bills; Σ months = all time).

### 7.7 Accounting checks

AC1–AC8 stay. New:

| ID | Check |
|---|---|
| AC9 | Σ I1 over items = M1 and Σ item COGS = M2 for any period. |
| AC10 | Σ I3 = M1; Σ I4 = M16. |
| AC11 | Money › Worth terms equal their homes: stock term = S4, receivable = O4, payable = O3, drawer = last C8 count. |
| AC12 | Month snapshot = live recompute for closed months; Σ months = all time (extends AC4). |
| AC13 | Single home: no figure rendered as a value by two screens (registry test, §6.1). |
| AC14 | BILL-COUNT is identical on Money, Insights, Statements and History for the same period. |

Every page shows its relevant checks in the checks line (§5.1-9); Diagnostics ›
Number checks runs them all.

### 7.8 Retired spec IDs

| Retired | Now | Note |
|---|---|---|
| F1 | M1 | |
| F2 | M2 | |
| F3 | M4 | |
| F4 | M6 | definition unchanged (#36, #215) |
| F5 | M8 | |
| F6 | S4 | stock value has one home: Stock |
| F7 | M14 (M12, M13) | |
| F8 | M17 | |
| F9 | O4 | one home: Outstanding (needs #130: wholesale dues in Outstanding) |
| F10 | O3 | |
| F11 | M9 | |
| F12 | M15 | #39 |
| R1 | M16 | |
| R2 | M1 | count per BILL-COUNT |
| R3 | M6 | |
| R4, R5 | — | retired: added money in and out together; replaced by M12/M13 split |
| R6 | O3 | |
| R7 | O4 | |
| R8 | M7 | |
| A1 | M1 | #49 fixed by BILL-TIME |
| A2 | M16 | |
| A3 | M4 | #49 |
| A4 | M6 | |
| A5 | O3 | #220 fixed by BILL-DUE |
| A6 | O4 | #220 |
| A7 | M11 (by day) | |

T*, O*, S*, C*, RT*, PT*, AC1–AC8 and the building blocks stay. The retired IDs
remain listed (struck through, "→ M6") in `docs/calculations.md` for one release
so old issues and audit reports still resolve.

### 7.9 How the known bugs are fixed

| Bug | Root cause | Fixed by |
|---|---|---|
| #49 / A3 (expense dates) | `analytics.js:parseDate` = `new Date(text)` | BILL-TIME: one parser (`dates.js`) for bills, expenses, withdrawals; review rule blocks `new Date(<field>.date)` in modules |
| #220 / A5, A6 (cleared bills counted) | `due || payment.due`, ignores `cleared` | Dues only via BILL-DUE (`money.js`); Insights shows dues only as Outstanding links |
| #47 (purchases before labour) | item rows sum line totals; totals use BILL-TOTAL after labour | I4 labour share; M16 shows line value and labour as parts |
| UI-F14 (bill counts differ) | three filters, opening records, date vs timestamp | BILL-COUNT + BILL-TIME + OPENING, AC14 |
| Opening records in period figures | filters by date only | OPENING (PR #18's rule, reused) |
| "100% margin" without caveat | margin shown where uncosted warning isn't | caveat chips travel with M3/M6 wherever a takeaway uses them |


---

## 8. Wireframes

Phone = 390 px wide (the audit's size). Desktop = ≥ 1024 px (rules only in
`css/desktop.css`). English shown; Hindi uses the same layout with Hindi words
only. Numbers are illustrative.

### 8.1 Side menu

```
 Business                         व्यापार (Hindi mode)
  💰 Money                         💰 हिसाब
  💡 Insights                      💡 कारोबार
  🧾 Statements                    🧾 बही-खाता
  📈 Rates (Rates · Trends · Traffic)
```

### 8.2 Money (phone)

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ ☰  Money                      🔔 │   │ ☰  Money                      🔔 │
│ [Profit][Cash][Spending][Worth]  │   │ [Profit][Cash][Spending][Worth]  │
│ ‹   October 2026 (to 26th)   ›  ▾│   │ ‹   October 2026 (to 26th)   ›  ▾│
├──────────────────────────────────┤   ├──────────────────────────────────┤
│ PROFIT                           │   │ NET MONEY IN                     │
│ ₹ 48,200                         │   │ − ₹ 12,400  (more went out)      │
│ ▲ 12% vs Sep · ▼ 3% vs Oct 2025  │   │ ▼ vs Sep · ▲ vs Oct 2025         │
│ "Profit ₹48,200, 3% below Oct    │   │ "Biggest outflow: purchases paid │
│  last year. Biggest change:      │   │  in cash (₹1.9 lakh)."           │
│  <item> (−₹6,100)."  [See items] │   │ In  ₹4,10,600                    │
│ ⚠ Cost not known for 12 kg  ›    │   │   cash 3,20,600 · online 90,000  │
├──────────────────────────────────┤   │ Out ₹4,23,000                    │
│ How we got here                  │   │   cash 3,63,000 · online 60,000  │
│ Sales               ₹ 6,20,000 › │   │ ▁▃▅▂▇▃▁▅▆▂ daily: tap a day →    │
│ − Cost of goods sold ₹ 5,40,300 ›│   │   Cash drawer for that day       │
│ = Gross profit       ₹   79,700 ›│   │ ✓ Matches Cash drawer            │
│ − Business expenses  ₹   30,000 ›│   └──────────────────────────────────┘
│ − Bad debts          ₹    1,500 ›│      Money › Cash
│ = Profit             ₹   48,200 ›│
│ Labour on purchases  ₹    4,800 ›│   ┌──────────────────────────────────┐
│ (not in cost yet: owner decides) │   │ BUSINESS EXPENSES  ₹ 30,000      │
├──────────────────────────────────┤   │ ▲ 8% vs Oct 2025, mostly rent    │
│ Profit by month  ▇▅▆▃▅▇▆▅▄▆▇▅▆  │   │ Rent       ██████████  12,000 ›  │
│ ┄┄ last year                     │   │ Transport  ██████       7,500 ›  │
├──────────────────────────────────┤   │ Wages      █████        6,300 ›  │
│ ▸ Stock movement (check line)    │   │ Others     ████         4,200 ›  │
│ ✓ Matches Stock and Outstanding  │   ├──────────────────────────────────┤
└──────────────────────────────────┘   │ Personal expenses     ₹ 9,000 ›  │
   Money › Profit                      │ Withdrawals           ₹ 20,000 › │
                                       │ Kept in business      ₹ 19,200 › │
                                       │ [ ＋ Record withdrawal ]         │
┌──────────────────────────────────┐   └──────────────────────────────────┘
│ NET WORTH          ₹ 64.3 L      │      Money › Spending
│ ▲ ₹5.1 L since Oct 2025          │
│ "₹6.1 L of it is still with      │   ┌──────────────────────────────────┐
│  customers." [Open Outstanding]  │   │ Sales                 ₹ 6,20,000 │
│ Stock value      → Stock      ›  │   │ 23 bills · 14 retail, 9 wholesale│
│ To receive       → Outstanding › │   │ ─────────────────────────────────│
│ To pay           → Outstanding › │   │ 26 Oct  R-0412  <party>  ₹ 1,200 │
│ Drawer (last count) → Cash    ›  │   │ 25 Oct  W-0098  <party>  ₹42,000 │
│ Bank, lent, savings  ₹ 3.0 L  ›  │   │ …  [Group: item ▾] [Search]      │
│ ▁▂▃▃▄▅▅▆▆▇ month-end worth       │   │ Tap a row → the bill in History  │
└──────────────────────────────────┘   └──────────────────────────────────┘
   Money › Worth                          Breakdown sheet (any number)
```

Each link row (`→ Stock`) shows the term's value inside the Net worth sum, with
its home named, and opens the home on tap (§6 rule).

### 8.3 Money (desktop ≥ 1024 px)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Money      [Profit][Cash][Spending][Worth]          ‹ October 2026 (to 26th) › ▾  │
├───────────────────────────────┬───────────────────────────────┬───────────────────┤
│ PROFIT ₹48,200                │ How we got here               │ Profit by month   │
│ ▲12% vs Sep · ▼3% vs Oct 2025 │ Sales            ₹6,20,000 ›  │ ▇▅▆▃▅▇▆▅▄▆▇▅▆     │
│ takeaway sentence  [See items]│ − Cost of goods  ₹5,40,300 ›  │ ┄┄ last year      │
│ ⚠ Cost not known for 12 kg ›  │ = Gross profit   ₹  79,700 ›  │                   │
│                               │ − Expenses       ₹  30,000 ›  │ ▸ Stock movement  │
│                               │ − Bad debts      ₹   1,500 ›  │                   │
│                               │ = Profit         ₹  48,200 ›  │                   │
│                               │ Labour (note)    ₹   4,800 ›  │                   │
├───────────────────────────────┴───────────────────────────────┴───────────────────┤
│ Breakdown opens as a right-side panel (not a full-screen sheet) · ✓ checks line   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 8.4 Insights (phone)

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ ☰  Insights                   🔔 │   │ ☰  Insights                   🔔 │
│ [Actions][Items][Parties][Seasons]│  │ [Actions][Items][Parties][Seasons]│
│ ‹   October 2026 (to 26th)   ›  ▾│   │ ‹   October 2026 (to 26th)   ›  ▾│
├──────────────────────────────────┤   │ [Retail][Wholesale][Both]        │
│ THIS WEEK                        │   ├──────────────────────────────────┤
│ ⏰ 4 parties owe ₹2.3 L for over │   │ "<item> earned the most profit;  │
│    30 days    [Open Outstanding] │   │  <item2> sold a lot but earned   │
│ 📉 <item> sold below cost 3 times│   │  ₹1 per ₹100."                   │
│    (40 kg)    [Item ledger]      │   │ Item     Sales  Profit ₹/100 vsLY│
│ 🌾 Stock up <item>: busy month in│   │ <item>   1.9L   21k    11   ▲ 8% │
│    5 weeks, 2 weeks of stock     │   │ <item>   1.2L   1.2k    1   ▼ 4% │
│               [Rate trends]      │   │ <item>   0.8L   9k     11   ▲30% │
│ 💤 6 items not sold in 30 days   │   │ … tap a row → item sheet:        │
│               [Stock › Not sell.]│   │   rate lines (Rate trends view), │
│ ⚠ 2 open anomalies [Anomalies]   │   │   item ledger, kg → Traffic      │
├──────────────────────────────────┤   ├──────────────────────────────────┤
│ Profit → Money ›                 │   │ ✓ Items add up to Money's sales  │
└──────────────────────────────────┘   └──────────────────────────────────┘
   Insights › Actions                     Insights › Items

┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ [Customers][Suppliers]           │   │ [Calendar][Rate trends][Traffic] │
│ "Top 5 customers gave 61% of     │   │ "<item> usually sells 2× more in │
│  sales. 3 regular buyers haven't │   │  Dec; you have 2 weeks of stock."│
│  come for 60 days." [See list]   │   │ Next 8 weeks: <item> ▲ <item> ▼  │
│ Party      Sales  Bills  Last    │   │        J F M A M J J A S O N D   │
│ <party>    1.1L   12     24 Oct  │   │ <item> ░ ░ ▒ ▓ █ ▓ ▒ ░ ░ ░ ▒ ▓   │
│ <party>    0.7L    5     02 Sep ⚠│   │ <item> █ ▓ ▒ ░ ░ ░ ░ ▒ ▓ █ █ █   │
│ … row → Party ledger             │   │ <item> ▒ ▒ ▒ ▒ ▓ █ ▓ ▒ ▒ ▒ ▒ ▒   │
│ Dues → Outstanding ›             │   │ tap a cell → Traffic, that month │
├──────────────────────────────────┤   │ (2 years of rateStats, no bills) │
│ ✓ Parties add up to Money's sales│   └──────────────────────────────────┘
└──────────────────────────────────┘      Insights › Seasons › Calendar
   Insights › Parties

┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ [Calendar][Rate trends][Traffic] │   │ [Calendar][Rate trends][Traffic] │
│ Item: <item> ▾  (shared picker)  │   │ Month: Oct 2026 (from the period)│
│ [12w][26w][52w][104w]            │   │ Item: <item> ▾ (shared picker)   │
│ ₹/kg ─ purchase ┄ sale ··· bills │   │ Item     Bought  Sold   vs LY    │
│      ╱╲__╱‾‾╲_╱‾  Oct shaded     │   │ <item>   9.2t    8.8t   ▲ 12%    │
│ Margin per kg · Next weeks ▲     │   │ … (the existing Product traffic  │
│ (the existing Rate trends view,  │   │  view, mounted here)             │
│  mounted here) Also in Rates ›   │   │ Also in Rates ›                  │
└──────────────────────────────────┘   └──────────────────────────────────┘
   Seasons › Rate trends                  Seasons › Product traffic
```

### 8.5 Insights (desktop)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Insights   [Actions][Items][Parties][Seasons]         ‹ October 2026 (to 26th) › ▾│
├──────────────────────────┬────────────────────────────────────────────────────────┤
│ THIS WEEK (actions)      │ Items  [Retail][Wholesale][Both]   takeaway sentence    │
│ ⏰ 4 parties overdue   › │ Item      Sales   Profit  ₹/100  vs Sep  vs Oct 2025    │
│ 📉 sold below cost     › │ <item>    1.9L    21k     11     ▲ 5%    ▲ 8%           │
│ 🌾 stock up <item>     › │ …                                                       │
│ 💤 6 not selling       › │ Selected item → right panel: Rate trends view (same    │
│ ⚠ 2 anomalies          › │ module) + item ledger link                             │
└──────────────────────────┴────────────────────────────────────────────────────────┘
```

### 8.6 Statements (phone)

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│ ☰  Statements                 🔔 │   │ ‹ Party ledger                   │
├──────────────────────────────────┤   │ <party> ▾        Apr–Oct 2026 ▾  │
│ 📅 Day book            any day ›│   ├──────────────────────────────────┤
│ 🗓 Month statement   any month ›│   │ BALANCE  ₹ 42,300 to receive     │
│ 👤 Party ledger      any party ›│   │ (matches Outstanding ✓)          │
│ 📦 Item ledger        any item ›│   ├──────────────────────────────────┤
│ ⬇ Export CSV          a range ›│   │ Date    Bill/Payment   ±     Bal.│
├──────────────────────────────────┤   │ 01 Apr  Opening            12,000│
│ Recent: Party ledger <party>     │   │ 03 Apr  S-0101  +8,400     20,400│
│         Month statement Sep 2026 │   │ 10 Apr  Paid    −5,000     15,400│
└──────────────────────────────────┘   │ …                                │
   Statements                          │ [WhatsApp] [Print/PDF] [CSV]     │
                                       └──────────────────────────────────┘
┌──────────────────────────────────┐      A statement (party ledger)
│ ‹ Day book      ‹ 21 Oct 2026 ›  │
│ Bills 14 · Expenses 6 · Pay 3    │   ┌──────────────────────────────────┐
│ 09:12 Purchase P-0311 <party>  … │   │ ‹ Item ledger   <item> ▾  Oct ▾  │
│ 10:30 Retail   R-0402 <party>  … │   │ Closing 63 kg @ ₹31.10 = ₹1,959  │
│ 11:05 Expense  rent            … │   │ Date   Record     kg   avg cost  │
│ 18:40 Drawer closed: short ₹20 › │   │ 21 Oct Purchase  +40   31.10     │
│ Totals (for 21 Oct)              │   │ 21 Oct Retail    −10   31.10     │
│ [WhatsApp] [Print/PDF] [CSV]     │   │ ⚠ sold below cost / before bought│
└──────────────────────────────────┘   └──────────────────────────────────┘
   Day book (today → links to Today)      Item ledger
```

### 8.7 Statements (desktop)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Statements                                                                        │
├────────────────────┬──────────────────────────────────────────────────────────────┤
│ 📅 Day book        │ Party ledger · <party> · Apr–Oct 2026     [WhatsApp][PDF][CSV]│
│ 🗓 Month statement │ Balance ₹42,300 to receive ✓ matches Outstanding             │
│ 👤 Party ledger  ● │ Date     Bill / payment      Debit    Credit    Balance      │
│ 📦 Item ledger     │ …                                                            │
│ ⬇ Export CSV      │ Print layout = A4, one language, shop name and date on top   │
└────────────────────┴──────────────────────────────────────────────────────────────┘
```

---

## 9. Performance and read budget

Principles: reuse the history window already loaded at start (bills from the
1st of the previous month, kept live by listeners), the month snapshots and the
monthly/weekly `rateStats`; never scan the full history on open.

| Page view | Data | Reads, first open of the day | Reads, repeat open |
|---|---|---|---|
| Money, current or previous month | window (0) + cash sessions for the month (≤ 31, cached 10 min, as Finance today) + `monthStats` (≤ 25, settled months cached in `localStorage`) | ≤ ~56 | ≤ ~5 (current/previous month snapshot) |
| Money, an older month | its snapshot (cached) + its cash sessions (≤ 31) | ≤ 31 | 0–2 |
| Insights › Actions/Items/Parties | window + `monthStats` (shared with Money) | 0–25 | 0–2 |
| Insights › Seasons › Calendar | `rateStats` year docs: current year (≤ 1 per item, ~45, 6 h roll) + last year (settled, cached) | ≤ ~90 | ≤ 5 |
| Seasons › Rate trends / Traffic | unchanged module (UI audit: Traffic ~88 per open; cached years) | as today | as today |
| Statements inside the window | window | 0 | 0 |
| Statements outside the window | one range query (day/month) or one party query (`party` + date index, 200 per page, "Load more") | ≤ bills in range | cached for the session |
| Build month history (owner, once) | full history, resumable, budget-guarded | ~7.2k once | — |

Daily estimate for a busy owner (Money and Insights 10× each, 3 statements):
≈ 300 reads/day on top of today's app start (~75 per login): ≈ 1% of the Spark
limit. Phase PRs measure it with the app's read meter.

Render rules: compute per (period, data version) once, memoised
(`render-memo.js`); charts are inline SVG (no chart library); the breakdown
sheet pages 50 rows; first paint < 1.5 s on the audit phone profile.

---

## 10. Migration plan

Each phase is one PR with tests; `npm test`, lint, `check:review`, `check:sw`,
`check:release` green; a cache bump whenever `www/` changes; and
`npm run audit:numbers` (from PR #20) on a real backup with **0 unexplained
mismatches** reported in the PR body (counts only). Depends on PR #18 (opening
rule) and PR #20 (audit tool) being merged first.

| Phase | PR | Contents | Tests | Effort |
|---|---|---|---|---|
| 1 | `[Refactor] One calculation layer for money and insight figures` | `business-metrics.js`, `takeaways.js`, `metric-registry.js` (old pages allow-listed); BILL-TIME, BILL-COUNT, OPENING, CMP; M*, I* formulas; old Finance/Reports/Analytics re-pointed to the layer (no layout change) so **#49, #220, #47 and UI-F14 are fixed on the live pages now**; `docs/calculations.md` rewritten with new IDs and the retired table | oracle per M*/I* ID in `tests/oracle/`; AC9–AC14 in `tests/property/`; fixtures for DD/MM expenses, cleared bills with old dues, labour shares, opening records; registry test; remove the fixed entries from `BUGS` | **L** |
| 2 | `[Feature] Money page (behind the new-pages switch)` | Money (4 sections), period picker + `insights-context.js`, generalised breakdown sheet, caveat chips, checks line, `monthStats` (build, roll, stale) + `firestore.rules` + rules tests, owner switch `settings/app.newPages` (Settings → "Try the new Money, Insights and Statements pages"); new nav entries shown only when on; i18n keys in both catalogues | oracle for M11 from snapshots; AC12; rules tests; jsdom render tests (one figure per `data-metric`); 5-second-test screenshots EN/HI phone + desktop | **L** |
| 3 | `[Feature] Insights page with Rate trends and Product traffic` | Actions, Items, Parties, Seasons (Calendar + mounted Rate trends / Product traffic via `RateTrendsManager.mount`), shared item picker, party-key merge (UI-F16), routes `insights-*` | I-ID oracles; AC9, AC10; `rate-trends.test.js` unchanged and passing; mount test (one DOM instance across Rates and Insights) | **L** |
| 4 | `[Feature] Statements: day book, month statement, ledgers, exports` | Five statements; print CSS (A4, one language); WhatsApp share text; CSV writer (plain ISO dates, labour per bill); party query with index (`firestore.indexes.json`) | ST totals = homes (AC4, AC5, AC7); CSV round-trip test; i18n guard | **M** |
| 5 | `[Refactor] Remove Finance, Reports and Analytics` | Delete old templates/modules/CSS/i18n keys; side menu: Money, Insights, Statements; redirects `finance*` → `money*`, `reports*` → `statements`, `analytics*` → `insights*` (and deep links from notifications, shortcuts `Alt+n`); permission migration (`money ?? finance`, `insights ?? analytics`, `statements ?? reports`) in `role-access.js` + `role-permissions.md`; remove the switch; registry strict; `STATIC_ASSETS` updated; Today chip "This month → Money" | registry strict (AC13); navigation redirect tests; role-access tests; `check:sw`; e2e smoke on the three pages | **M** |

Rollback: until Phase 5, turning the switch off restores the old pages; after
Phase 5, revert the PR (old pages come back with the Phase 1 layer underneath).

---

## 11. Open questions for the owner

| # | Question | Recommended default (used until answered) |
|---|---|---|
| 1 | **#43:** "This month" = calendar month (1st to today) or the last 30 days? | **Calendar month**, compared with the same days of the previous month and of the same month last year. "Last 30 days" stays available in the period menu, labelled so. |
| 2 | **Labour in the cost of goods sold:** should labour on purchases raise the cost of the stock (and lower profit)? | **Not in cost for now**: show "Labour on purchases" as its own line under Profit with a note, so the owner sees it every month and can decide with numbers in front of him. |
| 3 | **#39 Net worth:** what counts? | Stock value + to receive + bank/lent/savings (owner-entered) + cash in the drawer at the last count − to pay. Each due counted once. |
| 4 | **"This year":** calendar year (Jan–Dec) or financial year (Apr–Mar)? | **Calendar year** (matches PERIOD today); the financial year can be added to the period menu later. |
| 5 | **Action thresholds:** when is a party "overdue", an item "low profit", a buyer "stopped coming"? | Overdue: **30 days**; low profit: **under ₹3 per ₹100** of sales (and sales ≥ ₹5,000 in the period); stopped coming: regular last year, **no bill for 60 days**. Editable later in Settings. |
