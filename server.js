#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs/promises');
const path = require('path');
const Fuse = require('fuse.js');

const memoryFilePath = path.join(__dirname, 'memory.json');
const server = new Server({
  name: 'memory-server-mcp',
  version: '1.0.2'
}, {
  capabilities: {
    tools: {}
  }
});

async function cleanExpiredMemories(memory) {
    const now = new Date();
    let changed = false;
    for (const key in memory) {
        if (memory[key].expires_at && new Date(memory[key].expires_at) < now) {
            delete memory[key];
            changed = true;
        }
    }
    if (changed) {
        await fs.writeFile(memoryFilePath, JSON.stringify(memory, null, 2));
    }
    return memory;
}

function createFuseInstance(memories, options = {}) {
    const searchableData = Object.entries(memories).map(([key, memory]) => ({
        key,
        value: memory.value,
        tags: memory.tags ? memory.tags.join(' ') : '',
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        size: memory.value.length
    }));
    
    const fuseOptions = {
        keys: [
            { name: 'key', weight: 0.4 },
            { name: 'value', weight: 0.5 },
            { name: 'tags', weight: 0.3 }
        ],
        threshold: options.threshold || 0.3,
        includeScore: true,
        includeMatches: true,
        minMatchCharLength: 2,
        ...options
    };
    
    return new Fuse(searchableData, fuseOptions);
}

function fuzzySearch(memories, query, options = {}) {
    const fuse = createFuseInstance(memories, options);
    const results = fuse.search(query);
    
    return results.map(result => ({
        key: result.item.key,
        score: result.score,
        similarity: 1 - result.score,
        matches: result.matches ? result.matches.map(match => ({
            field: match.key,
            value: match.value,
            indices: match.indices
        })) : []
    }));
}

