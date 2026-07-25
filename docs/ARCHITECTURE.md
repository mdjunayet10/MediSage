# MediSage Architecture

```mermaid
flowchart LR
    U[Browser user] --> R[React interface]
    R -->|JSON or multipart PDF| E[Express API]
    E -->|In-memory buffer| P[Local PDF.js]
    P -->|Page text + stable chunks| D[Temporary DocumentStore]
    D --> X[Local BM25 retrieval]
    K[Optional local JSONL sample] --> X
    X -->|4–6 relevant text passages| E
    E -->|Text-only request| O[OpenRouter free model]
    O -->|Candidate answer| E
    E -->|Validated answer, separate safety, citations + excerpts| R
```

## PDF upload and summary

```mermaid
sequenceDiagram
    participant User
    participant UI as React UI
    participant API as Express API
    participant PDF as Local PDF.js
    participant Memory as Temporary memory
    participant OR as OpenRouter free model

    User->>UI: Drop text-based PDF
    UI->>API: Multipart upload
    API->>API: Validate size, signature, filename
    API->>PDF: Extract buffer locally
    PDF-->>API: Page-numbered text
    API->>API: Normalize, chunk, index, discard buffer
    API->>OR: Bounded representative text only
    OR-->>API: Candidate summary
    API->>API: Reject classifier-only or malformed output
    API->>API: Validate citation IDs
    API->>Memory: Store pages/chunks/index with TTL
    API-->>UI: Summary + page sources
```

## Grounded follow-up

```mermaid
sequenceDiagram
    participant User
    participant UI as React UI
    participant API as Express API
    participant BM as Local BM25 index
    participant OR as OpenRouter free model

    User->>UI: Ask about active PDF
    UI->>API: Chat + temporary document ID
    API->>BM: Search only active document chunks
    BM-->>API: Top relevant page chunks
    API->>API: Evaluate urgent-symptom safety separately
    API->>OR: Safety guidance + text passages + chat
    OR-->>API: Candidate answer with inline source IDs
    API->>API: Reject classifier-only output and remove unknown citations
    API-->>UI: Nested answer + safety + actual retrieved sources
```

## Security and privacy boundaries

- Free-only model validation happens during configuration and again when building every provider payload.
- Provider failures and invalid classifier-only outputs retry an ordered, bounded fallback list; authentication failures do not retry.
- Safety classification is computed locally and remains a separate response field; it can never replace `data.answer`.
- No OpenRouter request contains a file, file data, parser plugin, embedding request, or search request.
- The OpenRouter key remains in the backend environment.
- The PDF signature, byte size, page count, character count, filename, JSON body, and history length are bounded or validated.
- The original upload buffer is discarded after local extraction.
- Extracted document content stays in process memory until deletion, expiry, eviction, or restart.
- The client receives only relevant excerpts, never the complete extracted document.
- Basic per-IP rate limiting protects all `/api` endpoints.
