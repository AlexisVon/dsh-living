# dsh-living

English | [中文](README.md)

A runtime for an agent that **lives by its own settings**: its own schedule, memory and persona, connected to the real world through **WorldGem**.

> Status: v0.3.4. The core, protocol and three real gems (Bilibili / WeChat / PetKit feeder) are implemented. Gems are downloaded from npm into living's own directory and do not add DSH plugin entries.

## What it is

- **Clock** — 10–60 min auto-wake grid, hot/cold time ranges, its own schedule, rest, one night sleep at 03:30.
- **Memory** — layered and shown in three ways (hot injection / warm retrieval / cold clues only); forgetting is **dimension reduction**, not deletion.
- **Persona** — `charter` (read-only) + `self` (rewritten at night, versioned in `life.db`) + `journal`.
- **World** — WorldGem: a gem provides **capabilities** (MCP), **events** (ingest / outbox) and a **skill** that teaches the model how to use it.

## What it is not

- Not a general assistant; it does not take over your coding sessions.
- It does not make decisions for you; public speech always passes the limiter.
- It does not coexist with a second memory plugin — memory has exactly one owner.

## Install

Install `dsh-living` from the DSH plugin market (the only package that is installed as a plugin):

```sh
dsh plugin --profile <profile> add dsh-living
```

Gems are not installed one plugin at a time. After installing living, open **Living → Gems → Add gem** and choose Bilibili / WeChat / PetKit feeder from the built-in catalog. Living downloads them from npm into its own directory:

```
$DSH_HOME/living/
  data/        # life.db, gem config/credentials/media
  workspace/   # agent working directory
  gems/        # gem code (re-downloadable)
```

Restart the host after installing or removing a gem. Removing a gem deletes code and the media cache only; config, credentials and memories in `life.db` are kept.

## Data and backup

The memory database is `$DSH_HOME/living/data/life.db` (default `~/.dsh/living/data/life.db`). It contains events, the three memory layers, persona, journal, reports and outbound records. Legacy `charter.md` / `self.md` / `journal/` files are moved to `data/legacy/` and imported once on startup.

**Living → Config → Data & backup** provides:

- **Back up memory** — creates a consistent snapshot (`VACUUM INTO`) and exports a `.db` through the browser's save-location picker. The file is plain SQLite and contains persona and memories.
- **Import memory** — pick a `.db`, upload and validate (SQLite header, `integrity_check`, schema version, required tables). A valid file is staged and replaces the current database on the **next host start**, after backing up the current one to `data/backups/pre-import-*`. Replace only; no merge.
- A database with a newer schema is refused loudly.

Uninstalling the `dsh-living` plugin only removes plugin code; `data/` and `workspace/` are never deleted automatically.

## Repository layout

```
packages/
  core/          → npm: dsh-living              runtime
  protocol/      → npm: dsh-living-protocol     gem protocol (manifest / endpoints / failure codes)
  gem-example/   → npm: dsh-gem-example         reference gem
  gem-bili/      → npm: dsh-gem-bili            Bilibili gem
  gem-wechat/    → npm: dsh-gem-wechat          WeChat gem
  gem-petkit/    → npm: dsh-gem-petkit          PetKit feeder gem
docs/            architecture and project docs
scripts/         selfcheck / backtest maintenance scripts
spikes/          pre-release probes
```

One repository, several packages. The protocol is a separate package because gem authors depend on it; it does not need a separate repository.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — what it is.
- [Decisions](docs/DECISIONS.md) — why not the alternatives.
- [Working agreement](docs/WORKING-AGREEMENT.md) — who writes, who reviews, red lines.
- [Project](docs/PROJECT.md) — goals, non-goals, milestones and risks.

## Three design principles

1. **Auto-wake by grid quota** — 10–60 min grid, sample every 30/60s; only a hit calls the model, and points while running are void.
2. **Narrow surface by structure** — the tool surface is decided by the preset, not by prompt instructions.
3. **The ledger is not model-written** — observable facts come from code and parsers; its own journal lives in a separate area.

## License

MIT
