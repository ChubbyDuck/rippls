# A Classifier judges whether a Ticket can run

Rippls read HITL and blockers from what a Ticket states: a `hitl` field, a Marker, a Ticket Kind, a `blockedBy` field, or a "Blocked by" line. Tickets come from several authors and skills, each with its own way of marking a person in the loop or a blocker, and a folder ticket that stated nothing fell back to HITL yes and never ran. The ticket loop had replaced such rules with a small Model that reads each open ticket and judges it. We adopted that Model as the **Classifier**. For a Ticket of a classified Source, its **Classification** (ready, HITL, or blocked) stands in for Unblocked and Unattended. Not done, not escalated, and Unclaimed stay rules of the Engine.

The Classifier is a port. Its adapter runs a cheap Model through the Agent SDK, whatever Harness does the work, with no tools and a structured answer. An answer that is not exactly one known Classification per ticket is an error: a Drain halts, and a Watch tries again at the next poll. A Classification is never guessed.

## Considered options

- **Keep the rules and change the fallback to HITL no.** Rejected. It would run tickets that need a person but say so in prose, and it would still miss blockers named by title or link.
- **The Classifier as an extra gate after the rules.** Rejected. A ticket that states nothing would still fall back to HITL yes and never reach it.
- **Classify every Source.** Rejected as a default. Linear models readiness with workflow states and blockers with relations, so the Classifier is a setting on each Source, on for folders and off for Linear.
- **A fourth Classification, "not a ticket".** Rejected. The folder Source stays strict: a file without a numeric prefix is unreadable and never reaches the Classifier. A Ticket keeps the identity of ADR-0002.

## Classifications in the Ledger

A Classification is kept in the Ledger with the hash of the ticket text, the hash of the done set for a blocked one, and the Classifier's fingerprint (its model, effort, prompt, and schema). It holds while those match, so an unchanged ticket is judged once, an edited one again, and a blocked one again whenever a ticket becomes done. One Ledger keeps every fact the Engine records about a ticket, and the Git common directory serves every worktree with no ignore rule. Unlike a Claim, an Escalation, or done, a Classification can be given again: deleting the Classifications costs only Classifier calls.

## Consequences

- Picking a ticket can cost a Model call. A run with unchanged tickets costs none.
- `rippls status` reads Classifications from the Ledger and never calls the Classifier. A ticket with no Classification that holds is `unclassified`.
- Whether a ticket runs is a judgement, not a rule: two runs of the Classifier on the same text may differ. The Ledger keeps one judgement per text, so the Engine does not change its mind between picks.
- With the Classifier off, the rule-based reading applies as before.
