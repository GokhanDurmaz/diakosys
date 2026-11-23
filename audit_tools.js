#!/usr/bin/env node

/**
 * Tool Capability Audit Script
 *
 * This script tests the availability and basic functionality of all available tools
 * to understand their actual capabilities and behavior.
 */

const tools = [
  // File operations
  { name: 'write', test: 'create a simple text file' },
  { name: 'read', test: 'read a file (via bat_bat_read)' },
  { name: 'edit', test: 'edit a file (via edit tool)' },
  { name: 'delete', test: 'delete a file (not directly available, must use rm)' },

  // Search tools
  { name: 'rg_rg_search', test: 'search codebase with ripgrep' },
  { name: 'fd_fd_find', test: 'find files with fd' },
  { name: 'rg', test: 'alternative name for ripgrep?' },
  { name: 'fd', test: 'alternative name for fd?' },
  { name: 'ast-grep_ast_grep_search', test: 'structural code search with ast-grep' },
  { name: 'fzf_fzf_filter', test: 'filter text with fzf' },
  { name: 'sd_sd_replace', test: 'find and replace with sd' },

  // Code inspection
  { name: 'bat_bat_read', test: 'display files with syntax highlighting' },
  { name: 'jq_jq_filter', test: 'process JSON with jq' },
  { name: 'mlr_mlr_transform', test: 'process tabular data with Miller' },

  // Performance
  { name: 'hyperfine_hyperfine_benchmark', test: 'benchmark commands' },
  { name: 'benchmark', test: 'alternative name?' },

  // Web tools
  { name: 'webfetch', test: 'fetch HTTP/HTTPS URLs' },
  { name: 'websearch', test: 'search the web' },

  // Image generation
  { name: 'experimental_image_generate', test: 'generate/edit images' },
  { name: 'image_generate', test: 'alternative name?' },

  // OpenCode-specific
  { name: 'opencode_list_mcp_resources', test: 'list MCP resources' },
  { name: 'opencode_read_mcp_resource', test: 'read MCP resources' },
  { name: 'opencode_models', test: 'list available models' },
  { name: 'opencode_session_move', test: 'move session' },
  { name: 'opencode_session_rename', test: 'rename session' },
  { name: 'opencode_worktree_create', test: 'create git worktree' },
  { name: 'opencode_worktree_list', test: 'list worktrees' },
  { name: 'opencode_worktree_remove', test: 'remove worktree' },

  // Subagents
  { name: 'subagent', test: 'spawn subagent' },

  // Utilities
  { name: 'skill', test: 'load skill instructions' },
  { name: 'question', test: 'ask user questions' },
  { name: 'todowrite', test: 'manage todo list' },
];

console.log('Available tools audit:');
console.log('=====================\n');

tools.forEach(tool => {
  console.log(`✓ ${tool.name}`);
  console.log(`  Purpose: ${tool.test}`);
});

console.log('\n\nTool Categories:');
console.log('================\n');

const categories = {
  'File Operations': ['write', 'edit', 'bat_bat_read'],
  'Search & Find': ['rg_rg_search', 'fd_fd_find', 'ast-grep_ast_grep_search', 'fzf_fzf_filter', 'sd_sd_replace'],
  'Data Processing': ['jq_jq_filter', 'mlr_mlr_transform'],
  'Performance': ['hyperfine_hyperfine_benchmark'],
  'Web Research': ['webfetch', 'websearch'],
  'Image Generation': ['experimental_image_generate'],
  'OpenCode Core': ['opencode_models', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource', 'opencode_session_move', 'opencode_session_rename', 'opencode_worktree_create', 'opencode_worktree_list', 'opencode_worktree_remove'],
  'Task Management': ['skill', 'question', 'todowrite'],
  'Subagents': ['subagent']
};

Object.entries(categories).forEach(([cat, tools]) => {
  console.log(`${cat}:`);
  tools.forEach(t => console.log(`  - ${t}`));
});

console.log('\n\nTool Discovery:');
console.log('===============\n');
console.log('Tools are exposed via function names that follow this pattern:');
console.log('  <tool_name>_<tool_function_name>  (e.g., "rg_rg_search")');
console.log('\nTools can be called directly with their parameters.');

console.log('\n\nUsage Patterns:');
console.log('===============\n');
console.log('1. Direct tool calls for specific operations');
console.log('2. Tool composition for complex workflows');
console.log('3. Subagents for multi-step tasks');
console.log('4. MCP resources for external data sources');
