"""Leadprocure AI Orchestrator (V3 architecture: AI isolated in its own service).

POST /recommend — explainable award recommendation for opened bids.
Modes:
  * LLM mode      — when ANTHROPIC_API_KEY is set: Claude produces the rationale and
                    may re-rank within guardrails; the deterministic score is always
                    computed and returned alongside (explainability & audit).
  * Heuristic mode— no key: the same transparent weighted model as the in-app scorer.

The NestJS side calls this via HttpAiScorer and falls back to its local heuristic if
this service is unreachable — the platform never depends on the AI service being up.
"""
import hmac
import json
import os
from typing import Annotated, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Leadprocure AI Orchestrator", version="1.0.0")

WEIGHTS = {"price": 0.5, "delivery": 0.2, "reliability": 0.3}
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")


def require_internal_token(
    token: Annotated[Optional[str], Header(alias="X-Leadprocure-Internal-Token")] = None,
) -> None:
    if not INTERNAL_TOKEN:
        raise HTTPException(status_code=503, detail="Internal authentication is not configured")
    if token is None or not hmac.compare_digest(token, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


class BidIn(BaseModel):
    bid_id: str
    supplier_name: str
    total_minor: int = Field(ge=0)
    delivery_days: Optional[int] = None
    reliability: int = Field(default=60, ge=0, le=100)


class RecommendIn(BaseModel):
    currency: str = "AZN"
    bids: list[BidIn]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "mode": "llm" if ANTHROPIC_KEY else "heuristic", "model": MODEL if ANTHROPIC_KEY else "orchestrator-heuristic-v1"}


def score(bids: list[BidIn]) -> list[dict]:
    best_price = min(b.total_minor for b in bids)
    deliveries = [b.delivery_days for b in bids if b.delivery_days is not None]
    best_delivery = min(deliveries) if deliveries else None
    out = []
    for b in bids:
        price_score = round(best_price / b.total_minor * 100) if b.total_minor else 0
        delivery_score = 60 if (b.delivery_days is None or best_delivery is None) else round(best_delivery / b.delivery_days * 100)
        weighted = round(price_score * WEIGHTS["price"] + delivery_score * WEIGHTS["delivery"] + b.reliability * WEIGHTS["reliability"], 1)
        reasons = ["Lowest price" if b.total_minor == best_price else f"{round((b.total_minor - best_price) / best_price * 100)}% above best price"]
        if b.delivery_days is not None:
            reasons.append(f"Delivery in {b.delivery_days} days")
        reasons.append(f"Reliability {b.reliability}/100")
        out.append({
            "bidId": b.bid_id, "supplierName": b.supplier_name, "totalMinor": b.total_minor,
            "deliveryDays": b.delivery_days, "priceScore": price_score, "deliveryScore": delivery_score,
            "reliabilityScore": b.reliability, "weightedTotal": weighted, "reasons": reasons,
        })
    out.sort(key=lambda r: -r["weightedTotal"])
    return out


async def llm_rationale(ranking: list[dict], currency: str) -> Optional[str]:
    """Ask Claude for a concise, auditable rationale. Guardrail: the model explains the
    deterministic ranking — it does not silently change who wins."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={
                    "model": MODEL,
                    "max_tokens": 300,
                    "messages": [{
                        "role": "user",
                        "content": (
                            "You are a procurement analyst. In 2-3 sentences, justify the award "
                            f"recommendation to an auditor. Currency minor units: {currency}. Ranked bids: "
                            + json.dumps(ranking) +
                            " The first entry is the recommended winner — explain WHY using its scores, and note the runner-up gap."
                        ),
                    }],
                },
            )
            resp.raise_for_status()
            return resp.json()["content"][0]["text"].strip()
    except Exception:
        return None  # LLM is best-effort; heuristic rationale is the fallback


@app.post("/recommend")
async def recommend(inp: RecommendIn, _: None = Depends(require_internal_token)) -> dict:
    if not inp.bids:
        return {"model": "orchestrator-heuristic-v1", "weights": WEIGHTS, "ranking": [], "recommendedBidId": None,
                "rationale": "No opened bids to score yet."}
    ranking = score(inp.bids)
    top, runner = ranking[0], (ranking[1] if len(ranking) > 1 else None)
    rationale = (
        f"{top['supplierName']} leads with a weighted score of {top['weightedTotal']}"
        + (f" ({round(top['weightedTotal'] - runner['weightedTotal'], 1)} ahead of {runner['supplierName']})" if runner else "")
        + f", driven by {'; '.join(top['reasons']).lower()}."
    )
    model = "orchestrator-heuristic-v1"
    if ANTHROPIC_KEY:
        llm = await llm_rationale(ranking, inp.currency)
        if llm:
            rationale, model = llm, MODEL
    return {"model": model, "weights": WEIGHTS, "ranking": ranking,
            "recommendedBidId": top["bidId"], "rationale": rationale}
