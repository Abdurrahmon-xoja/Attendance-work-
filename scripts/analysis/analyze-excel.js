const XLSX = require('xlsx');

console.log('=== BEFORE UPDATE (Worker info 3) ===');
try {
  const wb3 = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Worker info (3).xlsx');
  const sheet3 = wb3.Sheets[wb3.SheetNames[0]];
  const data3 = XLSX.utils.sheet_to_json(sheet3, { defval: '' });
  console.log('Sheet name:', wb3.SheetNames[0]);
  console.log('Total rows:', data3.length);
  console.log('Columns:', Object.keys(data3[0] || {}));
  console.log('\nFirst 3 employees:');
  data3.slice(0, 3).forEach((row, i) => {
    console.log(`\n--- Row ${i+1} ---`);
    Object.entries(row).forEach(([key, val]) => {
      if (val !== '') console.log(`  ${key}: ${val}`);
    });
  });
} catch (e) {
  console.error('Error reading file 3:', e.message);
}

console.log('\n\n=== AFTER UPDATE (Worker info 4) ===');
try {
  const wb4 = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Worker info (4).xlsx');
  const sheet4 = wb4.Sheets[wb4.SheetNames[0]];
  const data4 = XLSX.utils.sheet_to_json(sheet4, { defval: '' });
  console.log('Sheet name:', wb4.SheetNames[0]);
  console.log('Total rows:', data4.length);
  console.log('Columns:', Object.keys(data4[0] || {}));
  console.log('\nFirst 3 employees:');
  data4.slice(0, 3).forEach((row, i) => {
    console.log(`\n--- Row ${i+1} ---`);
    Object.entries(row).forEach(([key, val]) => {
      if (val !== '') console.log(`  ${key}: ${val}`);
    });
  });
} catch (e) {
  console.error('Error reading file 4:', e.message);
}

console.log('\n\n=== DAILY SHEET (2025-12-03) ===');
try {
  const wbDaily = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/attendance_2025-12-03.xlsx');
  const sheetDaily = wbDaily.Sheets[wbDaily.SheetNames[0]];
  const dataDaily = XLSX.utils.sheet_to_json(sheetDaily, { defval: '' });
  console.log('Sheet name:', wbDaily.SheetNames[0]);
  console.log('Total rows:', dataDaily.length);
  console.log('Columns:', Object.keys(dataDaily[0] || {}));
  console.log('\nAll daily records:');
  dataDaily.forEach((row, i) => {
    console.log(`\n--- Row ${i+1}: ${row.Name || 'N/A'} ---`);
    Object.entries(row).forEach(([key, val]) => {
      if (val !== '') console.log(`  ${key}: ${val}`);
    });
  });
} catch (e) {
  console.error('Error reading daily file:', e.message);
}
