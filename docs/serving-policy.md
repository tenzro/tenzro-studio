# Universal serving policy — design doc

**Status:** draft for review.
**Goal:** every model in the Tenzro catalog serves correctly the moment it
lands, with zero per-id app patches. Adding a new model is a catalog-only
change: declare its facts (family, size, architecture, MoE/MTP/mmproj
shape, license, HF location) and the runtime derives every serving
decision from those facts.

## Why we need this

The current path is a pile of per-id hacks accumulated across one
session debugging Qwen3.5-0.8B:

- `TEMPLATE_OVERRIDES: &[(family, jinja_file)]` — hand-maintained map of
  known-broken families to vendored template files.
- Dual-stem catalog index — because the network downloader writes
  `<id>.gguf` (lowercase) while the catalog's `hf_filename` is the
  canonical Unsloth name (mixed case), the app indexes both.
- Per-id thinking-mode override in the catalog build pass:
  `if matches!(entry.id.as_str(), "qwen3.5-0.8b" | "qwen3.5-2b")`.
- App-side `inject_reasoning_default` reads the catalog's
  `reasoning_default` bool and injects `chat_template_kwargs.enable_thinking`.

Every one of these works around the same root cause: **the catalog
doesn't publish enough policy, so the app re-derives it incorrectly
and we patch the symptom per-id.**

A new model (Qwen 4 30B? Gemma 5? DeepSeek V5?) would force another
debugging session. That isn't the bar.

## Principle

> The catalog is the SoT for every serving parameter the runtime needs.
> The app reads; it never decides.

Adding a new model = adding a `HfModelEntry` literal with its facts.
The catalog build pass derives the runtime policy. The app reads the
derived policy and configures llama.cpp accordingly. No conditionals
keyed on family / id / size live in the app.

## What the catalog should publish (additive, backwards-compatible)

Three new fields on `HfModelEntry`, all derived in the build pass from
existing facts. No existing entry needs editing.

### 1. `download_filename: String`

The flat filename the network's HF downloader writes to
`~/.tenzro/models/`. Always `<id>.gguf` for unshared models;
`<id>/<first-shard>.gguf` for shared (the downloader chooses the dir
layout, the catalog publishes it). Eliminates the dual-stem index in
the app — the matcher just reads this field.

Derivation rule: simple — `<id>.gguf` for `mtp_kind == None && moe ==
None && !sharded`; `<id>/...` otherwise.

### 2. `reasoning: ReasoningPolicy`

Replaces today's single `reasoning_default: bool`. Carries everything
the runtime needs to drive thinking mode safely.

```rust
pub struct ReasoningPolicy {
    /// Whether the family supports thinking mode at all. False for
    /// instruct-only families (mistral, ministral, mistral-nemo, phi
    /// without -reasoning suffix, gemma3-it). True for qwen3/3.5/3.6,
    /// gpt-oss, glm5+, deepseek-v3+, kimi, gemma3-reasoning, phi-N-reasoning.
    pub supports_thinking: bool,
    /// Default mode for fresh requests. `Auto` resolves per
    /// `default_mode_threshold_b` below.
    pub default_mode: ReasoningMode, // Auto | Always | Never
    /// Below this parameter count (in billions, dense; or active-B for
    /// MoE), thinking is OFF by default even when the family supports
    /// it — because small thinking-mode models enter thinking-loops
    /// per Qwen 3.5-0.8B/2B model card warnings.
    pub thinking_safe_min_b: f32,
    /// Minimum total max_tokens budget when thinking is ON. Below this
    /// the runtime forces non-thinking (matches Qwen team's published
    /// 32K min recommendation for thinking-mode generation).
    pub thinking_min_budget_tokens: u32,
}

pub enum ReasoningMode { Auto, Always, Never }
```

Derivation rules (function of family + parameters + architecture):

| Family | supports_thinking | thinking_safe_min_b | thinking_min_budget |
|---|---|---|---|
| qwen3 | true | 0.6 (every Qwen3 size is documented thinking-on) | 8K |
| qwen3.5 / qwen3.6 | true | **4.0** | 16K |
| gpt-oss | true | 0.0 (Harmony defaults thinking) | 8K |
| glm / glm5 / glm6 | true | 9.0 | 16K |
| deepseek-v3 / -v4 | true | 13.0 | 32K |
| kimi-k2 / k2.5 / k2.6 | true | 0.0 (all MoE thinkers) | 32K |
| minimax-m1 / m3 | true | 0.0 | 16K |
| mistral / ministral / mistral-nemo | false | n/a | n/a |
| phi (no -reasoning suffix) | false | n/a | n/a |
| phi-N-reasoning | true | 4.0 | 16K |
| gemma3 / gemma4 (instruct) | false | n/a | n/a |
| nemotron-3-nano | true | 4.0 | 16K |
| granite4 (instruct) | false | n/a | n/a |

`default_mode = Auto` for every entry; `Always` and `Never` are
escape hatches (e.g. when an upstream's "thinking" variant is the
only one in the catalog, force `Always`). The runtime resolves `Auto`
by `parameters >= thinking_safe_min_b ? Always : Never`.

### 3. `template_fix: Option<TemplateFix>`

Replaces today's app-side `TEMPLATE_OVERRIDES` map.

