use tally_core::{Ledger, LinkGroup, LinkKind};
use tonic::{Request, Response, Status};

use super::pb::{self, link_service_server::LinkService};
use super::{status, timestamp};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl LinkService for Svc {
    async fn get_group(&self, req: Request<pb::GetGroupRequest>) -> Result<Response<pb::GetGroupResponse>, Status> {
        let group = self.0.get_group(req.into_inner().id).await.map_err(status)?;
        Ok(Response::new(pb::GetGroupResponse { group: Some(group_to_pb(group)) }))
    }

    async fn suggest_transfers(
        &self,
        _: Request<pb::SuggestTransfersRequest>,
    ) -> Result<Response<pb::SuggestTransfersResponse>, Status> {
        let suggestions = self.0.suggest_transfers().await.map_err(status)?;
        Ok(Response::new(pb::SuggestTransfersResponse {
            suggestions: suggestions
                .into_iter()
                .map(|s| pb::TransferSuggestion { outgoing_id: s.outgoing_id, incoming_id: s.incoming_id })
                .collect(),
        }))
    }

    async fn create_group(
        &self,
        req: Request<pb::CreateGroupRequest>,
    ) -> Result<Response<pb::CreateGroupResponse>, Status> {
        let req = req.into_inner();
        let kind = match pb::LinkKind::try_from(req.kind) {
            Ok(pb::LinkKind::Transfer) => LinkKind::Transfer,
            Ok(pb::LinkKind::Reimbursement) => LinkKind::Reimbursement,
            Ok(pb::LinkKind::Unspecified) | Err(_) => return Err(Status::invalid_argument("kind is required")),
        };
        let group =
            self.0.create_group(kind, req.title, &req.transaction_ids, req.counter_account_id).await.map_err(status)?;
        Ok(Response::new(pb::CreateGroupResponse { group: Some(group_to_pb(group)) }))
    }

    async fn mark_transfers(
        &self,
        req: Request<pb::MarkTransfersRequest>,
    ) -> Result<Response<pb::MarkTransfersResponse>, Status> {
        let req = req.into_inner();
        let out = self.0.mark_transfers(&req.transaction_ids, req.counter_account_id).await.map_err(status)?;
        Ok(Response::new(pb::MarkTransfersResponse { updated: out.updated as i64, skipped: out.skipped as i64 }))
    }

    async fn update_group_members(
        &self,
        req: Request<pb::UpdateGroupMembersRequest>,
    ) -> Result<Response<pb::UpdateGroupMembersResponse>, Status> {
        let req = req.into_inner();
        let group = self
            .0
            .update_group_members(req.group_id, &req.add_transaction_ids, &req.remove_transaction_ids)
            .await
            .map_err(status)?;
        Ok(Response::new(pb::UpdateGroupMembersResponse { group: Some(group_to_pb(group)) }))
    }

    async fn delete_group(
        &self,
        req: Request<pb::DeleteGroupRequest>,
    ) -> Result<Response<pb::DeleteGroupResponse>, Status> {
        self.0.delete_group(req.into_inner().id).await.map_err(status)?;
        Ok(Response::new(pb::DeleteGroupResponse {}))
    }
}

pub(super) fn kind_to_pb(kind: LinkKind) -> pb::LinkKind {
    match kind {
        LinkKind::Transfer => pb::LinkKind::Transfer,
        LinkKind::Reimbursement => pb::LinkKind::Reimbursement,
    }
}

fn group_to_pb(g: LinkGroup) -> pb::LinkGroup {
    pb::LinkGroup {
        id: g.id,
        kind: kind_to_pb(g.kind).into(),
        title: g.title,
        transaction_ids: g.transaction_ids,
        counter_account_id: g.counter_account_id,
        created_at: Some(timestamp(g.created_at)),
    }
}
