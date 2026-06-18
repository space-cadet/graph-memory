#!/usr/bin/env node
/**
 * knowledge-graph.js
 * ─────────────────────────────────────────────
 * Query and traverse the entity knowledge graph.
 * CLI interface for exploring entities, relationships, and paths.
 *
 * Usage:
 *   node knowledge-graph.js query "ts-quantum"          # find entity + neighbors
 *   node knowledge-graph.js path "Deepak" "ts-quantum"   # shortest path
 *   node knowledge-graph.js related "clerk"             # entities related to clerk
 *   node knowledge-graph.js stats                       # graph statistics
 *   node knowledge-graph.js export --format json|dot|gexf  # export graph
 *   node knowledge-graph.js search "quantum"            # fuzzy search entities
 */

const fs = require("fs");
const path = require("path");

const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const GRAPH_DIR = path.join(MEMORY_DIR, "graph");

/* ── SQLite ──────────────────────────────────── */
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  console.error("Install better-sqlite3: npm install -g better-sqlite3");
  process.exit(1);
}

/* ── Graph API ───────────────────────────────── */

class KnowledgeGraph {
  constructor() {
    this.db = db;
  }

  /** Get entity by name (case-insensitive) */
  getEntity(name) {
    const stmt = this.db.prepare(
      "SELECT * FROM entities WHERE name = ? COLLATE NOCASE OR canonical_name = ? COLLATE NOCASE"
    );
    return stmt.get(name, name);
  }

  /** Search entities by fuzzy match */
  searchEntities(query, type = null, limit = 20) {
    const sql = type
      ? `SELECT * FROM entities WHERE (name LIKE ? OR canonical_name LIKE ?) AND entity_type = ? ORDER BY mention_count DESC LIMIT ?`
      : `SELECT * FROM entities WHERE name LIKE ? OR canonical_name LIKE ? ORDER BY mention_count DESC LIMIT ?`;
    const pattern = `%${query}%`;
    const stmt = this.db.prepare(sql);
    return type ? stmt.all(pattern, pattern, type, limit) : stmt.all(pattern, pattern, limit);
  }

  /** Get all entities by type */
  getAllEntities(type = null) {
    if (type) {
      return this.db.prepare("SELECT * FROM entities WHERE entity_type = ? ORDER BY mention_count DESC").all(type);
    }
    return this.db.prepare("SELECT * FROM entities ORDER BY mention_count DESC").all();
  }

  /** Get neighbors of an entity */
  getNeighbors(name) {
    const outgoing = this.db.prepare(
      "SELECT r.*, e.name as target_name, e.entity_type as target_type FROM relationships r JOIN entities e ON r.target = e.name WHERE r.source = ? COLLATE NOCASE"
    ).all(name);
    
    const incoming = this.db.prepare(
      "SELECT r.*, e.name as source_name, e.entity_type as source_type FROM relationships r JOIN entities e ON r.source = e.name WHERE r.target = ? COLLATE NOCASE"
    ).all(name);
    
    return { outgoing, incoming };
  }

