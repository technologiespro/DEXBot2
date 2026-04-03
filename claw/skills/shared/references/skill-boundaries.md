# First-Release Skill Boundaries

| Skill | Boundary | Allowed work | Not allowed |
| --- | --- | --- | --- |
| `bitshares-guide` | presentation-only | Pack presentation, onboarding copy, and guide structure | Operational instructions or source dumps |
| `margin-trading` | concept-reference | Trading concepts, HONEST.Asset properties, position lifecycle, available operations | Prescribing specific parameter values as optimal, strategy recommendations, profit/loss predictions |
| `launcher-ops` | operational-orchestration | PM2 startup, unlock-start, claw-only mode, Docker-friendly launcher flow, launcher validation | Trading advice, credential disclosure, or bridge internals |

## Non-Goals

- No secrets or credentials.
- No unsupported runtime claims.
- No duplicated canonical source pointers inside individual `SKILL.md` files.
- No mixing of current, reference-only, and historical-only material without labels.
- Keep launcher orchestration guidance isolated to `launcher-ops`.
- No reuse of presentation reference material as an operational source.
