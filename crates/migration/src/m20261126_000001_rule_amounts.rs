//! Optional amount range on rules (the amount's size, in cents, inclusive). The same pattern may now
//! have several rules with different ranges.

use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261126_000001_rule_amounts"
    }
}

const UP: &str = r#"
ALTER TABLE rules
    ADD COLUMN min_amount_cents bigint CHECK (min_amount_cents >= 0),
    ADD COLUMN max_amount_cents bigint CHECK (max_amount_cents >= 0),
    ADD CONSTRAINT rules_amount_range CHECK (min_amount_cents IS NULL OR max_amount_cents IS NULL OR min_amount_cents <= max_amount_cents),
    DROP CONSTRAINT rules_pattern_direction_account_id_key,
    ADD CONSTRAINT rules_pattern_scope_key
        UNIQUE NULLS NOT DISTINCT (pattern, direction, account_id, min_amount_cents, max_amount_cents);
"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }
}
