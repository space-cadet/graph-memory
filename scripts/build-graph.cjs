#!/usr/bin/env node
/**
 * build-graph.cjs
 * ─────────────────────────────────────────────
 * Integration script that reads journal files from OpenClaw sessions
 * and builds the entity knowledge graph using entity-extractor.cjs.
 *
 * This is designed to be run periodically (e.g. via cron) to keep
 * the graph up-to-date with new journal entries.
 *
 * Usage:
 *   node build-graph.cjs                    # process all journals
 *   node build-graph.cjs --incremental     # only process new journals
 *   node build-graph.cjs --date 2026-05-21 # process specific date
 *   node build-graph.cjs --visualize       # build + generate HTML viz
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* ── Paths ───────────────────────────────────── */
const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const JOURNAL_DIR = path.join(MEMORY_DIR, "journal");
const GRAPH_DIR = path.join(MEMORY_DIR, "graph");
const SCRIPTS_DIR = path.join(MEMORY_DIR, "scripts");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const incremental = args.includes("--incremental");
const visualize = args.includes("--visualize");
const dateOverride = args.includes("--date")
  ? args[args.indexOf("--date") + 1]
  : null;

/* ── Ensure directories exist ─────────────────── */
if (!fs.existsSync(JOURNAL_DIR)) {
  console.error(`Journal directory not found: ${JOURNAL_DIR}`);
  console.error("Run the journal processor first to generate journal files.");
  process.exit(1);
}

if (!fs.existsSync(GRAPH_DIR)) {
  fs.mkdirSync(GRAPH_DIR, { recursive: true });
}

/* ── Run entity-extractor.cjs ─────────────────── */
console.log("Building knowledge graph from journal files...");

const extractorPath = path.join(SCRIPTS_DIR, "entity-extractor.cjs");
if (!fs.existsSync(extractorPath)) {
  console.error(`Entity extractor not found: ${extractorPath}`);
  process.exit(1);
}

if (dateOverride) {
  console.log(`Processing date: ${dateOverride}`);
  try {
    execSync(`node "${extractorPath}" --date ${dateOverride}`, {
      stdio: "inherit"
    });
  } catch (e) {
    console.error(`Failed to process ${dateOverride}: ${e.message}`);
    process.exit(1);
  }
} else {
  console.log("Processing all journal files...");
  try {
    execSync(`node "${extractorPath}"`, {
      stdio: "inherit"
    });
  } catch (e) {
    console.error(`Failed to process journals: ${e.message}`);
    process.exit(1);
  }
}

/* ── Generate statistics ─────────────────────── */
console.log("\nGraph statistics:");
try {
  const stats = execSync(`node "${path.join(SCRIPTS_DIR, "knowledge-graph.cjs")}" stats`, {
    encoding: "utf8"
  });
  console.log(stats);
} catch (e) {
  console.error("Could not get stats:", e.message);
}

/* ── Generate HTML visualization ─────────────── */
if (visualize) {
  console.log("\nGenerating HTML visualization...");
  try {
    execSync(`node "${path.join(SCRIPTS_DIR, "knowledge-graph.cjs")}" export --format json`, {
      stdio: "inherit"
    });
    
    // Generate HTML from the JSON export
    generateHTMLViz();
  } catch (e) {
    console.error("Could not generate visualization:", e.message);
  }
}

