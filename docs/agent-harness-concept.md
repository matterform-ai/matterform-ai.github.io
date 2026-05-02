# Stakeholder-Driven Agent Harnesses for Ticket-to-Delivery Workflows

## The goal

Take a Jira ticket at a Fortune 500 company — the kind with dozens of fields spanning Product, Engineering, DevOps, Security, Data, and other stakeholders — and produce a custom agent loop that drives the ticket to delivery. Not every field applies to every ticket, and not every stakeholder is on the hook for every feature. The system figures out who needs to weigh in, gathers what it needs from each of them, composes a process graph for the work (with human-in-the-loop checkpoints baked in where policy demands), gets sign-off where required, and then runs the loop.

Two ideas do most of the work:

1. **A company-level template process** that captures *how this particular company wants agent loops to be built* — its stack, its stakeholders, its policies, its HITL rules.
2. **A per-ticket intake process** that uses the template to interrogate the right stakeholders about a specific ticket and produce a concrete, executable process graph for it.

Both are run as guided, conversational, branching intake flows — one question at a time, downstream questions conditional on upstream answers. The intake experience is the unlock: it's how the system extracts enough structured intent from busy stakeholders to do real work without burying them in forms.

## Tier 1 — The template process (defines the harness for a company)

This runs as a Typeform-style flow when a company onboards, and is **rerunnable** (in part or in whole) whenever the stack, stakeholder roster, or governance policy changes. Every run is versioned, every artifact is auditable, and on rerun the flow shows previous answers as context so the responder is editing rather than re-answering from scratch.

What the template process establishes:

- **Stakeholder roles and their decision domains.** Who owns infra cost approval. Who signs off on schema changes. Who reviews anything touching PII. Who must be looped in when a new external dependency is introduced.
- **Policy → HITL gate mappings.** A declarative layer that says things like *"new cluster provisioning requires Finance + DevOps approval before any execution begins,"* or *"changes to tables tagged `pii:true` require Security review before merge,"* or *"refactors under N LOC in non-critical paths can auto-merge."* These are the rules that will later be instantiated as concrete gates in per-ticket process graphs.
- **Process-graph-level approval rules.** Some classes of work require approval of the *plan* before any execution starts. The template declares which classes. (And for cautious early adopters, the template can simply assert that *all* process graphs require plan approval until trust is established — a useful onboarding posture.)
- **Stack and integration surface.** Which systems of record exist, which actions are deterministic vs. LLM-mediated against them, what the agent is permitted to read from and write to.

The output is a versioned template artifact. Every per-ticket process graph that gets built afterward is attributable to a specific template version, so governance changes are traceable end-to-end.  Essentially, this process defines a process graph for defining process graphs for agent loops.

## Tier 2 — The intake process (builds a process graph for one ticket)

When Product issues a Jira ticket that provides only an outline of a new feature, component, or service, the intake agent runs a Typeform-style flow against the relevant stakeholders. The flow is dynamic: Product's answer about feature scope determines which questions Eng sees; Eng's answer about whether new infrastructure is needed determines whether DevOps gets pulled in at all; DevOps' answer about cluster provisioning determines whether a Finance gate gets inserted into the graph.

The deliverable is a **process graph** — a DAG of typed actions, some deterministic, some LLM-mediated, with HITL nodes inserted wherever the template's policy layer demands them. HITL nodes can appear:

- **At the start of the graph** as preconditions (e.g., approve the cost of a new cluster *before* any work begins).
- **In the middle**, gating intermediate artifacts (e.g., schema diff approval before migration runs).
- **At the end**, as delivery sign-off.
- **Around the graph as a whole**, when the template says this class of ticket needs plan approval before execution starts at all.

Tickets that don't trip any policy rules can produce graphs with no HITL nodes — a small, internal-only refactor on a non-critical path might run end-to-end autonomously. The point is that HITL is not a default posture; it's a *consequence* of policy intersecting with what the ticket actually touches.

## Why this shape, specifically

A few properties matter:

- **Stakeholders only answer questions that apply to them.** The branching intake means a ticket that doesn't touch infra never bothers DevOps. This is what makes participation tolerable at scale.
- **HITL is policy-driven, not vibes-driven.** Whether a human needs to approve something is a deterministic function of (template version) × (ticket characteristics). Auditable, explainable, and tunable.
- **The template is itself a governed artifact.** Versioned, rerunnable, with prior answers shown as context on rerun. Process graphs are attributable to template versions, so when policy shifts, you can tell exactly which historical agent loops ran under which rules.
- **Two flows, one pattern.** Both tiers use the same conversational, branching intake mechanism. The template flow asks *"how should this company's agent loops be built?"*; the intake flow asks *"how should this specific ticket's agent loop be built?"* The mechanism is the same; the schema and audience differ.

## Summary

The system is built from three separable concerns that are easy to conflate but need to stay distinct:

a) A **company-level template** that encodes stakeholders, stack, and HITL policy as a versioned, rerunnable, auditable artifact.

b) A **ticket-level intake** that branches based on the ticket's actual surface area, pulling in only the stakeholders whose domains the ticket actually touches.

c) A **process graph** whose HITL nodes are the deterministic output of policy meeting ticket — not a default posture, not a judgment call at runtime, but a function of (template version) × (ticket characteristics).

Both intake flows — the template flow and the per-ticket flow — share the same conversational, branching mechanism; what differs is the schema and the audience. That symmetry is what keeps the system coherent: one pattern for eliciting structured intent from humans, applied at two levels of governance.
