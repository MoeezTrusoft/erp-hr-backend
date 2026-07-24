-- Leave & Anomaly screen: the leave TYPE (= LeavePolicy) is assigned by HR at
-- approval, not chosen by the employee at request. Relax leavePolicyId to
-- nullable so a PENDING request can exist without a type. Additive.
ALTER TABLE "leave_requests" ALTER COLUMN "leavePolicyId" DROP NOT NULL;
