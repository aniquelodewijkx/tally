use tally_core::{Ledger, TotalTarget};
use tonic::{Request, Response, Status};

use super::pb::{self, category_total::Target, report_service_server::ReportService};
use super::{required_date, status};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl ReportService for Svc {
    async fn category_totals(
        &self,
        req: Request<pb::CategoryTotalsRequest>,
    ) -> Result<Response<pb::CategoryTotalsResponse>, Status> {
        let req = req.into_inner();
        let from = required_date(req.from.as_ref(), "from")?;
        let to = required_date(req.to.as_ref(), "to")?;
        let totals = self.0.category_totals(from, to).await.map_err(status)?;
        Ok(Response::new(pb::CategoryTotalsResponse {
            totals: totals
                .into_iter()
                .map(|t| pb::CategoryTotal {
                    year: t.month.year().into(),
                    month: t.month.month().into(),
                    target: Some(match t.target {
                        TotalTarget::Category(id) => Target::CategoryId(id),
                        TotalTarget::UncategorizedIn => Target::Uncategorized(pb::Direction::In.into()),
                        TotalTarget::UncategorizedOut => Target::Uncategorized(pb::Direction::Out.into()),
                    }),
                    amount_cents: t.amount_cents,
                    spent_cents: t.spent_cents,
                    received_cents: t.received_cents,
                })
                .collect(),
        }))
    }
}
