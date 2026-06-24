#!/usr/bin/env node
/**
 * llm-extractor.cjs
 * ─────────────────────────────────────────────
 * LLM-based entity/decision/topic/question extraction from conversation text.
 * Uses any OpenAI-compatible API. Falls back to regex-based extraction on failure.
 *
 * Exports:
 *   extractWithLLM(text, options)  → Promise<{entities, decisions, topics, questions}>
 *   extractBatch(chunks, options)  → Promise<merged results>
 *   createChunks(text, maxChars)   → Array<string>
 *
 * Usage:
 *   const { extractWithLLM } = require('./llm-extractor.cjs');
 *   const result = await extractWithLLM(sessionText, { apiKey: '...' });
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/* ── Defaults ────────────────────────────────── */
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CHUNK_SIZE = 8000; // chars per LLM call

/* ── Prompt template ─────────────────────────── */
const SYSTEM_PROMPT = `You are an entity extraction engine. Analyze the following conversation text and extract structured information.

Return ONLY a JSON object with this exact shape (no markdown, no explanation):

{
  "entities": [
    {
      "name": "string",
      "type": "one of: person | project | file | tool | concept | institution | research_paper | task | error | decision | topic",
      "confidence": 0.0 to 1.0,
      "description": "brief description of what this entity is",
      "context": "exact snippet from text where this was found"
    }
  ],
  "decisions": [
    {
      "text": "the decision made",
      "confidence": 0.0 to 1.0,
      "context": "surrounding text showing the decision"
    }
  ],
  "topics": [
    {
      "name": "topic name",
      "confidence": 0.0 to 1.0,
      "context": "relevant text snippet"
    }
  ],
  "questions": [
    {
      "text": "the question",
      "confidence": 0.0 to 1.0,
      "context": "surrounding text"
    }
  ]
}

Rules:
- Extract ONLY items clearly present in the text
- Confidence reflects your certainty (1.0 = explicit mention, 0.5 = inferred)
- Context must be a verbatim substring from the input
- Keep descriptions concise (≤ 20 words)
- If nothing relevant is found, return empty arrays
- Never hallucinate entities not in the text`;

/* ── Simple regex fallback patterns ──────────── */
const FALLBACK_PATTERNS = {
  explicitLink: /\[\[([^\]]+)\]\]/g,
  projectPath: /(?:~\/code\/|src\/|workspace\/|projects\/)([a-zA-Z][a-zA-Z0-9_-]*)/g,
  tool: /\b(?:npm|pnpm|yarn|npx|git|curl|node|python|docker|vercel|supabase|clerk|esbuild|vite|tsc|playwright|qiskit|qutip|julia|sagemath|pytorch)\b/gi,
  file: /\b([A-Z][a-zA-Z]*\.md|[a-z][a-z0-9_-]*\.(?:ts|tsx|js|jsx|json|py|sh|yml|yaml|css|html))\b/g,
  arxivId: /\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/g,
  arxivRef: /arXiv:\s*(\d{4}\.\d{4,5})/gi,
  error: /Error:\s*([^\n]+)|Failed to\s+([^\n]+)/g,
  githubRepo: /github\.com\/[^\/\s]+\/([a-zA-Z0-9_-]+)/g,
  taskRef: /\b(T\d{1,3})\b/g,
  decision: /(?:decision|decided|agreed|concluded)\s*:?\s*([^\n]+)/gi,
  question: /\b(what|how|why|when|where|who|which|is|are|does|do|can|could|would|will)\s+[^?]+\?/gi,
};

function guessEntityType(name) {
  if (/\.(md|ts|tsx|js|json|py)$/.test(name)) return 'file';
  if (/^(npm|pnpm|yarn|git|curl|node|docker|vercel|supabase|clerk)$/.test(name)) return 'tool';
  if (/^arXiv:/.test(name)) return 'research_paper';
  if (/^T\d+$/.test(name)) return 'task';
  if (/^Error:/.test(name)) return 'error';
  if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(name) && name.includes(' ')) return 'concept';
  return 'project';
}

