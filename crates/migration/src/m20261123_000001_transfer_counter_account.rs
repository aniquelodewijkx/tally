//! Savings pots: a one-sided transfer can say which account its other side is, for accounts you
//! never import (savings, cash). See "Pots" in docs/data-model/index.html.

use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261123_000001_transfer_counter_account"
    }
}

const UP: &str = r#"
ALTER TABLE link_groups
    ADD COLUMN counter_account_id bigint REFERENCES accounts (id) ON DELETE RESTRICT,
    ADD CONSTRAINT link_groups_counter_account_transfer_only
        CHECK (counter_account_id IS NULL OR kind = 'transfer');
CREATE INDEX link_groups_counter_account_id_idx ON link_groups (counter_account_id);
"#;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(UP).await?;
        Ok(())
    }
}
