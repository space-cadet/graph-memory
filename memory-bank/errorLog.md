# Error Log

## 2026-08-30 — BLOB Decoding Bug in Semantic Search

**Task:** T7 (Vector Embeddings + Semantic Search)  
**File:** `scripts/query-bridge.cjs`  
**Severity:** High — semantic search returning garbage results

### Symptoms
- Cosine similarity scores near zero (~0.001-0.01) for all queries
- Semantic search ranked unrelated entities above relevant ones
- No error thrown — silent data corruption

### Root Cause
`node:sqlite` (Node 22+ built-in SQLite) returns BLOB columns as `Uint8Array`. `better-sqlite3` returns them as `Buffer`. The code used:

```javascript
const emb = new Float32Array(row.embedding);
```

When `row.embedding` is a `Uint8Array` (1,536 bytes), `new Float32Array(Uint8Array)` creates a Float32Array view where **each byte becomes one float element**, producing 1,536 floats instead of 384. The byte-level reinterpretation is completely wrong.

### Fix Applied
Added `blobToFloat32()` in `scripts/query-bridge.cjs`:

```javascript
function blobToFloat32(blob) {
  if (blob instanceof Float32Array) return blob;
  if (Array.isArray(blob)) return Float32Array.from(blob);

  if (ArrayBuffer.isView(blob)) {
    if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`Invalid embedding BLOB length: ${blob.byteLength} bytes`);
    }
    return new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
  }

  if (blob instanceof ArrayBuffer) {
    if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`Invalid embedding BLOB length: ${blob.byteLength} bytes`);
    }
    return new Float32Array(blob, 0, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }

  throw new Error(`Unsupported embedding value: ${typeof blob}`);
}
```

Key rule: Use `new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)` for `ArrayBuffer.isView` inputs. Never `new Float32Array(blob)` directly.

### Prevention
- Always wrap BLOB-to-typed-array conversion in a validation function
- Check `byteLength % 4 === 0` before creating Float32Array
- Test with both `better-sqlite3` and `node:sqlite` drivers

### Validation
After fix: `node scripts/query-bridge.cjs "quantum computing" --similarity` returns valid scores (0.3-0.8 range).

---

*(Previous errors logged in DB — this file is for significant or recurring issues)*
