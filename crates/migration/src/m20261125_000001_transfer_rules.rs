//! Transfer rules: a rule's target is either a category or a pot (an account you never import).
//! A transfer a rule made remembers it in `link_groups.rule_id`, like splits do.

use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261125_000001_transfer_rules"
    }
}

const UP: &str = r#"
ALTER TABLE rules
    ALTER COLUMN category_id DROP NOT NULL,
    ADD COLUMN counter_account_id bigint REFERENCES accounts (id) ON DELETE CASCADE,
    ADD CONSTRAINT rules_one_target CHECK ((category_id IS NULL) <> (counter_account_id IS NULL));

-- Which rule made this transfer. NULL: you made it. Changing the group by hand makes it yours.
ALTER TABLE link_groups ADD COLUMN rule_id bigint REFERENCES rules (id) ON DELETE SET NULL;
CREATE INDEX link_groups_rule_id_idx ON link_groups (rule_id);
"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }
}
