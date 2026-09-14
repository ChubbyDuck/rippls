# Harness

Language for coordinating workers that process tickets.

## Participants

| Term        | Definition                                                                                         | Aliases to avoid                |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Harness** | An identified coordinator of a group of named **Runners** that process **Tickets**                 | Loop, orchestrator, worker pool |
| **Runner**  | A named worker that can process successive **Tickets** under the same identity                     | Agent, ticket execution, worker |
| **Agent**   | A named performer selected to execute a **Strategy** on a claimed **Ticket**                       | Model, LLM, tool, Runner        |

## Tickets

| Term              | Definition                                                                                           | Aliases to avoid            |
| ----------------- | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| **Ticket**        | A unit of work with identity, kind, status, project, body, and blocking relations                    | Issue, task (the noun), job |
| **Ticket Kind**   | The class of work a **Ticket** is: implementation, research, prototype, grilling, or task            | Type, category              |
| **HITL**          | Whether a human must be in the loop for this **Ticket**: yes or no                                   | Human review, interactive, AFK |
| **Ticket Status** | Where a **Ticket** sits in its lifecycle: open, ready-for-agent, claimed, done, resolved, or blocked | State, phase                |
| **Project**       | The named scope a **Ticket** belongs to                                                              | Repo, app, workspace        |
| **Title**         | The short human-readable name of a **Ticket**                                                        | Summary, subject            |

## Work

| Term                  | Definition                                                                                       | Aliases to avoid                |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| **Ticket Processing** | The work a **Runner** performs on one **Ticket**: claim, run the **Strategy**, record completion | Runner, run, execution, loop    |
| **Claim**             | Exclusive assignment of a **Ticket** to a **Runner**                                             | Lock, take, checkout            |
| **Strategy**          | The named procedure that executes one **Ticket Kind**, given a **Ticket** and an **Agent**       | Handler, workflow, prompt       |
| **Spawn**             | A **Harness** creating a **Runner** with a unique identity derived from the **Harness**          | Fork, allocate, start worker    |
| **Concurrency**       | How many **Runners** a **Harness** keeps available to process **Tickets** in parallel            | Parallelism, pool size, workers |
| **Quota**             | How many **Tickets** this **Harness** run will take before stopping                              | Queue, batch, limit             |
| **Idle**              | A **Harness** state: no **Ticket Processing** is in flight, and no **Eligible** **Ticket** is available |                                 |

## Place

| Term                  | Definition                                                                                          | Aliases to avoid      |
| --------------------- | --------------------------------------------------------------------------------------------------- | --------------------- |
| **Repository Root**   | The repository a **Harness** is bound to for one run                                                | CBD, checkout, cwd    |
| **Project Worktree**  | The stable worktree for a **Project**; it is not merged back automatically                          | checkout, branch      |
| **Ticket Worktree**   | The temporary worktree that holds every **Agent** run for one **Ticket**                            | per-prompt worktree   |

## Source

| Term       | Definition                                                                                                             | Aliases to avoid                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Source** | The origin a **Ticket** is read from and written to; it converts external records to the **Ticket** shape and back      | Backend, provider, tracker, store, repository |
| **Issue**  | An external record in a tracker such as Linear; a **Source** converts it to a **Ticket**. It is not itself a **Ticket** | Ticket, task                                  |

## Eligibility

| Term           | Definition                                                                               | Aliases to avoid      |
| -------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| **Unblocked**  | A **Ticket** with no remaining blockers                                                  | Ready, free           |
| **Unclaimed**  | A **Ticket** not assigned to any **Runner**                                              | Available, free, open |
| **Unattended** | A **Ticket** whose **HITL** is no — it can proceed without a human                       | AFK, automated, no-HITL |
| **Eligible**   | An **Unblocked**, **Unclaimed**, **Unattended** **Ticket** the **Harness** may take next | Ready, next, pollable |

## Relationships