function isCommonWord(word) {
  const common = new Set([
    'src', 'lib', 'dist', 'build', 'node_modules', 'public', 'assets',
    'components', 'pages', 'hooks', 'utils', 'types', 'contexts',
    'test', 'spec', 'docs', 'config', 'scripts', 'api', 'code',
    'workspace', 'projects', 'tmp', 'temp', 'cache', 'data'
  ]);
  return common.has(word.toLowerCase());
}

/* ── HTTP POST helper (built-in only) ────────── */
function postJSON(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${json.error?.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/* ── Chunking ────────────────────────────────── */
function createChunks(text, maxChars = DEFAULT_MAX_CHUNK_SIZE) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at a newline or sentence boundary
    if (end < text.length) {
      const newlineIdx = text.lastIndexOf('\n', end);
      const sentenceIdx = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('? ', end),
        text.lastIndexOf('! ', end)
      );
      const breakPoint = Math.max(newlineIdx, sentenceIdx);
      if (breakPoint > start + maxChars * 0.5) {
        end = breakPoint + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end;
  }

  return chunks;
}

/* ── LLM extraction for a single chunk ───────── */
async function extractChunk(chunk, options = {}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.KIMI_API_KEY;
  const baseURL = (options.baseURL || process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const model = options.model || process.env.LLM_MODEL || DEFAULT_MODEL;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    throw new Error('No API key provided. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or pass apiKey option.');
  }

  const url = `${baseURL}/chat/completions`;

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: chunk },
    ],
    ...(baseURL.includes('openai.com') || baseURL.includes('openrouter.ai')
      ? { response_format: { type: 'json_object' } }
      : {}),
  };

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    ...(baseURL.includes('openrouter')
      ? { 'HTTP-Referer': 'https://quantumofgravity.com', 'X-Title': 'graph-memory-extractor' }
      : {}),
  };

  const response = await postJSON(url, headers, body, timeoutMs);
  const content = response.choices?.[0]?.message?.content || '';

  // Parse JSON from response
  let parsed;
  try {
    // Handle possible markdown code blocks
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/```([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${e.message}\nContent: ${content.slice(0, 300)}`);
  }

  return {
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
  };
}

