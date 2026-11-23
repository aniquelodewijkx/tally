use tally_core::{ImportBatch, Ledger};
use tonic::{Request, Response, Status};

use super::pb::{self, import_service_server::ImportService};
use super::{status, timestamp};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl ImportService for Svc {
    async fn import_file(
        &self,
        req: Request<pb::ImportFileRequest>,
    ) -> Result<Response<pb::ImportFileResponse>, Status> {
        let req = req.into_inner();
        let outcome =
            self.0.import_file(req.account_id, &req.source, req.file_name, req.content).await.map_err(status)?;
        Ok(Response::new(pb::ImportFileResponse {
            batch: Some(batch_to_pb(outcome.batch)),
            already_imported: outcome.already_imported,
            auto_labelled: outcome.auto_labelled as i64,
        }))
    }

    async fn list_batches(
        &self,
        req: Request<pb::ListBatchesRequest>,
    ) -> Result<Response<pb::ListBatchesResponse>, Status> {
        let batches = self.0.list_batches(req.into_inner().account_id).await.map_err(status)?;
        Ok(Response::new(pb::ListBatchesResponse { batches: batches.into_iter().map(batch_to_pb).collect() }))
    }

    async fn undo_batch(&self, req: Request<pb::UndoBatchRequest>) -> Result<Response<pb::UndoBatchResponse>, Status> {
        self.0.undo_batch(req.into_inner().batch_id).await.map_err(status)?;
        Ok(Response::new(pb::UndoBatchResponse {}))
    }
}

fn batch_to_pb(b: ImportBatch) -> pb::ImportBatch {
    pb::ImportBatch {
        id: b.id,
        account_id: b.account_id,
        source: b.source,
        file_name: b.file_name,
        inserted: b.inserted,
        duplicates: b.duplicates,
        imported_at: Some(timestamp(b.imported_at)),
    }
}
