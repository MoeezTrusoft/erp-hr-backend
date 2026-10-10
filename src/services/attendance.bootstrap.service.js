// Historical data is loaded only through the reviewed import workflow.
// Startup must never create employees or write payroll attendance implicitly.
export async function bootstrapAttendanceData() {
  return { skipped: true, reason: 'Use the historical attendance import preview and commit workflow' };
}
