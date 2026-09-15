-- Relation properties are looked up by their target database when rows are deleted (to remove stale links).
CREATE INDEX db_properties_relation_target_idx ON db_properties (json_extract(config, '$.targetModuleId')) WHERE type = 'relation';
