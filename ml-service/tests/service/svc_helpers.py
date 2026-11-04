"""Request builders for the API tests."""
from __future__ import annotations

CONTRACT_FEATURES = dict(site_id="SITE-A", age=52, distance_km=40, daily_wage_worker=1, scheduled_visits=8, missed_reminders=2,
                         reimbursement_delay_days=12, side_effects_reported=1, phone_changed=0, visits_missed=1)


def risk_body(features=None, **kw):
    b = {"contractVersion": "1.1", "requestId": "req-123", "entityType": "patient", "entityId": "pat-1", "featureSchemaVersion": "2",
         "features": dict(CONTRACT_FEATURES if features is None else features), "requestedAt": "2026-11-01T12:00:00.000Z"}
    b.update(kw)
    return b


def integrity_body(**kw):
    b = {"contractVersion": "1.1", "requestId": "int-1", "windowStart": "2026-10-25T12:00:00Z", "windowEnd": "2026-11-01T12:00:00Z",
         "events": [], "reimbursements": [], "openVisits": [],
         "chain": {"valid": True, "eventsChecked": 0, "errorCount": 0, "firstError": None}}
    b.update(kw)
    return b
