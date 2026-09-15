# Separate Engine and Runner entities from orchestration

Runner is a concrete domain entity with a stable identity, reused by the higher-level loop across successive tickets. The orchestration previously exposed as `Runner.run(ticket)` lives in a reusable `ProcessTicket` application use case receiving the ticket and runner identity. Runner has no port: this flow is core application behavior, not a replaceable infrastructure capability.

The use case coordinates the Ticket Source, Harness Selector, and Strategy Selector; those dependencies remain ports. The higher-level loop operates on Runner entities and invokes the use case for each ticket. Entry points translate raw input into use-case commands; the processing operation is also callable from application orchestration.

Engine is also a concrete domain entity, identifying the coordinator and creating named Runners. Engine has no port; ticket acquisition, concurrency management, and invocation of `ProcessTicket` belong to the `RunEngine` application use case. This orchestration was moved from `runLoops`; it is core application behavior rather than an infrastructure implementation.

Engine and Runner represent participants with identities; `RunEngine` and `ProcessTicket` coordinate their work. Keeping these use cases explicit allows different entry points and application flows to reuse them without introducing polymorphic ports for the orchestration itself.

The outer entry point translates raw input into a command, supplies concrete service implementations, and runs the resulting Effect. Both use cases return Effects declaring their required ports; neither imports infrastructure nor starts a separate runtime. `RunEngine` creates the Engine and its Runners and directly invokes `ProcessTicket` with `{ ticket, runnerId }` within the same Effect environment. Other entry points can invoke `ProcessTicket` independently with their own service implementations.