```rust
pub enum TemplateFix {
    /// Embedded GGUF jinja is correct as-is. Most entries.
    None,
    /// Use a vendored fix shipped in the inference client. The string
    /// is the bundled jinja filename. Catalog declares WHICH fix; the
    /// client ships the actual file. Decoupling means a new template
    /// fix lands in the client without a catalog rebuild.
    Vendored { filename: &'static str },
    /// Apply a per-template-bug patch at load time (advanced; not
    /// wired yet). Reserved for fixes that are small enough to
    /// describe as a transform rather than a full replacement.
    Patch { kind: TemplatePatchKind },
}

pub enum TemplatePatchKind {
    /// Replace `content | replace(X, '')` with `content.split(X).join('')`
    /// for known minja replace-at-idx-0 bugs.
    SplitJoinReplace { needle: &'static str },
    /// Strip stray empty `<think></think>` blocks from assistant turns
    /// (the qwen3.5 v19 empty-think poisoning bug).
    EmptyThinkStrip,
}
```

Derivation rules — keyed off `family + architecture`, set once in the
catalog build pass:

| Family | template_fix |
|---|---|
| qwen3.5 / qwen3.6 | `Vendored { filename: "qwen3.5-3.6-froggeric-v20.jinja" }` |
| glm5 / glm6 | (TBD — track known glm 4.6 think-tag bug; for now `None`) |
| (everything else) | `None` |

Adding a new known-broken family: add one row here + drop a jinja in
the inference client. No app-side conditional changes.

## App-side runtime: derived from catalog only

The inference client reads catalog → produces llama.cpp invocation +
runtime hooks. Pseudocode for the only decision point:

```rust
fn build_invocation(entry: &HfModelEntry, host: &HardwareProfile) -> InvocationPlan {
    InvocationPlan {
        model_path:           models_dir.join(&entry.download_filename),
        chat_template:        match &entry.template_fix {
            TemplateFix::None => UseEmbedded,
            TemplateFix::Vendored { filename } => UseVendored(templates_dir.join(filename)),
            TemplateFix::Patch { kind } => ApplyAtLoadTime(*kind),
        },
        sampler:               entry.serving.clone(),
        mmproj:                entry.mmproj.as_ref().map(|m| models_dir.join(&m.filename)),
        spec_decoding:         resolve_spec_decoding(entry, models_dir),
        n_cpu_moe:             entry.moe.as_ref().map(|_| host.n_cpu_moe()).filter(|&n| n > 0),
        ctx_size:              host.ctx_size(),
        ...
    }
}

fn inject_runtime_kwargs(body: &mut Value, entry: &HfModelEntry) {
    if !entry.reasoning.supports_thinking { return; }
    let user_budget = body.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let mode = match entry.reasoning.default_mode {
        ReasoningMode::Always => true,
        ReasoningMode::Never  => false,
        ReasoningMode::Auto   => {
            let size_b = parse_param_b(&entry.parameters);
            let big_enough  = size_b >= entry.reasoning.thinking_safe_min_b;
            let budget_ok   = user_budget == 0 || user_budget >= entry.reasoning.thinking_min_budget_tokens;
            big_enough && budget_ok
        }
    };
    // Only inject when the caller didn't set it — caller wins.
    if !body_has_explicit_enable_thinking(body) {
        body["chat_template_kwargs"]["enable_thinking"] = Value::Bool(mode);
    }
    // Defensive: if thinking is being forced ON but budget is too small,
    // bump max_tokens to the model's recommended minimum.
    if mode && user_budget > 0 && user_budget < entry.reasoning.thinking_min_budget_tokens {
        body["max_tokens"] = Value::from(entry.reasoning.thinking_min_budget_tokens);
    }
}
```

That's the entire app-side serving logic. No `if family == "qwen3.5"`,
no `if id == "qwen3.5-0.8b"`, no hardcoded budget. Future models go
through the same path.

## Migration plan

1. **Catalog crate** (tenzro-network): add the three new fields, the
   derivation rules, and the build-pass enrichment that populates them
   from the existing facts. Backwards compatible because every new
   field has a `serde(default)` and the derivation runs at build-pass
   so old entries pick up correct values automatically.
2. **Inference client** (tenzro-inference): delete
   `TEMPLATE_OVERRIDES`, delete the dual-stem index, delete
   `inject_reasoning_default`'s hardcoded catalog read (replace with
   the policy function above). The client gets simpler, not bigger.
3. **All three repos** (dev tree, mirror, inference) get one commit
   each. The mirror commit goes to GitHub immediately so the deployed
   validator fleet picks up the new catalog on next image roll.

## Out of scope (this pass)

- Per-request thinking override from the UI (e.g. "force think harder"
  button). The infrastructure makes this trivial once needed —
  user-set `chat_template_kwargs.enable_thinking` already wins over
  the auto-injection — but we don't wire UI for it yet.
- `TemplatePatchKind::SplitJoinReplace` runtime patching of GGUF
  jinja. Vendored templates cover today's known bugs; load-time
  patching is reserved for cases where a full vendored replacement
  is more disruptive than a targeted patch (none yet).
- Reasoning-budget telemetry / observability. Once policies are in
  place, a follow-up should record `mode_chosen`, `budget_set`, and
  `finish_reason` per request so we can detect new thinking-loop
  regressions automatically.

## Questions for review

1. Are the **size thresholds** above acceptable as published
   defaults? They're derived from Qwen team + Unsloth published
   guidance for qwen3.5/3.6; other families are extrapolated. We can
   tune any of them — they live in the catalog crate, easy to PR.
2. Should `template_fix` reference the **inference-client repo path**
   directly, or stay a logical name the client resolves to its
   bundled path? I chose the latter (catalog publishes
   `"qwen3.5-3.6-froggeric-v20.jinja"`, client maps to its own
   `templates/` dir). That keeps the catalog deploy-agnostic and lets
   different clients ship their own template directories.
3. The `TemplatePatchKind` enum is **reserved but not implemented** —
   should we drop it from the schema until we have a real use case,
   or land it now for forward compatibility? I lean drop-now,
   add-when-needed.
