# Hybrid Search Feature Sample

A TypeScript code excerpt illustrating product search that combines lexical Elasticsearch results and vector nearest neighbors using Reciprocal Rank Fusion (RRF).

**Source:** [rrf-search.snippet.ts](./features/rrf-search.snippet.ts)

## Purpose

This feature shows how I coordinate two retrieval paths, combine their rankings, apply pagination after fusion, and retain lexical search when query embeddings are unavailable.

## Reciprocal Rank Fusion

The `rrfFuse` helper accumulates a contribution for each product ID from every ranked list:

```text
contribution = 1 / (k + rank)
```

Rank starts at one, and the default `k` is 60. Products appearing in multiple lists receive summed contributions. Original Elasticsearch score magnitudes are not used in this calculation.

**What this demonstrates:** combining ranked sources through a shared rank-based score without requiring their raw scores to have the same scale.

## Parallel Retrieval

- Requests a query embedding through a separate client.
- Runs lexical and vector searches concurrently with `Promise.all` when a vector is available.
- Fetches a candidate window of at least 50 results, growing it to cover the requested page offset and size.
- Supplies a boolean query to the lexical search and filter clauses to the vector search.
- Includes the category restriction in the vector filter as well as the lexical post-filter.
- Requests IDs, scores, and category aggregations without full source documents.

**What this demonstrates:** coordinating multiple retrieval paths while making filter placement explicit.

## Fusion and Result Metadata

- Converts both responses into product ID and score lists.
- Fuses rankings, sorts by the combined score, and slices the requested page.
- Returns the lexical query's hit count as `total`.
- Combines category IDs extracted from both responses.

**What this demonstrates:** separating ranking, pagination, and metadata policy when semantic neighbors augment lexical results.

## Embedding Failure Fallback

- Treats embedding exceptions and null responses as embedding failures.
- Tracks consecutive failures and opens an embedding circuit for a configured duration after a threshold is reached.
- Skips embedding requests while that circuit remains open.
- Uses a lexical-only Elasticsearch request when no vector is available.
- Records Elasticsearch success or failure through separate surrounding-service methods.

**What this demonstrates:** preserving a primary retrieval path when an auxiliary embedding dependency is unavailable.

## Technologies

TypeScript, Elasticsearch lexical queries and kNN retrieval, asynchronous embedding generation, Promise-based concurrency, and Reciprocal Rank Fusion.

## Excerpt Context and Behavior Boundaries

This is an incomplete source snippet, preserved as supplied. The helper's closing brace and the enclosing class/method structure are incomplete, so the file is not a standalone compilable TypeScript module.

Types, index constants, query construction, category extraction, embedding-client implementation, circuit settings, and Elasticsearch failure tracking belong to the surrounding service. The copied file has a descriptive filename; its contents are unchanged.

Fusion considers only the retrieved candidate windows. The returned lexical total is not a count of the fused result set, and deep-pagination behavior depends on retrieval limits and surrounding configuration. If either Elasticsearch request rejects in the parallel branch, that branch reports a failure rather than returning the other response alone.

Descriptions are based on source inspection. The snippet has not been compiled or executed, and Elasticsearch version compatibility has not been verified for this collection.

## Portfolio Message

I can express hybrid-search orchestration with explicit ranking fusion, filter handling, pagination policy, and fallback behavior for unavailable embeddings.
