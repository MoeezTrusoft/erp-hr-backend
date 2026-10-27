-- Signed snapshots cannot acquire new observations or evidence through a legacy writer.
CREATE FUNCTION assessment_insert_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment_id uuid; revision_number integer;
BEGIN
 IF TG_TABLE_NAME='AssessmentDimension' THEN
   SELECT "assessmentRef","revisionNo" INTO assessment_id,revision_number FROM "AssessmentObservation" WHERE id=NEW."observationRef" AND "tenantId"=NEW."tenantId";
 ELSE assessment_id:=NEW."assessmentRef"; revision_number:=NEW."revisionNo";
 END IF;
 IF EXISTS(SELECT 1 FROM "AssessmentRevision" WHERE "tenantId"=NEW."tenantId" AND "assessmentRef"=assessment_id AND "revisionNo"=revision_number) THEN
   RAISE EXCEPTION 'Submitted assessment revision cannot acquire new observation content';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assessment_observation_insert_frozen BEFORE INSERT ON "AssessmentObservation" FOR EACH ROW EXECUTE FUNCTION assessment_insert_frozen();
CREATE TRIGGER assessment_dimension_insert_frozen BEFORE INSERT ON "AssessmentDimension" FOR EACH ROW EXECUTE FUNCTION assessment_insert_frozen();
CREATE TRIGGER assessment_link_insert_frozen BEFORE INSERT ON "AssessmentEvidenceLink" FOR EACH ROW EXECUTE FUNCTION assessment_insert_frozen();
