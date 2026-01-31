const XLSX = require('xlsx');

console.log('=== Worker info (4) (1) ===');
try {
  const wb = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Worker info (4) (1).xlsx');
  console.log('Available sheets:', wb.SheetNames);
  console.log('\n');

  // Read each sheet
  wb.SheetNames.forEach(sheetName => {
    console.log(`\n========== SHEET: ${sheetName} ==========`);
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    console.log('Total rows:', data.length);
    console.log('Columns:', Object.keys(data[0] || {}));
    console.log('\nAll rows:');
    data.forEach((row, i) => {
      console.log(`\n--- Row ${i+1}: ${row.Name || row['Name full'] || 'N/A'} ---`);
      Object.entries(row).forEach(([key, val]) => {
        if (val !== '') console.log(`  ${key}: ${val}`);
      });
    });
  });
} catch (e) {
  console.error('Error reading file:', e.message);
}
