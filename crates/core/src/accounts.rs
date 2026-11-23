use entity::accounts;
use sea_orm::{ActiveModelTrait, EntityTrait, QueryOrder, Set};

use crate::error::{Error, Result, not_found};
use crate::time::timestamp_to_jiff;
use crate::{Account, Ledger};

impl Ledger {
    pub async fn list_accounts(&self) -> Result<Vec<Account>> {
        let rows = accounts::Entity::find().order_by_asc(accounts::Column::Name).all(&self.db).await?;
        Ok(rows.into_iter().map(to_domain).collect())
    }

    pub async fn create_account(&self, name: &str) -> Result<Account> {
        let model =
            accounts::ActiveModel { name: Set(required_name(name)?), ..Default::default() }.insert(&self.db).await?;
        Ok(to_domain(model))
    }

    pub async fn rename_account(&self, id: i64, name: &str) -> Result<Account> {
        let model = accounts::Entity::find_by_id(id).one(&self.db).await?.ok_or_else(|| not_found("account", id))?;
        let mut active: accounts::ActiveModel = model.into();
        active.name = Set(required_name(name)?);
        Ok(to_domain(active.update(&self.db).await?))
    }
}

pub(crate) fn required_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::InvalidArgument("name must not be empty".into()));
    }
    Ok(name.to_owned())
}

fn to_domain(m: accounts::Model) -> Account {
    Account { id: m.id, name: m.name, created_at: timestamp_to_jiff(m.created_at) }
}
