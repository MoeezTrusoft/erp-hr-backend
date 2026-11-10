-- A decided or cancelled leave request can never go back to PENDING: reopening it would let an approved leave be
-- changed without the approval route (the generic approval guard only watches moves to APPROVED/REJECTED/CANCELLED).
CREATE FUNCTION leave_status_no_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'HR-4205: A decided leave request cannot be reopened; file a new request';
END $$;
CREATE TRIGGER leave_status_no_reopen BEFORE UPDATE ON "leave_requests" FOR EACH ROW WHEN (OLD.status IN ('APPROVED','REJECTED','CANCELLED') AND NEW.status = 'PENDING') EXECUTE FUNCTION leave_status_no_reopen();