/* ── Deduplicate by name ─────────────────────── */
function deduplicate(items, keyFn = (x) => x.name || x.text) {
  const seen = new Map();
  for (const item of items) {
    const key = (keyFn(item) || '').toLowerCase().trim();
    if (!key) continue;
    if (seen.has(key)) {
      // Keep higher confidence
      if ((item.confidence || 0) > (seen.get(key).confidence || 0)) {
        seen.set(key, item);
      }
    } else {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

/* ── Main exported function: extractWithLLM ──── */
async function extractWithLLM(text, options = {}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { entities: [], decisions: [], topics: [], questions: [], fallback: false };
  }

  const maxChunkSize = options.maxChunkSize || DEFAULT_MAX_CHUNK_SIZE;
  const chunks = createChunks(text, maxChunkSize);

  try {
    const results = [];
    for (const chunk of chunks) {
      const result = await extractChunk(chunk, options);
      results.push(result);
    }

    // Merge results from all chunks
    const merged = {
      entities: deduplicate(results.flatMap((r) => r.entities)),
      decisions: deduplicate(results.flatMap((r) => r.decisions), (d) => d.text),
      topics: deduplicate(results.flatMap((r) => r.topics)),
      questions: deduplicate(results.flatMap((r) => r.questions), (q) => q.text),
      fallback: false,
    };

    return merged;
  } catch (error) {
    // Log error and fall back to regex
    if (!options.silent) {
      console.error(`[llm-extractor] LLM extraction failed: ${error.message}`);
      console.error(`[llm-extractor] Falling back to regex extraction...`);
    }

    const fallback = extractWithRegex(text);
    return { ...fallback, fallback: true, error: error.message };
  }
}

/* ── Regex fallback ──────────────────────────── */
function extractWithRegex(text) {
  const entities = [];
  const decisions = [];
  const topics = [];
  const questions = [];
  let match;

  // Entities from patterns
  for (const [patternName, pattern] of Object.entries(FALLBACK_PATTERNS)) {
    if (patternName === 'decision' || patternName === 'question') continue;

    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      let name, type;

      if (patternName === 'explicitLink') {
        name = match[1].trim();
        type = guessEntityType(name);
      } else if (patternName === 'projectPath') {
        name = match[1];
        if (isCommonWord(name)) continue;
        type = 'project';
      } else if (patternName === 'githubRepo') {
        name = match[1];
        type = 'project';
      } else if (patternName === 'tool') {
        name = match[0].toLowerCase();
        type = 'tool';
      } else if (patternName === 'file') {
        name = match[1];
        type = 'file';
      } else if (patternName === 'arxivId') {
        name = `arXiv:${match[1]}`;
        type = 'research_paper';
      } else if (patternName === 'arxivRef') {
        name = `arXiv:${match[1]}`;
        type = 'research_paper';
      } else if (patternName === 'error') {
        name = `Error: ${(match[1] || match[2]).trim()}`;
        type = 'error';
      } else if (patternName === 'taskRef') {
        name = match[1].toUpperCase();
        type = 'task';
      } else {
        continue;
      }

      entities.push({
        name,
        type,
        confidence: 0.7,
        description: `Detected via regex pattern: ${patternName}`,
        context: match[0],
      });
    }
  }

  // Decisions
  FALLBACK_PATTERNS.decision.lastIndex = 0;
  while ((match = FALLBACK_PATTERNS.decision.exec(text)) !== null) {
    decisions.push({
      text: match[1].trim(),
      confidence: 0.6,
      context: match[0],
    });
  }

  // Questions
  FALLBACK_PATTERNS.question.lastIndex = 0;
  while ((match = FALLBACK_PATTERNS.question.exec(text)) !== null) {
    questions.push({
      text: match[0].trim(),
      confidence: 0.8,
      context: match[0],
    });
  }

  return {
    entities: deduplicate(entities),
    decisions: deduplicate(decisions, (d) => d.text),
    topics,
    questions: deduplicate(questions, (q) => q.text),
  };
}

/* ── Batch extraction (for multiple chunks) ──── */
async function extractBatch(chunks, options = {}) {
  const allResults = [];

  for (let i = 0; i < chunks.length; i++) {
    if (!options.silent) {
      console.error(`[llm-extractor] Processing chunk ${i + 1}/${chunks.length}...`);
    }
    const result = await extractWithLLM(chunks[i], options);
    allResults.push(result);
  }

  return {
    entities: deduplicate(allResults.flatMap((r) => r.entities)),
    decisions: deduplicate(allResults.flatMap((r) => r.decisions), (d) => d.text),
    topics: deduplicate(allResults.flatMap((r) => r.topics)),
    questions: deduplicate(allResults.flatMap((r) => r.questions), (q) => q.text),
    fallback: allResults.every((r) => r.fallback),
  };
}

/* ── CLI smoke test ──────────────────────────── */
async function main() {
  const text = process.argv.slice(2).join(' ') ||
    `Deepak decided to use Qiskit for the quantum simulation project. He also mentioned arXiv:2401.12345 in the context of black hole thermodynamics. The next step is to implement the T34 task using TypeScript.`;

  console.error('Testing llm-extractor...');
  console.error(`Input: ${text.slice(0, 100)}...`);

  const result = await extractWithLLM(text, { silent: false });

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

/* ── Exports ─────────────────────────────────── */
module.exports = {
  extractWithLLM,
  extractBatch,
  createChunks,
  extractWithRegex, // exposed for testing
};
