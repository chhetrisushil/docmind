# Loom #778 integration (final-review finding 1)

- wire.ts: eraseSubject passes `record: false` for both subjects. The Eraser already drives its own resume loop (shred step throws ErasureParkedError, backs off, re-calls from the first subject, durable erasure_requests row); nothing relied on Loom's handleEvent auto-completion of a recorded park, so nothing was replaced.
- controlStreamKey: HKDF-SHA256 over the KEK (KeyObject from loadKeks), info "docmind-erasure-control-v1", 32 bytes (erasure/controlKey.ts). The planner key is optional and the KEK is the only always-present deployment secret, so no new env var. Previous KEKs map to previousControlStreamKeys. Wired through setup.ts -> compose options.erasure.controlStreamKeys -> ErasureWiring -> complianceConfig. The key is NOT stable across a KEK rotation: documented in docs/operations/rotate-kek.md (keep DOCMIND_KEK_PREVIOUS until no erasure is open).
- CI pin: LOOM_REF 37fe3373.
- Tests: controlKey unit; erasure.noPair e2e (h_ document run + chat turn both park; control stream has no handle, h_<H>, user id, tenant id; subjectRef shape checked; red confirmed with record:true and no key); e2eSupport allow-list for plaintext ERASURE_PENDING removed (proofShape test now rejects it); resume e2e now asserts the control stream names nothing.
- DocMind configures no content/archive/sender deletion, so no *_INTENDED rows occur; the existing "crash between key destroy and tombstones" resume e2e runs with the key configured and passes. No INTENDED-to-DELETED test was added.
- Docs: spec section 6, architecture.md, rotate-kek.md.
