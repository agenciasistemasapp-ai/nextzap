# Project rules

- Scheduling: the AI only requests bookings via markers ([AGENDAR]/[REMARCAR]/[CANCELAR_AGENDAMENTO]); `src/lib/scheduling.server.ts` validates, reserves and writes the customer confirmation. Why: prevents false confirmations.
- Booking conflicts are enforced by the `agendamento_sem_sobreposicao` exclusion constraint (company + recurso + time range, active statuses) and idempotency by `agendamento_idem_uniq`; never rely on a pre-check alone. Why: concurrent webhook calls.
- The internal `agendamento` table is the source of truth; Google Calendar is synced afterwards with a deterministic event id and `google_sync_status` for reconciliation. Why: Google and the DB are not one transaction.
- Pure scheduling rules live in `src/lib/scheduling.ts` and are covered by `src/lib/scheduling.test.ts` (`bun run test`). Why: testable without network/DB.
- Booking duration comes from the matched service: duration ranges ("60 a 75 min") use the maximum, an empty "Serviços agendáveis" falls back to "Produtos/Serviços" items that state a duration, and ambiguous service names are not guessed. Why: a short default duration let bookings overlap the next customer.