function findRelatedMemories(memories, targetKey, options = {}) {
    const { includeContent = true, includeTags = true, includeLinks = true, maxResults = 10, minSimilarity = 0.3 } = options;
    if (!memories[targetKey]) return [];
    
    const targetMemory = memories[targetKey];
    const relatedMemories = [];
    
    if (includeContent && targetMemory.value) {
        const contentResults = fuzzySearch(memories, targetMemory.value, { threshold: minSimilarity });
        for (const result of contentResults) {
            if (result.key !== targetKey) {
                relatedMemories.push({ key: result.key, similarity: result.similarity, reason: 'content_similarity', score: result.similarity * 0.6 });
            }
        }
    }
    
    if (includeTags && targetMemory.tags && targetMemory.tags.length > 0) {
        for (const [key, memory] of Object.entries(memories)) {
            if (key !== targetKey && memory.tags && memory.tags.length > 0) {
                const sharedTags = targetMemory.tags.filter(tag => memory.tags.includes(tag));
                if (sharedTags.length > 0) {
                    const tagSimilarity = sharedTags.length / Math.max(targetMemory.tags.length, memory.tags.length);
                    relatedMemories.push({ key, similarity: tagSimilarity, reason: 'shared_tags', shared_tags: sharedTags, score: tagSimilarity * 0.8 });
                }
            }
        }
    }
    
    if (includeLinks) {
        if (targetMemory.links) {
            for (const link of targetMemory.links) {
                if (memories[link.target_key]) {
                    relatedMemories.push({ key: link.target_key, similarity: 1.0, reason: 'direct_link', relationship: link.relationship_type, score: 1.0 });
                }
            }
        }
        
        for (const [key, memory] of Object.entries(memories)) {
            if (key !== targetKey && memory.links) {
                const linkToTarget = memory.links.find(link => link.target_key === targetKey);
                if (linkToTarget) {
                    relatedMemories.push({ key, similarity: 1.0, reason: 'reverse_link', relationship: linkToTarget.relationship_type, score: 0.9 });
                }
            }
        }
    }
    
    const uniqueMemories = new Map();
    for (const related of relatedMemories) {
        const existing = uniqueMemories.get(related.key);
        if (!existing || related.score > existing.score) {
            uniqueMemories.set(related.key, related);
        }
    }
    
    return Array.from(uniqueMemories.values()).sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function findShortestPath(memories, fromKey, toKey) {
    if (!memories[fromKey] || !memories[toKey] || fromKey === toKey) return null;
    
    const visited = new Set();
    const queue = [{ key: fromKey, path: [fromKey] }];
    
    while (queue.length > 0) {
        const { key, path } = queue.shift();
        if (visited.has(key)) continue;
        visited.add(key);
        
        if (key === toKey) {
            return {
                path,
                length: path.length - 1,
                connections: path.slice(1).map((targetKey, i) => {
                    const sourceKey = path[i];
                    const sourceMemory = memories[sourceKey];
                    const link = sourceMemory.links?.find(l => l.target_key === targetKey);
                    return { from: sourceKey, to: targetKey, relationship: link?.relationship_type || 'reverse_link' };
                })
            };
        }
        
        const currentMemory = memories[key];
        if (currentMemory && currentMemory.links) {
            for (const link of currentMemory.links) {
                if (!visited.has(link.target_key) && memories[link.target_key]) {
                    queue.push({ key: link.target_key, path: [...path, link.target_key] });
                }
            }
        }
        
        for (const [memKey, mem] of Object.entries(memories)) {
            if (mem.links && !visited.has(memKey)) {
                const hasLinkToCurrent = mem.links.some(link => link.target_key === key);
                if (hasLinkToCurrent) {
                    queue.push({ key: memKey, path: [...path, memKey] });
                }
            }
        }
    }
    
    return null;
}

function findMemoriesWithinDegrees(memories, startKey, maxDegrees = 2, relationship = null) {
    if (!memories[startKey]) return [];
    
    const visited = new Set();
    const results = [];
    const queue = [{ key: startKey, degree: 0, path: [] }];
    
    while (queue.length > 0) {
        const { key, degree, path } = queue.shift();
        if (visited.has(key) || degree > maxDegrees) continue;
        visited.add(key);
        
        if (degree > 0) {
            results.push({ key, degree, path: [...path, key], memory: memories[key] });
        }
        
        const currentMemory = memories[key];
        if (currentMemory && currentMemory.links) {
            for (const link of currentMemory.links) {
                if (!relationship || link.relationship_type === relationship) {
                    if (!visited.has(link.target_key) && memories[link.target_key]) {
                        queue.push({ key: link.target_key, degree: degree + 1, path: [...path, key] });
                    }
                }
            }
        }
        
        for (const [memKey, mem] of Object.entries(memories)) {
            if (mem.links && !visited.has(memKey)) {
                const hasLinkToCurrentKey = mem.links.some(link => link.target_key === key && (!relationship || link.relationship_type === relationship));
                if (hasLinkToCurrentKey) {
                    queue.push({ key: memKey, degree: degree + 1, path: [...path, key] });
                }
            }
        }
    }
    
    return results.sort((a, b) => a.degree - b.degree);
}

function searchByRelationshipPattern(memories, pattern) {
    const parts = pattern.split(' ');
    if (parts.length !== 3) return [];
    
    const [sourcePattern, relationshipPattern, targetPattern] = parts;
    const results = [];
    
    for (const [key, memory] of Object.entries(memories)) {
        if (!memory.links) continue;
        
        for (const link of memory.links) {
            const sourceMatch = sourcePattern === '*' || sourcePattern === key;
            const relationshipMatch = relationshipPattern === '*' || relationshipPattern === link.relationship_type;
            const targetMatch = targetPattern === '*' || targetPattern === link.target_key;
            
            if (sourceMatch && relationshipMatch && targetMatch) {
                results.push({ source: key, target: link.target_key, relationship: link.relationship_type, source_memory: memory, target_memory: memories[link.target_key] });
            }
        }
    }
    
    return results;
}

async function initializeMemoryFile() {
    try {
        await fs.access(memoryFilePath);
        const content = await fs.readFile(memoryFilePath, 'utf8');
        if (!content.trim()) {
            await fs.writeFile(memoryFilePath, '{}');
        }
    } catch (error) {
        await fs.writeFile(memoryFilePath, '{}');
    }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'save_memory',
        description: 'Save a value with a key to memory, optionally with tags and expiration',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to store the value under' },
            value: { type: 'string', description: 'The value to store' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
            expires_in_seconds: { type: 'number', description: 'Optional expiration time in seconds' }
          },
          required: ['key', 'value']
        }
      },
      {
        name: 'recall_memory',
        description: 'Retrieve a value by key from memory, with optional related memories',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to retrieve' },
            include_related: { type: 'boolean', description: 'Include related memories in response' },
            max_related: { type: 'number', description: 'Maximum number of related memories to return' }
          },
          required: ['key']
        }
      },
      {
        name: 'list_memories',
        description: 'List all memory keys, optionally filtered by tag',
        inputSchema: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'Optional tag to filter by' }
          }
        }
      },
      {
        name: 'delete_memory',
        description: 'Delete a memory by key',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to delete' }
          },
          required: ['key']
        }
      },
      {
        name: 'list_all_tags',
        description: 'List all unique tags used across all memories',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'search_memory_content',
        description: 'Search memory content using fuzzy search',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' }
          },
          required: ['query']
        }
      },
      {
        name: 'link_memories',
        description: 'Create a link between two memories with a relationship type',
        inputSchema: {
          type: 'object',
          properties: {
            source_key: { type: 'string', description: 'The source memory key' },
            target_key: { type: 'string', description: 'The target memory key' },
            relationship_type: { type: 'string', description: 'Type of relationship (e.g., related_to, depends_on)' }
          },
          required: ['source_key', 'target_key', 'relationship_type']
        }
      },
      {
        name: 'get_linked_memories',
        description: 'Get all memories linked from a source memory',
        inputSchema: {
          type: 'object',
          properties: {
            source_key: { type: 'string', description: 'The source memory key' },
            relationship_type: { type: 'string', description: 'Optional filter by relationship type' }
          },
          required: ['source_key']
        }
      },
      {
        name: 'find_related_memories',
        description: 'Find memories related to a given memory through content, tags, or links',
        inputSchema: {
          type: 'object',
          properties: {
            memory_key: { type: 'string', description: 'The memory key to find relations for' },
            include_content: { type: 'boolean', description: 'Include content similarity matches' },
            include_tags: { type: 'boolean', description: 'Include tag similarity matches' },
            include_links: { type: 'boolean', description: 'Include direct link matches' },
            max_results: { type: 'number', description: 'Maximum number of results to return' },
            min_similarity: { type: 'number', description: 'Minimum similarity threshold' }
          },
          required: ['memory_key']
        }
      },
      {
        name: 'find_memory_path',
        description: 'Find the shortest path between two memories through their links',
        inputSchema: {
          type: 'object',
          properties: {
            from_key: { type: 'string', description: 'Starting memory key' },
            to_key: { type: 'string', description: 'Target memory key' }
          },
          required: ['from_key', 'to_key']
        }
      },
      {
        name: 'search_by_relationship',
        description: 'Search for memories based on relationship patterns',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Pattern in format "source relationship target" (use * for wildcards)' }
          },
          required: ['pattern']
        }
      },
      {
        name: 'find_memories_within_degrees',
        description: 'Find all memories within N degrees of separation from a starting memory',
        inputSchema: {
          type: 'object',
          properties: {
            start_key: { type: 'string', description: 'Starting memory key' },
            max_degrees: { type: 'number', description: 'Maximum degrees of separation to search' },
            relationship_type: { type: 'string', description: 'Optional filter by relationship type' }
          },
          required: ['start_key']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    await initializeMemoryFile();
    let memory = JSON.parse(await fs.readFile(memoryFilePath, 'utf8'));
    memory = await cleanExpiredMemories(memory);
    let result = {};

    switch (name) {
      case 'save_memory':
        if (!args.key || !args.value) {
          throw new Error('key and value are required');
        }
        const now = new Date().toISOString();
        let expiresAt = null;
        if (args.expires_in_seconds !== undefined) {
          if (args.expires_in_seconds > 0) {
            expiresAt = new Date(Date.now() + args.expires_in_seconds * 1000).toISOString();
          } else {
            expiresAt = null;
          }
        }

        if (!memory[args.key]) {
          memory[args.key] = {
            value: args.value,
            tags: args.tags || [],
            created_at: now,
            updated_at: now,
            expires_at: expiresAt,
            links: []
          };
        } else {
          memory[args.key].value = args.value;
          if (args.tags !== undefined) {
            memory[args.key].tags = args.tags;
          }
          if (args.expires_in_seconds !== undefined) {
            memory[args.key].expires_at = expiresAt;
          }
          memory[args.key].updated_at = now;
        }
        await fs.writeFile(memoryFilePath, JSON.stringify(memory, null, 2));
        result = { success: true, message: `Saved memory for key: ${args.key}` };
        break;

      case 'recall_memory':
        if (!args.key) {
          throw new Error('key is required');
        }
        const recalledMemory = memory[args.key];
        
        if (recalledMemory) {
          result = {
            value: recalledMemory.value,
            tags: recalledMemory.tags,
            created_at: recalledMemory.created_at,
            updated_at: recalledMemory.updated_at,
            expires_at: recalledMemory.expires_at,
            links: recalledMemory.links
          };
          
          if (args.include_related !== false) {
            const relatedMemories = findRelatedMemories(memory, args.key, { maxResults: args.max_related || 5, minSimilarity: 0.4 });
            result.related_memories = relatedMemories;
          }
        } else {
          result = { value: null, tags: [], created_at: null, updated_at: null, expires_at: null, links: [], related_memories: [] };
        }
        break;

      case 'list_memories':
        const listFilteredKeys = Object.keys(memory).filter(key => {
          if (args && args.tag) {
            return memory[key].tags && memory[key].tags.includes(args.tag);
          } else {
            return true;
          }
        });
        result = { keys: listFilteredKeys };
        break;

      case 'delete_memory':
        if (!args.key) {
          throw new Error('key is required');
        }
        if (memory[args.key]) {
          for (const key in memory) {
            if (memory[key].links) {
              memory[key].links = memory[key].links.filter(link => link.target_key !== args.key);
            }
          }
          delete memory[args.key];
          await fs.writeFile(memoryFilePath, JSON.stringify(memory, null, 2));
          result = { success: true, message: `Deleted memory for key: ${args.key}` };
        } else {
          result = { success: false, message: `Key not found: ${args.key}` };
        }
        break;

      case 'list_all_tags':
        const allTags = new Set();
        Object.values(memory).forEach(mem => {
          if (mem.tags) {
            mem.tags.forEach(tag => allTags.add(tag));
          }
        });
        result = { tags: Array.from(allTags) };
        break;

      case 'search_memory_content':
        if (!args.query) {
          throw new Error('query is required');
        }
        
        const threshold = 0.2;
        const fuzzyResults = fuzzySearch(memory, args.query, { threshold });
        
        result = {
          keys: fuzzyResults.map(r => r.key),
          results: fuzzyResults
        };
        break;

      case 'link_memories':
        if (!args.source_key || !args.target_key || !args.relationship_type) {
          throw new Error('source_key, target_key, and relationship_type are required');
        }
        if (!memory[args.source_key]) {
          result = { success: false, message: `Source key not found: ${args.source_key}` };
        } else if (!memory[args.target_key]) {
          result = { success: false, message: `Target key not found: ${args.target_key}` };
        } else {
          const newLink = { target_key: args.target_key, relationship_type: args.relationship_type };
          if (!memory[args.source_key].links.some(link => link.target_key === newLink.target_key && link.relationship_type === newLink.relationship_type)) {
            memory[args.source_key].links.push(newLink);
            memory[args.source_key].updated_at = new Date().toISOString();
            await fs.writeFile(memoryFilePath, JSON.stringify(memory, null, 2));
            result = { success: true, message: `Linked ${args.source_key} to ${args.target_key} with type ${args.relationship_type}` };
          } else {
            result = { success: false, message: `Link already exists from ${args.source_key} to ${args.target_key} with type ${args.relationship_type}` };
          }
        }
        break;

      case 'get_linked_memories':
        if (!args.source_key) {
          throw new Error('source_key is required');
        }
        const sourceMemory = memory[args.source_key];
        if (!sourceMemory) {
          result = { success: false, message: `Source key not found: ${args.source_key}` };
        } else {
          let linkedMemories = sourceMemory.links || [];
          if (args.relationship_type) {
            linkedMemories = linkedMemories.filter(link => link.relationship_type === args.relationship_type);
          }
          result = { links: linkedMemories };
        }
        break;

      case 'find_related_memories':
        if (!args.memory_key) {
          throw new Error('memory_key is required');
        }
        
        if (!memory[args.memory_key]) {
          result = { success: false, message: `Memory key not found: ${args.memory_key}` };
        } else {
          const options = {
            includeContent: args.include_content !== false,
            includeTags: args.include_tags !== false,
            includeLinks: args.include_links !== false,
            maxResults: args.max_results || 10,
            minSimilarity: args.min_similarity || 0.3
          };
          
          const relatedMemories = findRelatedMemories(memory, args.memory_key, options);
          result = { memory_key: args.memory_key, related_memories: relatedMemories, total_found: relatedMemories.length };
        }
        break;

      case 'find_memory_path':
        if (!args.from_key || !args.to_key) {
          throw new Error('from_key and to_key are required');
        }
        
        const path = findShortestPath(memory, args.from_key, args.to_key);
        
        if (path) {
          result = { path_found: true, path: path.path, length: path.length, connections: path.connections };
        } else {
          result = { path_found: false, message: `No connection path found between ${args.from_key} and ${args.to_key}` };
        }
        break;

      case 'search_by_relationship':
        if (!args.pattern) {
          throw new Error('pattern is required (format: "source relationship target", use * for wildcards)');
        }
        
        const relationshipResults = searchByRelationshipPattern(memory, args.pattern);
        result = { pattern: args.pattern, matches: relationshipResults, total_matches: relationshipResults.length };
        break;

      case 'find_memories_within_degrees':
        if (!args.start_key) {
          throw new Error('start_key is required');
        }
        
        if (!memory[args.start_key]) {
          result = { success: false, message: `Start key not found: ${args.start_key}` };
        } else {
          const maxDegrees = args.max_degrees || 2;
          const relationship = args.relationship_type || null;
          
          const connectedMemories = findMemoriesWithinDegrees(memory, args.start_key, maxDegrees, relationship);
          result = { start_key: args.start_key, max_degrees: maxDegrees, relationship_filter: relationship, connected_memories: connectedMemories, total_found: connectedMemories.length };
        }
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };

  } catch (error) {
    throw new Error(`Tool execution failed: ${error.message}`);
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Memory Server MCP running on stdio');
}

runServer().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});