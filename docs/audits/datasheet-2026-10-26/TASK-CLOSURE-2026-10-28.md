# LP-A00–LP-A19: criteria, evidence and remaining work

## Criterion-level correction after owner challenge

Earlier blanket completeness statements below are qualified: broad regression PASS does not independently establish every original acceptance criterion. Current work reopens explicit missing evidence for A03(cancel/create both orders,8contract retries), A06(re-evaluate/award and disqualify/award both orders) and A11(existing catalog blocked-order plus accepted-obligation completion). Dedicated actual HTTP/PostgreSQL tests are implemented, hosted acceptance pending. This does not claim a new product defect or erase earlier passing scenarios. External SMTP/Meta is not presented as the only possible unfinished work.

Owner correction: focus on these original20 tasks. No optional release-engineering,
license issuance or duplicate backup project is included. Original criteria remain
in TASKS.md. PASS below means isolated technical acceptance, not live production.

Accepted baseline: main0a27fb026618422f852a857bd9ee39e23a441bd2,
[run40666138522](https://github.com/rashadoni/leadprocure/actions/runs/40666138522),
both jobs SUCCESS:25 suites/283 API,3 contention,10 native browser,1 fresh HTTPS;
build/schema validation/both migration histories/restore PASS. No completed gate
is rerun without a material change. Candidate7f521313507dd72551d3a15b2ede50896f4d4165 subsequently passed run40698739534:285API/3contention/13native browser/1fresh HTTPS. Independent PPTX run40698739541 PASS for15 pages,100% text coverage; changed slide11/data sheet1–2 visually inspected. This closes the new technical gaps, not external delivery or production acceptance.

| Task | Technical evidence in repository | Current disposition |
|---|---|---|
| A00 isolated acceptance | scripts/acceptance/assert-isolated.cjs; .github/workflows/acceptance.yml; dual-history upgrade and backup-restore scripts | Baseline PASS; only disposable fixtures used |
| A01 files | audit-regressions, clamav, verification, rls-acl API suites | Baseline PASS: foreign grants/namespace, immutable snapshots, real clean/EICAR. Earlier read-only runtime namespace mismatches0; no automatic deletion |
| A02 quantities/concurrency | audit-regressions, invoices, amendments; procurement.stress-spec | Baseline PASS: duplicate lines, aggregate billing, contended invoices/GRN, shared order locks |
| A03 lot boundaries | multilot, integrity; evaluation browser scenario | Baseline PASS: lot-scoped contract/PO/catalog, cancelled award rejected, per-award UI |
| A04 auction downstream | auction-flow; procurement.stress-spec | Baseline PASS: accepted tick lines through contract/order/receipt/invoice; idempotency |
| A05 auction winner | auction-flow; sourcing service guards | Baseline PASS: server-best eligible bid/lot, deterministic price order; client cannot override |
| A06 complete evaluation | integrity, audit-regressions; evaluation browser scenario | Baseline PASS: locked criteria, complete unique scores/current evaluation, event serialization |
| A07 evaluation UI | apps/web/tests/evaluation.spec.ts | Baseline PASS: custom criteria/re-evaluation show current result |
| A08 currency/volume | audit-regressions, multilot; common/procurement/invariants.ts | Baseline PASS: reject unsupported mixed currency, lot-equivalent comparison, safe money bounds. Automatic FX is not claimed |
| A09 VAT | audit-regressions; invoices tax snapshots | Baseline inclusive18/zero/exclusive arithmetic PASS. Current candidate adds real mixed0/18 invoice chains for BOTH modes; hosted PASS. Historical invoices are not recalculated |
| A10 UBL | scripts/acceptance/validate_exports.py; audit-regressions exports | Baseline two exports pass official UBL2.1 XSD. Current candidate requires four including mixed-rate modes; hosted PASS. Peppol network not claimed |
| A11 blocked supplier | audit-regressions; assertSupplierAllowed shared guard | Baseline PASS: new procurement denied while existing obligations continue |
| A12 AI edge values | audit-regressions; common/ai response validation/fallback | Baseline PASS: finite scores/zero price/same-day delivery/lot/currency and AZ explanation; external live LLM NOT RUN |
| A13 financial analytics | analytics, budgets, budget-integration; language/finance browser scenarios | Baseline API/net/currency/active awards/budget controls PASS. Current candidate fixes stale filter response and31st-day month overflow; three new native scenarios PASS |
| A14 OCDS | audit-regressions; validate_exports canonical1.1.5 | Baseline PASS: cancelled/re-award values/party/status, pre-opening restrictions. Downstream consumer NOT RUN |
| A15 UPDATE RETURNING | audit-regressions, followups, budget-integration; returnedRows helper | Baseline PostgreSQL/TypeORM PASS including stop/audit IDs and missing membership |
| A16 license lifecycle | audit-license; fresh-install signed file scenario | Baseline real signature/controlled clock/grace/restriction/renewal PASS. Installing an operator license is not an unfinished code feature |
| A17 truthful delivery | followups, mail, audit-webhook; durable outbox | Baseline states/recovery/reconcile/HMAC PASS. Owner confirmed SMTP/Meta connections absent: actual delivery explicitly NOT RUN, not simulated PASS |
| A18 deadlines | audit-regressions, auction-flow, procurement.stress-spec | Baseline PASS: server time/late withdraw/close serialization, no late accepted bids. Rejected transaction attempts are not falsely claimed as committed domain audit |
| A19 combined acceptance/materials | full hosted gate; render-presentations; v3 content/PPTX/PDF/notes; CLAIMS.md | Baseline gates PASS. Current candidate synchronizes obsolete budget policy/finance role in all formats and fixes current claims; changed PPTX independent render PASS; changed pages visually reviewed |

Current implementation order: LP-A13 correction and browser checks → mixed VAT
criteria A09/A10 → synchronize A19 materials/claims → independent review plus
hosted regression/render → report actual outcomes for all20. Do not turn external
dependencies into new unsanctioned features. Owner merge approval is separate once
new visible changes are concrete and reviewed; deployment is outside this phase.


Completed candidate: LP-A09/A10 mixed-rate exports, A13 filter/date/retry and A19 material synchronization PASS. PR11 merged by explicit owner approval; exact main e3e5dbcdcd39dbea67fe0ef3953dfc97b65ddb44 passed run40700763083. The reviewed and merged trees are identical(4ade0fb97e8fbcb53322691994c63d53d5c70db2). SMTP/Meta live delivery remains explicitly NOT RUN because no connections exist; external LLM, actual client rollout and desktop Microsoft PowerPoint remain outside verified scope. No optional release work is being substituted for these task criteria.


## Final merged-main outcome

PR11 MERGED. Run40700763083: both jobs SUCCESS,285API/3contention/13native browser/1freshHTTPS,4UBL/OCDS/both migrations/build/restore PASS. The changed material files have the exact same hashes as independently rendered15pages; no redundant render was run. All20 technical-task evidence rows are now reconciled; external delivery/client/production limits above remain explicit. See ORIGINAL-TASKS-MAIN-ACCEPTANCE-2026-10-28.json. Next original-task action is actual A17/A19 external delivery acceptance when test connections/recipients exist, not an unrelated release project.


## Explicit criteria verified after correction

Candidatece090a1 / PR12, run40706846700 BOTH jobs PASS:26suites/293API,3contention,13native browser/1freshHTTPS, build/schemas/both migrations/restore/fresh signedlicense/private storage/real AV. Seven new queued decision tests prove A03 retries/cancel-create and A06 re-evaluate/award/disqualify schedules; the eighth new test proves A11 existing-catalog blocking with completion of old obligations. Actual independent reviewer found no blockers. Business source unchanged: these cases confirmed existing safeguards rather than a newly claimed feature fix. This closes those evidence gaps, not every conceivable behavior. See CRITERION-ACCEPTANCE-2026-10-28.json.

## LP-A14 explicit negative endpoint check

29October: add standalone authenticated OCDS export check before opening. Existing detail secrecy and post-award export results do not independently prove this exact criterion. Assert no bid identifier/prices/payload, empty awards and no tender value; uninvited supplier404. Independent static review no blockers; new hosted outcome pending. No product bug or new feature claimed.


## LP-A14 result, 29October

PR12 merged into main1b25692 and exact-main293API/3contention/13browser/fresh gate40762059590 PASS. Continued LP-A14: standalone pre-opening OCDS boundary in candidate49d5d67 / PR13 PASS in full run40762961832(294API/3contention/13browser/1freshHTTPS). New test rejects actual bid ID, financial/payload fields and known bid prices, verifies uninvited supplier404. Separate independent reviewer no blockers. Application code unchanged; this is explicit criterion evidence, not a newly claimed product fix. No blanket all20 production acceptance or optional release work.
