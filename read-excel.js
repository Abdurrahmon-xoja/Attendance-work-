const XLSX = require('xlsx');

try {
  const workbook = XLSX.readFile('/Users/abdurrahmonxoja/Downloads/Worker info.xlsx');

  console.log('Sheets in workbook:', workbook.SheetNames);
  console.log('\n');

  workbook.SheetNames.forEach(sheetName => {
    console.log(`=== Sheet: ${sheetName} ===`);
    console.log('');

    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    // Print all rows
    data.forEach((row, index) => {
      console.log(`Row ${index + 1}:`, row);
    });

    console.log('\n');
  });

} catch (error) {
  console.error('Error reading Excel file:', error.message);
  process.exit(1);
}
