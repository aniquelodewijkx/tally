use tally_core::{Account, Ledger};
use tonic::{Request, Response, Status};

use super::pb::{self, account_service_server::AccountService};
use super::{status, timestamp};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl AccountService for Svc {
    async fn list_accounts(
        &self,
        _: Request<pb::ListAccountsRequest>,
    ) -> Result<Response<pb::ListAccountsResponse>, Status> {
        let accounts = self.0.list_accounts().await.map_err(status)?;
        Ok(Response::new(pb::ListAccountsResponse { accounts: accounts.into_iter().map(to_pb).collect() }))
    }

    async fn create_account(
        &self,
        req: Request<pb::CreateAccountRequest>,
    ) -> Result<Response<pb::CreateAccountResponse>, Status> {
        let account = self.0.create_account(&req.into_inner().name).await.map_err(status)?;
        Ok(Response::new(pb::CreateAccountResponse { account: Some(to_pb(account)) }))
    }

    async fn update_account(
        &self,
        req: Request<pb::UpdateAccountRequest>,
    ) -> Result<Response<pb::UpdateAccountResponse>, Status> {
        let req = req.into_inner();
        let account = self.0.rename_account(req.id, &req.name).await.map_err(status)?;
        Ok(Response::new(pb::UpdateAccountResponse { account: Some(to_pb(account)) }))
    }
}

fn to_pb(a: Account) -> pb::Account {
    pb::Account { id: a.id, name: a.name, created_at: Some(timestamp(a.created_at)) }
}