  /** Find shortest path between two entities (BFS) */
  findPath(start, end, maxDepth = 5) {
    const visited = new Set();
    const queue = [[start.toLowerCase()]];
    
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      
      if (current === end.toLowerCase()) {
        return path;
      }
      
      if (path.length > maxDepth) continue;
      if (visited.has(current)) continue;
      visited.add(current);
      
      const neighbors = this.db.prepare(
        "SELECT target as name FROM relationships WHERE source = ? COLLATE NOCASE UNION SELECT source as name FROM relationships WHERE target = ? COLLATE NOCASE"
      ).all(current, current);
      
      for (const n of neighbors) {
        if (!visited.has(n.name.toLowerCase())) {
          queue.push([...path, n.name.toLowerCase()]);
        }
      }
    }
    return null;
  }

  /** Get entities related to a given entity (shared neighbors) */
  getRelated(name, limit = 20) {
    return this.db.prepare(
      `SELECT e.*, COUNT(*) as shared_connections FROM entities e
       JOIN relationships r1 ON (r1.source = e.name AND r1.target = ?)
       OR (r1.target = e.name AND r1.source = ?)
       WHERE e.name != ?
       GROUP BY e.name
       ORDER BY shared_connections DESC
       LIMIT ?`
    ).all(name, name, name, limit);
  }

  /** Get graph statistics */
  getStats() {
    const entityCount = this.db.prepare("SELECT COUNT(*) as count FROM entities").get();
    const relCount = this.db.prepare("SELECT COUNT(*) as count FROM relationships").get();
    const typeBreakdown = this.db.prepare("SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type ORDER BY count DESC").all();
    const relTypeBreakdown = this.db.prepare("SELECT relation_type, COUNT(*) as count FROM relationships GROUP BY relation_type ORDER BY count DESC").all();
    
    return {
      entities: entityCount.count,
      relationships: relCount.count,
      entityTypes: typeBreakdown,
      relationshipTypes: relTypeBreakdown
    };
  }

  /** Export graph to JSON */
  exportJSON() {
    const entities = this.getAllEntities();
    const relationships = this.db.prepare("SELECT * FROM relationships").all();
    return { entities, relationships, exportedAt: new Date().toISOString() };
  }

  /** Export graph to DOT format (Graphviz) */
  exportDOT() {
    const entities = this.getAllEntities();
    const relationships = this.db.prepare("SELECT * FROM relationships").all();
    
    let dot = "digraph KnowledgeGraph {\n";
    dot += "  rankdir=LR;\n";
    dot += "  node [shape=box, style=rounded];\n\n";
    
    const colors = {
      person: "#e74c3c",
      project: "#3498db",
      tool: "#2ecc71",
      concept: "#9b59b6",
      file: "#f39c12",
      error: "#e67e22",
      institution: "#1abc9c",
      research_paper: "#34495e"
    };
    
    for (const e of entities) {
      const color = colors[e.entity_type] || "#95a5a6";
      dot += `  "${e.name}" [fillcolor="${color}", style="rounded,filled", fontcolor=white];\n`;
    }
    
    dot += "\n";
    
    for (const r of relationships) {
      dot += `  "${r.source}" -> "${r.target}" [label="${r.relation_type}", fontsize=10];\n`;
    }
    
    dot += "}\n";
    return dot;
  }

  /** Export graph to GEXF (Gephi-compatible) */
  exportGEXF() {
    const entities = this.getAllEntities();
    const relationships = this.db.prepare("SELECT * FROM relationships").all();
    
    let gexf = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://www.gexf.net/1.3" version="1.3">
  <meta lastmodifieddate="${new Date().toISOString().split("T")[0]}">
    <creator>Cloudy Knowledge Graph</creator>
    <description>Entity-relationship graph from journal files</description>
  </meta>
  <graph mode="static" defaultedgetype="directed">
    <nodes>\n`;
    
    for (const e of entities) {
      gexf += `      <node id="${e.name}" label="${e.name}">
        <attvalues>
          <attvalue for="type" value="${e.entity_type || "unknown"}"/>
          <attvalue for="mentions" value="${e.mention_count}"/>
        </attvalues>
      </node>\n`;
    }
    
    gexf += `    </nodes>
    <edges>\n`;
    
    let edgeId = 0;
    for (const r of relationships) {
      gexf += `      <edge id="${edgeId++}" source="${r.source}" target="${r.target}" label="${r.relation_type}"/>\n`;
    }
    
    gexf += `    </edges>
  </graph>
</gexf>`;
    return gexf;
  }

  /** Generate HTML visualization with D3.js */
  generateVisualization() {
    const entities = this.getAllEntities();
    const relationships = this.db.prepare("SELECT * FROM relationships LIMIT 1000").all();
    
    const nodes = entities.map(e => ({
      id: e.name,
      group: e.entity_type,
      size: Math.max(5, Math.min(30, e.mention_count * 3)),
      title: `${e.name} (${e.entity_type}, ${e.mention_count}×)`
    }));
    
    const links = relationships.map(r => ({
      source: r.source,
      target: r.target,
      type: r.relation_type || "related"
    }));
    
    const colors = {
      person: "#FF6B6B",
      project: "#4ECDC4",
      tool: "#45B7D1",
      concept: "#96CEB4",
      error: "#FFEAA7",
      file: "#DDA0DD",
      institution: "#FFA07A",
      research_paper: "#98D8C8",
      collaborator: "#F7DC6F",
      advisor: "#BB8FCE"
    };
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Knowledge Graph — Cloudy's Memory</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; font-family: -apple-system, sans-serif; background: #1a1a2e; }
    #graph { width: 100vw; height: 100vh; }
    .node circle { stroke: #fff; stroke-width: 1.5px; cursor: pointer; }
    .node text { font-size: 10px; fill: #fff; pointer-events: none; }
    .link { stroke: #999; stroke-opacity: 0.6; }
    .tooltip {
      position: absolute; padding: 8px; background: rgba(0,0,0,0.8);
      color: #fff; border-radius: 4px; font-size: 12px; pointer-events: none;
    }
    #legend {
      position: fixed; top: 10px; right: 10px;
      background: rgba(0,0,0,0.7); padding: 10px; border-radius: 8px;
      color: #fff; font-size: 12px;
    }
    #legend .color { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; }
    #stats {
      position: fixed; top: 10px; left: 10px;
      background: rgba(0,0,0,0.7); padding: 10px; border-radius: 8px;
      color: #fff; font-size: 12px;
    }
  </style>
</head>
<body>
  <div id="stats">
    <strong>Knowledge Graph</strong><br>
    ${nodes.length} entities<br>
    ${links.length} relationships
  </div>
  <div id="legend">
    ${Object.entries(colors).map(([type, color]) => 
      `<div><span class="color" style="background:${color}"></span>${type}</div>`
    ).join('')}
  </div>
  <div id="graph"></div>
  <div class="tooltip" style="display:none"></div>

  <script>
    const nodes = ${JSON.stringify(nodes)};
    const links = ${JSON.stringify(links)};
    const colors = ${JSON.stringify(colors)};

    const width = window.innerWidth;
    const height = window.innerHeight;

    const svg = d3.select("#graph").append("svg")
      .attr("width", width).attr("height", height);

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(80))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(d => d.size + 5));

    const link = svg.append("g").selectAll("line")
      .data(links).enter().append("line")
      .attr("class", "link")
      .attr("stroke-width", 1);

    const node = svg.append("g").selectAll("g")
      .data(nodes).enter().append("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended));

    node.append("circle")
      .attr("r", d => d.size)
      .attr("fill", d => colors[d.group] || "#ccc");

    node.append("text")
      .attr("dx", d => d.size + 3)
      .attr("dy", 3)
      .text(d => d.id.length > 20 ? d.id.slice(0, 18) + "..." : d.id);

    const tooltip = d3.select(".tooltip");
    node.on("mouseover", (event, d) => {
      tooltip.style("display", "block")
        .html(\`<strong>\${d.id}</strong><br>Type: \${d.group}<br>Mentions: \${d.title.match(/\\d+×/)[0]}\`)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 10) + "px");
    }).on("mouseout", () => tooltip.style("display", "none"));

    simulation.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
    });

    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    }
    function dragged(event, d) {
      d.fx = event.x; d.fy = event.y;
    }
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    }
  </script>
</body>
</html>`;
    
    return html;
  }
}

