# Coding standards

Rules for reviewing a change to Rippls. They add to `AGENTS.md` and `CONTEXT.md`, and override the review's smell baseline where they disagree.

## Two levels of finding

Give every finding one level.

- **Must fix**: behaviour that contradicts the ticket or its spec, or a failure with a concrete scenario: the inputs or the state, and what goes wrong (a crash, lost data, a ticket or Issue left stuck, a wrong message to the person). A breach of a rule in `AGENTS.md`, `CONTEXT.md`, or this file is also must fix.
- **Note**: everything else. Every smell of the baseline, naming taste, the shape of a test, a refactor the ticket did not ask for. A note is fixed when it is cheap and inside the files the change touches, and otherwise only recorded.

## The ticket is the unit of work

A change made for a ticket may carry everything that ticket asks for, in one commit or several. `AGENTS.md` "Small steps" bounds what a session takes on in a conversation; it is not a rule on commit size. Review the commits of a ticket against the ticket.

## Docs move with the code

A change updates the documents that describe the behaviour it changes: `README.md`, `onboarding.md`, `CONTEXT.md`, and the ADRs in `docs/adr/`. An edit that makes a document match the change is in scope. A document that the change leaves stale is a must fix.
