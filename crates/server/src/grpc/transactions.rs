use tally_core::{Ledger, Split, Transaction, TransactionFilter};
use tonic::{Request, Response, Status};

use super::pb::{self, transaction_service_server::TransactionService};
use super::{date_from_pb, date_to_pb, status};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl TransactionService for Svc {
    async fn list_transactions(
        &self,
        req: Request<pb::ListTransactionsRequest>,
    ) -> Result<Response<pb::ListTransactionsResponse>, Status> {
        let f = req.into_inner().filter.unwrap_or_default();
        let filter = TransactionFilter {
            account_id: f.account_id,
            booked_from: f.booked_from.as_ref().map(|d| date_from_pb(d, "booked_from")).transpose()?,
            booked_to: f.booked_to.as_ref().map(|d| date_from_pb(d, "booked_to")).transpose()?,
            category_id: f.category_id,
            uncategorized_only: f.uncategorized_only,
            link_group_id: f.link_group_id,
            search: f.search,
            counter_account_id: f.counter_account_id,
        };
        let rows = self.0.list_transactions(&filter).await.map_err(status)?;
        Ok(Response::new(pb::ListTransactionsResponse { transactions: rows.into_iter().map(to_pb).collect() }))
    }

    async fn get_transaction(
        &self,
        req: Request<pb::GetTransactionRequest>,
    ) -> Result<Response<pb::GetTransactionResponse>, Status> {
        let tx = self.0.get_transaction(req.into_inner().id).await.map_err(status)?;
        Ok(Response::new(pb::GetTransactionResponse { transaction: Some(to_pb(tx)) }))
    }

    async fn set_category(
        &self,
        req: Request<pb::SetCategoryRequest>,
    ) -> Result<Response<pb::SetCategoryResponse>, Status> {
        let req = req.into_inner();
        let out = self.0.set_category(&req.transaction_ids, req.category_id).await.map_err(status)?;
        Ok(Response::new(pb::SetCategoryResponse { updated: out.updated as i64, skipped: out.skipped as i64 }))
    }

    async fn set_splits(&self, req: Request<pb::SetSplitsRequest>) -> Result<Response<pb::SetSplitsResponse>, Status> {
        let req = req.into_inner();
        let splits = req
            .splits
            .into_iter()
            .map(|s| Split { category_id: s.category_id, amount_cents: s.amount_cents })
            .collect();
        let tx = self.0.set_splits(req.transaction_id, splits).await.map_err(status)?;
        Ok(Response::new(pb::SetSplitsResponse { transaction: Some(to_pb(tx)) }))
    }

    async fn set_notes(&self, req: Request<pb::SetNotesRequest>) -> Result<Response<pb::SetNotesResponse>, Status> {
        let req = req.into_inner();
        let tx = self.0.set_notes(req.transaction_id, req.notes).await.map_err(status)?;
        Ok(Response::new(pb::SetNotesResponse { transaction: Some(to_pb(tx)) }))
    }
}

pub(super) fn to_pb(t: Transaction) -> pb::Transaction {
    pb::Transaction {
        id: t.id,
        account_id: t.account_id,
        import_batch_id: t.import_batch_id,
        booked_on: Some(date_to_pb(t.booked_on)),
        amount_cents: t.amount_cents,
        counterparty_name: t.counterparty_name,
        counterparty_iban: t.counterparty_iban,
        description: t.description,
        link_group_id: t.link_group_id,
        link_kind: t.link_kind.map(|k| super::links::kind_to_pb(k).into()),
        link_title: t.link_title,
        link_counter_account_id: t.link_counter_account_id,
        rule_id: t.rule_id,
        notes: t.notes,
        splits: t
            .splits
            .into_iter()
            .map(|s| pb::Split { category_id: s.category_id, amount_cents: s.amount_cents })
            .collect(),
    }
}