/* ── CLI ─────────────────────────────────────── */

const graph = new KnowledgeGraph();
const command = process.argv[2];
const arg = process.argv[3];

function printEntity(e) {
  if (!e) {
    console.log("Entity not found.");
    return;
  }
  console.log(`\n${e.name} [${e.entity_type}]`);
  console.log(`  Mentions: ${e.mention_count}`);
  console.log(`  First seen: ${e.first_seen}`);
  console.log(`  Last seen: ${e.last_seen}`);
  
  const neighbors = graph.getNeighbors(e.name);
  if (neighbors.outgoing.length > 0) {
    console.log(`\n  Outgoing (${neighbors.outgoing.length}):`);
    for (const n of neighbors.outgoing.slice(0, 10)) {
      console.log(`    → ${n.target_name} [${n.relation_type}]`);
    }
  }
  if (neighbors.incoming.length > 0) {
    console.log(`\n  Incoming (${neighbors.incoming.length}):`);
    for (const n of neighbors.incoming.slice(0, 10)) {
      console.log(`    ← ${n.source_name} [${n.relation_type}]`);
    }
  }
}

switch (command) {
  case "query": {
    const entity = graph.getEntity(arg);
    printEntity(entity);
    break;
  }
  
  case "search": {
    const type = process.argv.includes("--type") ? process.argv[process.argv.indexOf("--type") + 1] : null;
    const results = graph.searchEntities(arg, type);
    console.log(`Found ${results.length} entities matching "${arg}":\n`);
    for (const e of results) {
      console.log(`  ${e.name} [${e.entity_type}] — ${e.mention_count} mentions`);
    }
    break;
  }
  
  case "path": {
    const end = process.argv[4];
    const path = graph.findPath(arg, end);
    if (path) {
      console.log(`Path from "${arg}" to "${end}":`);
      console.log(path.join(" → "));
    } else {
      console.log(`No path found between "${arg}" and "${end}" within 5 hops.`);
    }
    break;
  }
  
  case "related": {
    const related = graph.getRelated(arg);
    console.log(`Entities related to "${arg}":\n`);
    for (const r of related) {
      console.log(`  ${r.name} [${r.entity_type}] — ${r.shared_connections} shared connections`);
    }
    break;
  }
  
  case "stats": {
    const stats = graph.getStats();
    console.log("Knowledge Graph Statistics");
    console.log("==========================");
    console.log(`Entities: ${stats.entities}`);
    console.log(`Relationships: ${stats.relationships}`);
    console.log(`\nEntity types:`);
    for (const t of stats.entityTypes) {
      console.log(`  ${t.entity_type || "uncategorized"}: ${t.count}`);
    }
    console.log(`\nRelationship types:`);
    for (const t of stats.relationshipTypes) {
      console.log(`  ${t.relation_type}: ${t.count}`);
    }
    break;
  }
  
  case "export": {
    const format = process.argv.includes("--format") ? process.argv[process.argv.indexOf("--format") + 1] : "json";
    const outputDir = path.join(MEMORY_DIR, "graph");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    let content, filename;
    switch (format) {
      case "dot":
        content = graph.exportDOT();
        filename = "graph.dot";
        break;
      case "gexf":
        content = graph.exportGEXF();
        filename = "graph.gexf";
        break;
      case "json":
      default:
        content = JSON.stringify(graph.exportJSON(), null, 2);
        filename = "graph.json";
    }
    
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, content);
    console.log(`Exported to ${outputPath}`);
    break;
  }
  
  case "list": {
    const type = arg || null;
    const entities = graph.getAllEntities(type);
    console.log(`${entities.length} entities${type ? ` of type "${type}"` : ""}:\n`);
    for (const e of entities.slice(0, 50)) {
      console.log(`  ${e.name} [${e.entity_type}] — ${e.mention_count} mentions`);
    }
    if (entities.length > 50) {
      console.log(`\n  ... and ${entities.length - 50} more`);
    }
    break;
  }
  
  case "visualize": {
    const html = graph.generateVisualization();
    const outputPath = path.join(GRAPH_DIR, "knowledge-graph.html");
    fs.writeFileSync(outputPath, html);
    console.log(`Visualization written to ${outputPath}`);
    break;
  }
  
  default:
    console.log(`Usage: node knowledge-graph.js <command> [args]

Commands:
  query <name>              Show entity details and neighbors
  search <query> [--type]   Search entities by name
  path <start> <end>        Find shortest path between entities
  related <name>            Find entities with shared connections
  stats                     Graph statistics
  export [--format]         Export to json/dot/gexf
  list [type]               List all entities (optionally filtered by type)
  visualize                 Generate HTML visualization

Examples:
  node knowledge-graph.js query "Deepak Vaid"
  node knowledge-graph.js search "quantum"
  node knowledge-graph.js path "Deepak" "Loop Quantum Gravity"
  node knowledge-graph.js export --format gexf
  node knowledge-graph.js visualize
`);
}

if (db && typeof db.close === "function") {
  db.close();
}
