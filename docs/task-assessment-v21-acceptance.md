# Attachment acceptance traceability

Status legend: **targeted** = a focused automated check exists; **implementation/UAT** = code path exists but this exact end-to-end scenario still needs an acceptance exercise. All production/business-owner acceptance remains pending. This matrix deliberately does not claim that all 54 release scenarios have passed.

| ID | Code path / check | Evidence level |
|---|---|---|
| A01 | Approved profile snapshot; code-only identity; browser blank-dropdown test | targeted |
| A02 | Strict shared Score schema and integer-scale browser test | targeted |
| A03 | Independent dimension applicability; browser K-only N/A | targeted |
| A04 | Pending/null decision and velocity rules | targeted |
| A05 | Practical evidence-method and behavior-check rules | targeted |
| A06 | Level-4 substantive/nonroutine case rules | targeted |
| A07 | Exact rational threshold comparison before rounding | targeted |
| A08 | Three comparable case minimum for V4 | targeted |
| A09 | Verified observed failure versus missing opportunity | targeted |
| A10 | Immediate restriction at save; PM invalidation integration test | targeted; live latency pending |
| A11 | Dimension coverage and percentage rules | targeted |
| A12 | Distinct case/timing de-duplication rules | targeted |
| A13 | Versioned searchable guide route and download; keyboard navigation, narrow viewport, draft retention, locale | targeted; screen-reader UAT pending |
| A14 | Optimistic version conflict; database/browser tests | targeted |
| A15 | Failed autosave and typing during in-flight saves | targeted |
| A16 | New immutable versions, task/profile impact comparisons, explicit equivalence | targeted; complete impact UAT pending |
| A17 | Source attribution/contribution checks and rejected evidence links | implementation/UAT |
| A18 | Withdrawal resets open results or holds published capability; signed evidence retained | targeted for published hold; open-flow UAT pending |
| A19 | Factual suggestion provenance; kept/edited flags; blank numeric decisions | targeted |
| A20 | Calendar/wait interval subtraction; elapsed retained | targeted |
| A21 | Minimum 12 samples/4 employees; median/provenance; owner approval | targeted rules; worker UAT pending |
| A22 | Two-period drift candidate and prospective review | targeted rules; worker UAT pending |
| A23 | Manual share forces full review | targeted |
| A24 | Unsampled routine packet queue, explicit batch selection, pull-full action | implementation/UAT; full-review bypass rejection tested |
| A25 | Per-family distributions, N/A reasons, durations, shared-case/reference agreement; minimum-sample flags, owner notification and deprioritization without score changes | targeted rules and selection; worker UAT pending |
| I01 | Company UUID + employeeCode; FORCE RLS non-owner test | targeted |
| I02 | Code reconciliation/non-reuse and company quality circuit breaker | targeted rules; migration rehearsal pending |
| I03 | Approved correction, aliases, immutable history and PM acknowledgment | targeted HR; live cross-service drill pending |
| I04 | Strict rejection of employeeId/userId in new commands | targeted |
| I05 | Tenant and contribution/evidence scope authorization | targeted rules/RLS; source UAT pending |
| I06 | Quarantine, trusted scanner identity/hash/MIME/size receipts | implementation/UAT |
| I07 | Independent rater/reviewer/publisher and separate requirement permissions | targeted |
| I08 | Submission/evidence gates, receipt gate, DB insert/update freeze | targeted |
| I09 | Dispute reassessment, holds, SLA acknowledgment exception package | implementation/UAT |
| I10 | Inbox/event idempotence; monotonic PM publication sequence | targeted |
| I11 | Training completion creates reassessment opportunity, no rating uplift | implementation/UAT |
| I12 | V unavailable/N/A with reviewed nonzero effort fallback | targeted |
| I13 | Concurrent PM commits, people/tool locks and capacity guard | targeted people race; tools UAT pending |
| I14 | Exact 170-minute schedule across excluded days and occupied work | targeted |
| I15 | Freshness validation, fail-closed commitments, recovery stability period | targeted |
| I16 | Revocation, immutable appraisal amendments, active-work review/stop event | targeted PM and finalized-appraisal preservation/replay; live drill pending |
| I17 | Immediate active-position preflight; current profile; employment-scope event | targeted HR; live transfer propagation pending |
| I18 | Inbox replay, durable keys, no duplicate notification/development rows | implementation/UAT |
| I19 | Expiry/lead-window renewal trigger and duplicate/hold guards | implementation/UAT |
| I20 | Scope-delta generation and explicit independent version equivalence | targeted equivalence; complete role-change UAT pending |
| I21 | Leave/unavailability reassignment and new-rater verification | implementation/UAT |
| I22 | New approved evidence closes action; guarded legacy closure; scoped upcoming-work matching with calendar and supervisor checks | targeted matching/withdrawal; full learning-to-reassessment UAT pending |
| I23 | Recurring profile gaps create JD redline; owner + HR publication | implementation/UAT |
| I24 | Reserve/reject/expire releases uncommitted capacity | implementation/UAT |
| I25 | Restrictions dominate scores; class/risk/approval gates | targeted |
| I26 | Integration exceptions pause automatic commitment; recommendation continues | targeted rules and recovery path |
| I27 | Verified actuals, personal median and approved class fallback, prospective learning | implementation/UAT |
| I28 | Source integrity-rate circuit breaker and evidence review flags | implementation/UAT |
| I29 | Malformed or score-bearing note rejected and incident recorded | targeted |

Additional required release exercises: keyboard/screen-reader/zoom/long-label/empty-list checks with real users; scan-service rejection and authorized download checks; every configured source's attribution and withdrawal semantics; outbox/consumer outage and recovery; backup restore; migration rollback compatibility; projection rebuild; AutomationRun replay; 550-employee/7-site load with actual published calendars. None is silently waived by the automated checks above.
