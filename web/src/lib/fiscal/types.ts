export type Regime = "ordinario" | "forfettario" | "esente_sanitario";
export type RecipientKind = "paziente" | "tutore" | "committente";
export type Nature = "N2.2" | "N4";
export type PaymentMethod = "contanti" | "carta" | "bonifico";
export type DocType = "TD01" | "TD04";

export interface FiscalRates {
  vatRateBp: number;
  inpsSurchargeEnabled: boolean;
  inpsSurchargeBp: number;
  withholdingBp: number;
  stampChargedToClient: boolean;
}

export const DEFAULT_RATES: FiscalRates = {
  vatRateBp: 2200,
  inpsSurchargeEnabled: false,
  inpsSurchargeBp: 400,
  withholdingBp: 2000,
  stampChargedToClient: true,
};