function generateHTMLViz() {
  const jsonPath = path.join(GRAPH_DIR, "graph.json");
  if (!fs.existsSync(jsonPath)) {
    console.error("No graph.json export found");
    return;
  }
  
  const graph = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Knowledge Graph</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
    #header { padding: 1rem 2rem; background: #1e293b; border-bottom: 1px solid #334155; }
    #header h1 { font-size: 1.25rem; font-weight: 600; }
    #header p { font-size: 0.875rem; color: #94a3b8; margin-top: 0.25rem; }
    #stats { display: flex; gap: 1.5rem; padding: 1rem 2rem; background: #1e293b; border-bottom: 1px solid #334155; }
    .stat { text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #38bdf8; }
    .stat-label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; }
    #controls { padding: 1rem 2rem; display: flex; gap: 1rem; align-items: center; }
    #controls input { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem; }
    #controls input:focus { outline: none; border-color: #38bdf8; }
    #controls select { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.875rem; }
    #network { flex: 1; height: calc(100vh - 200px); }
    .container { display: flex; flex-direction: column; height: 100vh; }
    #sidebar { position: fixed; right: 0; top: 200px; width: 300px; height: calc(100vh - 200px); background: #1e293b; border-left: 1px solid #334155; padding: 1rem; overflow-y: auto; transform: translateX(100%); transition: transform 0.3s; }
    #sidebar.open { transform: translateX(0); }
    #sidebar h3 { font-size: 1rem; margin-bottom: 0.75rem; color: #38bdf8; }
    #sidebar .entity-type { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase; margin-bottom: 0.5rem; }
    #sidebar .connections { margin-top: 1rem; }
    #sidebar .connection { padding: 0.5rem; border-radius: 4px; background: #0f172a; margin-bottom: 0.5rem; font-size: 0.875rem; }
    #sidebar .connection .rel-type { color: #94a3b8; font-size: 0.75rem; }
    #close-sidebar { float: right; background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1.25rem; }
  </style>
</head>
<body>
  <div class="container">
    <div id="header">
      <h1>🧠 Knowledge Graph</h1>
      <p>Entities and relationships extracted from journal files</p>
    </div>
    <div id="stats">
      <div class="stat"><div class="stat-value">${graph.entities.length}</div><div class="stat-label">Entities</div></div>
      <div class="stat"><div class="stat-value">${graph.relationships.length}</div><div class="stat-label">Relationships</div></div>
      <div class="stat"><div class="stat-value">${new Set(graph.entities.map(e => e.entity_type)).size}</div><div class="stat-label">Types</div></div>
    </div>
    <div id="controls">
      <input type="text" id="search" placeholder="Search entities..." />
      <select id="filter-type">
        <option value="">All types</option>
        <option value="person">People</option>
        <option value="project">Projects</option>
        <option value="tool">Tools</option>
        <option value="concept">Concepts</option>
        <option value="file">Files</option>
        <option value="error">Errors</option>
        <option value="institution">Institutions</option>
        <option value="research_paper">Research Papers</option>
      </select>
    </div>
    <div id="network"></div>
  </div>
  <div id="sidebar">
    <button id="close-sidebar">&times;</button>
    <h3 id="sidebar-title"></h3>
    <div id="sidebar-type" class="entity-type"></div>
    <div id="sidebar-details"></div>
    <div id="sidebar-connections" class="connections"></div>
  </div>
  
  <script>
    const entities = ${JSON.stringify(graph.entities)};
    const relationships = ${JSON.stringify(graph.relationships)};
    
    const colors = {
      person: '#e74c3c',
      project: '#3498db',
      tool: '#2ecc71',
      concept: '#9b59b6',
      file: '#f39c12',
      error: '#e67e22',
      institution: '#1abc9c',
      research_paper: '#34495e'
    };
    
    const nodes = new vis.DataSet(entities.map(e => ({
      id: e.name,
      label: e.name,
      color: { background: colors[e.entity_type] || '#95a5a6', border: '#fff' },
      font: { color: '#fff', size: 14 },
      shape: 'dot',
      size: Math.max(10, Math.min(30, e.mention_count * 2)),
      title: \`\${e.name} (\${e.mention_count} mentions)\`
    })));
    
    const edges = new vis.DataSet(relationships.map(r => ({
      from: r.source,
      to: r.target,
      label: r.relation_type,
      font: { color: '#94a3b8', size: 10 },
      color: { color: '#475569' },
      arrows: 'to'
    })));
    
    const container = document.getElementById('network');
    const data = { nodes, edges };
    const options = {
      physics: { stabilization: false, barnesHut: { gravitationalConstant: -2000, springConstant: 0.04 } },
      interaction: { hover: true, tooltipDelay: 200 }
    };
    
    const network = new vis.Network(container, data, options);
    
    network.on('click', function(params) {
      if (params.nodes.length > 0) {
        const entityName = params.nodes[0];
        const entity = entities.find(e => e.name === entityName);
        if (entity) {
          showSidebar(entity);
        }
      }
    });
    
    function showSidebar(entity) {
      document.getElementById('sidebar-title').textContent = entity.name;
      document.getElementById('sidebar-type').textContent = entity.entity_type;
      document.getElementById('sidebar-type').style.background = colors[entity.entity_type] || '#95a5a6';
      document.getElementById('sidebar-details').innerHTML = \`
        <p><strong>Mentions:</strong> \${entity.mention_count}</p>
        <p><strong>First seen:</strong> \${entity.first_seen}</p>
        <p><strong>Last seen:</strong> \${entity.last_seen}</p>
      \`;
      
      const rels = relationships.filter(r => r.source === entity.name || r.target === entity.name);
      document.getElementById('sidebar-connections').innerHTML = rels.slice(0, 20).map(r => \`
        <div class="connection">
          <div>\${r.source} \u2192 \${r.target}</div>
          <div class="rel-type">\${r.relation_type}</div>
        </div>
      \`).join('');
      
      document.getElementById('sidebar').classList.add('open');
    }
    
    document.getElementById('close-sidebar').addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
    });
    
    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const filtered = entities.filter(en => en.name.toLowerCase().includes(query));
      nodes.clear();
      nodes.add(filtered.map(e => ({
        id: e.name,
        label: e.name,
        color: { background: colors[e.entity_type] || '#95a5a6', border: '#fff' },
        font: { color: '#fff', size: 14 },
        shape: 'dot',
        size: Math.max(10, Math.min(30, e.mention_count * 2))
      })));
    });
    
    document.getElementById('filter-type').addEventListener('change', (e) => {
      const type = e.target.value;
      const filtered = type ? entities.filter(en => en.entity_type === type) : entities;
      nodes.clear();
      nodes.add(filtered.map(e => ({
        id: e.name,
        label: e.name,
        color: { background: colors[e.entity_type] || '#95a5a6', border: '#fff' },
        font: { color: '#fff', size: 14 },
        shape: 'dot',
        size: Math.max(10, Math.min(30, e.mention_count * 2))
      })));
    });
  </script>
</body>
</html>`;
  
  const htmlPath = path.join(GRAPH_DIR, "knowledge-graph.html");
  fs.writeFileSync(htmlPath, html);
  console.log(`\nVisualization generated: ${htmlPath}`);
  console.log(`Open in browser: file://${htmlPath}`);
}

console.log("\n✅ Graph build complete!");
console.log(`Database: ${DB_PATH}`);
console.log(`\nQuery commands:`);
console.log(`  node scripts/knowledge-graph.cjs stats`);
console.log(`  node scripts/knowledge-graph.cjs query "User Name"`);
console.log(`  node scripts/knowledge-graph.cjs search "quantum"`);
console.log(`  node scripts/knowledge-graph.cjs export --format gexf`);
