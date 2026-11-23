use tally_core::{Ledger, MatchState, NewRule, Rule, RuleDirection, RuleScope, RuleTarget};
use tonic::{Request, Response, Status};

use super::pb::{self, rule_service_server::RuleService};
use super::{status, timestamp, transactions};

pub struct Svc(pub Ledger);

#[tonic::async_trait]
impl RuleService for Svc {
    async fn list_rules(&self, _: Request<pb::ListRulesRequest>) -> Result<Response<pb::ListRulesResponse>, Status> {
        let rules = self.0.list_rules().await.map_err(status)?;
        Ok(Response::new(pb::ListRulesResponse { rules: rules.into_iter().map(to_pb).collect() }))
    }

    async fn preview_rule(
        &self,
        req: Request<pb::PreviewRuleRequest>,
    ) -> Result<Response<pb::PreviewRuleResponse>, Status> {
        let req = req.into_inner();
        let scope = RuleScope {
            pattern: req.pattern,
            direction: direction_from_pb(req.direction),
            account_id: req.account_id,
            min_amount_cents: req.min_amount_cents,
            max_amount_cents: req.max_amount_cents,
        };
        let preview = self.0.preview_rule(&scope, req.rule_id).await.map_err(status)?;
        Ok(Response::new(pb::PreviewRuleResponse {
            will_label: preview.will_label as i64,
            labelled_by_rule: preview.labelled_by_rule as i64,
            handled: preview.handled as i64,
            matches: preview
                .matches
                .into_iter()
                .map(|m| pb::RuleMatch {
                    state: match m.state {
                        MatchState::WillLabel => pb::RuleMatchState::WillLabel,
                        MatchState::LabelledByRule => pb::RuleMatchState::LabelledByRule,
                        MatchState::Handled => pb::RuleMatchState::Handled,
                    }
                    .into(),
                    transaction: Some(transactions::to_pb(m.transaction)),
                })
                .collect(),
        }))
    }

    async fn create_rule(
        &self,
        req: Request<pb::CreateRuleRequest>,
    ) -> Result<Response<pb::CreateRuleResponse>, Status> {
        let req = req.into_inner();
        let new = NewRule {
            target: target_from_pb(req.category_id, req.counter_account_id)?,
            pattern: req.pattern,
            direction: direction_from_pb(req.direction),
            account_id: req.account_id,
            min_amount_cents: req.min_amount_cents,
            max_amount_cents: req.max_amount_cents,
        };
        let (rule, labelled) = self.0.create_rule(new, req.apply_to_existing).await.map_err(status)?;
        Ok(Response::new(pb::CreateRuleResponse { rule: Some(to_pb(rule)), labelled: labelled as i64 }))
    }

    async fn update_rule(
        &self,
        req: Request<pb::UpdateRuleRequest>,
    ) -> Result<Response<pb::UpdateRuleResponse>, Status> {
        let req = req.into_inner();
        let new = NewRule {
            target: target_from_pb(req.category_id, req.counter_account_id)?,
            pattern: req.pattern,
            direction: direction_from_pb(req.direction),
            account_id: req.account_id,
            min_amount_cents: req.min_amount_cents,
            max_amount_cents: req.max_amount_cents,
        };
        let rule = self.0.update_rule(req.id, new).await.map_err(status)?;
        Ok(Response::new(pb::UpdateRuleResponse { rule: Some(to_pb(rule)) }))
    }

    async fn delete_rule(
        &self,
        req: Request<pb::DeleteRuleRequest>,
    ) -> Result<Response<pb::DeleteRuleResponse>, Status> {
        self.0.delete_rule(req.into_inner().id).await.map_err(status)?;
        Ok(Response::new(pb::DeleteRuleResponse {}))
    }
}

fn target_from_pb(category_id: Option<i64>, counter_account_id: Option<i64>) -> Result<RuleTarget, Status> {
    match (category_id, counter_account_id) {
        (Some(c), None) => Ok(RuleTarget::Category(c)),
        (None, Some(pot)) => Ok(RuleTarget::Transfer(pot)),
        _ => Err(Status::invalid_argument("a rule needs either a category or a pot")),
    }
}

fn direction_from_pb(d: i32) -> Option<RuleDirection> {
    match pb::RuleDirection::try_from(d) {
        Ok(pb::RuleDirection::Out) => Some(RuleDirection::Out),
        Ok(pb::RuleDirection::In) => Some(RuleDirection::In),
        _ => None,
    }
}

fn to_pb(r: Rule) -> pb::Rule {
    let direction = match r.direction {
        Some(RuleDirection::Out) => pb::RuleDirection::Out,
        Some(RuleDirection::In) => pb::RuleDirection::In,
        None => pb::RuleDirection::Unspecified,
    };
    let (category_id, counter_account_id) = match r.target {
        RuleTarget::Category(c) => (Some(c), None),
        RuleTarget::Transfer(pot) => (None, Some(pot)),
    };
    pb::Rule {
        id: r.id,
        pattern: r.pattern,
        category_id,
        counter_account_id,
        direction: direction.into(),
        account_id: r.account_id,
        labels: r.labels as i64,
        min_amount_cents: r.min_amount_cents,
        max_amount_cents: r.max_amount_cents,
        created_at: Some(timestamp(r.created_at)),
    }
}
