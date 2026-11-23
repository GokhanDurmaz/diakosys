#!/bin/bash

# Tool Capability Tests
# This script tests the actual functionality of available tools

echo "Testing Tool Capabilities"
echo "========================="
echo ""

# Test 1: ripgrep
echo "1. Testing ripgrep (rg):"
rg --version 2>&1 | head -1
echo ""

# Test 2: fd
echo "2. Testing fd:"
fd --version 2>&1 | head -1
echo ""

# Test 3: bat
echo "3. Testing bat:"
bat --version 2>&1 | head -1
echo ""

# Test 4: jq
echo "4. Testing jq:"
jq --version 2>&1 | head -1
echo ""

# Test 5: Miller
echo "5. Testing Miller (mlr):"
mlr --version 2>&1 | head -1
echo ""

# Test 6: ast-grep
echo "6. Testing ast-grep:"
ast-grep --version 2>&1 | head -1
echo ""

# Test 7: fzf
echo "7. Testing fzf:"
fzf --version 2>&1 | head -1
echo ""

# Test 8: hyperfine
echo "8. Testing hyperfine:"
hyperfine --version 2>&1 | head -1
echo ""

# Test 9: sd (speeddate)
echo "9. Testing sd:"
sd --version 2>&1 | head -1
echo ""

# Test 10: opencode tools
echo "10. Testing opencode models:"
opencode_models --provider oxcoder-q8-m5 2>&1 | head -5
echo ""

# Test 11: Check git
echo "11. Testing git:"
git --version 2>&1 | head -1
echo ""

# Test 12: node
echo "12. Testing node:"
node --version 2>&1 | head -1
echo ""

# Test 13: pnpm/npm
echo "13. Testing pnpm:"
pnpm --version 2>&1 | head -1
echo ""

echo ""
echo "All basic tool tests completed."
