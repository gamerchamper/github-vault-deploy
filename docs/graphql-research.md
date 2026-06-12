# GitHub GraphQL Repository Object — Research Notes

## Question

Can GitHub GraphQL batch chunk existence checks to reduce REST/Contents API usage?

## Findings

### Repository object capabilities

The GraphQL `Repository` object exposes:

- `object(expression: "HEAD:path/to/file")` — single blob/tree lookup per query
- `defaultBranchRef` — branch metadata

GraphQL queries still count against the **same core rate limit** (5000/hr) but allow **multiple objects in one request** via aliases:

```graphql
query {
  repo: repository(owner: "o", name: "r") {
    c1: object(expression: "HEAD:vault/chunks/abc") { ... on Blob { oid } }
    c2: object(expression: "HEAD:vault/chunks/def") { ... on Blob { oid } }
  }
}
```

### Limitations

| Constraint | Impact |
|------------|--------|
| Query complexity limit (~500k points) | Caps aliases per request (~50–100 paths practical) |
| No native multi-path batch REST equivalent | GraphQL is the only batch option |
| `raw.githubusercontent.com` remains **zero quota** | GraphQL is worse than raw HEAD for public repos |
| Private repos need auth for raw URLs | GraphQL may help authenticated private blob checks |
| Backup sync needs **write** (`createOrUpdateFileContents`) | GraphQL cannot replace Contents API writes |

### Recommendation

1. **Keep raw HEAD/GET** as primary path (zero quota) — already implemented in `chunk-lookup-cache.js`.
2. **Use GraphQL batch** only for reconcile passes on private repos when raw fails with 404 ambiguity — future optimization.
3. **Do not migrate uploads** — Contents API PUT remains required.

### Estimated savings

- Reconcile 50 chunks: 50 REST calls → 1 GraphQL query (49 saved) when raw unavailable.
- With 404 cache hit rate >90% after warmup, GraphQL batch is low priority.

## Status

**Documented — not implemented.** Current 404 cache + raw URL strategy provides greater ROI.
