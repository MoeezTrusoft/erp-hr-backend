// Printed register signatories specified by management on 2026-10-08.
// Keyed by the verified tenant UUID, never a client-supplied company label.
// These labels do not grant permission or change payroll approval routing.
const definitions={
 '8f4a526f-d45b-4da2-b772-d6682e849812':['JOC','Khurram Gul','Irfan Abdi'],
 '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2':['BOC','Khurram Gul','Irfan Abdi'],
 '8ff0533b-62f6-4be9-a78e-69adf49e00bc':['HomeNet','Khurram Gul','Irfan Abdi'],
 '40314ef4-0a81-4390-b631-b3ad3f21f523':['TruSoft','Samar Abbas','Irfan Abdi'],
 '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73':['HomeVision','Hasan Abbas','Imran Abdi'],
};
export function payrollRegisterProfile(tenantId){
 const p=definitions[tenantId];if(!p)return null;
 return {companyName:p[0],signatories:[{label:'PREPARED BY',name:'Afsha Khan'},{label:'AUTHORIZED BY',name:p[1]},{label:'APPROVED BY',name:p[2]}]};
}
