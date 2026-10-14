import type { DbClient } from "../lib/db.js";
import type { RegistrationDataSource } from "./types.js";

export class RegistrationRepository implements RegistrationDataSource {
  constructor(private readonly db: Pick<DbClient,
    | "requestRegistrationCode" | "verifyRegistrationCode" | "reserveRegistrationTicket"
    | "releaseRegistrationReservation" | "finalizeRegistrationReservation"
  >) {}

  requestRegistrationCode(input: Parameters<RegistrationDataSource["requestRegistrationCode"]>[0]) {
    return this.db.requestRegistrationCode(input);
  }
  verifyRegistrationCode(input: Parameters<RegistrationDataSource["verifyRegistrationCode"]>[0]) {
    return this.db.verifyRegistrationCode(input);
  }
  reserveRegistrationTicket(input: Parameters<RegistrationDataSource["reserveRegistrationTicket"]>[0]) {
    return this.db.reserveRegistrationTicket(input);
  }
  releaseRegistrationReservation(reservationHash: string) {
    return this.db.releaseRegistrationReservation(reservationHash);
  }
  finalizeRegistrationReservation(input: Parameters<RegistrationDataSource["finalizeRegistrationReservation"]>[0]) {
    return this.db.finalizeRegistrationReservation(input);
  }
}
