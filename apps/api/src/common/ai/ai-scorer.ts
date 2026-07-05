import { Global, Injectable, Module } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service';

// Boundary for the AI scoring service. Phase 3 swaps HeuristicScorer for a client to
// the separate FastAPI AI Orchestrator (LLM recommendations, market-price comparison,
// pgvector supplier matching). The interface — explainable ranking with reasons — stays
// the same, so nothing downstream changes when the real service arrives.
export interface ScoredBid {
  bidId: string;
  supplierOrgId: string;
  supplierName: string;
  totalMinor: number;
  deliveryDays: number | null;
  priceScore: number;
  deliveryScore: number;
  reliabilityScore: number;
  weightedTotal: number;
  reasons: string[];
}
export interface Recommendation {
  model: string;
  weights: { price: number; delivery: number; reliability: number };
  ranking: ScoredBid[];
  recommendedBidId: string | null;
  rationale: string;
}

export abstract class AiScorer {
  abstract recommend(eventId: string): Promise<Recommendation>;
  abstract readonly model: string;
}

@Injectable()
export class HeuristicScorer extends AiScorer {
  readonly model = 'heuristic-v1';
  // Transparent weights — a buyer can defend the recommendation to an auditor.
  private readonly W = { price: 0.5, delivery: 0.2, reliability: 0.3 };

  constructor(private readonly rc: RequestContextService) {
    super();
  }

  async recommend(eventId: string): Promise<Recommendation> {
    const m = this.rc.manager;
    // Only opened bids carry cleartext amounts (RLS + status gate protect this).
    const bids: Array<{
      id: string; supplier_org_id: string; supplier_name: string;
      total_minor: string; delivery_days: number | null;
    }> = await m.query(
      `SELECT b.id, b.supplier_org_id, s.legal_name AS supplier_name, b.total_minor, b.delivery_days
       FROM bids b JOIN organizations s ON s.id = b.supplier_org_id
       WHERE b.event_id = $1 AND b.state = 'OPENED' AND b.total_minor IS NOT NULL`,
      [eventId],
    );
    if (!bids.length) {
      return { model: this.model, weights: this.W, ranking: [], recommendedBidId: null, rationale: 'No opened bids to score yet.' };
    }

    // Per-buyer reliability from scorecard history (0–100, default 60 when unrated).
    const rel = await m.query(
      `SELECT supplier_org_id, round(avg(score))::int AS score
       FROM supplier_scorecard_entries
       WHERE supplier_org_id = ANY($1::uuid[]) GROUP BY supplier_org_id`,
      [bids.map((b) => b.supplier_org_id)],
    );
    const relById = new Map<string, number>(rel.map((r: any) => [r.supplier_org_id, Number(r.score)]));

    const totals = bids.map((b) => Number(b.total_minor));
    const bestPrice = Math.min(...totals);
    const deliveries = bids.map((b) => (b.delivery_days == null ? null : Number(b.delivery_days))).filter((d): d is number => d != null);
    const bestDelivery = deliveries.length ? Math.min(...deliveries) : null;

    const ranking: ScoredBid[] = bids.map((b) => {
      const total = Number(b.total_minor);
      const priceScore = Math.round((bestPrice / total) * 100); // cheapest = 100
      const deliveryScore =
        b.delivery_days == null || bestDelivery == null ? 60 : Math.round((bestDelivery / Number(b.delivery_days)) * 100);
      const reliabilityScore = relById.get(b.supplier_org_id) ?? 60;
      const weightedTotal =
        Math.round((priceScore * this.W.price + deliveryScore * this.W.delivery + reliabilityScore * this.W.reliability) * 10) / 10;

      const reasons: string[] = [];
      reasons.push(total === bestPrice ? 'Lowest price' : `${Math.round(((total - bestPrice) / bestPrice) * 100)}% above the best price`);
      if (b.delivery_days != null) reasons.push(`Delivery in ${b.delivery_days} days`);
      reasons.push(relById.has(b.supplier_org_id) ? `Reliability index ${reliabilityScore}/100 (scorecard history)` : 'No scorecard history yet (neutral reliability)');

      return {
        bidId: b.id, supplierOrgId: b.supplier_org_id, supplierName: b.supplier_name,
        totalMinor: total, deliveryDays: b.delivery_days == null ? null : Number(b.delivery_days),
        priceScore, deliveryScore, reliabilityScore, weightedTotal, reasons,
      };
    });
    ranking.sort((a, b) => b.weightedTotal - a.weightedTotal);

    const top = ranking[0];
    const runnerUp = ranking[1];
    const margin = runnerUp ? Math.round((top.weightedTotal - runnerUp.weightedTotal) * 10) / 10 : null;
    const rationale =
      `${top.supplierName} leads with a weighted score of ${top.weightedTotal}` +
      (margin != null ? ` (${margin} ahead of ${runnerUp.supplierName})` : '') +
      `, driven by ${top.reasons.join('; ').toLowerCase()}.`;

    return { model: this.model, weights: this.W, ranking, recommendedBidId: top.bidId, rationale };
  }
}

@Global()
@Module({
  providers: [{ provide: AiScorer, useClass: HeuristicScorer }],
  exports: [AiScorer],
})
export class AiScorerModule {}
