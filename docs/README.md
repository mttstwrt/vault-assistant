# Vault assistant — internals

How this plugin works, and why it works that way. For what it does and how to
use it, see the [repository README](../README.md).

Start with [architecture.md](architecture.md): what the components are, how a
message and a workflow round move through them, and which way dependencies are
allowed to run. Then the subsystem that concerns you.

| Page | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The component map, the two data flows, the dependency rule. |
| [agent/](agent/README.md) | The agentic loop, the tool surface, and the permission model every tool has to honour. |
| [retrieval/](retrieval/README.md) | How the agent finds things: the wiki, the semantic index, the pre-pass, and typed links — and the one principle they share. |
| [api/](api/README.md) | What an endpoint has to provide, what degrades when it does not, and which assumptions are llama.cpp's rather than OpenAI's. |
| [future-work.md](future-work.md) | Deliberately not built, with enough of the argument to start from rather than rediscover. |

## What is not here

Per-file explanation. Every module opens with a doc comment stating its purpose,
its boundaries, and the alternatives that lost; that is where a question about
one file is answered, and duplicating it here would only give it somewhere to go
stale. These pages describe what no single file can: a contract between several.

There are four of them rather than one per source directory for the same reason.
A page is a liability as well as an asset — an outdated doc is a bug — so each
one has to earn its keep by stating something a reader cannot get from the code
in front of them.

---

Repository README: [../README.md](../README.md)
