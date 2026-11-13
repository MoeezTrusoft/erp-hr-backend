CREATE TABLE "PerfPeerRound" (
 id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "reviewId" UUID NOT NULL,
 minimum INTEGER NOT NULL CHECK(minimum>=5 AND minimum<=100), "closesAt" TIMESTAMP(3) NOT NULL,
 state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED')),
 version INTEGER NOT NULL DEFAULT 0, rubric JSONB NOT NULL, summary JSONB,
 "createdBy" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "closedAt" TIMESTAMP(3), UNIQUE("tenantId",id), UNIQUE("tenantId","reviewId"),
 FOREIGN KEY("tenantId","reviewId") REFERENCES "PerfReview"("tenantId",id)
);
CREATE TABLE "PerfPeerNomination" (
 id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "roundId" UUID NOT NULL,
 "employeeId" INTEGER NOT NULL, "proposedBy" INTEGER NOT NULL, reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(state IN ('PROPOSED','APPROVED','DECLINED','RESPONDED')),
 version INTEGER NOT NULL DEFAULT 0, "decidedBy" INTEGER, "decisionReason" TEXT,
 "decidedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("tenantId",id), UNIQUE("tenantId","roundId","employeeId"),
 FOREIGN KEY("tenantId","roundId") REFERENCES "PerfPeerRound"("tenantId",id),
 CHECK("decidedBy" IS NULL OR ("decidedBy"<>"employeeId" AND "decidedBy"<>"proposedBy"))
);
CREATE INDEX "PerfPeerNomination_tenantId_employeeId_id_idx" ON "PerfPeerNomination"("tenantId","employeeId",id);
CREATE TABLE "PerfPeerResponse" (
 id UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "roundId" UUID NOT NULL,
 "nominationId" UUID NOT NULL, "authorId" INTEGER NOT NULL,
 answers JSONB NOT NULL, digest TEXT NOT NULL, "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("tenantId",id), UNIQUE("tenantId","nominationId"), UNIQUE("tenantId","roundId","authorId"),
 FOREIGN KEY("tenantId","roundId") REFERENCES "PerfPeerRound"("tenantId",id),
 FOREIGN KEY("tenantId","nominationId") REFERENCES "PerfPeerNomination"("tenantId",id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['PerfPeerRound','PerfPeerNomination','PerfPeerResponse'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY perf_tenant ON %I USING ("tenantId"=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK ("tenantId"=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE TRIGGER peer_response_immutable BEFORE UPDATE OR DELETE ON "PerfPeerResponse" FOR EACH ROW EXECUTE FUNCTION perf_immutable();
CREATE FUNCTION perf_peer_round_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.state='CLOSED' OR NEW.version<>OLD.version+1 OR NEW."tenantId"<>OLD."tenantId"
   OR NEW."reviewId"<>OLD."reviewId" OR NEW.minimum<>OLD.minimum OR NEW.rubric<>OLD.rubric
   OR NEW."closesAt"<>OLD."closesAt" THEN
  RAISE EXCEPTION 'Peer round scope and closed summary are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.state='CLOSED' AND (NEW."closedAt" IS NULL OR NEW."closedAt"<NEW."closesAt" OR NEW.summary IS NULL) THEN
  RAISE EXCEPTION 'Peer round must finish its frozen response window' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER peer_round_guard BEFORE UPDATE ON "PerfPeerRound" FOR EACH ROW EXECUTE FUNCTION perf_peer_round_guard();
CREATE FUNCTION perf_peer_nomination_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."tenantId"<>OLD."tenantId" OR NEW."roundId"<>OLD."roundId" OR NEW."employeeId"<>OLD."employeeId"
   OR NEW."proposedBy"<>OLD."proposedBy" OR NEW.reason<>OLD.reason OR NEW.version<>OLD.version+1
   OR NOT ((OLD.state='PROPOSED' AND NEW.state IN ('APPROVED','DECLINED')) OR (OLD.state='APPROVED' AND NEW.state='RESPONDED')) THEN
  RAISE EXCEPTION 'Peer nomination transition is invalid' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER peer_nomination_guard BEFORE UPDATE ON "PerfPeerNomination" FOR EACH ROW EXECUTE FUNCTION perf_peer_nomination_guard();
CREATE FUNCTION perf_peer_response_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "PerfPeerNomination" n JOIN "PerfPeerRound" r ON r."tenantId"=n."tenantId" AND r.id=n."roundId"
   WHERE n."tenantId"=NEW."tenantId" AND n.id=NEW."nominationId" AND n."roundId"=NEW."roundId"
   AND n."employeeId"=NEW."authorId" AND n.state='APPROVED' AND r.state='OPEN' AND NEW."submittedAt"<=r."closesAt") THEN
  RAISE EXCEPTION 'Approved peer nomination and open response window required' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER peer_response_guard BEFORE INSERT ON "PerfPeerResponse" FOR EACH ROW EXECUTE FUNCTION perf_peer_response_guard();