- A **Harness** spawns one or more **Runners**; each **Runner** belongs to exactly one **Harness**.
- A **Runner** identity is stable across successive **Tickets**; **Ticket Processing** is one pass over one **Ticket**.
- A **Claim** assigns exactly one **Ticket** to exactly one **Runner**.
- A **Ticket** has exactly one **Ticket Kind**, one **HITL**, one **Ticket Status**, and one **Project**.
- Every **Ticket Kind** except task implies a fixed **HITL**; a task declares **HITL** explicitly.
- A **Ticket** may be **blocked by** zero or more other **Tickets**, and may **block** zero or more other **Tickets**.
- **Ticket Processing** selects one **Agent** and one **Strategy** (by **Ticket Kind**) for the claimed **Ticket**.
- An **Agent** is chosen from a configured rotation, optionally overridden by a time-bound schedule; it is not a **Runner**.
- A **Harness** is bound to one **Repository Root**.
- A **Project** is not a **Repository Root**.
- A **Project** has one **Project Worktree**.
- **Ticket Processing** creates one **Ticket Worktree**, installs workspace dependencies there from the tree's own manifest, and runs every **Agent** invocation for that **Ticket** inside it. The **Agent** does not discover or install those dependencies.
- After a successful **Ticket Processing**, the **Ticket Worktree** is merged back into its parent and closed.
- After a **HITL** raise, the **Ticket Worktree** is retained and is not merged back.
- A **Ticket** has exactly one **Source**; the **Source** is part of the **Ticket** identity, and the domain does not branch on it.
- A **Source** converts an external record — a Linear **Issue** or a local file — into a **Ticket**, and converts **Ticket** changes back to that record.
- A **Harness** is **Idle** when no **Runner** is in **Ticket Processing** and no **Eligible** **Ticket** is available.
- **Idle** begins on the first empty poll while no **Runner** is in **Ticket Processing**, and ends when a **Claim** starts.
- A **Harness** run ends when the **Quota** is reached or the **Harness** has been **Idle** for five minutes.

## Example dialogue

> **Dev:** "When the **Harness** starts, does each **Runner** pick its own **Agent**?"
> **Domain expert:** "No. The **Harness** **spawns** **Runners** up to **Concurrency**. Each **Runner** is just who claims the work. During **Ticket Processing**, the system selects an **Agent** independently and runs the **Strategy** for that **Ticket Kind**."
> **Dev:** "So if a **Ticket** is prototype with **HITL** yes, a **Runner** still **claims** it?"
> **Domain expert:** "Not from this **Harness**. The poll only takes **Eligible** **Tickets** — **Unblocked**, **Unclaimed**, and **Unattended**. Prototype implies **HITL** yes, so it is not **Unattended**."
> **Dev:** "And after the **Strategy** finishes, the **Runner** is done?"
> **Domain expert:** "The **Ticket** is **done**. The **Runner** stays; the **Harness** reuses it for the next **Eligible** **Ticket** until the **Quota** is reached or the **Harness** has been **Idle** for five minutes."

## Flagged ambiguities

- **"Runner"** was used for both the named worker and the act of processing a ticket. **Runner** is the identity; **Ticket Processing** is the work.
- **"Agent"** was used as a synonym for **Runner**. They are distinct: a **Runner** claims a **Ticket**; an **Agent** executes the **Strategy**.
- **"Ready"** was used for both **Ticket Status** `ready-for-agent` and the poll criteria. The harness takes **Eligible** tickets (unblocked, unclaimed, unattended), not every ticket whose status is ready-for-agent.
- **"AFK"** in queries means **HITL** is no. Prefer **Unattended**; do not treat AFK as a third concept besides **HITL**.
- **"Queue"** was used for a numeric cap on tickets in one run. That cap is a **Quota**, not a queue of work.
- **"Task"** is a **Ticket Kind**, not a synonym for **Ticket**.
- **"Done"** and **"resolved"** are different **Ticket Status** values. **Ticket Processing** records **done**; **resolved** is a separate status, not the completion of a claim.
- **"Repo"** was an alias to avoid for **Project**. **Repository Root** is a different term: the repository the **Harness** is bound to, not the named scope of a **Ticket**.
- **"Worktree"** was used for both the stable **Project Worktree** and the temporary **Ticket Worktree**. They are distinct: the project tree stays until a human merges it; the ticket tree covers every **Agent** run for one **Ticket** and is closed after success.
- **"Issue"** is an external record a **Source** converts into a **Ticket**. Do not use it as a synonym for **Ticket**.
- **"Sort"** once named a field. A query now carries a direction only. The **Harness** takes the next **Eligible** **Ticket** in each **Source**'s natural order, and each **Source** chooses the ordering key.
