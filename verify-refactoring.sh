#!/bin/bash

echo "=========================================="
echo "Sheets Service Refactoring Verification"
echo "=========================================="
echo ""

# Check all files exist
echo "📁 Checking file structure..."
FILES=(
  "src/services/sheets/index.js"
  "src/services/sheets/cache.manager.js"
  "src/services/sheets/quota.handler.js"
  "src/services/sheets/core.service.js"
  "src/services/sheets/roster.operations.js"
  "src/services/sheets/daily.operations.js"
  "src/services/sheets/monthly.operations.js"
)

ALL_EXIST=true
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "  ✅ $file"
  else
    echo "  ❌ $file - MISSING"
    ALL_EXIST=false
  fi
done

if [ "$ALL_EXIST" = false ]; then
  echo ""
  echo "❌ Some files are missing. Refactoring incomplete."
  exit 1
fi

echo ""
echo "📊 File statistics..."
echo "  Original: $(wc -l < src/services/sheets.service.js) lines"
echo ""
echo "  New modular structure:"
for file in "${FILES[@]}"; do
  printf "    %4d lines - %s\n" "$(wc -l < "$file")" "$file"
done

echo ""
echo "🔍 Syntax validation..."
SYNTAX_OK=true
for file in "${FILES[@]}"; do
  if node -c "$file" 2>/dev/null; then
    echo "  ✅ $file"
  else
    echo "  ❌ $file - SYNTAX ERROR"
    SYNTAX_OK=false
  fi
done

if [ "$SYNTAX_OK" = false ]; then
  echo ""
  echo "❌ Syntax errors found. Please fix before deployment."
  exit 1
fi

echo ""
echo "🔗 Import compatibility check..."
echo "  Files importing sheets.service:"
grep -l "require.*sheets\.service" src/**/*.js 2>/dev/null | while read file; do
  echo "    - $file"
done

echo ""
echo "✅ All checks passed!"
echo ""
echo "📝 Next steps:"
echo "  1. Backup original: cp src/services/sheets.service.js src/services/sheets.service.js.BACKUP"
echo "  2. Replace original: cp src/services/sheets.service.js.NEW src/services/sheets.service.js"
echo "  3. Test application thoroughly"
echo "  4. Monitor logs for any issues"
echo ""
echo "For detailed information, see: REFACTORING_SUMMARY.md"
