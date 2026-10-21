import { randomUUID } from 'node:crypto';

// Migrations require canonical, company-unique codes and retain reservations
// after deletion. Independent fixture runs must therefore use fresh codes.
export const fixtureEmployeeCode = () => `FIXTURE-${randomUUID().replaceAll('-', '').toUpperCase()}`;
