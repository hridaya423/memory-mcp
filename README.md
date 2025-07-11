# Memory Server MCP

A MCP server for persistent memory storage with advanced features like tagging, timestamping, expiration, content search, and inter-memory linking. Built for integration with MCP clients like Claude for Desktop.

## Features

- **Save/Update Memories (`save_memory`):** Store or update a memory with a unique key and value. Supports optional tags and expiration settings.
  - `key` (string): Unique identifier for the memory.
  - `value` (string): The content of the memory.
  - `tags` (array of strings, optional): A list of tags to associate with the memory. If provided, replaces existing tags. Pass an empty array to remove all tags.
  - `expires_in_seconds` (number, optional): The number of seconds until this memory expires. Pass `0` or a negative number to remove expiration.

- **Recall Memory (`recall_memory`):** Retrieve a memory by its key, including its value, associated tags, creation timestamp, last updated timestamp, and expiration timestamp.

- **List Memories (`list_memories`):** List all non-expired memory keys. Optionally, filter memories by a specific tag.
  - `tag` (string, optional): Filter memories by this tag.

- **Delete Memory (`delete_memory`):** Permanently remove a memory by its key. Also removes any links pointing to the deleted memory.

- **List All Tags (`list_all_tags`):** Get a list of all unique tags currently in use across all non-expired memories.

- **Search Memory Content (`search_memory_content`):** Search for memories whose content (value) contains a given query string (case-insensitive, non-expired memories only).

- **Link Memories (`link_memories`):** Create a directed link from a source memory to a target memory with a specified relationship type.
  - `source_key` (string): The key of the memory from which the link originates.
  - `target_key` (string): The key of the memory to which the link points.
  - `relationship_type` (string): The type of relationship (e.g., `related_to`, `depends_on`, `is_part_of`).

- **Get Linked Memories (`get_linked_memories`):** Retrieve a list of memories linked from a given source memory, optionally filtered by relationship type.

## Installation & Usage

### Quick Start with npx (Recommended)

```bash
npx memory-server-mcp
```

### Global Installation

```bash
npm install -g memory-server-mcp
memory-server-mcp
```

## Usage with MCP Clients

### Claude for Desktop

1. **Add MCP Server Configuration:**
   In your Claude for Desktop settings, add a new MCP server:
   
   ```json
   {
     "mcpServers": {
       "memory": {
         "command": "npx",
         "args": ["memory-server-mcp"]
       }
     }
   }
   ```

2. **Restart Claude for Desktop** to load the new server.

3. **Start using memory commands** in your conversations with Claude.

## Example Usage

Once connected to an MCP client, you can use commands like:

```
Save a memory about my project:
Key: project_status
Value: Working on memory server MCP, almost ready for release
Tags: work, mcp, nodejs

Recall what I saved about my project status.

Search for memories containing "nodejs".

Link my project memory to related technologies.
```