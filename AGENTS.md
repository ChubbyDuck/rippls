# Rippls

Standalone ticket **Harness**. Work in this app is interactive and sequential. The human names one problem, in specific terms, and waits for that change. Do that change. Stop.

## Ubiquitous language

`CONTEXT.md` is the ubiquitous language for this app. It declares the terms that exist. Read it when the work involves those terms, and use those names in code, errors, and prose.

## Do only what was asked

Implement the request as stated. Do not add the next adapter, the next invariant, or a feature implied by an ADR, a ticket comment, YAML commentary, or a field's everyday meaning.

A field description is not a license to model its future producer. `id` being "a positive integer matching the filename prefix" means the domain `id` is a positive integer. It does not mean `fromFile`, filename regexes, or any file handling until those are asked for.

If a suggestion would help, or the request is ambiguous, ask one short question and wait. Never decide the extra scope silently. When user needs to cleanup after a silent decision is a failure of this rule.

## Small steps

One concern per turn: one type, one invariant, one rename, one move. Do not "finish the design" ahead of the conversation. When the asked change is done, say what changed and wait.

## Generators vs pipes

Write Effects as pipes (`andThen`, `matchEffect`, `filterOrFail`, …) while they stay readable. Convert to `Effect.gen` when the pipe is no longer easy to follow — nested `flatMap` / `tap` / `catchTag` chains, or several sequential steps.

## Sandcastle source

When working with Sandcastle (`@ai-hero/sandcastle`), read the library from the local fork at `/Users/chubbyduck/_Projects/fork/sandcastle`. Do not guess APIs from types or docs when the source is available.
