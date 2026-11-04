import {createHrEligibilityReader} from './hr-eligibility-reader.mjs';
import prisma from '../lib/prisma.js';
import {verifyServiceRequest} from '../lib/serviceJwt.js';
import {createHrIntentReader} from './hr-intent-reader.mjs';
import {createHrContactReader} from './hr-contact-reader.mjs';
const native={prisma,verifyServiceRequest,expectedService:'erp-rbac'};
const handler=read=>async(req,res,next)=>{try{res.set('Cache-Control','no-store');res.json({success:true,data:await read(req)});}catch(error){next(error);}};
export const resolveProvisioningIntent=handler(createHrIntentReader(native));
export const resolveProvisioningContact=handler(createHrContactReader(native));

export const resolveProvisioningEligibility=handler(createHrEligibilityReader(native));
