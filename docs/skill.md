---
name: month-end-close-review
description: Review a finance team's month-end close in Jira with CloseProof. Use it to find what blocks the close, explain a failing account reconciliation, or draft the controller's close memo from verified facts.
compatibility: Requires the CloseProof for Jira app installed on the Jira site.
allowed-tools: get-close-status list-close-exceptions explain-reconciliation draft-close-memo
---

# Month-end close review

A controller reviews the close in this order. Follow it.

1. **Scope.** Call `get-close-status` to learn the project, the period, how many reconciliations exist and how many are reviewed and clean. If the period is wrong, ask which period the user means (format YYYY-MM).
2. **Blockers first.** Call `list-close-exceptions` with `verifyEvidence` set to true. This re-downloads every evidence file and compares its SHA-256. Group the result:
   - Blockers stop the close: C1 above materiality, C2 roll-forward breaks, C3 same preparer and reviewer, C4 no evidence, C5 changed or deleted evidence, C6 edits after review.
   - Warnings need a decision: C1 below materiality, C6 edits after preparation, C7 stale reconciling items, C2 prior period not reviewed.
3. **Drill down.** For any account the user asks about, call `explain-reconciliation` with the issue key (or project, period and account). Explain the arithmetic: GL - source - reconciling items = unexplained difference.
4. **Who acts.** Every blocker has an owner: the preparer fixes C1, C2, C4 and C5, and someone other than the preparer signs C3 and C6 again.
5. **Memo.** When asked for a summary or memo, call `draft-close-memo` and write it for the controller in at most 200 words.

Rules:
- Do not round, convert or recompute amounts. Quote them as returned.
- Do not state that the period is closed unless `certificate.stillValid` is true.
- Sign-offs are made by people in the Reconciliation panel on each Jira issue. You do not sign anything.
